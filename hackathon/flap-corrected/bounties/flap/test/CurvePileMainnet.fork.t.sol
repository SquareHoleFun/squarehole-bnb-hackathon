// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MainnetForkBase, IPortalAdminView} from "./MainnetForkBase.sol";
import {IERC20F, IPortalFloorLike} from "./PileForkBase.sol";
import {IPortalFloor} from "../src/IPortalFloor.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {PileVault} from "../src/PileVault.sol";
import {CurveLauncherFactory} from "../src/CurveLauncherFactory.sol";
import {CurveLauncher, CurveConfig} from "../src/CurveLauncher.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {IAntiScam} from "../src/IAntiScam.sol";
import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";

interface IERC20Name {
    function name() external view returns (string memory);
}

/// @notice Flap pre-audit finding R5: the curve sale with a pile against the BNB Chain Portal at a pinned block, with
/// creation PAUSED as it is there and our launcher factory enabled the way Flap would (MANAGE_ROLE,
/// `setLauncherFactoryMultiplier(factory, m, true)`), once at m = 0 and once at m = 10_000 (the real floor). Create
/// through `Portal.newLauncher`, buys by several buyers, a sell-back, the completing buy that launches, claims,
/// third-party trades that bring in tax, the dispatch to our vault, a redemption; a missed deadline that unwinds; a
/// Launcher not recorded on the Portal whose final buy is refused with CreationPaused; and a factory that is not
/// enabled, refused at the floor. Needs BSC_RPC_URL (see MainnetForkBase); skipped without it.
contract CurvePileMainnetForkTest is MainnetForkBase {
    PileVaultFactory pvf;
    CurveLauncherFactory clf;

    /// @dev The Portal's revert for `newLauncher` through a factory it has not enabled, read from the fork.
    bytes4 constant LAUNCHER_FACTORY_NOT_ENABLED = bytes4(keccak256("LauncherFactoryNotEnabled(address)"));

    struct Gas {
        uint256 completingBuy;
        uint256 claim;
        uint256 redeem;
        uint256 curveSell;
    }

    function setUp() public {
        if (!_forkSetUp()) return;
        (clf, pvf) = _deployCurvePair();
    }

    /// @dev The test network suites' sale: 600M tokens on the curve to 2.6 BNB, 10 BNB virtual.
    function _config(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c.name = "Curve Pile Main";
        c.symbol = "CPMAIN";
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

    /// @dev The same curve at a fifth of the size: a 0.5 BNB raise, far below the real floor.
    function _smallConfig(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c = _config(salt);
        c.targetRaise = 0.5 ether;
        c.virtualBnb = 2 ether;
    }

    function _floorOf(CurveConfig memory c, bool viaPortal) internal view returns (uint256 usd, uint256 req) {
        (, uint256 raise, uint256 pt, uint256 total,,) = clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        (usd, req) = clf.liquidityFloor(raise, pt, total, viaPortal);
    }

    function _assertCurveExact(CurveLauncher l, CurveConfig memory c) internal view {
        assertEq(l.curveBalance(), CurveMath.reserve(c.virtualBnb, l.virtualTokens(), l.sold()), "curve holds R(sold)");
        assertEq(address(l).balance, l.curveBalance() + l.feePot(), "balance = curve + fees");
    }

    // ── what the fork shows ───────────────────────────────────────────────────

    function test_facts_atThePinnedBlock() public {
        assertEq(block.number, FORK_BLOCK);
        assertEq(block.chainid, 56);
        emit log_named_uint("block", block.number);
        emit log_named_uint("block timestamp", block.timestamp);
        emit log_named_string("Portal version", IPortalAdminView(PORTAL).version());
        assertEq(portal.featureFlags(), 1, "creation paused (featureFlags bit 0)");
        emit log_named_uint("featureFlags", portal.featureFlags());
        assertEq(portal.SALT_LOCK_FEE(), 0.005 ether);

        IPortalFloor f = IPortalFloor(PORTAL);
        (bool en, uint256 price) = f.launchQuoteConfig(0, address(0));
        assertTrue(en, "native BNB is a quote");
        emit log_named_uint("native BNB quote price (USD wad)", price);
        (en, price) = f.launchQuoteConfig(0, USDT);
        assertTrue(en, "USDT is a quote");
        assertEq(price, 1 ether);
        (en, price) = f.launchQuoteConfig(0, USD1);
        assertTrue(en, "USD1 is a quote");
        assertEq(price, 1 ether);
        (en,) = f.launchQuoteConfig(0, WBNB);
        assertFalse(en, "WBNB is not a quote (native BNB is)");

        // the floor for a launch from a vault factory that is not enabled, whole supply in the pool and half of it
        (, uint256 bnbPrice) = f.launchQuoteConfig(0, address(0));
        IPortalFloor.GraduationFloorResultV2 memory r = f.graduationFloorV2(
            IPortalFloor.GraduationFloorParams(address(0), bnbPrice, 1 ether, 1e27, 1e27, address(pvf))
        );
        assertEq(r.multiplierBps, 10_000, "a vault factory that is not enabled: 1x");
        emit log_named_uint("create floor, whole supply in the pool (USD wad)", r.createFloorUsdWad);
        r = f.graduationFloorV2(IPortalFloor.GraduationFloorParams(address(0), bnbPrice, 1 ether, 5e26, 1e27, address(pvf)));
        emit log_named_uint("create floor, half the supply in the pool (USD wad)", r.createFloorUsdWad);
        (bool lfEn, uint16 lfM) = IPortalFloorLike(PORTAL).launcherFactoryMultiplier(address(clf));
        assertFalse(lfEn);
        assertEq(lfM, 10_000, "a launcher factory that is not enabled: 1x");

        // this sale's floor at 1x
        (uint256 usd, uint256 req) = _floorOf(_config(bytes32(0)), true);
        emit log_named_uint("2.6 BNB sale: pool value (USD wad)", usd);
        emit log_named_uint("2.6 BNB sale: required (USD wad)", req);
        assertGe(usd, req, "2.6 BNB meets the real floor");
        CurveConfig memory c2 = _config(bytes32(0));
        c2.targetRaise = 2 ether;
        (usd, req) = _floorOf(c2, true);
        assertLt(usd, req, "2.0 BNB does not");

        assertEq(TOKEN_IMPL.code.length > 0, true);
        IPortalAdminView pa = IPortalAdminView(PORTAL);
        assertTrue(pa.hasRole(pa.MANAGE_ROLE(), manager), "we act as the MANAGE_ROLE holder");
        assertFalse(pa.hasRole(bytes32(0), manager), "which is not DEFAULT_ADMIN_ROLE on the main network");
        emit log_named_address("MANAGE_ROLE holder (proxy admin owner)", manager);
        emit log_named_address("Guardian", GUARDIAN);
    }

    // ── the complete journey through Portal.newLauncher ───────────────────────

    /// @dev Create through the Portal with the creator's first buy; alice and carol buy; alice sells a quarter back;
    /// bob's buy completes the sale and launches; everyone claims; a third party trades on the pool; the tax is
    /// dispatched to the pile; alice redeems.
    function _journey(CurveConfig memory c, string memory label) internal {
        CurveLauncher l = _saleUntilLaunch(c);
        (address token, address pool, address vault) = l.launchInfo();
        _assertLaunch(l, c, token, pool, vault);
        emit log_named_string("journey", label);
        _claimAll(l, token);
        gas.redeem = _tradeDispatchRedeem(token, vault, alice);
        emit log_named_uint("gas: completing buy (create + pool + vault)", gas.completingBuy);
        emit log_named_uint("gas: claim", gas.claim);
        emit log_named_uint("gas: redemption", gas.redeem);
        emit log_named_uint("gas: curve sell-back", gas.curveSell);
    }

    Gas gas;
    uint256 feesAtLaunch;

    /// @dev Create through the Portal with the creator's first buy; alice and carol buy; alice sells a quarter back;
    /// bob's buy completes the sale and launches.
    function _saleUntilLaunch(CurveConfig memory c) internal returns (CurveLauncher l) {
        uint256 raise = c.targetRaise;
        l = CurveLauncher(payable(_createViaPortal(address(clf), abi.encode(c), clf.creationFee() + raise / 50)));
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(clf), "the Portal recorded the Launcher");
        assertEq(l.creator(), creator);
        assertGt(l.tokensOf(creator), 0, "the creator's first buy");

        vm.prank(alice);
        l.buy{value: raise * 4 / 10}(0);
        vm.prank(carol);
        l.buy{value: raise * 15 / 100}(0);
        uint256 back = l.tokensOf(alice) / 4;
        uint256 a0 = alice.balance;
        (,, uint256 paidQuote) = l.quoteSell(back);
        vm.prank(alice);
        uint256 g = gasleft();
        l.sell(back, 0);
        gas.curveSell = g - gasleft();
        assertEq(alice.balance - a0, paidQuote, "the sell-back paid its quote");
        _assertCurveExact(l, c);

        uint256 budget = l.costToComplete() + 0.01 ether;
        (uint256 t,, uint256 fee, uint256 refund) = l.quoteBuy(budget);
        feesAtLaunch = l.feePot() + fee;
        uint256 b0 = bob.balance;
        vm.prank(bob);
        g = gasleft();
        uint256 got = l.buy{value: budget}(0);
        gas.completingBuy = g - gasleft();
        assertEq(got, t);
        assertEq(b0 - bob.balance, budget - refund, "bob paid what the curve took, the rest came back");
        assertTrue(l.launched(), "launched in the completing buy");
    }

    function _assertLaunch(CurveLauncher l, CurveConfig memory c, address token, address pool, address vault)
        internal
    {
        assertEq(uint16(uint160(token)), 0x7777);
        assertEq(token, clf.predictToken(c.salt), "the token the tax-token implementation gives");
        assertEq(address(l).balance, 0, "the Launcher kept no BNB");
        assertEq(IERC20F(WBNB).balanceOf(pool), l.raiseTarget(), "pool BNB = the raise");
        assertEq(IERC20F(token).balanceOf(pool), l.poolToken(), "pool tokens");
        _assertLpBurned(pool);
        (address v2, address vf2) = portal.getLaunchVault(token);
        assertEq(vf2, address(pvf));
        assertEq(v2, vault);
        assertEq(vault, _predictPileVault(pvf, token));
        assertEq(PileVault(payable(vault)).pile(), feesAtLaunch, "the pile starts with the curve fees");
        emit log_named_uint("raise (pool BNB)", l.raiseTarget());
        emit log_named_uint("pile at launch (curve fees)", feesAtLaunch);
    }

    /// @dev Claims, one for one with what was bought; alice's claim is the one measured.
    function _claimAll(CurveLauncher l, address token) internal {
        address[4] memory who = [creator, alice, carol, bob];
        for (uint256 i; i < 4; ++i) {
            uint256 owed = l.tokensOf(who[i]);
            vm.prank(who[i]);
            uint256 g = gasleft();
            l.claim();
            if (who[i] == alice) gas.claim = g - gasleft();
            assertEq(IERC20F(token).balanceOf(who[i]), owed);
        }
        assertEq(IERC20F(token).balanceOf(address(l)), 0, "every sale token claimed");
    }

    /// Flap's test-network setting: enabled at multiplier 0. A 0.5 BNB sale, far below the real floor, passes
    /// creation and launches; without the multiplier the same sale is refused.
    function test_paused_enabledAtMultiplier0_fullJourney() public {
        CurveConfig memory c = _smallConfig(_mineSalt(keccak256("main-m0")));
        (uint256 usd, uint256 req) = _floorOf(c, true);
        assertLt(usd, req, "below the real floor at 1x");
        _enableLauncherFactory(address(clf), 0);
        (bool en, uint16 m) = IPortalFloorLike(PORTAL).launcherFactoryMultiplier(address(clf));
        assertTrue(en);
        assertEq(m, 0);
        (usd, req) = _floorOf(c, true);
        assertEq(req, 0, "no floor at multiplier 0");
        assertEq(portal.featureFlags() & 1, 1, "creation still paused for everyone else");
        _journey(c, "paused, enabled at multiplier 0, 0.5 BNB raise");
    }

    /// Enabled at multiplier 10_000 (no discount): the sale must raise the real minimum. A 2.0 BNB sale is refused at
    /// creation through the Portal; the 2.6 BNB sale, above the floor, runs the whole journey.
    function test_paused_enabledAtTheRealFloor_fullJourney() public {
        _enableLauncherFactory(address(clf), 10_000);
        CurveConfig memory low = _config(_mineSalt(keccak256("main-floor-low")));
        low.targetRaise = 2 ether;
        (uint256 usd, uint256 req) = _floorOf(low, true);
        assertLt(usd, req);
        uint256 fee = clf.creationFee();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.BelowLiquidityFloor.selector, usd, req));
        portal.newLauncher{value: fee}(address(clf), abi.encode(low));

        CurveConfig memory c = _config(_mineSalt(keccak256("main-floor")));
        (usd, req) = _floorOf(c, true);
        assertGe(usd, req, "2.6 BNB meets the real floor");
        _journey(c, "paused, enabled at multiplier 10000, 2.6 BNB raise");
    }

    // ── the miss: the sale unwinds, every buyer paid back ──────────────────────

    function test_paused_enabled_missedDeadline_unwinds() public {
        _enableLauncherFactory(address(clf), 10_000);
        CurveConfig memory c = _config(_mineSalt(keccak256("main-miss")));
        uint256 c0 = creator.balance;
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        uint256 k0 = carol.balance;
        CurveLauncher l =
            CurveLauncher(payable(_createViaPortal(address(clf), abi.encode(c), clf.creationFee() + 0.05 ether)));
        vm.prank(alice);
        l.buy{value: 1 ether}(0);
        uint256 aliceBack = l.tokensOf(alice) / 4; // read before the prank: a view call would take it
        vm.prank(alice);
        l.sell(aliceBack, 0);
        vm.prank(bob);
        l.buy{value: 0.5 ether}(0);
        vm.prank(carol);
        l.buy{value: 0.3 ether}(0);
        _assertCurveExact(l, c);
        uint256 pot = address(l).balance;

        vm.warp(l.deadline());
        assertEq(l.phase(), 2);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.SaleClosed.selector);
        l.buy{value: 2 ether}(0);

        uint256 paid;
        address[4] memory who = [bob, carol, alice, creator];
        for (uint256 i; i < 4; ++i) {
            vm.prank(who[i]);
            paid += l.unwind();
        }
        assertEq(paid, pot, "the unwind returned every wei the Launcher held");
        assertEq(address(l).balance, 0);
        assertEq(alice.balance, a0, "alice whole (her sell-back counted)");
        assertEq(bob.balance, b0, "bob whole");
        assertEq(carol.balance, k0, "carol whole");
        assertEq(c0 - creator.balance, clf.creationFee(), "the creator is out only the salt-lock fee");
        assertEq(clf.predictToken(c.salt).code.length, 0, "no token was created");
    }

    // ── the two negative cases Flap named ────────────────────────────────────

    /// The direct path (a Launcher the Portal never recorded, whose final buy the paused main-network Portal refuses
    /// with CreationPaused, measured at 6adbac37 before the R3 fix) no longer exists: the factory has no
    /// createLauncher in its ABI and a call to that selector fails, value untouched; the Launcher code cannot be
    /// initialized by anyone but the factory, and the factory's newLauncher answers only the Portal.
    function test_directPath_noLongerExists() public {
        string memory abiJson = vm.readFile("out/CurveLauncherFactory.sol/CurveLauncherFactory.json");
        assertEq(vm.indexOf(abiJson, '"name":"createLauncher"'), type(uint256).max, "no createLauncher in the ABI");
        assertTrue(vm.indexOf(abiJson, '"name":"newLauncher"') != type(uint256).max, "control: newLauncher is there");

        CurveConfig memory c = _config(_mineSalt(keccak256("main-direct")));
        uint256 c0 = creator.balance;
        vm.prank(creator);
        (bool ok,) = address(clf).call{value: clf.creationFee() + 0.05 ether}(
            abi.encodeWithSignature(
                "createLauncher((string,string,string,bytes32,uint256,uint256,uint256,uint64,uint16,uint16,uint16,uint16,uint32))",
                c
            )
        );
        assertFalse(ok, "a call to createLauncher fails");
        assertEq(creator.balance, c0, "and keeps nothing");

        CurveLauncher impl = CurveLauncher(payable(clf.implementation())); // read before the prank and the expectation
        vm.prank(creator);
        vm.expectRevert(CurveLauncher.NotFactory.selector);
        impl.initialize(creator, c);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LauncherFactoryBase.NotHub.selector, creator));
        clf.newLauncher(creator, abi.encode(c));
    }

    // ── R1: a name the Portal's anti-scam module lists is refused at creation ─

    function test_antiScam_listedWordRefused_cleanNameLaunches() public {
        assertEq(clf.antiScam(), ANTI_SCAM);
        (bool n, bool sy) = IAntiScam(ANTI_SCAM).isScamWord("USDT", "USDT");
        assertTrue(n && sy, "the live module lists USDT");
        (n, sy) = IAntiScam(ANTI_SCAM).isScamWord("Tether", "TETHER");
        assertFalse(n || sy, "and not Tether");

        _enableLauncherFactory(address(clf), 0);
        uint256 fee = clf.creationFee();
        CurveConfig memory c = _smallConfig(_mineSalt(keccak256("main-scam")));
        c.name = "USDT";
        c.symbol = "TETHER";
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "name on the Portal's anti-scam list")
        );
        portal.newLauncher{value: fee}(address(clf), abi.encode(c));
        c.name = "Tether";
        c.symbol = "BNB";
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CurveLauncherFactory.InvalidConfig.selector, "symbol on the Portal's anti-scam list")
        );
        portal.newLauncher{value: fee}(address(clf), abi.encode(c));

        c.symbol = "TETHER";
        CurveLauncher l = CurveLauncher(payable(_createViaPortal(address(clf), abi.encode(c), fee)));
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        l.buy{value: budget}(0);
        assertTrue(l.launched(), "a clean name launches, the Portal's own check agreeing");
        assertEq(IERC20Name(l.token()).name(), "Tether");
    }

    // ── R4: only the Guardian upgrades the vaults ─────────────────────────────

    /// On BNB Chain the Guardian is 0x9e27...8a4b (LaunchVaultAddresses.guardian() at chain 56, checked in the base).
    /// The MANAGE_ROLE holder, the creator, the deployer and the Portal are refused; nobody can call the beacon
    /// directly (the factory owns it); the Guardian's upgrade moves a launched pile to the new code, state kept.
    function test_r4_onlyTheGuardianUpgradesTheVaults() public {
        _enableLauncherFactory(address(clf), 0);
        CurveConfig memory c = _smallConfig(_mineSalt(keccak256("main-r4")));
        CurveLauncher l = CurveLauncher(payable(_createViaPortal(address(clf), abi.encode(c), clf.creationFee())));
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        l.buy{value: budget}(0);
        PileVault vault = PileVault(payable(l.pileVault()));
        uint256 pileBefore = vault.pile();
        assertGt(pileBefore, 0);

        UpgradeableBeacon beacon = UpgradeableBeacon(pvf.beacon());
        assertEq(beacon.owner(), address(pvf), "the factory owns the beacon");
        address oldImpl = beacon.implementation();
        address newImpl = address(new PileVault());
        address[4] memory refused = [manager, creator, address(this), PORTAL];
        for (uint256 i; i < 4; ++i) {
            vm.prank(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, refused[i]));
            pvf.upgradeVaultImplementation(newImpl);
        }
        vm.prank(GUARDIAN);
        vm.expectRevert(bytes4(0x82b42900)); // Unauthorized(): the beacon answers its owner, the factory, alone
        beacon.upgradeTo(newImpl);
        assertEq(beacon.implementation(), oldImpl, "unchanged so far");

        vm.prank(GUARDIAN);
        pvf.upgradeVaultImplementation(newImpl);
        assertEq(beacon.implementation(), newImpl, "the Guardian's upgrade took");
        assertEq(vault.pile(), pileBefore, "the launched pile runs the new code with its state");
        assertEq(vault.token(), l.token());
    }

    /// A factory that is NOT enabled: our creation check reads the Portal's 1x floor and refuses a sale below it, and
    /// the Portal refuses `newLauncher` through it outright.
    function test_paused_factoryNotEnabled_refusedAtTheFloor() public {
        (bool en,) = IPortalFloorLike(PORTAL).launcherFactoryMultiplier(address(clf));
        assertFalse(en);
        CurveConfig memory c = _smallConfig(_mineSalt(keccak256("main-off")));
        (uint256 usd, uint256 req) = _floorOf(c, true);
        assertLt(usd, req, "0.5 BNB is below the real floor");
        emit log_named_uint("0.5 BNB sale, not enabled: pool value (USD wad)", usd);
        emit log_named_uint("0.5 BNB sale, not enabled: required (USD wad)", req);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncherFactory.BelowLiquidityFloor.selector, usd, req));
        clf.checkConfig(c, true);

        // and the Portal itself, under the pause, refuses to create a Launcher through a factory it has not enabled,
        // below the floor or above it: LauncherFactoryNotEnabled(factory) (selector 0xa8a3c683)
        uint256 fee = clf.creationFee();
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LAUNCHER_FACTORY_NOT_ENABLED, address(clf)));
        portal.newLauncher{value: fee}(address(clf), abi.encode(c));
        CurveConfig memory big = _config(_mineSalt(keccak256("main-off-big")));
        (usd, req) = _floorOf(big, true);
        assertGe(usd, req, "2.6 BNB meets the floor");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LAUNCHER_FACTORY_NOT_ENABLED, address(clf)));
        portal.newLauncher{value: fee}(address(clf), abi.encode(big));
    }
}
