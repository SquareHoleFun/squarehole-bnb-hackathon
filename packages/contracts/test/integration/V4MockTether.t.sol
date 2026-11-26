// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {MockTetherUSD} from "../../src/testnet/MockTetherUSD.sol";
import {UniversalRouterLike} from "../utils/v4/Routers.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

/// @notice The whole Square Hole stack quoted in the testnet mock USDT (SH-B2 Build B item 7): launches of both
/// templates and both reward sides, buys (exact in, exact out whole NFTs) and sells through the Universal Router's
/// V4Router action engine, fee events, burns, protocol payouts, R = Q claims, R = T conversions and the sold-out
/// fallback, and every simulated issuer power (pause, sender blacklist incl. the PoolManager, fund destruction, the
/// transfer fee). Square Hole never calls the token's ERC-20 functions on the fee path (ERC-6909 claims), so issuer
/// actions can only block the specific ERC-20 movement they target; entitlements survive every one of them.
contract V4MockTetherTest is V4Fixture {
    MockTetherUSD internal mtu;
    uint32 internal mtuTemplate;
    UniversalRouterLike internal ur;
    address internal issuer = makeAddr("issuer");

    function setUp() public {
        _deploySystem();
        vm.warp(1_790_000_000);
        mtu = new MockTetherUSD(issuer);
        vm.prank(admin);
        mtuTemplate = registry.addTemplate(address(mtu), USD_START_FDV, USD_MIN_UNIT_VALUE, TICK_SPACING, RANGE_TICKS);
        ur = new UniversalRouterLike(pm);
    }

    /// Funding through the public faucet (≤ 10,000 per call, one call per hour per address); larger test amounts are
    /// written with `deal` (the faucet itself is unit-tested).
    function _fundQuote(address q, address to, uint256 amount) internal override {
        if (q != address(mtu)) return super._fundQuote(q, to, amount);
        if (amount <= mtu.FAUCET_MAX_PER_CALL()) {
            uint256 last = mtu.lastFaucetAt(to);
            if (last != 0 && block.timestamp < last + 1 hours) vm.warp(last + 1 hours);
            vm.prank(to);
            mtu.faucet(amount);
        } else {
            deal(address(mtu), to, mtu.balanceOf(to) + amount, true);
        }
    }

    function _launchMtu(SquareHoleRegistry.AssetKind kind, uint256 units, uint256 r, IRewardLedger.PayoutAsset payout)
        internal
        returns (Launch memory L)
    {
        L = _launch(kind, units, r, mtuTemplate, payout);
        assertEq(L.r.quote, address(mtu));
    }

    /// Exact-input buy through the V4Router engine (SWAP_EXACT_IN_SINGLE → SETTLE_ALL → TAKE_ALL); USDT-style
    /// approval (reset to 0, then the exact amount).
    function _urBuyIn(Launch memory L, address trader, uint256 qIn) internal returns (uint256 tOut) {
        _fundQuote(address(mtu), trader, qIn);
        _approveExact(address(mtu), trader, address(ur), qIn);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, !L.tIsCurrency0, uint128(qIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(address(mtu)), qIn);
        params[2] = abi.encode(Currency.wrap(L.r.token), uint256(1));
        uint256 before = L.t.balanceOf(trader);
        vm.prank(trader);
        ur.execute(abi.encode(actions, params));
        tOut = L.t.balanceOf(trader) - before;
        _approveExact(address(mtu), trader, address(ur), 0);
    }

    /// Exact-output buy of `k` whole units (k NFTs for a collection).
    function _urBuyWholeUnits(Launch memory L, address trader, uint256 k, uint256 maxIn) internal {
        _fundQuote(address(mtu), trader, maxIn);
        _approveExact(address(mtu), trader, address(ur), maxIn);
        uint256 amountOut = k * _unit(L);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            // forge-lint: disable-next-line(unsafe-typecast)
            IV4Router.ExactOutputSingleParams(L.key, !L.tIsCurrency0, uint128(amountOut), uint128(maxIn), 0, "")
        );
        params[1] = abi.encode(Currency.wrap(address(mtu)), maxIn);
        params[2] = abi.encode(Currency.wrap(L.r.token), amountOut);
        vm.prank(trader);
        ur.execute(abi.encode(actions, params));
        _approveExact(address(mtu), trader, address(ur), 0);
    }

    /// Exact-input sell of `tIn` T for mock USDT.
    function _urSellIn(Launch memory L, address trader, uint256 tIn) internal returns (uint256 qOut) {
        _approveExact(L.r.token, trader, address(ur), tIn);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, L.tIsCurrency0, uint128(tIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(L.r.token), tIn);
        params[2] = abi.encode(Currency.wrap(address(mtu)), uint256(1));
        uint256 before = mtu.balanceOf(trader);
        vm.prank(trader);
        ur.execute(abi.encode(actions, params));
        qOut = mtu.balanceOf(trader) - before;
    }

    /// Funds and approves an exact-input buy, then expects the router call itself to revert.
    function _expectBuyReverts(Launch memory L, address trader, uint256 qIn, bytes memory reason) internal {
        _fundQuote(address(mtu), trader, qIn);
        _approveExact(address(mtu), trader, address(ur), qIn);
        bytes memory data = _buyAllData(L, qIn);
        vm.prank(trader);
        if (reason.length == 0) vm.expectRevert();
        else vm.expectRevert(reason);
        ur.execute(data);
        _approveExact(address(mtu), trader, address(ur), 0);
    }

    /// Approves an exact-input sell, then expects the router call to revert.
    function _expectSellReverts(Launch memory L, address trader, uint256 tIn) internal {
        _approveExact(L.r.token, trader, address(ur), tIn);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, L.tIsCurrency0, uint128(tIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(L.r.token), tIn);
        params[2] = abi.encode(Currency.wrap(address(mtu)), uint256(1));
        vm.prank(trader);
        vm.expectRevert();
        ur.execute(abi.encode(actions, params));
        _approveExact(L.r.token, trader, address(ur), 0);
    }

    function _assertBooks(Launch memory L) internal view {
        assertEq(
            L.collector.totalQReceived(),
            L.collector.totalQProtocol() + L.collector.totalQHolders() + L.collector.qRemainder(),
            "F_Q = protocol + holders + remainder"
        );
        assertEq(L.collector.totalTReceived(), L.collector.totalTBurned() + L.collector.pendingBurnT(), "F_T");
        assertGe(_claimsOf(address(L.ledger), address(mtu)), L.ledger.holderQOutstanding(), "ledger solvent");
        assertEq(
            _claimsOf(address(L.collector), address(mtu)),
            L.collector.protocolQPending() + L.collector.qRemainder(),
            "collector Q claims exact"
        );
        assertEq(L.t.totalSupply(), L.r.initialSupply - L.collector.totalTBurned(), "supply = initial - burned");
        assertEq(mtu.allowance(address(L.ledger), address(pm)), 0, "Square Hole grants no USDT allowance");
        assertEq(mtu.allowance(address(L.collector), address(pm)), 0);
    }

    /*//////////////////////////////////////////////////////////////
                              FULL CYCLES
    //////////////////////////////////////////////////////////////*/

    /// Collection, R = Q: faucet → buy exact in → exact-out 3 whole NFTs → sell (burns an NFT) → claim in USDT-TEST
    /// → process fees (burn T, pay protocol USDT-TEST to the treasury).
    function test_mockTether_collectionPayoutQ_fullCycle() public {
        Launch memory L = _launchMtu(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, IRewardLedger.PayoutAsset.Q);
        _urBuyIn(L, alice, 250e6);
        _urBuyWholeUnits(L, bob, 3, 100e6);
        assertEq(_mirror(L).balanceOf(bob), 3, "exact-out delivered 3 whole NFTs");
        uint256 aliceNfts = _mirror(L).balanceOf(alice);
        uint256 qOut = _urSellIn(L, alice, _unit(L));
        assertGt(qOut, 0);
        assertEq(_mirror(L).balanceOf(alice), aliceNfts - 1, "selling one unit burns one NFT");
        assertEq(L.collector.receiptCount(), 3);
        assertGt(L.collector.pendingBurnT(), 0);

        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0);
        uint256 before = mtu.balanceOf(alice);
        vm.prank(alice);
        assertEq(L.ledger.claim(alice), owed);
        assertEq(mtu.balanceOf(alice) - before, owed, "claim paid in USDT-TEST (no-return transfer)");

        uint256 pendingQ = L.collector.protocolQPending();
        (uint256 burned, uint256 paid) = L.collector.processFees();
        assertGt(burned, 0);
        assertEq(paid, pendingQ);
        assertEq(mtu.balanceOf(treasury), pendingQ, "protocol share to the treasury");
        _assertBooks(L);
    }

    /// Fungible, R = T: conversions by pair id pay T; near sell-out a slice; sold out → the Q fallback pays USDT-TEST.
    function test_mockTether_fungiblePayoutT_conversionAndFallback() public {
        Launch memory L = _launchMtu(SquareHoleRegistry.AssetKind.Token, 1e9, 1, IRewardLedger.PayoutAsset.T);
        _urBuyIn(L, alice, 500e6);
        _urBuyIn(L, bob, 800e6);
        _urBuyIn(L, carol, 300e6);
        uint256 owed = L.ledger.claimable(alice);
        uint256 tBefore = L.t.balanceOf(alice);
        vm.prank(alice);
        (uint256 qIn, uint256 tOut) = converter.claimAsT(L.pairId, 1, block.timestamp);
        assertEq(qIn, owed);
        assertEq(L.t.balanceOf(alice) - tBefore, tOut);
        // Sell out the range, then the fallback pays bob in USDT-TEST.
        _fundQuote(address(mtu), carol, 20_000_000e6);
        _approveExact(address(mtu), carol, address(stepRouter), 20_000_000e6);
        _trade(L, carol, true, true, 20_000_000e6);
        assertTrue(converter.isSoldOut(L.r.token));
        uint256 bobOwed = L.ledger.claimable(bob);
        uint256 qBefore = mtu.balanceOf(bob);
        vm.prank(bob);
        assertEq(converter.claimAsQWhenSoldOut(L.r.token, ALL), bobOwed);
        assertEq(mtu.balanceOf(bob) - qBefore, bobOwed);
        L.collector.processFees();
        _assertBooks(L);
    }

    /*//////////////////////////////////////////////////////////////
                         SIMULATED ISSUER POWERS
    //////////////////////////////////////////////////////////////*/

    /// Pause: every USDT movement stops (buys, sells, claims, protocol payouts); approvals still work; nothing in
    /// Square Hole's books moves; everything resumes after unpause.
    function test_mockTether_pause_blocksMovementsNeverEntitlements() public {
        Launch memory L = _launchMtu(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, IRewardLedger.PayoutAsset.Q);
        _urBuyIn(L, alice, 200e6);
        _urBuyIn(L, bob, 200e6);
        uint256 owed = L.ledger.claimable(alice);
        uint256 receipts = L.collector.receiptCount();
        vm.prank(issuer);
        mtu.pause();

        // The faucet is a mint and approve is not paused; settle cannot pull USDT: the whole swap (and its fee
        // event) reverts.
        _expectBuyReverts(L, carol, 100e6, "");
        assertEq(L.collector.receiptCount(), receipts, "no fee event without the swap");
        _expectSellReverts(L, bob, L.t.balanceOf(bob) / 2);
        vm.prank(alice);
        vm.expectRevert();
        L.ledger.claim(alice);
        vm.expectRevert();
        L.collector.payProtocolQ();
        L.collector.burnPendingT(); // the T leg never depends on the quote
        assertEq(L.ledger.claimable(alice), owed, "entitlement intact while paused");

        vm.prank(issuer);
        mtu.unpause();
        vm.prank(alice);
        assertEq(L.ledger.claim(alice), owed);
        L.collector.payProtocolQ();
        _urBuyIn(L, carol, 100e6);
        _assertBooks(L);
    }

    /// Mainnet semantics: the blacklist blocks a SENDER. A blacklisted PoolManager freezes every USDT outflow of
    /// v4 (sells, claims, protocol payouts) but not inflows (buys) or fee events; a blacklisted holder can still be
    /// paid; a blacklisted seller cannot pay the pool. Entitlements survive; everything resumes after removal.
    function test_mockTether_blacklist_poolManagerHolderAndSeller() public {
        Launch memory L = _launchMtu(SquareHoleRegistry.AssetKind.Token, 1e9, 1, IRewardLedger.PayoutAsset.Q);
        _urBuyIn(L, alice, 200e6);
        _urBuyIn(L, bob, 200e6);

        vm.prank(issuer);
        mtu.addBlackList(address(pm));
        _urBuyIn(L, carol, 100e6); // inflow: carol → PoolManager; the fee event (claims) is unaffected
        uint256 owed = L.ledger.claimable(alice);
        vm.prank(alice);
        vm.expectRevert(); // PoolManager → alice is an outflow of a blacklisted sender
        L.ledger.claim(alice);
        _expectSellReverts(L, bob, L.t.balanceOf(bob) / 2);
        vm.expectRevert();
        L.collector.payProtocolQ();
        assertEq(L.ledger.claimable(alice), owed, "entitlement intact");
        vm.prank(issuer);
        mtu.removeBlackList(address(pm));

        // A blacklisted holder can still RECEIVE its claim (sender = PoolManager), but cannot pay the pool.
        vm.prank(issuer);
        mtu.addBlackList(alice);
        vm.prank(alice);
        assertEq(L.ledger.claim(alice), owed, "a blacklisted recipient is paid (mainnet semantics)");
        assertEq(mtu.balanceOf(alice), owed);
        _fundQuote(address(mtu), carol, 10e6);
        vm.prank(carol);
        mtu.transfer(alice, 10e6);
        _approveExact(address(mtu), alice, address(ur), 10e6);
        bytes memory buy = _buyAllData(L, 10e6);
        vm.prank(alice);
        vm.expectRevert(); // alice → PoolManager
        ur.execute(buy);
        // Destroying a blacklisted holder's USDT does not touch Square Hole's books (claims live in the PoolManager).
        uint256 ledgerClaims = _claimsOf(address(L.ledger), address(mtu));
        vm.prank(issuer);
        mtu.destroyBlackFunds(alice);
        assertEq(mtu.balanceOf(alice), 0);
        assertEq(_claimsOf(address(L.ledger), address(mtu)), ledgerClaims);
        _assertBooks(L);
    }

    /// Review round B: the issuer can also DESTROY a blacklisted PoolManager's balance (mainnet semantics, kept on
    /// purpose). Every USDT-TEST ERC-6909 claim then stays on the books but is unbacked: Square Hole's accounting is
    /// unchanged, yet claims, protocol payouts and sells fail until new buys bring USDT-TEST in, and whatever comes in
    /// is paid out first come, first served; the pool's principal and the claims stay short for good. The shared
    /// canonical Sepolia PoolManager holds EVERY USDT-TEST pool (third-party ones too), so one owner call breaks them
    /// all: disclosed for testers (ADR-0011 §9).
    function test_mockTether_destroyBlackFundsOnThePoolManager_leavesEveryClaimUnbacked() public {
        Launch memory L = _launchMtu(SquareHoleRegistry.AssetKind.Token, 1e9, 1, IRewardLedger.PayoutAsset.Q);
        _urBuyIn(L, alice, 200e6);
        _urBuyIn(L, bob, 200e6);
        uint256 owed = L.ledger.claimable(alice);
        uint256 ledgerClaims = _claimsOf(address(L.ledger), address(mtu));
        uint256 collectorClaims = _claimsOf(address(L.collector), address(mtu));
        assertGt(owed, 0);
        uint256 pmBefore = mtu.balanceOf(address(pm));
        assertGt(pmBefore, ledgerClaims + collectorClaims, "backed before");

        vm.startPrank(issuer);
        mtu.addBlackList(address(pm));
        mtu.destroyBlackFunds(address(pm));
        mtu.removeBlackList(address(pm));
        vm.stopPrank();
        assertEq(mtu.balanceOf(address(pm)), 0, "the PoolManager's USDT-TEST is gone");
        // The books do not move: the claims still exist, now unbacked.
        assertEq(_claimsOf(address(L.ledger), address(mtu)), ledgerClaims);
        assertEq(_claimsOf(address(L.collector), address(mtu)), collectorClaims);
        assertEq(L.ledger.claimable(alice), owed);

        vm.prank(alice);
        vm.expectRevert(); // PoolManager → alice: no balance
        L.ledger.claim(alice);
        vm.expectRevert();
        L.collector.payProtocolQ();
        _expectSellReverts(L, bob, L.t.balanceOf(bob) / 2);

        // A new buy brings USDT-TEST in; the first claimer is paid out of it (first come, first served).
        _urBuyIn(L, carol, 100e6);
        uint256 owedNow = L.ledger.claimable(alice); // grew by alice's share of carol's fee
        vm.prank(alice);
        assertEq(L.ledger.claim(alice), owedNow);
        assertEq(mtu.balanceOf(alice), owedNow);
        // Only carol's inflow minus alice's payout is left: the shortfall is exactly the destroyed balance, for good.
        assertEq(mtu.balanceOf(address(pm)), 100e6 - owedNow, "short by exactly the destroyed balance");
        assertGt(pmBefore, 0);
        _assertBooks(L);
    }

    function _buyAllData(Launch memory L, uint256 qIn) internal view returns (bytes memory) {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, !L.tIsCurrency0, uint128(qIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(address(mtu)), qIn);
        params[2] = abi.encode(Currency.wrap(L.r.token), uint256(1));
        return abi.encode(actions, params);
    }

    /// Transfer fee switched on (the issuer power mainnet USDT has, 0 today): the PoolManager credits less than a
    /// router sends, so v4 routers' exact settles fail (`CurrencyNotSettled`) and swaps revert; payouts arrive net of
    /// the fee (the issuer receives it), while Square Hole's accounting stays exact. Fee-bearing quotes stay
    /// unsupported at admission (G06).
    function test_mockTether_transferFee_swapsRevertPayoutsNetOfFee() public {
        Launch memory L = _launchMtu(SquareHoleRegistry.AssetKind.Token, 1e9, 1, IRewardLedger.PayoutAsset.Q);
        _urBuyIn(L, alice, 300e6);
        _urBuyIn(L, bob, 300e6);
        uint256 owed = L.ledger.claimable(alice);
        vm.prank(issuer);
        mtu.setParams(10, 49); // 0.1%, capped at 49 USDT-TEST
        _expectBuyReverts(L, carol, 100e6, abi.encodeWithSelector(IPoolManager.CurrencyNotSettled.selector));
        uint256 claimedBefore = L.ledger.totalClaimed();
        vm.prank(alice);
        assertEq(L.ledger.claim(alice), owed, "the ledger pays the full entitlement");
        uint256 fee = owed * 10 / 10_000;
        assertEq(mtu.balanceOf(alice), owed - fee, "the holder receives it net of the issuer's fee");
        assertEq(L.ledger.totalClaimed() - claimedBefore, owed, "accounting exact");
        vm.prank(issuer);
        mtu.setParams(0, 0);
        _urBuyIn(L, carol, 100e6);
        _assertBooks(L);
    }
}
