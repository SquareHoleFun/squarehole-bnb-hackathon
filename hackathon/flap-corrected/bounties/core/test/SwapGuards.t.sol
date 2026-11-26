// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RuleSplitter, RuleSplitterBase} from "../src/RuleSplitter.sol";
import {IRuleSplitter} from "../src/IRuleSplitter.sol";
import {FeeRules} from "../src/FeeRules.sol";
import {RailShop} from "../src/RailShop.sol";
import {IRailShop} from "../src/IRailShop.sol";
import {RailShopFactory} from "../src/RailShopFactory.sol";
import {ShopCards} from "./RailShop.t.sol";
import {Coin, WrappedNative, TaxToken, V2Pair, V2Factory, V2Router, NoFactoryRouter} from "./V2PoolMocks.sol";

/// @dev A payee that needs more gas than the splitter's fixed allowance (100,000) to take the coin: it writes ten
/// fresh storage slots (about 221,000 gas); `refuse` makes it revert.
contract HungryPayee {
    uint256[10] public marks;
    bool public refuse;

    function setRefuse(bool r) external {
        refuse = r;
    }

    receive() external payable {
        require(!refuse, "no");
        for (uint256 i; i < 10; ++i) marks[i] = block.timestamp + i + msg.value;
    }
}

/// Flap's pre-audit finding R2: the two buys anyone can trigger, the splitter's buy-and-burn and the shop's refill,
/// on a real constant-product pool (V2PoolMocks: a constant-product pair with PancakeSwap's 0.25% fee) with a
/// token taxed on its pair like Flap's tax token.
contract SwapGuardsTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant CREATOR = address(0xC12EA70);
    uint256 constant X = 100 ether; // the pool's quote reserve
    uint256 constant Y = 1e27; // the pool's token reserve
    address[] NONE;

    WrappedNative wbnb;
    V2Factory fac;
    V2Router router;

    function setUp() public {
        vm.warp(1_800_000_000);
        wbnb = new WrappedNative();
        fac = new V2Factory();
        router = new V2Router(address(fac), address(wbnb));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// A taxed token on the requested side of `quote` in the pair (a V2 factory sorts the pair by address).
    function _token(address quote, bool asToken0) internal returns (TaxToken t) {
        for (uint256 i; i < 40; ++i) {
            t = new TaxToken();
            if ((address(t) < quote) == asToken0) return t;
        }
        revert("no deployment on that side");
    }

    function _pool(address quote, TaxToken token, uint256 x, uint256 y) internal returns (V2Pair p) {
        p = V2Pair(fac.createPair(quote, address(token)));
        if (x != 0) {
            if (quote == address(wbnb)) {
                vm.deal(address(this), x);
                wbnb.deposit{value: x}();
                wbnb.transfer(address(p), x);
            } else {
                Coin(quote).mint(address(p), x);
            }
        }
        token.mint(address(p), y);
        p.sync();
        token.setPair(address(p));
    }

    function _reserves(V2Pair p, address quote) internal view returns (uint256 q, uint256 t) {
        (uint112 r0, uint112 r1,) = p.getReserves();
        (q, t) = p.token0() == quote ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _splitter(address token, address asset, address target) internal returns (RuleSplitter s, FeeRules pile) {
        pile = new FeeRules(token, asset, NONE);
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](3);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 2000, target: CREATOR});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 5000, target: address(pile)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 3000, target: target});
        s = new RuleSplitter(token, asset, r);
    }

    function _fund(RuleSplitter s, address asset, uint256 amount) internal {
        if (asset == address(0)) vm.deal(address(s), address(s).balance + amount);
        else Coin(asset).mint(address(s), amount);
    }

    // ── the splitter ─────────────────────────────────────────────────────────

    /// A part above the cap is bought in slices of 5 bps of the quote reserve, one per 60 seconds, with a nonzero
    /// minimum from the reserves; a call inside the 60 seconds buys nothing and pays the other rules as before; the
    /// remainder stays owed and visible until the last slice. Native coin, a token taxed 3% on buys and 5% on sells.
    function test_L1_splitter_native_slicesOfTheCap_oneBuyPerMinute_othersPaid() public {
        TaxToken tok = _token(address(wbnb), true);
        V2Pair p = _pool(address(wbnb), tok, X, Y);
        tok.setTax(300, 500);
        (RuleSplitter s, FeeRules pile) = _splitter(address(tok), address(0), address(router));
        _fund(s, address(0), 1 ether); // the buy's part: 0.3 ether, six times the cap of 0.05 ether
        (uint256 q, uint256 t) = _reserves(p, address(wbnb));
        uint256 cap = q * 5 / 10_000;
        uint256 expectMin = cap * t / (q + cap) * (10_000 - 1130) / 10_000;
        s.distribute(); // the first share-out buys at once, up to the cap
        assertEq(CREATOR.balance, 0.2 ether, "the creator paid in full");
        assertEq(pile.pile(), 0.5 ether, "the pile paid in full");
        assertEq(s.delivered(2), cap, "the first slice is the cap: 5 bps of the quote reserve");
        assertEq(s.owed(2), 0.3 ether - cap, "the rest stays owed and visible");
        assertEq(router.lastAmountOutMin(), expectMin, "the minimum: the reserves' output less 11.3%");
        assertGt(router.lastAmountOutMin(), 0, "a nonzero minimum");
        assertGe(tok.balanceOf(DEAD), expectMin, "what arrived after the tax meets it");
        assertEq(s.burned(2), tok.balanceOf(DEAD));

        // the same second: more income; the buy waits, the others are paid as before
        _fund(s, address(0), 1 ether);
        uint256 calls = router.calls();
        s.distribute();
        assertEq(router.calls(), calls, "no buy inside the 60 seconds");
        assertEq(CREATOR.balance, 0.4 ether);
        assertEq(pile.pile(), 1 ether);
        assertEq(s.owed(2), 0.6 ether - cap, "the new part joins the owed one");

        vm.warp(block.timestamp + 59);
        s.distribute();
        assertEq(router.calls(), calls, "59 seconds are not enough");
        uint256 slices = 1;
        for (uint256 i; i < 40 && s.owed(2) != 0; ++i) {
            vm.warp(block.timestamp + 60);
            (q,) = _reserves(p, address(wbnb));
            uint256 before = s.owed(2);
            s.distribute();
            uint256 slice = before - s.owed(2);
            assertEq(slice, before < q * 5 / 10_000 ? before : q * 5 / 10_000, "each slice is the cap or the rest");
            ++slices;
        }
        assertEq(s.owed(2), 0, "the whole part is bought in the end");
        assertEq(s.delivered(2), 0.6 ether);
        assertEq(slices, 12, "0.6 ether in slices of about 0.05 ether");
        assertEq(address(s).balance, 0, "nothing stranded");
    }

    /// An ERC-20 quote with 6 decimals, the token on either side of the pair.
    function test_L1_splitter_erc20Quote6Decimals_bothSides() public {
        for (uint256 side; side < 2; ++side) {
            Coin usd = new Coin(6);
            TaxToken tok = _token(address(usd), side == 0);
            V2Pair p = _pool(address(usd), tok, 100_000e6, Y);
            assertEq(p.token0() == address(tok), side == 0, "the token is on the requested side");
            tok.setTax(300, 500);
            (RuleSplitter s,) = _splitter(address(tok), address(usd), address(router));
            _fund(s, address(usd), 1_000e6); // the buy's part: 300e6, six times the cap of 50e6
            s.distribute();
            assertEq(s.delivered(2), 50e6, "the cap: 5 bps of the quote reserve");
            assertEq(s.owed(2), 250e6);
            assertEq(usd.balanceOf(CREATOR), 200e6, "the creator paid");
            assertGt(router.lastAmountOutMin(), 0);
            assertEq(usd.allowance(address(s), address(router)), 0, "no allowance left");
            vm.warp(block.timestamp + 60);
        }
    }

    /// No pair, a pair with empty reserves, or a router whose pool cannot be read: the buy's part stays owed, the
    /// others are paid, nothing reverts; once a pool exists the part is bought.
    function test_L1_splitter_noPairEmptyOrUnreadable_staysOwed_othersPaid() public {
        TaxToken tok = _token(address(wbnb), true);
        NoFactoryRouter unreadable = new NoFactoryRouter(address(wbnb));
        (RuleSplitter s0,) = _splitter(address(tok), address(0), address(unreadable));
        _fund(s0, address(0), 1000);
        s0.distribute();
        assertEq(s0.owed(2), 300, "a failed read leaves the part owed");
        assertEq(s0.delivered(0) + s0.delivered(1), 700, "the others are paid");

        (RuleSplitter s,) = _splitter(address(tok), address(0), address(router));
        _fund(s, address(0), 1000);
        s.distribute();
        assertEq(s.owed(2), 300, "no pair: owed");
        assertEq(s.delivered(0) + s.delivered(1), 700);

        V2Pair p = V2Pair(fac.createPair(address(wbnb), address(tok)));
        vm.warp(block.timestamp + 60);
        s.distribute();
        assertEq(s.owed(2), 300, "empty reserves: owed");

        vm.deal(address(this), X);
        wbnb.deposit{value: X}();
        wbnb.transfer(address(p), X);
        tok.mint(address(p), Y);
        p.sync();
        tok.setPair(address(p));
        s.distribute(); // the failed attempts above recorded nothing: no minute to wait
        assertEq(s.owed(2), 0, "a pool now: bought");
        assertGt(tok.balanceOf(DEAD), 0);
    }

    /// The minimum is what arrives after the token's buy tax: up to Flap's highest tax (10%) the buy goes through; a
    /// token taking 12% (above what any of our launches can set) makes the router refuse it, and the part stays owed.
    function test_L1_splitter_minimumAllowsTheTax_upTo10pct() public {
        TaxToken tok = _token(address(wbnb), false);
        _pool(address(wbnb), tok, X, Y);
        tok.setTax(1000, 1000);
        (RuleSplitter s,) = _splitter(address(tok), address(0), address(router));
        _fund(s, address(0), 0.1 ether);
        s.distribute();
        assertEq(s.owed(2), 0, "a 10% buy tax: bought");
        tok.setTax(1200, 1000);
        _fund(s, address(0), 0.1 ether);
        vm.warp(block.timestamp + 60);
        s.distribute();
        assertEq(s.owed(2), 0.03 ether, "a 12% buy tax: the minimum refuses, the part stays owed");
        assertEq(CREATOR.balance, 0.04 ether, "the creator is paid regardless");
    }

    // ── the shop ─────────────────────────────────────────────────────────────

    function _shop(address token, address asset) internal returns (RailShop shop) {
        return _shopOn(address(router), token, asset);
    }

    function _shopOn(address r, address token, address asset) internal returns (RailShop shop) {
        ShopCards cards = new ShopCards();
        address[] memory routers = new address[](1);
        routers[0] = r;
        address[] memory cols = new address[](1);
        cols[0] = address(cards);
        RailShopFactory f = new RailShopFactory(routers, cols);
        uint256[] memory prices = new uint256[](1);
        prices[0] = 1e18;
        shop = RailShop(payable(f.create(token, asset, r, cols, prices, 0, 1e24)));
    }

    /// The site's call `refill(waiting())` keeps working with the same bytes: it buys the slice (5 bps of the quote
    /// reserve), the rest keeps waiting; a second refill inside 60 seconds reverts; after them the next slice.
    function test_L1_shop_refillClampsToTheCap_oneRefillPerMinute() public {
        TaxToken tok = _token(address(wbnb), true);
        V2Pair p = _pool(address(wbnb), tok, X, Y);
        tok.setTax(300, 500);
        RailShop shop = _shop(address(tok), address(0));
        vm.deal(address(shop), 1 ether);
        (uint256 q,) = _reserves(p, address(wbnb));
        uint256 cap = q * 5 / 10_000;
        uint256 out = shop.refill(shop.waiting()); // the first refill buys at once
        assertEq(shop.waiting(), 1 ether - cap, "clamped to 5 bps of the quote reserve; the rest waits");
        assertGt(out, 0);
        assertEq(shop.budget(), out);
        assertGt(router.lastAmountOutMin(), 0, "a nonzero minimum");
        assertLe(router.lastAmountOutMin(), out);
        uint256 w = shop.waiting();
        vm.expectRevert(RailShop.RefillTooSoon.selector);
        shop.refill(w);
        vm.warp(block.timestamp + 60);
        shop.refill(shop.waiting());
        assertLt(shop.waiting(), 1 ether - cap, "the next slice");
    }

    function test_L1_shop_erc20Quote6Decimals_bothSides() public {
        for (uint256 side; side < 2; ++side) {
            Coin usd = new Coin(6);
            TaxToken tok = _token(address(usd), side == 0);
            _pool(address(usd), tok, 100_000e6, Y);
            tok.setTax(300, 500);
            RailShop shop = _shop(address(tok), address(usd));
            usd.mint(address(shop), 1_000e6);
            shop.refill(1_000e6);
            assertEq(shop.waiting(), 950e6, "clamped to the cap of 50e6");
            assertEq(usd.allowance(address(shop), address(router)), 0);
        }
    }

    /// No pair, empty reserves, or an unreadable pool: the refill reverts as before and the asset waits.
    function test_L1_shop_noPairEmptyOrUnreadable_reverts() public {
        TaxToken tok = _token(address(wbnb), true);
        RailShop shop = _shop(address(tok), address(0));
        vm.deal(address(shop), 1 ether);
        vm.expectRevert(RailShop.NoPool.selector);
        shop.refill(1 ether);
        fac.createPair(address(wbnb), address(tok));
        vm.expectRevert(RailShop.NoPool.selector);
        shop.refill(1 ether);
        assertEq(shop.waiting(), 1 ether);
        RailShop unreadable = _shopOn(address(new NoFactoryRouter(address(wbnb))), address(tok), address(0));
        vm.deal(address(unreadable), 1 ether);
        vm.expectRevert(RailShop.NoPool.selector);
        unreadable.refill(1 ether);
    }

    // ── the pace, a failed swap, a tiny refill, a second burn rule, a slice too small ─

    /// The pace: the first call buys; a caller every 59 seconds then finds every other call too soon; 20 such calls
    /// make 10 more buys.
    function test_pace_aCallerEvery59Seconds_buysAtEveryOtherCall() public {
        TaxToken tok = _token(address(wbnb), true);
        _pool(address(wbnb), tok, X, Y);
        (RuleSplitter s,) = _splitter(address(tok), address(0), address(router));
        _fund(s, address(0), 10 ether); // the buy's part: 3 ether, sixty caps
        s.distribute();
        assertGt(s.delivered(2), 0, "the first call buys");
        uint256 buys;
        for (uint256 i; i < 20; ++i) {
            vm.warp(block.timestamp + 59);
            uint256 d = s.delivered(2);
            s.distribute();
            if (s.delivered(2) > d) ++buys;
            // calls 1, 3, 5... are 59 seconds after a buy: nothing; calls 2, 4, 6... are 118 seconds after it
            assertEq(s.delivered(2) > d, i % 2 == 1, "a buy exactly at every second call");
        }
        assertEq(buys, 10, "every second call buys");
    }

    /// A failed swap writes no time: a call in the same second buys. Here the router refuses (a 12% buy tax fails the
    /// minimum); the old tests show the same for a gas-starved call (RuleSplitter.t.sol,
    /// test_tooLittleGas_buyDelayed_othersPaid).
    function test_failedSwap_costsNoMinute_splitter() public {
        TaxToken tok = _token(address(wbnb), true);
        _pool(address(wbnb), tok, X, Y);
        (RuleSplitter s,) = _splitter(address(tok), address(0), address(router));
        _fund(s, address(0), 1 ether);
        tok.setTax(1200, 0);
        s.distribute();
        assertEq(s.delivered(2), 0, "the router refused");
        tok.setTax(300, 0);
        s.distribute(); // the same second
        assertGt(s.delivered(2), 0, "the retry in the same second buys");
    }

    /// The shop: a refused swap reverts the whole refill, its time included; the retry in the same second buys.
    function test_failedSwap_costsNoMinute_shop() public {
        TaxToken tok = _token(address(wbnb), true);
        _pool(address(wbnb), tok, X, Y);
        RailShop shop = _shop(address(tok), address(0));
        vm.deal(address(shop), 1 ether);
        tok.setTax(1200, 0);
        vm.expectRevert(bytes("INSUFFICIENT_OUTPUT_AMOUNT"));
        shop.refill(1 ether);
        tok.setTax(300, 0);
        assertGt(shop.refill(1 ether), 0, "the retry in the same second buys");
    }

    /// A refill buys the whole eligible slice or nothing: a smaller amount is refused (it would take the minute for less).
    function test_shop_refillBelowTheSlice_refused() public {
        TaxToken tok = _token(address(wbnb), true);
        V2Pair p = _pool(address(wbnb), tok, X, Y);
        RailShop shop = _shop(address(tok), address(0));
        vm.deal(address(shop), 1 ether);
        (uint256 q,) = _reserves(p, address(wbnb));
        uint256 slice = q * 5 / 10_000;
        vm.expectRevert(RailShop.AmountBelowSlice.selector);
        shop.refill(1);
        vm.expectRevert(RailShop.AmountBelowSlice.selector);
        shop.refill(slice - 1);
        shop.refill(slice);
        assertEq(shop.waiting(), 1 ether - slice, "exactly the slice");
        vm.deal(address(shop), slice / 2); // less than a slice waits: the slice is what waits
        vm.warp(block.timestamp + 60);
        uint256 w = shop.waiting();
        vm.expectRevert(RailShop.AmountBelowSlice.selector);
        shop.refill(w - 1);
        shop.refill(w);
        assertEq(shop.waiting(), 0);
    }

    /// One pace per splitter means one burn rule: a splitter with two BUY_BURN rules is refused.
    function test_twoBurnRules_refused() public {
        TaxToken tok = _token(address(wbnb), true);
        V2Router other = new V2Router(address(new V2Factory()), address(wbnb));
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](2);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 5000, target: address(router)});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 5000, target: address(other)});
        vm.expectRevert(IRuleSplitter.InvalidRules.selector);
        new RuleSplitter(address(tok), address(0), r);
        r[1].target = address(router);
        vm.expectRevert(IRuleSplitter.InvalidRules.selector);
        new RuleSplitter(address(tok), address(0), r);
    }

    /// A slice whose minimum rounds to zero (an expensive token, a few units owed) is refused and stays owed, although
    /// the pool would give it one token unit: every buy passes a nonzero minimum. It writes no time, so a real part in
    /// the same second is bought at once.
    function test_sliceTooSmall_refused_writesNoTime() public {
        TaxToken tok = _token(address(wbnb), true);
        _pool(address(wbnb), tok, X, 1e16); // 1e16 token units for 100e18: a token unit costs 10,000 quote units
        (RuleSplitter s,) = _splitter(address(tok), address(0), address(router));
        _fund(s, address(0), 40_000); // the buy's part: 12,000 units: 1 token unit out, a minimum of 0.887, so 0
        uint256 calls = router.calls();
        s.distribute();
        assertEq(s.owed(2), 12_000, "a minimum of zero: refused, owed");
        assertEq(router.calls(), calls, "no swap at all");
        _fund(s, address(0), 1 ether);
        s.distribute(); // the same second
        assertGt(s.delivered(2), 0, "a real part: bought at once");
    }

    // ── N4: an owed creator part, paid with all the gas the caller gives ─────

    function test_N4_hungryPayee_owedByDistribute_paidByTheClaim_once() public {
        HungryPayee payee = new HungryPayee();
        FeeRules pile = new FeeRules(address(0x70CE), address(0), NONE);
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](2);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 2000, target: address(payee)});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 8000, target: address(pile)});
        vm.etch(address(0x70CE), hex"00");
        RuleSplitter s = new RuleSplitter(address(0x70CE), address(0), r);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.owed(0), 200, "100,000 gas is not enough for this payee: owed");
        assertEq(pile.pile(), 800, "the pile is paid");
        s.distribute();
        assertEq(s.owed(0), 200, "and stays owed by distribute");

        vm.expectRevert(RuleSplitterBase.NotCreatorRule.selector);
        s.payOwedCreator(1);
        payee.setRefuse(true);
        vm.expectRevert(RuleSplitterBase.PaymentFailed.selector);
        s.payOwedCreator(0);
        assertEq(s.owed(0), 200, "a failed claim leaves the part owed");
        payee.setRefuse(false);

        vm.expectEmit(address(s));
        emit IRuleSplitter.Delivered(0, 200, 0);
        vm.prank(address(0x5713A9)); // anyone
        assertEq(s.payOwedCreator(0), 200);
        assertEq(address(payee).balance, 200, "the claim pays the rule's own target");
        assertEq(s.owed(0), 0);
        assertEq(s.totalOwed(), 0);
        assertEq(s.delivered(0), 200);
        assertEq(address(s).balance, 0, "balance = owed + pending still");

        assertEq(s.payOwedCreator(0), 0, "a second claim pays nothing");
        assertEq(address(payee).balance, 200);
    }

    function test_N4_erc20_claimPaysTheTarget() public {
        Coin usd = new Coin(6);
        FeeRules pile = new FeeRules(address(0x70CE), address(usd), NONE);
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](2);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 2000, target: CREATOR});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 8000, target: address(pile)});
        vm.etch(address(0x70CE), hex"00");
        RuleSplitter s = new RuleSplitter(address(0x70CE), address(usd), r);
        usd.mint(address(s), 1000);
        assertEq(s.payOwedCreator(0), 0, "nothing owed before a distribution");
        s.distribute();
        assertEq(usd.balanceOf(CREATOR), 200);
        assertEq(s.payOwedCreator(0), 0, "paid by distribute: nothing owed");
    }

    receive() external payable {}
}
