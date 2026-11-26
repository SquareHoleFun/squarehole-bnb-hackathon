// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IListingRegistry} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {BnbTestnet, BnbTestnetCustody} from "./BnbTestnet.sol";
import {AtlasMirror, AtlasPriceRead, AtlasRaiseSetter, AtlasSource} from "./AtlasRaise.sol";

/// @notice SH-266 and SH-272, BNB Chain test network (chain 97) only: equal-dollar raises from Atlas prices.
/// `deployOpen` (SH-272) deploys, in this order, a source on Atlas's open feeds of this chain (BNB/USD, then NVDAB/USD,
/// XAU/USD and ETH/USD, each with its own measured age limit) and a setter (rows 0 BNB, 2 tNVDA, 3 tGOLD and 5 tETH, each
/// read through that source; the dollar target is the run's argument: 1.00 USD). The source's constructor requires a
/// mirror: it gets the one deployed on 25 November 2026, which is never written again (every managed row reads Atlas
/// directly). Refused unless the registry's lister IS the holding contract: the setter's `returnTo` is the lister at its
/// construction, so a setter deployed while an earlier setter holds the role would hand back to that setter.
/// `handover` moves the listing registry's lister role from the platform's holding contract to the setter (two sends of
/// the deployer); `handBack` returns it (two sends). Signed by the configured Foundry sender, who owns the holding
/// contract; this file reads no key.
/// The first deployment (25 November 2026: mirror, source and two setters on the first BNB/USD feed, which stopped
/// answering contracts and then stopped updating) is described in deployments/bnb-testnet/97-atlas.json under `retired`
/// and in hackathon/evidence/SH-266.md; the paths that deployed it are gone.
contract AtlasRaiseDeploy is Script {
    /// @notice Feed ids as bytes4: Atlas's published numbers 633 BNB/USD, 632 ETH/USD and 934 NVDAB/USD; XAU/USD has no
    /// published number, so its id here is the bytes "XAU" (ours, used only as this source's and mirror's key).
    bytes4 internal constant BNB_USD = 0x00000279;
    bytes4 internal constant ETH_USD = 0x00000278;
    bytes4 internal constant NVDAB_USD = 0x000003a6;
    bytes4 internal constant XAU_USD = 0x58415500;
    uint32 internal constant BNB_ROW = 0;
    uint32 internal constant TNVDA_ROW = 2;
    uint32 internal constant TGOLD_ROW = 3;
    uint32 internal constant TETH_ROW = 5;
    /// @notice Atlas's open SingleFeeds on BNB Chain testnet (no caller list; given to the founder on 25 November 2026):
    /// BNB/USD and ETH/USD; NVDAB/USD and XAU/USD as deployed by Atlas for this build the same day.
    address internal constant ATLAS_BNB_USD_OPEN_97 = 0x3957d289ee9C38272377786787ea34F9dd29788D;
    address internal constant ATLAS_ETH_USD_OPEN_97 = 0x35369dEcD8c662954B3D24acc2A862C708A34fD2;
    address internal constant ATLAS_NVDAB_USD_97 = 0x3eF39d6361EfA1E8Ca066751f438077dA81082A6;
    address internal constant ATLAS_XAU_USD_97 = 0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764;
    /// @notice Each feed's age limit: at least three times the largest gap between updates seen in a sample of at least
    /// 20 minutes, at most 3,600 (hackathon/evidence/SH-272.md, the rhythm table).
    uint256 internal constant BNB_MAX_AGE = 190;
    uint256 internal constant ETH_MAX_AGE = 190;
    uint256 internal constant NVDAB_MAX_AGE = 910;
    uint256 internal constant XAU_MAX_AGE = 910;
    /// @notice The mirror deployed on 25 November 2026 (written only by the keeper's wallet); reused as the new source's
    /// required mirror and never written again.
    address internal constant DEPLOYED_MIRROR = 0xE1F83eE5a2ba0f5Bf4Ff7737D9C879f716d2e912;
    address internal constant KEEPER = 0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189;

    /// @notice Refused before anything is sent (forge simulates the whole function first) unless `custody` holds the
    /// lister role and is owned by this sender, and the deployed mirror is in place. After the sends, still inside the
    /// simulation: the setter hands back to `custody`, and every row quotes from Atlas directly with room for its price
    /// to halve or double (the raise then stays at or above the registry's floor and at most the row's ceiling).
    function deployOpen(address listings, address custody, uint256 targetUsdX18)
        external
        returns (address source, address setter)
    {
        BnbTestnet.check(block.chainid);
        IListingRegistry reg = IListingRegistry(listings);
        require(
            reg.lister() == custody,
            "the registry's lister is not the holding contract given: hand the role back first (handBack), then deploy"
        );
        require(BnbTestnetCustody(payable(custody)).getOwners()[0] == msg.sender, "the holding contract's owner is not this sender");
        require(DEPLOYED_MIRROR.code.length > 0 && AtlasMirror(DEPLOYED_MIRROR).writer() == KEEPER, "not the deployed mirror");
        uint32[] memory ids = new uint32[](4);
        uint8[] memory kinds = new uint8[](4);
        address[] memory sources = new address[](4);
        bytes4[] memory feeds = new bytes4[](4);
        vm.startBroadcast(msg.sender);
        source = address(new AtlasSource(ATLAS_BNB_USD_OPEN_97, BNB_USD, AtlasMirror(DEPLOYED_MIRROR), BNB_MAX_AGE));
        AtlasSource(source).addDirectFeed(NVDAB_USD, ATLAS_NVDAB_USD_97, NVDAB_MAX_AGE);
        AtlasSource(source).addDirectFeed(XAU_USD, ATLAS_XAU_USD_97, XAU_MAX_AGE);
        AtlasSource(source).addDirectFeed(ETH_USD, ATLAS_ETH_USD_OPEN_97, ETH_MAX_AGE);
        (ids[0], kinds[0], sources[0], feeds[0]) = (BNB_ROW, AtlasPriceRead.SOURCE, source, BNB_USD);
        (ids[1], kinds[1], sources[1], feeds[1]) = (TNVDA_ROW, AtlasPriceRead.SOURCE, source, NVDAB_USD);
        (ids[2], kinds[2], sources[2], feeds[2]) = (TGOLD_ROW, AtlasPriceRead.SOURCE, source, XAU_USD);
        (ids[3], kinds[3], sources[3], feeds[3]) = (TETH_ROW, AtlasPriceRead.SOURCE, source, ETH_USD);
        setter = address(new AtlasRaiseSetter(reg, msg.sender, targetUsdX18, ids, kinds, sources, feeds));
        vm.stopBroadcast();
        AtlasRaiseSetter st = AtlasRaiseSetter(setter);
        require(st.returnTo() == custody, "the setter would hand back to another contract");
        for (uint256 i; i < ids.length; ++i) _checkRow(reg, st, ids[i]);
        console.log(string.concat("BNB|atlasMirror|", vm.toString(DEPLOYED_MIRROR)));
        console.log(string.concat("BNB|atlasSource|", vm.toString(source)));
        console.log(string.concat("BNB|atlasFeedBnbUsd|", vm.toString(ATLAS_BNB_USD_OPEN_97)));
        console.log(string.concat("BNB|atlasFeedNvdabUsd|", vm.toString(ATLAS_NVDAB_USD_97)));
        console.log(string.concat("BNB|atlasFeedXauUsd|", vm.toString(ATLAS_XAU_USD_97)));
        console.log(string.concat("BNB|atlasFeedEthUsd|", vm.toString(ATLAS_ETH_USD_OPEN_97)));
        console.log(string.concat("BNB|atlasRaiseSetter|", vm.toString(setter)));
    }

    /// @notice A row quotes from Atlas directly now, and its raise at half and at twice today's price stays within the
    /// registry's floor and the row's ceiling.
    function _checkRow(IListingRegistry reg, AtlasRaiseSetter st, uint32 id) internal view {
        string memory row = string.concat("row ", vm.toString(uint256(id)));
        (uint256 raise,,,, bool direct) = st.quote(id);
        require(direct, string.concat(row, ": the price is not Atlas's own"));
        (,,,,, uint256 startRaise,) = st.rows(id);
        require(raise * 2 <= startRaise * st.MAX_MULTIPLE(), string.concat(row, ": no room for the price to halve"));
        require(raise / 2 >= 1_000_000, string.concat(row, ": no room for the price to double"));
        try reg.checkLayout(raise / 2) {}
        catch { revert(string.concat(row, ": no room for the price to double")); }
        console.log(string.concat(row, ": quote ", vm.toString(raise), ", ceiling ", vm.toString(startRaise * st.MAX_MULTIPLE()), ", direct"));
    }

    /// @notice Checks everything first, then proposes the setter (the holding contract's call) and accepts. Refused with
    /// a plain message when `expectedCustody` (the platform's holding contract, given on the command line) is not both
    /// the registry's current lister and the setter's `returnTo`, the setter is not this sender's, names another
    /// registry, its mirror has another writer than `keeper`, its target is not `targetUsdX18`, or a managed row has no
    /// fresh quote now.
    function handover(address listings, address setter, address keeper, uint256 targetUsdX18, address expectedCustody)
        external
    {
        BnbTestnet.check(block.chainid);
        AtlasRaiseSetter st = AtlasRaiseSetter(setter);
        require(IListingRegistry(listings).lister() == expectedCustody, "the registry's lister is not the holding contract given");
        require(st.returnTo() == expectedCustody, "the setter would hand back to another holding contract");
        BnbTestnetCustody custody = BnbTestnetCustody(payable(expectedCustody));
        require(st.owner() == msg.sender, "the setter's owner is not this sender");
        require(address(st.listings()) == listings, "the setter names another listing registry");
        require(st.returnTo() == address(custody), "the setter names another holding contract");
        require(st.targetUsdX18() == targetUsdX18, "the setter's dollar target is not the one given");
        uint256 count = st.managedCount();
        require(count > 0, "the setter manages no row");
        for (uint256 i; i < count; ++i) {
            uint32 id = st.managedIds(i);
            (,,, address source,,,) = st.rows(id);
            require(AtlasSource(source).mirror().writer() == keeper, "the mirror's writer is not the keeper given");
            try st.quote(id) returns (uint256, uint256, uint256, uint256, bool) {}
            catch { revert(string.concat("row ", vm.toString(uint256(id)), " has no fresh quote now")); }
        }
        vm.startBroadcast(msg.sender);
        custody.execute(listings, 0, abi.encodeCall(IListingRegistry.proposeLister, (setter)));
        st.accept();
        vm.stopBroadcast();
        require(IListingRegistry(listings).lister() == setter, "handover failed");
        console.log(string.concat("BNB|lister|", vm.toString(setter)));
    }

    function handBack(address listings, address setter) external {
        BnbTestnet.check(block.chainid);
        address custody = AtlasRaiseSetter(setter).returnTo();
        vm.startBroadcast(msg.sender);
        AtlasRaiseSetter(setter).handBack();
        BnbTestnetCustody(payable(custody)).execute(listings, 0, abi.encodeCall(IListingRegistry.acceptLister, ()));
        vm.stopBroadcast();
        require(IListingRegistry(listings).lister() == custody, "hand-back failed");
        console.log(string.concat("BNB|lister|", vm.toString(custody)));
    }
}
