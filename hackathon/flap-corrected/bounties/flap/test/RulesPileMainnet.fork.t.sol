// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MainnetForkBase} from "./MainnetForkBase.sol";
import {IERC20F, ITaxTokenF, ITaxProcessorF, IRouterF} from "./PileForkBase.sol";
import {RulesCurveLauncher, CurveConfig} from "../src/RulesCurveLauncher.sol";
import {RulesCurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileVault} from "../src/PileVault.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RailStake} from "fee-rules/RailStake.sol";
import {RailStakeFactory} from "fee-rules/RailStakeFactory.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {PairPriceGuard} from "fee-rules/PairPriceGuard.sol";
import {IPortalTypes} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";

interface IV2PairM {
    function getReserves() external view returns (uint112, uint112, uint32);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function factory() external view returns (address);
    function token0() external view returns (address);
}

interface IV2RouterFactoryM {
    function factory() external view returns (address);
}

interface IV2FactoryM {
    function getPair(address, address) external view returns (address);
}

/// @dev A payee whose receive() needs more than the splitter's NATIVE_CALL_GAS (24 storage writes): distribute()
/// leaves its part owed, payOwedCreator pays it with all the gas given.
contract HungryPayee {
    uint256[24] slots;
    uint256 public got;

    receive() external payable {
        for (uint256 i; i < 24; ++i) {
            slots[i] = block.timestamp + i + got + 1;
        }
        got += msg.value;
    }
}

/// @notice Flap pre-audit finding R5, the rules factories: the creator's stake for the token to come and the creator's
/// rules (creator 10%, pile 30%, holders' stake 40%, buy and burn 20%) set before the sale, the sale created through
/// `Portal.newLauncher` on the BNB Chain Portal at a pinned block with creation PAUSED and the factory enabled by
/// MANAGE_ROLE at the real floor (multiplier 10_000); buys, a sell-back, the completing buy, claims, a holder's stake,
/// third-party trades, the dispatch to the rules vault, the share-out under the swap guard as Flap's pre-audit wrote it
/// (SH-308 R2: the first share-out buys at once at most 5 bps of the pool's quote reserve and burns it, at most one buy
/// a minute, the rest stays owed), the stake's claim and a redemption from the pile. In BNB. And what only the main
/// network shows: the real PancakeSwap V2 pair, the buy with the real tax token at 3% and at 10%, the Portal's highest
/// tax, a pinned limit (a price raised in the same second does not make the buy wait), the gas.
/// Needs BSC_RPC_URL (see MainnetForkBase); skipped without it.
contract RulesPileMainnetForkTest is MainnetForkBase {
    address payee = address(uint160(0xC0DE0099));
    /// @dev PancakeSwap V2 on BNB Chain: the factory behind ROUTER, and its WBNB/BUSD pair as a reference for pair code.
    address constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address constant PANCAKE_WBNB_BUSD = 0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16;
    RulesVaultFactory rvf;
    RulesCurveLauncherFactory rlf;
    RailStakeFactory sf;
    uint256 constant PERIOD = 1 days;

    function setUp() public {
        if (!_forkSetUp()) return;
        (rlf, rvf) = _deployRulesPairBnb();
        sf = new RailStakeFactory();
    }

    function _rules(address stake) internal view returns (IRuleSplitter.Rule[] memory r) {
        r = new IRuleSplitter.Rule[](4);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 1000, target: payee});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 3000, target: address(0)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 4000, target: stake});
        r[3] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 2000, target: address(0)});
    }

    function _part(uint256 income, uint256 bps) internal pure returns (uint256) {
        return income / 10_000 * bps + income % 10_000 * bps / 10_000;
    }

    function _cfg(bytes32 salt) internal pure returns (CurveConfig memory c) {
        return _cfg(salt, 300);
    }

    function _cfg(bytes32 salt, uint16 buyTax) internal pure returns (CurveConfig memory c) {
        c.name = "Rules Pile Main";
        c.symbol = "RULEM";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 2.6 ether;
        c.virtualBnb = 10 ether;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = buyTax;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    RulesCurveLauncher l;
    address token;
    RulesVault s;
    RailStake st;
    uint256 kStake;

    function test_paused_enabledAtTheRealFloor_rulesJourney() public {
        _enableLauncherFactory(address(rlf), 10_000);
        assertEq(portal.featureFlags() & 1, 1, "creation paused");
        _rulesThenSale("main-rules", payee, 300);
        _checkRules();
        _claimsAndStake();
        _tradeAndDispatchToSplitter(); // the third-party trades all come before the first share-out
        uint256 toStake = _shareOutGuarded();
        _stakeClaim(toStake);
        _redeemFromPile();
    }

    function _rulesThenSale(string memory seed, address payee_, uint16 buyTax) internal {
        payee = payee_;
        bytes32 salt = _mineSalt(keccak256(bytes(seed)));
        address tokenToCome = rlf.predictToken(salt);
        vm.prank(creator);
        st = RailStake(payable(sf.create(tokenToCome, address(0), PERIOD)));
        vm.prank(creator);
        address predicted = rvf.setRules(address(rlf), salt, _rules(address(st)));
        assertEq(predicted, rlf.predictLauncher(creator, salt));

        uint256 v = rlf.creationFee() + 0.05 ether;
        l = RulesCurveLauncher(payable(_createViaPortal(address(rlf), abi.encode(_cfg(salt, buyTax)), v)));
        assertEq(address(l), predicted, "the sale is the Launcher the rules were stored for");
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(rlf), "recorded on the Portal");

        vm.prank(alice);
        l.buy{value: 1 ether}(0);
        vm.prank(carol);
        l.buy{value: 0.4 ether}(0);
        uint256 aliceBack = l.tokensOf(alice) / 4; // read before the prank: a view call would take it
        vm.prank(alice);
        l.sell(aliceBack, 0);
        uint256 need = l.costToComplete();
        vm.prank(bob);
        l.complete{value: need}();
        assertTrue(l.launched());
        address vault;
        (token,, vault) = l.launchInfo();
        s = RulesVault(payable(vault));
        assertEq(token, tokenToCome);
    }

    function _checkRules() internal view {
        assertEq(rvf.vaultOf(token), address(s));
        assertEq(s.asset(), address(0));
        assertEq(s.ruleCount(), 4);
        (IRuleSplitter.Kind k1, uint16 b1, address t1) = s.rule(1);
        assertTrue(k1 == IRuleSplitter.Kind.PILE && b1 == 3000 && t1 == rvf.pileOf(token), "the pile rule");
        (,, address t2) = s.rule(2);
        assertEq(t2, address(st), "the holders' rule pays the stake");
        (IRuleSplitter.Kind k3,, address t3) = s.rule(3);
        assertTrue(k3 == IRuleSplitter.Kind.BUY_BURN && t3 == ROUTER, "buy and burn on the main network router");
        assertGt(s.pending(), 0, "the curve fees arrived as the splitter's first income");
    }

    function _claimsAndStake() internal {
        address[4] memory who = [creator, alice, carol, bob];
        for (uint256 i; i < 4; ++i) {
            uint256 owed = l.tokensOf(who[i]);
            vm.prank(who[i]);
            l.claim();
            assertEq(IERC20F(token).balanceOf(who[i]), owed);
        }
        // carol stakes all her tokens before the income arrives
        kStake = IERC20F(token).balanceOf(carol);
        vm.startPrank(carol);
        IERC20F(token).approve(address(st), kStake);
        assertEq(st.stake(kStake), kStake, "credited in full");
        vm.stopPrank();
    }

    /// @dev Third-party trades until the vault slot's share waits, then the dispatch to the splitter.
    function _tradeAndDispatchToSplitter() internal {
        address proc = ITaxTokenF(token).taxProcessor();
        vm.warp(block.timestamp + 601);
        vm.startPrank(trader);
        _buy(token, 0.3 ether);
        for (uint256 i; i < 80 && ITaxProcessorF(proc).marketQuoteBalance() == 0; ++i) {
            uint256 amt = IERC20F(token).balanceOf(trader) * 30 / 100;
            if (amt == 0) break;
            uint256 before_ = trader.balance;
            _sell(token, amt);
            uint256 got = trader.balance - before_;
            if (got > 0) _buy(token, got * 90 / 100);
        }
        vm.stopPrank();
        uint256 share = ITaxProcessorF(proc).marketQuoteBalance();
        assertGt(share, 0, "the vault slot's share is waiting");
        uint256 p0 = s.pending();
        ITaxProcessorF(proc).dispatch();
        assertEq(s.pending() - p0, share, "the splitter received exactly the vault slot's share");
    }

    /// @dev The four parts of `income` as distribute() assigns them (the last rule takes the remainder).
    function _parts(uint256 income) internal pure returns (uint256[4] memory p) {
        p[0] = _part(income, 1000);
        p[1] = _part(income, 3000);
        p[2] = _part(income, 4000);
        p[3] = income - p[0] - p[1] - p[2];
    }

    /// @dev The launched pair's reserves, oriented (quote, token).
    function _reserves() internal view returns (uint256 rq, uint256 rt) {
        (uint112 r0, uint112 r1,) = IV2PairM(l.pool()).getReserves();
        (rq, rt) = token < WBNB ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
    }

    uint256 gasBuy;
    uint256 gasPayOwed;

    /// @dev ROUND 1, the first share-out after the pool exists: it buys at once, exactly min(burn part, 5 bps of the
    /// quote reserve); the creator, the pile and the stake are paid their exact parts.
    function _roundFirstBuys(bool payeeTakesIt) internal returns (uint256[4] memory p) {
        p = _parts(s.pending());
        uint256 c0 = payee.balance;
        uint256 pile0 = PileVault(payable(rvf.pileOf(token))).pile();
        uint256 st0 = address(st).balance;
        assertEq(s.delivered(3), 0, "nothing bought before");
        uint256 bought = _roundBuys("round 1, the first share-out after the pool exists");
        assertGt(bought, 0, "the first share-out buys at once");
        if (payeeTakesIt) assertEq(payee.balance - c0, p[0], "the creator's rule paid in BNB");
        else assertEq(s.owed(0), p[0], "a payee that needs more gas stays owed");
        assertEq(PileVault(payable(rvf.pileOf(token))).pile() - pile0, p[1], "the pile grown by its rule");
        assertEq(address(st).balance - st0, p[2], "the holders' stake got its 40%");
    }

    /// @dev A buying round: exactly min(owed, 5 bps of the pair's quote reserve) bought and burned, the rest owed; the
    /// tokens at DEAD at least the guard's minimum for that amount.
    function _roundBuys(string memory label) internal returns (uint256 bought) {
        uint256[4] memory p = _parts(s.pending());
        uint256 owedBurn = s.owed(3) + p[3];
        (uint256 rq, uint256 rt) = _reserves();
        uint256 cap = rq * PairPriceGuard.CAP_BPS / 10_000;
        bought = owedBurn < cap ? owedBurn : cap;
        uint256 d0 = s.delivered(3);
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        uint256 b0 = s.burned(3);
        uint256 g = gasleft();
        s.distribute();
        gasBuy = g - gasleft();
        assertEq(s.delivered(3) - d0, bought, "bought exactly min(owed, 5 bps of the quote reserve)");
        assertEq(s.owed(3), owedBurn - bought, "the rest stays owed");
        uint256 burnt = IERC20F(token).balanceOf(DEAD) - dead0;
        assertEq(s.burned(3) - b0, burnt);
        assertGe(burnt, PairPriceGuard.minimumOut(bought, rq, rt), "at least the guard's minimum arrived");
        assertGt(burnt, 0);
        emit log_named_string("buying round", label);
        emit log_named_uint("  bought (wei)", bought);
        emit log_named_uint("  cap: 5 bps of the quote reserve (wei)", cap);
        emit log_named_uint("  tokens burned", burnt);
        emit log_named_uint("  guard minimum (tokens)", PairPriceGuard.minimumOut(bought, rq, rt));
        emit log_named_uint("  constant-product output, no fee (tokens)", bought * rt / (rq + bought));
    }

    /// @dev A round that buys nothing: the burn part (with any new income's) stays owed, the other rules are paid.
    function _roundWaits() internal {
        uint256[4] memory p = _parts(s.pending());
        uint256 owedBurn = s.owed(3) + p[3];
        uint256 d0 = s.delivered(3);
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        uint256 pile0 = PileVault(payable(rvf.pileOf(token))).pile();
        uint256 st0 = address(st).balance;
        s.distribute();
        assertEq(s.delivered(3), d0, "nothing bought");
        assertEq(s.owed(3), owedBurn, "the burn part waits");
        assertEq(IERC20F(token).balanceOf(DEAD), dead0, "nothing burned");
        assertEq(PileVault(payable(rvf.pileOf(token))).pile() - pile0, p[1], "the pile is paid all the same");
        assertEq(address(st).balance - st0, p[2], "the stake is paid all the same");
    }

    /// @dev The share-out under the guard as Flap wrote it: round 1 buys at once; 30 seconds later round 2 buys nothing
    /// (inside the minute after a buy); 61 seconds after round 1 round 3 buys again; the rest stays owed.
    function _shareOutGuarded() internal returns (uint256 toStake) {
        _roundFirstBuys(true);
        toStake = s.delivered(2);
        emit log_named_uint("gas: share-out that buys (round 1, 3% tax)", gasBuy);
        vm.warp(block.timestamp + 30);
        _roundWaits(); // round 2: inside the minute after a buy
        vm.warp(block.timestamp + 31);
        _roundBuys("round 3, 61 s after round 1");
        assertGt(s.owed(3), 0, "the rest still owed: paced, a slice a minute");
        assertEq(address(s).balance, s.totalOwed(), "the splitter holds exactly what it owes");
        assertEq(s.delivered(2), toStake, "no new income meanwhile");
    }

    // ── what only the main network shows ─────────────────────────────────────

    function _launchedForGuards(string memory seed, address payee_, uint16 buyTax) internal {
        _enableLauncherFactory(address(rlf), 10_000);
        _rulesThenSale(seed, payee_, buyTax);
        _claimsAndStake();
    }

    /// On the real pair: (1) a swap that fails costs no minute: the router refuses the first share-out's swap
    /// (forge's mockCallRevert on its swap selector: on BNB Chain no tax can exceed the guard's room and a past deadline
    /// is not ours to pass; every read stays the real pair's), nothing is bought and nothing written, and the next call
    /// in the same second, the cause gone, buys the cap; (2) one buy per minute: a second share-out in that same second
    /// buys nothing while the pile and the stake are paid; 61 seconds later the next slice is bought.
    function test_guard_failedSwapCostsNoMinute_oneBuyPerMinute() public {
        _launchedForGuards("main-final", payee, 300);
        _tradeAndDispatchToSplitter();
        uint256[4] memory p = _parts(s.pending());
        vm.mockCallRevert(
            ROUTER, abi.encodeWithSelector(IRouterF.swapExactETHForTokensSupportingFeeOnTransferTokens.selector), "refused"
        );
        s.distribute();
        assertEq(s.owed(3), p[3], "the refused swap bought nothing");
        assertEq(s.delivered(3), 0);
        vm.clearMockedCalls();
        _roundBuys("the retry in the same second after a refused swap");

        vm.prank(trader);
        (bool ok,) = address(s).call{value: 0.01 ether}("");
        assertTrue(ok);
        _roundWaits(); // a second share-out in the same second buys nothing

        vm.warp(block.timestamp + PairPriceGuard.MIN_GAP + 1);
        _roundBuys("the next minute");
    }

    /// (a) The pair Flap's launch creates on BNB Chain is a plain PancakeSwap V2 pair (the same code as PancakeSwap's
    /// WBNB/BUSD pair), made by PancakeSwap's V2 factory, the factory behind the router our rules use; and it KEEPS its
    /// price cumulative: a trade a minute later moves the token's side by exactly price x seconds (a fact of the pair;
    /// the guard as Flap wrote it no longer reads it).
    function test_guard_realPancakePairKeepsItsPriceCumulative() public {
        _launchedForGuards("main-twap", payee, 300);
        address pair = l.pool();
        assertEq(IV2RouterFactoryM(ROUTER).factory(), PANCAKE_V2_FACTORY, "the router's factory");
        assertEq(IV2FactoryM(PANCAKE_V2_FACTORY).getPair(WBNB, token), pair, "the launch's pool is that factory's pair");
        assertEq(IV2PairM(pair).factory(), PANCAKE_V2_FACTORY, "made by PancakeSwap's V2 factory");
        assertEq(IV2PairM(PANCAKE_WBNB_BUSD).factory(), PANCAKE_V2_FACTORY, "reference pair");
        assertEq(pair.codehash, PANCAKE_WBNB_BUSD.codehash, "plain PancakeSwap V2 pair code, not a variant");
        bool t0 = IV2PairM(pair).token0() == token;
        assertEq(t0, token < WBNB);

        vm.warp(block.timestamp + 601);
        (uint256 rq, uint256 rt) = _reserves();
        (,, uint32 tLast) = IV2PairM(pair).getReserves();
        uint256 c0 = t0 ? IV2PairM(pair).price0CumulativeLast() : IV2PairM(pair).price1CumulativeLast();
        uint256 q0 = t0 ? IV2PairM(pair).price1CumulativeLast() : IV2PairM(pair).price0CumulativeLast();
        vm.warp(block.timestamp + 60);
        vm.prank(trader);
        _buy(token, 0.01 ether);
        uint256 c1 = t0 ? IV2PairM(pair).price0CumulativeLast() : IV2PairM(pair).price1CumulativeLast();
        uint256 q1 = t0 ? IV2PairM(pair).price1CumulativeLast() : IV2PairM(pair).price0CumulativeLast();
        uint256 dt = block.timestamp - tLast;
        assertGe(dt, 661);
        unchecked {
            assertEq(c1 - c0, uint256(uint224((rq << 112) / rt)) * dt, "token side: price (BNB per token) x seconds");
            assertEq(q1 - q0, uint256(uint224((rt << 112) / rq)) * dt, "BNB side: price (tokens per BNB) x seconds");
        }
        assertGt(c1, c0);
        emit log_named_address("launched pair", pair);
        emit log_named_uint("seconds accumulated", dt);
        emit log_named_uint("token-side cumulative moved by", c1 - c0);
    }

    /// (b) at Flap's highest tax, (c) A PINNED LIMIT of the guard as Flap wrote it, and (d): the sale's buy tax is 10%
    /// (the most our factories and the Portal allow) and the creator's payee needs more gas than the splitter gives.
    /// The first share-out buys its slice at 10% tax above the guard's minimum; the creator stays owed and
    /// payOwedCreator pays it. 61 seconds later a trader raises the price by far more than 1% in the block before the
    /// share-out, in the same second: the share-out does NOT wait; it buys exactly min(owed, 5 bps of the RAISED quote
    /// reserve), at least the minimum from the raised reserves as read, and fewer tokens than the same amount bought
    /// before the raise. Nobody should read a price protection into this suite: the contracts no longer have one.
    function test_guard_limit_sameSecondRaiseDoesNotWait_tenPercentTax_payOwedCreator() public {
        HungryPayee hungry = new HungryPayee();
        _launchedForGuards("main-raise", address(hungry), 1000);
        _tradeAndDispatchToSplitter();
        uint256[4] memory p = _roundFirstBuys(false);
        emit log_named_uint("gas: share-out that buys (10% tax, payee left owed)", gasBuy);

        uint256 g = gasleft();
        uint256 paid = s.payOwedCreator(0);
        gasPayOwed = g - gasleft();
        assertEq(paid, p[0]);
        assertEq(hungry.got(), p[0], "payOwedCreator paid the hungry payee");
        assertEq(s.owed(0), 0);
        emit log_named_uint("gas: payOwedCreator (24 fresh storage writes in the payee)", gasPayOwed);

        vm.warp(block.timestamp + PairPriceGuard.MIN_GAP + 1);
        (uint256 rq0, uint256 rt0) = _reserves();
        vm.prank(trader);
        _buy(token, 0.3 ether);
        uint256 ts = block.timestamp;
        vm.roll(block.number + 1); // the share-out below runs in the NEXT block with the SAME timestamp, as consecutive
        assertEq(block.timestamp, ts); // BNB Chain blocks do (135830000 and 135830001 both carry 1795688575)
        _raisedBuyGoesThrough(rq0, rt0);
    }

    /// @dev The share-out right after a raise: exactly min(owed, 5 bps of the raised quote reserve) bought, at least the
    /// minimum from the raised reserves, fewer tokens than before the raise.
    function _raisedBuyGoesThrough(uint256 rq0, uint256 rt0) internal {
        (uint256 rq1, uint256 rt1) = _reserves();
        uint256 raisedBps = (rq1 * 1e18 / rt1) * 10_000 / (rq0 * 1e18 / rt0) - 10_000;
        assertGt(raisedBps, 100, "the price raised by more than 1%");
        uint256 owedBurn = s.owed(3) + _parts(s.pending())[3];
        uint256 cap = rq1 * PairPriceGuard.CAP_BPS / 10_000;
        uint256 amount = owedBurn < cap ? owedBurn : cap;
        uint256 minOut = PairPriceGuard.minimumOut(amount, rq1, rt1);
        uint256 beforeRaise = amount * rt0 / (rq0 + amount);
        uint256 d0 = s.delivered(3);
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        s.distribute();
        uint256 burnt = IERC20F(token).balanceOf(DEAD) - dead0;
        assertEq(s.delivered(3) - d0, amount, "the raise does NOT make the buy wait: the slice is bought");
        assertGe(burnt, minOut, "at least the minimum from the raised reserves");
        assertLt(burnt, beforeRaise, "fewer tokens than the same amount bought before the raise");
        emit log_named_uint("LIMIT: price raised in the same second (bps)", raisedBps);
        emit log_named_uint("LIMIT: bought at the raised price (wei)", amount);
        emit log_named_uint("LIMIT: minimum from the raised reserves (tokens)", minOut);
        emit log_named_uint("LIMIT: tokens burned", burnt);
        emit log_named_uint("LIMIT: constant-product output before the raise (tokens)", beforeRaise);
    }

    /// (b) Flap's highest tax on the main network: standing in for Flap, the MANAGE_ROLE holder opens creation on the
    /// fork (setCreationPaused(false) is open to that role), then the Portal's own launchTaxTokenV2: a 10.01% buy tax
    /// reverts InvalidTaxBps(1001) (0x929d8da4), 10% launches. So no buy tax above the guard's 10% room exists there.
    function test_portal_highestTaxOnTheMainNetwork() public {
        vm.prank(manager);
        portal.setCreationPaused(false);
        assertEq(portal.featureFlags() & 1, 0);
        IPortalTypes.CreateTaxTokenParams memory q = _taxProbe("main-tax-1001", 1001);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSignature("InvalidTaxBps(uint256)", uint256(1001)));
        portal.launchTaxTokenV2{value: 2 ether}(q, _noDist(), _noBuy());
        q = _taxProbe("main-tax-1000", 1000);
        vm.prank(creator);
        (address t,) = portal.launchTaxTokenV2{value: 2 ether}(q, _noDist(), _noBuy());
        assertEq(uint16(uint160(t)), 0x7777, "a 10% buy tax launches");
        assertEq(PairPriceGuard.MAX_BUY_TAX_BPS, 1000, "the guard's room is that highest tax");
    }

    function _noDist() internal pure returns (Distribution memory d) {}

    function _noBuy() internal pure returns (IPortalTypes.CreatorBuyParams memory b) {}

    function _taxProbe(string memory seed, uint16 buyTax) internal returns (IPortalTypes.CreateTaxTokenParams memory q) {
        IPortalTypes.FeeConfig[] memory fees = new IPortalTypes.FeeConfig[](1);
        fees[0] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeSlotType.DEFLATION, bps: 10_000, configData: ""
        });
        q.name = "Tax Probe";
        q.symbol = "TAXP";
        q.totalSupply = 1_000_000_000 ether;
        q.salt = _mineSalt(keccak256(bytes(seed)));
        q.poolQuote = 2 ether;
        q.poolToken = 1_000_000_000 ether;
        q.buyTaxRate = buyTax;
        q.sellTaxRate = 500;
        q.taxDuration = 365 days;
        q.antiFarmerDuration = 1 days;
        q.feeConfigs = fees;
    }

    /// @dev Carol, the only staker, streams the whole part over the period; then unstakes in full.
    function _stakeClaim(uint256 toStake) internal {
        assertEq(st.sync(), toStake);
        vm.warp(block.timestamp + PERIOD + 1);
        uint256 k0 = carol.balance;
        vm.prank(carol);
        uint256 kPaid = st.claim();
        assertEq(carol.balance - k0, kPaid);
        assertLe(kPaid, toStake, "never more than arrived");
        assertGe(kPaid + 2, toStake, "all of it, but rounding");
        emit log_named_uint("stake claim paid (wei)", kPaid);
        vm.prank(carol);
        st.unstake(kStake);
        assertEq(IERC20F(token).balanceOf(carol), kStake, "carol's tokens back in full");
    }

    function _redeemFromPile() internal {
        PileVault pile = PileVault(payable(rvf.pileOf(token)));
        uint256 amount = IERC20F(token).balanceOf(alice);
        uint256 expected = pile.pile() * amount / pile.circulatingSupply();
        uint256 a0 = alice.balance;
        vm.startPrank(alice);
        IERC20F(token).approve(address(pile), amount);
        assertEq(pile.redeem(amount, expected), expected);
        vm.stopPrank();
        assertGt(expected, 0);
        assertEq(alice.balance - a0, expected, "redeemed to the last wei");
    }

    /// R4 for the rules factory: both beacons (the splitter's and the pile's) are the factory's, and only the BNB Chain
    /// Guardian upgrades them; the MANAGE_ROLE holder and the creator are refused.
    function test_r4_onlyTheGuardianUpgradesTheRulesVaults() public {
        assertEq(UpgradeableBeacon(rvf.beacon()).owner(), address(rvf));
        assertEq(UpgradeableBeacon(rvf.pileBeacon()).owner(), address(rvf));
        address newSplitter = address(new RulesVault());
        address newPile = address(new PileVault());
        address[2] memory refused = [manager, creator];
        for (uint256 i; i < 2; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, refused[i]));
            rvf.upgradeVaultImplementation(newSplitter);
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, refused[i]));
            rvf.upgradePileImplementation(newPile);
        }
        vm.startPrank(GUARDIAN);
        rvf.upgradeVaultImplementation(newSplitter);
        rvf.upgradePileImplementation(newPile);
        vm.stopPrank();
        assertEq(rvf.beaconImplementation(), newSplitter);
        assertEq(rvf.pileBeaconImplementation(), newPile);
    }
}
