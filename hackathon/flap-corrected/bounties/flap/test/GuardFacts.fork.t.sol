// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20F, ITaxTokenF, ITaxProcessorF} from "./PileForkBase.sol";
import {GuardRoundsFork} from "./GuardRoundsFork.sol";
import {CurveConfig} from "../src/RulesCurveLauncher.sol";
import {RulesCurveLauncher} from "../src/RulesCurveLauncher.sol";
import {RulesCurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileVault} from "../src/PileVault.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {PairPriceGuard} from "fee-rules/PairPriceGuard.sol";

interface IV2PairT {
    function getReserves() external view returns (uint112, uint112, uint32);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function factory() external view returns (address);
    function token0() external view returns (address);
}

interface IV2FactoryT {
    function getPair(address, address) external view returns (address);
    function allPairs(uint256) external view returns (address);
}

interface IV2RouterT {
    function factory() external view returns (address);
}

/// @dev A payee whose receive() needs more than the splitter's NATIVE_CALL_GAS: distribute() leaves its part owed.
contract HungryPayeeT {
    uint256[24] slots;
    uint256 public got;

    receive() external payable {
        for (uint256 i; i < 24; ++i) {
            slots[i] = block.timestamp + i + got + 1;
        }
        got += msg.value;
    }
}

/// @notice The swap guard as Flap's pre-audit wrote it (SH-308 R2: at most 5 bps of the pair's quote reserve read in
/// the call, a nonzero minimum from those reserves, one buy per minute) against the BNB test network Portal (an anvil
/// fork pinned at a block, FORK_URL): (a) the launch's pool is the router's factory's PancakeSwap pair, (b) the first
/// share-out buys at once with the real tax token, a slice a minute until nothing is owed, (c) A PINNED LIMIT: a price
/// raised earlier in the same second does NOT make the buy wait; the buy goes through at the raised price, (d)
/// payOwedCreator and the gas. The same facts as RulesPileMainnet.fork.t.sol on BNB Chain.
contract GuardFactsForkTest is GuardRoundsFork {
    RulesVaultFactory rvf;
    RulesCurveLauncherFactory rlf;
    address payee = address(uint160(0xC0DE0099));

    RulesCurveLauncher l;
    address token;
    RulesVault s;

    function setUp() public {
        if (!_forkSetUp()) return;
        rvf = new RulesVaultFactory(PORTAL, address(0), ROUTER, _pairedNext());
        rlf = new RulesCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL, ANTI_SCAM);
    }

    function _rules() internal view returns (IRuleSplitter.Rule[] memory r) {
        r = new IRuleSplitter.Rule[](3);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 2000, target: payee});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 5000, target: address(0)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 3000, target: address(0)});
    }

    function _cfg(bytes32 salt, uint16 buyTax) internal pure returns (CurveConfig memory c) {
        c.name = "Guard Facts";
        c.symbol = "GUARD";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 2.35 ether;
        c.virtualBnb = 16 ether;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = buyTax;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    function _launch(string memory seed, address payee_, uint16 buyTax) internal {
        payee = payee_;
        bytes32 salt = _mineSalt(keccak256(bytes(seed)));
        vm.prank(creator);
        rvf.setRules(address(rlf), salt, _rules());
        uint256 fee = rlf.creationFee();
        vm.prank(creator);
        l = RulesCurveLauncher(payable(portal.newLauncher{value: fee}(address(rlf), abi.encode(_cfg(salt, buyTax)))));
        vm.prank(alice);
        l.buy{value: 1 ether}(0);
        uint256 need = l.costToComplete();
        vm.prank(bob);
        l.complete{value: need}();
        address vault;
        (token,, vault) = l.launchInfo();
        s = RulesVault(payable(vault));
    }

    function _tradeAndDispatch() internal {
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
    }

    /// (a) The pair is the router's factory's pair with that factory's pair code (and it keeps its price cumulative,
    /// moved by price x seconds); (b) the first share-out buys at once exactly min(burn part, 5 bps of the quote
    /// reserve) with the real tax token (3% buy tax); every round a minute apart until the burn part is bought.
    function test_guard_testnetPair_firstShareOutBuysAtOnce() public {
        _launch("guard-a", payee, 300);
        address factory = IV2RouterT(ROUTER).factory();
        address pair = l.pool();
        assertEq(IV2FactoryT(factory).getPair(WBNB, token), pair, "the launch's pool is the router's factory's pair");
        assertEq(IV2PairT(pair).factory(), factory);
        address ref = IV2FactoryT(factory).allPairs(0);
        assertEq(pair.codehash, ref.codehash, "the same pair code as that factory's first pair");
        emit log_named_address("router", ROUTER);
        emit log_named_address("factory", factory);
        emit log_named_address("launched pair", pair);

        bool t0 = IV2PairT(pair).token0() == token;
        vm.warp(block.timestamp + 601);
        (uint256 rq, uint256 rt) = _guardReserves(s);
        (,, uint32 tLast) = IV2PairT(pair).getReserves();
        uint256 c0 = t0 ? IV2PairT(pair).price0CumulativeLast() : IV2PairT(pair).price1CumulativeLast();
        vm.warp(block.timestamp + 60);
        vm.prank(trader);
        _buy(token, 0.01 ether);
        uint256 c1 = t0 ? IV2PairT(pair).price0CumulativeLast() : IV2PairT(pair).price1CumulativeLast();
        unchecked {
            assertEq(c1 - c0, uint256(uint224((rq << 112) / rt)) * (block.timestamp - tLast), "price x seconds");
        }

        _tradeAndDispatch();
        uint256 g = gasleft();
        (uint256 burnPart, uint256 first,) = _firstShareOut(s, 2);
        emit log_named_uint("gas: first share-out that buys (with the test's checks)", g - gasleft());
        (uint256 bought,,) = _buyRoundsUntilBurnt(s, 2, 40);
        assertEq(first + bought, burnPart);
        assertEq(s.totalOwed(), 0, "everything shared");
    }

    /// (c) A PINNED LIMIT of the guard as Flap wrote it, and (d): a 10% buy tax, a payee that needs more gas. The first
    /// share-out buys its slice, the creator stays owed and payOwedCreator pays it. 61 seconds later a trader raises the
    /// price by far more than 1% in one block; the share-out in the NEXT block with the SAME timestamp (as consecutive
    /// BNB blocks do) does NOT wait: it buys exactly min(owed, 5 bps of the RAISED quote reserve), with at least the
    /// minimum computed from the raised reserves as read, and fewer tokens than the same amount bought before the raise.
    /// Nobody should read a price protection into this suite: the contracts no longer have one.
    function test_guard_testnetLimit_sameSecondRaiseDoesNotWait_payOwedCreator() public {
        HungryPayeeT hungry = new HungryPayeeT();
        _launch("guard-c", address(hungry), 1000);
        _tradeAndDispatch();
        uint256 income = s.pending();
        uint256 pile0 = PileVault(payable(rvf.pileOf(token))).pile();
        _firstShareOut(s, 2);
        assertEq(s.owed(0), income / 10_000 * 2000 + income % 10_000 * 2000 / 10_000, "the hungry payee stays owed");
        assertGt(PileVault(payable(rvf.pileOf(token))).pile(), pile0, "the pile paid");

        uint256 owedCreator = s.owed(0);
        uint256 g = gasleft();
        assertEq(s.payOwedCreator(0), owedCreator);
        emit log_named_uint("gas: payOwedCreator (24 fresh storage writes in the payee)", g - gasleft());
        assertEq(hungry.got(), owedCreator);

        vm.warp(block.timestamp + PairPriceGuard.MIN_GAP + 1);
        (uint256 rq0, uint256 rt0) = _guardReserves(s);
        vm.prank(trader);
        _buy(token, 0.3 ether);
        uint256 ts = block.timestamp;
        vm.roll(block.number + 1); // the next block, the same second
        assertEq(block.timestamp, ts);
        _raisedBuyGoesThrough(rq0, rt0);
    }

    /// @dev The share-out right after a raise: exactly min(owed, 5 bps of the raised quote reserve) bought, at least the
    /// minimum from the raised reserves, fewer tokens than before the raise.
    function _raisedBuyGoesThrough(uint256 rq0, uint256 rt0) internal {
        (uint256 rq1, uint256 rt1) = _guardReserves(s);
        uint256 raisedBps = (rq1 * 1e18 / rt1) * 10_000 / (rq0 * 1e18 / rt0) - 10_000;
        assertGt(raisedBps, 100, "the price raised by more than 1%");
        uint256 owedBurn = s.owed(2) + _assigned(s, s.pending(), 2);
        uint256 cap = rq1 * PairPriceGuard.CAP_BPS / 10_000;
        uint256 amount = owedBurn < cap ? owedBurn : cap;
        uint256 minOut = PairPriceGuard.minimumOut(amount, rq1, rt1);
        uint256 beforeRaise = amount * rt0 / (rq0 + amount);
        uint256 d0 = s.delivered(2);
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        s.distribute();
        uint256 burnt = IERC20F(token).balanceOf(DEAD) - dead0;
        assertEq(s.delivered(2) - d0, amount, "the raise does NOT make the buy wait: the slice is bought");
        assertGe(burnt, minOut, "at least the minimum from the raised reserves");
        assertLt(burnt, beforeRaise, "fewer tokens than the same amount bought before the raise");
        emit log_named_uint("LIMIT: price raised in the same second (bps)", raisedBps);
        emit log_named_uint("LIMIT: bought at the raised price (wei)", amount);
        emit log_named_uint("LIMIT: minimum from the raised reserves (tokens)", minOut);
        emit log_named_uint("LIMIT: tokens burned", burnt);
        emit log_named_uint("LIMIT: constant-product output before the raise (tokens)", beforeRaise);
    }
}
