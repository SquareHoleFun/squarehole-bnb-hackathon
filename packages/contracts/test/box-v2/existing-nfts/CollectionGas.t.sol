// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetPoolFixture, SetSpecV2, SetStandardERC721} from "./SetPoolFixture.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {
    OZ3HolderFixture,
    OZ4PlainFixture,
    OZ4EnumerableFixture,
    OZ5PlainFixture,
    OZ5EnumerableFixture,
    ERC721ALayoutFixture
} from "./fixtures/MainstreamERC721.sol";

interface CollectionOps {
    function mint(address to, uint256 id) external;
    function ownerOf(uint256 id) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
}

/// One prepared operation per test transaction, through the actual factory/pool/coordinator/loader/vault.
/// Run Cancun, Amsterdam, and Amsterdam --enable-tx-gas-limit. The latter inherits a state reservoir
/// from the test transaction even though the measured child CALL has only 2.5M execution gas.
abstract contract CollectionFlowTest is SetPoolFixture {
    uint8 private immutable kind;
    uint256 private immutable batch;
    uint8 private immutable order;
    uint8 private immutable stage;
    uint256[] private committed;
    bytes32[] private links;

    constructor(uint8 kind_, uint256 batch_, uint8 order_, uint8 stage_) {
        kind = kind_;
        batch = batch_;
        order = order_;
        stage = stage_;
    }

    function setUp() public override {
        // Setup includes release deployment/salt search, not a product transaction budget.
        vm.pauseGasMetering();
        string memory evm = vm.getEvmVersion();
        // Foundry 1.8.3 drops the reservoir on setup cheatcode calls too. Deploy the identical
        // Cancun-target bytecode under Cancun, then restore the requested runtime before measurement.
        vm.setEvmVersion("cancun");
        super.setUp();
        address art;
        if (kind == 0) art = address(new SetStandardERC721());
        else if (kind == 1) art = address(new OZ3HolderFixture());
        else if (kind == 2) art = address(new OZ4PlainFixture());
        else if (kind == 3) art = address(new OZ4EnumerableFixture());
        else if (kind == 4) art = address(new OZ5PlainFixture());
        else if (kind == 5) art = address(new OZ5EnumerableFixture());
        else art = address(new ERC721ALayoutFixture());
        if (kind == 6) {
            ERC721ALayoutFixture(art).mintBatch(CREATOR, batch);
        } else {
            for (uint256 i; i < batch; ++i) {
                CollectionOps(art).mint(CREATOR, i + 3);
            }
        }
        committed = new uint256[](10);
        links = new bytes32[](11);
        for (uint256 i; i < 10; ++i) {
            uint256 offset = order == 0
                ? i
                : order == 1 ? (batch / 2 + i) % batch : order == 2 ? batch - 1 - i : (i == 0 ? 0 : i + 29);
            committed[i] = offset + 3;
        }
        for (uint256 i = 10; i != 0;) {
            --i;
            links[i] = keccak256(abi.encode(art, committed[i], uint8(0), links[i + 1]));
        }
        SetSpecV2 memory s = _spec();
        s.collection = art;
        s.count = 10;
        s.setHash = links[0];
        _start(s);
        if (stage == 0) {
            _finishSetup(evm, CREATOR);
            return;
        }
        for (uint256 i; i < 10; ++i) {
            _call(CREATOR, address(loader), _loadData(i));
        }
        if (stage == 3) {
            vm.warp(box.openAt() + 14 days);
            box.failClosed();
            _finishSetup(evm, ALICE);
            return;
        }
        loader.complete();
        _fill();
        box.graduate();
        _fundPicker();
        vm.prank(ALICE);
        CollectionOps(collection).setApprovalForAll(address(vault), true);
        if (stage == 2) {
            _call(
                ALICE, address(vault), abi.encodeCall(vault.withdrawBatch, (_one(), type(uint256).max, block.timestamp))
            );
        }
        _finishSetup(evm, ALICE);
    }

    function _finishSetup(string memory evm, address sender) private {
        vm.setEvmVersion(evm);
        vm.resumeGasMetering();
        vm.startPrank(sender);
    }

    function _one() private view returns (uint256[] memory one) {
        one = new uint256[](1);
        one[0] = committed[0];
    }

    function _loadData(uint256 index) private view returns (bytes memory) {
        address[] memory cs = new address[](1);
        cs[0] = collection;
        uint256[] memory ns = new uint256[](1);
        ns[0] = committed[index];
        return abi.encodeCall(loader.load, (cs, ns, new uint8[](1), links[index + 1]));
    }

    function _remainingData() private view returns (bytes memory) {
        address[] memory cs = new address[](9);
        uint256[] memory ns = new uint256[](9);
        for (uint256 i; i < 9; ++i) {
            cs[i] = collection;
            ns[i] = committed[i + 1];
        }
        return abi.encodeCall(loader.load, (cs, ns, new uint8[](9), links[10]));
    }

    function _call(address sender, address target, bytes memory data) private returns (uint256 gross) {
        vm.prank(sender);
        uint256 before = gasleft();
        (bool ok, bytes memory reason) = target.call{gas: 16_000_000}(data);
        gross = before - gasleft();
        if (!ok) {
            assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        }
    }

    function test_measuredProductFlow() public {
        _measureFlow(true);
    }

    function test_reservoirProductFlow() public {
        _measureFlow(false);
    }

    function _measureFlow(bool cool) private {
        bytes memory data;
        address target = address(vault);
        if (stage == 0) {
            data = _loadData(0);
            target = address(loader);
        } else if (stage == 1) {
            data = abi.encodeCall(vault.withdrawBatch, (_one(), type(uint256).max, block.timestamp));
        } else if (stage == 2) {
            data = abi.encodeCall(vault.returnItems, (_one(), 0, block.timestamp));
        } else {
            data = abi.encodeCall(vault.releaseToCreator, (_one()));
        }
        // Foundry 1.8.3 cheatcode calls (including vm.cool/prank) discard the inherited reservoir.
        // The reservoir variant makes NO cheatcode call before the target. Sender is armed in setUp.
        // vm.cool also does not restore original storage: preparation must stay in setUp.
        if (cool) {
            vm.cool(collection);
            vm.cool(address(vault));
            vm.cool(release.implementations[3]);
            vm.cool(address(loader));
            vm.cool(release.implementations[19]);
            vm.cool(address(box));
            vm.cool(release.implementations[0]);
            vm.cool(address(token));
            vm.cool(release.implementations[1]);
            vm.cool(vm.computeCreateAddress(release.implementations[3], 1));
            vm.cool(ALICE);
            vm.cool(CREATOR);
        }
        uint256 before = gasleft();
        (bool ok, bytes memory reason) = target.call{gas: 2_500_000}(data);
        uint256 gross = before - gasleft();
        if (!ok) {
            assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        }
        // The vendored Vm.Gas predates the sixth field introduced by Foundry 1.8.3.
        (, bytes memory raw) = address(vm).staticcall(abi.encodeWithSignature("lastFrameGas()"));
        (,,,,, uint64 stateGas) = abi.decode(raw, (uint64, uint64, uint64, int64, uint64, uint64));
        vm.stopPrank();
        uint256 total = GasBudget.transaction(gross, data);
        emit log_named_uint("conservative transaction execution gas", total);
        emit log_named_uint("state gas", stateGas);
        if (stateGas > total) total = stateGas;
        // A single item succeeds inside a 2.5M call (3M with the client's 20% margin), well below its cap.
        // The gas used below is a cost measurement; estimation must also satisfy the forwarding floors.
        assertLe((total * 120 + 99) / 100, 16_777_216);
        assertEq(
            CollectionOps(collection).ownerOf(committed[0]), stage == 1 ? ALICE : stage == 3 ? CREATOR : address(vault)
        );
        assertEq(vault.inside(), stage == 0 ? 1 : stage == 2 ? 10 : 9);
        if (stage == 0) {
            // Every remaining sparse/consecutive entry must load without self-transfer or reordering.
            if (cool) {
                for (uint256 i = 1; i < 10; ++i) {
                    _call(CREATOR, address(loader), _loadData(i));
                }
            } else {
                _call(CREATOR, address(loader), _remainingData());
            }
            loader.complete();
            assertTrue(box.gateOpen());
        }
    }
}

contract SolmateLoadTest is CollectionFlowTest(0, 10, 0, 0) {}

contract SolmatePickTest is CollectionFlowTest(0, 10, 0, 1) {}

contract SolmateReturnTest is CollectionFlowTest(0, 10, 0, 2) {}

contract SolmateReleaseTest is CollectionFlowTest(0, 10, 0, 3) {}

contract OZ3LoadTest is CollectionFlowTest(1, 10, 0, 0) {}

contract OZ3PickTest is CollectionFlowTest(1, 10, 0, 1) {}

contract OZ3ReturnTest is CollectionFlowTest(1, 10, 0, 2) {}

contract OZ3ReleaseTest is CollectionFlowTest(1, 10, 0, 3) {}

contract OZ4LoadTest is CollectionFlowTest(2, 10, 0, 0) {}

contract OZ4PickTest is CollectionFlowTest(2, 10, 0, 1) {}

contract OZ4ReturnTest is CollectionFlowTest(2, 10, 0, 2) {}

contract OZ4ReleaseTest is CollectionFlowTest(2, 10, 0, 3) {}

contract OZ4EnumerableLoadTest is CollectionFlowTest(3, 10, 0, 0) {}

contract OZ4EnumerablePickTest is CollectionFlowTest(3, 10, 0, 1) {}

contract OZ4EnumerableReturnTest is CollectionFlowTest(3, 10, 0, 2) {}

contract OZ4EnumerableReleaseTest is CollectionFlowTest(3, 10, 0, 3) {}

contract OZ5LoadTest is CollectionFlowTest(4, 10, 0, 0) {}

contract OZ5PickTest is CollectionFlowTest(4, 10, 0, 1) {}

contract OZ5ReturnTest is CollectionFlowTest(4, 10, 0, 2) {}

contract OZ5ReleaseTest is CollectionFlowTest(4, 10, 0, 3) {}

contract OZ5EnumerableLoadTest is CollectionFlowTest(5, 10, 0, 0) {}

contract OZ5EnumerablePickTest is CollectionFlowTest(5, 10, 0, 1) {}

contract OZ5EnumerableReturnTest is CollectionFlowTest(5, 10, 0, 2) {}

contract OZ5EnumerableReleaseTest is CollectionFlowTest(5, 10, 0, 3) {}

contract ERC721A10SequentialLoadTest is CollectionFlowTest(6, 10, 0, 0) {}

contract ERC721A10SequentialPickTest is CollectionFlowTest(6, 10, 0, 1) {}

contract ERC721A10SequentialReturnTest is CollectionFlowTest(6, 10, 0, 2) {}

contract ERC721A10SequentialReleaseTest is CollectionFlowTest(6, 10, 0, 3) {}

contract ERC721A10MidBatchLoadTest is CollectionFlowTest(6, 10, 1, 0) {}

contract ERC721A10MidBatchPickTest is CollectionFlowTest(6, 10, 1, 1) {}

contract ERC721A10MidBatchReturnTest is CollectionFlowTest(6, 10, 1, 2) {}

contract ERC721A10MidBatchReleaseTest is CollectionFlowTest(6, 10, 1, 3) {}

contract ERC721A30SequentialLoadTest is CollectionFlowTest(6, 30, 0, 0) {}

contract ERC721A30SequentialPickTest is CollectionFlowTest(6, 30, 0, 1) {}

contract ERC721A30SequentialReturnTest is CollectionFlowTest(6, 30, 0, 2) {}

contract ERC721A30SequentialReleaseTest is CollectionFlowTest(6, 30, 0, 3) {}

contract ERC721A30MidBatchLoadTest is CollectionFlowTest(6, 30, 1, 0) {}

contract ERC721A30MidBatchPickTest is CollectionFlowTest(6, 30, 1, 1) {}

contract ERC721A30MidBatchReturnTest is CollectionFlowTest(6, 30, 1, 2) {}

contract ERC721A30MidBatchReleaseTest is CollectionFlowTest(6, 30, 1, 3) {}

contract ERC721A100SequentialLoadTest is CollectionFlowTest(6, 100, 0, 0) {}

contract ERC721A100SequentialPickTest is CollectionFlowTest(6, 100, 0, 1) {}

contract ERC721A100SequentialReturnTest is CollectionFlowTest(6, 100, 0, 2) {}

contract ERC721A100SequentialReleaseTest is CollectionFlowTest(6, 100, 0, 3) {}

contract ERC721A100MidBatchLoadTest is CollectionFlowTest(6, 100, 1, 0) {}

contract ERC721A100MidBatchPickTest is CollectionFlowTest(6, 100, 1, 1) {}

contract ERC721A100MidBatchReturnTest is CollectionFlowTest(6, 100, 1, 2) {}

contract ERC721A100MidBatchReleaseTest is CollectionFlowTest(6, 100, 1, 3) {}

contract ERC721A100DescendingLoadTest is CollectionFlowTest(6, 100, 2, 0) {}

contract ERC721A100DescendingPickTest is CollectionFlowTest(6, 100, 2, 1) {}

contract ERC721A100DescendingReturnTest is CollectionFlowTest(6, 100, 2, 2) {}

contract ERC721A100DescendingReleaseTest is CollectionFlowTest(6, 100, 2, 3) {}

contract ERC721A100GapLoadTest is CollectionFlowTest(6, 100, 3, 0) {}

contract ERC721A100GapPickTest is CollectionFlowTest(6, 100, 3, 1) {}

contract ERC721A100GapReturnTest is CollectionFlowTest(6, 100, 3, 2) {}

contract ERC721A100GapReleaseTest is CollectionFlowTest(6, 100, 3, 3) {}
