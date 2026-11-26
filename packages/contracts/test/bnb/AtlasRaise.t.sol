// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IListingRegistry} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {BnbTestnetCustody} from "../../script/bnb/BnbTestnet.sol";
import {
    AtlasMirror,
    AtlasPriceRead,
    AtlasPriceSnapshot,
    AtlasRaiseSetter,
    AtlasSource,
    IAtlasSingleFeed
} from "../../script/bnb/AtlasRaise.sol";
import {ControlledFeed} from "./AtlasRaiseLocal.t.sol";

/// @notice Calls the setter's own read path, so a fork can show what a contract gets from Atlas.
contract AtlasReadProbe {
    function read(uint8 kind, address source, bytes4 feedId) external view returns (uint256, uint256, uint256) {
        return AtlasPriceRead.read(kind, source, feedId);
    }

    /// @notice A SingleFeed's answer and decimals as a contract gets them (this contract is the caller).
    function round(address feed) external view returns (uint8 decimals, int256 answer, uint256 updatedAt) {
        decimals = IAtlasSingleFeed(feed).decimals();
        (, answer,, updatedAt,) = IAtlasSingleFeed(feed).latestRoundData();
    }
}

/// @notice SH-266 and SH-272. Two forks, each skipped without its endpoint:
/// - SH_BSC_MAINNET_FORK_URL (chain 56): the read path against Atlas's REAL MultiFeed registry (NVDAB/USD), and the
///   BNB/USD SingleFeed refusing a contract's read (OnlyAuthorizedCallerAllowed);
/// - SH_BSC_TESTNET_FORK_URL (chain 97, at its head): Atlas's open feeds answering a contract, the first BNB/USD feed
///   refusing one; the deployed release's listing registry and holding contract (the live setter hands the role back
///   first, as the real run does): the lister role handed to a setter, pokes from Atlas's open BNB/USD feed directly
///   and from copied NVDAB/USD prices, the bounds, and the role handed back so the old path works again.
/// The mirror's own rules run without a fork.
contract AtlasRaiseTest is Test {
    IListingRegistry internal constant LISTINGS = IListingRegistry(0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170);
    /// @notice Atlas's first BNB/USD feed on chain 97 (retired by SH-272: it refuses contracts and stopped updating).
    address internal constant BNB_USD_97 = 0xb3d1614Bf894E68ADd1EA50CA250C152BAd5256F;
    /// @notice Atlas's open feeds on chain 97 (SH-272) and the two it deployed for this build.
    address internal constant BNB_USD_OPEN_97 = 0x3957d289ee9C38272377786787ea34F9dd29788D;
    address internal constant ETH_USD_OPEN_97 = 0x35369dEcD8c662954B3D24acc2A862C708A34fD2;
    address internal constant BTC_USD_OPEN_97 = 0x83B2F2c20df36F166cF5b3f017204cbB7BABcAD0;
    address internal constant NVDAB_USD_97 = 0x3eF39d6361EfA1E8Ca066751f438077dA81082A6;
    address internal constant XAU_USD_97 = 0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764;
    /// @notice The setter that held the lister role on 25 November 2026 (deployments/bnb-testnet/97-atlas.json).
    address internal constant LIVE_SETTER_97 = 0x2d7BE91672aa149F897064BabF8FfdeEBbf9B079;
    address internal constant BNB_USD_56 = 0x9C0517F5b4c8657c7F18D68d2d79e2b3b1cd6438;
    address internal constant REGISTRY_56 = 0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa;
    address internal constant KEEPER = 0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189;
    bytes4 internal constant BNB_USD = 0x00000279;
    bytes4 internal constant NVDAB_USD = 0x000003a6;
    bytes4 internal constant ONLY_AUTHORIZED = 0x32f539b2; // OnlyAuthorizedCallerAllowed()
    uint256 internal constant TARGET = 1e18;
    /// @notice NVDAB/USD as BNB mainnet's registry answered on 25 November 2026 (fetchBatch, 15:58:50 +07).
    uint80 internal constant NVDAB_PRICE = 149912509665791584390;

    AtlasMirror internal mirror;
    AtlasSource internal source;
    AtlasRaiseSetter internal setter;
    BnbTestnetCustody internal custody;
    address internal owner;

    function _fork(string memory name) internal returns (bool) {
        string memory url = vm.envOr(name, string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url);
        return true;
    }

    /// @notice The holding contract as the lister: when the live setter holds the role (from 25 November 2026), it hands
    /// it back first, as the real run's first step does.
    function _custody97() internal {
        if (LISTINGS.lister() == LIVE_SETTER_97) {
            AtlasRaiseSetter live = AtlasRaiseSetter(LIVE_SETTER_97);
            custody = BnbTestnetCustody(payable(live.returnTo()));
            owner = custody.getOwners()[0];
            assertEq(live.owner(), owner);
            vm.prank(owner);
            live.handBack();
            vm.prank(owner);
            custody.execute(address(LISTINGS), 0, abi.encodeCall(IListingRegistry.acceptLister, ()));
        }
        custody = BnbTestnetCustody(payable(LISTINGS.lister()));
        owner = custody.getOwners()[0];
    }

    function _deploy97() internal {
        _custody97();
        mirror = new AtlasMirror(KEEPER);
        // BNB/USD read from Atlas's open feed directly; NVDAB/USD from the copy only (so a test can set its price).
        source = new AtlasSource(BNB_USD_OPEN_97, BNB_USD, mirror, 180);
        uint32[] memory ids = new uint32[](2);
        uint8[] memory kinds = new uint8[](2);
        address[] memory sources = new address[](2);
        bytes4[] memory feeds = new bytes4[](2);
        (ids[0], kinds[0], sources[0], feeds[0]) = (0, AtlasPriceRead.SOURCE, address(source), BNB_USD);
        (ids[1], kinds[1], sources[1], feeds[1]) = (2, AtlasPriceRead.SOURCE, address(source), NVDAB_USD);
        setter = new AtlasRaiseSetter(LISTINGS, owner, TARGET, ids, kinds, sources, feeds);
    }

    function _push(bytes4 id, uint256 price, uint256 aggregatedTs, uint256 onchainTs) internal returns (uint256) {
        bytes4[] memory ids = new bytes4[](1);
        AtlasPriceSnapshot[] memory s = new AtlasPriceSnapshot[](1);
        ids[0] = id;
        s[0] = AtlasPriceSnapshot(uint80(price), uint48(aggregatedTs), uint48(onchainTs));
        vm.prank(KEEPER);
        return mirror.push(ids, s);
    }

    function _handover() internal {
        vm.prank(owner);
        custody.execute(address(LISTINGS), 0, abi.encodeCall(IListingRegistry.proposeLister, (address(setter))));
        setter.accept();
        assertEq(LISTINGS.lister(), address(setter));
    }

    // ---- BNB mainnet: the real interface.

    function test_mainnet_registry_read_by_a_contract_and_single_feed_refusal() external {
        if (!_fork("SH_BSC_MAINNET_FORK_URL")) return;
        assertEq(block.chainid, 56);
        AtlasReadProbe probe = new AtlasReadProbe();
        (uint256 price, uint256 aggregatedTs, uint256 onchainTs) = probe.read(AtlasPriceRead.MULTI, REGISTRY_56, NVDAB_USD);
        emit log_named_uint("NVDAB/USD x18", price);
        emit log_named_uint("aggregatedTs", aggregatedTs);
        emit log_named_uint("onchainTs", onchainTs);
        emit log_named_uint("block.timestamp", block.timestamp);
        assertGt(price, 1e18);
        assertLe(block.timestamp - onchainTs, AtlasPriceRead.MAX_AGE);
        // An id that is no feed answers all zero: refused, never priced.
        vm.expectRevert(AtlasPriceRead.NoPrice.selector);
        probe.read(AtlasPriceRead.MULTI, REGISTRY_56, bytes4(0));
        // The BNB/USD SingleFeed answers plain accounts only.
        vm.expectRevert(abi.encodeWithSelector(ONLY_AUTHORIZED));
        probe.read(AtlasPriceRead.SINGLE, BNB_USD_56, bytes4(0));
    }

    // ---- BNB Chain testnet (97): the deployed release.

    function test_testnet_bnb_usd_refuses_a_contract() external {
        if (!_fork("SH_BSC_TESTNET_FORK_URL")) return;
        AtlasReadProbe probe = new AtlasReadProbe();
        vm.expectRevert(abi.encodeWithSelector(ONLY_AUTHORIZED));
        probe.read(AtlasPriceRead.SINGLE, BNB_USD_97, bytes4(0));
    }

    /// @notice SH-272: Atlas's open feeds and the two deployed for this build answer a contract with 18 decimals, each
    /// within its age limit (three times the largest gap between updates measured: 190 s for the open feeds updated about
    /// every minute, 910 s for the stock and gold); the first BNB/USD feed's last update is older than an hour.
    function test_testnet_open_feeds_answer_a_contract() external {
        if (!_fork("SH_BSC_TESTNET_FORK_URL")) return;
        AtlasReadProbe probe = new AtlasReadProbe();
        address[5] memory open = [BNB_USD_OPEN_97, ETH_USD_OPEN_97, BTC_USD_OPEN_97, NVDAB_USD_97, XAU_USD_97];
        uint256[5] memory limit = [uint256(190), 190, 190, 910, 910];
        for (uint256 i; i < open.length; ++i) {
            (uint8 d, int256 answer, uint256 updatedAt) = probe.round(open[i]);
            assertEq(d, 18);
            assertGt(answer, 1e18);
            assertLe(block.timestamp - updatedAt, limit[i]);
            emit log_named_uint("price x18", uint256(answer));
            emit log_named_uint("age (s)", block.timestamp - updatedAt);
        }
        vm.prank(KEEPER, KEEPER);
        (,,, uint256 updatedAt,) = IAtlasSingleFeed(BNB_USD_97).latestRoundData();
        emit log_named_uint("first BNB/USD feed age (s)", block.timestamp - updatedAt);
        assertGt(block.timestamp - updatedAt, 3600, "the first BNB/USD feed has stopped");
    }

    function test_testnet_handover_pokes_and_hand_back() external {
        if (!_fork("SH_BSC_TESTNET_FORK_URL")) return;
        assertEq(block.chainid, 97);
        _deploy97();
        uint256 before0 = LISTINGS.listing(0).raise;
        uint256 before2 = LISTINGS.listing(2).raise;
        emit log_named_uint("row 0 raise before", before0);
        emit log_named_uint("row 2 raise before", before2);

        // A stock price a quarter below the one of the live raise (set at 19:35 +07 on 25 November), so a poke of row 2
        // moves it by more than 2%.
        uint256 p2 = NVDAB_PRICE * 3 / 4;
        _push(NVDAB_USD, p2, block.timestamp - 6, block.timestamp - 5);
        (uint256 want0, uint256 bnbPrice,,, bool direct0) = setter.quote(0);
        assertEq(want0, TARGET * 1e18 / bnbPrice);
        assertTrue(direct0, "Atlas's open BNB/USD feed answers the source directly");
        emit log_named_uint("BNB/USD x18 (Atlas's open feed, chain 97)", bnbPrice);
        emit log_named_uint("row 0 raise at 1.00 USD", want0);

        // Before the handover a poke cannot change anything: the registry refuses the setter.
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(setter)));
        setter.poke(2);

        _handover();
        // Ten minutes after the acceptance before any poke changes a raise.
        assertFalse(setter.poke(0));
        assertFalse(setter.poke(2));
        assertEq(LISTINGS.listing(2).raise, before2);
        vm.warp(block.timestamp + 600);
        // A fork's feed stands still while its clock runs: after the warp the open feed's answer is too old, and the
        // same price as a fresh copy stands in for Atlas's next update.
        _push(BNB_USD, bnbPrice, block.timestamp - 2, block.timestamp - 1);
        _push(NVDAB_USD, p2, block.timestamp - 4, block.timestamp - 3);
        bool moved0 = (want0 > before0 ? want0 - before0 : before0 - want0) * 10_000 >= 200 * before0;
        assertEq(setter.poke(0), moved0);
        assertEq(LISTINGS.listing(0).raise, moved0 ? want0 : before0);
        assertTrue(setter.poke(2));
        uint256 want2 = TARGET * 1e18 / p2;
        assertEq(LISTINGS.listing(2).raise, want2);
        emit log_named_uint("row 2 raise at 1.00 USD", want2);
        // The factory prices a box at the new raise (what the Launch page reads before it sends).
        (bool ok,) = address(0xB954a0db33a6351e76E519b4830489531C39d4F0).staticcall(
            abi.encodeWithSignature("boxQParameters(uint32,uint256)", uint32(2), want2)
        );
        assertTrue(ok, "factory quotes the new raise");

        // At most once an hour: a second poke keeps the raise, even at a price 10% away.
        _push(NVDAB_USD, p2 * 11 / 10, block.timestamp - 3, block.timestamp - 2);
        assertFalse(setter.poke(2));
        assertEq(LISTINGS.listing(2).raise, want2);

        // The old path is closed while the setter holds the role.
        vm.prank(owner);
        vm.expectRevert();
        custody.execute(address(LISTINGS), 0, abi.encodeCall(IListingRegistry.updateRaise, (0, 1e15)));

        // The pass-through: owner only, other lister acts only.
        vm.expectRevert(abi.encodeWithSelector(AtlasRaiseSetter.NotOwner.selector, address(this)));
        setter.listerCall(abi.encodeCall(IListingRegistry.setRoyaltyLot, (1, 1000)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AtlasRaiseSetter.RefusedSelector.selector, IListingRegistry.updateRaise.selector));
        setter.listerCall(abi.encodeCall(IListingRegistry.updateRaise, (0, 1e15)));
        vm.prank(owner);
        setter.listerCall(abi.encodeCall(IListingRegistry.setRoyaltyLot, (1, 1000)));

        // Hand back: the holding contract accepts with its own call, and the old path works again.
        vm.prank(owner);
        setter.handBack();
        vm.prank(owner);
        custody.execute(address(LISTINGS), 0, abi.encodeCall(IListingRegistry.acceptLister, ()));
        assertEq(LISTINGS.lister(), address(custody));
        vm.prank(owner);
        custody.execute(address(LISTINGS), 0, abi.encodeCall(IListingRegistry.updateRaise, (0, 1e15)));
        assertEq(LISTINGS.listing(0).raise, 1e15);
        // A poke that would change a raise now fails at the registry.
        vm.warp(block.timestamp + 3601);
        _push(NVDAB_USD, p2 / 2, block.timestamp - 1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(setter)));
        setter.poke(2);
    }

    function test_testnet_refusals_and_bounds() external {
        if (!_fork("SH_BSC_TESTNET_FORK_URL")) return;
        _deploy97();
        _handover();
        vm.warp(block.timestamp + 600);
        // Nothing mirrored yet: refused.
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NoFreshPrice.selector, NVDAB_USD));
        setter.poke(2);
        // Stale: older than three heartbeats.
        _push(NVDAB_USD, NVDAB_PRICE, block.timestamp - 182, block.timestamp - 181);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NoFreshPrice.selector, NVDAB_USD));
        setter.poke(2);
        // Ceiling: ten times the starting raise (the listing's raise when the setter was deployed).
        {
            (,,,,, uint256 startRaise,) = setter.rows(2);
            uint256 low = TARGET * 1e18 / (startRaise * 11);
            _push(NVDAB_USD, low, block.timestamp - 1, block.timestamp);
            vm.expectRevert(abi.encodeWithSelector(AtlasRaiseSetter.AboveCeiling.selector, TARGET * 1e18 / low, startRaise * 10));
            setter.poke(2);
        }
        // Floor: the registry's own (1,000,000 raw). An 18-decimal coin cannot get there at 1.00 USD within uint80
        // prices, so a setter with a target of one wei of a dollar shows the refusal.
        {
            uint32[] memory ids = new uint32[](1);
            uint8[] memory kinds = new uint8[](1);
            address[] memory sources = new address[](1);
            bytes4[] memory feeds = new bytes4[](1);
            (ids[0], kinds[0], sources[0], feeds[0]) = (2, AtlasPriceRead.SOURCE, address(source), NVDAB_USD);
            AtlasRaiseSetter tiny = new AtlasRaiseSetter(LISTINGS, owner, 1, ids, kinds, sources, feeds);
            vm.expectRevert(abi.encodeWithSelector(AtlasRaiseSetter.BelowFloor.selector, uint256(0)));
            tiny.quote(2);
        }
        // A step under 2% keeps the raise.
        vm.warp(block.timestamp + 1);
        uint256 current = LISTINGS.listing(2).raise;
        _push(NVDAB_USD, TARGET * 1e18 / (current * 1005 / 1000), block.timestamp - 1, block.timestamp);
        assertFalse(setter.poke(2));
        assertEq(LISTINGS.listing(2).raise, current);
        // Unknown rows are refused.
        vm.expectRevert(abi.encodeWithSelector(AtlasRaiseSetter.NotManaged.selector, uint32(1)));
        setter.poke(1);
    }

    // ---- The source: Atlas's own feed first, the relayed copy otherwise.

    function test_testnet_source_both_branches() external {
        if (!_fork("SH_BSC_TESTNET_FORK_URL")) return;
        _deploy97();
        // Direct branch: Atlas's open BNB/USD feed answers the source, with no transaction of ours.
        vm.prank(KEEPER, KEEPER);
        (, int256 answer,, uint256 updatedAt,) = IAtlasSingleFeed(BNB_USD_OPEN_97).latestRoundData();
        (uint256 p,, uint256 onchainTs, bool direct) = source.fetchWithOrigin(BNB_USD);
        assertTrue(direct, "Atlas's own feed answered the source");
        assertEq(p, uint256(answer));
        assertEq(onchainTs, updatedAt);
        (,,,, bool viaSetter) = setter.quote(0);
        assertTrue(viaSetter);
        // The stock has no direct feed in this source: always the copy.
        _push(NVDAB_USD, NVDAB_PRICE, block.timestamp - 6, block.timestamp - 5);
        (,,, direct) = source.fetchWithOrigin(NVDAB_USD);
        assertFalse(direct);
        // A stale direct answer falls back to a fresh copied value.
        vm.warp(updatedAt + 181);
        _push(BNB_USD, 600e18, block.timestamp - 2, block.timestamp - 1);
        (p,,, direct) = source.fetchWithOrigin(BNB_USD);
        assertFalse(direct);
        assertEq(p, 600e18);
        // Both stale: refused.
        vm.warp(block.timestamp + 181);
        vm.expectRevert(abi.encodeWithSelector(AtlasSource.NoFreshPrice.selector, BNB_USD));
        source.fetchWithOrigin(BNB_USD);
    }

    /// @notice The gas a changing poke needs end to end against the REAL registry (its checkLayout and updateRaise), with
    /// both direct-call budgets used up: a feed whose decimals() spends nearly its 30,000 cap and whose latestRoundData()
    /// burns its 60,000 cap, so the source falls back to the copy after spending both. The keeper's poke budget is this
    /// number with headroom (atlas-relay.ts POKE_GAS).
    function test_testnet_poke_gas_with_both_direct_budgets_burnt() external {
        if (!_fork("SH_BSC_TESTNET_FORK_URL")) return;
        _custody97();
        mirror = new AtlasMirror(KEEPER);
        ControlledFeed burner = new ControlledFeed();
        burner.setDecimals(ControlledFeed.Mode.Slow, 18);
        burner.set(ControlledFeed.Mode.BurnGas, 0, 0, 0);
        source = new AtlasSource(address(burner), BNB_USD, mirror, 180);
        uint32[] memory ids = new uint32[](2);
        uint8[] memory kinds = new uint8[](2);
        address[] memory sources = new address[](2);
        bytes4[] memory feeds = new bytes4[](2);
        (ids[0], kinds[0], sources[0], feeds[0]) = (0, AtlasPriceRead.SOURCE, address(source), BNB_USD);
        (ids[1], kinds[1], sources[1], feeds[1]) = (2, AtlasPriceRead.SOURCE, address(source), NVDAB_USD);
        setter = new AtlasRaiseSetter(LISTINGS, owner, TARGET, ids, kinds, sources, feeds);
        _handover();
        vm.warp(block.timestamp + 600);
        // Prices that move both live raises by more than 2% (a changing poke is the one measured).
        _push(BNB_USD, 400e18, block.timestamp - 2, block.timestamp - 1);
        _push(NVDAB_USD, NVDAB_PRICE * 3 / 4, block.timestamp - 2, block.timestamp - 1);
        uint256 g = gasleft();
        assertTrue(setter.poke(0));
        uint256 used0 = g - gasleft();
        g = gasleft();
        assertTrue(setter.poke(2));
        uint256 used2 = g - gasleft();
        (,,, bool direct) = source.fetchWithOrigin(BNB_USD);
        assertFalse(direct);
        emit log_named_uint("changing poke, row 0, both direct budgets burnt (gas)", used0);
        emit log_named_uint("changing poke, row 2, copy only (gas)", used2);
        // The keeper signs a poke with at least 900,000 gas (atlas-relay.ts POKE_GAS): about 1.5 times this.
        assertLt(used0 * 3 / 2, 900_001);
    }

    // ---- The mirror alone.

    function test_mirror_rules() external {
        vm.warp(1_800_000_000);
        mirror = new AtlasMirror(KEEPER);
        assertEq(mirror.decimals(), 18);
        bytes4[] memory ids = new bytes4[](1);
        AtlasPriceSnapshot[] memory s = new AtlasPriceSnapshot[](1);
        ids[0] = NVDAB_USD;
        s[0] = AtlasPriceSnapshot(NVDAB_PRICE, 1_799_999_990, 1_799_999_991);
        vm.expectRevert(abi.encodeWithSelector(AtlasMirror.NotWriter.selector, address(this)));
        mirror.push(ids, s);
        assertEq(_push(NVDAB_USD, NVDAB_PRICE, 1_799_999_990, 1_799_999_991), 1);
        assertEq(mirror.fetch(NVDAB_USD).price, NVDAB_PRICE);
        // Not newer, zero, or more than 60 s in the future: skipped.
        assertEq(_push(NVDAB_USD, 1e18, 1_799_999_990, 1_799_999_991), 0);
        assertEq(_push(NVDAB_USD, 0, 1_799_999_995, 1_799_999_995), 0);
        assertEq(_push(NVDAB_USD, 1e18, 1_800_000_061, 1_800_000_061), 0);
        assertEq(mirror.fetch(NVDAB_USD).onchainTs, 1_799_999_991);
        assertEq(mirror.fetchBatch(ids)[0].price, NVDAB_PRICE);
        assertEq(mirror.fetch(BNB_USD).onchainTs, 0);
    }
}
