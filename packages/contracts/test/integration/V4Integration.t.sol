// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IFeeCollector} from "../../src/interfaces/IFeeCollector.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {SameTransaction} from "../utils/SameTransaction.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";
import {StepRouter, UniversalRouterLike} from "../utils/v4/Routers.sol";

/// @notice End-to-end tests of Square Hole on a real Uniswap v4 PoolManager (compiled from the pinned source; local
/// only): launches of both templates, buys and sells (exact in/out) through PoolSwapTest and a Universal-Router-order
/// step router, whole-NFT delivery, batched swaps, the flash take → swap → settle sequence, blocked donations and
/// foreign liquidity, exact fee reconciliation against Pool.sol fee growth, burns, claims, exclusions and both token
/// orders.
contract V4IntegrationTest is V4Fixture {
    using StateLibrary for IPoolManager;

    uint256 internal constant Q = 1e18;

    function setUp() public {
        _deploySystem();
    }

    /*//////////////////////////////////////////////////////////////
                           LAUNCH AND POOL STATE
    //////////////////////////////////////////////////////////////*/

    function test_launch_seedsWholeSupplySingleSidedLocked_bothTemplates() public {
        for (uint256 k; k < 2; ++k) {
            SquareHoleRegistry.AssetKind kind =
                k == 0 ? SquareHoleRegistry.AssetKind.Collection : SquareHoleRegistry.AssetKind.Token;
            uint256 r = k == 0 ? 0 : 1;
            uint256 units = k == 0 ? 10_000 : 1e9;
            Launch memory L = _launch(kind, units, r, wethTemplate, IRewardLedger.PayoutAsset.Q);
            uint256 supply = 1e27; // F10: every launch has exactly 1,000,000,000 tokens
            assertEq(L.t.initialSupply(), supply);
            assertEq(L.t.totalSupply(), supply);
            // Whole supply in the pool (minus liquidity rounding dust kept by the hook, an excluded role).
            uint256 dust = L.t.balanceOf(address(hook));
            assertLt(dust, 1e9, "rounding dust only");
            assertEq(L.t.balanceOf(address(pm)), supply - dust, "the pool holds the supply");
            assertEq(_balance(address(weth), address(pm)), 0, "no first buy: no Q anywhere");
            assertEq(L.t.balanceOf(creator), 0, "the creator receives nothing");
            assertEq(L.t.balanceOf(address(launcher)), 0);
            assertEq(L.ledger.eligibleSupply(), 0);
            // Price and position exactly as recorded.
            (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) = pm.getSlot0(L.id);
            assertEq(sqrtP, L.r.sqrtPriceX96);
            assertEq(lpFee, 30_000, "static 3% LP fee");
            assertEq(protocolFee, 0);
            assertEq(_positionLiquidity(L), L.r.liquidity, "the protocol-owned position");
            (uint256 pt, uint256 pq) = _principal(L);
            assertEq(pq, 0, "single-sided T");
            assertEq(pt, supply - dust);
            if (L.tIsCurrency0) assertEq(tick, L.r.tickLower);
            else assertEq(tick, L.r.tickUpper);
        }
    }

    /// N = 1,024 divides 1e27 but not 1e9: one NFT is 976,562.5 tokens, so the record's fractionsPerNft is 0 and the
    /// unit is initialSupply / units (F10).
    function test_launch_recordsEveryIdentity() public {
        vm.recordLogs();
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_024, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        SquareHoleRegistry.PairRecord memory r = L.r;
        assertEq(r.chainId, block.chainid);
        assertEq(r.pairId, keccak256(abi.encode(block.chainid, r.token)));
        assertEq(registry.pairIdOf(r.token), r.pairId);
        assertEq(r.mirror, _collection(L).mirrorERC721());
        assertEq(r.ledger, _collection(L).rewardLedger());
        assertEq(r.collector, _collection(L).feeCollector());
        assertEq(r.hook, address(hook));
        assertEq(r.poolId, keccak256(abi.encode(L.key)));
        assertEq(r.quote, address(weth));
        assertEq(r.rewardSide, 0);
        assertEq(r.converter, address(0));
        assertEq(r.fractionsPerNft, 0, "976,562.5 tokens per NFT is not a whole number");
        assertEq(r.units, 1_024);
        assertEq(r.initialSupply, 1e27);
        assertEq(_collection(L).unit(), 976_562.5e18, "1e27 / 1,024, exact");
        assertEq(_unit(L) * r.units, r.initialSupply);
        assertEq(r.templateVersion, wethTemplate);
        assertEq(r.startFdvQ, WETH_START_FDV);
        assertEq(r.minStartUnitValueQ, WETH_MIN_UNIT_VALUE);
        assertEq(r.metadataManifestHash, keccak256(abi.encode("manifest", r.kind, uint256(1_024), uint256(0))));
        assertEq(r.creator, creator);
        assertEq(registry.pairCount(), 1);
        // The ledger's roles are the system's roles.
        assertEq(L.ledger.poolManager(), address(pm));
        assertEq(L.ledger.hook(), address(hook));
        assertEq(L.ledger.launcher(), address(launcher));
        assertEq(L.ledger.treasury(), treasury);
        assertEq(L.collector.feeSource(), address(hook));
        // PairCreated carries the same record.
        bytes32 sig = keccak256(
            "PairCreated(bytes32,address,address,(uint256,bytes32,uint8,address,address,address,address,address,bytes32,address,uint8,address,uint256,uint256,uint256,uint32,uint256,uint256,int24,int24,int24,uint128,uint160,bytes32,address,uint64))"
        );
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == sig) {
                found = true;
                assertEq(logs[i].topics[1], r.pairId);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), r.token);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), r.quote);
                SquareHoleRegistry.PairRecord memory e = abi.decode(logs[i].data, (SquareHoleRegistry.PairRecord));
                assertEq(keccak256(abi.encode(e)), keccak256(abi.encode(r)), "event == stored record");
            }
        }
        assertTrue(found, "PairCreated emitted");
    }

    /*//////////////////////////////////////////////////////////////
                  BUYS AND SELLS, EXACT IN / EXACT OUT
    //////////////////////////////////////////////////////////////*/

    /// A buy pays its 3% LP fee in Q; the fee is indexed to holders AT the swap (the buyer earns none of it).
    function test_buyExactIn_feeInQ_indexedAtTheSwap() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.1 ether); // alice: first holder (her own buy's holder share waits in bootstrap)
        uint256 bootstrap = L.ledger.bootstrapQ();
        assertGt(bootstrap, 0, "first buy: nobody eligible yet");
        uint256 qFeeBefore = L.collector.totalQReceived();
        uint256 tOut = _buyIn(L, bob, 0.3 ether);
        uint256 qFee = L.collector.totalQReceived() - qFeeBefore;
        assertApproxEqAbs(qFee, 0.3 ether * 3 / 100, 2, "3% of the input");
        assertEq(L.collector.receiptCount(), 2, "one receipt per swap");
        uint256 holderShare = qFee / 3 * 2;
        assertApproxEqAbs(L.ledger.claimable(alice), bootstrap + holderShare, 2, "alice held all eligible T");
        assertEq(L.ledger.claimable(bob), 0, "a buyer never earns its own buy's fee");
        assertGt(tOut, 0);
    }

    function test_sellExactIn_feeInT_burnedWithSupplyReconciled() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        uint256 tOut = _buyIn(L, alice, 0.5 ether);
        uint256 supply = L.t.totalSupply();
        _sellIn(L, alice, tOut / 2);
        uint256 tFee = L.collector.totalTReceived();
        assertApproxEqAbs(tFee, tOut / 2 * 3 / 100, 2, "3% of the T input");
        assertEq(L.collector.pendingBurnT(), tFee);
        assertEq(_claimsOf(address(L.collector), L.r.token), tFee, "fee T waits as claims");
        vm.prank(carol);
        L.collector.processFees(); // permissionless
        assertEq(L.t.totalSupply(), supply - tFee, "ECO-11: exactly the fee T is burned");
        assertEq(L.collector.totalTBurned(), tFee);
        assertEq(L.t.balanceOf(address(L.collector)), 0);
    }

    /// Exact-output buys of k whole units deliver k NFTs to a plain EOA (LP fee is on the Q input, not on T).
    function test_buyExactOut_kWholeUnitsDeliverKNfts() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        uint256 unit = _unit(L);
        uint256[3] memory ks = [uint256(1), 3, 10];
        address[3] memory buyers = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            _fundQuote(address(weth), buyers[i], 10 ether);
            (uint256 paid, uint256 received) = _trade(L, buyers[i], true, false, ks[i] * unit);
            assertEq(received, ks[i] * unit, "exactly k units");
            assertEq(_mirror(L).balanceOf(buyers[i]), ks[i], "k NFTs");
            assertGt(paid, 0);
        }
        // 7702-delegated EOAs are treated as EOAs (B1 policy): they receive NFTs through a pool buy too.
        address wallet = makeAddr("wallet7702");
        vm.etch(wallet, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        _fundQuote(address(weth), wallet, 10 ether);
        _trade(L, wallet, true, false, 2 * unit);
        assertEq(_mirror(L).balanceOf(wallet), 2);
    }

    function test_sellExactOut_quoteOut() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Token);
        uint256 tOut = _buyIn(L, alice, 1 ether);
        (uint256 tPaid, uint256 qReceived) = _trade(L, alice, false, false, 0.2 ether);
        assertEq(qReceived, 0.2 ether);
        assertLt(tPaid, tOut);
        assertApproxEqAbs(L.collector.totalTReceived(), tPaid * 3 / 100, 2, "fee on the T actually paid");
    }

    /// PoolSwapTest (Uniswap's harness, also deployed on Sepolia): exact-in and exact-out buys and sells.
    function test_poolSwapTest_allFourShapes() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        uint256 unit = _unit(L);
        _fundQuote(address(weth), alice, 5 ether);
        vm.startPrank(alice);
        weth.approve(address(swapRouter), 5 ether);
        L.t.approve(address(swapRouter), type(uint128).max);
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings(false, false);
        bool buy0For1 = !L.tIsCurrency0;
        swapRouter.swap(L.key, SwapParams(buy0For1, -0.2 ether, _limit(buy0For1)), ts, ""); // buy exact in
        swapRouter.swap(L.key, SwapParams(buy0For1, int256(2 * unit), _limit(buy0For1)), ts, ""); // buy exact out
        swapRouter.swap(L.key, SwapParams(!buy0For1, -int256(unit), _limit(!buy0For1)), ts, ""); // sell exact in
        swapRouter.swap(L.key, SwapParams(!buy0For1, 0.01 ether, _limit(!buy0For1)), ts, ""); // sell exact out
        vm.stopPrank();
        assertEq(L.collector.receiptCount(), 4, "a fee event per swap");
        assertGt(L.collector.totalQReceived(), 0);
        assertGt(L.collector.totalTReceived(), 0);
        // Whole units held by the EOA are NFTs, exactly (DN404 sync through the harness too).
        uint256 whole = L.t.balanceOf(alice) / unit;
        assertGe(whole, 2, "the exact-out buy of 2 units at least");
        assertEq(_mirror(L).balanceOf(alice), whole, "NFTs == floor(balance / unit)");
    }

    /*//////////////////////////////////////////////////////////////
                    FEE RECONCILIATION WITH POOL.SOL
    //////////////////////////////////////////////////////////////*/

    /// Every receipt equals exactly the position's fee growth over that swap (Pool.sol) × liquidity / 2^128 (floor),
    /// nothing stays uncollected, the trader's 3% is matched to within rounding (never exceeded), and the position's
    /// principal is untouched and fully backed.
    function test_feeReconciliation_exactAgainstPoolFeeGrowth() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        address[3] memory traders = [alice, bob, carol];
        uint256[2] memory traderFees; // [Q, T]: 3% of what traders paid in
        uint256[2] memory receipts; // [Q, T]
        for (uint256 i; i < 24; ++i) {
            address trader = traders[i % 3];
            bool buy = i % 3 != 2 || L.t.balanceOf(trader) == 0;
            uint256 amount = buy ? (i + 1) * 0.013 ether : L.t.balanceOf(trader) / 2;
            if (buy) _fundQuote(address(weth), trader, amount);
            (uint256 paid, uint256 receipt) = _reconciledTrade(L, trader, buy, amount);
            traderFees[buy ? 0 : 1] += paid * 30_000 / 1_000_000;
            receipts[buy ? 0 : 1] += receipt;
        }
        assertEq(receipts[0], L.collector.totalQReceived());
        assertEq(receipts[1], L.collector.totalTReceived());
        assertLe(receipts[0], traderFees[0] + 24, "never more than the traders paid");
        assertLe(receipts[1], traderFees[1] + 24);
        _assertPrincipalIntactAndBacked(L);
    }

    /// One exact-input trade: its receipt must equal the position's Pool.sol fee growth over the swap × liquidity
    /// / 2^128 (floor) in the input currency, zero in the other, with nothing left uncollected.
    function _reconciledTrade(Launch memory L, address trader, bool buy, uint256 amount)
        internal
        returns (uint256 paid, uint256 receipt)
    {
        (uint256 gT0, uint256 gQ0) = _feeGrowthInside(L);
        uint256 before = buy ? L.collector.totalQReceived() : L.collector.totalTReceived();
        uint256 otherBefore = buy ? L.collector.totalTReceived() : L.collector.totalQReceived();
        (paid,) = _trade(L, trader, buy, true, amount);
        (uint256 gT1, uint256 gQ1) = _feeGrowthInside(L);
        receipt = (buy ? L.collector.totalQReceived() : L.collector.totalTReceived()) - before;
        uint256 expected =
            buy ? FullMath.mulDiv(gQ1 - gQ0, L.r.liquidity, Q128) : FullMath.mulDiv(gT1 - gT0, L.r.liquidity, Q128);
        assertEq(receipt, expected, "receipt == Pool.sol fee growth x liquidity / 2^128");
        assertEq(buy ? gT1 - gT0 : gQ1 - gQ0, 0, "LP fees accrue in the input currency only");
        assertEq((buy ? L.collector.totalTReceived() : L.collector.totalQReceived()), otherBefore);
        (uint256 uT, uint256 uQ) = _uncollected(L);
        assertEq(uT + uQ, 0, "nothing left uncollected after the swap");
        // The trader paid 3% (rounded up by SwapMath); the receipt is that fee after fee-growth flooring.
        assertLe(receipt, paid * 30_000 / 1_000_000 + 1, "conservatively below");
        assertGe(receipt + 2, paid * 30_000 / 1_000_000, "within rounding");
    }

    /*//////////////////////////////////////////////////////////////
                    BATCHES AND THE FLASH-OUTFLOW GUARD
    //////////////////////////////////////////////////////////////*/

    /// Three swaps in one unlock, settled and taken at the end (Universal Router order): three clean fee events.
    function test_batchedSwapsInOneUnlock_eachIndexedAtItsSwap() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.2 ether); // alice holds T from an earlier transaction
        uint256 claimableBefore = L.ledger.claimable(alice);
        uint256 receiptsBefore = L.collector.receiptCount();
        _fundQuote(address(weth), bob, 1 ether);
        _approveExact(address(weth), bob, address(stepRouter), 1 ether);
        StepRouter.Step[] memory s = new StepRouter.Step[](5);
        s[0] = _swapStep(L, true, -0.1 ether);
        s[1] = _swapStep(L, true, -0.2 ether);
        s[2] = _swapStep(L, true, -0.3 ether);
        s[3] = _payStep(StepRouter.Op.SettleAll, address(weth), bob, 0);
        s[4] = _payStep(StepRouter.Op.TakeAll, L.r.token, bob, 0);
        stepRouter.run(s);
        assertEq(L.collector.receiptCount(), receiptsBefore + 3, "a fee event per swap");
        assertEq(L.ledger.bootstrapQ(), 0, "no take happened before any of them: all clean");
        uint256 holderQ = (L.collector.totalQHolders());
        assertGt(L.ledger.claimable(alice), claimableBefore);
        assertApproxEqAbs(L.ledger.claimable(alice), holderQ, 3, "alice was the only holder at all three");
        assertEq(L.ledger.claimable(bob), 0);
    }

    /// B1 release gate (ADR-0010 R1), fail-closed since review round A: take → fee-bearing swap → settle inside ONE
    /// real PoolManager unlock reverts, so borrowed pool reserves earn nothing and nobody (the borrower included) can
    /// recover the event's holder share at a later release. Nothing changes; the holders keep what they had.
    function test_flashTakeSwapSettle_realPoolManager_revertsFailClosed() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.05 ether); // alice: the only real holder
        _buyIn(L, bob, 0.01 ether); // releases the bootstrap bucket to alice; bob now also holds
        uint256 aliceBefore = L.ledger.claimable(alice);
        uint256 bobBefore = L.ledger.claimable(bob);
        uint256 receipts = L.collector.receiptCount();
        address attacker = makeAddr("attacker");
        uint256 borrowed = L.t.balanceOf(address(pm)) * 9 / 10; // 90% of the pool's T reserves
        _fundQuote(address(weth), attacker, 1 ether);
        _approveExact(address(weth), attacker, address(stepRouter), 1 ether);
        _approveExact(L.r.token, attacker, address(stepRouter), borrowed);

        StepRouter.Step[] memory s = new StepRouter.Step[](5);
        s[0] = _payStep(StepRouter.Op.Take, L.r.token, attacker, borrowed); // PoolManager.take(T)
        s[1] = _swapStep(L, true, -1 ether); // a fee-bearing swap while the reserves are out
        s[2] = _payStep(StepRouter.Op.Settle, L.r.token, attacker, borrowed); // settle the borrowed T back
        s[3] = _payStep(StepRouter.Op.SettleAll, address(weth), attacker, 0);
        s[4] = _payStep(StepRouter.Op.TakeAll, L.r.token, attacker, 0);
        vm.expectRevert(_outflowRevert(borrowed));
        stepRouter.run(s);

        assertEq(L.collector.receiptCount(), receipts, "no fee event happened");
        assertEq(L.ledger.bootstrapQ(), 0, "nothing deferred for a later release");
        assertEq(L.ledger.claimable(attacker), 0, "borrowed reserves earned nothing");
        assertEq(L.ledger.claimable(alice), aliceBefore);
        assertEq(L.ledger.claimable(bob), bobBefore);
        assertEq(L.t.balanceOf(attacker), 0);
        _assertPrincipalIntactAndBacked(L);
    }

    /// Review round A, finding 1 (regression): a buyer takes 1 wei of T out of the PoolManager, then makes a
    /// fee-bearing buy in the same unlock, then settles. Before the fix the buy's holder share went to the deferred
    /// bucket and the next clean fee event released it pro rata to the holders of that moment, the buyer's new T
    /// included (reviewer PoC: 89.4% of its own holder fee recovered on a 1 WETH buy, 93.5% on 5 WETH; the existing
    /// holders lost about 83% of their share). Now the call reverts; a clean buy earns the buyer nothing of its own
    /// fee, at the swap or at any later event.
    function test_selfInducedOutflow_oneWeiTakeThenBuy_revertsAndTheBuyerEarnsNothing() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.05 ether);
        _buyIn(L, bob, 0.01 ether); // releases the launch bootstrap; alice and bob are the existing holders
        address buyer = makeAddr("rebateBuyer");
        _fundQuote(address(weth), buyer, 1 ether);
        _approveExact(address(weth), buyer, address(stepRouter), 1 ether);
        StepRouter.Step[] memory s = new StepRouter.Step[](4);
        s[0] = _payStep(StepRouter.Op.Take, L.r.token, buyer, 1); // 1 wei of T out of the PoolManager
        s[1] = _swapStep(L, true, -1 ether); // the buy
        s[2] = _payStep(StepRouter.Op.SettleAll, address(weth), buyer, 0);
        s[3] = _payStep(StepRouter.Op.TakeAll, L.r.token, buyer, 0); // nets the 1 wei against the buy's output
        vm.expectRevert(_outflowRevert(1));
        stepRouter.run(s);
        assertEq(L.ledger.bootstrapQ(), 0);

        // The same buy without the take: indexed at the swap to alice and bob only.
        uint256 aliceBefore = L.ledger.claimable(alice);
        uint256 bobBefore = L.ledger.claimable(bob);
        uint256 aliceT = L.t.balanceOf(alice);
        uint256 bobT = L.t.balanceOf(bob);
        uint256 holderBefore = L.collector.totalQHolders();
        stepRouter.run(_buySteps(L, buyer, 1 ether));
        uint256 holderShare = L.collector.totalQHolders() - holderBefore;
        assertGt(holderShare, 0.019 ether, "2/3 of the 3% fee");
        assertEq(L.ledger.claimable(buyer), 0, "the buyer earns none of its own buy's fee");
        assertApproxEqAbs(L.ledger.claimable(alice) - aliceBefore, holderShare * aliceT / (aliceT + bobT), 2);
        assertApproxEqAbs(L.ledger.claimable(bob) - bobBefore, holderShare * bobT / (bobT + aliceT), 2);
        // A dust buy by the buyer in the next transaction (the reviewer's release step) has nothing to release.
        assertEq(L.ledger.bootstrapQ(), 0);
        uint256 dustHolderBefore = L.collector.totalQHolders();
        _buyIn(L, buyer, 1e12);
        uint256 dustShare = L.collector.totalQHolders() - dustHolderBefore;
        assertLe(L.ledger.claimable(buyer), dustShare, "only its pro-rata share of the dust buy's own fee");
    }

    /// The same shape through the Universal Router's V4_SWAP engine: two V4_SWAP commands in one transaction, a
    /// 1e9-wei buy (its TAKE_ALL moves T to the buyer) and then the real buy. The second command reverts, so the
    /// router call reverts as a whole.
    function test_twoV4SwapCommands_secondFeeEventAfterTake_reverts() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.05 ether);
        _buyIn(L, bob, 0.01 ether);
        UniversalRouterLike ur = new UniversalRouterLike(pm);
        address buyer = makeAddr("urBuyer");
        _fundQuote(address(weth), buyer, 2 ether);
        _approveExact(address(weth), buyer, address(ur), 2 ether);
        SameTransaction runner = new SameTransaction();
        SameTransaction.Call[] memory calls = new SameTransaction.Call[](2);
        calls[0] = SameTransaction.Call(buyer, address(ur), abi.encodeCall(ur.execute, (_urBuy(L, 1e9))));
        calls[1] = SameTransaction.Call(buyer, address(ur), abi.encodeCall(ur.execute, (_urBuy(L, 1 ether))));
        uint256 dustT = _quoteBuyOutput(L, 1e9);
        vm.expectRevert(_outflowRevert(dustT));
        runner.run(calls);
        assertEq(L.t.balanceOf(buyer), 0, "both commands reverted");
        // Each command in its own transaction works (ordinary routing).
        vm.prank(buyer);
        ur.execute(_urBuy(L, 1 ether));
        assertGt(L.t.balanceOf(buyer), 0);
        assertEq(L.ledger.claimable(buyer), 0);
    }

    /// Three swaps in ONE V4_SWAP (settle/take after all of them) remain three clean fee events; only a fee event
    /// after an earlier take in the same transaction reverts (second V4_SWAP command, second step-router batch).
    function test_batchedBuyThenBuyAfterTake_secondReverts() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.1 ether);
        _buyIn(L, alice, 0.001 ether); // release the first buy's bootstrap
        _fundQuote(address(weth), bob, 1 ether);
        _approveExact(address(weth), bob, address(stepRouter), 1 ether);
        StepRouter.Step[] memory s = new StepRouter.Step[](6);
        s[0] = _swapStep(L, true, -0.2 ether);
        s[1] = _payStep(StepRouter.Op.SettleAll, address(weth), bob, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, L.r.token, bob, 0); // T leaves the pool manager
        s[3] = _swapStep(L, true, -0.2 ether); // second V4_SWAP in the same transaction
        s[4] = _payStep(StepRouter.Op.SettleAll, address(weth), bob, 0);
        s[5] = _payStep(StepRouter.Op.TakeAll, L.r.token, bob, 0);
        uint256 receipts = L.collector.receiptCount();
        uint256 firstOut = _quoteBuyOutput(L, 0.2 ether);
        vm.expectRevert(_outflowRevert(firstOut));
        stepRouter.run(s);
        assertEq(L.collector.receiptCount(), receipts);
        assertEq(L.ledger.bootstrapQ(), 0);
        assertEq(L.t.balanceOf(bob), 0);
    }

    /// A sell (T in: a T-only fee event, no holder Q) after an earlier take in the same transaction does not revert
    /// and releases nothing: only fee events that carry holder Q are refused.
    function test_sellAfterTakeInSameTransaction_isNotBlocked() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.2 ether);
        _buyIn(L, bob, 0.01 ether);
        uint256 tIn = L.t.balanceOf(alice) / 4;
        _fundQuote(address(weth), alice, 0.05 ether);
        _approveExact(address(weth), alice, address(stepRouter), 0.05 ether);
        _approveExact(L.r.token, alice, address(stepRouter), tIn);
        StepRouter.Step[] memory s = new StepRouter.Step[](6);
        s[0] = _swapStep(L, true, -0.05 ether); // a buy, taken first
        s[1] = _payStep(StepRouter.Op.SettleAll, address(weth), alice, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, L.r.token, alice, 0);
        s[3] = _swapStep(L, false, -int256(tIn)); // then a sell: fee in T
        s[4] = _payStep(StepRouter.Op.SettleAll, L.r.token, alice, 0);
        s[5] = _payStep(StepRouter.Op.TakeAll, address(weth), alice, 0);
        uint256 receipts = L.collector.receiptCount();
        uint256 tFees = L.collector.totalTReceived();
        stepRouter.run(s);
        assertEq(L.collector.receiptCount(), receipts + 2);
        assertGt(L.collector.totalTReceived(), tFees, "the sell's T fee was received");
        assertEq(L.ledger.bootstrapQ(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                  BLOCKED: DONATIONS, FOREIGN LIQUIDITY, INIT
    //////////////////////////////////////////////////////////////*/

    function test_donate_isBlocked() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        _buyIn(L, alice, 0.1 ether);
        StepRouter.Step[] memory s = new StepRouter.Step[](1);
        s[0].op = StepRouter.Op.Donate;
        s[0].key = L.key;
        s[0].amount = 1;
        vm.expectRevert(_hookRevert(IHooks.beforeDonate.selector, SquareHoleHook.DonationsDisabled.selector));
        stepRouter.run(s);
    }

    function test_foreignAddAndRemoveLiquidity_areBlocked() public {
        Launch memory L = _launchWeth(SquareHoleRegistry.AssetKind.Collection);
        StepRouter.Step[] memory s = new StepRouter.Step[](1);
        s[0].op = StepRouter.Op.ModifyLiquidity;
        s[0].key = L.key;
        s[0].tickLower = L.r.tickLower;
        s[0].tickUpper = L.r.tickUpper;
        s[0].amount = 1e18;
        vm.expectRevert(_hookRevert(IHooks.beforeAddLiquidity.selector, SquareHoleHook.LiquidityLocked.selector));
        stepRouter.run(s);
        // Removing (or poking) with zero or negative liquidity: the hook refuses too (principal locked).
        s[0].amount = -1;
        vm.expectRevert(_hookRevert(IHooks.beforeRemoveLiquidity.selector, SquareHoleHook.LiquidityLocked.selector));
        stepRouter.run(s);
        s[0].amount = 0;
        vm.expectRevert(_hookRevert(IHooks.beforeRemoveLiquidity.selector, SquareHoleHook.LiquidityLocked.selector));
        stepRouter.run(s);
        assertEq(_positionLiquidity(L), L.r.liquidity, "principal untouched");
    }

    function test_foreignInitialize_isBlocked() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(usdc) < address(weth) ? address(usdc) : address(weth)),
            currency1: Currency.wrap(address(usdc) < address(weth) ? address(weth) : address(usdc)),
            fee: 30_000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert(_hookRevert(IHooks.beforeInitialize.selector, SquareHoleHook.ForeignInitialize.selector));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.prank(address(launcher)); // not even the launcher directly: only through the hook's launchPool
        vm.expectRevert(_hookRevert(IHooks.beforeInitialize.selector, SquareHoleHook.ForeignInitialize.selector));
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    /*//////////////////////////////////////////////////////////////
                    CLAIMS, EXCLUSIONS, BOTH TEMPLATES
    //////////////////////////////////////////////////////////////*/

    function test_holderClaimsQ_andExcludedRolesEarnNothing_bothTemplates() public {
        for (uint256 k; k < 2; ++k) {
            SquareHoleRegistry.AssetKind kind =
                k == 0 ? SquareHoleRegistry.AssetKind.Collection : SquareHoleRegistry.AssetKind.Token;
            Launch memory L = _launchWeth(kind);
            _buyIn(L, alice, 0.2 ether);
            _buyIn(L, bob, 0.2 ether);
            _sellIn(L, alice, L.t.balanceOf(alice) / 3);
            _buyIn(L, carol, 0.05 ether);
            uint256 c = L.ledger.claimable(alice);
            assertGt(c, 0);
            uint256 before = weth.balanceOf(alice);
            vm.prank(alice);
            assertEq(L.ledger.claim(alice), c);
            assertEq(weth.balanceOf(alice) - before, c, "holder Q redeemed from the PoolManager");
            assertEq(L.ledger.claimable(alice), 0);
            address[7] memory roles = [
                address(pm),
                address(hook),
                address(L.collector),
                address(L.ledger),
                address(launcher),
                treasury,
                L.r.mirror == address(0) ? address(registry) : L.r.mirror
            ];
            for (uint256 i; i < roles.length; ++i) {
                assertEq(L.ledger.claimable(roles[i]), 0, "ECO-12");
            }
            assertEq(
                L.ledger.eligibleSupply(),
                L.t.balanceOf(alice) + L.t.balanceOf(bob) + L.t.balanceOf(carol),
                "only real holders are eligible"
            );
            // Protocol Q to the (shared) treasury, fee T burned, custody balanced.
            uint256 treasuryBefore = weth.balanceOf(treasury);
            L.collector.processFees();
            assertEq(weth.balanceOf(treasury) - treasuryBefore, L.collector.totalQToTreasury());
            assertEq(L.collector.totalQToTreasury(), L.collector.totalQProtocol());
            assertEq(L.t.totalSupply(), L.t.initialSupply() - L.collector.totalTBurned());
            _assertPrincipalIntactAndBacked(L);
        }
    }

    /// Both token orders (T sorting before or after Q) behave identically.
    function test_bothTokenOrders() public {
        // Quote at a very low and at a very high address.
        address low = address(0x0000000000000000000000000000000000001000);
        address high = address(0xfFfffFFFfffFFfFFFFffFFFFffffFfFFFFff0000);
        deployCodeTo("MockTokens.sol:MockERC20", abi.encode("Low Q (test)", "LOWQ"), low);
        deployCodeTo("MockTokens.sol:MockERC20", abi.encode("High Q (test)", "HIGHQ"), high);
        vm.startPrank(admin);
        uint32 lowT = registry.addTemplate(low, 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
        uint32 highT = registry.addTemplate(high, 1e18, 1e14, TICK_SPACING, RANGE_TICKS);
        vm.stopPrank();
        uint32[2] memory templates = [lowT, highT];
        for (uint256 i; i < 2; ++i) {
            Launch memory L =
                _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, templates[i], IRewardLedger.PayoutAsset.Q);
            assertEq(L.tIsCurrency0, i == 1, "orientation");
            uint256 tOut = _buyIn(L, alice, 0.01 ether);
            assertApproxEqRel(tOut, 96 * _unit(L) / 10, 0.02e18, "same economics in both orders (~9.6 NFTs)");
            _sellIn(L, alice, tOut / 2);
            assertEq(L.collector.receiptCount(), 2);
            _assertPrincipalIntactAndBacked(L);
        }
    }

    /*//////////////////////////////////////////////////////////////
                         HELPERS AND ASSERTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev A WETH launch: a 1,000-NFT collection (one NFT = 1,000,000 tokens) or a token (always 1e9 tokens, F10).
    function _launchWeth(SquareHoleRegistry.AssetKind kind) internal returns (Launch memory) {
        bool collection = kind == SquareHoleRegistry.AssetKind.Collection;
        return _launch(kind, collection ? 1_000 : 1e9, collection ? 0 : 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
    }

    function _limit(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
    }

    /// @dev Swap exact-in `qIn` Q, settle all, take all to `buyer` (the Universal Router V4_SWAP order).
    function _buySteps(Launch memory L, address buyer, uint256 qIn) internal pure returns (StepRouter.Step[] memory s) {
        s = new StepRouter.Step[](3);
        s[0] = _swapStep(L, true, -int256(qIn));
        s[1] = _payStep(StepRouter.Op.SettleAll, L.r.quote, buyer, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, L.r.token, buyer, 0);
    }

    /// @dev V4_SWAP input (V4Router actions) for an exact-input buy of `qIn` WETH.
    function _urBuy(Launch memory L, uint256 qIn) internal pure returns (bytes memory) {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // casting to 'uint128' is safe because test amounts are small
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, !L.tIsCurrency0, uint128(qIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(L.r.quote), qIn);
        params[2] = abi.encode(Currency.wrap(L.r.token), uint256(1));
        return abi.encode(actions, params);
    }

    /// @dev T output of an exact-input buy of `qIn` at the current state (simulated and rolled back).
    function _quoteBuyOutput(Launch memory L, uint256 qIn) internal returns (uint256 tOut) {
        uint256 snap = vm.snapshotState();
        address probe = makeAddr("quoteProbe");
        tOut = _buyIn(L, probe, qIn);
        vm.revertToState(snap);
    }

    /// @dev v4 wraps a hook's revert as WrappedError(hook, selector, reason, HookCallFailed()).
    function _hookRevert(bytes4 hookSelector, bytes4 reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            abi.encodeWithSelector(reason),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// Principal never pays fees: the position's liquidity is unchanged and the PoolManager holds at least the
    /// principal at the current price plus every outstanding claim, in both currencies.
    function _assertPrincipalIntactAndBacked(Launch memory L) internal view {
        assertEq(_positionLiquidity(L), L.r.liquidity, "principal liquidity locked");
        (uint256 pt, uint256 pq) = _principal(L);
        uint256 tClaims = _claimsOf(address(L.collector), L.r.token) + _claimsOf(treasury, L.r.token);
        uint256 qClaims = _claimsOf(address(L.collector), L.r.quote) + _claimsOf(address(L.ledger), L.r.quote)
            + _claimsOf(address(converter), L.r.quote);
        assertGe(L.t.balanceOf(address(pm)), pt + tClaims, "T principal + claims backed");
        assertGe(_balance(L.r.quote, address(pm)), pq + qClaims, "Q principal + claims backed");
    }
}
