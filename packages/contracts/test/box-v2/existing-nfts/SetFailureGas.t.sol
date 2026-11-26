// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetFailureFixture, RecoveryVault} from "./SetFailureFixture.sol";
import {CustodyVault, SetStandardERC721} from "./SetVaultFixture.sol";
import {Vm} from "forge-std/Vm.sol";

/// Telemetry adds no persistent writes to the measured transfer. Mode 1 succeeds near the cap; mode 2 exhausts it.
contract RecoveryGasERC721 is SetStandardERC721 {
    bool public measuring;
    uint256 public mode;
    event RecoveryTransferGas(uint256 entry, uint256 used);

    function measure(uint256 mode_) external {
        measuring = true;
        mode = mode_;
    }

    function transferFrom(address from, address to, uint256 id) public override {
        uint256 entry = gasleft();
        super.transferFrom(from, to, id);
        if (!measuring) return;
        if (mode == 2) {
            assembly { for {} 1 {} {} }
        }
        if (mode == 1) {
            assembly { for {} gt(gas(), 5000) {} {} }
        }
        emit RecoveryTransferGas(entry, entry - gasleft());
    }
}

contract SetFailureGasTest is SetFailureFixture {
    RecoveryGasERC721 private nft;

    // Preparation in setUp gives the measured test a fresh transaction's original storage values.
    function setUp() public override {
        super.setUp();
        nft = new RecoveryGasERC721();
        _configure(address(nft), 32);
        for (uint256 i; i < 32; ++i) {
            nft.mint(CREATOR, ids[i]);
        }
        _deploy(true);
        _page(0, 32);
        _failClosed();
        nft.measure(0);
    }

    function test_cold32StandardTransfersAndFullForwarding() public {
        uint256[] memory list = _list(0, 32);
        _expectFullStipends(list);
        _cold();
        vm.recordLogs();
        uint256 beforeGas = gasleft();
        assertEq(recovery().releaseToCreator{gas: 16_000_000}(list), 32);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("cold 32 standard recovery, gross caller gas", used);
        assertLt(used, 4_000_000);
        _transferTelemetry(32, false);
        assertEq(vault.inside(), 0);
    }

    function test_cold16NearCapTransfersFitTransactionEnvelope() public {
        nft.measure(1);
        uint256[] memory list = _list(0, 16);
        _expectFullStipends(list);
        _cold();
        vm.recordLogs();
        uint256 beforeGas = gasleft();
        assertEq(recovery().releaseToCreator{gas: 16_000_000}(list), 16);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("cold 16 near-cap recovery, gross caller gas", used);
        assertLt(used, 12_000_000);
        _transferTelemetry(16, true);
        assertEq(vault.inside(), 16);
    }

    function test_cold16ExhaustedTransfersDeferAndKeepAllCustody() public {
        nft.measure(2);
        uint256[] memory list = _list(0, 16);
        _expectFullStipends(list);
        _cold();
        uint256 beforeGas = gasleft();
        assertEq(recovery().releaseToCreator{gas: 16_000_000}(list), 0);
        uint256 used = beforeGas - gasleft();
        emit log_named_uint("cold 16 exhausted transfers, gross caller gas", used);
        assertLt(used, 12_000_000);
        assertEq(vault.inside(), 32);
        for (uint256 i; i < 32; ++i) {
            assertEq(nft.ownerOf(ids[i]), address(vault));
        }
        nft.measure(0);
        assertEq(recovery().releaseToCreator(list), 16);
    }

    function test_outerFloorRefusesWithoutCallingItemAndSufficientEnvelopeForwardsFullCaps() public {
        nft.measure(1);
        bytes memory data = abi.encodeCall(RecoveryVault.releaseToCreator, (_list(0, 1)));
        _cold();
        (bool ok, bytes memory reason) = address(vault).call{gas: 2_000_000}(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(CustodyVault.TransferGas.selector));
        assertEq(vault.inside(), 32);
        assertEq(nft.ownerOf(ids[0]), address(vault));
        uint256[] memory one = _list(0, 1);
        _expectFullStipends(one);
        _cold();
        vm.recordLogs();
        assertEq(recovery().releaseToCreator{gas: 2_200_000}(one), 1);
        _transferTelemetry(1, true);
    }

    function test_insufficientLaterIterationRollsBackEarlierSuccessfulTransfer() public {
        nft.measure(1);
        _cold();
        bytes memory data = abi.encodeCall(RecoveryVault.releaseToCreator, (_list(0, 3)));
        vm.expectCall(
            collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(vault), CREATOR, ids[0])
        );
        (bool ok, bytes memory reason) = address(vault).call{gas: 2_800_000}(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(CustodyVault.TransferGas.selector));
        assertEq(vault.inside(), 32);
        assertEq(nft.ownerOf(ids[0]), address(vault));
        assertEq(nft.ownerOf(ids[1]), address(vault));
        assertEq(recovery().releaseToCreator(_list(0, 3)), 3);
    }

    function _cold() private {
        vm.cool(address(vault));
        vm.cool(vaultImpl);
        vm.cool(collection);
        vm.cool(CREATOR);
    }

    function _expectFullStipends(uint256[] memory list) private {
        for (uint256 i; i < list.length; ++i) {
            vm.expectCallMinGas(address(vault), 0, 1_900_000, abi.encodeCall(RecoveryVault.releaseOne, (list[i])));
            vm.expectCallMinGas(
                collection,
                0,
                450_000,
                abi.encodeWithSignature("transferFrom(address,address,uint256)", address(vault), CREATOR, list[i])
            );
        }
    }

    function _transferTelemetry(uint256 count, bool spending) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        uint256 maximum;
        uint256 minimumEntry = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != collection || logs[i].topics[0] != keccak256("RecoveryTransferGas(uint256,uint256)"))
            {
                continue;
            }
            (uint256 entry, uint256 used) = abi.decode(logs[i].data, (uint256, uint256));
            assertGe(entry, 449_000, "foreign CALL stipend clipped");
            assertLe(entry, 450_000);
            if (spending) assertGt(used, 440_000);
            if (used > maximum) maximum = used;
            if (entry < minimumEntry) minimumEntry = entry;
            ++found;
        }
        assertEq(found, count);
        emit log_named_uint("minimum transfer entry gas", minimumEntry);
        emit log_named_uint("maximum transfer body gas", maximum);
    }
}
