// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3ClaudeActor, AuditU3ClaudeTipTaker} from "./AuditU3ClaudeBase.sol";
import {AuditU3ClaudeDeepenWatch} from "./AuditU3ClaudeDeepenWatch.sol";
import {AuditU3ClaudeInvariantBase} from "./AuditU3ClaudeInvariantBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude): the curve's invariant campaign on the factory's box 0 (mainnet build, the real
/// FitBuybackExecutor), from inside the launch window through the close and graduation and on (P3.1, P3.2, P3.5-P3.7,
/// P3.9, P3.15; the unit brief's items 9 and 10). Random calls: one to three swaps in one unlock through a router-like
/// account (exact input and output, both directions, 1 wei to 3 × R, limits anywhere, at P1, at P0 or near them, each
/// leg with or without try/catch, so a refused later leg does not undo an earlier one), taxed buys through the launch
/// router, time, `graduate()` by anyone, `collect()`, `deepen()` through the watch, the launch router's `sweep()`, and
/// outsiders' liquidity, donations and pool initialisations. Each swap leg is traced inside the unlock (its outcome,
/// the hook's reason, the price and `closedAtBlock` right after it) and judged against the documented rule for its
/// phase (`IBoxHook.sol:44-53`, `BoxHook.sol:176-228`): after the close every leg is refused `CurveIsClosed` until
/// graduate(); in the window every buy from a route other than the launch router is refused
/// `BuyThroughLaunchRouter`; the leg that ends at or past √P1
/// sets `closedAtBlock` to this block in its own afterSwap and no leg ending above √P1 does; no leg ends above √P0
/// before the migration; after the migration the hook refuses nothing. State invariants after every call: the rules
/// above never broken; before the migration the price is at most √P0 and the curve is closed exactly when the price is
/// at or past √P1; closedAtBlock and migratedAtBlock written once; the phase never goes back; the hook holds no ETH and
/// no T, and no claims before graduation; reserveMinted ≤ reserveCap and, before graduation, equal to the
/// coordinator's Q claims; the pool's active liquidity is exactly the hook's in-range positions'; the hook's views
/// equal StateLibrary's reads; the world's ghost ledger balances.
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeCurveInvariants is AuditU3ClaudeInvariantBase {
    uint160 internal sqrtP0;
    uint160 internal sqrtP1;
    uint256 internal gClosedAt;
    uint8 internal gPhase;
    address[4] internal traders;

    uint256 public nLegsOk;
    uint256 public nLegsRefused;
    uint256 public nWholeReverts;
    uint256 public nCloses;
    uint256 public nGraduations;
    uint256 public nRouterBuys;

    function setUp() public override {
        super.setUp();
        _toWindow();
        sqrtP0 = curve.sqrtPriceUpperX96;
        sqrtP1 = curve.sqrtPriceLowerX96;
        traders = [eoa[0], eoa[1], eoa[3], eoa[4]];
        for (uint256 i; i < traders.length; ++i) {
            vm.prank(traders[i]);
            token.approve(address(u3actor), type(uint256).max);
        }
        watch = new AuditU3ClaudeDeepenWatch(pm, hook, executor, receiver);
        taker = new AuditU3ClaudeTipTaker(pm, a.hook, a.receiver, poolKey);
        _ghostAddOutside(address(taker));
        gPhase = uint8(hook.phase());
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = this.hSwaps.selector;
        sel[1] = this.hSwapsAgain.selector;
        sel[2] = this.hRouterBuy.selector;
        sel[3] = this.hAdvance.selector;
        sel[4] = this.hGraduate.selector;
        sel[5] = this.hCollect.selector;
        sel[6] = this.hDeepen.selector;
        sel[7] = this.hOutsider.selector;
        sel[8] = this.hSweep.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: sel}));
        targetSender(makeAddr("audit.u3.curveFuzzer"));
    }

    // ============================================================================================================
    // Handlers

    /// @notice One to three swaps in one unlock by a trader through the router-like actor, each leg traced.
    function hSwaps(uint256 who, uint256 shape, uint256[3] calldata sizes, uint256[3] calldata limits) public {
        address t = traders[who % traders.length];
        uint256 n = 1 + shape % 3;
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](n);
        for (uint256 i; i < n; ++i) {
            uint256 bits = shape >> (2 + 4 * i);
            // A quarter of the legs without try/catch (a refusal then reverts the whole unlock).
            legs[i] = _shaped(t, bits & 1 == 0, (bits >> 1) & 1 == 0, sizes[i], limits[i], (bits >> 2) & 3 != 0);
        }
        uint256 closed0 = hook.closedAtBlock();
        uint256 migrated0 = hook.migratedAtBlock();
        bool window = _inWindow();
        try this.doSwaps(t, legs) returns (AuditU3ClaudeActor.Trace[] memory tr) {
            _judge(legs, tr, closed0, migrated0, window);
        } catch (bytes memory err) {
            ++nWholeReverts;
            _judgeWholeRevert(err, closed0, migrated0, window);
        }
        _afterCall();
    }

    /// @notice The same handler under a second selector, so swaps are two calls in nine.
    function hSwapsAgain(uint256 who, uint256 shape, uint256[3] calldata sizes, uint256[3] calldata limits) external {
        hSwaps(who, shape, sizes, limits);
    }

    /// @notice A taxed buy through box 0's launch router (it refuses outside the window and after the close).
    function hRouterBuy(uint256 who, uint256 size) external {
        address t = traders[who % traders.length];
        uint256 m = size % 3;
        uint256 q = m == 0
            ? bound(size, 1e9, 0.01 ether)
            : (m == 1 ? bound(size, 0.01 ether, 1 ether) : bound(size, 1 ether, 2 * raise));
        uint256 closed0 = hook.closedAtBlock();
        try this.doRouterBuy(t, q) {
            ++nRouterBuys;
            if (closed0 != 0) _fail(1, "a launch-router buy passed after the close");
            _judgeOne(closed0);
        } catch {}
        _afterCall();
    }

    /// @notice Mostly 1 to 3 blocks of 12 s (so the 32-block window lasts several calls), a quarter of the time up
    /// to 40.
    function hAdvance(uint256 blocks) external {
        _advance(blocks % 4 == 0 ? bound(blocks, 1, 40) : bound(blocks, 1, 3));
        _afterCall();
    }

    /// @notice `graduate()` by the keeper or a trader: passes exactly once, after the close, and leaves the price at
    /// exactly √P1, the curve removed, the coordinator with no T.
    function hGraduate(uint256 who) external {
        address c = who % 2 == 0 ? keeper : traders[who % traders.length];
        bool closed = hook.closed();
        bool migrated = hook.migratedAtBlock() != 0;
        try this.doGraduate(c) {
            ++nGraduations;
            if (!closed || migrated) _fail(2, "graduate() passed without a close, or twice");
            gMigratedAt = hook.migratedAtBlock();
            (gAsk, gBid, gSentinel) = hook.graduatedLayout();
            if (_sqrtP() != sqrtP1) _fail(3, "graduation left the price off P1");
            if (_curveL() != 0) _fail(4, "graduation left the curve position");
            if (token.balanceOf(a.coordinator) != 0) _fail(5, "graduation left T in the coordinator");
        } catch {
            if (closed && !migrated) _fail(6, "graduate() refused after the close (D1: it cannot be blocked)");
        }
        _afterCall();
    }

    /// @notice `collect()`: refused only for a batch below the minimum; at most one poke per position held.
    function hCollect() external {
        uint256 held = _positionsHeld();
        (bool ok, bytes4 reason, uint256 pokes, uint256 others) = _collectCounted();
        if (!ok && reason != IBoxReceiver.BatchTooSmall.selector) _fail(7, "collect() refused for another reason");
        if (ok && (pokes > 4 || pokes != held || others != 0)) {
            _fail(8, "collect() poked other than each position once");
        }
        _afterCall();
    }

    /// @notice `deepen()` through the watch (before graduation it must skip NotGraduated and change nothing).
    function hDeepen(bool viaTaker) external {
        _deepenWatched(viaTaker);
        _afterCall();
    }

    /// @notice The launch router's `sweep()`: refused before the migration (the tax waits, F77); after it the hook's Q
    /// claims rise by exactly the router's balance (its depth budget), the T claims not at all.
    function hSweep() external {
        uint256 held = a.launchRouter.balance;
        bool migrated = hook.migratedAtBlock() != 0;
        (uint256 q0, uint256 t0) = _hookClaims();
        vm.prank(keeper);
        (bool ok,) = a.launchRouter.call(abi.encodeWithSignature("sweep()"));
        (uint256 q1, uint256 t1) = _hookClaims();
        if (ok && !migrated) _fail(27, "the launch tax was swept before the migration");
        if (ok && (q1 != q0 + held || t1 != t0)) {
            _fail(28, "a sweep moved the hook's claims by other than the router's ETH");
        }
        if (!ok && (q1 != q0 || t1 != t0)) _fail(29, "a refused sweep moved the hook's claims");
        if (!ok && migrated && held != 0) _fail(35, "a sweep with tax to move was refused after the migration");
        _afterCall();
    }

    /// @notice An outsider's add, removal, poke, donation or second pool: every one must revert.
    function hOutsider(uint256 seed) external {
        uint256 k = seed % 5;
        bool ok;
        if (k < 3) {
            int256 delta = k == 0 ? int256(bound(seed, 1, 1e24)) : (k == 1 ? -int256(bound(seed, 1, 1e24)) : int256(0));
            int24 lo = seed % 2 == 0 ? MIN_T : curve.tickLower;
            int24 hi = seed % 3 == 0 ? MAX_T : curve.tickUpper;
            ModifyLiquidityParams memory p = ModifyLiquidityParams(lo, hi, delta, bytes32(seed % 4));
            (ok,) = address(u3actor).call(abi.encodeCall(AuditU3ClaudeActor.modify, (poolKey, p, keeper)));
        } else if (k == 3) {
            (ok,) = address(u3actor)
                .call(abi.encodeCall(AuditU3ClaudeActor.donate, (poolKey, bound(seed, 1, 1e15), 0, keeper)));
        } else {
            PoolKey memory pk = _keyWith(uint24(bound(seed, 0, 20_000)), int24(int256(bound(seed, 1, 400))), a.hook);
            (ok,) = address(pm).call(abi.encodeCall(IPoolManager.initialize, (pk, uint160(1 << 96))));
        }
        if (ok) _fail(9, "an outsider changed box 0's pool or made a second pool");
        _afterCall();
    }

    // ------------------------------------------------------------------------------------------------ self calls

    /// @notice The legs through the actor as `t` (who pays and receives; the unspent ETH swept back), booked.
    function doSwaps(address t, AuditU3ClaudeActor.Leg[] memory legs)
        external
        returns (AuditU3ClaudeActor.Trace[] memory tr)
    {
        require(msg.sender == address(this), "self only");
        uint256 value = 10 * raise + 1 ether;
        // The actor holds no ETH between calls (its sweep would hand a leftover to `t` as if it were a swap's output).
        require(address(u3actor).balance == 0, "the actor holds no ETH between calls");
        _fund(t, value);
        (uint256 e0, uint256 t0) = (t.balance, token.balanceOf(t));
        vm.prank(t);
        tr = u3actor.swapsTraced{value: value}(poolKey, legs, t, t);
        u3actor.sweepTo(t);
        _noteEthChange(e0, t.balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(t), TIn.Sell, TOut.Buy);
    }

    function doRouterBuy(address t, uint256 q) external {
        require(msg.sender == address(this), "self only");
        _windowBuy(t, q);
    }

    function doGraduate(address c) external {
        require(msg.sender == address(this), "self only");
        _graduate(c);
    }

    // ============================================================================================================
    // Judging the traces

    function _judge(
        AuditU3ClaudeActor.Leg[] memory legs,
        AuditU3ClaudeActor.Trace[] memory tr,
        uint256 closed0,
        uint256 migrated0,
        bool window
    ) internal {
        uint256 closedNow = closed0;
        for (uint256 i; i < tr.length; ++i) {
            AuditU3ClaudeActor.Trace memory x = tr[i];
            if (x.ok) ++nLegsOk;
            else ++nLegsRefused;
            if (migrated0 != 0) {
                if (!x.ok && x.byHook) _fail(10, "the hook refused a swap after the migration");
                continue;
            }
            if (closedNow != 0) {
                if (x.ok) {
                    _fail(11, "a swap passed after the close, before graduate()");
                } else if (!x.byHook || x.reason != IBoxHook.CurveIsClosed.selector) {
                    _fail(12, "a swap after the close refused other than CurveIsClosed");
                }
                continue;
            }
            if (window && legs[i].params.zeroForOne) {
                if (x.ok) {
                    _fail(13, "a buy passed in the window off the launch router");
                } else if (!x.byHook || x.reason != IBoxHook.BuyThroughLaunchRouter.selector) {
                    _fail(14, "a window buy refused other than BuyThroughLaunchRouter");
                }
                continue;
            }
            if (!x.ok) {
                if (x.byHook && (x.reason != IBoxHook.BelowCurveFloor.selector || legs[i].params.zeroForOne)) {
                    _fail(15, "the open curve refused a swap other than a sale at its floor");
                }
                continue;
            }
            if (x.sqrtAfter > sqrtP0) _fail(16, "a swap ended above P0 before the migration");
            if (x.sqrtAfter <= sqrtP1) {
                if (x.closedAt != vm.getBlockNumber()) {
                    _fail(17, "a swap ended at or past P1 without closing in its block");
                }
                closedNow = x.closedAt;
                ++nCloses;
            } else if (x.closedAt != 0) {
                _fail(18, "the curve closed on a swap that ended above P1");
            }
        }
        if (hook.closedAtBlock() != closedNow) _fail(19, "closedAtBlock differs from the traced close");
    }

    /// @notice A whole unlock reverted (a leg without try/catch was refused, or the payer could not pay): its reason,
    /// when the hook's, must be one some leg could get in this phase; nothing changed.
    function _judgeWholeRevert(bytes memory err, uint256 closed0, uint256 migrated0, bool window) internal {
        (bool byHook, bytes4 r) = u3actor.reasonOf(err);
        if (hook.closedAtBlock() != closed0) _fail(20, "a reverted unlock changed closedAtBlock");
        if (!byHook) return;
        if (migrated0 != 0) {
            _fail(21, "the hook refused a swap after the migration");
        } else if (closed0 != 0) {
            if (r != IBoxHook.CurveIsClosed.selector) {
                _fail(22, "after the close the hook refused other than CurveIsClosed");
            }
        } else if (
            r != IBoxHook.CurveIsClosed.selector && r != IBoxHook.BelowCurveFloor.selector
                && !(window && r == IBoxHook.BuyThroughLaunchRouter.selector)
        ) {
            _fail(23, "the open curve refused a swap for an undocumented reason");
        }
    }

    /// @notice After one successful swap that started on an open curve.
    function _judgeOne(uint256 closed0) internal {
        uint160 s = _sqrtP();
        if (hook.migratedAtBlock() != 0) return;
        if (s > sqrtP0) _fail(16, "a swap ended above P0 before the migration");
        if (s <= sqrtP1) {
            if (closed0 == 0 && hook.closedAtBlock() != vm.getBlockNumber()) {
                _fail(17, "a swap ended at or past P1 without closing in its block");
            }
            if (closed0 == 0) ++nCloses;
        } else if (hook.closedAtBlock() != 0) {
            _fail(18, "the curve closed on a swap that ended above P1");
        }
    }

    function _afterCall() internal {
        uint8 p = uint8(hook.phase());
        if (p < gPhase) _fail(24, "the hook's phase went back");
        gPhase = p;
        uint256 c = hook.closedAtBlock();
        if (gClosedAt == 0) gClosedAt = c;
        else if (c != gClosedAt) _fail(25, "closedAtBlock rewritten");
        uint256 m = hook.migratedAtBlock();
        if (gMigratedAt != 0 && m != gMigratedAt) _fail(26, "migratedAtBlock rewritten");
        _checkPositions();
    }

    // ============================================================================================================
    // Building the legs

    function _inWindow() internal view returns (bool) {
        uint256 open = hook.openAt();
        return vm.getBlockTimestamp() >= open && vm.getBlockTimestamp() < open + hook.WINDOW_SECONDS();
    }

    /// @notice A leg of any shape: buys of 1 wei to 3 × R exact input (one in eight large enough to fill the curve) or
    /// 1 unit to twice the curve's T left exact output; sales of 1 unit to all the trader's T exact input or 1 wei to
    /// 0.5 ETH exact output; the limit at the extreme, at exactly P1 (buys) or P0 (sales), within 2,000 ticks of them,
    /// or anywhere.
    function _shaped(address t, bool buy, bool exactIn, uint256 size, uint256 lim, bool tryCatch)
        internal
        view
        returns (AuditU3ClaudeActor.Leg memory)
    {
        uint256 m = size % 8;
        uint256 amt;
        if (buy && exactIn) {
            // Tiny, small, medium; one leg in eight large enough to fill the curve (up to 3 × R).
            if (m < 2) amt = bound(size, 1, 1e9);
            else if (m < 5) amt = bound(size, 1e9, 0.05 ether);
            else if (m < 7) amt = bound(size, 0.05 ether, 0.5 ether);
            else amt = bound(size, 0.5 ether, 3 * raise);
        } else if (buy) {
            uint256 left = _tLeft();
            if (m < 2) amt = bound(size, 1, 1e12);
            else if (m < 7) amt = bound(size, 1, left / 4 + 1);
            else amt = bound(size, left / 2 + 1, 2 * left + 2);
        } else if (exactIn) {
            uint256 have = token.balanceOf(t);
            amt = have == 0 ? 1 : (m < 2 ? bound(size, 1, 1e6) : bound(size, 1, have));
        } else {
            amt = m < 2 ? bound(size, 1, 1e9) : bound(size, 1, 0.5 ether);
        }
        return _leg(buy, _amount(amt, exactIn), _limitFor(buy, lim), tryCatch);
    }

    function _tLeft() internal view returns (uint256) {
        uint160 s = _sqrtP();
        if (hook.migratedAtBlock() != 0 || s <= sqrtP1) return 1e24;
        return SqrtPriceMath.getAmount1Delta(sqrtP1, s, curve.liquidity, false);
    }

    function _limitFor(bool buy, uint256 lim) internal view returns (uint160) {
        uint256 m = lim % 4;
        uint256 lo = TickMath.MIN_SQRT_PRICE + 1;
        uint256 hi = TickMath.MAX_SQRT_PRICE - 1;
        if (m == 3) return uint160(bound(lim, lo, hi));
        if (buy) {
            if (m == 0) return uint160(lo);
            if (m == 1) return sqrtP1;
            return uint160(bound(lim, _sqrtAt(curve.tickLower - 2_000), _sqrtAt(curve.tickLower + 2_000)));
        }
        if (m == 0) return uint160(hi);
        if (m == 1) return sqrtP0;
        return uint160(bound(lim, _sqrtAt(curve.tickUpper - 2_000), _sqrtAt(curve.tickUpper + 2_000)));
    }

    // ============================================================================================================
    // The campaign's witness

    /// The handlers are not vacuous: eight seeded sequences of 128 calls drawn as the campaign draws them reach the
    /// window's refusals, launch-router buys, the close (in several shapes), graduation and the graduated pool; every
    /// rule holds along the way and every state invariant holds at each sequence's end. Counts are logged.
    function testProperty_AUDIT_U3_curveCampaignWitness() public {
        uint256[7] memory tot;
        uint256 snap = vm.snapshotState();
        for (uint256 r; r < 8; ++r) {
            vm.revertToState(snap);
            for (uint256 c; c < 128; ++c) {
                _seededCall(uint256(keccak256(abi.encode("audit.u3.curve", r, c))));
            }
            assertEq(violation, 0, violationWhy);
            invariant_AUDIT_U3_priceNeverAboveP0BeforeMigration();
            invariant_AUDIT_U3_closedExactlyWhenAtOrPastP1();
            invariant_AUDIT_U3_hookHoldsOnlyClaims();
            invariant_AUDIT_U3_reserveNeverAboveCap();
            invariant_AUDIT_U3_onlyTheHooksLiquidity();
            invariant_AUDIT_U3_viewsAreStateLibrarys();
            invariant_AUDIT_U3_ghostLedgerBalanced();
            tot[0] += hook.closed() ? 1 : 0;
            tot[1] += nGraduations;
            tot[2] += nLegsOk;
            tot[3] += nLegsRefused;
            tot[4] += nWholeReverts;
            tot[5] += nRouterBuys;
            tot[6] += nCollects;
        }
        emit log_named_uint("sequences that closed", tot[0]);
        emit log_named_uint("graduations", tot[1]);
        emit log_named_uint("swap legs that passed", tot[2]);
        emit log_named_uint("swap legs refused", tot[3]);
        emit log_named_uint("unlocks reverted whole", tot[4]);
        emit log_named_uint("launch-router buys", tot[5]);
        emit log_named_uint("collects", tot[6]);
        assertGe(tot[0], 4, "most sequences close the curve");
        assertGe(tot[1], 4, "and graduate it");
        assertGt(tot[3], 0);
        assertGt(tot[4], 0);
        assertGt(tot[5], 0);
    }

    function _seededCall(uint256 x) internal {
        uint256 k = x % 10;
        uint256 y = uint256(keccak256(abi.encode(x)));
        uint256[3] memory sz;
        uint256[3] memory lm;
        for (uint256 i; i < 3; ++i) {
            sz[i] = uint256(keccak256(abi.encode(y, i)));
            lm[i] = uint256(keccak256(abi.encode(y, i + 3)));
        }
        uint256 shape = uint256(keccak256(abi.encode(y, 7)));
        if (k <= 1) this.hSwaps(y, shape, sz, lm);
        else if (k == 2) this.hRouterBuy(y, sz[0]);
        else if (k == 3) this.hAdvance(y);
        else if (k == 4) this.hGraduate(y);
        else if (k == 5) this.hCollect();
        else if (k == 6) this.hDeepen(y % 2 == 0);
        else if (k == 7) this.hOutsider(y);
        else if (k == 8) this.hSweep();
        else this.hSwapsAgain(y, shape, sz, lm);
    }

    // ============================================================================================================
    // Invariants

    /// No call broke a documented rule of its phase (the traces' judgement, graduate(), collect(), deepen()'s watch,
    /// the outsiders, the written-once words, the phase order, the L7 positions and the pair).
    function invariant_AUDIT_U3_curveRulesHold() public view {
        assertEq(violation, 0, violationWhy);
    }

    /// Before the migration the price never ends above √P0 (IBoxHook.sol:51; BoxHook.sol:221).
    function invariant_AUDIT_U3_priceNeverAboveP0BeforeMigration() public view {
        if (hook.migratedAtBlock() == 0) assertLe(_sqrtP(), sqrtP0, "above P0 before the migration");
    }

    /// Before the migration the curve is closed exactly when the price is at or past √P1 (only swaps move it, and the
    /// one that reaches P1 closes in its own afterSwap; nothing trades after the close): close exactly once (BC-025).
    function invariant_AUDIT_U3_closedExactlyWhenAtOrPastP1() public view {
        if (hook.migratedAtBlock() != 0) {
            assertGe(hook.migratedAtBlock(), hook.closedAtBlock(), "graduated in or after the closing block");
            assertTrue(hook.closed());
            return;
        }
        assertEq(hook.closed(), _sqrtP() <= sqrtP1, "closed exactly when the price is at or past P1");
        assertEq(hook.closed(), hook.closedAtBlock() != 0);
    }

    /// The hook holds no ETH and no T; before graduation no claims either (the depth parts wait in the receiver and the
    /// tax in the launch router); its claims are the depth budget (BoxHook.sol:39-41; IBoxHook.sol:89-91).
    function invariant_AUDIT_U3_hookHoldsOnlyClaims() public view {
        assertEq(a.hook.balance, 0, "the hook holds no ETH");
        assertEq(token.balanceOf(a.hook), 0, "the hook holds no T");
        (uint256 q, uint256 t) = _hookClaims();
        if (hook.migratedAtBlock() == 0) assertEq(q + t, 0, "no depth budget before graduation");
    }

    /// reserveMinted ≤ reserveCap; before graduation the coordinator's Q claims are exactly the reserve (D6, BC-017).
    function invariant_AUDIT_U3_reserveNeverAboveCap() public view {
        assertLe(hook.reserveMinted(), hook.reserveCap(), "reserveMinted <= reserveCap");
        if (!coordinator.graduated()) {
            assertEq(pm.balanceOf(a.coordinator, 0), hook.reserveMinted(), "the coordinator holds exactly the reserve");
        }
    }

    /// The pool's active liquidity is exactly the hook's in-range positions': no outsider's liquidity exists (BC-032);
    /// the curve holds its whole liquidity until the migration and nothing after it.
    function invariant_AUDIT_U3_onlyTheHooksLiquidity() public view {
        assertEq(uint256(_activeL()), _hookActiveL(), "active liquidity == the hook's in-range positions'");
        if (hook.migratedAtBlock() == 0) {
            assertEq(_curveL(), curve.liquidity, "the curve never shrinks before the migration");
            assertEq(uint256(_askL()) + _bidL() + _sentinelL() + _pairL(), 0, "no other position before it");
        } else {
            assertEq(_curveL(), 0, "the curve removed whole");
        }
    }

    /// The hook's views read what v4's StateLibrary reads (P3.13).
    function invariant_AUDIT_U3_viewsAreStateLibrarys() public view {
        _assertViewsAreStateLibrarys();
    }

    /// The world's ghost ledger: system ETH == Σ in − Σ out, outside T == Σ out − Σ in, supply accounted.
    function invariant_AUDIT_U3_ghostLedgerBalanced() public view {
        _assertGhostLedger();
    }
}
