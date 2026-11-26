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
import {CurveLauncher, CurveConfig} from "../src/CurveLauncher.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {PileVault} from "../src/PileVault.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";

/// @dev A plain ERC-20 for the mock launch; `feeBps` > 0 makes transferFrom deliver less than asked.
contract MockToken20 {
    uint256 public totalSupply;
    uint256 public feeBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function setFeeBps(uint256 b) external {
        feeBps = b;
    }

    function mint(address to, uint256 a) external {
        totalSupply += a;
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        uint256 fee = a * feeBps / 10_000;
        balanceOf[to] += a - fee;
        totalSupply -= fee;
        return true;
    }
}

/// @dev Stands in for the Portal's anti-scam word list: listed names and symbols answer true.
contract MockAntiScam {
    mapping(bytes32 => bool) public listedName;
    mapping(bytes32 => bool) public listedSymbol;

    function list(string calldata name, string calldata symbol) external {
        if (bytes(name).length != 0) listedName[keccak256(bytes(name))] = true;
        if (bytes(symbol).length != 0) listedSymbol[keccak256(bytes(symbol))] = true;
    }

    function isScamWord(string calldata name, string calldata symbol) external view returns (bool, bool) {
        return (listedName[keccak256(bytes(name))], listedSymbol[keccak256(bytes(symbol))]);
    }
}

/// @dev Stands in for the Portal: the salt lock, and a launch that mints the distribution, calls the Launcher's
/// strategy callback and returns what the test configured (to provoke each launch check).
contract MockHub {
    uint256 public constant SALT_LOCK_FEE = 0.005 ether;
    bytes32 public lastSalt;
    address public callbackToken; // the token handed to initializeDistribution
    address public returnedToken; // the token launchTaxTokenV2 returns
    address public vault;
    address public vaultFactory;
    bool public createVault; // like the Portal: have the vault factory deploy the vault during the launch

    function lockSalt(bytes32 salt, uint8) external payable {
        require(msg.value == SALT_LOCK_FEE, "fee");
        lastSalt = salt;
    }

    function setLaunch(address cbToken, address retToken, address vault_, address vf) external {
        callbackToken = cbToken;
        returnedToken = retToken;
        vault = vault_;
        vaultFactory = vf;
    }

    function setCreateVault(bool v) external {
        createVault = v;
    }

    address public recordedFactory; // what getLauncher answers for every Launcher (the Portal's record)

    function setRecordedFactory(address f) external {
        recordedFactory = f;
    }

    function getLauncher(address) external view returns (LauncherRecord memory r) {
        r.launcherFactory = recordedFactory;
    }

    function getLaunchVault(address) external view returns (address, address) {
        return (vault, vaultFactory);
    }

    function launchTaxTokenV2(
        IPortalTypes.CreateTaxTokenParams calldata p,
        Distribution calldata d,
        IPortalTypes.CreatorBuyParams calldata
    ) external payable returns (address, address) {
        require(msg.value == p.poolQuote + p.creatorBuyQuote, "value");
        if (createVault) PileVaultFactory(vaultFactory).newVault(callbackToken, msg.sender, 0, abi.encode(p, d));
        MockToken20(callbackToken).mint(address(this), d.amount);
        MockToken20(callbackToken).approve(msg.sender, d.amount);
        IStrategy(msg.sender).initializeDistribution(callbackToken, d.amount, "", bytes32(0));
        return (returnedToken, address(0x9001));
    }
}

/// @dev A creator contract whose refund callback tries to trade: the lock must refuse both.
contract CallbackCreator {
    CurveLauncher public l;
    bytes public innerBuy;
    bytes public innerSell;

    function setLauncher(CurveLauncher l_) external {
        l = l_;
    }

    receive() external payable {
        (, innerBuy) = address(l).call{value: msg.value}(abi.encodeCall(CurveLauncher.buy, (0)));
        (, innerSell) = address(l).call(abi.encodeCall(CurveLauncher.sell, (1, 0)));
    }
}

/// @dev A buyer that stops accepting plain BNB after its buy.
contract RejectingBuyer {
    bool public accept = true;

    function buy(CurveLauncher l, uint256 budget) external payable {
        l.buy{value: budget}(0);
        accept = false;
    }

    receive() external payable {
        require(accept, "no BNB");
    }

    function unwind(CurveLauncher l) external returns (uint256) {
        return l.unwind();
    }

    function unwindTo(CurveLauncher l, address to) external returns (uint256) {
        return l.unwindTo(to);
    }
}

/// @notice The curve without a chain, checked against an independent oracle (OpenZeppelin's rounding mulDiv, not the
/// library the launcher uses): exact accounting after any history, the creator's first buy, the lock, the unwind in
/// both orders, the launch checks against a mock Portal. The live Portal is in the fork tests.
contract CurveLauncherTest is Test {
    MockHub hub;
    PileVaultFactory pvf;
    CurveLauncher impl;
    address constant TOKEN_IMPL = address(0x7777c57ff7dc441c1715b2e36fa581c48B782222);
    address creator = address(0xC0DE0001);
    address alice = address(0xC0DE0002);
    address bob = address(0xC0DE0003);
    address carol = address(0xC0DE0004);

    uint256 constant X0 = 10 ether;
    uint256 constant T = 2.6 ether;
    uint256 constant S = 600_000_000 ether;

    function setUp() public {
        hub = new MockHub();
        hub.setRecordedFactory(address(this)); // this test makes the Launchers: it stands in for the paired factory
        pvf = new PileVaultFactory(address(hub), address(this));
        impl = new CurveLauncher(address(hub), address(pvf), TOKEN_IMPL);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ── the independent oracle ────────────────────────────────────────────────

    function _y0() internal pure returns (uint256) {
        return Math.mulDiv(X0 + T, S, T);
    }

    function _R(uint256 s) internal pure returns (uint256) {
        uint256 y0 = _y0();
        return Math.mulDiv(X0, y0, y0 - s, Math.Rounding.Up) - X0;
    }

    function _fee(uint256 amount) internal pure returns (uint256) {
        return Math.mulDiv(amount, 100, 10_000, Math.Rounding.Up);
    }

    function _cfg() internal pure returns (CurveConfig memory c) {
        c.name = "Curve";
        c.symbol = "CRV";
        c.salt = bytes32(uint256(1));
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

    function _newFor(address who, uint256 firstBuy) internal returns (CurveLauncher l) {
        l = CurveLauncher(payable(LibClone.clone(address(impl))));
        vm.deal(address(this), 1 ether + firstBuy);
        l.initialize{value: 0.005 ether + firstBuy}(who, _cfg()); // this test is the factory
    }

    function _new(uint256 firstBuy) internal returns (CurveLauncher l) {
        return _newFor(creator, firstBuy);
    }

    function _check(CurveLauncher l) internal view {
        assertEq(l.curveBalance(), _R(l.sold()), "curve holds R(sold) (independent oracle)");
        assertEq(address(l).balance, l.curveBalance() + l.feePot(), "balance = curve + fees, to the wei");
    }

    /// @dev Buys with `budget` from `who` and returns the BNB actually spent, read from the balance.
    function _buy(CurveLauncher l, address who, uint256 budget) internal returns (uint256 spent) {
        uint256 b0 = who.balance;
        vm.prank(who);
        l.buy{value: budget}(0);
        spent = b0 - who.balance;
    }

    function _sell(CurveLauncher l, address who, uint256 n) internal returns (uint256 got) {
        uint256 b0 = who.balance;
        vm.prank(who);
        l.sell(n, 0);
        got = who.balance - b0;
    }

    // ── the shape, exact ──────────────────────────────────────────────────────

    function test_shape_exactAgainstTheOracle() public {
        CurveLauncher l = _new(0);
        assertEq(hub.lastSalt(), _cfg().salt, "the Launcher locked the salt itself");
        uint256 y0 = _y0();
        assertEq(l.virtualTokens(), y0);
        uint256 raise = _R(S);
        assertEq(l.raiseTarget(), raise);
        assertEq(raise, T + 1, "the raise is the target plus one wei for this configuration");
        uint256 pt = Math.mulDiv(y0 - S, raise, X0 + raise);
        assertEq(l.poolToken(), pt);
        assertEq(l.totalSupply(), S + pt);
        // the opening price raise / poolToken against the final marginal price (X0 + R) / (Y0 - S): the pool's token
        // side is rounded down, so pt * (X0 + R) <= (Y0 - S) * R < (pt + 1) * (X0 + R)
        assertLe(pt * (X0 + raise), (y0 - S) * raise);
        assertLt((y0 - S) * raise, (pt + 1) * (X0 + raise));
        _check(l);
    }

    // ── trades ────────────────────────────────────────────────────────────────

    function test_buySellBuy_exactToTheWei() public {
        CurveLauncher l = _new(0);
        uint256 spent = _buy(l, alice, 1 ether);
        uint256 got = l.tokensOf(alice);
        assertEq(spent, _R(got) + _fee(_R(got)), "alice paid R(n) plus the rounded-up fee");
        _check(l);
        uint256 part = got / 3;
        uint256 proceeds = _R(got) - _R(got - part);
        uint256 received = _sell(l, alice, part);
        assertEq(received, proceeds - _fee(proceeds));
        _check(l);
        _buy(l, bob, 0.3 ether);
        _check(l);
        _sell(l, alice, l.tokensOf(alice));
        _sell(l, bob, l.tokensOf(bob));
        assertEq(l.sold(), 0);
        assertEq(l.curveBalance(), 0);
        assertEq(address(l).balance, l.feePot());
    }

    /// @dev A budget of 1 mod 10100 leaves one wei of change at a 1% fee (the net rounds down by 0.99 wei).
    function _changeBudget(uint256 approx) internal pure returns (uint256) {
        return approx / 10_100 * 10_100 + 1;
    }

    function test_buy_sendsBackWhatTheCurveCannotTake() public {
        CurveLauncher l = _new(0);
        uint256 budget = _changeBudget(0.7 ether);
        (uint256 n, uint256 cost, uint256 fee, uint256 refund) = l.quoteBuy(budget);
        assertGt(refund, 0, "this budget leaves change");
        assertEq(cost, _R(n));
        assertEq(fee, _fee(cost));
        assertGt(_R(n + 1) + _fee(_R(n + 1)), budget, "one more token would not have been affordable");
        uint256 spent = _buy(l, bob, budget);
        assertEq(spent, budget - refund, "the change came back");
        assertEq(l.tokensOf(bob), n);
        _check(l);
    }

    function test_creatorFirstBuy_isAnOrdinaryBuyAtTheStart() public {
        uint256 budget = _changeBudget(0.2 ether);
        uint256 c0 = creator.balance;
        CurveLauncher a = _new(budget);
        uint256 creatorBack = creator.balance - c0;
        CurveLauncher b = _new(0);
        uint256 spent = _buy(b, alice, budget);
        assertEq(a.tokensOf(creator), b.tokensOf(alice), "same tokens");
        assertEq(a.feePot(), b.feePot(), "same fee");
        assertEq(a.curveBalance(), b.curveBalance(), "same cost");
        assertEq(budget - creatorBack, spent, "same change");
        assertGt(creatorBack, 0);
        _check(a);
    }

    function test_creatorRefundCallback_cannotTrade() public {
        CallbackCreator cc = new CallbackCreator();
        CurveLauncher l = CurveLauncher(payable(LibClone.clone(address(impl))));
        cc.setLauncher(l);
        uint256 budget = _changeBudget(0.2 ether); // leaves change, so the refund callback runs
        vm.deal(address(this), 1 ether);
        l.initialize{value: 0.005 ether + budget}(address(cc), _cfg());
        bytes memory reentry = abi.encodeWithSelector(CurveLauncher.Reentrancy.selector);
        assertEq(cc.innerBuy(), reentry, "buy refused inside initialize");
        assertEq(cc.innerSell(), reentry, "sell refused inside initialize");
        assertGt(address(cc).balance, 0, "the refund arrived");
        // after initialize the lock is open again
        _buy(l, alice, 0.1 ether);
        _check(l);
    }

    function test_creatorFirstBuy_mayNotCompleteTheSale() public {
        CurveLauncher l = CurveLauncher(payable(LibClone.clone(address(impl))));
        vm.deal(address(this), 10 ether);
        vm.expectRevert(CurveLauncher.FirstBuyCompletesSale.selector);
        l.initialize{value: 0.005 ether + 5 ether}(creator, _cfg());
    }

    function test_onlyTheFactory_once() public {
        CurveLauncher l = _new(0);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.NotFactory.selector);
        l.initialize(alice, _cfg());
        vm.expectRevert(CurveLauncher.AlreadyInitialized.selector);
        l.initialize(alice, _cfg());
        vm.expectRevert(CurveLauncher.AlreadyInitialized.selector);
        impl.initialize(alice, _cfg());
    }

    function test_sell_guards() public {
        CurveLauncher l = _new(0);
        _buy(l, alice, 0.5 ether);
        vm.prank(bob);
        vm.expectRevert(CurveLauncher.NotEnoughTokens.selector);
        l.sell(1, 0);
        uint256 all = l.tokensOf(alice);
        (,, uint256 paid) = l.quoteSell(all);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.BelowMinimum.selector, paid, paid + 1));
        l.sell(all, paid + 1);
        (uint256 t,,,) = l.quoteBuy(0.1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.BelowMinimum.selector, t, type(uint256).max));
        l.buy{value: 0.1 ether}(type(uint256).max);
    }

    // ── the miss: the unwind ──────────────────────────────────────────────────

    /// Nets measured from the balances (not from `owed`), and both claim orders give everyone exactly their net.
    function test_unwind_everyoneWhole_bothOrders() public {
        uint256 c0 = creator.balance;
        CurveLauncher l = _new(0.1 ether);
        uint256 netC = 0.1 ether - (creator.balance - c0); // the first buy, minus the change sent to the creator
        uint256 netA = _buy(l, alice, 0.9 ether);
        uint256 netB = _buy(l, bob, 0.4 ether);
        netA -= _sell(l, alice, l.tokensOf(alice) / 4);
        _check(l);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.SaleNotFailed.selector);
        l.unwind();
        vm.warp(l.deadline());
        assertEq(l.phase(), 2);
        vm.prank(carol);
        vm.expectRevert(CurveLauncher.SaleClosed.selector);
        l.buy{value: 0.1 ether}(0);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.SaleClosed.selector);
        l.sell(1, 0);
        assertEq(address(l).balance, netA + netB + netC, "the Launcher holds exactly everyone's net");

        address[3] memory order1 = [bob, creator, alice];
        address[3] memory order2 = [alice, creator, bob];
        for (uint256 round; round < 2; ++round) {
            uint256 snap = vm.snapshot();
            address[3] memory order = round == 0 ? order1 : order2;
            for (uint256 i; i < 3; ++i) {
                address who = order[i];
                uint256 b0 = who.balance;
                vm.prank(who);
                l.unwind();
                uint256 want = who == alice ? netA : who == bob ? netB : netC;
                assertEq(who.balance - b0, want, "exactly the net, in either order");
            }
            assertEq(address(l).balance, 0);
            CurveLauncher.Progress memory p = l.progress();
            assertEq(p.curveBalance, 0, "progress after the last refund: nothing left");
            assertEq(p.feePot, 0);
            vm.prank(alice);
            vm.expectRevert(CurveLauncher.NothingToUnwind.selector);
            l.unwind();
            vm.revertTo(snap);
        }
    }

    /// Alice sells at a profit; bob and carol are owed more than the Launcher holds. Both orders: each gets the
    /// remaining balance times its share of the remaining debt, rounded down, the last emptying it; the order moves
    /// at most one wei between them.
    function test_unwind_shortfall_bothOrders() public {
        CurveLauncher l = _new(0);
        uint256 inA = _buy(l, alice, 0.5 ether);
        uint256 ob = _buy(l, bob, 1.2 ether);
        uint256 oc = _buy(l, carol, 0.6 ether);
        uint256 outA = _sell(l, alice, l.tokensOf(alice));
        emit log_named_uint("alice paid in", inA);
        emit log_named_uint("alice took out", outA);
        emit log_named_uint("bob paid in", ob);
        emit log_named_uint("carol paid in", oc);
        assertEq(l.owed(alice), 0);
        vm.warp(l.deadline());
        uint256 pot = address(l).balance;
        assertLt(pot, ob + oc);
        uint256 snap = vm.snapshot();
        vm.prank(bob);
        uint256 b1 = l.unwind();
        vm.prank(carol);
        uint256 c1 = l.unwind();
        assertEq(b1, pot * ob / (ob + oc));
        assertEq(c1, pot - b1);
        vm.revertTo(snap);
        vm.prank(carol);
        uint256 c2 = l.unwind();
        vm.prank(bob);
        uint256 b2 = l.unwind();
        assertEq(c2, pot * oc / (ob + oc));
        assertEq(b2, pot - c2);
        assertLe(b2 > b1 ? b2 - b1 : b1 - b2, 1, "the order moves at most a wei");
        emit log_named_uint("Launcher holds", pot);
        emit log_named_uint("bob first: bob", b1);
        emit log_named_uint("bob first: carol", c1);
        emit log_named_uint("carol first: carol", c2);
        emit log_named_uint("carol first: bob", b2);
        assertLe(b1, ob);
        assertLe(c1, oc);
        assertEq(address(l).balance, 0);
    }

    function testFuzz_unwind_anyOrder_neverMoreThanOwed_lastEmpties(uint256 seed) public {
        CurveLauncher l = _new(0.01 ether);
        address[4] memory who = [alice, bob, carol, creator];
        for (uint256 i; i < 16; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address a = who[seed % 4];
            if ((seed >> 8) % 3 == 0 && l.tokensOf(a) > 0) {
                _sell(l, a, (seed >> 16) % l.tokensOf(a) + 1);
            } else {
                uint256 budget = (seed >> 16) % 0.3 ether + 1e9;
                (uint256 t,,,) = l.quoteBuy(budget);
                if (t == 0 || l.sold() + t >= S) continue;
                _buy(l, a, budget);
            }
        }
        assertLe(address(l).balance, l.totalOwed());
        vm.warp(l.deadline());
        uint256 pot = address(l).balance;
        uint256 paid;
        uint256 start = seed % 4;
        for (uint256 k; k < 4; ++k) {
            address w = who[(start + k) % 4];
            uint256 o = l.owed(w);
            if (o == 0) continue;
            vm.prank(w);
            uint256 p = l.unwind();
            assertLe(p, o, "never more than owed, the last one included");
            paid += p;
        }
        assertEq(paid, pot, "every wei returned");
        assertEq(address(l).balance, 0);
    }

    function test_unwindTo_forABuyerThatCannotReceiveBnb() public {
        CurveLauncher l = _new(0);
        RejectingBuyer rb = new RejectingBuyer();
        vm.deal(address(rb), 0.3 ether);
        rb.buy(l, 0.3 ether);
        uint256 net = l.owed(address(rb));
        assertEq(net, 0.3 ether - address(rb).balance);
        vm.warp(l.deadline());
        vm.expectRevert(bytes4(0xb12d13eb)); // plain BNB to the buyer itself fails: solady's ETHTransferFailed()
        rb.unwind(l);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.NothingToUnwind.selector); // nobody else can direct it
        l.unwindTo(alice);
        vm.expectRevert(CurveLauncher.InvalidRecipient.selector);
        rb.unwindTo(l, address(0));
        uint256 c0 = carol.balance;
        assertEq(rb.unwindTo(l, carol), net);
        assertEq(carol.balance - c0, net);
    }

    /// BNB that reaches the Launcher unasked: in an unwind it goes to the creditors with the rest.
    function test_unsolicitedBnb_unwind() public {
        CurveLauncher l = _new(0);
        uint256 spent = _buy(l, alice, 0.5 ether);
        vm.deal(address(l), address(l).balance + 7);
        assertEq(address(l).balance - l.curveBalance() - l.feePot(), 7, "the surplus");
        vm.warp(l.deadline());
        uint256 a0 = alice.balance;
        vm.prank(alice);
        l.unwind();
        assertEq(alice.balance - a0, spent + 7, "the only creditor takes the surplus too");
        assertEq(address(l).balance, 0);
    }

    // ── the launch, against a mock Portal ─────────────────────────────────────

    function _launchSetup(bool honest) internal returns (CurveLauncher l, address predicted, MockToken20 real) {
        l = _new(0);
        predicted = ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, _cfg().salt, address(hub));
        assertEq(l.predictedToken(), predicted);
        real = new MockToken20();
        vm.etch(predicted, address(real).code);
        if (honest) {
            hub.setLaunch(predicted, predicted, pvf.predictVault(predicted, address(0)), address(pvf));
            hub.setCreateVault(true);
        }
        _buy(l, alice, 1 ether);
    }

    function test_launch_checksPass_feesAndSurplusToThePile() public {
        (CurveLauncher l, address predicted,) = _launchSetup(true);
        vm.deal(address(l), address(l).balance + 5); // unasked BNB
        uint256 toPile = l.feePot() + 5;
        uint256 complete = l.costToComplete();
        assertEq(_buy(l, bob, complete + 0.1 ether), complete, "the completing buyer's change came back");
        assertTrue(l.launched());
        address vault = pvf.predictVault(predicted, address(0));
        assertEq(l.pileVault(), vault);
        assertGt(vault.code.length, 0, "the pile exists");
        assertEq(PileVault(payable(vault)).token(), predicted);
        uint256 want = toPile + _fee(_R(S) - _R(l.tokensOf(alice)));
        assertEq(vault.balance, want, "fee pot and surplus to the pile");
        assertEq(PileVault(payable(vault)).pile(), want, "and the pile counts them");
        assertEq(address(l).balance, 0);
        uint256 owedAlice = l.tokensOf(alice);
        vm.prank(alice);
        l.claim();
        assertEq(MockToken20(predicted).balanceOf(alice), owedAlice);
    }

    /// R3 (Flap's pre-audit): the vault factory serves only Launchers the Portal recorded for its paired launcher
    /// factory. A Launcher of any other factory that names it is refused at the launch, and its sale stays open; the
    /// same Launcher recorded for the paired factory launches.
    function test_vaultFactory_refusesALauncherOfAnotherFactory() public {
        (CurveLauncher l,,) = _launchSetup(true);
        hub.setRecordedFactory(address(0xF0F0)); // a foreign launcher factory
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PileVaultFactory.NotPaired.selector, address(l)));
        l.buy{value: budget}(0);
        assertFalse(l.launched());
        hub.setRecordedFactory(address(0)); // made outside the Portal: no record at all
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PileVaultFactory.NotPaired.selector, address(l)));
        l.buy{value: budget}(0);
        hub.setRecordedFactory(address(this)); // the paired factory's Launcher
        vm.prank(bob);
        l.buy{value: budget}(0);
        assertTrue(l.launched());
    }

    /// The pairing is fixed: no zero address at construction, and nothing can change it afterwards.
    function test_vaultFactory_pairingFixedAtConstruction() public {
        assertEq(pvf.pairedLauncherFactory(), address(this));
        try new PileVaultFactory(address(hub), address(0)) returns (PileVaultFactory) {
            revert("a vault factory without a paired launcher factory was accepted");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(DirectLaunchVaultFactoryBase.ZeroAddress.selector));
        }
    }

    /// The vault is at the right address and from the right factory, but was never deployed: refused, the fees stay.
    function test_launch_vaultWithoutCode_isRefused() public {
        (CurveLauncher l, address predicted,) = _launchSetup(true);
        hub.setCreateVault(false);
        address vault = pvf.predictVault(predicted, address(0));
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.LaunchMismatch.selector, "vault"));
        l.buy{value: budget}(0);
        assertFalse(l.launched());
        assertEq(vault.balance, 0, "an empty address received nothing");
    }

    /// complete() launches or does nothing: after a sell-back between quote and inclusion it reverts instead of
    /// buying part of the rest; with a margin it launches and the margin comes back.
    function test_complete_isAllOrNothing() public {
        (CurveLauncher l,,) = _launchSetup(true);
        uint256 quoted = l.costToComplete();
        uint256 aliceTokens = l.tokensOf(alice);
        _sell(l, alice, aliceTokens / 2); // a sell-back lands first
        (uint256 n,,,) = l.quoteBuy(quoted);
        uint256 still = S - l.sold() - n;
        assertGt(still, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.NotCompleted.selector, still));
        l.complete{value: quoted}();
        assertFalse(l.launched());
        assertEq(l.tokensOf(bob), 0, "no partial buy");
        uint256 need = l.costToComplete();
        uint256 spent = _complete(l, bob, need + 0.05 ether);
        assertEq(spent, need, "the margin came back");
        assertTrue(l.launched());
    }

    function _complete(CurveLauncher l, address who, uint256 value) internal returns (uint256 spent) {
        uint256 b0 = who.balance;
        vm.prank(who);
        l.complete{value: value}();
        spent = b0 - who.balance;
    }

    /// Nobody owed, BNB forced in, deadline passed: progress reports nothing refundable.
    function test_progress_nothingRefundableWhenNobodyIsOwed() public {
        CurveLauncher l = _new(0);
        vm.deal(address(l), 7);
        vm.warp(l.deadline());
        assertEq(l.totalOwed(), 0);
        assertEq(l.progress().curveBalance, 0);
        vm.prank(alice);
        vm.expectRevert(CurveLauncher.NothingToUnwind.selector);
        l.unwind();
    }

    function test_launch_wrongVault_isRefused() public {
        (CurveLauncher l, address predicted,) = _launchSetup(false);
        hub.setLaunch(predicted, predicted, address(0xBAD), address(pvf));
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.LaunchMismatch.selector, "vault"));
        l.buy{value: budget}(0);
        hub.setLaunch(predicted, predicted, pvf.predictVault(predicted, address(0)), address(0xBAD));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.LaunchMismatch.selector, "vault"));
        l.buy{value: budget}(0);
        assertFalse(l.launched());
        assertEq(address(0xBAD).balance, 0, "a wrong vault received nothing");
    }

    function test_launch_wrongToken_isRefused() public {
        (CurveLauncher l, address predicted,) = _launchSetup(false);
        MockToken20 other = new MockToken20();
        uint256 budget = l.costToComplete();
        // the callback hands another token: the strategy refuses it
        hub.setLaunch(address(other), address(other), pvf.predictVault(address(other), address(0)), address(pvf));
        vm.prank(bob);
        vm.expectRevert(CurveLauncher.InvalidDistribution.selector);
        l.buy{value: budget}(0);
        // the callback is right but the launch returns another token
        hub.setLaunch(predicted, address(other), pvf.predictVault(address(other), address(0)), address(pvf));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.LaunchMismatch.selector, "token"));
        l.buy{value: budget}(0);
        assertFalse(l.launched());
    }

    function test_launch_shortTokens_isRefused() public {
        (CurveLauncher l, address predicted,) = _launchSetup(true);
        MockToken20(predicted).setFeeBps(1); // the distribution arrives one hundredth of a percent short
        uint256 budget = l.costToComplete();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveLauncher.LaunchMismatch.selector, "sale tokens"));
        l.buy{value: budget}(0);
        assertFalse(l.launched());
        // the sale stays open; after the deadline it unwinds as usual
        vm.warp(l.deadline());
        vm.prank(alice);
        assertGt(l.unwind(), 0);
    }

    // ── any history ───────────────────────────────────────────────────────────

    function testFuzz_anyHistory_curveHoldsRsold(uint256 seed) public {
        CurveLauncher l = _new(0);
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address a = who[seed % 3];
            if ((seed >> 8) % 3 == 0 && l.tokensOf(a) > 0) {
                _sell(l, a, (seed >> 16) % l.tokensOf(a) + 1);
            } else {
                uint256 budget = (seed >> 16) % 0.3 ether + 1e9;
                (uint256 t,,,) = l.quoteBuy(budget);
                if (t == 0 || l.sold() + t >= S) continue;
                uint256 sBefore = l.sold();
                uint256 spent = _buy(l, a, budget);
                uint256 cost = _R(sBefore + t) - _R(sBefore);
                assertEq(spent, cost + _fee(cost), "the buy cost what the oracle says");
                assertGt(_R(sBefore + t + 1) - _R(sBefore) + _fee(_R(sBefore + t + 1) - _R(sBefore)), budget);
            }
            _check(l);
        }
        for (uint256 k; k < 3; ++k) {
            uint256 n = l.tokensOf(who[k]);
            if (n != 0) _sell(l, who[k], n);
        }
        assertEq(l.curveBalance(), 0);
        assertEq(address(l).balance, l.feePot());
    }

    receive() external payable {}
}
