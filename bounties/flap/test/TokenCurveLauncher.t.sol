// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {Math} from "@openzeppelin/utils/math/Math.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {IPortalTypes} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {IStrategy} from "src/flap/IStrategy.sol";
import {LauncherRecord} from "src/flap/ILauncher.sol";
import {CurveConfig} from "../src/CurveLauncher.sol";
import {TokenCurveLauncher} from "../src/TokenCurveLauncher.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";
import {PileVault} from "../src/PileVault.sol";
import {MockToken20} from "./CurveLauncher.t.sol";

/// @dev Stands in for the Portal with an ERC-20 quote: the salt lock, the quote config, and a launch that pulls the
/// pool's quote from the Launcher by transferFrom (value must be 0), creates the vault through the vault factory,
/// mints the distribution and calls the strategy callback.
contract MockHubT {
    uint256 public constant SALT_LOCK_FEE = 0.005 ether;
    address public quoteEnabled;
    address public token; // the token the launch mints (etched at the predicted address by the test)
    address public vaultFactory;
    address public vault;
    bool public createVault = true;

    constructor(address q) {
        quoteEnabled = q;
    }

    function setQuoteEnabled(address q) external {
        quoteEnabled = q;
    }

    function lockSalt(bytes32, uint8) external payable {
        require(msg.value == SALT_LOCK_FEE, "fee");
    }

    function launchQuoteConfig(uint8, address q) external view returns (bool, uint256) {
        return (q == quoteEnabled, 1e18);
    }

    function setLaunch(address token_, address vf, address vault_, bool create) external {
        token = token_;
        vaultFactory = vf;
        vault = vault_;
        createVault = create;
    }

    function getLauncher(address) external pure returns (LauncherRecord memory r) {
        return r;
    }

    function getLaunchVault(address) external view returns (address, address) {
        return (vault, vaultFactory);
    }

    function launchTaxTokenV2(
        IPortalTypes.CreateTaxTokenParams calldata p,
        Distribution calldata d,
        IPortalTypes.CreatorBuyParams calldata
    ) external payable returns (address, address) {
        require(msg.value == 0, "value");
        require(p.quoteToken == quoteEnabled, "quote");
        MockToken20(p.quoteToken).transferFrom(msg.sender, address(this), p.poolQuote);
        if (createVault) TokenPileVaultFactory(vaultFactory).newVault(token, msg.sender, 0, abi.encode(p, d));
        MockToken20(token).mint(address(this), d.amount);
        MockToken20(token).approve(msg.sender, d.amount);
        IStrategy(msg.sender).initializeDistribution(token, d.amount, "", bytes32(0));
        return (token, address(0x9001));
    }
}

/// @notice The token-quote curve sale without a chain: exact pulls and payments, no change, no native coin, the
/// launch with its approval set back to zero, the unwind, refusals of a quote that takes a cut.
contract TokenCurveLauncherTest is Test {
    MockToken20 usd;
    MockHubT hub;
    TokenPileVaultFactory pvf;
    TokenCurveLauncher impl;
    address constant TOKEN_IMPL = address(0x7777c57ff7dc441c1715b2e36fa581c48B782222);
    address creator = address(0xC0DE0001);
    address alice = address(0xC0DE0002);
    address bob = address(0xC0DE0003);

    uint256 constant X0 = 11_600 ether;
    uint256 constant T = 1_700 ether;
    uint256 constant S = 600_000_000 ether;

    function setUp() public {
        usd = new MockToken20();
        hub = new MockHubT(address(usd));
        pvf = new TokenPileVaultFactory(address(hub), address(usd));
        impl = new TokenCurveLauncher(address(hub), address(pvf), TOKEN_IMPL, address(usd));
        address[3] memory who = [creator, alice, bob];
        for (uint256 i; i < 3; ++i) usd.mint(who[i], 10_000 ether);
    }

    function _cfg() internal pure returns (CurveConfig memory c) {
        c.name = "Curve USD";
        c.symbol = "CUSD";
        c.salt = bytes32(uint256(2));
        c.saleTokens = S;
        c.targetRaise = T;
        c.virtualBnb = X0;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    function _new() internal returns (TokenCurveLauncher l) {
        l = TokenCurveLauncher(LibClone.clone(address(impl)));
        vm.deal(address(this), 1 ether);
        l.initialize{value: 0.005 ether}(creator, _cfg());
    }

    function _R(uint256 s) internal pure returns (uint256) {
        uint256 y0 = Math.mulDiv(X0 + T, S, T);
        return Math.mulDiv(X0, y0, y0 - s, Math.Rounding.Up) - X0;
    }

    function _fee(uint256 a) internal pure returns (uint256) {
        return Math.mulDiv(a, 100, 10_000, Math.Rounding.Up);
    }

    function _check(TokenCurveLauncher l) internal view {
        assertEq(l.curveBalance(), _R(l.sold()), "curve holds R(sold)");
        assertEq(usd.balanceOf(address(l)), l.curveBalance() + l.feePot(), "quote balance = curve + fees");
    }

    function _buy(TokenCurveLauncher l, address who, uint256 maxCost) internal returns (uint256 spent) {
        uint256 b0 = usd.balanceOf(who);
        vm.startPrank(who);
        usd.approve(address(l), maxCost);
        l.buy(maxCost, 0);
        vm.stopPrank();
        spent = b0 - usd.balanceOf(who);
    }

    function _launchReady(TokenCurveLauncher l) internal returns (address predicted) {
        predicted = ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, _cfg().salt, address(hub));
        assertEq(l.predictedToken(), predicted);
        vm.etch(predicted, address(new MockToken20()).code);
        hub.setLaunch(predicted, address(pvf), pvf.predictVault(predicted), true);
    }

    // ── exact pulls and payments ──────────────────────────────────────────────

    function test_buy_pullsExactlyCostPlusFee_noChange() public {
        TokenCurveLauncher l = _new();
        (uint256 n, uint256 cost, uint256 fee) = l.quoteBuy(300 ether);
        uint256 spent = _buy(l, alice, 300 ether);
        assertEq(spent, cost + fee, "exactly cost plus fee left the buyer");
        assertEq(cost, _R(n));
        assertEq(fee, _fee(cost));
        assertLe(spent, 300 ether);
        assertEq(usd.allowance(alice, address(l)), 300 ether - spent, "nothing more was pulled");
        assertEq(l.tokensOf(alice), n);
        _check(l);
    }

    function test_buy_respectsMinTokens() public {
        TokenCurveLauncher l = _new();
        (uint256 n,,) = l.quoteBuy(100 ether);
        vm.startPrank(alice);
        usd.approve(address(l), 100 ether);
        vm.expectRevert(abi.encodeWithSelector(TokenCurveLauncher.BelowMinimum.selector, n, n + 1));
        l.buy(100 ether, n + 1);
        vm.stopPrank();
    }

    function test_sell_paysExactly() public {
        TokenCurveLauncher l = _new();
        _buy(l, alice, 300 ether);
        uint256 half = l.tokensOf(alice) / 2;
        (uint256 proceeds, uint256 fee, uint256 paid) = l.quoteSell(half);
        assertEq(proceeds, _R(l.sold()) - _R(l.sold() - half));
        uint256 a0 = usd.balanceOf(alice);
        vm.prank(alice);
        assertEq(l.sell(half, paid), paid);
        assertEq(usd.balanceOf(alice) - a0, paid);
        assertEq(paid, proceeds - fee);
        _check(l);
    }

    function test_quoteTakingACut_isRefused() public {
        TokenCurveLauncher l = _new();
        usd.setFeeBps(1); // transferFrom delivers 0.01% less than asked
        vm.startPrank(alice);
        usd.approve(address(l), 300 ether);
        vm.expectRevert(TokenCurveLauncher.InexactTransfer.selector);
        l.buy(300 ether, 0);
        vm.stopPrank();
    }

    /// The same calls succeed without value and fail with it (controls), and there is no receive.
    function test_noNativeCoin_withControls() public {
        TokenCurveLauncher l = _new();
        _launchReady(l);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        usd.approve(address(l), 100 ether);
        (bool ok,) = address(l).call{value: 1}(abi.encodeCall(TokenCurveLauncher.buy, (100 ether, 0)));
        assertFalse(ok, "buy refuses value");
        (ok,) = address(l).call(abi.encodeCall(TokenCurveLauncher.buy, (100 ether, 0)));
        assertTrue(ok, "control: the same buy without value succeeds");
        (ok,) = address(l).call{value: 1}("");
        assertFalse(ok, "no receive");
        vm.stopPrank();
        uint256 need = l.costToComplete();
        vm.deal(bob, 1 ether);
        vm.startPrank(bob);
        usd.approve(address(l), need);
        (ok,) = address(l).call{value: 1}(abi.encodeCall(TokenCurveLauncher.complete, (need)));
        assertFalse(ok, "complete refuses value");
        (ok,) = address(l).call(abi.encodeCall(TokenCurveLauncher.complete, (need)));
        assertTrue(ok, "control: the same complete without value succeeds");
        vm.stopPrank();
        assertTrue(l.launched());
        assertEq(address(l).balance, 0);
    }

    /// An ordinary buy whose cap exceeds what the rest of the sale costs: exactly the cost of the rest plus fee is
    /// pulled, the unused budget stays with the buyer (and stays approved), and the sale launches.
    function test_buy_unusedBudgetIsNotPulled() public {
        TokenCurveLauncher l = _new();
        _launchReady(l);
        _buy(l, alice, 300 ether);
        uint256 need = l.costToComplete();
        uint256 b0 = usd.balanceOf(bob);
        vm.startPrank(bob);
        usd.approve(address(l), need + 50 ether);
        l.buy(need + 50 ether, 0);
        vm.stopPrank();
        assertEq(b0 - usd.balanceOf(bob), need, "only the cost of the rest left the buyer");
        assertEq(usd.allowance(bob, address(l)), 50 ether, "the unused budget was not pulled");
        assertTrue(l.launched());
        // an absurd cap is clamped to the rest, not an overflow
        (uint256 left,,) = l.quoteBuy(type(uint256).max);
        assertEq(left, 0, "nothing left to sell after the launch");
    }

    /// A cap that would overflow the inverse curve is clamped: quoting the maximum buys exactly the rest.
    function test_quoteBuy_hugeCap_buysTheRest() public {
        TokenCurveLauncher l = _new();
        (uint256 n, uint256 cost, uint256 fee) = l.quoteBuy(type(uint256).max);
        assertEq(n, S);
        assertEq(cost, _R(S));
        assertEq(fee, _fee(_R(S)));
    }

    // ── complete and the launch ───────────────────────────────────────────────

    function test_complete_launches_allowanceZero_feesToThePile() public {
        TokenCurveLauncher l = _new();
        address predicted = _launchReady(l);
        _buy(l, alice, 300 ether);
        usd.mint(address(l), 5 ether); // quote that reached the Launcher unasked
        uint256 need = l.costToComplete();
        uint256 toPile = l.feePot() + _fee(_R(S) - _R(l.sold())) + 5 ether;
        uint256 b0 = usd.balanceOf(bob);
        vm.startPrank(bob);
        usd.approve(address(l), need + 50 ether);
        vm.expectRevert(abi.encodeWithSelector(TokenCurveLauncher.AboveMaximum.selector, need, need - 1));
        l.complete(need - 1);
        l.complete(need + 50 ether);
        vm.stopPrank();
        assertEq(b0 - usd.balanceOf(bob), need, "exactly the cost of the rest");
        assertTrue(l.launched());
        assertEq(usd.allowance(address(l), address(hub)), 0, "no allowance left to the Portal");
        assertEq(usd.balanceOf(address(hub)), l.raiseTarget(), "the Portal pulled exactly the raise");
        address vault = l.pileVault();
        assertEq(vault, pvf.predictVault(predicted));
        assertEq(PileVault(payable(vault)).asset(), address(usd));
        assertEq(PileVault(payable(vault)).pile(), toPile, "fees and surplus to the pile, in the quote");
        assertEq(usd.balanceOf(address(l)), 0);
        uint256 owedAlice = l.tokensOf(alice);
        vm.prank(alice);
        l.claim();
        assertEq(MockToken20(predicted).balanceOf(alice), owedAlice);
    }

    function test_complete_afterASellBack_revertsWhole() public {
        TokenCurveLauncher l = _new();
        _launchReady(l);
        _buy(l, alice, 300 ether);
        uint256 quoted = l.costToComplete();
        uint256 half = l.tokensOf(alice) / 2;
        vm.prank(alice);
        l.sell(half, 0); // lands before bob's complete
        uint256 need = l.costToComplete();
        vm.startPrank(bob);
        usd.approve(address(l), quoted);
        vm.expectRevert(abi.encodeWithSelector(TokenCurveLauncher.AboveMaximum.selector, need, quoted));
        l.complete(quoted);
        vm.stopPrank();
        assertFalse(l.launched());
        assertEq(l.tokensOf(bob), 0, "no partial buy");
    }

    /// The completion became cheaper between quote and send (someone bought in between): it pulls only the new,
    /// lower cost; the rest of the approval stays unused.
    function test_complete_cheaperThanQuoted_pullsOnlyTheNewCost() public {
        TokenCurveLauncher l = _new();
        _launchReady(l);
        _buy(l, alice, 300 ether);
        uint256 quoted = l.costToComplete();
        _buy(l, alice, 100 ether); // lands before bob's complete
        uint256 need = l.costToComplete();
        assertLt(need, quoted);
        uint256 b0 = usd.balanceOf(bob);
        vm.startPrank(bob);
        usd.approve(address(l), quoted);
        l.complete(quoted);
        vm.stopPrank();
        assertEq(b0 - usd.balanceOf(bob), need, "pulled the new cost");
        assertEq(usd.allowance(bob, address(l)), quoted - need);
        assertTrue(l.launched());
    }

    function test_launch_vaultWithoutCode_isRefused() public {
        TokenCurveLauncher l = _new();
        address predicted = _launchReady(l);
        hub.setLaunch(predicted, address(pvf), pvf.predictVault(predicted), false);
        uint256 need = l.costToComplete();
        vm.startPrank(bob);
        usd.approve(address(l), need);
        vm.expectRevert(abi.encodeWithSelector(TokenCurveLauncher.LaunchMismatch.selector, "vault"));
        l.complete(need);
        vm.stopPrank();
    }

    // ── the miss ──────────────────────────────────────────────────────────────

    function test_unwind_netDepositsWhenNobodySoldAtAProfit() public {
        TokenCurveLauncher l = _new();
        uint256 netA = _buy(l, alice, 300 ether);
        uint256 netB = _buy(l, bob, 200 ether);
        uint256 half = l.tokensOf(alice) / 2;
        uint256 a0 = usd.balanceOf(alice);
        vm.prank(alice);
        l.sell(half, 0);
        netA -= usd.balanceOf(alice) - a0;
        vm.warp(l.deadline());
        assertEq(usd.balanceOf(address(l)), netA + netB);
        uint256 b1 = usd.balanceOf(bob);
        vm.prank(bob);
        l.unwind();
        assertEq(usd.balanceOf(bob) - b1, netB);
        uint256 a1 = usd.balanceOf(alice);
        vm.prank(alice);
        l.unwindTo(alice);
        assertEq(usd.balanceOf(alice) - a1, netA);
        assertEq(usd.balanceOf(address(l)), 0);
        assertEq(l.progress().curveBalance, 0);
    }

    /// Alice sells back at a profit after bob's and carol's buys; on the miss bob and carol share the balance in
    /// proportion to what each is owed, to the last unit, the last one emptying it (the native rule).
    function test_unwind_shortfallAfterAProfitableSeller_isProportional() public {
        TokenCurveLauncher l = _new();
        address carol = address(0xC0DE0004);
        usd.mint(carol, 10_000 ether);
        _buy(l, alice, 300 ether);
        uint256 ob = _buy(l, bob, 600 ether);
        uint256 oc = _buy(l, carol, 300 ether);
        uint256 all = l.tokensOf(alice);
        vm.prank(alice);
        l.sell(all, 0);
        assertEq(l.owed(alice), 0, "alice took out more than she put in");
        vm.warp(l.deadline());
        uint256 pot = usd.balanceOf(address(l));
        assertLt(pot, ob + oc, "the Launcher is short of the others' nets");
        uint256 b0 = usd.balanceOf(bob);
        vm.prank(bob);
        uint256 pb = l.unwind();
        assertEq(pb, pot * ob / (ob + oc));
        assertEq(usd.balanceOf(bob) - b0, pb);
        uint256 c0 = usd.balanceOf(carol);
        vm.prank(carol);
        uint256 pc = l.unwind();
        assertEq(pc, pot - pb, "the last one owed empties it");
        assertEq(usd.balanceOf(carol) - c0, pc);
        assertEq(usd.balanceOf(address(l)), 0);
        vm.prank(alice);
        vm.expectRevert(TokenCurveLauncher.NothingToUnwind.selector);
        l.unwind();
    }

    // ── the factory ───────────────────────────────────────────────────────────

    function test_factories_refuseAQuoteThePortalHasNotEnabled() public {
        MockToken20 other = new MockToken20();
        try new TokenPileVaultFactory(address(hub), address(other)) returns (TokenPileVaultFactory) {
            revert("accepted a quote the Portal has not enabled");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(TokenPileVaultFactory.QuoteNotEnabled.selector, address(other)));
        }
        TokenCurveLauncherFactory f = new TokenCurveLauncherFactory(address(hub), address(pvf), TOKEN_IMPL);
        assertEq(f.quote(), address(usd));
        // the launcher factory refuses too, once the Portal no longer enables the quote
        hub.setQuoteEnabled(address(other));
        try new TokenCurveLauncherFactory(address(hub), address(pvf), TOKEN_IMPL) returns (TokenCurveLauncherFactory) {
            revert("the launcher factory accepted a disabled quote");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(TokenCurveLauncherFactory.QuoteNotEnabled.selector));
        }
        hub.setQuoteEnabled(address(usd));
        assertTrue(pvf.isQuoteTokenSupported(address(usd)));
        assertFalse(pvf.isQuoteTokenSupported(address(0)));
        assertFalse(pvf.isQuoteTokenSupported(address(other)));
    }

    receive() external payable {}
}
