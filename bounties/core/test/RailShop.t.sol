// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RailShop} from "../src/RailShop.sol";
import {IRailShop} from "../src/IRailShop.sol";
import {RailShopFactory} from "../src/RailShopFactory.sol";
import {RuleSplitter} from "../src/RuleSplitter.sol";
import {IRuleSplitter} from "../src/IRuleSplitter.sol";

/// An ERC-20 for the tests: anyone mints; it can tax its own transfers, answer false, or call back into a shop.
contract ShopCoin {
    mapping(address => uint256) private bal;
    address public shortFor; // balanceOf(shortFor) answers 16 bytes (a malformed answer)
    function setShortFor(address who) external { shortFor = who; }
    function balanceOf(address who) external view returns (uint256) {
        if (who == shortFor && who != address(0)) {
            assembly { mstore(0, 7) return(16, 16) }
        }
        return bal[who];
    }
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public taxBps;
    bool public answerFalse;
    address public reenter; // a shop to call back during transfers
    bytes public reenterCall;

    function setModes(uint256 taxBps_, bool answerFalse_) external { taxBps = taxBps_; answerFalse = answerFalse_; }
    function setReenter(address shop, bytes calldata call) external { reenter = shop; reenterCall = call; }
    function mint(address to, uint256 amount) external { bal[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transfer(address to, uint256 amount) external returns (bool) { return _move(msg.sender, to, amount); }

    function transferFrom(address f, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a < amount) return false;
        allowance[f][msg.sender] = a - amount;
        return _move(f, to, amount);
    }

    function _move(address f, address to, uint256 amount) private returns (bool) {
        if (answerFalse) return false;
        if (reenter != address(0)) {
            (bool ok, bytes memory ret) = reenter.call(reenterCall);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        }
        require(bal[f] >= amount, "balance");
        bal[f] -= amount;
        uint256 tax = amount * taxBps / 10_000;
        bal[to] += amount - tax;
        return true;
    }
}

/// An ERC-20 whose transfers return nothing (as some old tokens).
contract SilentCoin {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transfer(address to, uint256 amount) external { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; }
    function transferFrom(address f, address to, uint256 amount) external {
        allowance[f][msg.sender] -= amount; balanceOf[f] -= amount; balanceOf[to] += amount;
    }
}

/// An ERC-721 for the tests: it can refuse every transfer, call back into a shop, or lie about its owners.
contract ShopCards {
    mapping(uint256 => address) private _owner;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    bool public refuseAll;
    bool public noMove; // transfers do nothing (with `lie`: phantom cards)
    bool public lie; // ownerOf answers the shop for every id
    address public shop;
    address public reenter;
    bytes public reenterCall;

    function setModes(bool refuseAll_, bool lie_, address shop_) external { refuseAll = refuseAll_; lie = lie_; shop = shop_; }
    function setReenter(address target, bytes calldata call) external { reenter = target; reenterCall = call; }
    function setNoMove(bool n) external { noMove = n; }
    uint8 public readMode; // ownerOf: 0 answers, 1 reverts, 2 answers short, 3 answers a word that is no address, 4 answers zero
    function setReadMode(uint8 m) external { readMode = m; }
    function mint(address to, uint256 id) external { require(_owner[id] == address(0), "minted"); _owner[id] = to; }
    /// The collection's own admin move (no approval needed): a card leaves its holder.
    function adminMove(uint256 id, address to) external { _owner[id] = to; }
    function ownerOf(uint256 id) external view returns (address) {
        uint8 m = readMode;
        if (m == 1) revert("read failed");
        if (m == 2) assembly { mstore(0, 1) return(16, 16) }
        if (m == 3) assembly { mstore(0, not(0)) return(0, 32) }
        if (m == 4) return address(0);
        if (lie) return shop;
        require(_owner[id] != address(0), "no card");
        return _owner[id];
    }
    function approve(address to, uint256 id) external { require(msg.sender == _owner[id], "owner"); getApproved[id] = to; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }

    function transferFrom(address from, address to, uint256 id) public {
        require(!refuseAll, "refused");
        if (reenter != address(0)) {
            (bool ok, bytes memory ret) = reenter.call(reenterCall);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        }
        if (noMove) return;
        require(_owner[id] == from, "from");
        require(msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender], "approval");
        _owner[id] = to;
        getApproved[id] = address(0);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        if (to.code.length != 0) {
            (bool ok, bytes memory ret) = to.call(abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", msg.sender, from, id, ""));
            require(ok && ret.length >= 32 && bytes4(abi.decode(ret, (bytes32))) == 0x150b7a02, "receiver");
        }
    }
}

/// An ERC-721 without the three-argument safe transfer (only transferFrom).
contract PlainCards {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    function mint(address to, uint256 id) external { ownerOf[id] = to; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }
    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && (msg.sender == from || isApprovedForAll[from][msg.sender]), "transfer");
        ownerOf[id] = to;
    }
}

/// A PancakeSwap V2 router stand-in: a buy mints `rate` tokens per unit of input to `to`; it can refuse, refuse
/// inputs above a size (a pool too shallow for a huge amount), or draw only part of an ERC-20 allowance.
contract ShopRouter {
    address public constant WETH = address(0xBEEF);
    uint256 public rate = 1000;
    uint256 public maxIn = type(uint256).max;
    uint256 public drawBps = 10_000;
    bool public refuse;
    function setDraw(uint256 bps) external { drawBps = bps; }
    address public reenter;
    bytes public reenterCall;
    function setModes(bool refuse_, uint256 maxIn_) external { refuse = refuse_; maxIn = maxIn_; }
    function setReenter(address target, bytes calldata call) external { reenter = target; reenterCall = call; }
    function _during() private {
        if (reenter == address(0)) return;
        (bool ok, bytes memory ret) = reenter.call(reenterCall);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata path, address to, uint256) external payable {
        require(!refuse && msg.value <= maxIn && path[0] == WETH, "swap");
        _during();
        ShopCoin(path[1]).mint(to, msg.value * rate);
    }
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256, address[] calldata path, address to, uint256) external {
        require(!refuse && amountIn <= maxIn, "swap");
        _during();
        uint256 drawn = amountIn * drawBps / 10_000;
        require(ShopCoin(path[0]).transferFrom(msg.sender, address(this), drawn), "pull");
        ShopCoin(path[1]).mint(to, drawn * rate);
    }
}

/// A contract wallet that takes cards.
contract CardWallet {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return 0x150b7a02; }
}

contract RailShopTest is Test {
    RailShopFactory factory;
    ShopCoin token;
    ShopCoin assetCoin;
    ShopRouter router;
    ShopCards common;
    ShopCards rare;
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 constant COMMON = 1_000e18;
    uint256 constant RARE = 4_000e18;
    uint256 constant CAP = 10_000e18;
    uint256 room; // the fuzz's model of the period's room

    function setUp() public {
        token = new ShopCoin();
        assetCoin = new ShopCoin();
        router = new ShopRouter();
        common = new ShopCards();
        rare = new ShopCards();
        factory = _factory(address(common), address(rare));
    }

    function _factory(address a, address b) internal returns (RailShopFactory f) {
        address[] memory routers = new address[](1); routers[0] = address(router);
        address[] memory cols = new address[](b == address(0) ? 1 : 2); cols[0] = a;
        if (b != address(0)) cols[1] = b;
        f = new RailShopFactory(routers, cols);
    }

    function _lists() internal view returns (address[] memory nfts, uint256[] memory prices) {
        nfts = new address[](2); prices = new uint256[](2);
        (nfts[0], prices[0]) = (address(common), COMMON);
        (nfts[1], prices[1]) = (address(rare), RARE);
    }

    function _shop(address asset) internal returns (RailShop shop) {
        (address[] memory nfts, uint256[] memory prices) = _lists();
        vm.prank(creator);
        shop = RailShop(payable(factory.create(address(token), asset, address(router), nfts, prices, 5_000, CAP)));
    }

    /// A shop stocked with common #1..3 and rare #1..2 (from the creator), with `fund` tokens of budget.
    function _stocked(address asset, uint256 fund) internal returns (RailShop shop) {
        shop = _shop(asset);
        uint256[] memory ids = new uint256[](3);
        for (uint256 i; i < 3; ++i) { ids[i] = i + 1; common.mint(creator, i + 1); }
        uint256[] memory rids = new uint256[](2);
        for (uint256 i; i < 2; ++i) { rids[i] = i + 1; rare.mint(creator, i + 1); }
        vm.startPrank(creator);
        common.setApprovalForAll(address(shop), true);
        rare.setApprovalForAll(address(shop), true);
        shop.stock(address(common), ids);
        shop.stock(address(rare), rids);
        vm.stopPrank();
        token.mint(address(shop), fund);
    }

    // ── Factory ────────────────────────────────────────────────────────────

    function test_factory_addressCommitsToEveryParameter_beforeTheTokenExists() public {
        address futureToken = address(0x70CE);
        (address[] memory nfts, uint256[] memory prices) = _lists();
        address predicted = factory.shopAddress(creator, futureToken, address(0), address(router), nfts, prices, 0, CAP);
        assertEq(predicted, factory.addressFor(factory.paramsHash(creator, futureToken, address(0), address(router), nfts, prices, 0, CAP)));
        assertEq(predicted.code.length, 0);
        // Any other content lands elsewhere: another router, cap, surcharge, price, collection list or creator.
        assertTrue(factory.shopAddress(creator, futureToken, address(0), address(0xBAD), nfts, prices, 0, CAP) != predicted);
        assertTrue(factory.shopAddress(creator, futureToken, address(0), address(router), nfts, prices, 0, CAP + 1) != predicted);
        assertTrue(factory.shopAddress(creator, futureToken, address(0), address(router), nfts, prices, 1, CAP) != predicted);
        uint256[] memory other = new uint256[](2); (other[0], other[1]) = (COMMON, RARE + 1);
        assertTrue(factory.shopAddress(creator, futureToken, address(0), address(router), nfts, other, 0, CAP) != predicted);
        assertTrue(factory.shopAddress(alice, futureToken, address(0), address(router), nfts, prices, 0, CAP) != predicted);
        bytes32 hash = factory.paramsHash(creator, futureToken, address(0), address(router), nfts, prices, 0, CAP);
        vm.expectEmit(true, true, true, true);
        emit RailShopFactory.ShopCreated(predicted, creator, futureToken, address(0), address(router), hash);
        vm.prank(creator);
        address shop = factory.create(futureToken, address(0), address(router), nfts, prices, 0, CAP);
        assertEq(shop, predicted);
        assertTrue(factory.isShop(shop));
        assertEq(factory.shopCount(futureToken), 1);
        assertEq(factory.shopOf(futureToken, 0), shop);
        assertEq(RailShop(payable(shop)).creator(), creator);
        assertEq(RailShop(payable(shop)).factory(), address(factory));
        // The same parameters twice: refused (the address is taken). Other parameters: a second shop for the token.
        vm.prank(creator);
        vm.expectRevert();
        factory.create(futureToken, address(0), address(router), nfts, prices, 0, CAP);
        vm.prank(creator);
        address second = factory.create(futureToken, address(0), address(router), nfts, prices, 0, CAP + 1);
        assertEq(factory.shopCount(futureToken), 2);
        assertEq(factory.shopOf(futureToken, 1), second);
        // A stranger lengthens the open list, never the creator's own.
        vm.prank(alice);
        address strangers = factory.create(futureToken, address(0), address(router), nfts, prices, 0, CAP);
        assertEq(factory.shopCount(futureToken), 3);
        assertEq(factory.shopCountBy(futureToken, creator), 2);
        assertEq(factory.shopOfBy(futureToken, creator, 0), shop);
        assertEq(factory.shopOfBy(futureToken, creator, 1), second);
        assertEq(factory.shopCountBy(futureToken, alice), 1);
        assertEq(factory.shopOfBy(futureToken, alice, 0), strangers);
        assertEq(factory.shopCountBy(address(token), creator), 0);
        // Nobody but the factory initializes, and only once.
        vm.expectRevert(IRailShop.InvalidShop.selector);
        RailShop(payable(shop)).initialize(creator, futureToken, address(0), address(router), nfts, prices, 0, CAP);
        assertFalse(factory.isShop(address(new RailShop())));
    }

    function _refused(address tok, address asset, address rtr, address[] memory nfts, uint256[] memory prices, uint16 bps, uint256 cap) internal {
        vm.prank(creator);
        vm.expectRevert(IRailShop.InvalidShop.selector);
        factory.create(tok, asset, rtr, nfts, prices, bps, cap);
    }

    function _notAccepted(address what, address rtr, address[] memory nfts, uint256[] memory prices) internal {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RailShopFactory.NotAccepted.selector, what));
        factory.create(address(token), address(0), rtr, nfts, prices, 0, CAP);
    }

    /// The factory accepts only its routers and collections: a creator cannot bring its own.
    function test_factory_acceptsOnlyItsRoutersAndCollections() public {
        (address[] memory nfts, uint256[] memory prices) = _lists();
        ShopRouter own = new ShopRouter();
        _notAccepted(address(own), address(own), nfts, prices); // a router of the creator's own
        _notAccepted(address(0x1234), address(0x1234), nfts, prices); // a router without code
        ShopCards mine = new ShopCards();
        address[] memory withMine = new address[](2); (withMine[0], withMine[1]) = (address(common), address(mine));
        _notAccepted(address(mine), address(router), withMine, prices); // a collection of the creator's own
        address[] memory noCode = new address[](1); noCode[0] = address(0x5555);
        uint256[] memory one = new uint256[](1); one[0] = COMMON;
        _notAccepted(address(0x5555), address(router), noCode, one);
        address[] memory selfList = new address[](1); selfList[0] = address(token);
        _notAccepted(address(token), address(router), selfList, one); // the token as a collection
        address[] memory rs = factory.acceptedRouters();
        address[] memory cs = factory.acceptedCollections();
        assertEq(rs.length, 1); assertEq(rs[0], address(router));
        assertEq(cs.length, 2); assertEq(cs[0], address(common)); assertEq(cs[1], address(rare));
        assertTrue(factory.acceptsRouter(address(router)) && !factory.acceptsRouter(address(own)));
        // The factory's own construction: something to accept, with code, each once.
        address[] memory none = new address[](0);
        address[] memory r1 = new address[](1); r1[0] = address(router);
        vm.expectRevert(abi.encodeWithSelector(RailShopFactory.NotAccepted.selector, address(0)));
        new RailShopFactory(none, cs);
        address[] memory noCodeRouter = new address[](1); noCodeRouter[0] = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(RailShopFactory.NotAccepted.selector, address(0x1234)));
        new RailShopFactory(noCodeRouter, cs);
        address[] memory twice = new address[](2); (twice[0], twice[1]) = (address(common), address(common));
        vm.expectRevert(abi.encodeWithSelector(RailShopFactory.NotAccepted.selector, address(common)));
        new RailShopFactory(r1, twice);
    }

    function test_factory_refusesBadShops() public {
        (address[] memory nfts, uint256[] memory prices) = _lists();
        _refused(address(token), address(0x9999), address(router), nfts, prices, 0, CAP); // asset without code
        _refused(address(0), address(0), address(router), nfts, prices, 0, CAP); // no token
        _refused(address(token), address(token), address(router), nfts, prices, 0, CAP); // token is the asset
        _refused(address(token), address(0), address(router), nfts, prices, 50_001, CAP); // surcharge too high
        _refused(address(token), address(0), address(router), nfts, prices, 0, 0); // no cap
        _refused(address(token), address(0), address(router), new address[](0), new uint256[](0), 0, CAP); // no collection
        uint256[] memory one = new uint256[](1); one[0] = COMMON;
        _refused(address(token), address(0), address(router), nfts, one, 0, CAP); // lengths differ
        address[] memory five = new address[](5); uint256[] memory fivePrices = new uint256[](5);
        for (uint256 i; i < 5; ++i) { five[i] = address(new ShopCards()); fivePrices[i] = COMMON; }
        address[] memory routers = new address[](1); routers[0] = address(router);
        RailShopFactory f5 = new RailShopFactory(routers, five);
        vm.prank(creator);
        vm.expectRevert(IRailShop.InvalidShop.selector);
        f5.create(address(token), address(0), address(router), five, fivePrices, 0, CAP); // more than four
        address[] memory dup = new address[](2); dup[0] = address(common); dup[1] = address(common);
        _refused(address(token), address(0), address(router), dup, prices, 0, CAP); // twice the same collection
        uint256[] memory zero = new uint256[](2);
        _refused(address(token), address(0), address(router), nfts, zero, 0, CAP); // a zero price
        _refused(address(token), address(0), address(router), nfts, prices, 0, RARE - 1); // a give price above the cap
        _refused(address(token), address(0), address(router), nfts, prices, 0, uint256(type(uint128).max) + 1); // cap above 2^128 - 1
        vm.prank(creator); // the largest cap is accepted, with the largest surcharge
        factory.create(address(token), address(0), address(router), nfts, prices, 50_000, type(uint128).max);
    }

    /// The external surface, from the compiled artifact, enumerated: every state-changing function of the shop is one
    /// of give, pick, stock, refill, drop and the factory's one-time initialize; nothing else (no owner, setter, sweep).
    function test_abi_exactlyTheseWriters() public view {
        string memory j = vm.readFile("out/RailShop.sol/RailShop.json");
        string[6] memory expected = ["drop", "give", "initialize", "pick", "refill", "stock"];
        bool[6] memory seen;
        uint256 writers;
        for (uint256 i; vm.keyExistsJson(j, string.concat(".abi[", vm.toString(i), "]")); ++i) {
            string memory base = string.concat(".abi[", vm.toString(i), "]");
            if (keccak256(bytes(vm.parseJsonString(j, string.concat(base, ".type")))) != keccak256("function")) continue;
            bytes32 m = keccak256(bytes(vm.parseJsonString(j, string.concat(base, ".stateMutability"))));
            if (m == keccak256("view") || m == keccak256("pure")) continue;
            string memory name = vm.parseJsonString(j, string.concat(base, ".name"));
            bool known;
            for (uint256 k; k < 6; ++k) {
                if (keccak256(bytes(name)) == keccak256(bytes(expected[k]))) { assertFalse(seen[k], name); seen[k] = true; known = true; }
            }
            assertTrue(known, string.concat("an unexpected writer: ", name));
            ++writers;
        }
        assertEq(writers, 6);
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool same = true;
            for (uint256 j; j < needle.length; ++j) if (hay[i + j] != needle[j]) { same = false; break; }
            if (same) return true;
        }
        return false;
    }

    // ── Stock and views ────────────────────────────────────────────────────

    function test_stock_anyoneListedOnly_andTheList() public {
        RailShop shop = _stocked(address(0), 0);
        assertEq(shop.cardCount(), 5);
        (address[] memory nfts, uint256[] memory ids) = shop.cards(1, 3);
        assertEq(nfts.length, 3);
        (address n0, uint256 i0) = shop.card(1);
        assertEq(nfts[0], n0); assertEq(ids[0], i0);
        (nfts,) = shop.cards(4, 10); assertEq(nfts.length, 1);
        (nfts,) = shop.cards(9, 10); assertEq(nfts.length, 0);
        assertTrue(shop.holds(address(common), 2));
        (address c0, uint256 g0, uint256 p0) = shop.collection(0);
        assertEq(c0, address(common)); assertEq(g0, COMMON); assertEq(p0, COMMON * 15 / 10);
        (uint256 g1, uint256 p1) = shop.pricesOf(address(rare));
        assertEq(g1, RARE); assertEq(p1, RARE * 15 / 10);
        vm.expectRevert(IRailShop.NotListed.selector); shop.pricesOf(address(token));
        // An unlisted collection cannot be stocked; a held card cannot be counted twice.
        ShopCards other = new ShopCards(); other.mint(alice, 1);
        uint256[] memory one = new uint256[](1); one[0] = 1;
        vm.prank(alice); vm.expectRevert(IRailShop.NotListed.selector); shop.stock(address(other), one);
        vm.prank(creator); vm.expectRevert(IRailShop.NotHeld.selector); shop.stock(address(common), one);
        // A card sent by a plain transfer is counted by stock, without a transfer.
        common.mint(alice, 9);
        vm.prank(alice); common.transferFrom(alice, address(shop), 9);
        assertFalse(shop.holds(address(common), 9));
        one[0] = 9;
        vm.prank(bob); shop.stock(address(common), one);
        assertTrue(shop.holds(address(common), 9));
        assertEq(shop.cardCount(), 6);
    }

    // ── Give ───────────────────────────────────────────────────────────────

    function test_give_paysExactlyThePrice_andTheCardIsCounted() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        vm.expectEmit(true, true, true, true);
        emit IRailShop.Given(address(common), 7, alice, COMMON);
        uint256 paid = shop.give(address(common), 7, COMMON);
        vm.stopPrank();
        assertEq(paid, COMMON);
        assertEq(token.balanceOf(alice), COMMON);
        assertEq(shop.budget(), 20_000e18 - COMMON);
        assertEq(common.ownerOf(7), address(shop));
        assertTrue(shop.holds(address(common), 7));
        assertEq(shop.capLeft(), CAP - COMMON);
    }

    function test_give_refusals() public {
        RailShop shop = _stocked(address(0), COMMON - 1);
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        vm.expectRevert(IRailShop.BudgetShort.selector); shop.give(address(common), 7, 0);
        vm.stopPrank();
        token.mint(address(shop), 1);
        vm.startPrank(alice);
        vm.expectRevert(IRailShop.PriceAbove.selector); shop.give(address(common), 7, COMMON + 1);
        vm.expectRevert(IRailShop.NotListed.selector); shop.give(address(token), 7, 0);
        shop.give(address(common), 7, COMMON);
        vm.stopPrank();
        assertEq(shop.budget(), 0);
    }

    function test_cap_edges_andThePeriodsTurn() public {
        RailShop shop = _stocked(address(0), 100_000e18);
        // 2 rares + 2 commons = 10,000e18 = exactly the cap; one more common is refused.
        for (uint256 id = 10; id < 12; ++id) { rare.mint(alice, id); }
        for (uint256 id = 10; id < 13; ++id) { common.mint(alice, id); }
        vm.startPrank(alice);
        rare.setApprovalForAll(address(shop), true);
        common.setApprovalForAll(address(shop), true);
        shop.give(address(rare), 10, 0);
        shop.give(address(rare), 11, 0);
        shop.give(address(common), 10, 0);
        shop.give(address(common), 11, 0);
        assertEq(shop.capLeft(), 0);
        vm.expectRevert(IRailShop.CapReached.selector); shop.give(address(common), 12, 0);
        vm.stopPrank();
        uint256 ends = shop.periodEnds();
        assertEq(ends, shop.createdAt() + 7 days);
        vm.warp(ends - 1);
        vm.prank(alice); vm.expectRevert(IRailShop.CapReached.selector); shop.give(address(common), 12, 0);
        vm.warp(ends); // the period turns
        assertEq(shop.capLeft(), CAP);
        vm.prank(alice); shop.give(address(common), 12, 0);
        assertEq(shop.capLeft(), CAP - COMMON);
        assertEq(shop.periodEnds(), ends + 7 days);
    }

    // ── Pick ───────────────────────────────────────────────────────────────

    function test_pick_takesExactlyThePickPrice_whichStaysAsBudget() public {
        RailShop shop = _stocked(address(0), 0);
        uint256 price = RARE * 15 / 10;
        token.mint(bob, price);
        vm.startPrank(bob);
        token.approve(address(shop), price);
        vm.expectRevert(IRailShop.PriceAbove.selector); shop.pick(address(rare), 2, price - 1, bob);
        vm.expectEmit(true, true, true, true);
        emit IRailShop.Picked(address(rare), 2, bob, bob, price);
        uint256 paid = shop.pick(address(rare), 2, price, bob);
        vm.stopPrank();
        assertEq(paid, price);
        assertEq(token.balanceOf(bob), 0);
        assertEq(shop.budget(), price);
        assertEq(rare.ownerOf(2), bob);
        assertFalse(shop.holds(address(rare), 2));
        assertEq(shop.cardCount(), 4);
    }

    function test_pick_roundsTheSurchargeUp() public {
        address[] memory nfts = new address[](1); nfts[0] = address(common);
        uint256[] memory prices = new uint256[](1); prices[0] = 3; // 3 x 1.5 = 4.5: rounded up to 5
        vm.prank(creator);
        RailShop shop = RailShop(payable(factory.create(address(token), address(0), address(router), nfts, prices, 5_000, CAP)));
        (, uint256 pickPrice) = shop.pricesOf(address(common));
        assertEq(pickPrice, 5);
    }

    function test_pick_refusals_andTheLastCardStays() public {
        RailShop shop = _stocked(address(0), 0);
        token.mint(bob, 100_000e18);
        vm.startPrank(bob);
        token.approve(address(shop), type(uint256).max);
        vm.expectRevert(IRailShop.NotHeld.selector); shop.pick(address(common), 99, type(uint256).max, bob);
        vm.expectRevert(IRailShop.BadReceiver.selector); shop.pick(address(common), 1, type(uint256).max, address(0));
        vm.expectRevert(IRailShop.BadReceiver.selector); shop.pick(address(common), 1, type(uint256).max, address(shop));
        vm.expectRevert(IRailShop.NotListed.selector); shop.pick(address(token), 1, type(uint256).max, bob);
        shop.pick(address(common), 1, type(uint256).max, bob);
        shop.pick(address(common), 2, type(uint256).max, bob);
        shop.pick(address(common), 3, type(uint256).max, bob);
        shop.pick(address(rare), 1, type(uint256).max, bob);
        assertEq(shop.cardCount(), 1);
        vm.expectRevert(IRailShop.LastCard.selector); shop.pick(address(rare), 2, type(uint256).max, bob);
        vm.stopPrank();
        assertEq(rare.ownerOf(2), address(shop));
    }

    function test_pick_toAContractWallet() public {
        RailShop shop = _stocked(address(0), 0);
        CardWallet wallet = new CardWallet();
        token.mint(bob, 2_000e18);
        vm.startPrank(bob);
        token.approve(address(shop), 2_000e18);
        shop.pick(address(common), 1, type(uint256).max, address(wallet));
        vm.stopPrank();
        assertEq(common.ownerOf(1), address(wallet));
    }

    // ── Exactness by balance, odd tokens ───────────────────────────────────

    function test_taxedToken_giveAndPickRefused() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        token.setModes(100, false); // a 1% tax on every transfer
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        vm.expectRevert(IRailShop.TransferFailed.selector); shop.give(address(common), 7, 0);
        vm.stopPrank();
        token.mint(bob, 10_000e18);
        vm.startPrank(bob);
        token.approve(address(shop), type(uint256).max);
        vm.expectRevert(IRailShop.TransferFailed.selector); shop.pick(address(common), 1, type(uint256).max, bob);
        vm.stopPrank();
        assertEq(shop.cardCount(), 5);
        assertEq(common.ownerOf(7), alice);
    }

    function test_tokenAnsweringFalse_refused_nothingMoves() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        token.setModes(0, true);
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        vm.expectRevert(IRailShop.TransferFailed.selector); shop.give(address(common), 7, 0);
        vm.stopPrank();
        assertEq(common.ownerOf(7), alice);
        assertEq(shop.capLeft(), CAP);
    }

    function test_tokenAnsweringNothing_works() public {
        SilentCoin silent = new SilentCoin();
        address[] memory nfts = new address[](1); nfts[0] = address(common);
        uint256[] memory prices = new uint256[](1); prices[0] = COMMON;
        vm.prank(creator);
        RailShop shop = RailShop(payable(factory.create(address(silent), address(0), address(router), nfts, prices, 0, CAP)));
        silent.mint(address(shop), COMMON);
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        shop.give(address(common), 7, COMMON);
        vm.stopPrank();
        assertEq(silent.balanceOf(alice), COMMON);
    }

    function test_tokenWithoutCode_noBudget_giveRefused() public {
        address[] memory nfts = new address[](1); nfts[0] = address(common);
        uint256[] memory prices = new uint256[](1); prices[0] = COMMON;
        vm.prank(creator);
        RailShop shop = RailShop(payable(factory.create(address(0x70CE), address(0), address(router), nfts, prices, 0, CAP)));
        assertEq(shop.budget(), 0);
        common.mint(alice, 7);
        vm.prank(alice); vm.expectRevert(IRailShop.BudgetShort.selector); shop.give(address(common), 7, 0);
        // No stock and no refill before the token exists: cards would have no exit, the asset would buy nothing.
        uint256[] memory one = new uint256[](1); one[0] = 7;
        vm.prank(alice); vm.expectRevert(IRailShop.TokenNotLive.selector); shop.stock(address(common), one);
        vm.deal(address(shop), 1 ether);
        vm.expectRevert(IRailShop.TokenNotLive.selector); shop.refill(1 ether);
        assertEq(shop.waiting(), 1 ether, "the payment waits");
    }

    // ── Re-entry and misbehaving collections ───────────────────────────────

    function test_reenteringCardContract_refused() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        common.mint(alice, 7);
        vm.prank(alice); common.approve(address(shop), 7);
        common.setReenter(address(shop), abi.encodeCall(RailShop.give, (address(common), 1, 0)));
        vm.prank(alice); vm.expectRevert(IRailShop.Reentrancy.selector); shop.give(address(common), 7, 0);
        common.setReenter(address(shop), abi.encodeCall(RailShop.refill, (1)));
        token.mint(bob, 10_000e18);
        vm.startPrank(bob);
        token.approve(address(shop), type(uint256).max);
        vm.expectRevert(IRailShop.Reentrancy.selector); shop.pick(address(common), 1, type(uint256).max, bob);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 0);
        assertEq(shop.cardCount(), 5);
    }

    function test_reenteringToken_refused() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        token.setReenter(address(shop), abi.encodeCall(RailShop.pick, (address(rare), 1, type(uint256).max, alice)));
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        vm.expectRevert(IRailShop.TransferFailed.selector); // the re-entry is refused inside the token's transfer
        shop.give(address(common), 7, 0);
        vm.stopPrank();
        assertEq(common.ownerOf(7), alice);
        assertEq(rare.ownerOf(1), address(shop));
    }

    function test_refusingCollection_hurtsOnlyItsOwnCards() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        common.setModes(true, false, address(0)); // every common transfer refused
        token.mint(bob, 10_000e18);
        vm.startPrank(bob);
        token.approve(address(shop), type(uint256).max);
        vm.expectRevert(); shop.pick(address(common), 1, type(uint256).max, bob);
        shop.pick(address(rare), 1, type(uint256).max, bob); // the other collection works
        vm.stopPrank();
        rare.mint(alice, 9);
        vm.startPrank(alice);
        rare.approve(address(shop), 9);
        shop.give(address(rare), 9, 0);
        vm.stopPrank();
        assertEq(rare.ownerOf(1), bob);
        assertEq(token.balanceOf(alice), RARE);
    }

    function test_lyingCollection_doesNotTouchTheOtherCollectionsCards() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        common.setModes(false, true, address(shop)); // ownerOf answers the shop for every id
        common.setNoMove(true); // and it delivers nothing
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        shop.give(address(common), 7, 0); // the creator's choice of collection: the shop is only as honest as it is
        vm.stopPrank();
        // The rare cards and their prices are untouched.
        assertTrue(shop.holds(address(rare), 1) && shop.holds(address(rare), 2));
        assertEq(rare.ownerOf(1), address(shop));
    }

    // ── Income and refill ──────────────────────────────────────────────────

    function test_plainNativePayment_within100kGas_noWork() public {
        RailShop shop = _shop(address(0));
        vm.deal(address(this), 1 ether);
        uint256 g = gasleft();
        (bool ok,) = address(shop).call{value: 1 ether, gas: 100_000}("");
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertLt(used, 100_000);
        assertEq(shop.waiting(), 1 ether);
        RailShop erc20Shop = _shopFor(address(assetCoin));
        vm.deal(address(this), 1 ether); // a funded sender: the refusal is the shop's
        (ok,) = address(erc20Shop).call{value: 1, gas: 100_000}("");
        assertFalse(ok); // a native payment to a shop whose asset is an ERC-20 is refused
        assertEq(address(erc20Shop).balance, 0);
        (ok,) = address(erc20Shop).call{gas: 100_000}(""); // the splitter's empty wake call is accepted
        assertTrue(ok);
    }

    function _shopFor(address asset) internal returns (RailShop shop) {
        (address[] memory nfts, uint256[] memory prices) = _lists();
        ShopCoin t = new ShopCoin();
        vm.prank(creator);
        shop = RailShop(payable(factory.create(address(t), asset, address(router), nfts, prices, 0, CAP)));
    }

    function test_refill_native_andErc20() public {
        RailShop shop = _shop(address(0));
        vm.expectRevert(IRailShop.NothingWaiting.selector); shop.refill(0);
        vm.expectRevert(IRailShop.AmountAbove.selector); shop.refill(1);
        vm.deal(address(shop), 2 ether);
        vm.expectEmit(true, true, true, true);
        emit IRailShop.Refilled(2 ether, 2_000 ether);
        uint256 out = shop.refill(2 ether);
        assertEq(out, 2_000 ether);
        assertEq(shop.budget(), 2_000 ether);
        assertEq(shop.waiting(), 0);

        RailShop erc20Shop = _shop2(address(assetCoin));
        assetCoin.mint(address(erc20Shop), 5e6);
        router.setDraw(9_000); // the router draws only 90% of what it was allowed
        vm.expectEmit(true, true, true, true);
        emit IRailShop.Refilled(4.5e6, 4.5e6 * 1000); // the measured debit, not the amount asked
        vm.prank(bob); out = erc20Shop.refill(5e6);
        assertEq(out, 4.5e6 * 1000);
        assertEq(erc20Shop.waiting(), 5e5, "waiting fell by exactly the reported debit");
        assertEq(assetCoin.allowance(address(erc20Shop), address(router)), 0, "the allowance is reset to zero");
    }

    function _shop2(address asset) internal returns (RailShop shop) {
        (address[] memory nfts, uint256[] memory prices) = _lists();
        vm.prank(bob);
        shop = RailShop(payable(factory.create(address(token), asset, address(router), nfts, prices, 0, CAP)));
    }

    function test_refill_hugeAmount_inSlices_theRestWaits() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        vm.deal(address(shop), 1_000_000 ether); // a huge amount of the asset
        router.setModes(false, 10 ether); // the pool takes at most 10
        vm.expectRevert(); shop.refill(1_000_000 ether);
        uint256 budget0 = shop.budget();
        shop.refill(10 ether); // a slice the pool can take
        shop.refill(10 ether);
        assertEq(shop.waiting(), 1_000_000 ether - 20 ether, "the rest keeps waiting");
        assertEq(shop.budget(), budget0 + 20 ether * 1000);
        common.mint(alice, 7);
        vm.startPrank(alice);
        common.approve(address(shop), 7);
        shop.give(address(common), 7, 0); // gives and picks go on
        vm.stopPrank();
        router.setModes(true, type(uint256).max);
        vm.expectRevert(); shop.refill(1 ether);
        assertEq(shop.waiting(), 1_000_000 ether - 20 ether, "a failed refill leaves the asset waiting");
    }

    function test_reentryThroughTheRouter_refused() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        vm.deal(address(shop), 1 ether);
        router.setReenter(address(shop), abi.encodeCall(RailShop.give, (address(common), 1, 0)));
        vm.expectRevert(IRailShop.Reentrancy.selector); shop.refill(1 ether);
        assertEq(shop.waiting(), 1 ether);
        assertEq(shop.budget(), 20_000e18);
    }

    /// The room is net of picks in BOTH orders: at no surcharge neither give-then-pick nor pick-then-give, twenty
    /// rounds each, uses any of it; a pick as the first action of a new period adds to the room.
    function test_capNetOfPicks_inBothOrders_atNoSurcharge() public {
        (address[] memory nfts, uint256[] memory prices) = _lists();
        vm.prank(creator);
        RailShop shop = RailShop(payable(factory.create(address(token), address(0), address(router), nfts, prices, 0, CAP)));
        uint256[] memory ids = new uint256[](3); (ids[0], ids[1], ids[2]) = (1, 2, 3);
        common.mint(creator, 1); common.mint(creator, 2); common.mint(creator, 3);
        vm.startPrank(creator); common.setApprovalForAll(address(shop), true); shop.stock(address(common), ids); vm.stopPrank();
        token.mint(address(shop), 100_000e18);
        rare.mint(alice, 7);
        token.mint(alice, 10 * COMMON);
        vm.startPrank(alice);
        rare.setApprovalForAll(address(shop), true);
        common.setApprovalForAll(address(shop), true);
        token.approve(address(shop), type(uint256).max);
        for (uint256 round; round < 20; ++round) { // give then pick: 20 x 4,000 would be 8 caps
            shop.give(address(rare), 7, RARE);
            shop.pick(address(rare), 7, RARE, alice);
            assertEq(shop.capLeft(), CAP, "give-then-pick leaves the room unchanged");
        }
        uint256 budget0 = shop.budget();
        for (uint256 round; round < 20; ++round) { // pick then give: the credit is kept, the give takes it back
            shop.pick(address(common), 1, COMMON, alice);
            assertEq(shop.capLeft(), CAP + COMMON, "a pick adds its give price, also before any give");
            shop.give(address(common), 1, COMMON);
            assertEq(shop.capLeft(), CAP, "pick-then-give leaves the room unchanged");
        }
        assertEq(shop.budget(), budget0, "nothing moved net");
        vm.stopPrank();
        common.mint(bob, 9);
        vm.startPrank(bob); common.approve(address(shop), 9); shop.give(address(common), 9, COMMON); vm.stopPrank();
        assertEq(shop.capLeft(), CAP - COMMON, "an honest give is still paid");
        // A new period starts at the cap; a pick as its first action adds to the room, above the cap.
        vm.warp(shop.periodEnds());
        assertEq(shop.capLeft(), CAP);
        token.mint(bob, 10_000e18);
        vm.startPrank(bob); token.approve(address(shop), type(uint256).max); shop.pick(address(common), 2, COMMON, bob); vm.stopPrank();
        assertEq(shop.capLeft(), CAP + COMMON, "the room can exceed the cap after picks");
        // Gives minus picks in the period stay within the cap: the room now pays the cap plus the one pick.
        for (uint256 id = 20; id < 31; ++id) { common.mint(alice, id); }
        vm.startPrank(alice);
        for (uint256 id = 20; id < 31; ++id) shop.give(address(common), id, 0); // 11 x 1,000 = cap + one pick
        assertEq(shop.capLeft(), 0);
        common.mint(alice, 31);
        vm.expectRevert(IRailShop.CapReached.selector); shop.give(address(common), 31, 0);
        vm.stopPrank();
    }

    function test_collectionWithoutSafeTransfer_canBePicked() public {
        PlainCards plain = new PlainCards();
        address[] memory nfts = new address[](1); nfts[0] = address(plain);
        uint256[] memory prices = new uint256[](1); prices[0] = COMMON;
        RailShopFactory f = _factory(address(plain), address(0));
        vm.prank(creator);
        RailShop shop = RailShop(payable(f.create(address(token), address(0), address(router), nfts, prices, 0, CAP)));
        plain.mint(creator, 1); plain.mint(creator, 2);
        uint256[] memory ids = new uint256[](2); (ids[0], ids[1]) = (1, 2);
        vm.startPrank(creator); plain.setApprovalForAll(address(shop), true); shop.stock(address(plain), ids); vm.stopPrank();
        token.mint(bob, COMMON);
        vm.startPrank(bob); token.approve(address(shop), COMMON); shop.pick(address(plain), 1, COMMON, bob); vm.stopPrank();
        assertEq(plain.ownerOf(1), bob);
    }

    function test_aCardThatLeft_isDroppedFromTheList() public {
        RailShop shop = _stocked(address(0), 0);
        vm.expectRevert(IRailShop.StillHeld.selector); shop.drop(address(common), 2);
        vm.expectRevert(IRailShop.NotHeld.selector); shop.drop(address(common), 99);
        common.adminMove(2, alice); // the collection's own doing
        // An indefinite answer never removes a card: a read that fails once, a short, a non-address or a zero answer.
        for (uint8 m = 1; m <= 4; ++m) {
            common.setReadMode(m);
            vm.prank(bob); vm.expectRevert(IRailShop.OwnerUnknown.selector); shop.drop(address(common), 2);
            assertTrue(shop.holds(address(common), 2));
        }
        common.setReadMode(0);
        // A held card behind a failing read is not hidden either.
        common.setReadMode(1);
        vm.prank(bob); vm.expectRevert(IRailShop.OwnerUnknown.selector); shop.drop(address(common), 3);
        common.setReadMode(0);
        assertEq(shop.cardCount(), 5);
        vm.expectEmit(true, true, true, true);
        emit IRailShop.Dropped(address(common), 2);
        vm.prank(bob); shop.drop(address(common), 2);
        assertFalse(shop.holds(address(common), 2));
        assertEq(shop.cardCount(), 4);
        (address[] memory nfts, uint256[] memory ids) = shop.cards(0, 10);
        for (uint256 i; i < nfts.length; ++i) assertTrue(!(nfts[i] == address(common) && ids[i] == 2));
    }

    /// A token whose balance read answers short during a give or a pick: the call reverts, nothing moves.
    function test_shortBalanceAnswer_inGiveAndPick_reverts_nothingMoves() public {
        RailShop shop = _stocked(address(0), 20_000e18);
        common.mint(alice, 7);
        vm.prank(alice); common.approve(address(shop), 7);
        token.setShortFor(alice); // the holder's balance answers 16 bytes
        vm.prank(alice); vm.expectRevert(IRailShop.BalanceUnreadable.selector); shop.give(address(common), 7, 0);
        assertEq(common.ownerOf(7), alice);
        assertEq(shop.capLeft(), CAP);
        token.setShortFor(address(0));
        assertEq(shop.budget(), 20_000e18);
        token.mint(bob, 10_000e18);
        vm.prank(bob); token.approve(address(shop), type(uint256).max);
        token.setShortFor(bob); // the buyer's balance answers 16 bytes
        vm.prank(bob); vm.expectRevert(IRailShop.BalanceUnreadable.selector); shop.pick(address(common), 1, type(uint256).max, bob);
        token.setShortFor(address(0));
        assertEq(token.balanceOf(bob), 10_000e18);
        assertEq(shop.budget(), 20_000e18);
        assertTrue(shop.holds(address(common), 1));
        assertEq(common.ownerOf(1), address(shop));
        assertEq(shop.capLeft(), CAP);
    }

    /// A collection that lies about its owners and does not move cards (the creator's choice) draws gives from the
    /// shared budget, phantom cards included, but never more than the cap in a period.
    function test_lyingCollection_drawsAtMostTheCapPerPeriod() public {
        RailShop shop = _stocked(address(0), 100_000e18);
        common.setModes(false, true, address(shop));
        common.setNoMove(true);
        uint256 a0 = token.balanceOf(alice);
        vm.startPrank(alice);
        uint256 id = 1_000;
        while (true) {
            try shop.give(address(common), id, 0) { ++id; } catch (bytes memory err) {
                assertEq(bytes4(err), IRailShop.CapReached.selector);
                break;
            }
        }
        vm.stopPrank();
        assertEq(token.balanceOf(alice) - a0, CAP, "at most the cap in this period");
        assertEq(shop.capLeft(), 0);
        vm.warp(shop.periodEnds());
        vm.prank(alice); shop.give(address(common), id, 0); // the next period: the next slice
        assertEq(token.balanceOf(alice) - a0, CAP + COMMON);
    }

    /// The shop as the payee of a CREATOR rule: the splitter's plain payment reaches it (native and ERC-20).
    function test_asTheSplittersCreatorPayee_nativeAndErc20() public {
        RailShop shop = _shop(address(0));
        IRuleSplitter.Rule[] memory rules = new IRuleSplitter.Rule[](2);
        rules[0] = IRuleSplitter.Rule(IRuleSplitter.Kind.CREATOR, 6_000, creator);
        rules[1] = IRuleSplitter.Rule(IRuleSplitter.Kind.CREATOR, 4_000, address(shop));
        RuleSplitter splitter = new RuleSplitter(address(token), address(0), rules);
        vm.deal(address(splitter), 1 ether);
        splitter.distribute();
        assertEq(splitter.delivered(1), 0.4 ether);
        assertEq(splitter.owed(1), 0);
        assertEq(shop.waiting(), 0.4 ether);

        RailShop erc20Shop = _shop2(address(assetCoin));
        rules[1] = IRuleSplitter.Rule(IRuleSplitter.Kind.CREATOR, 4_000, address(erc20Shop));
        RuleSplitter s2 = new RuleSplitter(address(token), address(assetCoin), rules);
        assetCoin.mint(address(s2), 1e6);
        s2.distribute();
        assertEq(s2.delivered(1), 4e5);
        assertEq(erc20Shop.waiting(), 4e5);
        erc20Shop.refill(erc20Shop.waiting());
        assertEq(erc20Shop.budget(), 4e5 * 1000);
    }

    /// Fuzz: give and pick in any order move exactly one card and the exact price; the shop's books always match.
    function testFuzz_givesAndPicks_exact(uint256 seed) public {
        RailShop shop = _stocked(address(0), 50_000e18);
        token.mint(bob, 1_000_000e18);
        vm.prank(bob); token.approve(address(shop), type(uint256).max);
        vm.prank(alice); common.setApprovalForAll(address(shop), true);
        uint256 nextId = 100;
        room = CAP; // the model: a give takes its price, a pick adds its card's give price
        for (uint256 step; step < 12; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 budgetBefore = shop.budget(); uint256 count = shop.cardCount();
            assertEq(shop.capLeft(), room, "the room follows the model");
            if (seed % 2 == 0) {
                common.mint(alice, nextId);
                uint256 aliceBefore = token.balanceOf(alice);
                bool paysOut = budgetBefore >= COMMON && room >= COMMON;
                if (!paysOut) {
                    vm.prank(alice);
                    vm.expectRevert(budgetBefore < COMMON ? IRailShop.BudgetShort.selector : IRailShop.CapReached.selector);
                    shop.give(address(common), nextId, 0);
                    assertEq(shop.cardCount(), count);
                } else {
                    vm.prank(alice);
                    uint256 paid = shop.give(address(common), nextId, 0);
                    assertEq(paid, COMMON);
                    assertEq(token.balanceOf(alice) - aliceBefore, COMMON);
                    assertEq(budgetBefore - shop.budget(), COMMON);
                    assertEq(shop.cardCount(), count + 1);
                    room -= COMMON;
                }
                ++nextId;
            } else if (count > 1) {
                (address nft, uint256 id) = shop.card(seed % count);
                (uint256 givePrice, uint256 price) = shop.pricesOf(nft);
                uint256 bobBefore = token.balanceOf(bob);
                vm.prank(bob);
                shop.pick(nft, id, price, bob);
                room += givePrice;
                assertEq(bobBefore - token.balanceOf(bob), price);
                assertEq(shop.budget() - budgetBefore, price);
                assertEq(shop.cardCount(), count - 1);
            }
        }
    }

    /// Fuzz with odd parts: a token that may tax its transfers and a collection that may refuse them. Every give and
    /// pick either moves exactly one card and the exact price, or nothing at all.
    function testFuzz_withATaxedTokenAndARefusingCollection(uint256 seed) public {
        RailShop shop = _stocked(address(0), 50_000e18);
        bool taxed = seed % 2 == 1;
        bool refusing = seed % 3 == 0;
        if (taxed) token.setModes(100, false);
        if (refusing) common.setModes(true, false, address(0));
        token.mint(bob, 1_000_000e18);
        vm.prank(bob); token.approve(address(shop), type(uint256).max);
        uint256 nextId = 100;
        room = CAP; // in storage: this function is at the stack's limit
        for (uint256 step; step < 10; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            assertEq(shop.capLeft(), room, "the room follows the model");
            uint256 budgetBefore = shop.budget(); uint256 count = shop.cardCount(); uint256 bobBefore = token.balanceOf(bob);
            ShopCards c = seed % 4 < 2 ? common : rare;
            if (seed % 2 == 0) {
                c.mint(alice, nextId);
                vm.startPrank(alice); c.setApprovalForAll(address(shop), true); vm.stopPrank();
                uint256 aliceBefore = token.balanceOf(alice);
                (uint256 price,) = shop.pricesOf(address(c));
                bool ok = !taxed && !(refusing && c == common) && budgetBefore >= price && room >= price;
                vm.prank(alice);
                if (!ok) vm.expectRevert();
                shop.give(address(c), nextId, 0);
                if (ok) {
                    assertEq(token.balanceOf(alice) - aliceBefore, price);
                    assertEq(budgetBefore - shop.budget(), price);
                    assertEq(shop.cardCount(), count + 1);
                    assertEq(c.ownerOf(nextId), address(shop));
                    room -= price;
                } else {
                    assertEq(shop.budget(), budgetBefore);
                    assertEq(shop.cardCount(), count);
                    assertEq(token.balanceOf(alice), aliceBefore);
                }
                ++nextId;
            } else if (count > 1) {
                (address nft, uint256 id) = shop.card(seed % count);
                (uint256 givePrice, uint256 price) = shop.pricesOf(nft);
                bool ok = !taxed && !(refusing && nft == address(common));
                vm.prank(bob);
                if (!ok) vm.expectRevert();
                shop.pick(nft, id, price, bob);
                if (ok) {
                    assertEq(bobBefore - token.balanceOf(bob), price);
                    assertEq(shop.budget() - budgetBefore, price);
                    assertEq(shop.cardCount(), count - 1);
                    room += givePrice;
                } else {
                    assertEq(token.balanceOf(bob), bobBefore);
                    assertEq(shop.budget(), budgetBefore);
                    assertEq(shop.cardCount(), count);
                    assertTrue(shop.holds(nft, id));
                }
            }
        }
    }
}
