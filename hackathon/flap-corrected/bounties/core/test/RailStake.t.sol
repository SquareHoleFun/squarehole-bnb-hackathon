// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {RailStake} from "../src/RailStake.sol";
import {RailStakeFactory} from "../src/RailStakeFactory.sol";
import {IRailStake, IRailStakeFactory} from "../src/IRailStake.sol";
import {RuleSplitter} from "../src/RuleSplitter.sol";
import {IRuleSplitter} from "../src/IRuleSplitter.sol";
import {MockToken} from "./FeeRules.t.sol";
import {FlexToken} from "./RuleSplitter.t.sol";

/// @dev A token whose transferFrom reports false.
contract FalseToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev A token whose balance read fails until a transfer has moved tokens since the fail mode was switched on.
contract ReadAfterMoveToken {
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public failMode;
    bool public moved;

    function setFailMode(bool f) external {
        failMode = f;
        moved = false;
    }

    function mint(address to, uint256 a) external {
        _bal[to] += a;
    }

    function approve(address sp, uint256 a) external returns (bool) {
        allowance[msg.sender][sp] = a;
        return true;
    }

    function balanceOf(address a) external view returns (uint256) {
        require(!failMode || moved, "no read");
        return _bal[a];
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _bal[msg.sender] -= a;
        _bal[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        _bal[f] -= a;
        _bal[to] += a;
        moved = true;
        return true;
    }
}

/// @dev A staker contract that can refuse the native coin, or try to re-enter from its payment.
contract NativeStaker {
    RailStake public s;
    bool public refuse;
    bool public reenter;
    bytes public reentryError;

    constructor(RailStake s_) {
        s = s_;
    }

    function set(bool refuse_, bool reenter_) external {
        refuse = refuse_;
        reenter = reenter_;
    }

    function doStake(MockToken tok, uint256 amount) external {
        tok.approve(address(s), amount);
        s.stake(amount);
    }

    function doUnstake(uint256 amount) external {
        s.unstake(amount);
    }

    function doClaim() external returns (uint256) {
        return s.claim();
    }

    function doClaimTo(address to) external returns (uint256) {
        return s.claimTo(to);
    }

    receive() external payable {
        if (refuse) revert("no coin");
        if (reenter) {
            try s.claim() returns (uint256) {}
            catch (bytes memory e) {
                reentryError = e;
            }
        }
    }
}

contract RailStakeTest is Test {
    uint256 constant PERIOD = 7 days;
    uint256 constant S = 1e27;
    RailStakeFactory f;
    MockToken tok;
    FlexToken usd;
    RailStake s; // test dollar income
    RailStake n; // native income
    address creator = address(0xC0);
    address alice = address(0xA1);
    address bob = address(0xB0);
    address eve = address(0xE5);

    function setUp() public {
        vm.warp(1_000_000);
        f = new RailStakeFactory();
        tok = new MockToken();
        usd = new FlexToken();
        vm.startPrank(creator);
        s = RailStake(payable(f.create(address(tok), address(usd), PERIOD)));
        MockToken tok2 = new MockToken();
        n = RailStake(payable(f.create(address(tok2), address(0), PERIOD)));
        vm.stopPrank();
    }

    function _stake(RailStake st, address who, uint256 amount) internal returns (uint256 credited) {
        MockToken t = MockToken(payable(st.token()));
        t.mint(who, amount);
        vm.prank(who);
        t.approve(address(st), amount);
        vm.prank(who);
        credited = st.stake(amount);
    }

    function _claim(RailStake st, address who) internal returns (uint256) {
        vm.prank(who);
        return st.claim();
    }

    /// claimed * S + sum(earnedScaled) + undistributedScaled == arrived * S, and the asset covers what is owed.
    function _exact(RailStake st, address[] memory who) internal view {
        uint256 sum = st.claimed() * S + st.undistributedScaled();
        for (uint256 i; i < who.length; ++i) {
            sum += st.earnedScaled(who[i]);
        }
        assertEq(sum, st.arrived() * S, "claimed + claimable + undistributed == arrived");
        assertLe(st.claimed(), st.arrived());
    }

    function _three() internal view returns (address[] memory w) {
        w = new address[](3);
        w[0] = alice;
        w[1] = bob;
        w[2] = eve;
    }

    // ── P1: the stake comes back, in full, to its staker only, always ───────

    function test_unstake_inFull_anyTime() public {
        _stake(s, alice, 100e18);
        usd.mint(address(s), 1000e18);
        s.sync();
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        s.unstake(100e18); // one second later, in the middle of a stream
        assertEq(tok.balanceOf(alice), 100e18);
        assertEq(s.stakedOf(alice), 0);
        assertEq(s.totalStaked(), 0);
        assertGt(s.claimable(alice), 0, "what it earned stays claimable after the unstake");
    }

    function test_onlyTheStakerTakesItOut() public {
        _stake(s, alice, 100e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IRailStake.NotStaked.selector, 0));
        s.unstake(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRailStake.NotStaked.selector, 100e18));
        s.unstake(100e18 + 1);
    }

    function test_refusingAsset_neverBlocksUnstake() public {
        _stake(s, alice, 100e18);
        usd.mint(address(s), 1000e18);
        s.sync();
        vm.warp(block.timestamp + PERIOD);
        usd.setModes(true, false, address(0), false); // the asset's transfer returns false
        uint256 owed = s.claimable(alice);
        vm.prank(alice);
        vm.expectRevert(IRailStake.TransferFailed.selector);
        s.claim();
        assertEq(s.claimable(alice), owed, "a failed claim stays owed");
        vm.prank(alice);
        s.unstake(100e18);
        assertEq(tok.balanceOf(alice), 100e18, "the unstake does not touch the asset");
        usd.setModes(false, false, address(0), false);
        assertEq(_claim(s, alice), owed);
    }

    function test_refusingNativePayee_neverBlocksUnstake_claimToPaysElsewhere() public {
        NativeStaker ns = new NativeStaker(n);
        MockToken(payable(n.token())).mint(address(ns), 50e18);
        ns.doStake(MockToken(payable(n.token())), 50e18);
        vm.deal(address(n), 3 ether);
        n.sync();
        vm.warp(block.timestamp + PERIOD);
        ns.set(true, false);
        vm.expectRevert(IRailStake.TransferFailed.selector);
        ns.doClaim();
        ns.doUnstake(50e18);
        assertEq(MockToken(payable(n.token())).balanceOf(address(ns)), 50e18);
        uint256 paid = ns.doClaimTo(bob);
        assertEq(bob.balance, paid);
        assertApproxEqAbs(paid, 3 ether, 1);
    }

    // ── P2: measured by balance ─────────────────────────────────────────────

    function test_stake_creditsWhatArrived_taxingToken() public {
        tok.setTransferFeeBps(1000); // 10% of every transfer burned
        uint256 credited = _stake(s, alice, 100e18);
        assertEq(credited, 90e18);
        assertEq(s.stakedOf(alice), 90e18);
        assertEq(tok.balanceOf(address(s)), 90e18);
        vm.prank(alice);
        s.unstake(90e18);
        assertEq(tok.balanceOf(alice), 81e18, "the credited 90 is sent; the token's 10% tax leaves the staker 81");
        assertEq(tok.balanceOf(address(s)), 0, "nothing short for anyone");
        assertEq(s.totalStaked(), 0);
    }

    function test_income_countedOnce_byBalance() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 500);
        assertEq(s.unsynced(), 500);
        assertEq(s.sync(), 500);
        assertEq(s.sync(), 0, "counted once");
        assertEq(s.arrived(), 500);
        assertEq(s.unsynced(), 0);
    }

    function test_stake_tokenReturningFalse_refused() public {
        FalseToken ft = new FalseToken();
        vm.prank(creator);
        RailStake fs = RailStake(payable(f.create(address(ft), address(usd), PERIOD)));
        ft.mint(alice, 10);
        vm.prank(alice);
        vm.expectRevert(IRailStake.TransferFailed.selector);
        fs.stake(10);
    }

    // ── P3 and P4: even, never more than arrived ────────────────────────────

    function test_evenPerTokenAndSecond() public {
        _stake(s, alice, 1e18);
        _stake(s, bob, 3e18);
        usd.mint(address(s), 1000e18);
        s.sync();
        assertEq(s.ratePerSecond(), 1000e18 / PERIOD);
        vm.warp(block.timestamp + PERIOD / 2);
        assertApproxEqAbs(s.claimable(alice), 125e18, 1);
        vm.warp(block.timestamp + PERIOD);
        assertApproxEqAbs(_claim(s, alice), 250e18, 1);
        assertApproxEqAbs(_claim(s, bob), 750e18, 1);
        _exact(s, _three());
        assertLe(s.claimed(), 1000e18);
    }

    /// A large stake just before the share-out, gone just after, earns only its seconds.
    function test_justInTimeStaker_earnsOnlyItsSeconds() public {
        _stake(s, alice, 1e18);
        uint256 x = 1000e18;
        usd.mint(address(s), x); // a big payment lands, not yet counted
        _stake(s, eve, 1000e18); // 1000 times alice's stake, right before the sync
        s.sync();
        vm.warp(block.timestamp + 3); // one BNB Chain block
        vm.prank(eve);
        s.unstake(1000e18);
        uint256 got = _claim(s, eve);
        assertLe(got, x * 3 / PERIOD + 1, "at most income * seconds / period");
        assertGt(got, 0);
        vm.warp(block.timestamp + PERIOD);
        uint256 a = _claim(s, alice);
        assertApproxEqAbs(a + got, x, 2, "the rest goes to the one who stayed");
        _exact(s, _three());
    }

    /// With a leftover L still streaming (r seconds left), a staker who comes right before a sync of `income` and
    /// leaves s seconds later earns at most (L / r + income / period) * s.
    function testFuzz_justInTimeStaker_bound(uint256 x0, uint256 t0, uint256 x, uint256 big, uint256 small, uint256 dt)
        public
    {
        x0 = bound(x0, 0, 1e30);
        t0 = bound(t0, 0, PERIOD - 1);
        x = bound(x, 1e6, 1e30);
        big = bound(big, 1, 1e30);
        small = bound(small, 1, 1e30);
        dt = bound(dt, 1, PERIOD);
        _stake(s, alice, small);
        usd.mint(address(s), x0);
        s.sync();
        vm.warp(block.timestamp + t0);
        uint256 leftScaled = s.undistributedScaled();
        uint256 r = s.streamEnd() > block.timestamp ? s.streamEnd() - block.timestamp : 0;
        usd.mint(address(s), x);
        _stake(s, eve, big);
        s.sync();
        uint256 after_ = s.streamEnd() - block.timestamp; // R, the new end rounded down to a whole second
        vm.warp(block.timestamp + dt);
        vm.prank(eve);
        s.unstake(big);
        uint256 got = _claim(s, eve);
        // leftScaled includes a waiting carry (less than one increment at alice's total)
        uint256 fromLeft = r == 0 ? leftScaled / S : leftScaled * dt / r / S;
        uint256 bound_ = (fromLeft + x * dt / PERIOD + small / S + 3) * (after_ + 1) / after_;
        assertLe(got, bound_, "its share of (L / r + income / period) * s + an increment, times (R + 1) / R");
        _exact(s, _three());
    }

    function test_justInTimeStaker_withALeftoverStreaming() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 700e18);
        s.sync();
        vm.warp(block.timestamp + PERIOD / 2);
        uint256 leftScaled = s.undistributedScaled();
        uint256 r = s.streamEnd() - block.timestamp;
        usd.mint(address(s), 1000e18);
        _stake(s, eve, 1000e18);
        s.sync();
        uint256 after_ = s.streamEnd() - block.timestamp;
        vm.warp(block.timestamp + 3);
        vm.prank(eve);
        s.unstake(1000e18);
        uint256 got = _claim(s, eve);
        assertLe(got, (leftScaled * 3 / r / S + 1000e18 * 3 / PERIOD + 3) * (after_ + 1) / after_);
        assertGt(got, 0);
        _exact(s, _three());
    }

    function test_roundingStaysInTheContract() public {
        _stake(s, alice, 1);
        _stake(s, bob, 2);
        _stake(s, eve, 4);
        usd.mint(address(s), 1001);
        s.sync();
        for (uint256 i; i < 13; ++i) {
            vm.warp(block.timestamp + 12_345);
            _claim(s, alice);
            _claim(s, bob);
            _exact(s, _three());
        }
        vm.warp(block.timestamp + PERIOD);
        _claim(s, alice);
        _claim(s, bob);
        _claim(s, eve);
        _exact(s, _three());
        assertLe(s.claimed(), 1001);
        assertGe(s.claimed(), 1001 - 3, "at most one unit per staker waits as a fraction");
        assertEq(usd.balanceOf(address(s)), 1001 - s.claimed());
    }

    // ── P5: income while nobody stakes waits ────────────────────────────────

    function test_countedIncome_pausesWhileNobodyStakes_firstStakerEarnsPerSecond() public {
        uint256 x = 700e18;
        usd.mint(address(s), x);
        s.sync(); // nobody staked
        uint256 end0 = s.streamEnd();
        assertEq(end0, block.timestamp + PERIOD);
        vm.warp(block.timestamp + 3 days);
        assertEq(s.streamEnd(), end0 + 3 days, "the stream's end moves with the clock");
        assertEq(s.ratePerSecond(), 0);
        assertEq(s.undistributed(), x, "nothing streamed into the void");
        _stake(s, alice, 1); // the first staker, one wei
        vm.warp(block.timestamp + 1);
        assertLe(s.claimable(alice), x / PERIOD + 1, "per second, never at once");
        vm.warp(block.timestamp + PERIOD);
        assertApproxEqAbs(_claim(s, alice), x, 1, "alone for the whole remaining stream: all of it");
    }

    function test_unsyncedIncome_waitsForASync() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 100e18);
        vm.warp(block.timestamp + PERIOD);
        assertEq(s.claimable(alice), 0);
        assertEq(s.unsynced(), 100e18);
        s.sync();
        vm.warp(block.timestamp + PERIOD);
        assertApproxEqAbs(s.claimable(alice), 100e18, 1);
    }

    // ── caller influence: the moment of a sync ──────────────────────────────

    function test_syncWithoutIncome_changesNothing() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 100e18);
        s.sync();
        uint256 end0 = s.streamEnd();
        vm.warp(block.timestamp + 1 days);
        s.sync();
        assertEq(s.streamEnd(), end0, "an empty sync changes nothing");
    }

    /// One wei synced every block for a thousand blocks cannot stretch a stream that should end.
    function test_tinyIncomeEveryBlock_cannotStretchTheStream() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 1000e18);
        s.sync();
        uint256 end0 = s.streamEnd();
        for (uint256 i; i < 1000; ++i) {
            vm.warp(block.timestamp + 3);
            usd.mint(address(s), 1);
            assertEq(s.sync(), 1);
        }
        // each sync moves the end by at most period * 1 / (L + 1) rounded down: 0 while L is above a period in wei
        assertEq(s.streamEnd(), end0, "the end did not move");
        vm.warp(end0);
        assertEq(s.undistributed(), 0, "everything streamed by the original end");
        assertApproxEqAbs(_claim(s, alice), 1000e18 + 1000, 1);
        _exact(s, _three());
    }

    function test_realIncome_streamsOverAboutAPeriod() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 100e18);
        s.sync();
        assertEq(s.streamEnd(), block.timestamp + PERIOD, "nothing left over: a full period");
        vm.warp(block.timestamp + PERIOD / 2);
        uint256 left = s.undistributed(); // about 50e18 with PERIOD / 2 left
        usd.mint(address(s), left);
        s.sync();
        // an income the size of the leftover: the mean of PERIOD / 2 and PERIOD
        assertApproxEqAbs(s.streamEnd(), block.timestamp + PERIOD * 3 / 4, 1);
    }

    // ── P6: no re-entry ─────────────────────────────────────────────────────

    function test_reentry_fromTheToken_refused() public {
        tok.setHook(address(s), abi.encodeCall(RailStake.sync, ()), 0);
        _stake(s, alice, 1e18);
        assertFalse(tok.hookOk());
        assertEq(tok.hookReturn(), abi.encodeWithSelector(IRailStake.Reentrancy.selector));
    }

    function test_reentry_fromTheNativePayment_refused() public {
        NativeStaker ns = new NativeStaker(n);
        MockToken t = MockToken(payable(n.token()));
        t.mint(address(ns), 1e18);
        ns.doStake(t, 1e18);
        vm.deal(address(n), 1 ether);
        n.sync();
        vm.warp(block.timestamp + PERIOD);
        ns.set(false, true);
        uint256 paid = ns.doClaim();
        assertApproxEqAbs(paid, 1 ether, 1);
        assertEq(ns.reentryError(), abi.encodeWithSelector(IRailStake.Reentrancy.selector));
    }

    // ── P7: nothing stops it for good ───────────────────────────────────────

    function test_hugeOpenMintAsset_countedInChunks_neverStops() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 2 ** 200);
        uint256 first = s.sync();
        assertEq(first, s.MAX_OUTSTANDING(), "counted up to the cap, the rest waits");
        vm.warp(block.timestamp + PERIOD);
        uint256 paid = _claim(s, alice);
        assertApproxEqAbs(paid, first, 1);
        assertGt(s.sync(), 0, "the next chunk counts once claims made room");
        vm.prank(alice);
        s.unstake(1e18);
        _exact(s, _three());
    }

    function test_assetReturningNothing_paysOut() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 10e18);
        s.sync();
        vm.warp(block.timestamp + PERIOD);
        usd.setModes(false, true, address(0), false);
        uint256 paid = _claim(s, alice);
        assertApproxEqAbs(paid, 10e18, 1);
        assertEq(usd.balanceOf(alice), paid);
    }

    // ── as the payee of a splitter's CREATOR rule ───────────────────────────

    function test_asSplitterPayee_nativeAndDollar() public {
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](2);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 6000, target: creator});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 4000, target: address(n)});
        RuleSplitter sp = new RuleSplitter(n.token(), address(0), r);
        vm.deal(address(sp), 1000);
        sp.distribute();
        assertEq(sp.owed(1), 0, "accepted within the splitter's gas");
        assertEq(n.unsynced(), 400);
        (bool ok,) = address(n).call{value: 1, gas: 2300}("");
        assertTrue(ok, "even a 2300 gas transfer is received");

        r[1].target = address(s);
        RuleSplitter sp2 = new RuleSplitter(address(tok), address(usd), r);
        usd.mint(address(sp2), 1000);
        sp2.distribute();
        assertEq(s.unsynced(), 400);
    }

    // ── receiving: the asset must match the payer's ─────────────────────────

    function test_receive_nativeValue_refusedForAnErc20Asset_splitterKeepsItOwed() public {
        (bool ok, bytes memory err) = address(s).call{value: 1}("");
        assertFalse(ok, "value refused when the asset is the test dollar");
        assertEq(err, abi.encodeWithSelector(IRailStake.WrongAsset.selector));
        (ok,) = address(s).call("");
        assertTrue(ok, "the empty zero-value call is accepted");
        (ok,) = address(n).call{value: 1}("");
        assertTrue(ok, "value accepted when the asset is native");

        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](2);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 6000, target: creator});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 4000, target: address(s)});
        RuleSplitter sp = new RuleSplitter(address(tok), address(0), r); // a native payer naming a dollar stake
        vm.deal(address(sp), 1000);
        sp.distribute();
        assertEq(sp.owed(1), 400, "the splitter keeps the part owed");
        assertEq(address(s).balance, 0, "no coin stuck in the stake");
    }

    // ── pins ────────────────────────────────────────────────────────────────

    function test_stake_beforeTheTokenHasCode_reverts() public {
        vm.prank(creator);
        RailStake early = RailStake(payable(f.create(address(0x7777), address(usd), PERIOD)));
        vm.prank(alice);
        vm.expectRevert(IRailStake.BalanceUnreadable.selector); // no code: the balance read answers nothing
        early.stake(1);
    }

    function _restake(address who, uint256 amount) internal {
        vm.startPrank(who);
        tok.approve(address(s), amount);
        s.stake(amount);
        vm.stopPrank();
    }

    function test_severalPauses_keepTheSameRemainingSeconds() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 700e18);
        s.sync();
        uint256 end0 = s.streamEnd();
        vm.warp(block.timestamp + PERIOD / 4);
        vm.prank(alice);
        s.unstake(1e18); // pause 1
        vm.warp(block.timestamp + 1 days);
        _restake(alice, 1e18);
        vm.warp(block.timestamp + PERIOD / 4);
        vm.prank(alice);
        s.unstake(1e18); // pause 2
        vm.warp(block.timestamp + 2 days);
        _restake(alice, 1e18);
        assertEq(s.streamEnd(), end0 + 3 days, "the end moved by exactly the paused seconds");
        assertEq(s.streamEnd() - block.timestamp, PERIOD / 2, "half the stream still to come");
        vm.warp(s.streamEnd());
        assertApproxEqAbs(_claim(s, alice), 700e18, 1, "the one staker got it all, only while staked");
        _exact(s, _three());
    }

    function test_oneWeiTotal_largestOutstanding_noOverflow() public {
        _stake(s, alice, 1);
        usd.mint(address(s), s.MAX_OUTSTANDING());
        assertEq(s.sync(), s.MAX_OUTSTANDING());
        vm.warp(block.timestamp + 1);
        uint256 paid = _claim(s, alice);
        assertEq(paid, s.MAX_OUTSTANDING() / PERIOD, "one second of the largest stream, to a one-wei stake");
        _stake(s, eve, 1e30);
        vm.warp(block.timestamp + PERIOD);
        paid += _claim(s, alice);
        uint256 e = _claim(s, eve);
        assertLe(paid + e, s.MAX_OUTSTANDING());
        // what does not divide evenly among 1e30 + 1 staked units stays undistributed: under 1e30 / 1e27 = 1000 wei
        assertLe(s.undistributed(), 1000);
        assertGe(paid + e + s.undistributed() + 2, s.MAX_OUTSTANDING());
        _exact(s, _three());
    }

    // ── STEP 3: strict reads, receivers, the clock, the rate ────────────────

    function test_stake_balanceReadFailsBeforeTheTransfer_reverts_nobodysDepositMoves() public {
        ReadAfterMoveToken rt = new ReadAfterMoveToken();
        vm.prank(creator);
        RailStake st = RailStake(payable(f.create(address(rt), address(usd), PERIOD)));
        rt.mint(alice, 100e18);
        vm.startPrank(alice);
        rt.approve(address(st), 100e18);
        st.stake(100e18);
        vm.stopPrank();
        rt.setFailMode(true); // the read fails before a transfer, succeeds after
        rt.mint(bob, 1);
        vm.startPrank(bob);
        rt.approve(address(st), 1);
        vm.expectRevert(IRailStake.BalanceUnreadable.selector);
        st.stake(1);
        vm.stopPrank();
        assertEq(st.stakedOf(bob), 0, "the newcomer is credited nothing");
        assertEq(st.totalStaked(), 100e18);
        assertEq(st.stakedOf(alice), 100e18);
        vm.prank(alice);
        st.unstake(100e18); // the unstake reads no balance
        rt.setFailMode(false);
        assertEq(rt.balanceOf(alice), 100e18, "alice's deposit back in full");
        assertEq(rt.balanceOf(bob), 1);
    }

    function test_claimTo_refusesTheStakeAndZero() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 100e18);
        s.sync();
        vm.warp(block.timestamp + PERIOD);
        vm.prank(alice);
        vm.expectRevert(IRailStake.BadReceiver.selector);
        s.claimTo(address(s));
        vm.prank(alice);
        vm.expectRevert(IRailStake.BadReceiver.selector);
        s.claimTo(address(0));
        assertEq(s.claimed(), 0);
        vm.prank(alice);
        assertApproxEqAbs(s.claimTo(bob), 100e18, 1);
    }

    /// A stake of 1e33 raw units and an income of `rate` raw units a second (a six-decimal asset), synced once.
    function _bigStake(uint256 rate) internal returns (RailStake st, MockToken t6) {
        t6 = new MockToken();
        FlexToken a6 = new FlexToken();
        vm.prank(creator);
        st = RailStake(payable(f.create(address(t6), address(a6), PERIOD)));
        t6.mint(alice, 1e33);
        vm.startPrank(alice);
        t6.approve(address(st), 1e33);
        st.stake(1e33);
        vm.stopPrank();
        a6.mint(address(st), rate * PERIOD);
        st.sync();
    }

    /// Alice's claimable after 3000 s, quiet and with a checkpoint every 3 s (an empty sync, or a one-wei stake).
    function _checkpoints(uint256 rate, bool oneWeiStakes) internal returns (uint256 quiet, uint256 busy) {
        (RailStake st, MockToken t6) = _bigStake(rate);
        uint256 t0 = block.timestamp;
        uint256 snap = vm.snapshot();
        vm.warp(t0 + 3000);
        quiet = st.claimable(alice);
        vm.revertTo(snap);
        t6.mint(bob, 1000);
        vm.prank(bob);
        t6.approve(address(st), 1000);
        for (uint256 i; i < 1000; ++i) {
            vm.warp(block.timestamp + 3);
            if (oneWeiStakes) {
                vm.prank(bob);
                st.stake(1);
            } else {
                st.sync(); // counts nothing; a checkpoint
            }
        }
        assertEq(block.timestamp, t0 + 3000);
        busy = st.claimable(alice);
        console2.log("rate", rate);
        console2.log("  claimable after 3000 s, quiet", quiet);
        console2.log(oneWeiStakes ? "  with 1000 one-wei stakes" : "  with 1000 empty syncs", busy);
        // one increment: 1e33 / 1e27 = 1e6 raw units (the stake's own last checkpoint may hold it back)
        assertApproxEqAbs(busy, quiet, 1e6 + 1, "within one increment of no checkpoints at all");
    }

    function test_checkpointsEveryBlock_changeNothingBeyondOneIncrement_emptySyncs() public {
        _checkpoints(1e6, false); // divides evenly every 3 s
        _checkpoints(3e5, false); // an increment that rounds to 0 every 3 s
        _checkpoints(1_234_567, false); // an increment with a remainder
    }

    function test_checkpointsEveryBlock_changeNothingBeyondOneIncrement_oneWeiStakes() public {
        _checkpoints(1e6, true);
        _checkpoints(3e5, true);
        _checkpoints(1_234_567, true);
    }

    function test_ratePerSecond_readsZeroWhileAStreamPays_scaledDoesNot() public {
        _stake(s, alice, 1e18);
        usd.mint(address(s), 1000);
        s.sync();
        assertEq(s.ratePerSecond(), 0, "under one unit a second");
        assertEq(s.ratePerSecondScaled(), 1000 * S / PERIOD);
        vm.warp(block.timestamp + PERIOD / 2);
        assertApproxEqAbs(s.claimable(alice), 500, 1, "and it pays");
    }

    // ── the factory ─────────────────────────────────────────────────────────

    function test_factory_addressCommitsToEverySetting_beforeTheToken() public {
        address token = address(0x7777); // no code yet
        address p = f.stakeAddress(alice, token, address(usd), 1 days);
        assertTrue(p != f.stakeAddress(bob, token, address(usd), 1 days), "another creator, another address");
        assertTrue(p != f.stakeAddress(alice, address(0x7778), address(usd), 1 days), "another token");
        assertTrue(p != f.stakeAddress(alice, token, address(0), 1 days), "another asset");
        assertTrue(p != f.stakeAddress(alice, token, address(usd), 1 days + 1), "another period");
        usd.mint(p, 500); // paid before the stake exists
        assertEq(f.stakeOf(alice, token), address(0));
        assertFalse(f.isStake(p));
        vm.expectEmit(true, true, true, true, address(f));
        emit IRailStakeFactory.StakeCreated(p, alice, token, address(usd), 1 days);
        vm.prank(alice);
        address made = f.create(token, address(usd), 1 days);
        assertEq(made, p);
        assertTrue(f.isStake(p));
        assertEq(f.stakeOf(alice, token), p);
        RailStake st = RailStake(payable(p));
        assertEq(st.factory(), address(f));
        assertEq(st.creator(), alice);
        assertEq(st.token(), token);
        assertEq(st.asset(), address(usd));
        assertEq(st.period(), 1 days);
        assertEq(st.unsynced(), 500, "income paid before creation is counted by the first sync");
        (address c,,,) = f.parameters();
        assertEq(c, address(0), "no settings left behind");
    }

    function test_factory_refusals() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRailStakeFactory.InvalidSettings.selector, "period"));
        f.create(address(0x7777), address(usd), 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(IRailStakeFactory.InvalidSettings.selector, "period"));
        f.create(address(0x7777), address(usd), 365 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IRailStakeFactory.InvalidSettings.selector, "asset has no code"));
        f.create(address(0x7777), address(0x1234), 1 days);
        vm.expectRevert(abi.encodeWithSelector(IRailStakeFactory.InvalidSettings.selector, "token"));
        f.create(address(0), address(usd), 1 days);
        vm.expectRevert(abi.encodeWithSelector(IRailStakeFactory.InvalidSettings.selector, "token"));
        f.create(address(usd), address(usd), 1 days);
        address p = f.create(address(0x7777), address(0), 1 days);
        vm.expectRevert(abi.encodeWithSelector(IRailStakeFactory.AlreadyCreated.selector, p));
        f.create(address(0x7777), address(usd), 2 days);
        vm.stopPrank();
        // a named address with other settings can never be created once the creator has its stake for the token
        address named = f.stakeAddress(alice, address(0x7777), address(usd), 2 days);
        assertEq(named.code.length, 0);
        assertEq(f.stakeOf(alice, address(0x7777)), p, "the page's lookup");
    }
}

/// @dev Random stake, unstake, income, sync, time and claims across three stakers; the asset is FlexToken or native.
contract StakeHandler is Test {
    RailStake public s;
    MockToken public tok;
    FlexToken public usd; // address(0) for a native stake
    address[3] public actors = [address(0xA1), address(0xB0), address(0xE5)];
    uint256 public paidOut;

    uint256 public maxStake;
    uint256 public maxIncome;

    constructor(RailStake s_, MockToken tok_, FlexToken usd_, uint256 maxStake_, uint256 maxIncome_) {
        s = s_;
        tok = tok_;
        usd = usd_;
        maxStake = maxStake_;
        maxIncome = maxIncome_;
    }

    function stake(uint256 who, uint256 amount) external {
        address a = actors[who % 3];
        amount = bound(amount, 1, maxStake);
        tok.mint(a, amount);
        vm.prank(a);
        tok.approve(address(s), amount);
        vm.prank(a);
        s.stake(amount);
    }

    function unstake(uint256 who, uint256 amount) external {
        address a = actors[who % 3];
        uint256 st = s.stakedOf(a);
        if (st == 0) return;
        amount = bound(amount, 1, st);
        vm.prank(a);
        s.unstake(amount);
    }

    function income(uint256 amount) external {
        amount = bound(amount, 0, maxIncome);
        if (address(usd) == address(0)) vm.deal(address(s), address(s).balance + amount);
        else usd.mint(address(s), amount);
    }

    function sync() external {
        s.sync();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }

    function claim(uint256 who) external {
        vm.prank(actors[who % 3]);
        paidOut += s.claim();
    }

    function received(address a) external view returns (uint256) {
        return address(usd) == address(0) ? a.balance : usd.balanceOf(a);
    }
}

/// @dev The invariant for one configuration; runs and depth from foundry.toml ([invariant], fail_on_revert).
abstract contract RailStakeInvariantBase is Test {
    uint256 constant S = 1e27;
    StakeHandler h;
    RailStake s;
    MockToken tok;

    function _period() internal pure virtual returns (uint256);
    function _native() internal pure virtual returns (bool);
    function _taxBps() internal pure virtual returns (uint256);

    function _maxStake() internal pure virtual returns (uint256) {
        return 1e30;
    }

    function _maxIncome() internal pure virtual returns (uint256) {
        return 1e30;
    }

    function setUp() public {
        vm.warp(1_000_000);
        RailStakeFactory f = new RailStakeFactory();
        tok = new MockToken();
        tok.setTransferFeeBps(_taxBps());
        FlexToken usd = _native() ? FlexToken(address(0)) : new FlexToken();
        s = RailStake(payable(f.create(address(tok), address(usd), _period())));
        h = new StakeHandler(s, tok, usd, _maxStake(), _maxIncome());
        if (_maxStake() > 1e30) h.stake(0, _maxStake()); // start from the large total
        targetContract(address(h));
    }

    function invariant_claimedPlusClaimablePlusUndistributed_isArrived() public view {
        uint256 sum = s.claimed() * S + s.undistributedScaled();
        uint256 staked;
        uint256 got;
        for (uint256 i; i < 3; ++i) {
            address a = h.actors(i);
            sum += s.earnedScaled(a);
            staked += s.stakedOf(a);
            got += h.received(a);
        }
        assertEq(sum, s.arrived() * S, "exact, in scaled units");
        assertLe(s.claimed(), s.arrived());
        assertEq(s.claimed(), h.paidOut());
        assertEq(got, s.claimed(), "what the stakers hold is what was claimed");
        uint256 bal = _native() ? address(s).balance : FlexToken(s.asset()).balanceOf(address(s));
        assertGe(bal, s.arrived() - s.claimed(), "the asset covers every claim");
        assertEq(staked, s.totalStaked());
        assertEq(tok.balanceOf(address(s)), s.totalStaked(), "every staked token is here");
        assertLe(s.streamEnd(), block.timestamp + _period(), "the end is never beyond a full period");
    }
}

contract RailStakeInvariantTest is RailStakeInvariantBase {
    function _period() internal pure virtual override returns (uint256) {
        return 1 days;
    }

    function _native() internal pure virtual override returns (bool) {
        return false;
    }

    function _taxBps() internal pure virtual override returns (uint256) {
        return 0;
    }
}

contract RailStakeInvariantTaxedTest is RailStakeInvariantTest {
    function _taxBps() internal pure override returns (uint256) {
        return 500; // 5% of every token transfer burned
    }
}

contract RailStakeInvariantNativeTest is RailStakeInvariantTest {
    function _native() internal pure override returns (bool) {
        return true;
    }
}

contract RailStakeInvariantHourTest is RailStakeInvariantTest {
    function _period() internal pure override returns (uint256) {
        return 1 hours;
    }
}

contract RailStakeInvariantYearTest is RailStakeInvariantTest {
    function _period() internal pure override returns (uint256) {
        return 365 days;
    }
}

/// A six-decimal asset (incomes up to a million units) against a total stake of 1e33 raw units.
contract RailStakeInvariantSixDecimalsTest is RailStakeInvariantTest {
    function _maxStake() internal pure override returns (uint256) {
        return 1e33;
    }

    function _maxIncome() internal pure override returns (uint256) {
        return 1e12;
    }
}
