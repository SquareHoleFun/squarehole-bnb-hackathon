// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RewardLedger} from "../src/RewardLedger.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {PoolManagerClaims} from "../src/libraries/PoolManagerClaims.sol";
import {TransientReentrancyGuard} from "../src/libraries/TransientReentrancyGuard.sol";
import {Fixture} from "./utils/Fixture.sol";
import {MockERC20, ReentrantERC20} from "./utils/MockTokens.sol";

contract RewardLedgerTest is Fixture {
    uint256 internal constant Q = 1e18; // one whole Q

    function setUp() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 1e6, 1_000);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function _cfg() internal view returns (RewardLedger.Config memory) {
        return _config(address(0x7001), address(quote), address(0x7002), IRewardLedger.PayoutAsset.Q, launcher, true);
    }

    function test_constructor_rejectsZeroCoreAddresses() public {
        RewardLedger.Config memory c = _cfg();
        c.token = address(0);
        vm.expectRevert(RewardLedger.ZeroAddress.selector);
        new RewardLedger(c);
        c = _cfg();
        c.quote = address(0);
        vm.expectRevert(RewardLedger.ZeroAddress.selector);
        new RewardLedger(c);
        c = _cfg();
        c.feeCollector = address(0);
        vm.expectRevert(RewardLedger.ZeroAddress.selector);
        new RewardLedger(c);
        c = _cfg();
        c.treasury = address(0);
        vm.expectRevert(RewardLedger.ZeroAddress.selector);
        new RewardLedger(c);
        c = _cfg();
        c.poolManager = address(0); // custody of holder Q lives there (ADR-0011): required
        vm.expectRevert(RewardLedger.ZeroAddress.selector);
        new RewardLedger(c);
    }

    function test_constructor_payoutConverterPairing() public {
        RewardLedger.Config memory c = _cfg();
        c.payoutAsset = IRewardLedger.PayoutAsset.T; // R = T needs a converter
        vm.expectRevert(RewardLedger.InvalidPayoutConfig.selector);
        new RewardLedger(c);
        c = _cfg();
        c.converter = converter; // R = Q must not name one
        vm.expectRevert(RewardLedger.InvalidPayoutConfig.selector);
        new RewardLedger(c);
        c.payoutAsset = IRewardLedger.PayoutAsset.T;
        RewardLedger ok = new RewardLedger(c);
        assertEq(ok.converter(), converter);
    }

    function test_constructor_rejectsDuplicateRoles() public {
        RewardLedger.Config memory c = _cfg();
        c.launcher = treasury;
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.DuplicateRole.selector, treasury));
        new RewardLedger(c);
        c = _cfg();
        c.hook = poolManager;
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.DuplicateRole.selector, poolManager));
        new RewardLedger(c);
        c = _cfg();
        c.quote = c.token;
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.DuplicateRole.selector, c.token));
        new RewardLedger(c);
    }

    function test_constructor_allowsUnusedOptionalRoles() public {
        RewardLedger.Config memory c = _cfg();
        c.launcher = address(0);
        c.hook = address(0);
        c.nftMirror = false;
        RewardLedger l = new RewardLedger(c);
        assertFalse(l.isExcluded(address(0xdead)));
        assertFalse(l.isExcluded(address(0)), "unused roles never make the zero address excluded");
        assertTrue(l.isExcluded(address(l)));
        assertEq(l.mirror(), address(0), "the fungible template has no mirror role");
    }

    function test_exclusions_areRoleBasedAndImmutable() public view {
        address[9] memory ex = ledger.excludedAccounts();
        assertEq(ex[0], address(ledger));
        assertEq(ex[1], address(token));
        assertEq(ex[2], address(mirror));
        assertEq(ex[3], address(collector));
        assertEq(ex[4], treasury);
        assertEq(ex[5], address(0)); // no converter when R = Q
        assertEq(ex[6], launcher);
        assertEq(ex[7], poolManager);
        assertEq(ex[8], hook);
        for (uint256 i; i < ex.length; ++i) {
            if (ex[i] != address(0)) assertTrue(ledger.isExcluded(ex[i]));
        }
        assertFalse(ledger.isExcluded(alice));
        assertFalse(ledger.isExcluded(address(quote)));
    }

    /*//////////////////////////////////////////////////////////////
                             AUTHORIZATION
    //////////////////////////////////////////////////////////////*/

    function test_beforeBalanceChange_onlyToken() public {
        vm.prank(alice);
        vm.expectRevert(RewardLedger.NotToken.selector);
        ledger.beforeBalanceChange(alice, 0, bob, 0, 1);
    }

    function test_notifyHolderQ_onlyFeeCollector() public {
        address[4] memory callers = [alice, hook, treasury, address(token)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(RewardLedger.NotFeeCollector.selector);
            ledger.notifyHolderQ(0);
        }
    }

    function test_claim_onlyByAccountItself() public {
        _buy(alice, 10 * UNIT);
        _feeEvent(0, 3 * Q);
        vm.prank(bob);
        vm.expectRevert(RewardLedger.NotAccount.selector);
        ledger.claim(alice);
        assertEq(_claim(alice), 2 * Q, "sole holder gets all holder Q");
        assertEq(quote.balanceOf(alice), 2 * Q, "redeemed from the PoolManager as the ERC-20");
        assertEq(_claims(address(ledger), address(quote)), 0);
    }

    function test_claimFor_onlyConverter_andOnlyWhenPayoutIsT() public {
        _buy(alice, 10 * UNIT);
        _feeEvent(0, 3 * Q);
        vm.prank(converter);
        vm.expectRevert(RewardLedger.NotConverter.selector); // R = Q: converter role is empty
        ledger.claimFor(alice, type(uint256).max);

        _deploy(IRewardLedger.PayoutAsset.T, 1e6, 1_000);
        _buy(alice, 10 * UNIT);
        _feeEvent(0, 3 * Q);
        vm.prank(alice);
        vm.expectRevert(RewardLedger.WrongPayoutAsset.selector);
        ledger.claim(alice);
        vm.prank(alice);
        vm.expectRevert(RewardLedger.NotConverter.selector);
        ledger.claimFor(alice, type(uint256).max);
        vm.prank(converter);
        assertEq(ledger.claimFor(alice, type(uint256).max), 2 * Q);
        assertEq(_claims(converter, address(quote)), 2 * Q, "Q claims go to the converter, never elsewhere");
        assertEq(quote.balanceOf(converter), 0);
        assertEq(ledger.claimable(alice), 0);
        vm.prank(converter);
        assertEq(ledger.claimFor(alice, type(uint256).max), 0, "consumed exactly once");
    }

    /// Partial settlement (SH-B2 review round A, finding 4): the converter consumes at most `maxAmount`; the rest of
    /// the entitlement (and its sub-wei remainder) stays on the account and keeps accruing.
    function test_claimFor_partialAmountLeavesTheRestIntact() public {
        _deploy(IRewardLedger.PayoutAsset.T, 1e6, 1_000);
        _buy(alice, 10 * UNIT);
        _buy(bob, 20 * UNIT);
        _feeEvent(0, 3 * Q); // alice 2/3 Q, bob 4/3 Q (index dust ≤ 1 wei)
        uint256 owed = ledger.claimable(alice);
        vm.startPrank(converter);
        assertEq(ledger.claimFor(alice, 0), 0, "a zero slice consumes nothing");
        assertEq(ledger.claimFor(alice, Q / 4), Q / 4);
        assertEq(ledger.claimable(alice), owed - Q / 4);
        assertEq(ledger.totalClaimed(), Q / 4);
        assertEq(_claims(converter, address(quote)), Q / 4);
        assertEq(ledger.claimFor(alice, type(uint256).max), owed - Q / 4, "the rest, once");
        assertEq(ledger.claimFor(alice, 1), 0);
        vm.stopPrank();
        _feeEvent(0, 3 * Q);
        assertApproxEqAbs(ledger.claimable(alice), 2 * Q / 3, 1, "keeps accruing after partial claims");
    }

    function test_unlockCallback_onlyDuringOwnClaim() public {
        _buy(alice, 10 * UNIT);
        _feeEvent(0, 3 * Q);
        // The PoolManager calls back only the contract that unlocked it; a direct call (even pretending to be the
        // PoolManager) outside the ledger's guarded claim is refused, so nobody can redeem the ledger's claims.
        vm.prank(poolManager);
        vm.expectRevert(RewardLedger.NotPoolManager.selector);
        ledger.unlockCallback(abi.encode(bob, 2 * Q));
        vm.prank(bob);
        vm.expectRevert(RewardLedger.NotPoolManager.selector);
        ledger.unlockCallback(abi.encode(bob, 2 * Q));
        assertEq(_claims(address(ledger), address(quote)), 2 * Q);
    }

    /*//////////////////////////////////////////////////////////////
                    SPEC 05 WORKED EXAMPLE AND MODEL CASES
    //////////////////////////////////////////////////////////////*/

    /// Alice holds 25 of 100 eligible T; a fee event delivers 30 T and 3 Q.
    function test_workedExample_spec05() public {
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        uint256 supply = token.totalSupply();
        _feeEvent(30 * UNIT, 3 * Q);
        collector.processFees();
        assertEq(token.totalSupply(), supply - 30 * UNIT, "30 fee T burned");
        assertEq(quote.balanceOf(treasury), 1 * Q, "1 Q to the protocol");
        assertEq(ledger.claimable(alice), Q / 2, "alice earns 0.5 Q");
        assertEq(ledger.claimable(bob), 3 * Q / 2);
        assertEq(_claim(alice), Q / 2);
        assertEq(quote.balanceOf(alice), Q / 2);
    }

    function test_sellerKeepsPastClaim_buyerGetsNoRetroactiveClaim() public {
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        _feeEvent(0, 3 * Q);
        vm.prank(alice);
        token.transfer(carol, 25 * UNIT); // alice sells everything
        assertEq(token.balanceOf(alice), 0);
        assertEq(ledger.claimable(alice), Q / 2, "ECO-05: seller keeps prior earnings");
        assertEq(ledger.claimable(carol), 0, "ECO-05: buyer inherits nothing");
        assertEq(_claim(alice), Q / 2);
        _feeEvent(0, 3 * Q);
        assertEq(ledger.claimable(alice), 0);
        assertEq(ledger.claimable(carol), Q / 2, "buyer earns only later fees");
    }

    function test_nftTransferMovesFutureEarningsOnly() public {
        _buy(alice, 2 * UNIT);
        _buy(bob, 2 * UNIT);
        _feeEvent(0, 3 * Q);
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        vm.prank(alice);
        mirror.transferFrom(alice, bob, id);
        assertEq(ledger.claimable(alice), Q);
        assertEq(ledger.claimable(bob), Q);
        _feeEvent(0, 3 * Q);
        assertEq(ledger.claimable(alice), Q + Q / 2);
        assertEq(ledger.claimable(bob), Q + 3 * Q / 2);
    }

    function test_doubleClaimIsZero() public {
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        _feeEvent(0, 3 * Q);
        assertEq(_claim(alice), Q / 2);
        assertEq(_claim(alice), 0);
        assertEq(ledger.totalClaimed(), Q / 2);
    }

    function test_excludedAccountsNeverEarn() public {
        _buy(alice, 10 * UNIT);
        vm.startPrank(launcher);
        token.transfer(treasury, 5 * UNIT);
        token.transfer(poolManager, 5 * UNIT);
        token.transfer(address(token), UNIT);
        token.transfer(address(mirror), UNIT);
        token.transfer(address(ledger), UNIT);
        vm.stopPrank();
        _feeEvent(7 * UNIT, 3 * Q);
        address[9] memory ex = ledger.excludedAccounts();
        for (uint256 i; i < ex.length; ++i) {
            assertEq(ledger.claimable(ex[i]), 0, "ECO-12");
            (uint256 cp, uint256 acc) = ledger.accountState(ex[i]);
            assertEq(cp + acc, 0, "excluded accounts are never settled");
        }
        assertEq(ledger.claimable(alice), 2 * Q, "the only eligible holder gets all holder Q");
        vm.prank(launcher);
        assertEq(ledger.claim(launcher), 0);
    }

    function test_tOnlyFeeCreatesNoQ() public {
        _buy(alice, 10 * UNIT);
        _feeEvent(30 * UNIT, 0);
        assertEq(ledger.rewardIndex(), 0);
        assertEq(ledger.claimable(alice), 0, "ECO-10");
        assertEq(ledger.totalHolderQReceived(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                       ZERO ELIGIBLE SUPPLY / BOOTSTRAP
    //////////////////////////////////////////////////////////////*/

    function test_bootstrap_deferredToNextValidFeeCheckpoint() public {
        assertEq(ledger.eligibleSupply(), 0);
        _prepareFee(10 * UNIT, 3 * Q);
        vm.expectEmit(address(ledger));
        emit IRewardLedger.HolderQDeferred(2 * Q, 2 * Q);
        vm.prank(hook);
        collector.receiveFees(10 * UNIT, 3 * Q);
        assertEq(ledger.bootstrapQ(), 2 * Q, "ECO-08: kept in a separate bucket");
        assertEq(ledger.rewardIndex(), 0);

        _buy(alice, 10 * UNIT);
        assertEq(ledger.claimable(alice), 0, "first recipient cannot claim bootstrap by a balance read");

        _feeEvent(0, 3 * Q);
        assertEq(ledger.bootstrapQ(), 0);
        assertEq(ledger.claimable(alice), 4 * Q, "released with the next fee event");
    }

    function test_bootstrap_releasedByTOnlyFeeEvent() public {
        _feeEvent(0, 3 * Q);
        _buy(alice, 10 * UNIT);
        _feeEvent(UNIT, 0);
        assertEq(ledger.bootstrapQ(), 0);
        assertEq(ledger.claimable(alice), 2 * Q);
    }

    function test_bootstrap_notReleasedByPermissionlessProcessing() public {
        _feeEvent(0, 3 * Q);
        _buy(alice, 10 * UNIT);
        collector.processFees();
        assertEq(ledger.bootstrapQ(), 2 * Q, "only an authenticated fee event releases it");
        assertEq(ledger.claimable(alice), 0);
    }

    function test_bootstrap_whenAllHoldersSellBackToExcluded() public {
        _buy(alice, 10 * UNIT);
        vm.prank(alice);
        token.transfer(launcher, 10 * UNIT);
        assertEq(ledger.eligibleSupply(), 0);
        _feeEvent(0, 3 * Q);
        assertEq(ledger.bootstrapQ(), 2 * Q);
        assertEq(ledger.claimable(alice), 0);
    }

    /*//////////////////////////////////////////////////////////////
                           ROUNDING AND BOUNDS
    //////////////////////////////////////////////////////////////*/

    function test_newPayoutUnitsOnlyEarnLater() public {
        _deploy(IRewardLedger.PayoutAsset.T, 1e6, 1_000);
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        _feeEvent(0, 3 * Q);
        // R = T: the converter consumes alice's Q (as claims) and buys T for her; here the market pays 50 T.
        vm.prank(converter);
        assertEq(ledger.claimFor(alice, type(uint256).max), Q / 2);
        _buy(alice, 50 * UNIT);
        assertEq(ledger.claimable(alice), 0, "payout T earns nothing retroactively");
        _feeEvent(0, 3 * Q);
        // alice now holds 75 of 150 eligible T: 1 Q exactly in the model; the index floors, so the ledger may keep
        // at most one wei (never pays more than the exact share).
        assertLe(ledger.claimable(alice), Q);
        assertApproxEqAbs(ledger.claimable(alice), Q, 1);
    }

    function test_subWeiEntitlementsAreKeptNotLost() public {
        _buy(alice, 1);
        _buy(bob, 3 * UNIT);
        for (uint256 i; i < 10; ++i) {
            _feeEvent(0, 3);
        }
        // alice's share per event is 2 × 1/(3·UNIT+1) wei: accrued in scaled units, never rounded away.
        (, uint256 scaled) = ledger.accountState(alice);
        assertEq(scaled, 0, "not settled yet");
        _buy(alice, 1); // settles alice
        (, scaled) = ledger.accountState(alice);
        assertGt(scaled, 0);
        assertEq(ledger.claimable(alice), 0);
        uint256 total = ledger.claimable(alice) + ledger.claimable(bob);
        assertLe(total, 20);
        assertGe(total, 20 - 2, "dust <= one wei per account");
    }

    function test_indexRemainderIsCarried() public {
        _buy(alice, 1 * UNIT);
        _buy(bob, 2 * UNIT);
        _feeEvent(0, 3);
        // numerator 2e36 over 3·UNIT eligible: remainder must be tracked, not dropped.
        assertEq(ledger.indexRemainder(), (2 * 1e36) % (3 * UNIT));
        uint256 idx = ledger.rewardIndex();
        assertEq(idx, (2 * 1e36) / (3 * UNIT));
        _feeEvent(0, 3);
        assertEq(ledger.rewardIndex(), (4 * 1e36) / (3 * UNIT));
    }

    function testFuzz_proRataWithinOneWei(uint96 a, uint96 b, uint128 q) public {
        uint256 amountA = bound(a, 1, 60 * UNIT);
        uint256 amountB = bound(b, 1, 60 * UNIT);
        uint256 qAmount = bound(q, 3, 1e30) / 3 * 3; // multiple of 3: no collector carry
        _buy(alice, amountA);
        _buy(bob, amountB);
        _feeEvent(0, qAmount);
        uint256 holder = qAmount / 3 * 2;
        uint256 s = amountA + amountB;
        assertApproxEqAbs(ledger.claimable(alice), holder * amountA / s, 1);
        assertApproxEqAbs(ledger.claimable(bob), holder * amountB / s, 1);
        assertLe(ledger.claimable(alice) + ledger.claimable(bob), holder, "never over-allocated");
    }

    function test_holderQCap() public {
        _buy(alice, UNIT);
        uint256 cap = ledger.MAX_TOTAL_HOLDER_Q();
        // One PoolManager delta is an int128: fund the collector with cap = 2^128 − 1 claims in three deposits.
        uint256 chunk = uint256(uint128(type(int128).max));
        funder.deposit(address(quote), address(0), chunk, address(collector));
        funder.deposit(address(quote), address(0), chunk, address(collector));
        funder.deposit(address(quote), address(0), cap - 2 * chunk, address(collector));
        vm.startPrank(address(collector));
        pm.approve(address(ledger), _id(address(quote)), cap);
        ledger.notifyHolderQ(cap); // exactly the cap is accepted
        vm.stopPrank();
        funder.deposit(address(quote), address(0), 1, address(collector));
        vm.startPrank(address(collector));
        pm.approve(address(ledger), _id(address(quote)), 1);
        vm.expectRevert(RewardLedger.HolderQCapExceeded.selector);
        ledger.notifyHolderQ(1);
        vm.stopPrank();
        assertEq(ledger.claimable(alice), cap, "no overflow at the cap");
    }

    /*//////////////////////////////////////////////////////////////
                    EXACT RECEIPTS, DONATIONS, HOSTILE Q
    //////////////////////////////////////////////////////////////*/

    function test_notify_pullsExactlyAndIgnoresDonations() public {
        _buy(alice, UNIT);
        funder.deposit(address(quote), address(0), 5 * Q, address(ledger)); // unsolicited claims
        quote.mint(address(ledger), 4 * Q); // unsolicited ERC-20
        vm.prank(address(collector));
        vm.expectRevert(); // no claims, no allowance: a donation cannot stand in for the collector's Q
        ledger.notifyHolderQ(Q);
        _feeEvent(0, 3 * Q);
        assertEq(ledger.totalHolderQReceived(), 2 * Q);
        assertEq(ledger.claimable(alice), 2 * Q, "donation is not holder Q");
        assertEq(ledger.sweepUnaccountedClaims(address(quote)), 5 * Q, "surplus claims above what is owed");
        assertEq(_claims(treasury, address(quote)), 5 * Q, "donations go to the treasury, never holders");
        assertEq(ledger.sweepUnaccounted(address(quote)), 4 * Q, "ERC-20 Q in the ledger is always unsolicited");
        assertEq(quote.balanceOf(treasury), 4 * Q);
        vm.expectRevert(RewardLedger.NothingToSweep.selector);
        ledger.sweepUnaccountedClaims(address(quote));
        vm.expectRevert(RewardLedger.NothingToSweep.selector);
        ledger.sweepUnaccounted(address(quote));
        assertEq(_claim(alice), 2 * Q, "owed Q was not swept");
    }

    function test_sweep_tAndUnsupportedAssets() public {
        _buy(alice, UNIT);
        vm.prank(alice);
        token.transfer(address(ledger), UNIT / 2);
        assertEq(ledger.sweepUnaccounted(address(token)), UNIT / 2);
        assertEq(token.balanceOf(treasury), UNIT / 2);
        funder.deposit(address(token), launcher, UNIT, address(ledger));
        assertEq(ledger.sweepUnaccountedClaims(address(token)), UNIT, "T claims are never owed by the ledger");
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.NotSweepable.selector, address(0xabc)));
        ledger.sweepUnaccounted(address(0xabc));
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.NotSweepable.selector, address(0xabc)));
        ledger.sweepUnaccountedClaims(address(0xabc));
    }

    /// The only ERC-6909 pull is the collector's exact allowance; the ledger checks the pull's balance delta.
    function test_notify_exactClaimsPull() public {
        _buy(alice, UNIT);
        funder.deposit(address(quote), address(0), 1000, address(collector));
        vm.startPrank(address(collector));
        pm.approve(address(ledger), _id(address(quote)), 999);
        vm.expectRevert(); // allowance below the notified amount
        ledger.notifyHolderQ(1000);
        pm.approve(address(ledger), _id(address(quote)), 1000);
        ledger.notifyHolderQ(1000);
        vm.stopPrank();
        assertEq(_claims(address(ledger), address(quote)), 1000);
        assertEq(pm.allowance(address(collector), address(ledger), _id(address(quote))), 0);
    }

    function test_claim_reentrancyBlocked() public {
        ReentrantERC20 hostile = new ReentrantERC20();
        quote = MockERC20(address(hostile));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e7, 100, address(hostile));
        _buy(alice, UNIT);
        _feeEvent(0, 3 * Q);
        hostile.arm(address(ledger), abi.encodeCall(RewardLedger.claim, (alice)));
        assertEq(_claim(alice), 2 * Q);
        assertFalse(hostile.lastCallSucceeded());
        assertEq(bytes4(hostile.lastRevertData()), TransientReentrancyGuard.Reentrancy.selector);
        assertEq(hostile.balanceOf(alice), 2 * Q, "paid exactly once");
    }

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    function test_events_allocationSettlementClaim() public {
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        uint256 delta = (2 * Q * 1e36) / (100 * UNIT);
        _prepareFee(0, 3 * Q);
        vm.expectEmit(address(ledger));
        emit IRewardLedger.HolderQAllocated(2 * Q, 0, 100 * UNIT, delta, delta);
        vm.prank(hook);
        collector.receiveFees(0, 3 * Q);

        vm.expectEmit(address(ledger));
        emit IRewardLedger.Settled(alice, 25 * UNIT, 0, delta, 25 * UNIT * delta);
        vm.prank(alice);
        token.transfer(carol, UNIT);

        vm.expectEmit(address(ledger));
        emit IRewardLedger.Claimed(alice, alice, Q / 2);
        _claim(alice);
    }

    function test_accruedView_isSettledPartOnly() public {
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        _feeEvent(0, 3 * Q);
        assertEq(ledger.accrued(alice), 0, "not settled yet");
        assertEq(ledger.claimable(alice), Q / 2, "but already claimable");
        vm.prank(alice);
        token.transfer(carol, 1); // settles alice at 25 units
        assertEq(ledger.accrued(alice), Q / 2);
        (uint256 cp, uint256 scaled) = ledger.accountState(alice);
        assertEq(cp, ledger.rewardIndex());
        assertEq(scaled / 1e36, Q / 2);
    }

    function test_holderQOutstanding() public {
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
        _feeEvent(0, 3 * Q);
        _claim(alice);
        assertEq(ledger.holderQOutstanding(), 3 * Q / 2);
        assertEq(ledger.quoteClaims(), ledger.holderQOutstanding(), "the ledger holds exactly what it owes");
        assertEq(PoolManagerClaims.claimId(address(quote)), _id(address(quote)));
    }
}
