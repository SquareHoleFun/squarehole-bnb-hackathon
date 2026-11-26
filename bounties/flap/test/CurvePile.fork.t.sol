// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PileForkBase, IERC20F, IPortalFloorLike} from "./PileForkBase.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {PileVault} from "../src/PileVault.sol";
import {CurveLauncherFactory} from "../src/CurveLauncherFactory.sol";
import {CurveLauncher, CurveConfig} from "../src/CurveLauncher.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";

/// @notice The curve sale against the live BNB test network Portal: the complete launch both ways (directly, and
/// through `Portal.newLauncher`), the unwind of a missed deadline, the floor refusal, and the fixed rules.
contract CurvePileForkTest is PileForkBase {
    PileVaultFactory pvf;
    CurveLauncherFactory clf;

    uint256 constant FIRST_BUY = 0.05 ether;

    function setUp() public {
        if (!_forkSetUp()) return;
        pvf = new PileVaultFactory(PORTAL);
        clf = new CurveLauncherFactory(PORTAL, address(pvf), TOKEN_IMPL);
    }

    function _config(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c.name = "Curve Pile Test";
        c.symbol = "CPILE";
        c.meta = "";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 2.6 ether;
        c.virtualBnb = 10 ether;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000; // 20% of the tax burned, 80% into the pile
        c.taxDuration = 365 days;
    }

    function _createDirect(CurveConfig memory c) internal returns (CurveLauncher l) {
        uint256 v = clf.creationFee() + FIRST_BUY;
        vm.prank(creator);
        l = CurveLauncher(payable(clf.createLauncher{value: v}(c)));
    }

    function _createViaPortal(CurveConfig memory c) internal returns (CurveLauncher l) {
        uint256 v = clf.creationFee() + FIRST_BUY;
        vm.prank(creator);
        l = CurveLauncher(payable(portal.newLauncher{value: v}(address(clf), abi.encode(c))));
    }

    function _assertCurveExact(CurveLauncher l) internal view {
        assertEq(l.curveBalance(), CurveMath.reserve(10 ether, l.virtualTokens(), l.sold()), "curve holds R(sold)");
        assertEq(address(l).balance, l.curveBalance() + l.feePot(), "balance = curve + fees");
    }

    /// @dev The curve trades, the graduating buy, the launch checks, the claims. Returns the token.
    function _saleAndLaunch(CurveLauncher l, bytes32 salt) internal returns (address token) {
        return _saleAndLaunch(l, salt, false);
    }

    /// @dev `atomic`: the last step is `complete()` (launch or revert), as the real run does; else a plain `buy`.
    function _saleAndLaunch(CurveLauncher l, bytes32 salt, bool atomic) internal returns (address token) {
        assertEq(l.phase(), 0);
        assertGt(l.tokensOf(creator), 0, "the creator's first buy");
        vm.prank(alice);
        l.buy{value: 1 ether}(0);
        uint256 back = l.tokensOf(alice) / 4;
        vm.prank(alice);
        l.sell(back, 0); // sold back along the same curve before the launch
        _assertCurveExact(l);

        uint256 budget = l.costToComplete() + 0.1 ether;
        (uint256 t,, uint256 fee, uint256 refund) = l.quoteBuy(budget);
        uint256 feesAtLaunch = l.feePot() + fee;
        uint256 b0 = bob.balance;
        vm.prank(bob);
        if (atomic) assertEq(l.complete{value: budget}(), t); // launch or revert
        else assertEq(l.buy{value: budget}(0), t); // takes the last sale token: launches in this transaction
        assertEq(b0 - bob.balance, budget - refund, "bob paid what the curve took, the rest came back");
        assertGe(refund, 0.1 ether);

        token = _assertLaunched(l, salt, feesAtLaunch);
        _claims(l, token);
    }

    function _assertLaunched(CurveLauncher l, bytes32 salt, uint256 feesAtLaunch) internal returns (address token) {
        assertTrue(l.launched());
        assertEq(l.phase(), 1);
        uint256 raise = l.raiseTarget();
        (address token_, address pool, address vault) = l.launchInfo();
        token = token_;
        assertEq(uint16(uint160(token)), 0x7777, "token ends in 7777");
        assertEq(token, clf.predictToken(salt), "token at the predicted address");
        assertEq(address(l).balance, 0, "the Launcher kept no BNB");
        assertEq(IERC20F(token).totalSupply(), l.totalSupply(), "supply = sale tokens + pool tokens");

        // the pool: exactly the raise and exactly the pool's tokens, i.e. the curve's final price; LP burned
        assertEq(IERC20F(WBNB).balanceOf(pool), raise, "pool BNB = the raise");
        assertEq(IERC20F(token).balanceOf(pool), l.poolToken(), "pool tokens");
        (,, uint256 finalPrice) = l.prices();
        assertApproxEqRel(raise * 1e18 / l.poolToken(), finalPrice, 1e9, "pool opens at the curve's final price");
        _assertLpBurned(pool);

        // the vault: this token's PileVault; the curve fees are its first money
        (address v, address vf) = portal.getLaunchVault(token);
        assertEq(vf, address(pvf));
        assertEq(v, vault);
        assertEq(vault, pvf.predictVault(token, address(0)));
        assertEq(PileVault(payable(vault)).pile(), feesAtLaunch, "pile starts with the curve fees, to the wei");
        emit log_named_uint("pile at launch (curve fees)", feesAtLaunch);
        emit log_named_uint("raise (pool BNB)", raise);
        emit log_named_uint("pool tokens", l.poolToken());
        emit log_named_uint("total supply", l.totalSupply());
    }

    function _claims(CurveLauncher l, address token) internal {
        // claims: one for one with what was bought
        assertEq(IERC20F(token).balanceOf(address(l)), l.config().saleTokens);
        address[3] memory who = [creator, alice, bob];
        for (uint256 i; i < 3; ++i) {
            uint256 owed = l.tokensOf(who[i]);
            vm.prank(who[i]);
            l.claim();
            assertEq(IERC20F(token).balanceOf(who[i]), owed);
        }
        assertEq(IERC20F(token).balanceOf(address(l)), 0, "every sale token claimed, none stranded");
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.NothingToClaim.selector);
        l.claim();
        vm.prank(trader);
        vm.expectRevert(CurveLauncher.SaleClosed.selector);
        l.buy{value: 0.01 ether}(0);
    }

    // ── the complete launch, directly ─────────────────────────────────────────

    function test_direct_completeLaunch() public {
        bytes32 salt = _mineSalt(keccak256("curve-direct"));
        CurveLauncher l = _createDirect(_config(salt));
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(0), "a direct Launcher is not recorded");
        address token = _saleAndLaunch(l, salt);
        _tradeDispatchRedeem(token, l.pileVault(), alice);
    }

    // ── the complete launch, through Portal.newLauncher ───────────────────────

    function test_portal_enabled_completeLaunch() public {
        // stand in for Flap: enable the factory (as their own fork tests do), with creation paused for everyone else
        vm.startPrank(admin);
        portal.setCreationPaused(true);
        portal.setLauncherFactoryMultiplier(address(clf), 10_000, true);
        vm.stopPrank();
        bytes32 salt = _mineSalt(keccak256("curve-portal"));
        CurveLauncher l = _createViaPortal(_config(salt));
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(clf), "the Portal recorded the Launcher");
        assertEq(l.creator(), creator);
        address token = _saleAndLaunch(l, salt);
        _tradeDispatchRedeem(token, l.pileVault(), bob);
    }

    /// Finding (25 Nov 2026): with creation open, as on the test network today (featureFlags 0), the Portal records
    /// a Launcher from a factory Flap has NOT enabled, and the whole journey completes.
    function test_portal_openCreation_notEnabled_completeLaunch() public {
        assertEq(portal.featureFlags() & 1, 0, "creation is open on the test network");
        (bool enabled,) = IPortalFloorLike(PORTAL).launcherFactoryMultiplier(address(clf));
        assertFalse(enabled);
        bytes32 salt = _mineSalt(keccak256("curve-open"));
        CurveLauncher l = _createViaPortal(_config(salt));
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(clf));
        address token = _saleAndLaunch(l, salt, true); // the demo path: Portal.newLauncher, then complete()
        _tradeDispatchRedeem(token, l.pileVault(), creator);
    }

    /// Observed on a fork (25 Nov 2026), contrary to the docs: after the admin pauses creation, a Launcher from a
    /// factory Flap has NOT enabled is still recorded and still launches. Pinned so a change on Flap's side shows.
    function test_portal_paused_observed_notEnabledStillLaunches() public {
        vm.prank(admin);
        portal.setCreationPaused(true);
        assertEq(portal.featureFlags() & 1, 1, "creation paused");
        (bool enabled,) = IPortalFloorLike(PORTAL).launcherFactoryMultiplier(address(clf));
        assertFalse(enabled, "the factory is not enabled");
        bytes32 salt = _mineSalt(keccak256("curve-paused"));
        CurveLauncher l = _createViaPortal(_config(salt));
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(clf), "recorded although not enabled");
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        l.buy{value: budget}(0);
        assertTrue(l.launched());
        assertEq(IERC20F(WBNB).balanceOf(l.pool()), l.raiseTarget(), "and the pool holds the raise");
    }

    // ── if Flap lowers the floor for our factories ─────────────────────────────

    function _smallConfig(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c = _config(salt);
        c.targetRaise = 0.05 ether;
        c.virtualBnb = 0.2 ether;
    }

    /// With the Launcher factory enabled at multiplier 0, a 0.05 BNB sale through Portal.newLauncher passes the
    /// creation check and launches (the floor is gone for it); without it the same sale is refused.
    function test_portal_launcherMultiplierZero_smallSaleLaunches() public {
        bytes32 salt = _mineSalt(keccak256("curve-small-portal"));
        CurveConfig memory c = _smallConfig(salt);
        (, uint256 raise, uint256 pt, uint256 total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (uint256 usd, uint256 req) = clf.liquidityFloor(raise, pt, total, true);
        assertLt(usd, req, "refused without Flap");
        vm.prank(admin);
        portal.setLauncherFactoryMultiplier(address(clf), 0, true);
        (usd, req) = clf.liquidityFloor(raise, pt, total, true);
        assertEq(req, 0, "no floor at multiplier 0");
        CurveLauncher l = _createViaPortal(c);
        uint256 budget = l.costToComplete();
        emit log_named_uint("small sale: cost to complete (wei)", budget);
        vm.prank(bob);
        l.buy{value: budget}(0);
        assertTrue(l.launched());
        assertEq(IERC20F(WBNB).balanceOf(l.pool()), l.raiseTarget());
    }

    /// With the vault factory enabled at multiplier 0, the same small sale launches the direct way too.
    function test_direct_vaultMultiplierZero_smallSaleLaunches() public {
        vm.prank(admin);
        portal.setVaultFactoryMultiplier(address(pvf), 0, true);
        bytes32 salt = _mineSalt(keccak256("curve-small-direct"));
        CurveConfig memory c = _smallConfig(salt);
        (, uint256 raise, uint256 pt, uint256 total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (, uint256 req) = clf.liquidityFloor(raise, pt, total, false);
        assertEq(req, 0);
        CurveLauncher l = _createDirect(c);
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        l.buy{value: budget}(0);
        assertTrue(l.launched());
        assertEq(IERC20F(WBNB).balanceOf(l.pool()), l.raiseTarget(), "pool BNB = the raise");
        assertEq(IERC20F(l.token()).balanceOf(l.pool()), l.poolToken(), "pool tokens");
        assertLe(l.raiseTarget() - 0.05 ether, 0.05 ether / 1_000_000, "a 0.05 BNB pool, within the stated tolerance");
    }

    // ── the miss: the sale unwinds ────────────────────────────────────────────

    function test_direct_missedDeadline_unwinds() public {
        bytes32 salt = _mineSalt(keccak256("curve-miss"));
        uint256 c0 = creator.balance;
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        CurveLauncher l = _createDirect(_config(salt));
        vm.prank(alice);
        l.buy{value: 1 ether}(0);
        vm.prank(bob);
        l.buy{value: 0.5 ether}(0);
        _assertCurveExact(l);
        uint256 pot = address(l).balance;

        vm.warp(l.deadline());
        assertEq(l.phase(), 2);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.SaleClosed.selector);
        l.buy{value: 2 ether}(0);

        uint256 paid;
        address[3] memory who = [bob, alice, creator];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            paid += l.unwind();
        }
        assertEq(paid, pot, "the unwind returned every wei the Launcher held");
        assertEq(address(l).balance, 0);
        // each one gets back exactly what it put in, fees included; the creator is out only the salt-lock fee
        assertEq(alice.balance, a0, "alice whole");
        assertEq(bob.balance, b0, "bob whole");
        assertEq(c0 - creator.balance, clf.creationFee(), "the creator is out only the salt-lock fee");
        assertFalse(l.launched());
        assertEq(clf.predictToken(salt).code.length, 0, "no token was created");
    }

    // ── refusals at creation, and fixed rules ─────────────────────────────────

    function test_floor_refusesASaleThatCouldNeverLaunch() public {
        bytes32 salt = _mineSalt(keccak256("curve-floor"));
        CurveConfig memory c = _config(salt);
        (, uint256 raise, uint256 pt, uint256 total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (uint256 usd, uint256 req) = clf.liquidityFloor(raise, pt, total, false);
        emit log_named_uint("2.6 BNB raise, quote USD (wad)", usd);
        emit log_named_uint("2.6 BNB raise, required USD (wad)", req);
        assertGe(usd, req);
        c.targetRaise = 2 ether;
        (, raise, pt, total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (usd, req) = clf.liquidityFloor(raise, pt, total, false);
        assertLt(usd, req);
        uint256 v = clf.creationFee();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.BelowLiquidityFloor.selector, usd, req));
        clf.createLauncher{value: v}(c);
    }

    /// Creation refuses what the Portal would refuse at the launch (bounds measured on this Portal), and a factory
    /// pair that answers to two different hubs.
    function test_creation_refusesWhatCouldNeverLaunch() public {
        // `new` runs through deployCode here, where expectRevert would end the test early: catch and compare.
        PileVaultFactory otherHub = new PileVaultFactory(address(0xBEEF));
        try new CurveLauncherFactory(PORTAL, address(otherHub), TOKEN_IMPL) returns (CurveLauncherFactory) {
            revert("a factory pair with two hubs was accepted");
        } catch (bytes memory err) {
            assertEq(
                err,
                abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "vault factory answers to another hub")
            );
        }

        bytes32 salt = _mineSalt(keccak256("curve-bounds"));
        CurveConfig memory c = _config(salt);
        c.buyTaxBps = 99;
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "a tax below 1% that is not 0"));
        clf.checkConfig(c, false);
        c.buyTaxBps = 0; // 0 is allowed on one side
        clf.checkConfig(c, false);
        c.taxDuration = 1 days - 1;
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "tax duration below one day"));
        clf.checkConfig(c, false);
        c.taxDuration = 1 days;
        clf.checkConfig(c, false);
        // a pool below one whole token (the tested curve with one wei of virtual BNB: 230,769,229 base units)
        c.virtualBnb = 1;
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "pool below one token"));
        clf.checkConfig(c, false);
        // a raise off its target by more than one millionth, everything else in bounds: 100 tokens to 3 wei with one
        // wei of virtual BNB raise 4 wei, with 26.67 tokens in the pool
        c = _config(salt);
        c.saleTokens = 100 ether;
        c.targetRaise = 3;
        c.virtualBnb = 1;
        (, uint256 r4, uint256 pt4,,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        assertEq(r4, 4);
        assertGe(pt4, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "raise off target"));
        clf.checkConfig(c, false);
        // and a sale at exactly the bounds launches on the live Portal
        c = _config(salt);
        c.buyTaxBps = 0;
        c.sellTaxBps = 100;
        c.taxDuration = 1 days;
        CurveLauncher l = _createDirect(c);
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        l.buy{value: budget}(0);
        assertTrue(l.launched());
    }

    function test_rulesCannotChange() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(CurveLauncherFactory.LaunchersAreImmutable.selector);
        clf.upgradeVaultImplementation(address(1));
        vm.prank(GUARDIAN);
        vm.expectRevert(PileVaultFactory.VaultsAreImmutable.selector);
        pvf.upgradeVaultImplementation(address(1));
        vm.expectRevert(abi.encodeWithSelector(LauncherFactoryBase.NotHub.selector, address(this)));
        clf.newLauncher(creator, "");
        bytes32 salt = _mineSalt(keccak256("curve-fixed"));
        CurveLauncher l = _createDirect(_config(salt));
        vm.expectRevert(CurveLauncher.NotFactory.selector);
        l.initialize(alice, _config(salt));
        vm.prank(address(clf));
        vm.expectRevert(CurveLauncher.AlreadyInitialized.selector);
        l.initialize(alice, _config(salt));
        // a salt whose token would not end in 7777 is refused at creation
        CurveConfig memory c = _config(keccak256("not mined"));
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "token address must end in 7777"));
        clf.checkConfig(c, false);
    }
}
