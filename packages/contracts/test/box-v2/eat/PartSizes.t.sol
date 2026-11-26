// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";

/// V21-MONEY-01 size pins: the exact production runtime of every gated release part in size-budget.v2.json.
/// G1 remeasures fixed receiver dispatch and includes both shared Alchemist parts; G1-INT the graduation clock
/// restart and the Alchemist dust size; RC5-B moves dust claims to the box hook; the RC5 integration fix round shares
/// the receiver's failed read and stops a failed box forwarding royalties (18,404 to 17,915 B).
/// RC6-CC collects before claims and previews collectable P (coordinator 21,207 B; receiver 17,992 B).
/// RC6 pins the plain-hook conversion and fixed-fee checks, including current linked runtime widths.
/// RC5-C removes conversion custody; RC6-COW-INBOX gives every box an income inbox (router, handler, listing lots).
/// RC6-INT part 2 merges both: coordinator 21,802 B, receiver 17,322 B, factory checks 22,061 B, measured; the shared
/// CoW handler (2,301 B) is the manifest's 45th gate (INBOX request 7). Its fix round registers each inbox order
/// without the ComposableCoW broadcast (R1-1): the router 11,920 to 11,919 B, measured.
/// RC6-RR-FEEPATH: value-sized hook pages (21,724 B), independent receiver cursors (books 13,588 B).
/// RC6-CREATION-GAS reads the Shop's immutable seed/prices from clone code: 19,229 B, measured.
/// RC6-RR-INBOX: pending-income claim views and whole-lot registration, measured on both EVMs.
/// RC7-INBOX-PAYLOAD: canonical-only verification removes the scan/decoder; router 13,260 to 12,160 B.
/// RC7-CLAIM-RESERVE: the inbox sweep's 4M admission reserve; coordinator 22,043 to 22,064 B. Both measured together.
/// RC7-RECEIVER-QUOTA: additive cursor view 17,646 B; bounded sub-unit allocation and zero-range elision 13,669 B.
/// The four rc7 rows measured together on the merged tree (SH-V21-RC7-INT part 3).
/// RC7-HOOK-PAGE: remove the four-valued-source stop; hook runtime 21,670 B.
contract EatPartSizesTest is Test {
    uint256 internal constant GATE = 22_118;

    function test_V21M01_everyGatedPartSizeIsPinned() public view {
        string memory manifest = vm.readFile("size-budget.v2.json");
        string[45] memory names = [
            string("BoxCollectionV2"), "BoxCoordinatorV2", "BoxFactoryV2", "BoxFactoryV2Checks", "BoxFactoryV2Parts",
            "BoxFactoryV2Planner", "BoxHookV2", "BoxHookV2Extension", "BoxLaunchRouterV2", "BoxReceiverV2",
            "BoxReceiverV2Extension", "BoxRegistryV2", "BoxRoyaltyRouterV2", "BoxSpecV2Validator", "BoxTicketsV2",
            "BoxTicketsV2Views", "BoxTokenV2", "BoxTokenV2Ledger", "BoxVaultV2", "CoordinatorViews",
            "FactoryChecksCurve", "HolderLedgerV2", "ItemLedgerV2", "ListingRegistry", "PileVaultV2",
            "ReceiverViews", "ShopTBurnerV2", "ShopVaultV2", "StarterSetLoaderV2", "VaultViews",
            "FeeModuleDirectoryV21", "EatPriceCoinFeeModuleV21", "HoldersTFeeModuleV21", "ItemsTFeeModuleV21",
            "PileFeeModuleV21", "ReceiverBooksV21", "ReceiverPendingV21", "ReceiverRewardsV21",
            "RewardAccountingV21", "FeeModuleProofV21", "ReceiverModuleCallV21", "ReceiverShopV21", "AlchemistFeeModuleV21", "AlchemistRouteV21",
            "RoyaltyCowHandler"
        ];
        uint256[45] memory sizes = [
            uint256(15723), 22064, 10405, 22061, 17424, 14956, 21670, 21514, 10901, 17646, 5452, 4858, 12160, 14963, 21295, 5975, 3024, 5809, 21163, 1183, 4407, 9107, 16080, 19282, 7515, 5477, 272, 19229, 3690, 1555, 3865, 2292, 2642, 2642, 1803, 13669, 3202, 4466, 1297, 771, 1429, 6238, 3333, 13388, 2301
        ];
        assertEq(vm.parseJsonKeys(manifest, ".gates").length, names.length, "every gate pinned");
        for (uint256 i; i < names.length; ++i) {
            string memory source = vm.parseJsonString(manifest, string.concat(".gates.", names[i], ".source"));
            uint256 size = vm.getDeployedCode(string.concat(source, ":", names[i])).length;
            assertEq(size, sizes[i], names[i]);
            assertLe(size, GATE, names[i]);
        }
    }

    /// The planner's constructor embeds the parts runtime for its code-hash check: creation code stays deployable.
    function test_V21M01_plannerCreationCodePinned() public view {
        uint256 size = vm.getCode("src/box-v2/BoxFactoryV2Planner.sol:BoxFactoryV2Planner").length;
        assertEq(size, 32776, "planner creation code");
        assertLe(size, 49_152, "EIP-3860 initcode limit");
    }
}
