// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LinkedPriceFixture} from "../../money/LinkedPriceFixture.sol";
import {ItemLedgerV2} from "../../../../../src/box-v2/ItemLedgerV2.sol";
import {GasBudget} from "../../../gas/GasBudget.sol";

/// FINAL-M02/M03 + F130/F127: unrelated triggers pay only fixed Safes; item rights remain owner-only.
contract Round2CombinedPayoutsTest is LinkedPriceFixture {
    uint256 private constant CALL_GAS = 4_000_000;
    address private constant TRIGGER = address(0xF112);

    function test_safeThenItemClaimsConserveLinkedP() public { _combined(false); }
    function test_itemThenSafeClaimsConserveLinkedP() public { _combined(true); }

    function _combined(bool itemFirst) private {
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        bytes32 protected = _unclaimedState(ledger);
        uint256 beforePM = price.balanceOf(address(pm));
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        uint256 receiverBacking = pm.balanceOf(address(receiver), uint160(address(price)));
        uint256 itemBacking = pm.balanceOf(address(ledger), uint160(address(price)));
        uint256 beforeFit = price.balanceOf(fitSafe);
        uint256 beforePlatform = price.balanceOf(address(this));
        uint256[] memory ids = new uint256[](1); ids[0] = 1;
        // No trigger may consume the owner's item credit, even though Safe triggers are open.
        vm.prank(TRIGGER); vm.expectRevert(); ledger.claim(ids, TRIGGER);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), itemBacking);
        if (itemFirst) _claim(ledger, ids, owed);
        _cold(fitSafe);
        _call(TRIGGER, address(receiver), abi.encodeCall(receiver.payFit, ()), fit);
        _cold(address(this));
        _call(TRIGGER, address(receiver), abi.encodeCall(receiver.payPlatform, ()), platform);
        if (!itemFirst) _claim(ledger, ids, owed);
        assertEq(price.balanceOf(fitSafe), beforeFit + fit);
        assertEq(price.balanceOf(address(this)), beforePlatform + platform);
        assertEq(price.balanceOf(ALICE), owed);
        assertEq(price.balanceOf(TRIGGER), 0, "third-party trigger receives no fee or tip");
        assertEq(price.balanceOf(address(pm)), beforePM - fit - platform - owed);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), receiverBacking - fit - platform);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), itemBacking - owed);
        assertEq(_unclaimedState(ledger), protected, "other items and origin native backing are unchanged");
        _call(TRIGGER, address(receiver), abi.encodeCall(receiver.payFit, ()), 0);
        _call(TRIGGER, address(receiver), abi.encodeCall(receiver.payPlatform, ()), 0);
        vm.prank(ALICE); vm.expectRevert(ItemLedgerV2.InvalidClaim.selector); ledger.claim(ids, ALICE);
        _booked();
    }

    function _claim(ItemLedgerV2 ledger, uint256[] memory ids, uint256 owed) private {
        _cold(ALICE); vm.cool(address(ledger)); vm.cool(release.implementations[16]);
        _call(ALICE, address(ledger), abi.encodeCall(ledger.claim, (ids, ALICE)), owed);
    }

    function _call(address caller, address target, bytes memory data, uint256 amount) private {
        vm.prank(caller);
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory result) = target.call{gas: CALL_GAS}(data);
        uint256 gross = GasBudget.transaction(beforeGas - gasleft(), data);
        assertTrue(ok, "cold production exit fits its submitted envelope");
        assertEq(abi.decode(result, (uint256)), amount);
        assertLt(CALL_GAS + GasBudget.intrinsic(data), 16_777_216);
        assertLt(gross * 130 / 100 + 500_000, 16_777_216);
        emit log_named_uint("cold payout gross gas", gross);
    }

    function _cold(address to) private {
        vm.cool(address(price)); vm.cool(release.implementations[20]);
        vm.cool(origin.roleAddress(17)); vm.cool(release.implementations[17]);
        vm.cool(address(receiver)); vm.cool(release.implementations[5]);
        vm.cool(address(pm)); vm.cool(to);
    }
}
