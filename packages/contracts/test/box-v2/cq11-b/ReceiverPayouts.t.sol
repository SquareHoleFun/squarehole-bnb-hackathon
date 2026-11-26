// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture} from "./ReceiverFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

/// C5.5/C15.5-7: accumulated claims are uint256, although each v4 redemption is int128.
contract ReceiverPayoutsTest is ReceiverFixture {
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));
    uint256 private constant MAX_BATCH = 4 * MAX_PART;
    uint256 private constant CALL_GAS = 2_000_000;
    // Four measured 2.5M Safe payout allowances plus EIP-150 and receiver entry work.
    uint256 private constant SAFE_CALL_GAS = 12_000_000;

    function _drainCreator() private returns (uint256 total) {
        while (r.creatorP() != 0) {
            uint256 owed = r.creatorP();
            uint256 batch = owed > MAX_BATCH ? MAX_BATCH : owed;
            uint256 claims = _balance(address(r));
            uint256 booked = r.booked(address(p));
            uint256 beforeBalance = p.balanceOf(PAYEE);
            vm.expectEmit(address(r));
            emit IBoxReceiverV2.CreatorClaimed(PAYEE, address(p), PAYEE, batch);
            vm.prank(PAYEE);
            uint256 paid = r.claimCreator{gas: CALL_GAS}(address(p), PAYEE);
            assertEq(paid, batch, "report only this bounded batch");
            assertEq(r.creatorP(), owed - paid);
            assertEq(_balance(address(r)), claims - paid);
            assertEq(r.booked(address(p)), booked - paid);
            assertEq(p.balanceOf(PAYEE), beforeBalance + paid);
            total += paid;
            _booked();
        }
    }

    function _drainSafe(bool fit) private returns (uint256 total) {
        address safe = fit ? FIT : PLATFORM;
        uint256 owed = fit ? r.fitOwed() : r.platformOwed();
        while (owed != 0) {
            uint256 batch = owed > MAX_BATCH ? MAX_BATCH : owed;
            uint256 claims = _balance(address(r));
            uint256 booked = r.booked(address(p));
            uint256 beforeBalance = p.balanceOf(safe);
            uint256 other = fit ? r.platformOwed() : r.fitOwed();
            vm.expectEmit(address(r));
            if (fit) emit IBoxReceiverV2.FitPaid(safe, batch);
            else emit IBoxReceiverV2.PlatformPaid(safe, batch);
            uint256 paid = fit ? r.payFit{gas: SAFE_CALL_GAS}() : r.payPlatform{gas: SAFE_CALL_GAS}();
            assertEq(paid, batch, "report only this bounded batch");
            assertEq(fit ? r.fitOwed() : r.platformOwed(), owed - paid);
            assertEq(fit ? r.platformOwed() : r.fitOwed(), other);
            assertEq(_balance(address(r)), claims - paid);
            assertEq(r.booked(address(p)), booked - paid);
            assertEq(p.balanceOf(safe), beforeBalance + paid);
            total += paid;
            owed -= paid;
            _booked();
        }
    }

    function _largeFees(uint256 amount) private {
        p.mint(address(driver), amount);
        uint256 left = amount;
        while (left != 0) {
            uint256 part = left > MAX_PART ? MAX_PART : left;
            driver.mintClaims(Currency.wrap(address(p)), address(r), part);
            left -= part;
        }
        r.collect(address(0));
        _booked();
    }

    function test_C5_creatorRedeemsMultiplePartsInFull() public {
        _largeFees(MAX_PART * 5);
        coord.graduation(r);
        uint256 owed = r.creatorP();
        uint256 claims = _balance(address(r));
        uint256 booked = r.booked(address(p));
        assertGt(owed, MAX_PART * 3);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), owed);
        assertEq(p.balanceOf(PAYEE), owed);
        assertEq(r.creatorP(), 0);
        assertEq(_balance(address(r)), claims - owed);
        assertEq(r.booked(address(p)), booked - owed);
        _booked();
    }

    function test_C5_safesRedeemMultiplePartsIndependently() public {
        _largeFees(MAX_PART * 31);
        uint256 fit = r.fitOwed();
        uint256 platform = r.platformOwed();
        assertGt(platform, MAX_PART * 2);
        assertEq(_drainSafe(true), fit);
        assertEq(_drainSafe(false), platform);
        assertEq(p.balanceOf(FIT), fit);
        assertEq(p.balanceOf(PLATFORM), platform);
        assertEq(r.fitOwed() + r.platformOwed(), 0);
        _booked();
    }

    /// Called by the token after its first transfer. A second transfer to the same recipient refuses.
    function blockNext(address to) external {
        require(msg.sender == address(p));
        p.setBlocked(to, true);
    }

    function test_C5_creatorLateRefusalRollsBackAllPartsThenRetries() public {
        _largeFees(MAX_PART * 5);
        coord.graduation(r);
        uint256 owed = r.creatorP();
        uint256 claims = _balance(address(r));
        uint256 manager = p.balanceOf(address(pm));
        p.armReentry(address(this), abi.encodeCall(this.blockNext, (PAYEE)));
        vm.prank(PAYEE);
        vm.expectRevert();
        r.claimCreator(address(p), PAYEE);
        assertEq(r.creatorP(), owed);
        assertEq(_balance(address(r)), claims);
        assertEq(p.balanceOf(address(pm)), manager);
        assertEq(p.balanceOf(PAYEE), 0);
        assertFalse(p.blocked(PAYEE));
        p.armReentry(address(0), "");
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), owed);
        assertEq(p.balanceOf(PAYEE), owed);
    }

    function test_C5_safeLateRefusalRestoresDebtAndOtherSafeStillPays() public {
        _largeFees(MAX_PART * 31);
        uint256 fit = r.fitOwed();
        uint256 platform = r.platformOwed();
        uint256 claims = _balance(address(r));
        p.armReentry(address(this), abi.encodeCall(this.blockNext, (FIT)));
        assertEq(r.payFit(), 0);
        assertEq(r.fitOwed(), fit);
        assertEq(_balance(address(r)), claims);
        assertEq(p.balanceOf(FIT), 0);
        assertFalse(p.blocked(FIT));
        p.armReentry(address(0), "");
        assertEq(_drainSafe(false), platform);
        assertEq(_drainSafe(true), fit);
        _booked();
    }

    function test_C5_inexactMultiPartPayoutIsAtomic() public {
        _largeFees(MAX_PART * 31);
        coord.graduation(r);
        uint256 claims = _balance(address(r));
        uint256 booked = r.booked(address(p));
        p.setFeeBps(1);
        vm.prank(PAYEE);
        vm.expectRevert();
        r.claimCreator(address(p), PAYEE);
        assertEq(r.payFit(), 0);
        assertEq(r.payPlatform(), 0);
        assertEq(_balance(address(r)), claims);
        assertEq(r.booked(address(p)), booked);
        assertEq(p.balanceOf(PAYEE) + p.balanceOf(FIT) + p.balanceOf(PLATFORM), 0);
        p.setFeeBps(0);
        uint256 owed = r.creatorP();
        assertEq(_drainCreator(), owed);
        _booked();
    }

    function test_C5_transactionSizedDebtsDrainThroughBoundedCalls() public {
        // Real backed claims: the reviewed full-debt Safe gas pre-check exceeds 16,777,216.
        _largeFees(MAX_PART * 630);
        assertEq(r.fitOwed(), MAX_PART * 84);
        assertEq(r.platformOwed(), MAX_PART * 42);
        assertEq(_drainSafe(true), MAX_PART * 84);
        assertEq(_drainSafe(false), MAX_PART * 42);
        coord.graduation(r);
        assertEq(_drainCreator(), MAX_PART * 420);
        assertEq(p.balanceOf(FIT), MAX_PART * 84);
        assertEq(p.balanceOf(PLATFORM), MAX_PART * 42);
        assertEq(p.balanceOf(PAYEE), MAX_PART * 420);
        assertEq(r.booked(address(p)), 0);
        assertEq(_balance(address(r)), 0);
        assertEq(r.payFit(), 0);
        assertEq(r.payPlatform(), 0);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), 0);
    }

    function test_C5_laterRefusedBatchPreservesUnpaidDebtAndEarlierPayment() public {
        _largeFees(MAX_PART * 90);
        coord.graduation(r);
        uint256 initialFit = r.fitOwed();
        uint256 initialCreator = r.creatorP();
        assertEq(r.payFit{gas: SAFE_CALL_GAS}(), MAX_BATCH);
        vm.prank(PAYEE);
        assertEq(r.claimCreator{gas: CALL_GAS}(address(p), PAYEE), MAX_BATCH);
        uint256 claims = _balance(address(r));
        uint256 booked = r.booked(address(p));
        p.armReentry(address(this), abi.encodeCall(this.blockNext, (FIT)));
        assertEq(r.payFit{gas: SAFE_CALL_GAS}(), 0);
        assertEq(r.fitOwed(), initialFit - MAX_BATCH);
        assertEq(p.balanceOf(FIT), MAX_BATCH);
        assertFalse(p.blocked(FIT));
        p.armReentry(address(this), abi.encodeCall(this.blockNext, (PAYEE)));
        vm.prank(PAYEE);
        vm.expectRevert();
        r.claimCreator{gas: CALL_GAS}(address(p), PAYEE);
        assertEq(r.creatorP(), initialCreator - MAX_BATCH);
        assertEq(p.balanceOf(PAYEE), MAX_BATCH);
        assertFalse(p.blocked(PAYEE));
        assertEq(_balance(address(r)), claims);
        assertEq(r.booked(address(p)), booked);
        p.armReentry(address(0), "");
        assertEq(_drainSafe(true), initialFit - MAX_BATCH);
        assertEq(_drainCreator(), initialCreator - MAX_BATCH);
        assertEq(p.balanceOf(FIT), initialFit);
        assertEq(p.balanceOf(PAYEE), initialCreator);
        _booked();
    }
}
