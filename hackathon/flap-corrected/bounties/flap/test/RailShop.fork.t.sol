// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20F, ITaxTokenF, ITaxProcessorF} from "./PileForkBase.sol";
import {GuardRoundsFork} from "./GuardRoundsFork.sol";
import {PairPriceGuard} from "fee-rules/PairPriceGuard.sol";
import {CurveConfig} from "../src/RulesCurveLauncher.sol";
import {RulesTokenCurveLauncher as TokenCurveLauncher} from "../src/RulesTokenCurveLauncher.sol";
import {RulesTokenCurveLauncherFactory as TokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileVault} from "../src/PileVault.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RailShop} from "fee-rules/RailShop.sol";
import {RailShopFactory} from "fee-rules/RailShopFactory.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

interface IV2PairS {
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IV2RouterFactoryS {
    function factory() external view returns (address);
}

interface IV2FactoryS {
    function getPair(address, address) external view returns (address);
}

interface IMintableUsd {
    function mint(address to, uint256 amount) external;
}

interface ICards {
    function ownerOf(uint256 id) external view returns (address);
    function setApprovalForAll(address op, bool ok) external;
    function approve(address to, uint256 id) external;
    function tokenURI(uint256 id) external view returns (string memory);
}

interface IRouterS {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice SH-288 on Flap: a card shop for a token that does not exist yet, named in the token's rules (creator 10%,
/// pile 30%, the shop 40%, buy and burn 20% last, as the rules factory requires: two CREATOR rules), on the live test network Portal and our four real test
/// card collections (packages/contracts/deployments/bnb-testnet/97-cards.json). The sale launches, trades raise tax,
/// the share-out pays the shop in the test dollar, the shop refills into the token, a holder of our test cards stocks
/// some and gives one for its exact price, and a buyer picks one for its exact price. Set FORK_URL; skipped otherwise.
contract RailShopForkTest is GuardRoundsFork {
    address constant USD = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;
    // The four test card collections on chain 97 and the wallet that holds ids 5 to 8 of each (97-cards.json).
    address constant COMMON = 0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174;
    address constant UNCOMMON = 0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577;
    address constant RARE = 0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC;
    address constant LEGENDARY = 0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143;
    address constant CARD_HOLDER = 0xc979F6Cb8902f56f76b926358dC451cBF8f310F0;
    /// PancakeSwap's V2 router on chain 97 (the one our launch template names), the factory's second accepted router.
    address constant PANCAKE_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;

    address payee = address(uint160(0xC0DE0099)); // the creator's own payee
    RulesVaultFactory rvf;
    TokenCurveLauncherFactory clf;
    RailShopFactory shops;

    function setUp() public {
        if (!_forkSetUp()) return;
        rvf = new RulesVaultFactory(PORTAL, USD, ROUTER, _pairedNext());
        clf = new TokenCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL, ANTI_SCAM);
        address[] memory routers = new address[](2);
        (routers[0], routers[1]) = (ROUTER, PANCAKE_ROUTER);
        address[] memory cards = new address[](4);
        (cards[0], cards[1], cards[2], cards[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        shops = new RailShopFactory(routers, cards); // the real run's construction
        address[4] memory who = [creator, alice, bob, trader];
        for (uint256 i; i < 4; ++i) IMintableUsd(USD).mint(who[i], 100_000 ether);
    }

    function _cfg(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c.name = "Card Rail";
        c.symbol = "CRAIL";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 1_700 ether;
        c.virtualBnb = 11_600 ether;
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
        IRouterS(ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, trader, block.timestamp + 600);
    }

    address token;
    RailShop shop;
    address vault;
    address[] nfts;

    function test_flap_shopNamedInTheRules_feedsRefillsGivesPicks() public {
        bytes32 salt = _mineSalt(keccak256("rail-shop"));
        _makeShop(salt);
        _rulesAndLaunch(salt);
        _tradeAndDispatch(token, vault);
        _shareOut();
        uint256 bought = _refill();
        _stockAndGive(bought);
        _pick(bought);
    }

    /// 1. The token's address is known before the launch; the shop is made for it first.
    function _makeShop(bytes32 salt) internal {
        token = ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, salt, PORTAL);
        assertEq(token.code.length, 0, "the token does not exist yet");
        nfts = new address[](4);
        (nfts[0], nfts[1], nfts[2], nfts[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        uint256[] memory prices = new uint256[](4);
        (prices[0], prices[1], prices[2], prices[3]) = (100 ether, 200 ether, 400 ether, 800 ether);
        address predicted = shops.shopAddress(creator, token, USD, ROUTER, nfts, prices, 10_000, 10_000 ether);
        vm.prank(creator);
        shop = RailShop(payable(shops.create(token, USD, ROUTER, nfts, prices, 10_000, 10_000 ether)));
        assertEq(address(shop), predicted, "the shop is where the factory said");
        assertTrue(shops.isShop(address(shop)));
        assertEq(shops.shopCount(token), 1);
    }

    /// 2. The rules name the shop (a second CREATOR rule), then the sale launches and is claimed.
    function _rulesAndLaunch(bytes32 salt) internal {
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](4);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 1000, target: payee});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 3000, target: address(0)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 4000, target: address(shop)});
        r[3] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 2000, target: address(0)}); // last
        vm.prank(creator);
        rvf.setRules(address(clf), salt, r);
        uint256 fee = clf.creationFee();
        vm.prank(creator);
        TokenCurveLauncher l = TokenCurveLauncher(portal.newLauncher{value: fee}(address(clf), abi.encode(_cfg(salt))));
        vm.startPrank(alice);
        IERC20F(USD).approve(address(l), 300 ether);
        l.buy(300 ether, 0);
        vm.stopPrank();
        uint256 need = l.costToComplete();
        vm.startPrank(bob);
        IERC20F(USD).approve(address(l), need);
        l.complete(need);
        vm.stopPrank();
        address launched;
        (launched,, vault) = l.launchInfo();
        assertEq(launched, token, "the token is the one the shop was made for");
        vm.prank(alice);
        l.claim();
        (IRuleSplitter.Kind k2, uint16 b2, address t2) = RulesVault(payable(vault)).rule(2);
        assertTrue(k2 == IRuleSplitter.Kind.CREATOR && b2 == 4000 && t2 == address(shop), "the shop's rule");
        (IRuleSplitter.Kind k3,,) = RulesVault(payable(vault)).rule(3);
        assertTrue(k3 == IRuleSplitter.Kind.BUY_BURN, "the buy and burn goes last");
    }

    function _part(uint256 income, uint256 bps) internal pure returns (uint256) {
        return income / 10_000 * bps + income % 10_000 * bps / 10_000;
    }

    /// 3. The share-out pays the shop its 40% as a plain payment of the test dollar (the buy and burn, last, takes the
    /// remainder). Under the swap guard the first share-out buys at once exactly min(burn part, 5 bps of the quote
    /// reserve); share-outs 61 seconds apart then buy the next slices until it is all bought.
    function _shareOut() internal {
        RulesVault s = RulesVault(payable(vault));
        uint256 income = s.pending();
        uint256 shopPart = _part(income, 4000);
        uint256 payee0 = IERC20F(USD).balanceOf(payee);
        (uint256 burnPart, uint256 firstBought,) = _firstShareOut(s, 3);
        assertEq(IERC20F(USD).balanceOf(payee) - payee0, _part(income, 1000), "the creator's 10%");
        assertEq(PileVault(payable(rvf.pileOf(token))).pile(), _part(income, 3000), "the pile's 30%");
        assertEq(s.delivered(2), shopPart, "the shop's 40% delivered");
        assertEq(shop.waiting(), shopPart, "waiting in the shop");
        (uint256 boughtBurn,,) = _buyRoundsUntilBurnt(s, 3, 40);
        assertEq(boughtBurn + firstBought, burnPart, "the 20% bought and burned, in rounds");
        assertGt(s.burned(3), 0, "the 20% bought and burned");
        assertEq(s.totalOwed(), 0);
        assertEq(shop.waiting(), shopPart, "the rounds pay the shop nothing more");
        emit log_named_uint("income shared (USD wei)", income);
        emit log_named_uint("the shop's part (USD wei)", shopPart);
    }

    /// 4. Refill under the swap guard: `refill(waiting())` buys at once exactly the slice min(waiting, 5 bps of the
    /// pair's quote reserve), at least the guard's minimum arriving; a smaller amount is refused (AmountBelowSlice); a
    /// retry inside the minute is refused (RefillTooSoon); rounds a minute apart until nothing waits. The bought
    /// tokens are the shop's budget.
    function _refill() internal returns (uint256 bought) {
        uint256 rounds;
        while (shop.waiting() != 0 && rounds < 40) {
            if (rounds != 0) vm.warp(block.timestamp + PairPriceGuard.MIN_GAP + 1);
            bought += _refillRound(rounds == 0);
            ++rounds;
        }
        assertEq(shop.waiting(), 0, "everything waiting bought, a slice a minute");
        assertEq(shop.budget(), bought, "the bought tokens are the shop's budget");
        emit log_named_uint("refill rounds, 61 s apart", rounds);
        emit log_named_uint("tokens bought by the refills", bought);
        assertGe(bought, 800 ether, "the budget pays a Legendary give");
    }

    /// @dev One refill round: the exact slice; on the first round also the two refusals.
    function _refillRound(bool first) internal returns (uint256 got) {
        uint256 w = shop.waiting();
        address pair = IV2FactoryS(IV2RouterFactoryS(ROUTER).factory()).getPair(USD, token);
        (uint112 r0, uint112 r1,) = IV2PairS(pair).getReserves();
        (uint256 rq, uint256 rt) = token < USD ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 cap = rq * PairPriceGuard.CAP_BPS / 10_000;
        uint256 slice = w < cap ? w : cap;
        if (first) {
            vm.expectRevert(RailShop.AmountBelowSlice.selector);
            shop.refill(slice - 1);
        }
        uint256 b0 = shop.budget();
        got = shop.refill(w);
        assertEq(w - shop.waiting(), slice, "exactly the slice min(waiting, 5 bps of the quote reserve)");
        assertEq(shop.budget() - b0, got);
        assertGe(got, PairPriceGuard.minimumOut(slice, rq, rt), "at least the guard's minimum");
        if (first) {
            assertGt(shop.waiting(), 0, "more waits for the next minute");
            uint256 left = shop.waiting();
            vm.expectRevert(RailShop.RefillTooSoon.selector);
            shop.refill(left);
        }
    }

    /// 5. Our real test cards: their holder stocks three and gives a Legendary for its exact price.
    function _stockAndGive(uint256 bought) internal {
        for (uint256 i; i < 4; ++i) assertEq(ICards(nfts[i]).ownerOf(5), CARD_HOLDER, "the holder has id 5 of each tier");
        vm.startPrank(CARD_HOLDER);
        ICards(COMMON).setApprovalForAll(address(shop), true);
        ICards(RARE).setApprovalForAll(address(shop), true);
        ICards(LEGENDARY).setApprovalForAll(address(shop), true);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (5, 6);
        shop.stock(COMMON, ids);
        uint256[] memory one = new uint256[](1);
        one[0] = 5;
        shop.stock(RARE, one);
        uint256 h0 = IERC20F(token).balanceOf(CARD_HOLDER);
        uint256 paid = shop.give(LEGENDARY, 5, 800 ether);
        vm.stopPrank();
        assertEq(paid, 800 ether);
        assertEq(IERC20F(token).balanceOf(CARD_HOLDER) - h0, 800 ether, "the holder received exactly the give price");
        assertEq(shop.budget(), bought - 800 ether);
        assertEq(shop.cardCount(), 4);
        assertEq(ICards(LEGENDARY).ownerOf(5), address(shop));
    }

    /// 6. A token holder picks a Common for exactly its pick price (twice the give price).
    function _pick(uint256 bought) internal {
        (, uint256 pickPrice) = shop.pricesOf(COMMON);
        assertEq(pickPrice, 200 ether);
        uint256 a0 = IERC20F(token).balanceOf(alice);
        assertGe(a0, pickPrice, "alice holds the token from the sale");
        vm.startPrank(alice);
        IERC20F(token).approve(address(shop), pickPrice);
        shop.pick(COMMON, 5, pickPrice, alice);
        vm.stopPrank();
        assertEq(a0 - IERC20F(token).balanceOf(alice), pickPrice, "alice paid exactly the pick price");
        assertEq(shop.budget(), bought - 800 ether + pickPrice, "the pick price stays as budget");
        assertEq(ICards(COMMON).ownerOf(5), alice);
        assertEq(shop.cardCount(), 3);
        assertEq(shop.capLeft(), 10_000 ether - 800 ether + 100 ether, "the pick gave its give price back to the cap");
        assertGt(bytes(ICards(COMMON).tokenURI(5)).length, 0, "the card's own metadata");
    }

    /// @dev Pool rounds in USD until the processor holds the vault slot's share, then dispatch to the splitter.
    function _tradeAndDispatch(address tok, address splitter) internal {
        address proc = ITaxTokenF(tok).taxProcessor();
        vm.warp(block.timestamp + 601);
        vm.startPrank(trader);
        _swap(USD, tok, 200 ether);
        for (uint256 i; i < 80 && ITaxProcessorF(proc).marketQuoteBalance() == 0; ++i) {
            uint256 amt = IERC20F(tok).balanceOf(trader) * 30 / 100;
            if (amt == 0) break;
            uint256 u0 = IERC20F(USD).balanceOf(trader);
            _swap(tok, USD, amt);
            uint256 got = IERC20F(USD).balanceOf(trader) - u0;
            if (got > 0) _swap(USD, tok, got * 90 / 100);
        }
        vm.stopPrank();
        uint256 share = ITaxProcessorF(proc).marketQuoteBalance();
        assertGt(share, 0, "the vault slot's share is waiting");
        uint256 p0 = RulesVault(payable(splitter)).pending();
        ITaxProcessorF(proc).dispatch();
        assertEq(RulesVault(payable(splitter)).pending() - p0, share, "the splitter received exactly the vault share");
    }
}
