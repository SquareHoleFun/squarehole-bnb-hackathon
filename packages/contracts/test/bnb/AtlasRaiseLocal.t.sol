// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IListingRegistry, ListingRecord, ListingClass, ListingKind, QParameters} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {
    AtlasMirror,
    AtlasPriceRead,
    AtlasPriceSnapshot,
    AtlasRaiseSetter,
    AtlasSource
} from "../../script/bnb/AtlasRaise.sol";

/// @notice A SingleFeed whose every answer the test controls, including the broken ones.
contract ControlledFeed {
    enum Mode { Normal, Revert, HugeRevert, Short, Long, BurnGas, Refused, Slow, WideRound }
    Mode public mode;
    Mode public decimalsMode;
    uint8 public decimalsValue = 18;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;

    function set(Mode m, int256 a, uint256 s, uint256 u) external { (mode, answer, startedAt, updatedAt) = (m, a, s, u); }
    function setDecimals(Mode m, uint8 d) external { (decimalsMode, decimalsValue) = (m, d); }

    function decimals() external view returns (uint8) {
        if (decimalsMode == Mode.Refused) revert("OnlyAuthorizedCallerAllowed");
        if (decimalsMode == Mode.Short) assembly { return(0, 0) }
        if (decimalsMode == Mode.BurnGas) { while (true) {} }
        // Uses nearly all of its gas cap, then answers.
        if (decimalsMode == Mode.Slow) { while (gasleft() > 3000) {} }
        return decimalsValue;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        Mode m = mode;
        if (m == Mode.Revert || m == Mode.Refused) revert("refused");
        if (m == Mode.HugeRevert) {
            bytes memory big = new bytes(20_000);
            assembly { revert(add(big, 32), mload(big)) }
        }
        if (m == Mode.Short) {
            uint256 a = uint256(answer);
            assembly { mstore(0, 1) mstore(32, a) return(0, 64) }
        }
        if (m == Mode.Long) {
            uint256 a = uint256(answer); uint256 s = startedAt; uint256 u = updatedAt;
            assembly {
                mstore(0x80, 1) mstore(0xa0, a) mstore(0xc0, s) mstore(0xe0, u) mstore(0x100, 1) mstore(0x120, 7)
                return(0x80, 192)
            }
        }
        if (m == Mode.BurnGas) { while (true) {} }
        if (m == Mode.WideRound) {
            uint256 a = uint256(answer); uint256 s = startedAt; uint256 u = updatedAt;
            assembly {
                mstore(0x80, shl(80, 1)) mstore(0xa0, a) mstore(0xc0, s) mstore(0xe0, u) mstore(0x100, 1)
                return(0x80, 160)
            }
        }
        return (1, answer, startedAt, updatedAt, 1);
    }
}

/// @notice The listing registry's lister surface, local: raises, the lister role and the layout floor.
contract LocalListings {
    address public lister;
    address public pendingLister;
    mapping(uint32 => ListingRecord) internal _rows;

    constructor() { lister = msg.sender; }

    function addRow(uint32 id, uint8 decimals, uint256 raise) external {
        _rows[id] = ListingRecord(id, address(uint160(0xC0 + id)), decimals, ListingClass.STOCK, ListingKind.LISTED, 1, raise, QParameters(1, 1, 1, 1));
    }
    function listing(uint32 id) external view returns (ListingRecord memory) { return _rows[id]; }
    function checkLayout(uint256 raise) external pure { require(raise >= 1_000_000, "layout"); }
    function updateRaise(uint32 id, uint256 raise) external { require(msg.sender == lister, "NotLister"); _rows[id].raise = raise; }
    function proposeLister(address next) external { require(msg.sender == lister, "NotLister"); pendingLister = next; }
    function acceptLister() external { require(msg.sender == pendingLister, "NotPending"); lister = msg.sender; pendingLister = address(0); }
}

/// @notice SH-266, without a fork (these never skip): the source's direct read against every kind of broken feed, the
/// consumption time rule, the mirror's two times, the setter's cooldown after acceptance, its interval and bounds.
contract AtlasRaiseLocalTest is Test {
    bytes4 internal constant BNB = 0x00000279;
    bytes4 internal constant NVDAB = 0x000003a6;
    uint256 internal constant T = 1_800_000_000;
    uint256 internal constant BNB_PRICE = 539300459101204565650;
    address internal constant KEEPER = address(0xBEEF);

    ControlledFeed internal feed;
    AtlasMirror internal mirror;
    AtlasSource internal source;
    LocalListings internal listings;
    AtlasRaiseSetter internal setter;

    function setUp() external {
        vm.warp(T);
        feed = new ControlledFeed();
        mirror = new AtlasMirror(KEEPER);
        source = new AtlasSource(address(feed), BNB, mirror, 180);
        listings = new LocalListings();
        listings.addRow(0, 18, 1e15);
        listings.addRow(2, 18, 1e15);
        uint32[] memory ids = new uint32[](2);
        uint8[] memory kinds = new uint8[](2);
        address[] memory sources = new address[](2);
        bytes4[] memory feeds = new bytes4[](2);
        (ids[0], kinds[0], sources[0], feeds[0]) = (0, AtlasPriceRead.SOURCE, address(source), BNB);
        (ids[1], kinds[1], sources[1], feeds[1]) = (2, AtlasPriceRead.SOURCE, address(source), NVDAB);
        setter = new AtlasRaiseSetter(_listings(), address(this), 1e18, ids, kinds, sources, feeds);
    }

    function _listings() internal view returns (IListingRegistry) { return IListingRegistry(address(listings)); }

    function _push(bytes4 id, uint256 price, uint256 agg, uint256 onchain) internal returns (uint256) {
        bytes4[] memory ids = new bytes4[](1);
        AtlasPriceSnapshot[] memory s = new AtlasPriceSnapshot[](1);
        ids[0] = id;
        s[0] = AtlasPriceSnapshot(uint80(price), uint48(agg), uint48(onchain));
        vm.prank(KEEPER);
        return mirror.push(ids, s);
    }

    function _origin(bytes4 id) internal view returns (uint256 price, bool direct) {
        (price,,, direct) = source.fetchWithOrigin(id);
    }

    // ---- The direct read.

    function test_direct_used_when_well_formed_and_fresh() external {
        feed.set(ControlledFeed.Mode.Normal, int256(BNB_PRICE), T - 11, T - 10);
        _push(BNB, 600e18, T - 3, T - 2);
        (uint256 p, bool direct) = _origin(BNB);
        assertTrue(direct);
        assertEq(p, BNB_PRICE);
    }

    function test_every_broken_direct_answer_falls_back_to_a_fresh_copy() external {
        _push(BNB, 600e18, T - 3, T - 2);
        int256 wide = int256(uint256(type(uint80).max) + 1);
        ControlledFeed.Mode[7] memory modes = [ControlledFeed.Mode.Revert, ControlledFeed.Mode.HugeRevert, ControlledFeed.Mode.Short,
            ControlledFeed.Mode.Long, ControlledFeed.Mode.BurnGas, ControlledFeed.Mode.Refused, ControlledFeed.Mode.WideRound];
        for (uint256 i; i < modes.length; ++i) {
            feed.set(modes[i], int256(BNB_PRICE), T - 11, T - 10);
            (uint256 p, bool direct) = _origin(BNB);
            assertFalse(direct);
            assertEq(p, 600e18);
        }
        // Well-formed but refused by the rule: too wide, negative, zero, future, stale, times out of order.
        int256[6] memory answers = [wide, -1, int256(0), int256(BNB_PRICE), int256(BNB_PRICE), int256(BNB_PRICE)];
        uint256[6] memory started = [T - 11, T - 11, T - 11, T, T - 200, T - 5];
        uint256[6] memory updated = [T - 10, T - 10, T - 10, T + 1, T - 181, T - 6];
        for (uint256 i; i < answers.length; ++i) {
            feed.set(ControlledFeed.Mode.Normal, answers[i], started[i], updated[i]);
            (uint256 p, bool direct) = _origin(BNB);
            assertFalse(direct);
            assertEq(p, 600e18);
        }
        // The feed's own decimals: not 18, refused, or malformed: the copy.
        feed.set(ControlledFeed.Mode.Normal, int256(BNB_PRICE), T - 11, T - 10);
        feed.setDecimals(ControlledFeed.Mode.Normal, 8);
        (, bool d8) = _origin(BNB);
        assertFalse(d8);
        feed.setDecimals(ControlledFeed.Mode.Short, 18);
        (, bool dShort) = _origin(BNB);
        assertFalse(dShort);
        feed.setDecimals(ControlledFeed.Mode.Normal, 18);
        (, bool back) = _origin(BNB);
        assertTrue(back);
    }

    function test_a_gas_burning_feed_leaves_room_for_the_fallback_and_the_poke() external {
        feed.set(ControlledFeed.Mode.BurnGas, int256(BNB_PRICE), T - 11, T - 10);
        _push(BNB, BNB_PRICE, T - 3, T - 2);
        listings.proposeLister(address(setter));
        setter.accept();
        vm.warp(T + 601);
        _push(BNB, BNB_PRICE, T + 590, T + 591);
        uint256 before = gasleft();
        assertTrue(setter.poke{gas: 1_500_000}(0));
        emit log_named_uint("poke gas with a gas-burning direct feed", before - gasleft());
        assertLt(before - gasleft(), 400_000);
        assertEq(listings.listing(0).raise, uint256(1e36) / BNB_PRICE);
    }

    function test_too_little_gas_reverts_instead_of_choosing_the_copy() external {
        feed.set(ControlledFeed.Mode.Normal, int256(BNB_PRICE), T - 11, T - 10);
        _push(BNB, 600e18, T - 3, T - 2);
        (bool ok, bytes memory data) = address(source).staticcall{gas: 100_000}(abi.encodeCall(AtlasSource.fetchWithOrigin, (BNB)));
        assertFalse(ok);
        assertEq(bytes4(data), AtlasSource.LowGas.selector);
        // The stock has no direct feed: no reserve needed.
        _push(NVDAB, 147e18, T - 3, T - 2);
        (ok,) = address(source).staticcall{gas: 60_000}(abi.encodeCall(AtlasSource.fetchWithOrigin, (NVDAB)));
        assertTrue(ok);
    }

    function test_the_copy_alone_refuses_future_stale_and_empty() external {
        feed.set(ControlledFeed.Mode.Refused, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NoFreshPrice.selector, BNB));
        source.fetchWithOrigin(BNB);
        // A copy stamped one second ahead of this chain is not written at all.
        assertEq(_push(BNB, 600e18, T, T + 1), 0);
        assertEq(_push(BNB, 600e18, T - 1, T), 1);
        (uint256 p, bool direct) = _origin(BNB);
        assertEq(p, 600e18);
        assertFalse(direct);
        vm.warp(T + 181);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NoFreshPrice.selector, BNB));
        source.fetchWithOrigin(BNB);
    }

    // ---- The mirror's two times.

    function test_mirror_guards_both_times() external {
        assertEq(_push(NVDAB, 147e18, T - 10, T - 5), 1);
        assertEq(_push(NVDAB, 148e18, T - 20, T - 4), 0, "aggregation time went back");
        assertEq(_push(NVDAB, 148e18, T - 3, T - 4), 0, "aggregation after the on-chain time");
        assertEq(_push(NVDAB, 148e18, T - 9, T - 5), 0, "on-chain time not newer");
        assertEq(_push(NVDAB, 148e18, T + 61, T + 61), 0, "in the future");
        // A future write never displaces a usable price: the stored one stays readable.
        assertEq(_push(NVDAB, 999e18, T - 4, T + 1), 0, "one second in the future");
        (uint256 kept,) = _origin(NVDAB);
        assertEq(kept, 147e18);
        assertEq(_push(NVDAB, 0, T - 2, T - 1), 0, "zero price");
        assertEq(_push(NVDAB, 148e18, T - 9, T - 1), 1);
        AtlasPriceSnapshot memory s = mirror.fetch(NVDAB);
        assertEq(s.price, 148e18);
        assertEq(s.aggregatedTs, T - 9);
        assertEq(s.onchainTs, T - 1);
    }

    // ---- The setter.

    function test_cooldown_after_acceptance_then_hourly() external {
        _push(NVDAB, 147737064126976709110, T - 3, T - 2);
        // The holding contract changed the raise just before the handover.
        listings.updateRaise(2, 1.1e15);
        listings.proposeLister(address(setter));
        setter.accept();
        assertEq(setter.acceptedAt(), T);
        assertFalse(setter.poke(2), "same block as the acceptance");
        vm.warp(T + 599);
        _push(NVDAB, 147737064126976709110, T + 597, T + 598);
        assertFalse(setter.poke(2), "inside the ten minutes");
        assertEq(listings.listing(2).raise, 1.1e15);
        vm.warp(T + 600);
        assertTrue(setter.poke(2), "ten minutes after the acceptance");
        assertEq(listings.listing(2).raise, uint256(1e36) / 147737064126976709110);
        // Then at most once an hour, whatever the price does.
        vm.warp(T + 600 + 3599);
        _push(NVDAB, 100e18, T + 4197, T + 4198);
        assertFalse(setter.poke(2));
        vm.warp(T + 600 + 3600);
        assertTrue(setter.poke(2));
        assertEq(listings.listing(2).raise, 1e16);
    }

    function test_quote_bounds_and_width() external {
        listings.proposeLister(address(setter));
        setter.accept();
        vm.warp(T + 601);
        _push(NVDAB, 99e18, T + 599, T + 600);
        vm.expectRevert(abi.encodeWithSelector(AtlasRaiseSetter.AboveCeiling.selector, uint256(1e36) / 99e18, uint256(1e16)));
        setter.poke(2);
    }

    // ---- The add-only tables.

    function test_direct_feeds_are_add_only_by_the_deployer() external {
        assertEq(source.directFeedOf(BNB), address(feed));
        assertEq(source.admin(), address(this));
        ControlledFeed stock = new ControlledFeed();
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NotAdmin.selector, address(0xBAD)));
        source.addDirectFeed(NVDAB, address(stock), 180);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.FeedAlreadySet.selector, BNB, address(feed)));
        source.addDirectFeed(BNB, address(stock), 180);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.BadFeed.selector, address(0x1234)));
        source.addDirectFeed(NVDAB, address(0x1234), 180);
        // A feed that answers us with other decimals is refused; one that refuses us is taken (checked on every read).
        stock.setDecimals(ControlledFeed.Mode.Normal, 8);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.BadFeed.selector, address(stock)));
        source.addDirectFeed(NVDAB, address(stock), 180);
        // A decimals call that succeeds with no word at all: refused too.
        stock.setDecimals(ControlledFeed.Mode.Short, 18);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.BadFeed.selector, address(stock)));
        source.addDirectFeed(NVDAB, address(stock), 180);
        stock.setDecimals(ControlledFeed.Mode.Refused, 18);
        vm.expectEmit(true, false, false, true, address(source));
        emit AtlasSource.DirectFeedAdded(NVDAB, address(stock), 180);
        source.addDirectFeed(NVDAB, address(stock), 180);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.FeedAlreadySet.selector, NVDAB, address(stock)));
        source.addDirectFeed(NVDAB, address(0x1234), 180);
        // Refused by the feed: the copy. Authorised later (here: the feed answers): direct, with no transaction of ours.
        stock.set(ControlledFeed.Mode.Refused, 0, 0, 0);
        _push(NVDAB, 147e18, T - 3, T - 2);
        (uint256 p, bool direct) = _origin(NVDAB);
        assertFalse(direct);
        assertEq(p, 147e18);
        stock.setDecimals(ControlledFeed.Mode.Normal, 18);
        stock.set(ControlledFeed.Mode.Normal, 148e18, T - 6, T - 5);
        (p, direct) = _origin(NVDAB);
        assertTrue(direct);
        assertEq(p, 148e18);
    }

    function test_each_feed_has_its_own_age_limit_for_direct_and_copy() external {
        bytes4 gold = 0x58415500;
        ControlledFeed xau = new ControlledFeed();
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.BadFeed.selector, address(xau)));
        source.addDirectFeed(gold, address(xau), 0);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.BadFeed.selector, address(xau)));
        source.addDirectFeed(gold, address(xau), 3601);
        source.addDirectFeed(gold, address(xau), 900);
        assertEq(source.ageLimitOf(gold), 900);
        assertEq(source.ageLimitOf(BNB), 180);
        // Six minutes old: fresh for gold (900 s), direct.
        xau.set(ControlledFeed.Mode.Normal, 3521e18, T - 361, T - 360);
        (uint256 p, bool direct) = _origin(gold);
        assertTrue(direct);
        assertEq(p, 3521e18);
        // The same age for BNB is stale: its copy answers instead (and a copy of that age would not).
        feed.set(ControlledFeed.Mode.Normal, int256(BNB_PRICE), T - 361, T - 360);
        _push(BNB, 600e18, T - 3, T - 2);
        (, direct) = _origin(BNB);
        assertFalse(direct);
        // Gold's copy keeps gold's limit: 899 s old is used, 901 s old is refused.
        xau.set(ControlledFeed.Mode.Refused, 0, 0, 0);
        _push(gold, 3500e18, T - 900, T - 899);
        (p, direct) = _origin(gold);
        assertFalse(direct);
        assertEq(p, 3500e18);
        vm.warp(T + 2);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NoFreshPrice.selector, gold));
        source.fetchWithOrigin(gold);
    }

    /// @notice A setter built with one row (helper for the construction checks).
    function _oneRow(uint32 id, uint8 kind, address src, bytes4 f) external returns (AtlasRaiseSetter) {
        uint32[] memory ids = new uint32[](1);
        uint8[] memory kinds = new uint8[](1);
        address[] memory sources = new address[](1);
        bytes4[] memory feeds = new bytes4[](1);
        (ids[0], kinds[0], sources[0], feeds[0]) = (id, kind, src, f);
        return new AtlasRaiseSetter(_listings(), address(this), 1e18, ids, kinds, sources, feeds);
    }

    function test_rows_are_fixed_at_construction_and_checked_there() external {
        bytes4 gold = 0x58415500;
        listings.addRow(3, 18, 1e15);
        // No way to add a row later: the setter has no such function.
        (bool ok,) = address(setter).call(abi.encodeWithSignature("addRow(uint32,uint8,address,bytes4)", uint32(3), uint8(3), address(source), gold));
        assertFalse(ok);
        assertEq(setter.managedCount(), 2);
        // Only rows read through an AtlasSource.
        vm.expectRevert(AtlasRaiseSetter.BadRows.selector);
        this._oneRow(3, AtlasPriceRead.SINGLE, address(feed), gold);
        vm.expectRevert(AtlasRaiseSetter.BadRows.selector);
        this._oneRow(3, AtlasPriceRead.MULTI, address(mirror), gold);
        // An unknown listing, and a row that can never quote (at 1.00 USD an 18-decimal coin's smallest raise is
        // 827,180,612,553 raw, above a ceiling of ten times 1,000,000).
        vm.expectRevert(AtlasRaiseSetter.BadRows.selector);
        this._oneRow(7, AtlasPriceRead.SOURCE, address(source), gold);
        listings.addRow(4, 18, 1_000_000);
        vm.expectRevert(AtlasRaiseSetter.BadRows.selector);
        this._oneRow(4, AtlasPriceRead.SOURCE, address(source), gold);
        AtlasRaiseSetter g = this._oneRow(3, AtlasPriceRead.SOURCE, address(source), gold);
        (bool managed,,,, bytes4 f, uint256 start,) = g.rows(3);
        assertTrue(managed);
        assertEq(f, gold);
        assertEq(start, 1e15);
    }
}
