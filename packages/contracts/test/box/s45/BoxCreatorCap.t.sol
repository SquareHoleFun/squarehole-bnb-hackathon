// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxPriceSampler} from "../../../src/box/BoxPriceSampler.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxPriceAverage, IBoxPriceQuote} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {BoxKind, RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";
import {MockFitExecutor, SettablePriceAverage} from "./BoxS45Mocks.sol";

/// @notice TEST ONLY: a price average whose quote the test sets (ready, value, or a revert), to drive the receiver's
/// held-until-valued rule independently of the sampler.
contract QuoteStandIn is SettablePriceAverage, IBoxPriceQuote {
    bool public quoteReady;
    uint256 public quoteQ;
    bool public quoteReverts;

    function setQuote(bool ready_, uint256 q_, bool reverts_) external {
        (quoteReady, quoteQ, quoteReverts) = (ready_, q_, reverts_);
    }

    function quoteTInQ(uint256) external view returns (bool, uint256) {
        require(!quoteReverts, "quote down");
        return (quoteReady, quoteQ);
    }
}

/// @notice S5.M3, add-on 5's creator-fee cap in the receiver (docs/design/swap-module-v1.md § 4.1-4.2, § 4.7, § 15
/// finding 4; R F74 U2, F75 U9): one counter per 30-day epoch from graduation, no carry-over, in Q at face (TO_CREATOR
/// Q and royalties when credited, CREATOR_IN_T at the Q handed for its buy, CREATOR_IN_Q at the Q its sale paid); T paid
/// as T valued by the box's sampler (`quoteTInQ`, the 1-hour average, rounded up), held until that average is ready;
/// the excess to BURN (the module's burn-buy ledger for Q, a burn for T) or POOL_DEPTH (the hook's claims) in the
/// currency it arrived in. BC-126 (the cap per preset and epoch, the refusals), BC-136 (the conversions under it, the
/// held-until-valued rule, the TO_CREATOR twin).
contract BoxCreatorCapTest is BoxSwapModuleBase {
    IBoxSwapModule.Action internal constant BUY_C = IBoxSwapModule.Action.BuyForCreator;
    IBoxSwapModule.Action internal constant SELL_C = IBoxSwapModule.Action.SellForCreator;
    uint256 internal constant EPOCH = 30 days;

    /// One `CreatorCapped` event.
    struct Capped {
        uint256 epoch;
        uint256 keptQ;
        uint256 excessQ;
        uint256 excessT;
        uint256 keptInEpoch;
    }

    function setUp() public {
        _setUpModuleWorld();
    }

    function _capped(uint8 qs, uint8 ts, uint128 cap, uint8 excess) internal view returns (Params memory p) {
        p = _mp(qs, ts, false);
        p.payee = carol;
        (p.creatorCap, p.capExcess) = (cap, excess);
    }

    function _presets() internal pure returns (uint128[5] memory) {
        return [uint128(1 ether), 4 ether, 8 ether, 16 ether, 32 ether];
    }

    /// The buyers' 10/15 of a `fundFees(x)` batch (no tip; the carried remainder joins it).
    function _rewardOf(Box memory b, uint256 x) internal view returns (uint256) {
        (uint256 qCarry,) = b.receiver.carried();
        return (x + qCarry) / 15 * 10;
    }

    function _remaining(Box memory b) internal view returns (uint256 rem) {
        (,,,, rem) = b.receiver.creatorCap();
    }

    function _kept(Box memory b) internal view returns (uint256 kept) {
        (,,, kept,) = b.receiver.creatorCap();
    }

    function _qBurnOwed(Box memory b) internal view returns (uint256 q) {
        (q,,,,,,) = b.receiver.moduleOwed();
    }

    function _hookQ(Box memory b) internal view returns (uint256) {
        return _claims(address(b.hook), address(0));
    }

    function _min(uint256 a, uint256 c) internal pure returns (uint256) {
        return a < c ? a : c;
    }

    /// `t` valued in Q at `tick`, rounded up (the receiver's count: never below the value).
    function _quoteUp(uint256 t, int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(t, Q96, s), Q96, s);
    }

    function _cappedEvents(address receiver) internal returns (Capped[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == receiver && logs[i].topics[0] == IBoxReceiver.CreatorCapped.selector) ++n;
        }
        out = new Capped[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != receiver || logs[i].topics[0] != IBoxReceiver.CreatorCapped.selector) continue;
            Capped memory c = out[n++];
            c.epoch = uint256(logs[i].topics[1]);
            (c.keptQ, c.excessQ, c.excessT, c.keptInEpoch) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
        }
    }

    // ============================================================================================================
    // BC-126: at most the preset per 30-day epoch, the rest to the excess destination

    /// TO_CREATOR Q at face, at every preset and both excess destinations: below, at and above the room; FIT's 3/15
    /// and the depth 2/15 untouched; a new epoch starts from zero with no carry-over.
    function test_BC126_toCreatorQAtFaceEachPresetAndEpoch() public {
        uint128[5] memory presets = _presets();
        uint8[2] memory dests = [BoxSpecV1.CAP_EXCESS_BURN, BoxSpecV1.CAP_EXCESS_POOL_DEPTH];
        for (uint256 i; i < presets.length; ++i) {
            for (uint256 d; d < 2; ++d) {
                Box memory b = _graduatedBox(
                    _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, presets[i], dests[d])
                );
                (uint256 cap, uint8 ex, uint256 epoch, uint256 kept, uint256 rem) = b.receiver.creatorCap();
                assertEq(cap, presets[i], "the cap argument");
                assertEq(ex, dests[d], "the excess argument");
                assertEq(epoch, 0, "epoch 0 from graduation");
                assertEq(rem, cap - kept);
                _capBatch(b, rem / 2); // below the room
                _capBatch(b, cap * 3 / 2); // through it and above
                _capBatch(b, cap / 4); // all excess
                assertEq(_remaining(b), 0, "the epoch's room spent");
                // The next epoch starts at zero.
                vm.warp(block.timestamp + EPOCH);
                (,, epoch, kept, rem) = b.receiver.creatorCap();
                assertEq(epoch, 1);
                assertEq(kept, 0, "a new epoch counts from zero");
                assertEq(rem, cap);
                _capBatch(b, cap / 4); // a quarter used
                // No carry-over: the unused three quarters do not reach epoch 2.
                vm.warp(block.timestamp + EPOCH);
                (,, epoch, kept, rem) = b.receiver.creatorCap();
                assertEq(epoch, 2);
                assertEq(rem, cap, "no carry-over");
                _capBatch(b, cap * 2);
                assertEq(_kept(b), cap, "never more than the cap in an epoch");
            }
        }
    }

    /// What a cap batch reads before and after.
    struct Reads {
        uint256 owed;
        uint256 burn;
        uint256 hook;
        uint256 fit;
        uint256 toCreator;
        uint256 room;
    }

    function _reads(Box memory b) internal view returns (Reads memory r) {
        (r.owed,) = b.receiver.creatorOwed();
        (r.burn, r.hook, r.fit) = (_qBurnOwed(b), _hookQ(b), b.receiver.fitOwed());
        (,,,,, r.toCreator,) = b.receiver.totals();
        r.room = _remaining(b);
    }

    /// One `fundFees` batch whose 10/15 is about `want`: the creator keeps min(reward, room), the rest goes to the
    /// excess destination in Q; FIT's 3/15 and the depth 2/15 as without the cap.
    function _capBatch(Box memory b, uint256 want) internal {
        uint256 x = want * 3 / 2;
        uint256 reward = _rewardOf(b, x);
        Reads memory r0 = _reads(b);
        uint256 keep = _min(reward, r0.room);
        _feedQ(b, x);
        Reads memory r1 = _reads(b);
        assertEq(r1.owed - r0.owed, keep, "the creator keeps min(reward, room)");
        assertEq(r1.fit - r0.fit, reward / 10 * 3, "FIT's 3/15 untouched");
        (, uint8 ex,,,) = b.receiver.creatorCap();
        if (ex == BoxSpecV1.CAP_EXCESS_BURN) {
            assertEq(r1.burn - r0.burn, reward - keep, "BURN: the excess Q to the module's burn-buy ledger");
            assertEq(r1.hook - r0.hook, reward / 10 * 2, "depth: its 2/15 only");
        } else {
            assertEq(r1.burn, r0.burn, "POOL_DEPTH: nothing to the burn-buy ledger");
            assertEq(
                r1.hook - r0.hook, reward / 10 * 2 + reward - keep, "POOL_DEPTH: the excess into the hook's claims"
            );
        }
        assertEq(r0.room - r1.room, keep, "counted at face");
        assertEq(r1.toCreator - r0.toCreator, keep, "the creator's total counts only what it keeps");
    }

    /// Curve-time creator fees are held and counted in epoch 0, even when the settlement runs a month late; the batch
    /// that triggers it counts in the epoch then current.
    function test_BC126_curveTimeFeesCountInEpochZeroEvenWhenSettledLate() public {
        Box memory b = _buildAndLaunch(
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 1 ether, BoxSpecV1.CAP_EXCESS_BURN)
        );
        _skipWindow(b);
        _feedQ(b, 3 ether);
        (uint256 held,) = b.receiver.creatorHeld();
        assertGe(held, 2 ether, "held until graduation (F69 C1)");
        (,,, uint256 kept0, uint256 rem0) = b.receiver.creatorCap();
        assertEq(kept0, 0);
        assertEq(rem0, 1 ether, "the whole cap until the settlement");
        b.coord.setSkipPokes(true);
        _closeAndGraduate(b);
        vm.warp(block.timestamp + EPOCH + 1 days);
        uint256 burn0 = _qBurnOwed(b);
        // The first receiver call after the late graduation: the settlement, then this batch.
        vm.recordLogs();
        _feedQ(b, 0.03 ether);
        Capped[] memory ev = _cappedEvents(address(b.receiver));
        assertGe(ev.length, 2, "the held fees, then the batch");
        uint256 keptSum;
        uint256 excessSum;
        for (uint256 i; i < ev.length; ++i) {
            (keptSum, excessSum) = (keptSum + ev[i].keptQ, excessSum + ev[i].excessQ);
            if (i + 1 < ev.length) assertEq(ev[i].epoch, 0, "the settlement counts in epoch 0");
        }
        assertEq(ev[0].keptQ, 1 ether, "the held fees fill epoch 0's cap");
        assertEq(ev[0].excessQ, held - 1 ether);
        Capped memory last = ev[ev.length - 1];
        assertEq(last.epoch, 1, "the late batch counts in epoch 1");
        assertGt(last.keptQ, 0);
        assertEq(last.excessQ, 0, "epoch 1's room is whole");
        (uint256 owed,) = b.receiver.creatorOwed();
        assertEq(owed, keptSum, "owed == what the cap kept");
        assertEq(_qBurnOwed(b) - burn0, excessSum, "the excess to the burn-buy ledger");
        (,, uint256 epoch, uint256 kept,) = b.receiver.creatorCap();
        assertEq(epoch, 1);
        assertEq(kept, last.keptQ);
        (,,,,, uint256 toCreator,) = b.receiver.totals();
        assertEq(toCreator, owed, "the creator's total: the held fees less the cap's excess");
    }

    /// Royalties for the creator (the Creator destination, `fundCreator`) count under the same cap (P).
    function test_BC126_royaltiesCountUnderTheCap() public {
        Params memory p =
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 1 ether, BoxSpecV1.CAP_EXCESS_POOL_DEPTH);
        p.royalty = RoyaltyDestination.Creator;
        Box memory b = _graduatedBox(p);
        uint256 room = _remaining(b);
        (uint256 owed0,) = b.receiver.creatorOwed();
        uint256 hook0 = _hookQ(b);
        vm.deal(address(this), 3 ether);
        b.receiver.fundCreator{value: 3 ether}();
        (uint256 owed1,) = b.receiver.creatorOwed();
        assertEq(owed1 - owed0, room, "royalties fill the room");
        assertEq(_hookQ(b) - hook0, 3 ether - room, "the rest into depth (POOL_DEPTH)");
        assertEq(_remaining(b), 0);
    }

    /// `initialize` takes the cap only where it can keep it.
    function test_BC126_initializeRefusesACapItCannotKeep() public {
        uint8 burn = BoxSpecV1.CAP_EXCESS_BURN;
        // Accepted: a creator kind on either side, either destination, any preset.
        _initOk(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 1 ether, burn));
        _initOk(_capped(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_TO_CREATOR, 32 ether, burn));
        _initOk(
            _capped(
                BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T, 8 ether, BoxSpecV1.CAP_EXCESS_POOL_DEPTH
            )
        );
        _initOk(_capped(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 16 ether, burn));
        // Refused: no creator stream (royalties alone do not take the add-on, as validate()).
        Params memory p = _capped(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_BURN_T, 1 ether, burn);
        _initRefused(p);
        p.royalty = RoyaltyDestination.Creator;
        _initRefused(p);
        // Refused: HOLDERS (S14), an unknown destination, a destination without a cap, a cap without one.
        _initRefused(
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 1 ether, BoxSpecV1.CAP_EXCESS_HOLDERS)
        );
        _initRefused(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 1 ether, 4));
        _initRefused(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 0, burn));
        _initRefused(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_BURN_T, 1 ether, 0));
        // Box 0 has no creator: no cap.
        Params memory z = _box0Params();
        (z.creatorCap, z.capExcess) = (32 ether, burn);
        _initRefused(z);
        z.creatorCap = 0;
        _initRefused(z);
    }

    function _initOk(Params memory p) internal {
        Box memory b = _build(p);
        vm.prank(address(b.coord));
        b.receiver.initialize();
        (uint256 cap, uint8 ex,,,) = b.receiver.creatorCap();
        assertEq(cap, p.creatorCap);
        assertEq(ex, p.capExcess);
    }

    function _initRefused(Params memory p) internal {
        Box memory b = _build(p);
        vm.prank(address(b.coord));
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.CreatorCapRefused.selector, p.creatorCap, p.capExcess));
        b.receiver.initialize();
    }

    /// Random batches and times over several epochs, any preset and destination: the creator never receives more than
    /// the cap in an epoch, and kept + excess == every reward, to the wei.
    function testFuzz_BC126_neverMoreThanTheCapPerEpoch(uint256 seed, uint8 preset, bool depth) public {
        uint128 cap = _presets()[preset % 5];
        Box memory b = _graduatedBox(
            _capped(
                BoxSpecV1.Q_STREAM_TO_CREATOR,
                BoxSpecV1.T_STREAM_BURN_T,
                cap,
                depth ? BoxSpecV1.CAP_EXCESS_POOL_DEPTH : BoxSpecV1.CAP_EXCESS_BURN
            )
        );
        uint256[8] memory perEpoch;
        (,, uint256 e0, uint256 k0,) = b.receiver.creatorCap();
        perEpoch[e0] = k0;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + seed % 12 days);
            _fuzzBatch(b, 0.01 ether + (seed >> 64) % (uint256(cap) * 2), cap, perEpoch);
        }
    }

    function _fuzzBatch(Box memory b, uint256 x, uint256 cap, uint256[8] memory perEpoch) internal {
        uint256 reward = _rewardOf(b, x);
        Reads memory r0 = _reads(b);
        _feedQ(b, x);
        Reads memory r1 = _reads(b);
        (, uint8 ex, uint256 epoch,,) = b.receiver.creatorCap();
        assertLt(epoch, 8);
        perEpoch[epoch] += r1.owed - r0.owed;
        assertLe(perEpoch[epoch], cap, "never more than the cap in an epoch");
        uint256 excess = ex == BoxSpecV1.CAP_EXCESS_POOL_DEPTH ? r1.hook - r0.hook - reward / 10 * 2 : r1.burn - r0.burn;
        assertEq(r1.owed - r0.owed + excess, reward, "kept + excess == the reward");
    }

    // ============================================================================================================
    // BC-136: the creator conversions under the cap, and T paid as T

    /// CREATOR_IN_T counts at the Q handed for its buy, at the split; the T the module buys is not counted again.
    /// Curve-time Q held for the buy is capped in epoch 0 at the settlement.
    function test_BC136_creatorInTCountedAtTheQHandedForItsBuy() public {
        Box memory b = _graduatedBox(
            _capped(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T, 1 ether, BoxSpecV1.CAP_EXCESS_BURN)
        );
        uint256 room = _remaining(b);
        (uint256 qb0, uint256 qc0,,,,,) = b.receiver.moduleOwed();
        uint256 reward = _rewardOf(b, 3 ether);
        _feedQ(b, 3 ether);
        (uint256 qb1, uint256 qc1,,,,,) = b.receiver.moduleOwed();
        assertEq(qc1 - qc0, room, "the creator-buy ledger takes the room, at face");
        assertEq(qb1 - qb0, reward - room, "BURN: the rest to the burn-buy ledger");
        assertEq(_remaining(b), 0);
        // The buy spends it; the T it buys is the creator's and counts nothing more.
        _readyAverage(b);
        uint256 kept = _kept(b);
        _roll(1);
        Result memory r = _step(b, BUY_C, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None));
        (, uint256 ownedT) = b.receiver.creatorOwed();
        assertEq(ownedT, r.amountOut, "the bought T owed to the payee");
        assertEq(_kept(b), kept, "not counted again");
        // The excess is bought and burned by BuyBurn, like a buy-back.
        _roll(1);
        uint256 supply0 = b.t.totalSupply();
        Result memory rb = _step(b, IBoxSwapModule.Action.BuyBurn, keeper);
        assertEq(uint256(rb.stop), uint256(IBoxSwapModule.Stop.None));
        assertEq(supply0 - b.t.totalSupply(), rb.amountOut - 1, "the excess Q buys T and burns it");

        // Curve-time Q held for the buy: capped in epoch 0 at the settlement, before the settlement's own split.
        Box memory h = _buildAndLaunch(
            _capped(
                BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T, 1 ether, BoxSpecV1.CAP_EXCESS_POOL_DEPTH
            )
        );
        _skipWindow(h);
        _feedQ(h, 3 ether);
        (, uint256 heldQ,,,,, bool isHeld) = h.receiver.moduleOwed();
        assertTrue(isHeld);
        assertGe(heldQ, 2 ether);
        vm.recordLogs();
        _closeAndGraduate(h);
        Capped[] memory ev = _cappedEvents(address(h.receiver));
        assertEq(ev[0].epoch, 0);
        assertEq(ev[0].keptQ, 1 ether, "the held Q fills epoch 0's cap first");
        assertEq(ev[0].excessQ, heldQ - 1 ether, "the rest into depth");
        (, uint256 qc,,,,,) = h.receiver.moduleOwed();
        assertEq(qc, 1 ether, "the creator-buy ledger holds exactly the cap");
    }

    /// CREATOR_IN_Q counts at the Q its sale paid, in moduleProceeds: within the room the payee's, beyond it the
    /// excess destination's (BURN: the burn-buy ledger, a sell and a buy back; POOL_DEPTH: the hook's claims).
    function test_BC136_creatorInQCountedAtTheQItsSalePaid() public {
        _sellUnderTheCap(BoxSpecV1.CAP_EXCESS_BURN);
        _sellUnderTheCap(BoxSpecV1.CAP_EXCESS_POOL_DEPTH);
    }

    function _sellUnderTheCap(uint8 dest) internal {
        Box memory b =
            _graduatedBox(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 1 ether, dest));
        _feedT(b, 3_000_000e18);
        // Leave 0.004 ETH (and a few wei) of room through the Q side.
        uint256 rem = _remaining(b);
        uint256 d = 0.004 ether + (rem - 0.004 ether) % 10;
        (uint256 qCarry,) = b.receiver.carried();
        _feedQ(b, (rem - d) * 3 / 2 - qCarry);
        assertEq(_remaining(b), d, "the room left");
        _readyAverage(b);
        (uint256 owed0,) = b.receiver.creatorOwed();
        uint256 burn0 = _qBurnOwed(b);
        uint256 hook0 = _hookQ(b);
        _roll(1);
        Result memory r = _step(b, SELL_C, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None));
        uint256 paid = r.amountOut - r.tip;
        assertGt(paid, d, "the sale pays more than the room");
        (uint256 owed1,) = b.receiver.creatorOwed();
        assertEq(owed1 - owed0, d, "the payee gets the room, at face");
        assertEq(_remaining(b), 0);
        if (dest == BoxSpecV1.CAP_EXCESS_BURN) {
            assertEq(_qBurnOwed(b) - burn0, paid - d, "BURN: the rest to the burn-buy ledger");
        } else {
            assertEq(_hookQ(b) - hook0, paid - d, "POOL_DEPTH: the rest into depth");
            assertEq(_qBurnOwed(b), burn0);
        }
        _assertLedgersAreClaims(b);
    }

    /// § 13 point 7, decided by size in S5.M3 (built), bounded after the S5 review: once the creator's room for the
    /// epoch is spent and the excess is BURN, a SellForCreator step burns the creator's T instead of selling it (no sell
    /// and buy back, no tip), but only what one sale would have sold: the same block limit, price read and 49-tick
    /// limit as a sale, the rest kept for later steps; with room left, or with POOL_DEPTH, it sells; a new epoch's room
    /// makes it sell again.
    function test_BC136_atRoomZeroWithBurnTheCreatorsTIsBurnedNotSold() public {
        Box memory b = _graduatedBox(
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 1 ether, BoxSpecV1.CAP_EXCESS_BURN)
        );
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
        // What one sale sells here, with room left (2M T of creator T is more than one 49-tick step).
        uint256 inOne = _oneSale(b);
        _feedQ(b, 3 ether); // the room spent through the Q side
        assertEq(_remaining(b), 0);
        (uint256 owed0,) = b.receiver.creatorOwed();
        uint256 burn0 = _qBurnAll(b);
        uint160 s0 = _sqrtP(b);
        uint256 supply0 = b.t.totalSupply();
        uint256 keeper0 = keeper.balance;
        (,,, uint256 tc0,,,) = b.receiver.moduleOwed();
        assertGt(tc0 - 2, inOne, "fixture: a ledger larger than one step");
        _roll(1);
        vm.recordLogs();
        Result memory r = _step(b, SELL_C, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "the step ran: a burn");
        assertEq(_creatorTBurned(b), r.amountIn, "CreatorTBurned");
        assertLe(r.amountIn, inOne, "never more than one sale would have sold");
        assertApproxEqAbs(r.amountIn, inOne, 4, "one sale's worth, to the rounding");
        assertEq(r.amountOut + r.tip, 0, "nothing sold, no tip");
        assertEq(_sqrtP(b), s0, "no trade");
        assertEq(keeper.balance, keeper0);
        assertEq(supply0 - b.t.totalSupply(), r.amountIn - 1, "burned (the module's T balance keeps 1 raw unit)");
        (uint256 owed1,) = b.receiver.creatorOwed();
        assertEq(owed1, owed0, "nothing to the creator");
        assertEq(_qBurnAll(b), burn0, "no Q to buy back");
        (, uint256 tForCreator) = _creatorLedgers(b);
        assertEq(tForCreator, tc0 - 1 - r.amountIn, "the rest kept for later steps");
        assertEq(_m(b).lastStepBlock(), block.number, "the step block recorded, as a sale's");
        _assertLedgersAreClaims(b);
        // A new epoch: room again, so it sells.
        vm.warp(block.timestamp + EPOCH);
        _feedT(b, 3_000_000e18);
        _hold(b, 2);
        Result memory r2 = _step(b, SELL_C, keeper);
        assertEq(uint256(r2.stop), uint256(IBoxSwapModule.Stop.None));
        assertGt(r2.amountOut, 0, "sold in the new epoch");
        (uint256 owed2,) = b.receiver.creatorOwed();
        assertGt(owed2, owed1, "paid to the creator again");
        // POOL_DEPTH at room 0 still sells: its excess Q goes into depth.
        Box memory d = _graduatedBox(
            _capped(
                BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 1 ether, BoxSpecV1.CAP_EXCESS_POOL_DEPTH
            )
        );
        _feedT(d, 3_000_000e18);
        _feedQ(d, 3 ether);
        assertEq(_remaining(d), 0);
        _readyAverage(d);
        uint256 hook0 = _hookQ(d);
        _roll(1);
        Result memory r3 = _step(d, SELL_C, keeper);
        assertGt(r3.amountOut, 0, "POOL_DEPTH: sold");
        assertEq(_hookQ(d) - hook0, r3.amountOut - r3.tip, "its Q into depth");
    }

    /// S5 review (finding 1): a backlog of creator T far larger than one step, on the epoch's last day, with the room
    /// spent and BURN. Each step burns at most what one sale would have sold, once a block, and only with the average
    /// ready and room before the band, as a sale; the rest waits, and once the epoch turns it is sold for the creator.
    function test_BC136_atRoomZeroABacklogBurnsOneSaleAStepAndTheRestSellsNextEpoch() public {
        Box memory b = _backlogBox(BoxSpecV1.CAP_EXCESS_BURN);
        uint256 inOne = _oneSale(b);
        // The creator's own fees spend the room in the epoch's last hours.
        vm.warp(block.timestamp + 29 days + 20 hours);
        _hold(b, 1);
        _feedQ(b, 3 ether);
        assertEq(_remaining(b), 0);
        (, uint256 tc0) = _creatorLedgers(b);
        (uint256 owed0,) = b.receiver.creatorOwed();
        _roll(1);
        Result memory r = _step(b, SELL_C, address(0));
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "a burn");
        assertLe(r.amountIn, inOne, "one sale's worth at most");
        assertApproxEqAbs(r.amountIn, inOne, 4);
        uint256 burned1 = r.amountIn;
        // One step a block, all actions together, the burn included.
        r = _step(b, SELL_C, address(0));
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.BlockLimit), "a second burn in the block waits");
        assertEq(uint256(_step(b, IBoxSwapModule.Action.BuyBurn, keeper).stop), uint256(IBoxSwapModule.Stop.BlockLimit));
        (, uint256 tc1) = _creatorLedgers(b);
        assertEq(tc0 - tc1, burned1, "only the one step left the ledger");
        assertGt(tc1, tc0 / 2, "the backlog is mostly kept");
        // The next block: another step's worth, no more.
        _roll(1);
        r = _step(b, SELL_C, address(0));
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None));
        assertLe(r.amountIn, inOne);
        (, uint256 tc2) = _creatorLedgers(b);
        (uint256 owed1,) = b.receiver.creatorOwed();
        assertEq(owed1, owed0, "nothing to the creator while the room is spent");
        // The epoch turns: the room is whole again, and the backlog is sold for the creator.
        vm.warp(block.timestamp + 5 hours);
        _hold(b, 2);
        assertEq(_remaining(b), 1 ether, "the next epoch's room");
        r = _step(b, SELL_C, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None));
        assertGt(r.amountOut, 0, "sold, not burned");
        (uint256 owed2,) = b.receiver.creatorOwed();
        assertEq(owed2 - owed1, r.amountOut - r.tip, "the sale's Q to the creator");
        (, uint256 tc3) = _creatorLedgers(b);
        assertEq(tc2 - tc3, r.amountIn);
        _assertLedgersAreClaims(b);
    }

    /// S5 review (finding 1): a third party fills the room with a `fundFees` gift (the creator's 10/15 of it counts at
    /// face) and calls the step in the same block, with no tip: it burns at most one sale's worth; the creator keeps the
    /// gift's share and the rest of the backlog, which sells once the epoch turns.
    function test_BC136_aThirdPartyFillingTheRoomBurnsAtMostOneStep() public {
        Box memory b = _backlogBox(BoxSpecV1.CAP_EXCESS_BURN);
        uint256 inOne = _oneSale(b);
        vm.warp(block.timestamp + 29 days);
        _hold(b, 1);
        uint256 room = _remaining(b);
        {
            (uint256 c0,) = b.receiver.carried();
            _feedQ(b, (room - 0.01 ether) * 3 / 2 - c0);
        }
        room = _remaining(b);
        assertApproxEqAbs(room, 0.01 ether, 10, "fixture: 0.01 ETH of room left");
        address attacker = makeAddr("s5review.attacker");
        (uint256 qCarry,) = b.receiver.carried();
        uint256 gift = (room * 15 + 9) / 10 - qCarry + 15;
        vm.deal(attacker, gift);
        vm.prank(attacker);
        b.receiver.fundFees{value: gift}();
        assertEq(_remaining(b), 0, "the room filled by a stranger's gift");
        (, uint256 tc0) = _creatorLedgers(b);
        uint256 supply0 = b.t.totalSupply();
        vm.prank(attacker);
        Result memory r = _step(b, SELL_C, address(0));
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None));
        assertLe(supply0 - b.t.totalSupply(), inOne, "at most one sale's worth burned");
        (, uint256 tc1) = _creatorLedgers(b);
        assertEq(tc0 - tc1, r.amountIn);
        assertGt(tc1, tc0 * 9 / 10, "the backlog stays the creator's");
        vm.prank(attacker);
        assertEq(uint256(_step(b, SELL_C, address(0)).stop), uint256(IBoxSwapModule.Stop.BlockLimit));
        // A day later the room is whole and the same T is sold for the creator.
        vm.warp(block.timestamp + 1 days + 1);
        _hold(b, 2);
        (uint256 owed0,) = b.receiver.creatorOwed();
        r = _step(b, SELL_C, keeper);
        assertGt(r.amountOut, 0, "sold for the creator");
        (uint256 owed1,) = b.receiver.creatorOwed();
        assertEq(owed1 - owed0, r.amountOut - r.tip);
    }

    /// A CREATOR_IN_Q box with add-on 5 (1 ETH, `excess`) and a creator-sell backlog of 60M T (far more than one
    /// 49-tick step at graduation's depth), its average ready.
    function _backlogBox(uint8 excess) internal returns (Box memory b) {
        b = _graduatedBox(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 1 ether, excess));
        _feedT(b, 90_000_000e18);
        _readyAverage(b);
        _m(b).sync();
    }

    /// The T one SellForCreator step sells here and now with room left (the state is restored after).
    function _oneSale(Box memory b) internal returns (uint256 tIn) {
        assertGt(_remaining(b), 0, "fixture: room left for the reference sale");
        uint256 snap = vm.snapshotState();
        Result memory r = _step(b, SELL_C, keeper);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "fixture: the reference sale ran");
        assertGt(r.amountOut, 0, "fixture: a sale");
        tIn = r.amountIn;
        vm.revertToState(snap);
    }

    /// The amount of the one `CreatorTBurned` among the recorded logs.
    function _creatorTBurned(Box memory b) internal returns (uint256 amount) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != b.module || logs[i].topics[0] != IBoxSwapModule.CreatorTBurned.selector) continue;
            amount = abi.decode(logs[i].data, (uint256));
            ++n;
        }
        assertEq(n, 1, "one CreatorTBurned");
    }

    /// The burn-buy Q wherever it is: still owed by the receiver, or in the module's ledger.
    function _qBurnAll(Box memory b) internal view returns (uint256) {
        (uint256 inModule,,,,) = _m(b).budgets();
        return _qBurnOwed(b) + inModule;
    }

    function _creatorLedgers(Box memory b) internal view returns (uint256 qCreator, uint256 tForCreator) {
        (, qCreator,, tForCreator,) = _m(b).budgets();
    }

    /// T paid as T (TO_CREATOR on the sellers' side): held at the settlement and while the average is not ready, with
    /// collect, payFit, claimCreator, fundFees, fundDepth, fundCreator and pullForModule all working; the first collect
    /// with a ready average credits it through the cap at the sampler's quoteTInQ.
    function test_BC136_tPaidAsTHeldUntilTheSamplerValuesIt() public {
        Params memory p =
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR, 32 ether, BoxSpecV1.CAP_EXCESS_BURN);
        p.royalty = RoyaltyDestination.Creator;
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        _feedT(b, 3_000_000e18);
        (, uint256 ht0) = b.receiver.creatorHeld();
        assertGe(ht0, 2_000_000e18, "curve-time T held");
        _closeAndGraduate(b);
        (uint256 oq, uint256 ot) = b.receiver.creatorOwed();
        assertGt(oq, 0, "the held Q owed through the cap");
        assertEq(ot, 0, "T paid as T stays held at the settlement: the average is not ready");
        (, uint256 ht1) = b.receiver.creatorHeld();
        assertGe(ht1, ht0);
        uint256 held = _nothingWaitsForTheAverage(b, ht1);
        _creditedOnceReady(b, held);
    }

    /// Every path runs while the average is not ready; the T stays held. Returns what is held.
    function _nothingWaitsForTheAverage(Box memory b, uint256 ht1) internal returns (uint256 ht3) {
        MockFitExecutor(payable(b.executor)).setGraduated(true);
        _feedT(b, 3_000_000e18);
        b.receiver.payFit();
        vm.prank(carol);
        b.receiver.claimCreator(carol);
        _feedQ(b, 0.3 ether);
        vm.deal(address(this), 1 ether);
        b.receiver.fundDepth{value: 0.1 ether}();
        b.receiver.fundCreator{value: 0.1 ether}();
        _m(b).sync();
        (, uint256 ht2) = b.receiver.creatorHeld();
        assertEq(ht2, ht1 + 2_000_000e18, "the new batch's T joins it");
        (, uint256 ot) = b.receiver.creatorOwed();
        assertEq(ot, 0);
        // Seeded, but under an hour: still held.
        IBoxPriceAverage(b.average).poke();
        _roll(10);
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        (, ht3) = b.receiver.creatorHeld();
        assertEq(ht3, ht2, "not ready: held");
    }

    /// Ready: the first collect values the held T at the 1-hour average, rounded up, and credits it.
    function _creditedOnceReady(Box memory b, uint256 held) internal {
        _roll(301);
        IBoxPriceAverage(b.average).poke();
        (bool ready, uint256 v) = IBoxPriceQuote(b.average).quoteTInQ(held);
        assertTrue(ready);
        (, int24 avg,) = IBoxPriceAverage(b.average).twap();
        assertEq(v, _quoteUp(held, avg), "the sampler's 1-hour average, rounded up");
        uint256 supply0 = b.t.totalSupply();
        (,,,,,, uint256 tToCreator0) = b.receiver.totals();
        _mintQ(b, 0.01 ether);
        vm.recordLogs();
        b.receiver.collect(keeper);
        Capped[] memory ev = _cappedEvents(address(b.receiver));
        Capped memory last = ev[ev.length - 1];
        assertEq(last.keptQ, v, "counted at its value");
        assertEq(last.excessT, 0, "within the room");
        (, uint256 ot) = b.receiver.creatorOwed();
        assertEq(ot, held, "credited whole");
        (, uint256 ht4) = b.receiver.creatorHeld();
        assertEq(ht4, 0);
        assertEq(b.t.totalSupply(), supply0, "nothing burned");
        (,,,,,, uint256 tToCreator1) = b.receiver.totals();
        assertEq(tToCreator1, tToCreator0, "counted for the creator when held, not again");
    }

    /// Beyond the room, T paid as T keeps the share its value allows (rounded down) and the rest goes to the excess
    /// destination in T (BURN: burned; POOL_DEPTH: the hook's T claims).
    function test_BC136_tPaidAsTBeyondTheRoomGoesToTheExcessInT() public {
        _tBeyondTheRoom(BoxSpecV1.CAP_EXCESS_BURN);
        _tBeyondTheRoom(BoxSpecV1.CAP_EXCESS_POOL_DEPTH);
    }

    function _tBeyondTheRoom(uint8 dest) internal {
        Box memory b =
            _graduatedBox(_capped(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_TO_CREATOR, 1 ether, dest));
        _feedT(b, 150_000_000e18);
        (, uint256 h) = b.receiver.creatorHeld();
        assertGe(h, 100_000_000e18);
        _readyAverage(b);
        (, uint256 v) = IBoxPriceQuote(b.average).quoteTInQ(h);
        uint256 room = _remaining(b);
        assertGt(v, room, "worth more than the room");
        uint256 keepT = h * room / v;
        uint256 supply0 = b.t.totalSupply();
        uint256 hookT0 = _claims(address(b.hook), address(b.t));
        (,,,,,, uint256 tToCreator0) = b.receiver.totals();
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        (, uint256 ot) = b.receiver.creatorOwed();
        assertEq(ot, keepT, "the share its value allows, rounded down");
        assertEq(_remaining(b), 0);
        if (dest == BoxSpecV1.CAP_EXCESS_BURN) {
            assertEq(supply0 - b.t.totalSupply(), h - keepT, "BURN: the rest burned");
        } else {
            assertEq(_claims(address(b.hook), address(b.t)) - hookT0, h - keepT, "POOL_DEPTH: the rest into depth");
            assertEq(b.t.totalSupply(), supply0);
        }
        (,,,,,, uint256 tToCreator1) = b.receiver.totals();
        assertEq(tToCreator0 - tToCreator1, h - keepT, "the creator's total loses the excess");
    }

    /// A failing or missing quote leaves T held and every path working (the box's average is a stand-in without
    /// quoteTInQ here).
    function test_BC136_aFailingQuoteLeavesTHeld() public {
        Params memory p =
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR, 4 ether, BoxSpecV1.CAP_EXCESS_BURN);
        p.averageKind = 1;
        Box memory b = _graduatedBox(p);
        _feedT(b, 3_000_000e18);
        _readyAverage(b);
        (, uint256 h0) = b.receiver.creatorHeld();
        assertGt(h0, 0);
        _feedT(b, 3_000_000e18);
        (, uint256 h1) = b.receiver.creatorHeld();
        assertEq(h1, h0 + 2_000_000e18, "held: the stand-in has no quote");
        (, uint256 ot) = b.receiver.creatorOwed();
        assertEq(ot, 0);
    }

    /// The receiver uses a quote only when it says ready and carries a value; a reverting one leaves T held; a ready
    /// one is counted as given (here a stand-in value, so the share kept is checked against it).
    function test_BC136_onlyAReadyQuoteIsUsed() public {
        Params memory p =
            _capped(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_TO_CREATOR, 1 ether, BoxSpecV1.CAP_EXCESS_BURN);
        p.averageKind = 1;
        Box memory b = _graduatedBox(p);
        vm.etch(b.average, address(new QuoteStandIn()).code);
        QuoteStandIn quote = QuoteStandIn(b.average);
        _feedT(b, 3_000_000e18);
        (, uint256 h) = b.receiver.creatorHeld();
        assertGt(h, 0);
        quote.setQuote(false, 0.5 ether, false);
        _feedT(b, 3_000_000e18);
        (, uint256 h1) = b.receiver.creatorHeld();
        assertEq(h1, h + 2_000_000e18, "a quote that is not ready is never used, whatever value it carries");
        quote.setQuote(true, 0, false);
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        (, uint256 h2) = b.receiver.creatorHeld();
        assertEq(h2, h1, "a zero value is not a valuation");
        quote.setQuote(true, 0.5 ether, true);
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        (, uint256 h3) = b.receiver.creatorHeld();
        assertEq(h3, h1, "a reverting quote leaves it held");
        // Ready at 2 ETH for all of it: the creator keeps half (the 1 ETH room), the rest burned.
        quote.setQuote(true, 2 ether, false);
        uint256 supply0 = b.t.totalSupply();
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        (, uint256 ot) = b.receiver.creatorOwed();
        assertEq(ot, h1 / 2, "the share its counted value allows");
        assertEq(supply0 - b.t.totalSupply(), h1 - h1 / 2, "the rest burned");
        assertEq(_remaining(b), 0);
    }

    /// The sampler's quote (a view): not ready before its first sample and for an hour after it; then the 1-hour
    /// average, rounded up.
    function test_BC136_quoteTInQRoundsUpAtTheAverage() public {
        Box memory b = _graduatedBox(
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR, 4 ether, BoxSpecV1.CAP_EXCESS_BURN)
        );
        IBoxPriceQuote s = IBoxPriceQuote(b.average);
        (bool ready, uint256 q) = s.quoteTInQ(1e24);
        assertFalse(ready, "no sample yet");
        assertEq(q, 0);
        IBoxPriceAverage(b.average).poke();
        _roll(250);
        (ready, q) = s.quoteTInQ(1e24);
        assertFalse(ready, "under an hour");
        _roll(51);
        IBoxPriceAverage(b.average).poke();
        (, int24 avg,) = IBoxPriceAverage(b.average).twap();
        uint256[4] memory ts = [uint256(1), 7, 1e18, 123_456_789e18];
        for (uint256 i; i < ts.length; ++i) {
            (ready, q) = s.quoteTInQ(ts[i]);
            assertTrue(ready);
            uint256 floor = _tInQ(ts[i], avg);
            assertGe(q, floor, "never below the value");
            assertLe(q, floor + 2, "rounded up, not more");
            assertEq(q, _quoteUp(ts[i], avg));
        }
        (ready, q) = s.quoteTInQ(0);
        assertEq(q, 0);
        assertEq(BoxPriceSampler(b.average).ARGS_LENGTH(), 60, "unchanged clone layout");
    }

    /// The FIT and depth parts of a capped box equal its uncapped TO_CREATOR twin's to the wei (BURN keeps the excess
    /// out of depth), whatever the cap does to the creator's part.
    function test_BC136_fitAndDepthPartsEqualTheUncappedTwinsToTheWei() public {
        Box memory c = _graduatedBox(
            _capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR, 1 ether, BoxSpecV1.CAP_EXCESS_BURN)
        );
        Box memory w = _graduatedBox(_capped(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR, 0, 0));
        for (uint256 i; i < 3; ++i) {
            _feedQ(c, 1.2 ether);
            _feedQ(w, 1.2 ether);
            _feedT(c, 4_000_000e18);
            _feedT(w, 4_000_000e18);
            vm.warp(block.timestamp + 11 days);
        }
        (uint256 cFit,, uint256 cQDepth, uint256 cTDepth,,,) = c.receiver.totals();
        (uint256 wFit,, uint256 wQDepth, uint256 wTDepth,,,) = w.receiver.totals();
        assertEq(cFit, wFit, "FIT's Q parts");
        assertEq(c.receiver.fitWaitingT(), w.receiver.fitWaitingT(), "FIT's T parts");
        assertEq(cQDepth, wQDepth, "Q depth parts");
        assertEq(cTDepth, wTDepth, "T depth parts");
        assertEq(_hookQ(c), _hookQ(w), "the hooks' Q claims");
        (uint256 cq,) = c.receiver.creatorOwed();
        (uint256 wq,) = w.receiver.creatorOwed();
        assertLt(cq, wq, "only the creator's part is capped");
        assertEq(wq - cq, _qBurnOwed(c), "the difference waits to be bought and burned");
        // An uncapped box reports no cap.
        (uint256 cap, uint8 ex, uint256 epoch, uint256 kept, uint256 rem) = w.receiver.creatorCap();
        assertEq(cap | ex | epoch | kept | rem, 0, "no add-on, no cap");
        assertEq(uint256(w.kind), uint256(BoxKind.Standard));
    }
}
