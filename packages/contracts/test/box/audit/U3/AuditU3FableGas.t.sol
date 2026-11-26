// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {AuditU3FableBase} from "./AuditU3FableBase.sol";

/// @notice SH-AUDIT-B0 U3 (Fable), L5 (P3.11, X18): the hook's gas per ordinary swap, three ways.
/// (1) BC-018 as it is defined (`BoxS45Gas.t.sol:24-30`, on the factory's box 0 here): after graduation, a buy and a
/// sell through the Universal Router stand-in on box 0's pool against the same swap on a hookless pool holding the
/// same ask, bid and sentinel at the same price after the same warm-up; the difference per swap against +14,123.
/// (2) The two callbacks v4 makes (`beforeSwap`, `afterSwap`), called as the PoolManager would, each callback's own
/// frame (`vm.lastFrameGas`: the clone's frame, its DELEGATECALL to the implementation included) in every phase.
/// (3) The whole swap through the stand-in per phase and shape, the closing buy, `graduate()`, and the keeper calls
/// at the largest reachable state (`collect` with four positions, `deepen` as a conversion, as the first pair and
/// into a pair with fees, the cooldown skip), each logged and pinned under a stated local bound.
/// **How Foundry meters here** (as `docs/evidence/SH-S0-spikes.md` § 2.4 records: "whole transaction, 21,000 +
/// calldata + execution"; a no-op transaction reads 21,205 on Osaka): every top-level call from the test is its own
/// transaction, so every measured call is cold (there is no warm measurement at this depth, and `vm.cool` changes
/// nothing), and a non-static call's frame carries the transaction's intrinsic gas (21,000 plus EIP-2028 calldata);
/// a `staticcall`'s does not. So (2) calls the callbacks by `staticcall` (none writes outside the close), (1) is a
/// difference of two calls with the same calldata (the base cancels), and (3)'s driver deltas are whole transactions.
/// Local figures only: the fork and Sepolia figures BC-018 waits for are a limitation; `cancun` cannot run here (the
/// world needs EIP-2537). Run under Osaka and Amsterdam (the concrete contracts); under Amsterdam the frame gas leaves
/// EIP-8037 state gas out (S0 § 2.4 caveat 1); no swap after graduation creates hook state (asserted below).
abstract contract AuditU3FableGasBase is AuditU3FableBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// BC-018's budget (P), as `BoxS45Gas.t.sol:30` states it: the research's +10,623 plus 3,500 for the clone call.
    uint256 internal constant BC018_BUDGET = 14_123;
    /// A local pin for the two cold callback frames before graduation (the gate's router read, the floor's
    /// argument copy, pool id and PoolManager read; each frame cold on its own under this metering). Measured
    /// (Osaka / Amsterdam): window sell 8,958 + 15,572 = 24,530 / 9,858 + 16,872 = 26,730; bonding buy and sell
    /// 6,104 + 15,572 = 21,676 / 6,504 + 16,872 = 23,376. The window's beforeSwap also reads the router argument.
    uint256 internal constant PRE_GRADUATION_FRAMES_BOUND = 28_000;

    struct Frames {
        uint256 before_;
        uint256 after_;
    }

    // ================================================================================================ BC-018

    /// BC-018 as defined: after graduation, a buy and a sell through the stand-in on box 0's pool cost at most
    /// +14,123 gas over the same swap on a hookless pool holding the same three positions at the same price (each
    /// measured swap its own transaction: cold). The outsider seeds the hookless pool with dealt T, so this test does
    /// not check the ghost ledger.
    function testProperty_AUDIT_U3_extraGasPerOrdinarySwapWithinBudget() public {
        _toGraduated();
        PoolKey memory hookless = _hooklessTwin();
        address trader = makeAddr("u3.gas.trader");
        _warmUpBoth(hookless, trader);
        uint256 extraBuy = _extra(hookless, trader, true);
        uint256 extraSell = _extra(hookless, trader, false);
        emit log_named_uint("U3F|BC-018 extra gas per swap, buy 0.1 ETH", extraBuy);
        emit log_named_uint("U3F|BC-018 extra gas per swap, sell 5M T", extraSell);
        assertLe(extraBuy, BC018_BUDGET, "BC-018: a buy within +14,123");
        assertLe(extraSell, BC018_BUDGET, "BC-018: a sell within +14,123");
    }

    // ================================================================================================ callbacks

    /// P3.11: the two callbacks' own frames per phase (window sell; bonding buy and sell; graduated buy and sell),
    /// each cold: after graduation their sum is within BC-018's budget on its own (the early return before any
    /// argument read), and it is the least of all phases; before graduation the sum stays under a local pin.
    function testProperty_AUDIT_U3_swapCallbackFramesPerPhase() public {
        _toWindow();
        Frames memory w = _frames(false);
        _log("window (sell)", w);
        _toBonding();
        Frames memory b = _frames(true);
        _log("bonding (buy)", b);
        Frames memory bs = _frames(false);
        _log("bonding (sell)", bs);
        _toGraduated();
        Frames memory g = _frames(true);
        _log("graduated (buy)", g);
        Frames memory gs = _frames(false);
        _log("graduated (sell)", gs);
        assertLe(g.before_ + g.after_, BC018_BUDGET, "graduated (buy): both cold frames within BC-018");
        assertLe(gs.before_ + gs.after_, BC018_BUDGET, "graduated (sell): both cold frames within BC-018");
        assertLt(g.before_ + g.after_, b.before_ + b.after_, "after graduation the callbacks cost less");
        assertLe(w.before_ + w.after_, PRE_GRADUATION_FRAMES_BOUND, "window: local pin");
        assertLe(b.before_ + b.after_, PRE_GRADUATION_FRAMES_BOUND, "bonding (buy): local pin");
        assertLe(bs.before_ + bs.after_, PRE_GRADUATION_FRAMES_BOUND, "bonding (sell): local pin");
    }

    // ================================================================================================ whole calls

    /// The whole swap through the stand-in per phase and shape, the closing buy and `graduate()` (each a transaction
    /// as metered here, logged), and every swap after graduation writes no hook slot (BC-018: no state from a swap).
    function testProperty_AUDIT_U3_wholeSwapGasPerPhase() public {
        _toWindow();
        _logSwap("window exact-in sell", _gasSell(eoa[0], token.balanceOf(eoa[0]) / 10));
        _toBonding();
        _logSwap("bonding exact-in buy", _gasBuy(eoa[3], 0.05 ether));
        _logSwap("bonding exact-in sell", _gasSell(eoa[3], token.balanceOf(eoa[3]) / 2));
        _logSwap("bonding exact-out buy", _gasBuyOut(eoa[3], 1e20));
        uint256 g0 = gasleft();
        _toClosed();
        emit log_named_uint("U3F|gas closing buy (whole driver)", g0 - gasleft());
        _warpTo(_requestTimeFor(r0));
        g0 = gasleft();
        _graduate(keeper);
        emit log_named_uint("U3F|gas graduate()", g0 - gasleft());
        vm.record();
        _logSwap("graduated exact-in buy", _gasBuy(eoa[3], 0.05 ether));
        _logSwap("graduated exact-in sell", _gasSell(eoa[3], token.balanceOf(eoa[3]) / 2));
        _logSwap("graduated exact-out buy", _gasBuyOut(eoa[3], 1e20));
        (, bytes32[] memory writes) = vm.accesses(a.hook);
        assertEq(writes.length, 0, "no graduated swap writes a hook slot");
    }

    /// X18: the keeper calls at the largest reachable state: `deepen()` as a conversion alone, as the first pair, as
    /// an add into the pair with fees to poke; `collect()` with all four positions earning; the cooldown skip; each
    /// the driver's gas (a transaction as metered here) under a stated local bound.
    function testProperty_AUDIT_U3_keeperCallsBounded() public {
        _toGraduated();
        _catchUp(300);
        _fundDepth(eoa[5], 0.6 ether);
        uint256 g0 = gasleft();
        (DepthKind kind, DeepenSkip skip,,,) = _deepen(keeper, keeper);
        uint256 gConvert = g0 - gasleft();
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Convert));
        emit log_named_uint("U3F|gas deepen() conversion alone (driver)", gConvert);
        _giftT(eoa[2], _tForQ(0.5 ether, _sqrtP()));
        _catchUp(300);
        g0 = gasleft();
        (kind, skip,,,) = _deepen(keeper, keeper);
        uint256 gPair = g0 - gasleft();
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        assertEq(uint8(kind), uint8(DepthKind.Pair));
        emit log_named_uint("U3F|gas deepen() first pair (driver)", gPair);
        _buy(eoa[3], 0.3 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _catchUp(300);
        g0 = gasleft();
        (kind, skip,,,) = _deepen(keeper, keeper);
        uint256 gPair2 = g0 - gasleft();
        assertEq(uint8(skip), uint8(DeepenSkip.None));
        emit log_named_uint("U3F|gas deepen() add into the pair with fees (driver)", gPair2);
        _buy(eoa[3], 0.6 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        g0 = gasleft();
        _collect(keeper, keeper);
        uint256 gCollect = g0 - gasleft();
        emit log_named_uint("U3F|gas collect() with four positions (driver)", gCollect);
        g0 = gasleft();
        (, skip,,,) = _deepen(keeper, keeper);
        uint256 gSkip = g0 - gasleft();
        assertEq(uint8(skip), uint8(DeepenSkip.Cooldown));
        emit log_named_uint("U3F|gas deepen() cooldown skip (driver)", gSkip);
        assertLt(gConvert, 1_000_000, "a conversion under 1,000,000 (local bound)");
        assertLt(gPair, 1_000_000, "a first pair under 1,000,000 (local bound)");
        assertLt(gPair2, 1_000_000, "a pair add with a poke under 1,000,000 (local bound)");
        assertLt(gCollect, 1_500_000, "a four-position batch under 1,500,000 (local bound)");
        assertLt(gSkip, 100_000, "a skip under 100,000 (local bound)");
        _assertHookHoldsOnlyClaims();
    }

    // ------------------------------------------------------------------------------------------------ callbacks

    function _frames(bool buy) internal returns (Frames memory f) {
        SwapParams memory p = SwapParams(buy, -1, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        f.before_ = _static(abi.encodeCall(IHooks.beforeSwap, (address(routerSwapper), poolKey, p, "")));
        f.after_ =
            _static(abi.encodeCall(IHooks.afterSwap, (address(routerSwapper), poolKey, p, BalanceDelta.wrap(0), "")));
    }

    /// @dev The callback as the PoolManager, by `staticcall` (no write outside the close), its own frame's gas.
    function _static(bytes memory data) internal returns (uint256) {
        vm.prank(address(pm));
        (bool ok,) = a.hook.staticcall(data);
        assertTrue(ok, "the callback returned");
        return _frameGas();
    }

    function _frameGas() internal view returns (uint256) {
        VmSafe.Gas memory g = vm.lastFrameGas();
        return g.gasTotalUsed;
    }

    function _log(string memory phase, Frames memory f) internal {
        emit log_named_uint(string.concat("U3F|gas ", phase, " beforeSwap frame (cold)"), f.before_);
        emit log_named_uint(string.concat("U3F|gas ", phase, " afterSwap frame (cold)"), f.after_);
    }

    // ------------------------------------------------------------------------------------------------ whole swaps

    function _logSwap(string memory what, uint256 g) internal {
        emit log_named_uint(string.concat("U3F|gas swap ", what, " (stand-in transaction)"), g);
    }

    function _gasBuy(address who, uint256 q) internal returns (uint256 g) {
        _fund(who, q);
        g = gasleft();
        _swap(who, _buyParams(q, TickMath.MIN_SQRT_PRICE + 1), q);
        g -= gasleft();
    }

    function _gasBuyOut(address who, uint256 t) internal returns (uint256 g) {
        _fund(who, 1 ether);
        g = gasleft();
        _swap(who, _buyOutParams(t, TickMath.MIN_SQRT_PRICE + 1), 1 ether);
        g -= gasleft();
    }

    function _gasSell(address who, uint256 t) internal returns (uint256 g) {
        g = gasleft();
        _swap(who, _sellParams(t, TickMath.MAX_SQRT_PRICE - 1), 0);
        g -= gasleft();
    }

    // ------------------------------------------------------------------------------------------------ hookless twin

    /// @dev A hookless pool with box 0's T, fee and spacing at box 0's price, holding the same ask, bid and sentinel
    /// (the outsider adds them with dealt T and ETH; a hookless pool refuses nobody).
    function _hooklessTwin() internal returns (PoolKey memory k) {
        k = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(a.token), BoxSpecV1.LP_FEE, BoxSpecV1.TICK_SPACING, IHooks(address(0))
        );
        pm.initialize(k, _sqrtP());
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        deal(a.token, address(outsider), 5e26);
        vm.deal(address(outsider), 20 ether);
        outsider.modify(k, curve.tickLower, MAX_T, int256(uint256(bid)));
        outsider.modify(k, curve.tickUpper, MAX_T, int256(uint256(sentinel)));
        outsider.modify(k, MIN_T, curve.tickLower, int256(uint256(ask)));
        (uint160 s1,,,) = pm.getSlot0(k.toId());
        assertEq(s1, _sqrtP(), "twin: the same price");
        uint128 active = pm.getLiquidity(k.toId());
        assertTrue(active == ask || active == bid, "twin: at P1");
    }

    /// @dev S0's warm-up on both pools (parks the price in the ask) so both hold the same state; the trader holds T.
    function _warmUpBoth(PoolKey memory k, address trader) internal {
        deal(a.token, trader, 2e26);
        vm.deal(trader, 50 ether);
        vm.prank(trader);
        token.approve(address(routerSwapper), type(uint256).max);
        _warmUpOne(poolKey, trader);
        _warmUpOne(k, trader);
        _assertSameState(k);
    }

    function _warmUpOne(PoolKey memory k, address trader) internal {
        _raw(k, trader, _buyParams(0.3 ether, TickMath.MIN_SQRT_PRICE + 1), 0.3 ether);
        _raw(k, trader, _sellParams(100_000_000e18, TickMath.MAX_SQRT_PRICE - 1), 0);
        _raw(k, trader, _buyParams(3 ether, TickMath.MIN_SQRT_PRICE + 1), 3 ether);
        _raw(k, trader, _buyParams(0.5 ether, TickMath.MIN_SQRT_PRICE + 1), 0.5 ether);
    }

    function _assertSameState(PoolKey memory k) internal view {
        PoolId twin = k.toId();
        (uint160 s1, int24 t1,,) = pm.getSlot0(twin);
        assertEq(_sqrtP(), s1, "both pools at the same price after the warm-up");
        assertEq(_tick(), t1, "both pools at the same tick");
        assertLt(t1, curve.tickLower, "parked in the ask");
        assertEq(pm.getLiquidity(poolId), pm.getLiquidity(twin), "the same active liquidity");
    }

    /// @dev One measured swap on each pool (box 0's first, the twin's second), the same parameters and calldata; the
    /// hooked frame's gas less the hookless one's (both cold, their intrinsic bases equal and cancelled).
    function _extra(PoolKey memory k, address trader, bool buy) internal returns (uint256) {
        SwapParams memory p = buy
            ? _buyParams(0.1 ether, TickMath.MIN_SQRT_PRICE + 1)
            : _sellParams(5_000_000e18, TickMath.MAX_SQRT_PRICE - 1);
        uint256 value = buy ? 0.1 ether : 0;
        _raw(poolKey, trader, p, value);
        uint256 withHook = _frameGas();
        _raw(k, trader, p, value);
        uint256 base = _frameGas();
        assertGt(withHook, base, "the hooked swap costs more than the hookless one");
        return withHook - base;
    }

    function _raw(PoolKey memory k, address who, SwapParams memory p, uint256 value) internal {
        vm.prank(who);
        routerSwapper.swapOne{value: value}(k, p, "", who);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU3FableGasTest is AuditU3FableGasBase {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU3FableGasAmsterdamTest is AuditU3FableGasBase {}
