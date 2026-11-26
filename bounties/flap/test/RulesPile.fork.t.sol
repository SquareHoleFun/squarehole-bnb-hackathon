// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {PileForkBase, IERC20F, ITaxTokenF, ITaxProcessorF} from "./PileForkBase.sol";
import {CurveConfig} from "../src/RulesCurveLauncher.sol";
import {RulesCurveLauncher as CurveLauncher} from "../src/RulesCurveLauncher.sol";
import {RulesCurveLauncherFactory as CurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesTokenCurveLauncher as TokenCurveLauncher} from "../src/RulesTokenCurveLauncher.sol";
import {RulesTokenCurveLauncherFactory as TokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";
import {ILauncherDescription} from "src/flap/ILauncher.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileVault} from "../src/PileVault.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {PileDeployer, RulesVaultDeployer} from "../src/RulesDeployers.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IRouterR {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice Their token, our rules, on the live test network Portal: a creator sets its rules (creator 20%, pile 50%,
/// buy and burn 30%) before the sale exists, the sale launches through Portal.newLauncher with a RulesVault in the
/// VAULT slot, trades raise income, `distribute()` pays the creator, grows a redeemable pile and sends bought tokens
/// to the dead address. In the test dollar and in BNB; and the order that is refused.
contract RulesPileForkTest is PileForkBase {
    address constant USD = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;
    address payee = address(uint160(0xC0DE0099)); // the creator's chosen payee

    RulesVaultFactory rvfU;
    TokenCurveLauncherFactory clfU;
    RulesVaultFactory rvfN;
    CurveLauncherFactory clfN;

    function setUp() public {
        if (!_forkSetUp()) return;
        PileDeployer pd = new PileDeployer();
        RulesVaultDeployer rd = new RulesVaultDeployer();
        rvfU = new RulesVaultFactory(PORTAL, USD, ROUTER, pd, rd);
        clfU = new TokenCurveLauncherFactory(PORTAL, address(rvfU), TOKEN_IMPL);
        rvfN = new RulesVaultFactory(PORTAL, address(0), ROUTER, pd, rd);
        clfN = new CurveLauncherFactory(PORTAL, address(rvfN), TOKEN_IMPL);
        address[4] memory who = [creator, alice, bob, trader];
        for (uint256 i; i < 4; ++i) IMintable(USD).mint(who[i], 100_000 ether);
    }

    function _rules() internal view returns (IRuleSplitter.Rule[] memory r) {
        r = new IRuleSplitter.Rule[](3);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 2000, target: payee});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 5000, target: address(0)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 3000, target: address(0)});
    }

    function _cfg(bytes32 salt, bool usd) internal pure returns (CurveConfig memory c) {
        c.name = "Rules Pile";
        c.symbol = "RULE";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = usd ? 1_700 ether : 2.35 ether;
        c.virtualBnb = usd ? 11_600 ether : 16 ether;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    function _swap(address from, address to, uint256 amount) internal {
        IERC20F(from).approve(ROUTER, amount);
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        IRouterR(ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, trader, block.timestamp + 600);
    }

    /// @dev Pool rounds in USD until the processor holds the vault slot's share, then dispatch to the splitter.
    function _tradeUsdAndDispatch(address token, address splitter) internal returns (uint256 share) {
        address proc = ITaxTokenF(token).taxProcessor();
        vm.warp(block.timestamp + 601);
        vm.startPrank(trader);
        _swap(USD, token, 200 ether);
        for (uint256 i; i < 80 && ITaxProcessorF(proc).marketQuoteBalance() == 0; ++i) {
            uint256 amt = IERC20F(token).balanceOf(trader) * 30 / 100;
            if (amt == 0) break;
            uint256 u0 = IERC20F(USD).balanceOf(trader);
            _swap(token, USD, amt);
            uint256 got = IERC20F(USD).balanceOf(trader) - u0;
            if (got > 0) _swap(USD, token, got * 90 / 100);
        }
        vm.stopPrank();
        share = ITaxProcessorF(proc).marketQuoteBalance();
        assertGt(share, 0, "the vault slot's share is waiting");
        uint256 p0 = RulesVault(payable(splitter)).pending();
        ITaxProcessorF(proc).dispatch();
        assertEq(RulesVault(payable(splitter)).pending() - p0, share, "the splitter received exactly the vault share");
    }

    // ── rules set first, then the sale: the rules hold (test dollar) ──────────

    function test_usd_rulesThenCreate_threeEffects() public {
        bytes32 salt = _mineSalt(keccak256("rules-usd"));
        vm.prank(creator);
        address predicted = rvfU.setRules(address(clfU), salt, _rules());
        assertEq(predicted, clfU.predictLauncher(creator, salt));
        assertTrue(rvfU.rulesSet(predicted));

        uint256 fee = clfU.creationFee();
        vm.prank(creator);
        TokenCurveLauncher l = TokenCurveLauncher(portal.newLauncher{value: fee}(address(clfU), abi.encode(_cfg(salt, true))));
        assertEq(address(l), predicted, "the sale is the Launcher the rules were stored for");

        // buys and the launch
        vm.startPrank(alice);
        IERC20F(USD).approve(address(l), 300 ether);
        l.buy(300 ether, 0);
        vm.stopPrank();
        uint256 need = l.costToComplete();
        vm.startPrank(bob);
        IERC20F(USD).approve(address(l), need);
        l.complete(need);
        vm.stopPrank();
        assertTrue(l.launched());
        (address token,, address vault) = l.launchInfo();
        _checkRules(token, vault);
        vm.prank(alice);
        l.claim();
        vm.prank(bob);
        l.claim();
        _tradeUsdAndDispatch(token, vault);
        _distributeAndCheck(token, vault);
        _redeemCheck(token);
    }

    function _checkRules(address token, address vault) internal view {
        RulesVault s = RulesVault(payable(vault));
        assertEq(rvfU.vaultOf(token), vault);
        assertEq(s.token(), token);
        assertEq(s.asset(), USD);
        assertEq(s.ruleCount(), 3);
        (IRuleSplitter.Kind k0, uint16 b0, address t0) = s.rule(0);
        assertTrue(k0 == IRuleSplitter.Kind.CREATOR && b0 == 2000 && t0 == payee);
        (IRuleSplitter.Kind k1, uint16 b1, address t1) = s.rule(1);
        assertTrue(k1 == IRuleSplitter.Kind.PILE && b1 == 5000 && t1 == rvfU.pileOf(token));
        (IRuleSplitter.Kind k2, uint16 b2, address t2) = s.rule(2);
        assertTrue(k2 == IRuleSplitter.Kind.BUY_BURN && b2 == 3000 && t2 == ROUTER);
        assertGt(s.pending(), 0, "the curve fees arrived as the splitter's first income");
    }

    function _distributeAndCheck(address token, address vault) internal {
        RulesVault s = RulesVault(payable(vault));
        uint256 income = s.pending();
        uint256 c0 = IERC20F(USD).balanceOf(payee);
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        s.distribute();
        uint256 p0 = income * 2000 / 10_000;
        uint256 p1 = income * 5000 / 10_000;
        assertEq(IERC20F(USD).balanceOf(payee) - c0, p0, "the creator paid");
        assertEq(PileVault(payable(rvfU.pileOf(token))).pile(), p1, "the pile grown");
        uint256 burnt = IERC20F(token).balanceOf(DEAD) - dead0;
        assertGt(burnt, 0, "tokens at the dead address");
        assertEq(s.burned(2), burnt);
        assertEq(s.delivered(2), income - p0 - p1);
        assertEq(s.totalOwed(), 0);
        emit log_named_uint("income shared (USD wei)", income);
        emit log_named_uint("creator paid", p0);
        emit log_named_uint("pile grown", p1);
        emit log_named_uint("tokens burned", burnt);
    }

    function _redeemCheck(address token) internal {
        address pile = rvfU.pileOf(token);
        PileVault pv = PileVault(payable(pile));
        uint256 amount = IERC20F(token).balanceOf(alice);
        uint256 expected = pv.pile() * amount / pv.circulatingSupply();
        uint256 u0 = IERC20F(USD).balanceOf(alice);
        vm.startPrank(alice);
        IERC20F(token).approve(pile, amount);
        assertEq(pv.redeem(amount, expected), expected);
        vm.stopPrank();
        assertEq(IERC20F(USD).balanceOf(alice) - u0, expected, "redeemed to the last unit");
    }

    // ── the sale first: rules refused, the pile gets everything ───────────────

    function test_usd_createThenRules_refused_pileTakesAll() public {
        bytes32 salt = _mineSalt(keccak256("rules-late"));
        uint256 fee = clfU.creationFee();
        vm.prank(creator);
        TokenCurveLauncher l = TokenCurveLauncher(portal.newLauncher{value: fee}(address(clfU), abi.encode(_cfg(salt, true))));
        IRuleSplitter.Rule[] memory r = _rules();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.SaleExists.selector, address(l)));
        rvfU.setRules(address(clfU), salt, r);
        assertFalse(rvfU.rulesSet(address(l)));
        uint256 need = l.costToComplete();
        vm.startPrank(bob);
        IERC20F(USD).approve(address(l), need);
        l.complete(need);
        vm.stopPrank();
        (address token,, address vault) = l.launchInfo();
        RulesVault s = RulesVault(payable(vault));
        assertEq(s.ruleCount(), 1);
        (IRuleSplitter.Kind k, uint16 b, address t) = s.rule(0);
        assertTrue(k == IRuleSplitter.Kind.PILE && b == 10_000 && t == rvfU.pileOf(token), "PILE 100% for good");
        uint256 income = s.pending();
        s.distribute();
        assertEq(PileVault(payable(rvfU.pileOf(token))).pile(), income, "the pile gets everything");
    }

    /// The texts a buyer reads on Flap say what happens on a rules sale.
    function test_texts_sayTheRules() public {
        bytes32 salt = _mineSalt(keccak256("rules-text"));
        uint256 fee = clfU.creationFee();
        vm.prank(creator);
        address l = portal.newLauncher{value: fee}(address(clfU), abi.encode(_cfg(salt, true)));
        string memory d = ILauncherDescription(l).description();
        assertTrue(_contains(d, "shared by the creator's rules"), "the Launcher's description");
        assertFalse(_contains(d, "tax fill a pile"), "no pile-only claim");
        assertLt(bytes(d).length, 4096, "the Portal stores it only under 4 KB");
        console2.log("Launcher description bytes", bytes(d).length);
        assertTrue(_contains(clfU.launcherDataSchema().description, "shared by the"), "the factory's form");
        assertTrue(_contains(clfN.launcherDataSchema().description, "shared by the"), "the native factory's form");
    }

    function _contains(string memory h, string memory n) internal pure returns (bool) {
        bytes memory hb = bytes(h);
        bytes memory nb = bytes(n);
        if (nb.length > hb.length) return false;
        for (uint256 i; i <= hb.length - nb.length; ++i) {
            bool m = true;
            for (uint256 j; j < nb.length && m; ++j) {
                if (hb[i + j] != nb[j]) m = false;
            }
            if (m) return true;
        }
        return false;
    }

    /// Create then rules in BNB: refused, and the pile gets everything.
    function test_bnb_createThenRules_refused_pileTakesAll() public {
        bytes32 salt = _mineSalt(keccak256("rules-bnb-late"));
        uint256 fee = clfN.creationFee();
        vm.prank(creator);
        CurveLauncher l = CurveLauncher(payable(portal.newLauncher{value: fee}(address(clfN), abi.encode(_cfg(salt, false)))));
        IRuleSplitter.Rule[] memory r = _rules();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.SaleExists.selector, address(l)));
        rvfN.setRules(address(clfN), salt, r);
        uint256 need = l.costToComplete();
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        l.complete{value: need}();
        (address token,, address vault) = l.launchInfo();
        RulesVault s = RulesVault(payable(vault));
        assertEq(s.ruleCount(), 1);
        (IRuleSplitter.Kind k, uint16 b,) = s.rule(0);
        assertTrue(k == IRuleSplitter.Kind.PILE && b == 10_000);
        uint256 income = s.pending();
        s.distribute();
        assertEq(PileVault(payable(rvfN.pileOf(token))).pile(), income, "the pile gets everything");
    }

    /// Rules for a launcher factory that does not name this vault factory are refused (they would never be used).
    function test_setRules_unpairedLauncherFactory_refused() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.NotPaired.selector, address(clfN)));
        rvfU.setRules(address(clfN), keccak256("x"), _rules());
    }

    // ── the same in BNB ───────────────────────────────────────────────────────

    function test_bnb_rulesThenCreate_threeEffects() public {
        bytes32 salt = _mineSalt(keccak256("rules-bnb"));
        vm.prank(creator);
        rvfN.setRules(address(clfN), salt, _rules());
        uint256 fee = clfN.creationFee();
        vm.prank(creator);
        CurveLauncher l = CurveLauncher(payable(portal.newLauncher{value: fee}(address(clfN), abi.encode(_cfg(salt, false)))));
        vm.prank(alice);
        l.buy{value: 1 ether}(0);
        uint256 need = l.costToComplete();
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        l.complete{value: need}();
        (address token,, address vault) = l.launchInfo();
        RulesVault s = RulesVault(payable(vault));
        assertEq(s.asset(), address(0));
        vm.prank(alice);
        l.claim();
        // trades in BNB until the vault share waits, then dispatch
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
        assertGt(ITaxProcessorF(proc).marketQuoteBalance(), 0);
        ITaxProcessorF(proc).dispatch();
        _distributeBnb(token, s);
    }

    function _distributeBnb(address token, RulesVault s) internal {
        uint256 income = s.pending();
        uint256 c0 = payee.balance;
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        s.distribute();
        assertEq(payee.balance - c0, income * 2000 / 10_000, "the creator paid in BNB");
        assertEq(PileVault(payable(rvfN.pileOf(token))).pile(), income * 5000 / 10_000, "the pile grown");
        assertGt(IERC20F(token).balanceOf(DEAD) - dead0, 0, "tokens at the dead address");
        assertEq(address(s).balance, 0);
        emit log_named_uint("BNB income shared (wei)", income);
    }

    /// Every contract of the real deployment fits the chain's contract size limit (24,576 bytes).
    function test_sizes_withinTheLimit() public view {
        assertLe(address(rvfU).code.length, 24_576, "RulesVaultFactory");
        assertLe(address(clfU).code.length, 24_576, "TokenCurveLauncherFactory");
        assertLe(address(clfN).code.length, 24_576, "CurveLauncherFactory");
        assertLe(clfU.implementation().code.length, 24_576, "TokenCurveLauncher, the text-only copy");
        assertLe(clfN.implementation().code.length, 24_576, "CurveLauncher, the text-only copy");
        assertLe(address(rvfU.pileDeployer()).code.length, 24_576, "PileDeployer");
        assertLe(address(rvfU.rulesDeployer()).code.length, 24_576, "RulesVaultDeployer");
    }

    function test_setRules_refusals() public {
        bytes32 salt = keccak256("any");
        IRuleSplitter.Rule[] memory r = _rules();
        r[1].target = address(0xBEEF);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.InvalidRules.selector, "one pile, target filled at launch"));
        rvfU.setRules(address(clfU), salt, r);
        r = _rules();
        r[0].bps = 1999;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.InvalidRules.selector, "parts must sum to 10000"));
        rvfU.setRules(address(clfU), salt, r);
        vm.prank(creator);
        rvfU.setRules(address(clfU), salt, _rules());
        address launcher = clfU.predictLauncher(creator, salt);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.RulesAlreadySet.selector, launcher));
        rvfU.setRules(address(clfU), salt, _rules());
        // another account's call stores rules for ITS launcher, never for the creator's
        vm.prank(alice);
        address other = rvfU.setRules(address(clfU), salt, _rules());
        assertTrue(other != launcher);
        assertEq(rvfU.rulesOf(launcher).length, 3);
    }
}
