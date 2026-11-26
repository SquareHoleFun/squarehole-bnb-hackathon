// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LinkedPriceFixture} from "../final/money/LinkedPriceFixture.sol";
import {LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {ClaimCap} from "../gas/m3/ClaimCap.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";

/// FINAL-M03: real factory, ledger-token history and PM transport; run with --isolate on both EVMs.
contract LinkedItemClaimGasTest is LinkedPriceFixture {
    function test_coldFreshContractFullAndHalfCap() public {
        _case(0);
    }

    function test_coldRegisteredContractFullAndHalfCap() public {
        _case(1);
    }

    function test_coldFreshWalletFullAndHalfCap() public {
        _case(2);
    }

    function test_coldFirstEligibleOwnerFullAndHalfCap() public {
        _case(3);
    }

    function test_coldLongHistoryFreshWalletFullAndHalfCap() public {
        _case(4);
    }

    function test_coldLongHistoryReturningWalletFullAndHalfCap() public {
        _case(5);
    }

    function test_coldFirstEligible7702OwnerFullAndHalfCap() public {
        _case(6);
    }

    function test_coldStrictMinimumStipendHasTwoTimesHeadroom() public {
        vm.etch(CREATOR, address(new LifeCustody()).code);
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        assertEq(BoxTokenV2Ledger(address(price)).holderCount(), 0);
        vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        uint256 cap = ledger.CLAIM_GAS();
        bytes memory code = release.implementations[16].code;
        bytes32 beforeState = _refusalState(ledger);
        uint256 snap = vm.snapshotState();
        uint256 low;
        uint256 high = 2_000_000;
        while (low + 1 < high) {
            assertTrue(vm.revertToState(snap));
            uint256 mid = (low + high) / 2;
            vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(code), cap, mid, 2));
            if (_attempt(ledger)) {
                high = mid;
            } else {
                assertEq(_refusalState(ledger), beforeState, "failed stipend probe is atomic");
                low = mid;
            }
        }
        emit log_named_uint("strict minimum PM stipend including nested EIP-150", high);
        assertLe(2 * high, cap, "twice the measured required stipend fits production");
        assertTrue(vm.revertToState(snap));
        vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(code), cap, high, 2));
        _paid(ledger, owed, ALICE, "cold exact minimum stipend");
        assertTrue(vm.revertToState(snap));
        vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(code), cap, high - 1, 2));
        assertFalse(_attempt(ledger), "one less gas refuses");
        assertEq(_refusalState(ledger), beforeState);
    }

    function _attempt(ItemLedgerV2 ledger) private returns (bool ok) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        bytes memory data = abi.encodeCall(ItemLedgerV2.claim, (ids, ALICE));
        _cold(ledger, ALICE);
        vm.prank(ALICE);
        bytes memory result;
        (ok, result) = address(ledger).call{gas: 5_000_000}(data);
        if (!ok) assertEq(result, abi.encodeWithSelector(ItemLedgerV2.PayoutFailed.selector));
    }

    function test_coldLowGasRefusalPreservesCreditAndHistoryThenRetryPaysOnce() public {
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        bytes32 beforeState = _refusalState(ledger);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256 limit = ledger.CLAIM_GAS();
        bytes memory data = abi.encodeCall(ItemLedgerV2.claim, (ids, ALICE));
        _cold(ledger, ALICE);
        vm.prank(ALICE);
        (bool ok, bytes memory result) = address(ledger).call{gas: limit}(data);
        assertFalse(ok, "cap alone cannot cover outer work, EIP-150 and retained reserve");
        assertEq(result, abi.encodeWithSelector(ItemLedgerV2.GasTooLow.selector));
        assertEq(_refusalState(ledger), beforeState);
        _paid(ledger, owed, ALICE, "cold retry after low gas");
    }

    function _refusalState(ItemLedgerV2 ledger) private view returns (bytes32) {
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(price));
        return keccak256(
            abi.encode(
                _unclaimedState(ledger),
                _creditState(ledger),
                price.balanceOf(ALICE),
                price.balanceOf(address(pm)),
                pm.balanceOf(address(ledger), uint160(address(price))),
                history.holderCheckpoint(),
                history.holderCount()
            )
        );
    }

    function _case(uint256 scenario) private {
        // A contract creator plus contract swap actors leaves A with no eligible holders. No protocol
        // runtime or storage is replaced: only this fixture's creator endpoint receives contract code.
        if (scenario == 3 || scenario == 6) vm.etch(CREATOR, address(new LifeCustody()).code);
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(price));
        address to = ALICE;
        if (scenario < 2) to = address(new LifeCustody());
        if (scenario == 1) {
            HolderLedgerV2 holders = HolderLedgerV2(origin.roleAddress(17));
            vm.prank(to);
            holders.register();
            assertEq(history.holderAt(history.holderCount() - 1), to);
        }
        if (scenario == 6) vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        if (scenario == 3 || scenario == 6) {
            assertEq(history.holderCount(), 0, "first eligible owner, not just a fresh balance");
            assertEq(history.eligibleSupplyAt(history.holderCheckpoint()), 0);
        }
        if (scenario == 4 || scenario == 5) {
            address seasoned = address(0x515EA50);
            uint256 checkpoint = history.holderCheckpoint();
            // Real, positive out-and-back transfers create 1024 entries for both parties and supply.
            // Returning wallet is empty; every payout still appends fresh mandatory history slots.
            for (uint256 i; i < 512; ++i) {
                vm.prank(address(buyer));
                price.transfer(seasoned, 1);
                vm.prank(seasoned);
                price.transfer(address(buyer), 1);
            }
            assertEq(history.holderCheckpoint(), checkpoint + 1024);
            if (scenario == 5) to = seasoned;
        }
        uint256 cap = ledger.CLAIM_GAS();
        assertEq(cap, 2_600_000, "twice the rounded-up 1.3M strict cold allowance");
        bytes memory code = release.implementations[16].code;
        uint256 snap = vm.snapshotState();
        _paid(ledger, owed, to, "cold full production cap");
        assertTrue(vm.revertToState(snap));
        vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(code), cap, cap / 2, 2));
        _paid(ledger, owed, to, "cold half production cap");
        assertTrue(vm.revertToState(snap));
        // The token's optional checkpoint hint can be skipped at smaller allowances. Also measure
        // the complete real path with enough gas to activate it; no protocol body is substituted.
        vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(code), cap, 4_000_000, 2));
        _paid(ledger, owed, to, "cold high allowance with optional hint");
    }

    function _cold(ItemLedgerV2 ledger, address to) private {
        address holders = origin.roleAddress(17);
        // cool resets the account and all its storage access warmth after setup and assertion reads.
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i);
            if (part != address(0)) vm.cool(part);
            if (release.implementations[i] != address(0)) vm.cool(release.implementations[i]);
        }
        vm.cool(address(origin));
        vm.cool(address(box));
        vm.cool(holders);
        vm.cool(address(price));
        vm.cool(address(pm));
        vm.cool(address(ledger));
        vm.cool(ALICE);
        vm.cool(to);
    }

    function _paid(ItemLedgerV2 ledger, uint256 owed, address to, string memory label) private {
        assertEq(price.balanceOf(to), 0);
        uint256 backing = pm.balanceOf(address(ledger), uint160(address(price)));
        uint256 liquid = price.balanceOf(address(pm));
        bytes32 other = _unclaimedState(ledger);
        uint256 checkpoint = BoxTokenV2Ledger(address(price)).holderCheckpoint();
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        {
            bytes memory data = abi.encodeCall(ItemLedgerV2.claim, (ids, to));
            _cold(ledger, to);
            vm.prank(ALICE);
            uint256 beforeGas = gasleft();
            (bool ok, bytes memory result) = address(ledger).call{gas: 5_000_000}(data);
            uint256 gross = GasBudget.transaction(beforeGas - gasleft(), data);
            emit log_named_uint(label, gross);
            if (!ok) {
                assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
            }
            assertEq(abi.decode(result, (uint256)), owed);
        }
        assertEq(price.balanceOf(to), owed);
        assertEq(price.balanceOf(address(pm)), liquid - owed);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), backing - owed);
        assertEq(BoxTokenV2Ledger(address(price)).holderCheckpoint(), checkpoint + 1);
        assertEq(_creditState(ledger), keccak256(abi.encode(uint256(0), uint256(0))));
        assertEq(_unclaimedState(ledger), other);
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.InvalidClaim.selector);
        ledger.claim(ids, to);
        assertEq(price.balanceOf(to), owed, "no second payment");
    }
}
