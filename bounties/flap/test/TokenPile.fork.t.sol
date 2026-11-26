// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PileForkBase, IERC20F, ITaxTokenF, ITaxProcessorF} from "./PileForkBase.sol";
import {CurveConfig} from "../src/CurveLauncher.sol";
import {TokenCurveLauncher} from "../src/TokenCurveLauncher.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {PileVault} from "../src/PileVault.sol";

interface IAllowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface ITestUsd {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
}

interface IRouterT {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice The curve sale with Flap's test USDT as the quote, against the live test network Portal and the real test
/// USDT (minted through its public mint inside the fork): created through Portal.newLauncher, buy, sell back,
/// complete, claims, pool trades on the token/USD pair, the tax reaching the pile in USD, a redemption; and the miss.
contract TokenPileForkTest is PileForkBase {
    address constant USD = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;

    TokenPileVaultFactory pvf;
    TokenCurveLauncherFactory clf;

    function setUp() public {
        if (!_forkSetUp()) return;
        pvf = new TokenPileVaultFactory(PORTAL, USD);
        clf = new TokenCurveLauncherFactory(PORTAL, address(pvf), TOKEN_IMPL);
        address[4] memory who = [creator, alice, bob, trader];
        for (uint256 i; i < 4; ++i) ITestUsd(USD).mint(who[i], 100_000 ether);
    }

    function _config(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c.name = "Curve USD Pile";
        c.symbol = "UPILE";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 1_700 ether; // in test USDT
        c.virtualBnb = 11_600 ether; // virtual USDT
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    function _createViaPortal(CurveConfig memory c) internal returns (TokenCurveLauncher l) {
        uint256 v = clf.creationFee();
        vm.prank(creator);
        l = TokenCurveLauncher(portal.newLauncher{value: v}(address(clf), abi.encode(c)));
    }

    function _buy(TokenCurveLauncher l, address who, uint256 maxCost) internal returns (uint256 spent) {
        uint256 b0 = IERC20F(USD).balanceOf(who);
        vm.startPrank(who);
        IERC20F(USD).approve(address(l), maxCost);
        l.buy(maxCost, 0);
        IERC20F(USD).approve(address(l), 0);
        vm.stopPrank();
        spent = b0 - IERC20F(USD).balanceOf(who);
    }

    function _swap(address from, address to, uint256 amount) internal {
        IERC20F(from).approve(ROUTER, amount);
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        IRouterT(ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, trader, block.timestamp + 600);
    }

    function test_quote_isEnabledOnThePortal() public view {
        assertEq(ITestUsd(USD).decimals(), 18);
        assertEq(clf.quote(), USD);
        assertTrue(pvf.isQuoteTokenSupported(USD));
        assertFalse(pvf.isQuoteTokenSupported(address(0)));
    }

    function test_portal_completeLaunch_inTestUsd() public {
        bytes32 salt = _mineSalt(keccak256("usd-portal"));
        TokenCurveLauncher l = _createViaPortal(_config(salt));
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(clf), "recorded by the Portal");
        assertEq(address(l).balance, 0, "no native coin held");

        // buy, sell back half
        uint256 spentA = _buy(l, alice, 300 ether);
        assertGt(spentA, 0);
        uint256 half = l.tokensOf(alice) / 2;
        (,, uint256 paid) = l.quoteSell(half);
        uint256 a0 = IERC20F(USD).balanceOf(alice);
        vm.prank(alice);
        l.sell(half, paid);
        assertEq(IERC20F(USD).balanceOf(alice) - a0, paid, "sell-back paid exactly");
        assertEq(IERC20F(USD).balanceOf(address(l)), l.curveBalance() + l.feePot());

        // complete: exactly the cost of the rest, approval for exactly that
        uint256 need = l.costToComplete();
        uint256 feesAtLaunch = l.feePot() + (need - (l.raiseTarget() - l.curveBalance()));
        uint256 b0 = IERC20F(USD).balanceOf(bob);
        vm.startPrank(bob);
        IERC20F(USD).approve(address(l), need);
        l.complete(need);
        vm.stopPrank();
        assertEq(b0 - IERC20F(USD).balanceOf(bob), need, "complete pulled exactly the cost of the rest");
        assertEq(IAllowance(USD).allowance(bob, address(l)), 0);
        assertTrue(l.launched());

        (address token, address pool, address vault) = l.launchInfo();
        assertEq(uint16(uint160(token)), 0x7777);
        assertEq(token, clf.predictToken(salt));
        assertEq(IAllowance(USD).allowance(address(l), PORTAL), 0, "no allowance left to the Portal");
        assertEq(IERC20F(USD).balanceOf(pool), l.raiseTarget(), "the pool holds the raise in USD");
        assertEq(IERC20F(token).balanceOf(pool), l.poolToken());
        _assertLpBurned(pool);
        assertEq(vault, pvf.predictVault(token));
        assertEq(PileVault(payable(vault)).asset(), USD);
        assertEq(PileVault(payable(vault)).pile(), feesAtLaunch, "the curve fees are the pile's first money, in USD");
        assertEq(IERC20F(USD).balanceOf(address(l)), 0);
        emit log_named_uint("raise (USD wei)", l.raiseTarget());
        emit log_named_uint("pile at launch (USD wei)", feesAtLaunch);

        // claims
        address[2] memory who = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            uint256 owedT = l.tokensOf(who[i]);
            vm.prank(who[i]);
            l.claim();
            assertEq(IERC20F(token).balanceOf(who[i]), owedT);
        }

        // pool trades on the token/USD pair until the tax is liquidated, then dispatch: the pile grows in USD
        address proc = ITaxTokenF(token).taxProcessor();
        vm.warp(block.timestamp + 601);
        vm.startPrank(trader);
        _swap(USD, token, 200 ether);
        for (uint256 i; i < 80 && !_liquidated(proc); ++i) {
            uint256 amt = IERC20F(token).balanceOf(trader) * 30 / 100;
            if (amt == 0) break;
            uint256 u0 = IERC20F(USD).balanceOf(trader);
            _swap(token, USD, amt);
            uint256 got = IERC20F(USD).balanceOf(trader) - u0;
            if (got > 0) _swap(USD, token, got * 90 / 100);
        }
        vm.stopPrank();
        assertTrue(_liquidated(proc), "tax liquidated into the processor");
        PileVault pv = PileVault(payable(vault));
        uint256 pileBefore = pv.pile();
        uint256 vaultShare = ITaxProcessorF(proc).marketQuoteBalance();
        emit log_named_uint("processor market bucket (USD wei)", vaultShare);
        assertGt(vaultShare, 0, "a positive vault share is waiting");
        ITaxProcessorF(proc).dispatch();
        assertEq(pv.pile() - pileBefore, vaultShare, "the pile grew by exactly the vault slot's share, in USD");

        // redeem: paid in USD to the last unit
        uint256 amount = IERC20F(token).balanceOf(alice);
        uint256 pile = pv.pile();
        uint256 circ = pv.circulatingSupply();
        uint256 expected = pile * amount / circ;
        uint256 u1 = IERC20F(USD).balanceOf(alice);
        vm.startPrank(alice);
        IERC20F(token).approve(vault, amount);
        assertEq(pv.redeem(amount, expected), expected);
        vm.stopPrank();
        assertEq(IERC20F(USD).balanceOf(alice) - u1, expected, "paid in USD to the last unit");
        assertEq(pv.pile(), pile - expected);
        emit log_named_uint("redeemed for (USD wei)", expected);
    }

    function test_missedDeadline_unwindsInUsd() public {
        bytes32 salt = _mineSalt(keccak256("usd-miss"));
        TokenCurveLauncher l = _createViaPortal(_config(salt));
        uint256 netA = _buy(l, alice, 400 ether);
        uint256 netB = _buy(l, bob, 250 ether);
        vm.warp(l.deadline());
        uint256 a0 = IERC20F(USD).balanceOf(alice);
        vm.prank(alice);
        l.unwind();
        uint256 b0 = IERC20F(USD).balanceOf(bob);
        vm.prank(bob);
        l.unwind();
        assertEq(IERC20F(USD).balanceOf(alice) - a0, netA);
        assertEq(IERC20F(USD).balanceOf(bob) - b0, netB);
        assertEq(IERC20F(USD).balanceOf(address(l)), 0);
        assertEq(clf.predictToken(salt).code.length, 0, "no token was created");
    }

    function test_floor_inUsd() public {
        bytes32 salt = _mineSalt(keccak256("usd-floor"));
        CurveConfig memory c = _config(salt);
        (, uint256 raise, uint256 pt, uint256 total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (uint256 usd, uint256 req) = clf.liquidityFloor(raise, pt, total, false); // the direct route, as called below
        emit log_named_uint("1700 USD raise, quote USD (wad)", usd);
        emit log_named_uint("required USD (wad)", req);
        assertGe(usd, req);
        c.targetRaise = 1_400 ether;
        (, raise, pt, total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (usd, req) = clf.liquidityFloor(raise, pt, total, false);
        assertLt(usd, req);
        uint256 v = clf.creationFee();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TokenCurveLauncherFactory.BelowLiquidityFloor.selector, usd, req));
        clf.createLauncher{value: v}(c);
        // a raise a standard V2 pair could not hold as a reserve is refused at creation
        c = _config(salt);
        c.targetRaise = uint256(type(uint112).max) + 1;
        c.virtualBnb = c.targetRaise * 7;
        vm.expectRevert(abi.encodeWithSelector(TokenCurveLauncherFactory.InvalidConfig.selector, "raise above a V2 reserve"));
        clf.checkConfig(c, false);
    }
}
