// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";

/// @notice CQ11-0: every surviving deployed part obeys the ticket's runtime limit, including Tickets.
contract CQ11SizeBudgetTest is Test {
    uint256 constant LIMIT = 22_118;

    function test_manifestNamesOnlySurvivingParts() public view {
        string memory manifest = vm.readFile("size-budget.v2.json");
        assertEq(vm.parseJsonUint(manifest, ".limitBytes"), 24_576);
        assertEq(vm.parseJsonUint(manifest, ".minReserveBytes"), 2_458);
        string[] memory parts = vm.parseJsonKeys(manifest, ".gates");
        string[45] memory expected = [
            string("BoxCollectionV2"),
            "BoxCoordinatorV2",
            "BoxFactoryV2",
            "BoxFactoryV2Checks",
            "BoxFactoryV2Parts",
            "BoxFactoryV2Planner",
            "BoxHookV2",
            "BoxHookV2Extension",
            "BoxLaunchRouterV2",
            "BoxReceiverV2",
            "BoxReceiverV2Extension",
            "BoxRegistryV2",
            "BoxRoyaltyRouterV2",
            "BoxSpecV2Validator",
            "BoxTicketsV2",
            "BoxTicketsV2Views",
            "BoxTokenV2",
            "BoxTokenV2Ledger",
            "BoxVaultV2",
            "CoordinatorViews",
            "FactoryChecksCurve",
            "HolderLedgerV2",
            "ItemLedgerV2",
            "ListingRegistry",
            "PileVaultV2",
            "ReceiverViews",
            "ShopTBurnerV2",
            "ShopVaultV2",
            "StarterSetLoaderV2",
            "VaultViews",
            "FeeModuleDirectoryV21",
            "EatPriceCoinFeeModuleV21",
            "HoldersTFeeModuleV21",
            "ItemsTFeeModuleV21",
            "PileFeeModuleV21",
            "ReceiverBooksV21",
            "ReceiverPendingV21",
            "ReceiverRewardsV21",
            "RewardAccountingV21",
            "FeeModuleProofV21",
            "ReceiverModuleCallV21",
            "ReceiverShopV21", "AlchemistFeeModuleV21", "AlchemistRouteV21", "RoyaltyCowHandler"
        ];
        assertEq(parts.length, expected.length);
        for (uint256 i; i < expected.length; ++i) {
            string memory gate = string.concat(".gates.", expected[i]);
            assertEq(vm.parseJsonUint(manifest, string.concat(gate, ".m1GateBytes")), LIMIT);
            assertEq(vm.parseJsonUint(manifest, string.concat(gate, ".reserveBytes")), 2_458);
            bytes32 nameHash = keccak256(bytes(expected[i]));
            string memory folder = nameHash == keccak256("BoxFactoryV2Checks")
                || nameHash == keccak256("CoordinatorViews") || nameHash == keccak256("VaultViews") || nameHash == keccak256("ReceiverViews") || nameHash == keccak256("FactoryChecksCurve")
                ? "src/box-v2/libraries/" : "src/box-v2/";
            string memory sourceName = nameHash == keccak256("ShopTBurnerV2") ? "ShopVaultV2" : expected[i];
            if (nameHash == keccak256("FeeModuleDirectoryV21")) folder = "src/box-v2/";
            if (i >= 31 && i <= 34) folder = "src/box-v2/modules/";
            if (i >= 35 && i <= 41) folder = "src/box-v2/libraries/";
            if (i >= 42 && i <= 43) folder = "src/box-v2/modules/";
            if (i == 44) folder = "src/box-v2/";
            assertEq(vm.parseJsonString(manifest, string.concat(gate, ".source")), string.concat(folder, sourceName, ".sol"));
        }
    }

    function _assertRuntime(string memory name) private view {
        string memory manifest = vm.readFile("size-budget.v2.json");
        string memory source = vm.parseJsonString(manifest, string.concat(".gates.", name, ".source"));
        bytes memory code = vm.getDeployedCode(string.concat(source, ":", name));
        assertGt(code.length, 0, name);
        assertLe(code.length, LIMIT, name);
    }
    function test_size_feeModulesAndFixedCoreLibraries() public view {
        _assertRuntime("FeeModuleDirectoryV21");
        _assertRuntime("EatPriceCoinFeeModuleV21");
        _assertRuntime("HoldersTFeeModuleV21");
        _assertRuntime("ItemsTFeeModuleV21");
        _assertRuntime("PileFeeModuleV21");
        _assertRuntime("ReceiverBooksV21");
        _assertRuntime("ReceiverPendingV21");
        _assertRuntime("ReceiverRewardsV21");
        _assertRuntime("RewardAccountingV21");
        _assertRuntime("FeeModuleProofV21");
        _assertRuntime("ReceiverModuleCallV21");
        _assertRuntime("ReceiverShopV21");
        _assertRuntime("AlchemistFeeModuleV21");
        _assertRuntime("AlchemistRouteV21");
    }
    function test_size_BoxCollectionV2() public view { _assertRuntime("BoxCollectionV2"); }
    function test_size_BoxCoordinatorV2() public view { _assertRuntime("BoxCoordinatorV2"); }
    function test_size_BoxFactoryV2() public view { _assertRuntime("BoxFactoryV2"); }
    function test_size_BoxFactoryV2Checks() public view { _assertRuntime("BoxFactoryV2Checks"); }
    function test_size_PileVaultV2() public view { _assertRuntime("PileVaultV2"); }
    function test_size_BoxFactoryV2Parts() public view { _assertRuntime("BoxFactoryV2Parts"); }
    function test_size_BoxFactoryV2Planner() public view { _assertRuntime("BoxFactoryV2Planner"); }
    function test_size_BoxHookV2() public view { _assertRuntime("BoxHookV2"); }
    function test_size_BoxHookV2Extension() public view { _assertRuntime("BoxHookV2Extension"); }
    function test_size_BoxLaunchRouterV2() public view { _assertRuntime("BoxLaunchRouterV2"); }
    function test_size_BoxReceiverV2() public view {
        _assertRuntime("BoxReceiverV2");
        string memory manifest = vm.readFile("size-budget.v2.json");
        assertEq(vm.parseJsonUint(manifest, ".gates.BoxReceiverV2.roomGateBytes"), 18_500);
        assertLe(vm.getDeployedCode("BoxReceiverV2.sol:BoxReceiverV2").length, 18_500);
    }
    function test_size_BoxReceiverV2Extension() public view { _assertRuntime("BoxReceiverV2Extension"); }
    function test_size_BoxRegistryV2() public view { _assertRuntime("BoxRegistryV2"); }
    function test_size_BoxRoyaltyRouterV2() public view { _assertRuntime("BoxRoyaltyRouterV2"); }
    function test_size_BoxSpecV2Validator() public view { _assertRuntime("BoxSpecV2Validator"); }
    function test_size_RoyaltyCowHandler() public view { _assertRuntime("RoyaltyCowHandler"); }
    function test_size_BoxTicketsV2() public view { _assertRuntime("BoxTicketsV2"); }
    function test_size_BoxTicketsV2Views() public view { _assertRuntime("BoxTicketsV2Views"); }
    function test_deploymentHarnessIsRecognisedAsTestOnly() public {
        address harness = address(0x7057);
        vm.etch(harness, vm.getDeployedCode("Box0CodePin.t.sol:Box0Step2Deployer"));
        (bool ok, bytes memory result) = harness.staticcall(abi.encodeWithSignature("IS_TEST()"));
        assertTrue(ok && result.length == 32 && abi.decode(result, (bool)), "test harness marker");
    }
    function test_size_deployedTicketsWithConstructorWiring() public {
        BoxTicketsV2 tickets = new BoxTicketsV2(address(0x1234));
        assertEq(tickets.coordinatorImplementation(), address(0x1234));
        address views = vm.computeCreateAddress(address(tickets), 1);
        bytes memory code = vm.getDeployedCode("BoxTicketsV2Views.sol:BoxTicketsV2Views");
        assertEq(views.codehash, keccak256(code), "constructor deploys the fixed view part");
        assertLe(views.code.length, LIMIT);
        assertLe(address(tickets).code.length, LIMIT, "deployed Tickets runtime");
    }
    function test_size_BoxTokenV2() public view { _assertRuntime("BoxTokenV2"); }
    function test_size_BoxTokenV2Ledger() public view { _assertRuntime("BoxTokenV2Ledger"); }
    function test_size_BoxVaultV2() public view { _assertRuntime("BoxVaultV2"); }
    function test_size_CoordinatorViews() public view { _assertRuntime("CoordinatorViews"); }
    function test_size_ItemLedgerV2() public view { _assertRuntime("ItemLedgerV2"); }
    function test_size_FactoryChecksCurve() public view { _assertRuntime("FactoryChecksCurve"); }
    function test_size_HolderLedgerV2() public view { _assertRuntime("HolderLedgerV2"); }
    function test_size_ListingRegistry() public view { _assertRuntime("ListingRegistry"); }
    function test_size_ShopTBurnerV2() public view { _assertRuntime("ShopTBurnerV2"); }
    function test_size_ShopVaultV2() public view { _assertRuntime("ShopVaultV2"); }
    function test_size_ReceiverViews() public view { _assertRuntime("ReceiverViews"); }
    function test_size_StarterSetLoaderV2() public view { _assertRuntime("StarterSetLoaderV2"); }
    function test_size_VaultViews() public view { _assertRuntime("VaultViews"); }
}
