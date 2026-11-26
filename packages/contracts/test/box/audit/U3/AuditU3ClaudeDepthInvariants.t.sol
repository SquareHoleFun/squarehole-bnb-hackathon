// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3ClaudeActor, AuditU3ClaudeTipTaker} from "./AuditU3ClaudeBase.sol";
import {AuditU3ClaudeDeepenWatch} from "./AuditU3ClaudeDeepenWatch.sol";
import {AuditU3ClaudeInvariantBase} from "./AuditU3ClaudeInvariantBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude): the depth invariant campaign on the factory's box 0 after graduation, with the real
/// FitBuybackExecutor as the 1-hour average (P3.1, P3.4, P3.8, P3.10, P3.11, P3.16; BC-118 to BC-122, BC-133, BC-137,
/// BC-142). Start: graduated, the launch tax swept into the hook's claims, 300 blocks on. Random calls: trades (buys,
/// sales, round trips), pushes of the spot to −150 … +150 ticks from the average (anywhere inside the tick or on its
/// edge), the executor's poke and a funded `execute(1)` (FIT's own buy in the same pool), time (1-10 blocks or about
/// one cooldown, each ending with a keeper's poke), `deepen()` through the watch with the tip to the keeper or to a
/// re-entering recipient that trades inside the hook's unlock, `collect()` (pokes counted), `fundDepth()` gifts from a
/// stranger or the Safe, ERC-6909 claim gifts of Q and T to the hook, and `deepen()` / `collect()` from inside another
/// account's unlock plus outsiders' liquidity and donations. Every deepen is judged by the watch against every
/// documented rule (guards, cooldown, exact claims movement, tip, conversion bounds, minimum output, fee note, the
/// pair's cap and MIN_ADD budget, t_ref − 99); every other call must leave the hook's claims unchanged except by its
/// named path, exactly (a batch: its DepthFunded parts and returned note; a gift: the gift). State invariants after
/// every call: no rule broken; the hook holds no ETH and no T; the L7 positions as seeded and the pair never below its
/// high-water mark; the pool's active liquidity exactly the hook's in-range positions'; the hook's storage word equal
/// to its value at graduation but for lastDeepenBlock (the block of the last act) and the pair bit (set exactly when
/// the pair exists); reserveMinted frozen at graduation; the views equal StateLibrary's; the ghost ledger balanced.
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeDepthInvariants is AuditU3ClaudeInvariantBase {
    uint256 internal constant DEEPEN_FIELD = ((uint256(1) << 40) - 1) << 168;
    uint256 internal constant PAIR_BIT = uint256(1) << 235;

    address internal giver = makeAddr("audit.u3.depthGiver");
    address[3] internal traders;
    uint256 internal gReserve;
    uint256 internal gWordFixed;

    uint256 public nTrades;
    uint256 public nPushes;
    uint256 public nExecutes;
    uint256 public nGifts;
    uint256 public nFundDepth;
    uint256 public nForeign;

    function setUp() public override {
        super.setUp();
        _ghostAddOutside(giver);
        _toBonding();
        _buy(whale, 0.5 ether);
        _toGraduated();
        vm.prank(keeper);
        launchRouter.sweep();
        _advance(300);
        traders = [eoa[3], eoa[4], eoa[5]];
        watch = new AuditU3ClaudeDeepenWatch(pm, hook, executor, receiver);
        taker = new AuditU3ClaudeTipTaker(pm, a.hook, a.receiver, poolKey);
        _ghostAddOutside(address(taker));
        _transferT(whale, address(taker), token.balanceOf(whale) / 10);
        vm.prank(whale);
        token.approve(address(u3actor), type(uint256).max);
        gMigratedAt = hook.migratedAtBlock();
        (gAsk, gBid, gSentinel) = hook.graduatedLayout();
        gReserve = hook.reserveMinted();
        gWordFixed = uint256(vm.load(a.hook, bytes32(0))) & ~(DEEPEN_FIELD | PAIR_BIT);
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = this.hTrade.selector;
        sel[1] = this.hPush.selector;
        sel[2] = this.hPoke.selector;
        sel[3] = this.hExecute.selector;
        sel[4] = this.hAdvance.selector;
        sel[5] = this.hDeepen.selector;
        sel[6] = this.hDeepenAgain.selector;
        sel[7] = this.hCollect.selector;
        sel[8] = this.hFundDepth.selector;
        sel[9] = this.hGift.selector;
        sel[10] = this.hForeign.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: sel}));
        targetSender(makeAddr("audit.u3.depthFuzzer"));
    }

    // ============================================================================================================
    // Handlers

    /// @notice A buy of 0.001-0.3 ETH, a sale of at most that much T at spot, or a round trip, by one of three traders.
    function hTrade(uint256 who, uint256 size, uint8 mode) external {
        address t = traders[who % traders.length];
        uint256 eth = bound(size, 0.001 ether, 0.3 ether);
        (uint256 q0, uint256 t0) = _hookClaims();
        try this.doTrade(t, eth, mode % 3) {
            ++nTrades;
        } catch {}
        _unchanged(q0, t0, "a trade moved the hook's claims");
        _afterCall();
    }

    /// @notice The spot landed at the average + d ticks (d in −150 … +150), on the tick's edge a quarter of the time.
    function hPush(int256 dSeed, uint256 frac) external {
        (, int24 avg,) = executor.twap();
        int24 d = int24(bound(dSeed, -150, 150));
        uint160 lo = _sqrtAt(avg + d);
        uint160 hi = _sqrtAt(avg + d + 1);
        uint160 target = frac % 4 == 0 ? lo : uint160(bound(frac, lo, hi - 1));
        (uint256 q0, uint256 t0) = _hookClaims();
        try this.doLand(target) {
            ++nPushes;
        } catch {}
        _unchanged(q0, t0, "a push moved the hook's claims");
        _afterCall();
    }

    function hPoke() external {
        (uint256 q0, uint256 t0) = _hookClaims();
        executor.poke();
        _unchanged(q0, t0, "a poke moved the hook's claims");
        _afterCall();
    }

    /// @notice FIT's executor funded (0.01-0.2 ETH) and one chunk executed: its own buy in box 0's pool.
    function hExecute(uint256 amount) external {
        (uint256 q0, uint256 t0) = _hookClaims();
        try this.doExecute(bound(amount, 0.01 ether, 0.2 ether)) {
            ++nExecutes;
        } catch {}
        _unchanged(q0, t0, "FIT's executor moved the hook's claims");
        _afterCall();
    }

    /// @notice 1-10 blocks, or 280-320 (about one cooldown), then a keeper's poke of the executor.
    function hAdvance(uint256 blocks) external {
        (uint256 q0, uint256 t0) = _hookClaims();
        _advance(blocks % 3 == 0 ? bound(blocks, 280, 320) : bound(blocks, 1, 10));
        executor.poke();
        _unchanged(q0, t0, "time moved the hook's claims");
        _afterCall();
    }

    function hDeepen(bool viaTaker) public {
        _deepenWatched(viaTaker);
        _afterCall();
    }

    /// @notice The same under a second selector (deepen is the campaign's subject).
    function hDeepenAgain(bool viaTaker) external {
        hDeepen(viaTaker);
    }

    function hCollect() external {
        uint256 held = _positionsHeld();
        (bool ok, bytes4 reason, uint256 pokes, uint256 others) = _collectCounted();
        if (!ok && reason != IBoxReceiver.BatchTooSmall.selector) _fail(7, "collect() refused for another reason");
        if (ok && (pokes > 4 || pokes != held || others != 0)) {
            _fail(8, "collect() poked other than each position once");
        }
        _afterCall();
    }

    /// @notice `fundDepth()` of 1 wei-0.1 ETH by a stranger or the Safe: exactly the gift into the hook's Q claims.
    function hFundDepth(uint256 amount, bool fromSafe) external {
        uint256 x = bound(amount, 1, 0.1 ether);
        (uint256 q0, uint256 t0) = _hookClaims();
        try this.doFundDepth(fromSafe ? safe : giver, x) {
            ++nFundDepth;
            (uint256 q1, uint256 t1) = _hookClaims();
            if (q1 != q0 + x || t1 != t0) _fail(50, "fundDepth() moved the hook's claims by other than the gift");
        } catch {
            _fail(51, "fundDepth() refused after graduation");
        }
        _afterCall();
    }

    /// @notice ERC-6909 claims of Q (from the giver's ETH) and T (from the whale's T) minted straight to the hook.
    function hGift(uint256 qSeed, uint256 tSeed) external {
        uint256 q = bound(qSeed, 0, 0.05 ether);
        uint256 t = bound(tSeed, 0, token.balanceOf(whale) / 20);
        (uint256 q0, uint256 t0) = _hookClaims();
        try this.doGift(q, t) {
            ++nGifts;
            (uint256 q1, uint256 t1) = _hookClaims();
            if (q1 != q0 + q || t1 != t0 + t) _fail(52, "a claim gift moved the hook's claims by other than the gift");
        } catch {}
        _afterCall();
    }

    /// @notice From inside another account's unlock: deepen and collect must revert; outsiders' liquidity and
    /// donations must revert; the hook's claims never move.
    function hForeign(uint256 seed) external {
        (uint256 q0, uint256 t0) = _hookClaims();
        uint256 k = seed % 4;
        bool ok;
        if (k == 0) {
            (ok,) = u3actor.callInside(a.hook, abi.encodeCall(IBoxHook.deepen, (keeper)));
        } else if (k == 1) {
            (ok,) = u3actor.callInside(a.receiver, abi.encodeCall(IBoxReceiver.collect, (keeper)));
        } else if (k == 2) {
            int256 delta = seed % 3 == 0 ? int256(bound(seed, 1, 1e24)) : (seed % 3 == 1 ? -int256(1) : int256(0));
            ModifyLiquidityParams memory p = ModifyLiquidityParams(MIN_T, MAX_T, delta, bytes32(seed % 4));
            (ok,) = address(u3actor).call(abi.encodeCall(AuditU3ClaudeActor.modify, (poolKey, p, keeper)));
        } else {
            (ok,) = address(u3actor)
                .call(abi.encodeCall(AuditU3ClaudeActor.donate, (poolKey, 0, bound(seed, 1, 1e18), keeper)));
        }
        ++nForeign;
        if (ok) _fail(53, "deepen/collect inside a foreign unlock, or an outsider's liquidity or donation, passed");
        _unchanged(q0, t0, "a foreign call moved the hook's claims");
        _afterCall();
    }

    // ------------------------------------------------------------------------------------------------ self calls

    function doTrade(address t, uint256 eth, uint256 mode) external {
        require(msg.sender == address(this), "self only");
        if (mode == 0) {
            _buy(t, eth);
        } else if (mode == 1) {
            uint256 have = token.balanceOf(t);
            uint256 worth = (((eth * uint256(_sqrtP())) >> 96) * uint256(_sqrtP())) >> 96;
            uint256 x = have < worth ? have : worth;
            if (x != 0) _sell(t, x);
        } else {
            uint256 got = _buy(t, eth);
            _sell(t, got);
        }
    }

    function doLand(uint160 target) external {
        require(msg.sender == address(this), "self only");
        _land(target);
    }

    function doExecute(uint256 amount) external {
        require(msg.sender == address(this), "self only");
        _fundBudget(giver, amount);
        executor.execute(1);
    }

    function doFundDepth(address from, uint256 x) external {
        require(msg.sender == address(this), "self only");
        _fundDepth(from, x);
    }

    function doGift(uint256 q, uint256 t) external {
        require(msg.sender == address(this), "self only");
        if (q != 0) {
            _fund(giver, q);
            uint256 e0 = giver.balance;
            vm.prank(giver);
            u3actor.mintClaims{value: q}(Currency.wrap(address(0)), q, giver, a.hook);
            _noteEthChange(e0, giver.balance, EthIn.FundDepth, EthOut.Other);
        }
        if (t != 0) {
            uint256 w0 = token.balanceOf(whale);
            u3actor.mintClaims(Currency.wrap(a.token), t, whale, a.hook);
            _noteTChange(w0, token.balanceOf(whale), TIn.Other, TOut.Other);
        }
    }

    // ------------------------------------------------------------------------------------------------ checks

    function _unchanged(uint256 q0, uint256 t0, string memory why) internal {
        (uint256 q1, uint256 t1) = _hookClaims();
        if (q1 != q0 || t1 != t0) _fail(54, why);
    }

    function _afterCall() internal {
        _checkPositions();
        uint256 w = uint256(vm.load(a.hook, bytes32(0)));
        if (w & ~(DEEPEN_FIELD | PAIR_BIT) != gWordFixed) {
            _fail(55, "the state word moved beyond lastDeepenBlock and the pair bit");
        }
        if ((w & PAIR_BIT != 0) != (_pairL() != 0)) _fail(56, "the pair bit disagrees with the pair");
        if (hook.lastDeepenBlock() != gLastDeepen) _fail(57, "lastDeepenBlock is not the block of the last act");
    }

    // ============================================================================================================
    // The campaign's witness

    /// The handlers are not vacuous: eight seeded sequences of 128 calls drawn as the campaign draws them reach
    /// conversions, pairs, tips through the re-entering recipient, collects, pushes, FIT's execute and gifts; every
    /// rule holds along the way and every state invariant at each sequence's end. Counts are logged.
    function testProperty_AUDIT_U3_depthCampaignWitness() public {
        uint256[8] memory tot;
        uint256 snap = vm.snapshotState();
        for (uint256 r; r < 8; ++r) {
            vm.revertToState(snap);
            for (uint256 c; c < 128; ++c) {
                _seededCall(uint256(keccak256(abi.encode("audit.u3.depth", r, c))));
            }
            assertEq(violation, 0, violationWhy);
            invariant_AUDIT_U3_hookHoldsOnlyClaimsAfterGraduation();
            invariant_AUDIT_U3_positionsNeverShrink();
            invariant_AUDIT_U3_onlyTheHooksLiquidityAfterGraduation();
            invariant_AUDIT_U3_stateWordStaysConsistent();
            invariant_AUDIT_U3_reserveFrozenAfterGraduation();
            invariant_AUDIT_U3_depthViewsAreStateLibrarys();
            invariant_AUDIT_U3_depthGhostLedgerBalanced();
            tot[0] += nDeepenActs;
            tot[1] += nDeepenSkips;
            tot[2] += nPairs;
            tot[3] += nConversions;
            tot[4] += nTakerTips;
            tot[5] += nCollects;
            tot[6] += nExecutes;
            tot[7] += nGifts + nFundDepth;
        }
        emit log_named_uint("deepen acts", tot[0]);
        emit log_named_uint("deepen skips", tot[1]);
        emit log_named_uint("pairs", tot[2]);
        emit log_named_uint("conversions", tot[3]);
        emit log_named_uint("tips through the re-entering recipient", tot[4]);
        emit log_named_uint("collects", tot[5]);
        emit log_named_uint("FIT executes", tot[6]);
        emit log_named_uint("gifts and fundDepth", tot[7]);
        assertGe(tot[0], 8, "deepen acts");
        assertGt(tot[2], 0, "pairs");
        assertGt(tot[3], 0, "conversions");
        assertGt(tot[4], 0, "tips to the re-entering recipient");
        assertGt(tot[5], 0, "collects");
    }

    function _seededCall(uint256 x) internal {
        uint256 k = x % 11;
        uint256 y = uint256(keccak256(abi.encode(x)));
        uint256 z = uint256(keccak256(abi.encode(y)));
        if (k == 0) this.hTrade(y, z, uint8(y % 3));
        else if (k == 1) this.hPush(int256(y), z);
        else if (k == 2) this.hPoke();
        else if (k == 3) this.hExecute(y);
        else if (k == 4) this.hAdvance(y);
        else if (k == 5) hDeepen(y % 2 == 0);
        else if (k == 6) this.hDeepenAgain(y % 2 == 0);
        else if (k == 7) this.hCollect();
        else if (k == 8) this.hFundDepth(y, y % 2 == 0);
        else if (k == 9) this.hGift(y, z);
        else this.hForeign(y);
    }

    // ============================================================================================================
    // Invariants

    /// No call broke a documented rule (every deepen judged by the watch; every other call's effect on the hook's
    /// claims, collect's pokes, gifts, foreign calls, the state word).
    function invariant_AUDIT_U3_depthRulesHold() public view {
        assertEq(violation, 0, violationWhy);
    }

    /// The hook holds no ETH and no T: its only balances are its claims, the depth budget (BoxHook.sol:39-41).
    function invariant_AUDIT_U3_hookHoldsOnlyClaimsAfterGraduation() public view {
        assertEq(a.hook.balance, 0, "the hook holds no ETH");
        assertEq(token.balanceOf(a.hook), 0, "the hook holds no T");
    }

    /// No position shrinks: ask, bid and sentinel stay as the migration seeded them; the pair only grows (IBoxHook.sol:
    /// 89-90; F72 (B), F77: never removable).
    function invariant_AUDIT_U3_positionsNeverShrink() public view {
        assertEq(_askL(), gAsk, "ask");
        assertEq(_bidL(), gBid, "bid");
        assertEq(_sentinelL(), gSentinel, "sentinel");
        assertGe(_pairL(), gPair, "the pair never below its high-water mark");
        assertEq(_curveL(), 0, "no curve after graduation");
    }

    /// The pool's active liquidity is exactly the hook's in-range positions' (closed pool, BC-032).
    function invariant_AUDIT_U3_onlyTheHooksLiquidityAfterGraduation() public view {
        assertEq(uint256(_activeL()), _hookActiveL(), "active liquidity == the hook's in-range positions'");
    }

    /// The storage word the two code halves share (P3.8): unchanged since graduation but for lastDeepenBlock (the last
    /// act's block) and the pair bit (set exactly when the pair exists).
    function invariant_AUDIT_U3_stateWordStaysConsistent() public view {
        uint256 w = uint256(vm.load(a.hook, bytes32(0)));
        assertEq(w & ~(DEEPEN_FIELD | PAIR_BIT), gWordFixed, "only lastDeepenBlock and the pair bit move");
        assertEq(w & PAIR_BIT != 0, _pairL() != 0, "the pair bit says whether the pair exists");
        assertEq(hook.lastDeepenBlock(), gLastDeepen, "lastDeepenBlock is the last act's block");
        assertLe(hook.lastDeepenBlock(), vm.getBlockNumber());
    }

    /// reserveMinted frozen at graduation, within its cap (D6).
    function invariant_AUDIT_U3_reserveFrozenAfterGraduation() public view {
        assertEq(hook.reserveMinted(), gReserve);
        assertLe(gReserve, hook.reserveCap());
    }

    function invariant_AUDIT_U3_depthViewsAreStateLibrarys() public view {
        _assertViewsAreStateLibrarys();
    }

    function invariant_AUDIT_U3_depthGhostLedgerBalanced() public view {
        _assertGhostLedger();
    }
}
