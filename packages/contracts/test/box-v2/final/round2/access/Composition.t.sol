// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../../rc5-a/NoFailureSweep.sol";

import {LinkedPriceFixture} from "../../money/LinkedPriceFixture.sol";
import {ItemLedgerV2} from "../../../../../src/box-v2/ItemLedgerV2.sol";
import {GasBudget} from "../../../gas/GasBudget.sol";

/// FINAL2-ACCESS: real factory, linked ledger-token P and PM; named caller envelopes exclude setup.
contract Round2AccessCompositionTest is LinkedPriceFixture {
    address private constant CALLER = address(0xF130);
    uint256 private constant TX_CAP = 16_777_216;
    uint256 private constant SAFE_ENVELOPE = 12_000_000;
    uint256 private constant ITEM_ENVELOPE = 4_000_000;

    function test_R2_F130_linkedSafePayoutsAreIndependentAndPublicBeforeGraduation() public {
        _linked(false);
        _publicSafes();
        assertFalse(box.graduated());
    }

    function test_R2_F130_linkedSafePayoutsRemainPublicAfterGraduation() public {
        _linked(false);
        _fill();
        box.graduate();
        receiver.collect(address(0));
        _publicSafes();
        assertTrue(box.graduated());
    }

    function test_R2_linkedPFailureHasNoYearSweepAndSafeExitsNeverRecountClaims() public {
        _linked(false);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 count) = box.claimState();
        uint256 supply = price.totalSupply();
        uint256 nativeBacking = address(pm).balance;
        uint256 owed = receiver.fitOwed();
        vm.warp(box.failedAt() + 365 days - 1);
        NoFailureSweep.check(address(box));
        vm.warp(block.timestamp + 1);
        vm.prank(CALLER);
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), owed);
        _publicSafes();
        (uint256 remaining, uint256 left) = box.claimState();
        assertEq(remaining, pot);
        assertEq(left, count, "Safe payment never recounts failed coins");
        assertEq(box.quoteClaim(count), pot);
        assertEq(price.totalSupply(), supply);
        assertEq(address(pm).balance, nativeBacking, "origin native P is untouched");
    }

    function test_R2_linkedItemOwnerExitSurvivesExhaustedOptionalNoticeAndPreservesOtherItems() public {
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        // Fault only the optional observer after real admission and credit funding.
        vm.etch(origin.roleAddress(17), hex"5b600056");
        bytes32 others = _unclaimedState(ledger);
        uint256 backing = pm.balanceOf(address(ledger), uint160(address(price)));
        uint256 pmP = price.balanceOf(address(pm));
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        bytes memory data = abi.encodeCall(ledger.claim, (ids, ALICE));
        vm.prank(CALLER);
        vm.expectRevert();
        ledger.claim(ids, CALLER);
        assertEq(_unclaimedState(ledger), others);
        vm.prank(ALICE);
        (bool low,) = address(ledger).call{gas: 2_000_000}(data);
        assertFalse(low, "insufficient admission gas must retain the entire owner credit");
        (uint256 outsideP, uint256 stashP) = ledger.itemCredit(1);
        assertEq(outsideP + stashP, owed);
        assertEq(_run(address(ledger), ALICE, data, ITEM_ENVELOPE), owed);
        assertEq(price.balanceOf(ALICE), owed);
        assertEq(price.balanceOf(address(pm)), pmP - owed);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), backing - owed);
        assertEq(_unclaimedState(ledger), others);
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.InvalidClaim.selector);
        ledger.claim(ids, ALICE);
    }

    function _publicSafes() private {
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(price)));
        uint256 callerP = price.balanceOf(CALLER);
        uint256 beforeFit = price.balanceOf(fitSafe);
        uint256 beforePlatform = price.balanceOf(address(this));
        assertGt(fit, 0);
        assertGt(platform, 0);
        assertEq(_run(address(receiver), CALLER, abi.encodeCall(receiver.payFit, ()), SAFE_ENVELOPE), fit);
        assertEq(price.balanceOf(fitSafe), beforeFit + fit);
        assertEq(receiver.platformOwed(), platform);
        assertEq(price.balanceOf(address(this)), beforePlatform);
        assertEq(_run(address(receiver), ALICE, abi.encodeCall(receiver.payPlatform, ()), SAFE_ENVELOPE), platform);
        assertEq(price.balanceOf(address(this)), beforePlatform + platform);
        assertEq(price.balanceOf(CALLER), callerP, "trigger earns no P");
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing - fit - platform);
        assertEq(receiver.fitOwed(), 0);
        assertEq(receiver.platformOwed(), 0);
        assertEq(receiver.payFit(), 0);
        assertEq(receiver.payPlatform(), 0);
        _booked();
    }

    function _run(address target, address caller, bytes memory data, uint256 envelope) private returns (uint256) {
        for (uint256 i; i < 24; ++i) {
            address impl = release.implementations[i];
            if (impl != address(0)) vm.cool(impl);
            address a = box.roleAddress(i);
            address b = origin.roleAddress(i);
            if (a != address(0)) vm.cool(a);
            if (b != address(0)) vm.cool(b);
        }
        vm.cool(address(pm));
        vm.cool(caller);
        vm.cool(fitSafe);
        vm.cool(target);
        assertLt(envelope + GasBudget.intrinsic(data), TX_CAP, "submitted allowance including intrinsic");
        vm.prank(caller);
        uint256 start = gasleft();
        (bool ok, bytes memory result) = target.call{gas: envelope}(data);
        uint256 gross = GasBudget.transaction(start - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        emit log_named_uint("cold gross transaction bound", gross);
        assertLt(gross * 130 / 100 + 500_000, TX_CAP, "conservative execution plus state gas and headroom");
        return abi.decode(result, (uint256));
    }
}
