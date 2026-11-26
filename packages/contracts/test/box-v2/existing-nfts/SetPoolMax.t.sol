// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetPoolGasFixture} from "./SetPoolGas.t.sol";
import {GasBudget} from "../gas/GasBudget.sol";

/// Entire 10,000-item setup is many transactions modelled in one Foundry frame, never one transaction budget.
/// Four tests skip under the default budget; sepolia-rehearsal runs the unchanged production release on both EVMs.
abstract contract SetPoolMaxFixture is SetPoolGasFixture {
    uint256 private pages;
    uint256 private largestSequencePage;

    function _count() internal pure override returns (uint32) {
        return 10000;
    }

    function _load(bytes32[] memory links) internal override {
        for (uint256 i; i < 10000; i += 32) {
            uint256 n = 10000 - i > 32 ? 32 : 10000 - i;
            bytes memory data = _pageData(i, n, links[i + n]);
            vm.prank(CREATOR);
            uint256 before = gasleft();
            (bool ok, bytes memory reason) = address(loader).call{gas: 16_000_000}(data);
            uint256 gasUsed = GasBudget.transaction(before - gasleft(), data);
            if (!ok) {
                assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
            }
            assertLe(gasUsed, 16_777_216);
            if (gasUsed > largestSequencePage) largestSequencePage = gasUsed;
            ++pages;
            (uint32 loaded, bytes32 next, bool notified) = loader.progress();
            assertEq(loaded, i + n);
            assertEq(next, links[i + n]);
            assertFalse(notified);
            assertFalse(box.gateOpen());
            if (i + n < 10000) {
                vm.expectRevert();
                loader.complete();
            }
        }
        assertEq(pages, 313);
        assertEq(vault.inside(), 10000);
        assertEq(art.balanceOf(address(vault)), 10000);
        for (uint256 i; i < 10000; ++i) {
            assertEq(vault.memberAt(i), _id(i));
        }
    }

    function _assertMax() internal {
        assertEq(pages, 313);
        assertEq(vault.loaded(), 10000);
        assertEq(vault.collectionSize(), 10000);
        // This chronology has dirty original slots between pages; fresh-frame upper bounds live in SetPoolGas.
        emit log_named_uint("largest page in 313-page chronology", largestSequencePage);
        _noPayouts();
    }
}

contract SetPoolMaxConversionTest is SetPoolMaxFixture {
    function _stage() internal pure override returns (uint256) {
        return 5;
    }

    function test_E07_max10000ColdPick8() public {
        _assertMax();
        _nearCap();
        vm.recordLogs();
        _measure(
            "max N pick 8 near cap",
            ALICE,
            address(vault),
            abi.encodeCall(vault.withdrawBatch, (_ids(32, 8), type(uint256).max, block.timestamp)),
            0
        );
        _telemetry(8);
        assertEq(vault.inside(), 9960);
    }

    function test_E07_max10000ColdReturn8() public {
        _assertMax();
        _nearCap();
        vm.recordLogs();
        _measure(
            "max N return 8 near cap",
            ALICE,
            address(vault),
            abi.encodeCall(vault.returnItems, (_ids(0, 8), 0, block.timestamp)),
            0
        );
        _telemetry(8);
        assertEq(vault.inside(), 9976);
    }
}

contract SetPoolMaxFailureTest is SetPoolMaxFixture {
    function _stage() internal pure override returns (uint256) {
        return 6;
    }

    function test_E07_max10000ColdFailure() public {
        _assertMax();
        vm.expectCall(address(art), bytes(""), uint64(0));
        _measure("max N fail deadline", ALICE, address(box), abi.encodeCall(box.fail, ()), 0);
        assertTrue(vault.failed());
        (, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(ALICE));
    }
}

contract SetPoolMaxRecoveryTest is SetPoolMaxFixture {
    function _stage() internal pure override returns (uint256) {
        return 7;
    }

    function test_E07_max10000ColdRecovery8() public {
        _assertMax();
        _nearCap();
        vm.recordLogs();
        bytes memory result = _measure(
            "max N recover 8 near cap",
            ALICE,
            address(vault),
            abi.encodeCall(vault.releaseToCreator, (_ids(9992, 8))),
            0
        );
        _telemetry(8);
        assertEq(abi.decode(result, (uint256)), 8);
        assertEq(vault.inside(), 9992);
        (, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(ALICE));
    }
}
