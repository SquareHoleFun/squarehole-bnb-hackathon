// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";
import {MockERC20} from "../utils/MockTokens.sol";
import {StepRouter, UniversalRouterLike, pullToken} from "../utils/v4/Routers.sol";

/// @notice Test-only counter-example (ADR-0011 "Fee realization"): a hook that realizes its position's fees as
/// ERC-20 with `PoolManager.take` inside afterSwap. It needs the PoolManager to already hold the fee currency before
/// the swapper settles, so the FIRST buy of a pool whose Q the PoolManager does not hold reverts. Square Hole's hook
/// mints ERC-6909 claims instead, which never depends on the PoolManager's physical balance.
contract TakeRealizingProbeHook is IUnlockCallback {
    IPoolManager internal immutable _pm;
    PoolKey internal _key;
    int24 internal _tickLower;
    int24 internal _tickUpper;

    constructor(IPoolManager pm_) {
        _pm = pm_;
    }

    function seed(PoolKey memory key, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
    {
        _key = key;
        _tickLower = tickLower;
        _tickUpper = tickUpper;
        _pm.initialize(key, sqrtPriceX96);
        _pm.unlock(abi.encode(liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        uint128 liquidity = abi.decode(data, (uint128));
        (BalanceDelta delta,) =
            _pm.modifyLiquidity(_key, ModifyLiquidityParams(_tickLower, _tickUpper, int256(uint256(liquidity)), 0), "");
        Currency owedCurrency = delta.amount0() < 0 ? _key.currency0 : _key.currency1;
        uint256 owed = uint256(uint128(-(delta.amount0() < 0 ? delta.amount0() : delta.amount1())));
        _pm.sync(owedCurrency);
        MockERC20(Currency.unwrap(owedCurrency)).transfer(address(_pm), owed);
        _pm.settle();
        return "";
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        returns (bytes4, int128)
    {
        (, BalanceDelta fees) = _pm.modifyLiquidity(key, ModifyLiquidityParams(_tickLower, _tickUpper, 0, 0), "");
        if (fees.amount0() > 0) _pm.take(key.currency0, address(this), uint128(fees.amount0()));
        if (fees.amount1() > 0) _pm.take(key.currency1, address(this), uint128(fees.amount1()));
        return (IHooks.afterSwap.selector, 0);
    }
}

/// @notice Test-only v4 caller that keeps bought T as ERC-6909 claims on the PoolManager (mode 0), redeems a user's
/// T claims to the user and then buys again inside the same unlock (mode 1), or only redeems (mode 2). Reviewer
/// probe of review round A (finding 5), ported.
contract ClaimsTrader is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager internal immutable _pm;

    constructor(IPoolManager pm_) {
        _pm = pm_;
    }

    function run(uint8 mode, PoolKey memory key, bool zeroForOne, address q, address t, uint256 qIn, uint256 redeem)
        external
    {
        _pm.unlock(abi.encode(mode, key, zeroForOne, q, t, qIn, redeem, msg.sender));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm), "only pm");
        (
            uint8 mode,
            PoolKey memory key,
            bool zeroForOne,
            address q,
            address t,
            uint256 qIn,
            uint256 redeem,
            address user
        ) = abi.decode(data, (uint8, PoolKey, bool, address, address, uint256, uint256, address));
        if (mode != 0) {
            // Redeem the user's T claims to the user as ERC-20 (PoolManager -> an eligible account).
            _pm.burn(user, uint256(uint160(t)), redeem);
            _pm.take(Currency.wrap(t), user, redeem);
            if (mode == 2) return "";
        }
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        _pm.swap(key, SwapParams(zeroForOne, -int256(qIn), limit), "");
        _pm.sync(Currency.wrap(q));
        pullToken(q, user, address(_pm), qIn);
        _pm.settle();
        int256 d = _pm.currencyDelta(address(this), Currency.wrap(t));
        _pm.mint(user, uint256(uint160(t)), uint256(d)); // keep the bought T as claims
        return "";
    }
}

/// @notice Quote assets (WETH-like, 6-decimal USDC-like, no-return USDT-like with its approval quirk, and FIT: a
/// Square Hole launch used as Q), the R = T claim converter, a Universal Router V4_SWAP action sequence (v4-periphery
/// V4Router), edge cases of fee realization, and the counter-example for take-based realization.
contract V4QuotesAndConverterTest is V4Fixture {
    using StateLibrary for IPoolManager;

    address internal fitWhale = makeAddr("fitWhale");
    address internal fit;

    function setUp() public {
        _deploySystem();
    }

    /// FIT has no mint: quote funding comes from a holder that bought FIT on its own pool.
    function _fundQuote(address q, address to, uint256 amount) internal override {
        if (q == fit && fit != address(0)) {
            vm.prank(fitWhale);
            MockERC20(q).transfer(to, amount);
        } else {
            super._fundQuote(q, to, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                              QUOTE ASSETS
    //////////////////////////////////////////////////////////////*/

    function test_usdcSixDecimals_fullCycle() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 10_000, 0, usdcTemplate, IRewardLedger.PayoutAsset.Q);
        _fullCycle(L, 250e6);
    }

    /// USDT-style Q: no return values, approve from non-zero reverts; routers and v4 handle it, Square Hole never
    /// touches its ERC-20 on the fee path.
    function test_usdtNoReturn_fullCycle() public {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, usdtTemplate, IRewardLedger.PayoutAsset.Q);
        _fullCycle(L, 400e6);
    }

    /// Issuer controls (blacklist, pause) can block payouts to a blocked address or while paused, but never fee
    /// events: the collector and ledger never hold the ERC-20. Entitlements survive and pay after the block lifts.
    function test_usdtBlacklistAndPause_neverBrickFeeEventsOrLoseClaims() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, usdtTemplate, IRewardLedger.PayoutAsset.Q);
        _buyIn(L, alice, 100e6);
        usdt.setBlackListed(address(L.collector), true);
        usdt.setBlackListed(address(L.ledger), true);
        _buyIn(L, bob, 100e6); // fee event with a blacklisted collector and ledger: unaffected
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0);
        usdt.setBlackListed(alice, true);
        vm.prank(alice);
        vm.expectRevert(); // the PoolManager cannot pay a blacklisted holder
        L.ledger.claim(alice);
        assertEq(L.ledger.claimable(alice), owed, "entitlement intact");
        usdt.setBlackListed(alice, false);
        usdt.setBlackListed(treasury, true);
        vm.expectRevert();
        L.collector.payProtocolQ();
        L.collector.burnPendingT(); // the T leg never depends on Q
        usdt.setBlackListed(treasury, false);
        usdt.setPaused(true);
        vm.prank(alice);
        vm.expectRevert();
        L.ledger.claim(alice);
        usdt.setPaused(false);
        vm.prank(alice);
        assertEq(L.ledger.claim(alice), owed);
        assertEq(usdt.balanceOf(alice), owed);
        L.collector.payProtocolQ();
        assertEq(usdt.balanceOf(treasury), L.collector.totalQToTreasury());
    }

    /// FIT, a Square Hole launch itself, as the quote asset of another launch (F08 quote list).
    function test_fitAsQuote_fullCycle() public {
        Launch memory F = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        fit = F.r.token;
        _buyIn(F, fitWhale, 0.5 ether);
        uint256 whaleFit = F.t.balanceOf(fitWhale);
        assertGt(whaleFit, 1e8 * 1e18, "the whale holds >10% of FIT");
        vm.prank(admin);
        uint32 fitTemplate = registry.addTemplate(fit, 1_000_000e18, 100e18, TICK_SPACING, RANGE_TICKS);
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 100, 0, fitTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(L.r.quote, fit);
        _fullCycle(L, 5_000_000e18);
        // FIT's own ledger: the X pool's FIT reserves and X's fee claims sit in the PoolManager (excluded).
        assertEq(F.ledger.claimable(address(pm)), 0);
        assertEq(F.ledger.claimable(address(L.collector)), 0);
        assertEq(F.ledger.claimable(address(L.ledger)), 0);
    }

    /// Buy, buy, sell, claim, process: shared assertions for any quote.
    function _fullCycle(Launch memory L, uint256 qIn) internal {
        uint256 tA = _buyIn(L, alice, qIn);
        _buyIn(L, bob, qIn / 2);
        _sellIn(L, alice, tA / 4);
        _buyIn(L, carol, qIn / 10);
        assertEq(L.collector.receiptCount(), 4);
        assertGt(L.collector.totalQReceived(), 0);
        assertGt(L.collector.totalTReceived(), 0);
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0);
        uint256 before = _balance(L.r.quote, alice);
        vm.prank(alice);
        L.ledger.claim(alice);
        assertEq(_balance(L.r.quote, alice) - before, owed);
        uint256 supply = L.t.totalSupply();
        uint256 pending = L.collector.pendingBurnT();
        L.collector.processFees();
        assertEq(L.t.totalSupply(), supply - pending);
        assertEq(_claimsOf(address(L.collector), L.r.quote), L.collector.qRemainder());
        assertGe(_claimsOf(address(L.ledger), L.r.quote), L.ledger.holderQOutstanding());
    }

    /*//////////////////////////////////////////////////////////////
                          R = T CLAIM CONVERTER
    //////////////////////////////////////////////////////////////*/

    function test_converter_claimAsT_paysTToTheHolder() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.T);
        assertEq(L.r.converter, address(converter));
        assertEq(L.ledger.converter(), address(converter));
        _buyIn(L, alice, 0.2 ether);
        _buyIn(L, bob, 0.3 ether);
        _buyIn(L, carol, 0.1 ether);
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0);
        vm.prank(alice);
        vm.expectRevert(RewardLedger.WrongPayoutAsset.selector);
        L.ledger.claim(alice);

        uint256 tBefore = L.t.balanceOf(alice);
        uint256 receipts = L.collector.receiptCount();
        uint256 claimedBefore = L.ledger.totalClaimed();
        uint256 holderQBefore = L.collector.totalQHolders();
        uint256 aliceShare = L.t.balanceOf(alice) * 1e18 / L.ledger.eligibleSupply();
        vm.prank(alice);
        (uint256 qIn, uint256 tOut) = converter.claimAsT(L.r.token, ALL, 1, block.timestamp);
        assertEq(qIn, owed, "exactly the entitlement");
        assertEq(L.ledger.totalClaimed() - claimedBefore, owed, "consumed once");
        assertEq(L.t.balanceOf(alice) - tBefore, tOut, "T straight to the holder");
        assertGt(tOut, 0);
        assertEq(L.collector.receiptCount(), receipts + 1, "the conversion paid the normal pool fee");
        // That fee is an ordinary fee event: alice, holding T before the payout arrived, earns her pro-rata share of
        // it like any holder; the payout T itself earns only from later events (spec 05).
        uint256 conversionHolderQ = L.collector.totalQHolders() - holderQBefore;
        assertApproxEqAbs(L.ledger.claimable(alice), conversionHolderQ * aliceShare / 1e18, 2);
        assertEq(_claimsOf(address(converter), L.r.quote), 0, "the converter keeps nothing");
        assertEq(L.t.balanceOf(address(converter)), 0);
        vm.prank(makeAddr("neverHeld"));
        vm.expectRevert(SquareHoleClaimConverter.NothingToClaim.selector);
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
    }

    /// ECO-07: a failed conversion (minimum output, deadline) leaves the entitlement intact.
    function test_converter_failuresLeaveTheClaimIntact() public {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.2 ether);
        _buyIn(L, bob, 0.2 ether);
        _buyIn(L, carol, 0.2 ether);
        uint256 owed = L.ledger.claimable(alice);
        vm.prank(alice);
        vm.expectPartialRevert(SquareHoleClaimConverter.InsufficientOutput.selector);
        converter.claimAsT(L.r.token, ALL, type(uint256).max, block.timestamp);
        assertEq(L.ledger.claimable(alice), owed);
        vm.warp(block.timestamp + 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.Expired.selector, block.timestamp - 1));
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp - 1);
        assertEq(L.ledger.claimable(alice), owed);
        // Only the caller's own entitlement: bob converting touches only bob's.
        uint256 bobOwed = L.ledger.claimable(bob);
        vm.prank(bob);
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
        assertGe(L.ledger.claimable(alice), owed, "alice untouched (plus her share of bob's conversion fee)");
        assertLt(L.ledger.claimable(bob), bobOwed, "bob's entitlement consumed (only his conversion-fee share left)");
        assertGt(bobOwed, 0);
    }

    function test_converter_rejectsNonPayoutTAndUnknownPairs() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.NotPayoutT.selector, L.r.token));
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.UnknownPair.selector, address(weth)));
        converter.claimAsT(address(weth), ALL, 0, block.timestamp);
        vm.prank(address(pm));
        vm.expectRevert(SquareHoleClaimConverter.NotPoolManager.selector);
        converter.unlockCallback("");
    }

    /// Review round A, finding 4: partial conversion and the sold-out Q fallback. Near sell-out the whole entitlement
    /// cannot fill (reverts, intact), a slice that fits converts and the rest stays intact; once the range is sold out
    /// no conversion can fill and the holder takes the rest in Q; the trigger follows the pool price both ways.
    function test_converter_partialConversionNearSellOut_thenQFallbackWhenSoldOut() public {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.5 ether);
        _fundQuote(address(weth), bob, 1_000 ether);
        (uint256 reservesT,) = _principal(L);
        _trade(L, bob, true, false, reservesT - 0.01e24); // leaves 10,000 T (about 0.01 WETH) in the range
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0.1 ether, "alice earned from bob's large buy");
        assertFalse(converter.isSoldOut(L.r.token));

        // The whole entitlement cannot fill: atomic revert, nothing consumed.
        vm.prank(alice);
        vm.expectPartialRevert(SquareHoleClaimConverter.PartialFill.selector);
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
        assertEq(L.ledger.claimable(alice), owed);
        // The Q fallback is closed while the pool still sells T.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.PoolNotSoldOut.selector, L.r.token));
        converter.claimAsQWhenSoldOut(L.r.token, ALL);

        // A slice that fits converts; the rest (plus alice's share of the slice's own fee) stays intact.
        uint256 slice = 0.005 ether;
        uint256 tBefore = L.t.balanceOf(alice);
        vm.prank(alice);
        (uint256 qIn, uint256 tOut) = converter.claimAsT(L.r.token, slice, 1, block.timestamp);
        assertEq(qIn, slice, "exactly the slice");
        assertEq(L.t.balanceOf(alice) - tBefore, tOut);
        assertGe(L.ledger.claimable(alice), owed - slice, "the rest is intact");
        assertEq(L.ledger.totalClaimed(), slice);

        // Bob buys the remaining T: the range is sold out; conversions cannot fill; the fallback opens.
        _buyIn(L, bob, 1 ether);
        (reservesT,) = _principal(L);
        assertEq(reservesT, 0);
        assertTrue(converter.isSoldOut(L.r.token));
        uint256 rest = L.ledger.claimable(alice);
        vm.prank(alice);
        vm.expectRevert(); // PartialFill or Pool.sol PriceLimitAlreadyExceeded: nothing to buy
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
        assertEq(L.ledger.claimable(alice), rest);
        uint256 qBefore = weth.balanceOf(alice);
        vm.prank(alice);
        vm.expectEmit(address(converter));
        emit SquareHoleClaimConverter.ClaimPaidInQSoldOut(L.r.token, alice, rest / 2);
        assertEq(converter.claimAsQWhenSoldOut(L.r.token, rest / 2), rest / 2, "a partial Q payout");
        vm.prank(alice);
        assertEq(converter.claimAsQWhenSoldOut(L.r.token, ALL), rest - rest / 2, "the rest in Q");
        assertEq(weth.balanceOf(alice) - qBefore, rest, "Q redeemed from the PoolManager to the holder");
        assertEq(L.ledger.claimable(alice), 0);
        assertEq(_claimsOf(address(converter), address(weth)), 0, "the converter keeps nothing");
        assertGe(_claimsOf(address(L.ledger), address(weth)), L.ledger.holderQOutstanding(), "ledger solvent");
        vm.prank(carol);
        vm.expectRevert(SquareHoleClaimConverter.NothingToClaim.selector);
        converter.claimAsQWhenSoldOut(L.r.token, ALL);

        // A sell brings T back into the range: the fallback closes again, conversions work again.
        _sellIn(L, bob, L.t.balanceOf(bob) / 10);
        assertFalse(converter.isSoldOut(L.r.token));
        _buyIn(L, carol, 0.001 ether);
        assertGt(L.ledger.claimable(bob), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.PoolNotSoldOut.selector, L.r.token));
        converter.claimAsQWhenSoldOut(L.r.token, ALL);
        vm.prank(bob);
        converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
    }

    /// The fallback serves only R = T launches wired to this converter; unknown tokens are never "sold out".
    function test_converter_fallbackRejectsNonPayoutTAndUnknownPairs() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.NotPayoutT.selector, L.r.token));
        converter.claimAsQWhenSoldOut(L.r.token, ALL);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.UnknownPair.selector, address(weth)));
        converter.claimAsQWhenSoldOut(address(weth), ALL);
        assertFalse(converter.isSoldOut(address(weth)));
        // Both token orders: the trigger reads the Q-only end of the range on the right side.
        for (uint256 i; i < 2; ++i) {
            address q = i == 0
                ? address(0x0000000000000000000000000000000000001000)
                : address(0xfFfffFFFfffFFfFFFFffFFFFffffFfFFFFff0000);
            deployCodeTo("MockTokens.sol:MockERC20", abi.encode("Q (test)", "Q"), q);
            vm.prank(admin);
            uint32 v = registry.addTemplate(q, 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
            Launch memory M = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, v, IRewardLedger.PayoutAsset.T);
            assertEq(M.tIsCurrency0, i == 1);
            assertFalse(converter.isSoldOut(M.r.token), "at launch the range is full of T");
            _buyIn(M, alice, 100 ether); // far more than the whole range costs
            assertTrue(converter.isSoldOut(M.r.token), "bought out");
        }
    }

    /// Partial conversion at the ledger boundary: `maxQIn` below the entitlement consumes exactly `maxQIn`.
    function test_converter_partialSliceConsumesExactlyTheSlice() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.2 ether);
        _buyIn(L, bob, 0.3 ether);
        uint256 owed = L.ledger.claimable(alice);
        vm.prank(alice);
        (uint256 qIn,) = converter.claimAsT(L.r.token, owed / 3, 0, block.timestamp);
        assertEq(qIn, owed / 3);
        assertEq(L.ledger.totalClaimed(), owed / 3);
        assertGe(L.ledger.claimable(alice), owed - owed / 3);
        vm.prank(alice);
        vm.expectRevert(SquareHoleClaimConverter.NothingToClaim.selector);
        converter.claimAsT(L.r.token, 0, 0, block.timestamp); // a zero slice converts nothing
    }

    /*//////////////////////////////////////////////////////////////
               UNIVERSAL ROUTER V4_SWAP ACTIONS (V4Router)
    //////////////////////////////////////////////////////////////*/

    /// The Universal Router's V4_SWAP command runs v4-periphery's V4Router actions: the swap (and its afterSwap fee
    /// event) always precedes SETTLE_ALL and TAKE_ALL, so ordinary buys and sells are clean fee events.
    function test_universalRouterActions_exactInAndExactOut() public {
        UniversalRouterLike ur = new UniversalRouterLike(pm);
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _buyIn(L, alice, 0.1 ether); // alice holds T from an earlier transaction
        uint256 aliceBefore = L.ledger.claimable(alice);
        _fundQuote(address(weth), bob, 1 ether);
        _approveExact(address(weth), bob, address(ur), 1 ether);
        bool zeroForOne = !L.tIsCurrency0; // buy
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, zeroForOne, 0.2 ether, 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(address(weth)), uint256(0.2 ether));
        params[2] = abi.encode(Currency.wrap(L.r.token), uint256(1));
        vm.prank(bob);
        ur.execute(abi.encode(actions, params));
        assertGt(L.t.balanceOf(bob), 0);
        assertEq(L.ledger.bootstrapQ(), 0, "clean fee event");
        assertGt(L.ledger.claimable(alice), aliceBefore, "indexed at the swap to the prior holder");
        assertEq(L.ledger.claimable(bob), 0);

        // Exact output: 3 whole NFTs to bob.
        uint256 unit = _unit(L);
        uint256 nftsBefore = _mirror(L).balanceOf(bob);
        actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        params[0] =
            abi.encode(IV4Router.ExactOutputSingleParams(L.key, zeroForOne, uint128(3 * unit), 0.5 ether, 0, ""));
        params[1] = abi.encode(Currency.wrap(address(weth)), uint256(0.5 ether));
        params[2] = abi.encode(Currency.wrap(L.r.token), uint256(3 * unit));
        _approveExact(address(weth), bob, address(ur), 0.5 ether);
        vm.prank(bob);
        ur.execute(abi.encode(actions, params));
        assertEq(_mirror(L).balanceOf(bob) - nftsBefore, 3, "exact-out delivers whole NFTs");
    }

    /*//////////////////////////////////////////////////////////////
           MULTI-HOP THROUGH FIT AND ERC-6909 (REVIEW ROUND A)
    //////////////////////////////////////////////////////////////*/

    Launch internal fitLaunch; // FIT: a Square Hole fungible launch on WETH
    Launch internal tOnFit; // T: a Square Hole collection quoted in FIT

    /// FIT on WETH, then a collection quoted in FIT; fitWhale holds FIT (and funds FIT), alice and carol hold T.
    function _setUpFitRoute() internal {
        fitLaunch = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        fit = fitLaunch.r.token;
        _buyIn(fitLaunch, fitWhale, 0.5 ether);
        _buyIn(fitLaunch, carol, 0.01 ether); // releases FIT's launch bootstrap to fitWhale
        vm.prank(admin);
        uint32 fitTemplate = registry.addTemplate(fit, 1_000_000e18, 100e18, TICK_SPACING, RANGE_TICKS);
        tOnFit = _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, fitTemplate, IRewardLedger.PayoutAsset.Q);
        _buyIn(tOnFit, alice, 50_000e18);
        _buyIn(tOnFit, carol, 1_000e18); // releases T's launch bootstrap to alice
    }

    /// Exact-input multi-hop through the V4Router engine (one V4_SWAP: both swaps, then SETTLE_ALL, TAKE_ALL).
    function _multiHopExactIn(
        UniversalRouterLike ur,
        address trader,
        address cin,
        address mid,
        address cout,
        uint256 amountIn
    ) internal {
        _approveExact(cin, trader, address(ur), amountIn);
        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey(Currency.wrap(mid), 30_000, TICK_SPACING, IHooks(address(hook)), "");
        path[1] = PathKey(Currency.wrap(cout), 30_000, TICK_SPACING, IHooks(address(hook)), "");
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // casting to 'uint128' is safe because test amounts are small
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] =
            abi.encode(IV4Router.ExactInputParams(Currency.wrap(cin), path, new uint256[](0), uint128(amountIn), 1));
        params[1] = abi.encode(Currency.wrap(cin), amountIn);
        params[2] = abi.encode(Currency.wrap(cout), uint256(1));
        vm.prank(trader);
        ur.execute(abi.encode(actions, params));
    }

    /// WETH → FIT → T in one V4_SWAP: two Square Hole fee events (FIT's pool in WETH, T's pool in FIT), each clean
    /// and indexed at its own swap to its own holders; the intermediate FIT never reaches the trader.
    function test_multiHop_buyThroughFit_twoCleanFeeEvents() public {
        _setUpFitRoute();
        UniversalRouterLike ur = new UniversalRouterLike(pm);
        uint256 fReceipts = fitLaunch.collector.receiptCount();
        uint256 tReceipts = tOnFit.collector.receiptCount();
        uint256 fHolderQ = fitLaunch.collector.totalQHolders();
        uint256 tHolderQ = tOnFit.collector.totalQHolders();
        uint256 aliceBefore = tOnFit.ledger.claimable(alice);
        uint256 carolBefore = tOnFit.ledger.claimable(carol);
        uint256 whaleBefore = fitLaunch.ledger.claimable(fitWhale);
        uint256 aliceT = tOnFit.t.balanceOf(alice);
        uint256 carolT = tOnFit.t.balanceOf(carol);
        _fundQuote(address(weth), bob, 0.01 ether);
        _multiHopExactIn(ur, bob, address(weth), fit, tOnFit.r.token, 0.01 ether);

        assertEq(fitLaunch.collector.receiptCount(), fReceipts + 1, "hop 1: one fee event on FIT's pool (in WETH)");
        assertEq(tOnFit.collector.receiptCount(), tReceipts + 1, "hop 2: one fee event on T's pool (in FIT)");
        assertEq(fitLaunch.ledger.bootstrapQ(), 0, "hop 1 clean");
        assertEq(tOnFit.ledger.bootstrapQ(), 0, "hop 2 clean");
        uint256 hop1 = fitLaunch.collector.totalQHolders() - fHolderQ;
        uint256 hop2 = tOnFit.collector.totalQHolders() - tHolderQ;
        assertGt(hop1, 0);
        assertGt(hop2, 0);
        assertGt(fitLaunch.ledger.claimable(fitWhale), whaleBefore, "FIT holders indexed at hop 1");
        assertApproxEqAbs(tOnFit.ledger.claimable(alice) - aliceBefore, hop2 * aliceT / (aliceT + carolT), 2);
        assertApproxEqAbs(tOnFit.ledger.claimable(carol) - carolBefore, hop2 * carolT / (aliceT + carolT), 2);
        assertEq(tOnFit.ledger.claimable(bob), 0, "the trader earns none of its own fees");
        assertEq(fitLaunch.ledger.claimable(bob), 0);
        assertEq(fitLaunch.t.balanceOf(bob), 0, "the intermediate FIT never reaches the trader");
        assertGt(tOnFit.t.balanceOf(bob), 0);
        assertEq(weth.balanceOf(bob), 0);
    }

    /// T → FIT → WETH: hop 1 is a T-only receipt (T fee, burned later), hop 2 a FIT-only receipt on FIT's pool.
    function test_multiHop_sellThroughFit_tOnlyReceipts() public {
        _setUpFitRoute();
        UniversalRouterLike ur = new UniversalRouterLike(pm);
        uint256 tIn = tOnFit.t.balanceOf(alice) / 2;
        uint256 tFeeT = tOnFit.collector.totalTReceived();
        uint256 tFeeQ = tOnFit.collector.totalQReceived();
        uint256 fFeeT = fitLaunch.collector.totalTReceived();
        uint256 fFeeQ = fitLaunch.collector.totalQReceived();
        uint256 fitBefore = fitLaunch.t.balanceOf(alice);
        _multiHopExactIn(ur, alice, tOnFit.r.token, fit, address(weth), tIn);
        assertApproxEqAbs(tOnFit.collector.totalTReceived() - tFeeT, tIn * 3 / 100, 2, "T fee: 3% of the T input");
        assertEq(tOnFit.collector.totalQReceived(), tFeeQ, "no Q from the T sell hop");
        assertGt(fitLaunch.collector.totalTReceived() - fFeeT, 0, "FIT fee (native) at the FIT/WETH hop");
        assertEq(fitLaunch.collector.totalQReceived(), fFeeQ, "no WETH from the FIT sell hop");
        assertEq(fitLaunch.t.balanceOf(alice), fitBefore, "the intermediate FIT never reaches the trader");
        assertGt(weth.balanceOf(alice), 0);
        assertEq(tOnFit.ledger.bootstrapQ(), 0);
        assertEq(fitLaunch.ledger.bootstrapQ(), 0);
    }

    /// Exact output through two hops: exactly k whole NFTs to an EOA; one receipt per hop.
    function test_multiHop_exactOut_kNftsThroughFit() public {
        _setUpFitRoute();
        UniversalRouterLike ur = new UniversalRouterLike(pm);
        uint256 fReceipts = fitLaunch.collector.receiptCount();
        uint256 tReceipts = tOnFit.collector.receiptCount();
        uint256 unit = _unit(tOnFit);
        _fundQuote(address(weth), bob, 1 ether);
        _approveExact(address(weth), bob, address(ur), 1 ether);
        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey(Currency.wrap(address(weth)), 30_000, TICK_SPACING, IHooks(address(hook)), "");
        path[1] = PathKey(Currency.wrap(fit), 30_000, TICK_SPACING, IHooks(address(hook)), "");
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactOutputParams(
                Currency.wrap(tOnFit.r.token), path, new uint256[](0), uint128(3 * unit), 1 ether
            )
        );
        params[1] = abi.encode(Currency.wrap(address(weth)), uint256(1 ether));
        params[2] = abi.encode(Currency.wrap(tOnFit.r.token), 3 * unit);
        vm.prank(bob);
        ur.execute(abi.encode(actions, params));
        assertEq(tOnFit.t.balanceOf(bob), 3 * unit);
        assertEq(_mirror(tOnFit).balanceOf(bob), 3, "3 NFTs through a two-hop exact-out");
        assertEq(tOnFit.collector.receiptCount(), tReceipts + 1);
        assertEq(fitLaunch.collector.receiptCount(), fReceipts + 1);
        assertEq(fitLaunch.t.balanceOf(bob), 0);
        assertEq(tOnFit.ledger.bootstrapQ(), 0);
        assertEq(fitLaunch.ledger.bootstrapQ(), 0);
    }

    /// T held as ERC-6909 claims on the PoolManager is excluded with the PoolManager (it earns nothing and does not
    /// dilute holders). Redeeming the claims counts as a pool outflow: a fee-bearing buy after it in the same
    /// transaction reverts (fail-closed); redeemed in its own transaction, the T is ordinary eligible T.
    function test_erc6909Holder_excludedThenRedeemIsCounted() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _buyIn(L, alice, 0.1 ether);
        _buyIn(L, carol, 0.001 ether);
        ClaimsTrader ct = new ClaimsTrader(pm);
        address holder = makeAddr("holder6909");
        _fundQuote(address(weth), holder, 1 ether);
        _approveExact(address(weth), holder, address(ct), 1 ether);
        vm.prank(holder);
        pm.setOperator(address(ct), true);
        bool buy0For1 = !L.tIsCurrency0;
        uint256 supply0 = L.ledger.eligibleSupply();
        uint256 receipts = L.collector.receiptCount();
        vm.prank(holder);
        ct.run(0, L.key, buy0For1, address(weth), L.r.token, 0.2 ether, 0);
        uint256 claims = _claimsOf(holder, L.r.token);
        assertGt(claims, 0, "T kept as ERC-6909 claims");
        assertEq(L.t.balanceOf(holder), 0);
        assertEq(L.ledger.eligibleSupply(), supply0, "claims-held T is not eligible");
        assertEq(L.collector.receiptCount(), receipts + 1, "the buy was a clean fee event");
        assertEq(L.ledger.bootstrapQ(), 0);
        _buyIn(L, carol, 0.05 ether); // a fee event while the holder has only claims
        assertEq(L.ledger.claimable(holder), 0, "an ERC-6909 holder earns nothing");

        // Redeem + buy in ONE unlock: the redemption is a pool outflow, so the buy's fee event reverts.
        vm.prank(holder);
        vm.expectRevert(_outflowRevert(claims));
        ct.run(1, L.key, buy0For1, address(weth), L.r.token, 0.05 ether, claims);
        assertEq(_claimsOf(holder, L.r.token), claims, "reverted as a whole");

        // Redeem alone (its own transaction), then a later fee event indexes the holder like any holder.
        vm.prank(holder);
        ct.run(2, L.key, buy0For1, address(weth), L.r.token, 0, claims);
        assertEq(L.t.balanceOf(holder), claims);
        assertEq(
            L.ledger.eligibleSupply(),
            L.t.balanceOf(alice) + L.t.balanceOf(carol) + claims,
            "redeemed T is eligible from now on"
        );
        uint256 holderQBefore = L.collector.totalQHolders();
        _buyIn(L, bob, 0.01 ether);
        uint256 share = L.collector.totalQHolders() - holderQBefore;
        uint256 s = L.ledger.eligibleSupply() - L.t.balanceOf(bob);
        assertApproxEqAbs(L.ledger.claimable(holder), share * claims / s, 2, "redeemed T earns from later events");
    }

    /*//////////////////////////////////////////////////////////////
                    FEE REALIZATION: CLAIMS VS TAKE
    //////////////////////////////////////////////////////////////*/

    /// The claims design works when the PoolManager holds none of the fee currency (first buy of a fresh Q) and
    /// when the pool's T reserves are nearly empty (a large sell after the range sold out).
    function test_claimsRealization_worksWithoutPoolManagerBalance() public {
        MockERC20 freshQ = new MockERC20("Fresh Q (test)", "FRQ");
        vm.prank(admin);
        uint32 v = registry.addTemplate(address(freshQ), 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, v, IRewardLedger.PayoutAsset.Q);
        assertEq(freshQ.balanceOf(address(pm)), 0, "the PoolManager holds no Q at the first buy's afterSwap");
        _buyIn(L, alice, 0.5 ether);
        assertGt(L.collector.totalQReceived(), 0, "fee realized as claims anyway");

        // Buy out the whole range (the swap stops at the range top), then sell a large amount back.
        _fundQuote(address(freshQ), bob, 1_000 ether);
        _trade(L, bob, true, true, 1_000 ether);
        (uint256 pt,) = _principal(L);
        assertLt(pt, 1e6, "T reserves (nearly) empty");
        uint256 tFeeBefore = L.collector.totalTReceived();
        _sellIn(L, bob, L.t.balanceOf(bob) / 2);
        assertGt(L.collector.totalTReceived() - tFeeBefore, 1e18, "a fee far above the pool's T reserves");
        L.collector.processFees();
        assertEq(L.t.totalSupply(), L.t.initialSupply() - L.collector.totalTBurned());
    }

    /// Counter-example: realizing the fee with `take` inside afterSwap reverts the first buy of a fresh-Q pool.
    function test_takeRealization_revertsFirstBuy_counterExample() public {
        MockERC20 tToken = new MockERC20("Probe T", "PT");
        MockERC20 qToken = new MockERC20("Probe Q", "PQ");
        address probeAddr = address(uint160((uint256(keccak256("take-probe")) >> 96 << 14) | Hooks.AFTER_SWAP_FLAG));
        deployCodeTo("V4QuotesAndConverter.t.sol:TakeRealizingProbeHook", abi.encode(pm), probeAddr);
        TakeRealizingProbeHook probe = TakeRealizingProbeHook(probeAddr);
        bool tIs0 = address(tToken) < address(qToken);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(tIs0 ? address(tToken) : address(qToken)),
            currency1: Currency.wrap(tIs0 ? address(qToken) : address(tToken)),
            fee: 30_000,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(probeAddr)
        });
        LaunchMath.LaunchPosition memory pos =
            LaunchMath.launchPosition(1_000e18, 1e18, RANGE_TICKS, TICK_SPACING, tIs0);
        tToken.mint(probeAddr, 1_000e18);
        probe.seed(key, pos.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity);

        qToken.mint(alice, 1 ether);
        _approveExact(address(qToken), alice, address(stepRouter), 1 ether);
        StepRouter.Step[] memory s = new StepRouter.Step[](3);
        s[0].op = StepRouter.Op.Swap;
        s[0].key = key;
        s[0].zeroForOne = !tIs0;
        s[0].amount = -0.1 ether;
        s[1] = _payStep(StepRouter.Op.SettleAll, address(qToken), alice, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, address(tToken), alice, 0);
        vm.expectRevert(); // PoolManager.take of Q the PoolManager does not hold yet (the buyer settles after)
        stepRouter.run(s);
    }
}
