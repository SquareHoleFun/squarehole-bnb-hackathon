// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {ITestT} from "../utils/Fixture.sol";
import {MockERC20} from "../utils/MockTokens.sol";
import {StepRouter} from "../utils/v4/Routers.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

/// @notice Random trading through the REAL hook and PoolManager: exact-in/out buys and sells, holder transfers,
/// claims (R = Q) or conversions (R = T, the real converter swapping through the pool: whole or partial, with the
/// sold-out Q fallback), fee processing and flash take → swap → settle sequences (fail-closed: they must revert with
/// the ledger's PoolOutflowAtFeeEvent). Every swap's receipt is checked inline against Pool.sol fee growth; a ghost
/// splits each fee event's holder Q pro rata over the actors' balances at the swap (independent of the ledger's index)
/// and never defers anything except at zero eligible supply.
contract V4Handler is Test {
    using StateLibrary for IPoolManager;

    uint256 internal constant GHOST_SCALE = 1e18;
    uint256 internal constant Q128 = 1 << 128;

    IPoolManager public immutable pm;
    StepRouter public immutable router;
    SquareHoleClaimConverter public immutable converter;
    MockERC20 public immutable quote;
    ITestT public immutable token;
    RewardLedger public immutable ledger;
    FeeCollector public immutable collector;
    PoolId public immutable poolId;
    bool public immutable tIsCurrency0;
    bool public immutable payoutIsT;
    address public immutable hookAddr;
    uint256 public immutable unit;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    uint128 public immutable liquidity;
    PoolKey internal _key;

    address[] public actors;
    mapping(address => uint256) public ghostEntitledScaled;
    mapping(address => uint256) public ghostClaimed;
    uint256 public ghostBootstrap;
    uint256 public ghostExpectedTFees; // Σ Pool.sol fee growth × L / 2^128, T
    uint256 public ghostExpectedQFees; // same, Q
    uint256 public ghostMaxError;

    uint256 public countSwaps;
    uint256 public countExactOut;
    uint256 public countSells;
    uint256 public countFlash;
    uint256 public countFlashReverted;
    uint256 public countClaims;
    uint256 public countPartialConversions;
    uint256 public countQFallbacks;
    uint256 public countBurns;
    uint256 public countSoldOut; // swaps that left the pool with no T in range (price beyond the range)
    uint256 public countConversionsBlocked;
    /// @dev Pool.sol `PriceLimitAlreadyExceeded(uint160,uint160)`.
    bytes4 internal constant PRICE_LIMIT_EXCEEDED = 0x7c9c6e8f;

    constructor(
        IPoolManager pm_,
        StepRouter router_,
        SquareHoleClaimConverter converter_,
        MockERC20 quote_,
        V4Fixture.Launch memory L
    ) {
        pm = pm_;
        router = router_;
        converter = converter_;
        quote = quote_;
        token = L.t;
        ledger = L.ledger;
        collector = L.collector;
        poolId = L.id;
        tIsCurrency0 = L.tIsCurrency0;
        payoutIsT = L.r.rewardSide == 1;
        hookAddr = L.r.hook;
        unit = L.r.kind == SquareHoleRegistry.AssetKind.Collection ? L.r.initialSupply / L.r.units : 1e18;
        tickLower = L.r.tickLower;
        tickUpper = L.r.tickUpper;
        liquidity = L.r.liquidity;
        _key = L.key;
        for (uint256 i; i < 5; ++i) {
            actors.push(makeAddr(string.concat("v4actor", vm.toString(i))));
        }
        address wallet7702 = makeAddr("v4actor7702");
        vm.etch(wallet7702, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        actors.push(wallet7702);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev One call in 16 is a whale buy of up to 40 Q: enough to leave the range (sold out) in the WETH template
    /// (the whole range costs about 31.6 × the 1-WETH start FDV), so campaigns also cover out-of-range swaps
    /// (no fee accrues, nothing is collected) and the way back into the range.
    function buyExactIn(uint256 actorSeed, uint256 amountSeed) external {
        address a = actors[actorSeed % actors.length];
        (uint256 reservesT,) = _principal();
        // Sold out: the price sits at the routers' extreme limit and there is nothing left to buy (a further buy with
        // that limit reverts in Pool.sol with PriceLimitAlreadyExceeded; sells bring the price back).
        if (reservesT == 0) return;
        uint256 qIn = uint256(keccak256(abi.encode(amountSeed))) % 16 == 0
            ? bound(amountSeed, 1 ether, 40 ether)
            : bound(amountSeed, 1e9, 0.5 ether);
        _swap(a, true, -int256(qIn));
    }

    function buyExactOut(uint256 actorSeed, uint256 unitsSeed) external {
        address a = actors[actorSeed % actors.length];
        (uint256 reservesT,) = _principal();
        uint256 tOut = bound(unitsSeed, 1, 5) * unit;
        if (tOut * 2 > reservesT) return; // stay inside the range (an exact-out beyond it cannot fill)
        _swap(a, true, int256(tOut));
        ++countExactOut;
    }

    function sellExactIn(uint256 actorSeed, uint256 fracSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        uint256 tIn = bound(fracSeed, 1, bal);
        _swap(a, false, -int256(tIn));
        ++countSells;
    }

    function sellExactOut(uint256 actorSeed, uint256 qSeed) external {
        address a = actors[actorSeed % actors.length];
        (, uint256 reservesQ) = _principal();
        if (reservesQ < 1e9 || token.balanceOf(a) == 0) return;
        uint256 qOut = bound(qSeed, 1e6, reservesQ / 4);
        // Only if the actor can afford it at ~2x the current price (checked by the router's settle otherwise).
        if (_tForQ(qOut) * 2 > token.balanceOf(a)) return;
        _swap(a, false, int256(qOut));
        ++countSells;
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 amount = bound(amountSeed, 0, token.balanceOf(from));
        vm.prank(from);
        token.transfer(to, amount);
    }

    /// @dev R = T: every other call converts a random slice (partial conversion); when the pool cannot fill it and
    /// the range is sold out, the holder takes the slice in Q through the converter's fallback.
    function claim(uint256 actorSeed, uint256 sliceSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 owed = ledger.claimable(a);
        if (payoutIsT) {
            if (owed == 0) return;
            uint256 maxQ = sliceSeed % 2 == 0 ? type(uint256).max : bound(sliceSeed, 1, owed);
            // The conversion is a swap through the pool: its own fee event is ghosted like any swap (the holder's
            // pre-conversion balance earns its share of it).
            uint256 claimedBefore = ledger.totalClaimed();
            if (!_conversion(a, maxQ)) {
                // The pool could not fill the conversion: ECO-07, nothing was consumed.
                assertEq(ledger.claimable(a), owed, "failed conversion leaves the claim intact");
                if (!converter.isSoldOut(address(token))) {
                    ++countConversionsBlocked;
                    return;
                }
                uint256 qBefore = quote.balanceOf(a);
                vm.prank(a);
                uint256 paid = converter.claimAsQWhenSoldOut(address(token), maxQ);
                assertEq(paid, maxQ < owed ? maxQ : owed, "fallback pays the requested slice");
                assertEq(quote.balanceOf(a) - qBefore, paid, "in Q, to the holder");
                ++countQFallbacks;
            } else if (maxQ < owed) {
                ++countPartialConversions;
            }
            ghostClaimed[a] += ledger.totalClaimed() - claimedBefore;
        } else {
            vm.prank(a);
            ghostClaimed[a] += ledger.claim(a);
        }
        if (owed != 0) ++countClaims;
        _trackError(a);
    }

    function processFees() external {
        (uint256 burned,) = collector.processFees();
        if (burned != 0) ++countBurns;
    }

    /// PoolManager.take(T) to `borrower`, a buy by `buyer` in the same unlock, settle(T) back. Fail-closed flash guard
    /// (review round A): a fee event carrying holder Q while the borrowed reserves are out reverts the whole unlock
    /// with the ledger's PoolOutflowAtFeeEvent(borrowed); nothing is deferred and nobody earns. A buy that collects
    /// no holder Q completes and changes no entitlement.
    function flashBorrowSwap(uint256 borrowerSeed, uint256 buyerSeed, uint256 borrowSeed, uint256 qSeed) external {
        address borrower = actors[borrowerSeed % actors.length];
        address buyer = actors[buyerSeed % actors.length];
        (uint256 reservesT,) = _principal();
        if (reservesT < 2) return;
        uint256 borrowed = bound(borrowSeed, 1, reservesT / 2);
        uint256 qIn = bound(qSeed, 1e9, 0.2 ether);
        quote.mint(buyer, qIn);
        _approve(address(quote), buyer, qIn);
        _approve(address(token), borrower, borrowed);
        address t = address(token);
        StepRouter.Step[] memory s = new StepRouter.Step[](5);
        s[0] = _step(StepRouter.Op.Take, t, borrower, borrowed);
        s[1] = _swapStep(true, -int256(qIn));
        s[2] = _step(StepRouter.Op.Settle, t, borrower, borrowed);
        s[3] = _step(StepRouter.Op.SettleAll, address(quote), buyer, 0);
        s[4] = _step(StepRouter.Op.TakeAll, t, buyer, 0);
        uint256 holderBefore = collector.totalQHolders();
        uint256 bootstrapBefore = ledger.bootstrapQ();
        (uint256 g0T, uint256 g0Q) = _growth();
        uint256 tRecv = collector.totalTReceived();
        uint256 qRecv = collector.totalQReceived();
        try router.run(s) {
            _reconcile(g0T, g0Q, tRecv, qRecv);
            ++countSwaps;
            assertEq(collector.totalQHolders(), holderBefore, "a flash fee event with holder Q never completes");
        } catch (bytes memory reason) {
            assertEq(keccak256(reason), keccak256(_outflowRevert(borrowed)), "only the flash guard refuses it");
            ++countFlashReverted;
        }
        assertEq(ledger.bootstrapQ(), bootstrapBefore, "nothing deferred");
        _approve(address(token), borrower, 0);
        _approve(address(quote), buyer, 0);
        ++countFlash;
    }

    /// The revert of a fee-bearing swap after a same-transaction pool outflow (ledger error wrapped by v4).
    function _outflowRevert(uint256 outflow) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            hookAddr,
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, outflow),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _swap(address trader, bool buy, int256 amountSpecified) internal {
        address input = buy ? address(quote) : address(token);
        address output = buy ? address(token) : address(quote);
        if (buy) quote.mint(trader, amountSpecified < 0 ? uint256(-amountSpecified) : 10 ether);
        _approve(input, trader, buy ? quote.balanceOf(trader) : token.balanceOf(trader));
        StepRouter.Step[] memory s = new StepRouter.Step[](3);
        s[0] = _swapStep(buy, amountSpecified);
        s[1] = _step(StepRouter.Op.SettleAll, input, trader, 0);
        s[2] = _step(StepRouter.Op.TakeAll, output, trader, 0);
        _ghostSwap(trader, s);
        _approve(input, trader, 0);
        (uint256 reservesT,) = _principal();
        if (buy && reservesT == 0) ++countSoldOut;
    }

    /// Runs `s` (one fee-bearing swap, settled/taken after it) and applies the ghost at the swap's balances.
    function _ghostSwap(address, StepRouter.Step[] memory s) internal {
        uint256[] memory before = _balances();
        uint256 holderBefore = collector.totalQHolders();
        uint256 receipts = collector.receiptCount();
        _checkedRun(s);
        // A swap whose fee rounds to zero collects nothing: no receipt, no fee event (nothing released).
        if (collector.receiptCount() != receipts) _ghostFee(collector.totalQHolders() - holderBefore, before);
    }

    /// The converter's own swap (inside its unlock), reconciled and ghosted like any swap. Returns false when the
    /// pool cannot fill it (the whole call reverted).
    function _conversion(address holder, uint256 maxQ) internal returns (bool converted) {
        uint256[] memory before = _balances();
        uint256 holderBefore = collector.totalQHolders();
        (uint256 g0T, uint256 g0Q) = _growth();
        uint256 tRecv = collector.totalTReceived();
        uint256 qRecv = collector.totalQReceived();
        uint256 receipts = collector.receiptCount();
        vm.prank(holder);
        try converter.claimAsT(address(token), maxQ, 0, block.timestamp) {
            converted = true;
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            assertTrue(
                selector == SquareHoleClaimConverter.PartialFill.selector || selector == PRICE_LIMIT_EXCEEDED,
                "only an unfillable pool may block a conversion"
            );
            return false;
        }
        _reconcile(g0T, g0Q, tRecv, qRecv);
        if (collector.receiptCount() != receipts) _ghostFee(collector.totalQHolders() - holderBefore, before);
        ++countSwaps;
    }

    function _checkedRun(StepRouter.Step[] memory s) internal {
        if (s.length == 0) return;
        (uint256 g0T, uint256 g0Q) = _growth();
        uint256 tRecv = collector.totalTReceived();
        uint256 qRecv = collector.totalQReceived();
        router.run(s);
        _reconcile(g0T, g0Q, tRecv, qRecv);
        ++countSwaps;
    }

    /// Receipts of this step equal Pool.sol fee growth × L / 2^128 exactly; nothing stays uncollected.
    function _reconcile(uint256 g0T, uint256 g0Q, uint256 tRecv, uint256 qRecv) internal {
        (uint256 g1T, uint256 g1Q) = _growth();
        uint256 eT = FullMath.mulDiv(g1T - g0T, liquidity, Q128);
        uint256 eQ = FullMath.mulDiv(g1Q - g0Q, liquidity, Q128);
        assertEq(collector.totalTReceived() - tRecv, eT, "T receipts == fee growth");
        assertEq(collector.totalQReceived() - qRecv, eQ, "Q receipts == fee growth");
        ghostExpectedTFees += eT;
        ghostExpectedQFees += eQ;
    }

    /// Ghost of the fee event of one run: `holderQ` deferred (zero eligible supply) or split pro rata over the
    /// actors' balances before the run (every swap precedes its settle/take).
    function _ghostFee(uint256 holderQ, uint256[] memory before) internal {
        uint256 supply;
        for (uint256 i; i < before.length; ++i) {
            supply += before[i];
        }
        if (supply == 0) {
            ghostBootstrap += holderQ;
            return;
        }
        uint256 allocation = holderQ + ghostBootstrap;
        ghostBootstrap = 0;
        if (allocation == 0) return;
        for (uint256 i; i < actors.length; ++i) {
            ghostEntitledScaled[actors[i]] += before[i] * allocation * GHOST_SCALE / supply;
        }
    }

    function _balances() internal view returns (uint256[] memory b) {
        b = new uint256[](actors.length);
        for (uint256 i; i < actors.length; ++i) {
            b[i] = token.balanceOf(actors[i]);
        }
    }

    function _growth() internal view returns (uint256 gT, uint256 gQ) {
        (uint256 g0, uint256 g1) = pm.getFeeGrowthInside(poolId, tickLower, tickUpper);
        (gT, gQ) = tIsCurrency0 ? (g0, g1) : (g1, g0);
    }

    function _principal() internal view returns (uint256 t, uint256 q) {
        (uint160 sqrtP,,,) = pm.getSlot0(poolId);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtP < sqrtL) sqrtP = sqrtL;
        if (sqrtP > sqrtU) sqrtP = sqrtU;
        uint256 a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtU, liquidity, true);
        uint256 a1 = SqrtPriceMath.getAmount1Delta(sqrtL, sqrtP, liquidity, true);
        (t, q) = tIsCurrency0 ? (a0, a1) : (a1, a0);
    }

    /// Rough T needed for `qOut` at the current price (upper bound use only).
    function _tForQ(uint256 qOut) internal view returns (uint256) {
        (uint160 sqrtP,,,) = pm.getSlot0(poolId);
        // Outside the range the price jumps back to the range edge at no cost: estimate at the clamped price.
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtP < sqrtL) sqrtP = sqrtL;
        if (sqrtP > sqrtU) sqrtP = sqrtU;
        uint256 pQ96 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96); // currency1 per currency0, Q96
        if (pQ96 == 0) return type(uint256).max;
        return tIsCurrency0 ? FullMath.mulDiv(qOut, 1 << 96, pQ96) : FullMath.mulDiv(qOut, pQ96, 1 << 96);
    }

    function _swapStep(bool buy, int256 amountSpecified) internal view returns (StepRouter.Step memory s) {
        s.op = StepRouter.Op.Swap;
        s.key = _key;
        s.zeroForOne = buy ? !tIsCurrency0 : tIsCurrency0;
        s.amount = amountSpecified;
    }

    function _step(StepRouter.Op op, address currency, address account, uint256 amount)
        internal
        pure
        returns (StepRouter.Step memory s)
    {
        s.op = op;
        s.currency = currency;
        s.account = account;
        s.amount = int256(amount);
    }

    function _approve(address t, address owner, uint256 amount) internal {
        vm.prank(owner);
        MockERC20(t).approve(address(router), amount);
    }

    function entitlementError(address a) public view returns (uint256) {
        uint256 onchain = ghostClaimed[a] + ledger.claimable(a);
        uint256 expected = ghostEntitledScaled[a] / GHOST_SCALE;
        return onchain > expected ? onchain - expected : expected - onchain;
    }

    function _trackError(address a) internal {
        uint256 err = entitlementError(a);
        if (err > ghostMaxError) ghostMaxError = err;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}

abstract contract V4InvariantBase is V4Fixture {
    using StateLibrary for IPoolManager;

    V4Handler internal handler;
    Launch internal L;

    function _setUpCampaign(SquareHoleRegistry.AssetKind kind, IRewardLedger.PayoutAsset payout) internal {
        _deploySystem();
        // F10: a 1,000-NFT collection (one NFT = 1,000,000 tokens) or a token, both exactly 1e9 tokens.
        uint256 units = kind == SquareHoleRegistry.AssetKind.Collection ? 1_000 : 1e9;
        uint256 r = kind == SquareHoleRegistry.AssetKind.Collection ? 1e6 : 1;
        L = _launch(kind, units, r, wethTemplate, payout);
        handler = new V4Handler(pm, stepRouter, converter, weth, L);
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = V4Handler.buyExactIn.selector;
        selectors[1] = V4Handler.buyExactIn.selector;
        selectors[2] = V4Handler.buyExactOut.selector;
        selectors[3] = V4Handler.sellExactIn.selector;
        selectors[4] = V4Handler.sellExactOut.selector;
        selectors[5] = V4Handler.transfer.selector;
        selectors[6] = V4Handler.claim.selector;
        selectors[7] = V4Handler.processFees.selector;
        selectors[8] = V4Handler.flashBorrowSwap.selector;
        selectors[9] = V4Handler.sellExactIn.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Fees: all receipts equal Σ Pool.sol fee growth × L / 2^128; native T burned or pending; Q split 1:2.
    function invariant_v4_feesReconcileWithPoolFeeGrowth() public view {
        assertEq(L.collector.totalTReceived(), handler.ghostExpectedTFees());
        assertEq(L.collector.totalQReceived(), handler.ghostExpectedQFees());
        assertEq(L.collector.totalTReceived(), L.collector.totalTBurned() + L.collector.pendingBurnT());
        assertEq(
            L.collector.totalQReceived(),
            L.collector.totalQProtocol() + L.collector.totalQHolders() + L.collector.qRemainder()
        );
        assertEq(L.collector.totalQHolders(), 2 * L.collector.totalQProtocol());
    }

    /// Principal locked and backed: the position's liquidity never changes; the PoolManager holds the principal at
    /// the current price plus every outstanding claim of the launch (fees never come out of principal).
    function invariant_v4_principalLockedAndBacked() public view {
        assertEq(_positionLiquidity(L), L.r.liquidity);
        (uint256 pt, uint256 pq) = _principal(L);
        uint256 tClaims = _claimsOf(address(L.collector), L.r.token);
        uint256 qClaims = _claimsOf(address(L.collector), L.r.quote) + _claimsOf(address(L.ledger), L.r.quote);
        assertGe(L.t.balanceOf(address(pm)), pt + tClaims, "T backed");
        assertGe(weth.balanceOf(address(pm)), pq + qClaims, "Q backed");
        (uint256 uT, uint256 uQ) = _uncollected(L);
        assertEq(uT + uQ, 0, "no uncollected fees at rest");
    }

    function invariant_v4_supplyAndEligibility() public view {
        assertEq(L.t.totalSupply(), L.t.initialSupply() - L.collector.totalTBurned());
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += L.t.balanceOf(handler.actorAt(i));
        }
        assertEq(L.ledger.eligibleSupply(), sum, "only the actors are eligible");
        address[6] memory roles =
            [address(pm), address(hook), address(L.collector), address(L.ledger), address(launcher), treasury];
        for (uint256 i; i < roles.length; ++i) {
            assertEq(L.ledger.claimable(roles[i]), 0, "excluded roles earn nothing");
        }
    }

    function invariant_v4_entitlementsMatchGhost() public view {
        for (uint256 i; i < handler.actorCount(); ++i) {
            assertLe(handler.entitlementError(handler.actorAt(i)), 2, "entitlement vs ghost");
        }
        assertEq(L.ledger.bootstrapQ(), handler.ghostBootstrap(), "deferred bucket");
        assertGe(_claimsOf(address(L.ledger), L.r.quote), L.ledger.holderQOutstanding(), "ledger solvent");
    }

    function invariant_v4_noStandingAllowancesOrClaimsInTransit() public view {
        uint256 qId = uint256(uint160(L.r.quote));
        uint256 tId = uint256(uint160(L.r.token));
        assertEq(pm.balanceOf(address(hook), qId) + pm.balanceOf(address(hook), tId), 0, "hook holds no claims");
        assertEq(pm.allowance(address(hook), address(L.collector), qId), 0);
        assertEq(pm.allowance(address(hook), address(L.collector), tId), 0);
        assertEq(pm.allowance(address(L.collector), address(L.ledger), qId), 0);
        assertEq(pm.balanceOf(address(converter), qId), 0, "converter holds nothing at rest");
        assertEq(L.ledger.poolNetOutflow(), 0);
    }

    /// @dev Coverage counters of the run (fixed order, names in `_name`). With SH_INVARIANT_AGGREGATE=true they are
    /// also summed across runs in environment variables (maxErrWei: the maximum), like the B1 campaigns; run one
    /// suite at a time in that mode.
    function afterInvariant() external {
        uint256[12] memory c = [
            handler.countSwaps(),
            handler.countExactOut(),
            handler.countSells(),
            handler.countFlash(),
            handler.countFlashReverted(),
            handler.countClaims(),
            handler.countBurns(),
            handler.countSoldOut(),
            handler.countConversionsBlocked(),
            handler.countPartialConversions(),
            handler.countQFallbacks(),
            handler.ghostMaxError()
        ];
        string memory scope = "one run";
        if (vm.envOr("SH_INVARIANT_AGGREGATE", false)) {
            uint256 runs = vm.envOr("SH_V4_AGGREGATE_runs", uint256(0)) + 1;
            vm.setEnv("SH_V4_AGGREGATE_runs", vm.toString(runs));
            for (uint256 i; i < c.length; ++i) {
                string memory key = string.concat("SH_V4_AGGREGATE_", _name(i));
                uint256 previous = vm.envOr(key, uint256(0));
                c[i] = i == 11 ? (previous > c[i] ? previous : c[i]) : previous + c[i];
                vm.setEnv(key, vm.toString(c[i]));
            }
            scope = string.concat("aggregate of ", vm.toString(runs), " runs");
        }
        string memory line = string.concat("V4 COVERAGE(", scope, ")");
        for (uint256 i; i < c.length; ++i) {
            line = string.concat(line, " ", _name(i), "=", vm.toString(c[i]));
        }
        console.log(line);
    }

    function _name(uint256 i) internal pure returns (string memory) {
        string[12] memory names = [
            "swaps",
            "exactOut",
            "sells",
            "flash",
            "flashReverted",
            "claims",
            "burns",
            "soldOutBuys",
            "conversionsBlocked",
            "partialConversions",
            "qFallbacks",
            "maxErrWei"
        ];
        return names[i];
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: deep.invariant.runs = 512
/// forge-config: deep.invariant.depth = 128
contract V4InvariantsCollectionQ is V4InvariantBase {
    function setUp() public {
        _setUpCampaign(SquareHoleRegistry.AssetKind.Collection, IRewardLedger.PayoutAsset.Q);
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: deep.invariant.runs = 512
/// forge-config: deep.invariant.depth = 128
contract V4InvariantsCollectionT is V4InvariantBase {
    function setUp() public {
        _setUpCampaign(SquareHoleRegistry.AssetKind.Collection, IRewardLedger.PayoutAsset.T);
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: deep.invariant.runs = 512
/// forge-config: deep.invariant.depth = 128
contract V4InvariantsFungibleQ is V4InvariantBase {
    function setUp() public {
        _setUpCampaign(SquareHoleRegistry.AssetKind.Token, IRewardLedger.PayoutAsset.Q);
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: deep.invariant.runs = 512
/// forge-config: deep.invariant.depth = 128
contract V4InvariantsFungibleT is V4InvariantBase {
    function setUp() public {
        _setUpCampaign(SquareHoleRegistry.AssetKind.Token, IRewardLedger.PayoutAsset.T);
    }
}
