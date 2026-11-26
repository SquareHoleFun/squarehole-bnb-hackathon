// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {TransientReentrancyGuard} from "../../src/libraries/TransientReentrancyGuard.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {ReentrantERC20} from "../utils/MockTokens.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

/// @notice A holder contract that rejects every callback (no receive, no fallback, no ERC-721 receiver): a conversion
/// must pay it T (and NFTs, once it opts in) without calling it back.
contract CallbackRejectingHolder {
    function optIntoNfts(address token) external {
        (bool ok,) = token.call(abi.encodeWithSignature("setSkipNFT(bool)", false));
        require(ok, "setSkipNFT");
    }

    function approve(address token, address spender, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        require(ok, "approve");
    }

    function convert(SquareHoleClaimConverter c, bytes32 pairId, uint256 minTOut) external returns (uint256 tOut) {
        (, tOut) = c.claimAsT(pairId, minTOut, block.timestamp);
    }

    fallback() external {
        revert("CallbackRejectingHolder: no callbacks");
    }
}

/// @notice Calls the converter from inside its own PoolManager unlock (a router or smart account that already
/// unlocked): the converter's own unlock must revert (`AlreadyUnlocked`), never nest.
contract NestedUnlockCaller is IUnlockCallback {
    IPoolManager internal immutable _pm;
    SquareHoleClaimConverter internal immutable _converter;

    constructor(IPoolManager pm_, SquareHoleClaimConverter converter_) {
        _pm = pm_;
        _converter = converter_;
    }

    function run(bytes32 pairId) external {
        _pm.unlock(abi.encode(pairId));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm), "only pm");
        _converter.claimAsT(abi.decode(data, (bytes32)), 0, block.timestamp);
        return "";
    }
}

/// @notice SH-B2 Build B item 6: `claimAsT(pairId, minTOut, deadline)` converts the caller's whole R = T entitlement
/// through the pair's canonical pool (fixed PoolKey from the registry), pays T to the caller, pays the normal pool fee
/// and reverts atomically otherwise (ECO-07). Revert paths, reentrancy, sandwich bounds through `minTOut`, and the
/// exact attribution of the conversion's own fee (ECO-02, ECO-05, ECO-09, ECO-14, ECO-16).
contract V4ClaimConverterTest is V4Fixture {
    uint256 internal constant INDEX_SCALE = 1e36;

    function setUp() public {
        _deploySystem();
    }

    /// Alice (0.2), bob (0.3) and carol (0.1 WETH) buy in turn; alice and bob earn from the later buys.
    function _launchWithHolders(SquareHoleRegistry.AssetKind kind, uint256 units, uint256 r)
        internal
        returns (Launch memory L)
    {
        L = _launch(kind, units, r, wethTemplate, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.2 ether);
        _buyIn(L, bob, 0.3 ether);
        _buyIn(L, carol, 0.1 ether);
    }

    struct Snapshot {
        uint256 claimable;
        uint256 totalClaimed;
        uint256 ledgerQClaims;
        uint256 converterQClaims;
        uint256 receipts;
        uint256 tBalance;
    }

    function _snap(Launch memory L, address holder) internal view returns (Snapshot memory s) {
        s.claimable = L.ledger.claimable(holder);
        s.totalClaimed = L.ledger.totalClaimed();
        s.ledgerQClaims = _claimsOf(address(L.ledger), L.r.quote);
        s.converterQClaims = _claimsOf(address(converter), L.r.quote);
        s.receipts = L.collector.receiptCount();
        s.tBalance = L.t.balanceOf(holder);
    }

    function _assertIntact(Launch memory L, address holder, Snapshot memory s) internal view {
        assertEq(L.ledger.claimable(holder), s.claimable, "entitlement intact");
        assertEq(L.ledger.totalClaimed(), s.totalClaimed, "nothing consumed");
        assertEq(_claimsOf(address(L.ledger), L.r.quote), s.ledgerQClaims, "ledger claims untouched");
        assertEq(_claimsOf(address(converter), L.r.quote), 0, "converter holds nothing");
        assertEq(L.collector.receiptCount(), s.receipts, "no fee event happened");
        assertEq(L.t.balanceOf(holder), s.tBalance, "no T paid");
    }

    /*//////////////////////////////////////////////////////////////
                         HAPPY PATH (BY PAIR ID)
    //////////////////////////////////////////////////////////////*/

    function test_claimAsTByPairId_convertsTheWholeEntitlementOnce() public {
        Launch memory L = _launchWithHolders(SquareHoleRegistry.AssetKind.Collection, 1_000, 0);
        Snapshot memory s = _snap(L, alice);
        assertGt(s.claimable, 0);

        vm.expectEmit(true, true, false, false, address(converter));
        emit SquareHoleClaimConverter.ClaimConverted(L.r.token, alice, s.claimable, 0);
        vm.prank(alice);
        (uint256 qIn, uint256 tOut) = converter.claimAsT(L.pairId, 1, block.timestamp);

        assertEq(qIn, s.claimable, "exactly the whole entitlement");
        assertEq(L.ledger.totalClaimed() - s.totalClaimed, qIn, "consumed once");
        assertEq(L.t.balanceOf(alice) - s.tBalance, tOut, "T straight to the caller");
        assertGt(tOut, 0);
        assertEq(L.collector.receiptCount(), s.receipts + 1, "one ordinary fee event: the conversion's own swap");
        assertEq(_claimsOf(address(converter), L.r.quote), 0, "the converter keeps no Q claims");
        assertEq(_claimsOf(address(converter), L.r.token), 0, "the converter keeps no T claims");
        assertEq(L.t.balanceOf(address(converter)), 0, "the converter keeps no T");
        assertEq(L.ledger.poolNetOutflow(), 0, "transient outflow cleared after the transaction");
        // What is left is only alice's share of her own conversion's fee (she held T before the payout arrived).
        assertLt(L.ledger.claimable(alice), qIn / 30, "only the fee share of the conversion remains");
        // The same entry point converts that remainder later; a holder with nothing gets NothingToClaim.
        vm.prank(makeAddr("neverHeld"));
        vm.expectRevert(SquareHoleClaimConverter.NothingToClaim.selector);
        converter.claimAsT(L.pairId, 0, block.timestamp);
    }

    /// The pair-id and the token entry points settle identically (same pool, same fee, same payout).
    function test_claimAsTByPairId_matchesTheTokenEntryPoint() public {
        Launch memory L = _launchWithHolders(SquareHoleRegistry.AssetKind.Token, 1e9, 1);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (uint256 qA, uint256 tA) = converter.claimAsT(L.pairId, 0, block.timestamp);
        vm.revertToState(snap);
        vm.prank(alice);
        (uint256 qB, uint256 tB) = converter.claimAsT(L.r.token, ALL, 0, block.timestamp);
        assertEq(qA, qB);
        assertEq(tA, tB);
    }

    /*//////////////////////////////////////////////////////////////
                      REVERT PATHS (ECO-07: INTACT)
    //////////////////////////////////////////////////////////////*/

    function test_claimAsTByPairId_revertPathsLeaveTheEntitlementIntact() public {
        Launch memory L = _launchWithHolders(SquareHoleRegistry.AssetKind.Token, 1e9, 1);
        Launch memory Q =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        Snapshot memory s = _snap(L, alice);

        // Unknown pair id (e.g. a pair id of another chain, or of a token that was never launched here).
        bytes32 foreign = keccak256(abi.encode(uint256(1), L.r.token));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.UnknownPairId.selector, foreign));
        converter.claimAsT(foreign, 0, block.timestamp);
        _assertIntact(L, alice, s);

        // An R = Q launch: never converted (ECO-04).
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.NotPayoutT.selector, Q.r.token));
        converter.claimAsT(Q.pairId, 0, block.timestamp);

        // Deadline passed.
        vm.warp(block.timestamp + 100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SquareHoleClaimConverter.Expired.selector, block.timestamp - 1));
        converter.claimAsT(L.pairId, 0, block.timestamp - 1);
        _assertIntact(L, alice, s);

        // Output below the caller's minimum.
        vm.prank(alice);
        vm.expectPartialRevert(SquareHoleClaimConverter.InsufficientOutput.selector);
        converter.claimAsT(L.pairId, type(uint256).max, block.timestamp);
        _assertIntact(L, alice, s);

        // A caller without an entitlement (the converter never consumes anyone else's).
        vm.prank(makeAddr("neverHeld"));
        vm.expectRevert(SquareHoleClaimConverter.NothingToClaim.selector);
        converter.claimAsT(L.pairId, 0, block.timestamp);
        _assertIntact(L, alice, s);

        // Near sell-out the whole entitlement cannot fill: PartialFill, atomic.
        _fundQuote(address(weth), carol, 1_000 ether);
        (uint256 reservesT,) = _principal(L);
        _trade(L, carol, true, false, reservesT - 0.01e18);
        s = _snap(L, alice);
        assertGt(s.claimable, 0.02 ether);
        vm.prank(alice);
        vm.expectPartialRevert(SquareHoleClaimConverter.PartialFill.selector);
        converter.claimAsT(L.pairId, 0, block.timestamp);
        _assertIntact(L, alice, s);

        // Sold out: no conversion can fill; the entitlement waits (or takes the published Q fallback).
        _buyIn(L, carol, 1 ether);
        assertTrue(converter.isSoldOut(L.r.token));
        s = _snap(L, alice);
        vm.prank(alice);
        vm.expectRevert();
        converter.claimAsT(L.pairId, 0, block.timestamp);
        _assertIntact(L, alice, s);
        vm.prank(alice);
        assertEq(converter.claimAsQWhenSoldOut(L.r.token, ALL), s.claimable, "fallback pays the same entitlement");
    }

    /*//////////////////////////////////////////////////////////////
                               REENTRANCY
    //////////////////////////////////////////////////////////////*/

    /// A caller that already holds a PoolManager unlock (a router, a smart account bundle) cannot run a conversion
    /// inside it: the converter opens its own unlock, which v4 refuses; the entitlement is untouched.
    function test_converter_reentrancy_insideAnotherUnlockReverts() public {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.T);
        NestedUnlockCaller nested = new NestedUnlockCaller(pm, converter);
        _buyIn(L, address(nested), 0.2 ether);
        _buyIn(L, bob, 0.2 ether);
        Snapshot memory s = _snap(L, address(nested));
        assertGt(s.claimable, 0);
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        nested.run(L.pairId);
        _assertIntact(L, address(nested), s);
    }

    /// The unlock callback is accepted only from the PoolManager while the converter's own guarded call runs.
    function test_converter_reentrancy_callbackOnlyInsideTheGuardedCall() public {
        Launch memory L = _launchWithHolders(SquareHoleRegistry.AssetKind.Token, 1e9, 1);
        bytes memory forged = abi.encode(uint8(0), alice, ALL, uint256(0), registry.pair(L.pairId));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(SquareHoleClaimConverter.NotPoolManager.selector);
        converter.unlockCallback(forged);
        vm.prank(address(pm)); // even the PoolManager, outside the converter's own unlock
        vm.expectRevert(SquareHoleClaimConverter.NotPoolManager.selector);
        converter.unlockCallback(forged);
    }

    /// A hostile quote token whose transfer calls back into the converter (the fallback's take pays Q through the
    /// token's own code): every re-entry hits the converter's lock or the ledger's role check, and the outer
    /// settlement completes exactly once.
    function test_converter_reentrancy_hostileQuoteCannotReenter() public {
        ReentrantERC20 q = new ReentrantERC20();
        vm.prank(admin);
        uint32 v = registry.addTemplate(address(q), 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, v, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.5 ether);
        _buyIn(L, bob, 100 ether); // buys the whole range: sold out, alice earned from bob's buy
        assertTrue(converter.isSoldOut(L.r.token));
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0);

        bytes[3] memory reentries = [
            abi.encodeWithSignature("claimAsQWhenSoldOut(address,uint256)", L.r.token, ALL),
            abi.encodeWithSignature("claimAsT(bytes32,uint256,uint256)", L.pairId, uint256(0), block.timestamp),
            abi.encodeWithSignature(
                "claimAsT(address,uint256,uint256,uint256)", L.r.token, ALL, uint256(0), block.timestamp
            )
        ];
        uint256 paid;
        for (uint256 i; i < reentries.length; ++i) {
            q.arm(address(converter), reentries[i]);
            uint256 before = q.balanceOf(alice);
            vm.prank(alice);
            uint256 slice = converter.claimAsQWhenSoldOut(L.r.token, owed / 4);
            paid += slice;
            assertEq(q.balanceOf(alice) - before, slice, "the outer settlement paid exactly its slice");
            assertFalse(q.lastCallSucceeded(), "the re-entry failed");
            assertEq(bytes4(q.lastRevertData()), TransientReentrancyGuard.Reentrancy.selector, "blocked by the lock");
        }
        // The ledger refuses anyone but the converter (the hostile token calling claimFor directly).
        q.arm(address(L.ledger), abi.encodeCall(RewardLedger.claimFor, (alice, ALL)));
        vm.prank(alice);
        paid += converter.claimAsQWhenSoldOut(L.r.token, ALL);
        assertFalse(q.lastCallSucceeded());
        assertEq(bytes4(q.lastRevertData()), RewardLedger.NotConverter.selector);
        assertEq(paid, owed, "the entitlement was consumed exactly once in total");
        assertEq(L.ledger.claimable(alice), 0);
        assertEq(_claimsOf(address(converter), address(q)), 0);
    }

    /// No callback reaches the holder: a contract that rejects every call still receives its T and NFTs.
    function test_converter_paysACallbackRejectingContractWithoutCallingIt() public {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.T);
        CallbackRejectingHolder holder = new CallbackRejectingHolder();
        holder.optIntoNfts(L.r.token);
        _buyIn(L, address(holder), 0.3 ether);
        _buyIn(L, bob, 0.5 ether);
        _buyIn(L, carol, 0.5 ether);
        uint256 nftsBefore = _mirror(L).balanceOf(address(holder));
        uint256 tBefore = L.t.balanceOf(address(holder));
        uint256 tOut = holder.convert(converter, L.pairId, 1);
        assertEq(L.t.balanceOf(address(holder)) - tBefore, tOut);
        assertEq(
            _mirror(L).balanceOf(address(holder)), L.t.balanceOf(address(holder)) / _unit(L), "NFTs follow the balance"
        );
        assertGe(_mirror(L).balanceOf(address(holder)), nftsBefore);
    }

    /*//////////////////////////////////////////////////////////////
                      SANDWICH AND PRICE IMPACT
    //////////////////////////////////////////////////////////////*/

    /// Quote the conversion in a snapshot (what an app does with an eth_call), set `minTOut` 0.5% below it: a
    /// front-run that moves the price further makes the conversion revert with the entitlement intact; a smaller
    /// one is absorbed within the tolerance; without a minimum the holder is exposed.
    function test_converter_sandwich_minTOutBoundsTheLoss() public {
        Launch memory L = _launchWithHolders(SquareHoleRegistry.AssetKind.Collection, 1_000, 0);
        _buyIn(L, bob, 1 ether); // alice's entitlement grows to a size worth sandwiching
        address mev = makeAddr("mev");
        uint256 deadline = block.timestamp;

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (uint256 qIn, uint256 quoted) = converter.claimAsT(L.pairId, 0, deadline);
        vm.revertToState(snap);
        uint256 minOut = quoted * 995 / 1000;
        emit log_named_uint("entitlement converted (raw Q)", qIn);
        emit log_named_uint("quoted T out (raw)", quoted);

        // A: a large front-run (1 WETH) moves the price well beyond 0.5%: the conversion reverts, intact.
        snap = vm.snapshotState();
        Snapshot memory s = _snap(L, alice);
        uint256 frontT = _buyIn(L, mev, 1 ether);
        s.receipts = L.collector.receiptCount();
        s.claimable = L.ledger.claimable(alice); // alice earned her share of mev's buy fee
        s.ledgerQClaims = _claimsOf(address(L.ledger), L.r.quote);
        vm.prank(alice);
        vm.expectPartialRevert(SquareHoleClaimConverter.InsufficientOutput.selector);
        converter.claimAsT(L.pairId, minOut, deadline);
        _assertIntact(L, alice, s);
        uint256 back = _sellIn(L, mev, frontT);
        emit log_named_uint("A: mev round trip WETH in", 1 ether);
        emit log_named_uint("A: mev round trip WETH out (victim protected)", back);
        assertLt(back, 1 ether, "the failed sandwich costs the attacker both 3% fees");
        vm.revertToState(snap);

        // B: a small front-run (0.001 WETH) stays inside the tolerance: the conversion fills at or above minOut.
        snap = vm.snapshotState();
        _buyIn(L, mev, 0.001 ether);
        vm.prank(alice);
        (, uint256 tOutB) = converter.claimAsT(L.pairId, minOut, deadline);
        assertGe(tOutB, minOut, "never below the signed minimum");
        assertLe(tOutB, quoted, "a front-run never improves the fill");
        emit log_named_uint("B: T out with a small front-run (>= minOut)", tOutB);
        vm.revertToState(snap);

        // C: without a minimum the same large front-run takes a real share of the conversion.
        frontT = _buyIn(L, mev, 1 ether);
        vm.prank(alice);
        (, uint256 tOutC) = converter.claimAsT(L.pairId, 0, deadline);
        back = _sellIn(L, mev, frontT);
        uint256 lossBps = (quoted - tOutC) * 10_000 / quoted;
        emit log_named_uint("C: T out with minTOut = 0", tOutC);
        emit log_named_uint("C: holder loss vs quote (bps)", lossBps);
        emit log_named_uint("C: mev round trip WETH out for 1 WETH in", back);
        assertGt(lossBps, 50, "an unprotected conversion loses more than the 0.5% tolerance");
    }

    /// Property: whatever the front-run, the holder either gets at least `minTOut` or keeps the entitlement.
    /// forge-config: default.fuzz.runs = 48
    /// forge-config: deep.fuzz.runs = 256
    function testFuzz_converter_frontRunNeverBreachesMinOut(uint256 frontRunWei, uint256 toleranceBps) public {
        frontRunWei = bound(frontRunWei, 0, 3 ether);
        toleranceBps = bound(toleranceBps, 0, 500);
        Launch memory L = _launchWithHolders(SquareHoleRegistry.AssetKind.Token, 1e9, 1);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        (, uint256 quoted) = converter.claimAsT(L.pairId, 0, block.timestamp);
        vm.revertToState(snap);
        uint256 minOut = quoted * (10_000 - toleranceBps) / 10_000;
        if (frontRunWei != 0) _buyIn(L, makeAddr("mev"), frontRunWei);
        Snapshot memory s = _snap(L, alice);
        vm.prank(alice);
        try converter.claimAsT(L.pairId, minOut, block.timestamp) returns (uint256, uint256 tOut) {
            assertGe(tOut, minOut);
        } catch (bytes memory reason) {
            // Either the minimum or, near sell-out, a partial fill; never a silent loss.
            bytes4 sel = bytes4(reason);
            assertTrue(
                sel == SquareHoleClaimConverter.InsufficientOutput.selector
                    || sel == SquareHoleClaimConverter.PartialFill.selector,
                "only minOut or partial-fill reverts"
            );
            _assertIntact(L, alice, s);
        }
    }

    /*//////////////////////////////////////////////////////////////
                  THE CONVERSION'S OWN FEE (ATTRIBUTION)
    //////////////////////////////////////////////////////////////*/

    struct FeeState {
        uint256 receipts;
        uint256 qReceived;
        uint256 tReceived;
        uint256 pendingBurnT;
        uint256 protocolQPending;
        uint256 qRemainder;
        uint256 qHolders;
        uint256 index;
        uint256 eligible;
        uint256 qGrowth;
        uint256 supply;
        uint256 bootstrap;
    }

    function _fees(Launch memory L) internal view returns (FeeState memory f) {
        f.receipts = L.collector.receiptCount();
        f.qReceived = L.collector.totalQReceived();
        f.tReceived = L.collector.totalTReceived();
        f.pendingBurnT = L.collector.pendingBurnT();
        f.protocolQPending = L.collector.protocolQPending();
        f.qRemainder = L.collector.qRemainder();
        f.qHolders = L.collector.totalQHolders();
        f.index = L.ledger.rewardIndex();
        f.eligible = L.ledger.eligibleSupply();
        (, f.qGrowth) = _feeGrowthInside(L);
        f.supply = L.t.totalSupply();
        f.bootstrap = L.ledger.bootstrapQ();
    }

    /// The conversion's 3% fee is an ordinary buy fee event: realized in Q, exactly reconciled with Pool.sol, split
    /// 1:2, indexed at the swap to the holders by their PRE-conversion balances (the converting holder included,
    /// its payout T excluded), never a T fee, never burned (ECO-02), and paid only out of the converted entitlement
    /// (ECO-14). Both token orders.
    function test_converter_ownFeeIsAttributedExactly_bothOrders() public {
        for (uint256 i; i < 2; ++i) {
            address q = i == 0
                ? address(0x0000000000000000000000000000000000001000)
                : address(0xfFfffFFFfffFFfFFFFffFFFFffffFfFFFFff0000);
            deployCodeTo("MockTokens.sol:MockERC20", abi.encode("Q (test)", "Q"), q);
            vm.prank(admin);
            uint32 v = registry.addTemplate(q, 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
            Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, v, IRewardLedger.PayoutAsset.T);
            assertEq(L.tIsCurrency0, i == 1);
            _buyIn(L, alice, 0.3 ether);
            _buyIn(L, bob, 0.2 ether);
            _buyIn(L, carol, 0.1 ether);
            _sellIn(L, carol, L.t.balanceOf(carol) / 3); // a pending T fee to burn later
            _assertOwnFeeAttribution(L);
        }
    }

    struct Holders {
        uint256 a;
        uint256 b;
        uint256 c;
        uint256 bobBefore;
        uint256 carolBefore;
        uint256 qIn;
        uint256 tOut;
    }

    function _assertOwnFeeAttribution(Launch memory L) internal {
        Holders memory h;
        h.a = L.t.balanceOf(alice);
        h.b = L.t.balanceOf(bob);
        h.c = L.t.balanceOf(carol);
        h.bobBefore = L.ledger.claimable(bob);
        h.carolBefore = L.ledger.claimable(carol);
        FeeState memory f0 = _fees(L);
        assertEq(f0.bootstrap, 0);

        vm.prank(alice);
        (h.qIn, h.tOut) = converter.claimAsT(L.pairId, 1, block.timestamp);
        FeeState memory f1 = _fees(L);

        _assertReceiptAndSplit(L, f0, f1, h.qIn);
        _assertIndexing(L, f0, f1, h);
        // Processing burns only the earlier sell fee; alice's payout T is untouched.
        uint256 aliceT = L.t.balanceOf(alice);
        (uint256 burned,) = L.collector.processFees();
        assertEq(burned, f0.pendingBurnT, "only native fee T is burned");
        assertEq(L.t.totalSupply(), f1.supply - burned);
        assertEq(L.t.balanceOf(alice), aliceT, "payout T is never burned");
    }

    /// One fee event, Q only (a conversion is a buy): no T fee, nothing added to the burn inventory (ECO-02); exactly
    /// Pool.sol's fee growth of this swap, 3% of the converted Q (protocol fee 0) within 2 wei; the 1:2 split.
    function _assertReceiptAndSplit(Launch memory L, FeeState memory f0, FeeState memory f1, uint256 qIn)
        internal
        pure
    {
        assertEq(f1.receipts, f0.receipts + 1, "one receipt");
        assertEq(f1.tReceived, f0.tReceived, "no T fee");
        assertEq(f1.pendingBurnT, f0.pendingBurnT, "payout T never enters the burn inventory");
        uint256 qFee = f1.qReceived - f0.qReceived;
        assertEq(qFee, FullMath.mulDiv(f1.qGrowth - f0.qGrowth, L.r.liquidity, Q128), "reconciled with fee growth");
        assertApproxEqAbs(qFee, qIn * 3 / 100, 2, "3% of the converted slice");
        uint256 splittable = qFee + f0.qRemainder;
        assertEq(f1.protocolQPending - f0.protocolQPending, splittable / 3, "protocol third");
        assertEq(f1.qHolders - f0.qHolders, 2 * (splittable / 3), "holder two thirds");
        assertEq(f1.qRemainder, splittable % 3, "remainder carried");
    }

    /// Indexed at the swap over the PRE-conversion eligible supply; the payout T joins it only afterwards. Alice's
    /// whole entitlement was consumed; she earns her share of her own conversion fee on her pre-conversion balance
    /// only (the bought T earns from later events). The fee came only out of the converted entitlement (ECO-14).
    function _assertIndexing(Launch memory L, FeeState memory f0, FeeState memory f1, Holders memory h) internal view {
        uint256 holderQ = f1.qHolders - f0.qHolders;
        uint256 dI = f1.index - f0.index;
        assertApproxEqAbs(dI, holderQ * INDEX_SCALE / f0.eligible, 1, "index step over the pre-conversion supply");
        assertEq(f1.eligible, f0.eligible + h.tOut, "payout T becomes eligible after the event");
        assertApproxEqAbs(L.ledger.claimable(bob) - h.bobBefore, h.b * dI / INDEX_SCALE, 1, "bob pro rata");
        assertApproxEqAbs(L.ledger.claimable(carol) - h.carolBefore, h.c * dI / INDEX_SCALE, 1, "carol pro rata");
        assertApproxEqAbs(L.ledger.claimable(alice), h.a * dI / INDEX_SCALE, 1, "alice: pre-conversion balance only");
        assertLt(h.a * dI / INDEX_SCALE, (h.a + h.tOut) * dI / INDEX_SCALE, "the payout T would have earned more");
    }
}
