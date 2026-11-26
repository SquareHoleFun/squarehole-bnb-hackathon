// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxRoyaltyRouterV2} from "../../src/box-v2/interfaces/IBoxPeripheryV2.sol";
import {IFeeModulesV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {CommonBase} from "forge-std/Base.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../src/box-v2/BoxFactoryV2Planner.sol";
import {IBoxFactoryV2Wiring} from "../../src/box-v2/BoxFactoryV2.sol";

/// @notice Script-only inventory of all runtime parts, including constructor-created view contracts.
abstract contract CoreV2ReleaseInventory is CommonBase {
    error BadPart(address part);
    error CodeHashMismatch(address part, bytes32 expected, bytes32 actual);

    /// @dev Libraries come from deployment links or the authenticated saved manifest, never verifier links.
    /// Order: curve, pending, rewards, reward accounting, books, module proof, module call, shop.
    function _inventory(BoxFactoryV2 f, address[8] memory libraries)
        internal
        view
        returns (address[] memory parts, string[] memory names, bytes32[] memory hashes)
    {
        parts = new address[](42);
        names = new string[](42);
        parts[0] = f.registry();
        names[0] = "BoxRegistryV2";
        parts[1] = f.listingRegistry();
        names[1] = "ListingRegistry";
        uint256[15] memory slots = [uint256(0), 1, 2, 3, 4, 5, 6, 7, 8, 17, 19, 20, 21, 16, 22];
        string[15] memory implementations = [
            "BoxCoordinatorV2",
            "BoxTokenV2",
            "BoxHookV2",
            "BoxVaultV2",
            "BoxCollectionV2",
            "BoxReceiverV2",
            "BoxLaunchRouterV2",
            "BoxTicketsV2",
            "BoxRoyaltyRouterV2",
            "HolderLedgerV2",
            "StarterSetLoaderV2",
            "BoxTokenV2Ledger",
            "ShopVaultV2",
            "ItemLedgerV2",
            "PileVaultV2"
        ];
        for (uint256 i; i < slots.length; ++i) {
            parts[i + 2] = f.implementation(slots[i]);
            names[i + 2] = implementations[i];
        }
        parts[17] = IBoxFactoryV2Wiring(f.implementation(2)).extension();
        names[17] = "BoxHookV2Extension";
        BoxFactoryV2Planner planner = f.planner();
        parts[18] = address(planner.validator());
        names[18] = "BoxSpecV2Validator";
        parts[19] = address(planner);
        names[19] = "BoxFactoryV2Planner";
        parts[20] = address(f.checks());
        names[20] = "BoxFactoryV2Checks";
        parts[21] = address(f);
        names[21] = "BoxFactoryV2";
        parts[22] = vm.computeCreateAddress(f.implementation(0), 1);
        names[22] = "CoordinatorViews";
        parts[23] = vm.computeCreateAddress(f.implementation(3), 1);
        names[23] = "VaultViews";
        (parts[24], parts[28], parts[29]) = IFeeModulesV21(f.implementation(5)).receiverCode();
        names[24] = "ReceiverViews";
        parts[25] = vm.computeCreateAddress(f.implementation(7), 1);
        names[25] = "BoxTicketsV2Views";
        parts[26] = address(planner.parts());
        names[26] = "BoxFactoryV2Parts";
        parts[27] = libraries[0];
        names[27] = "FactoryChecksCurve";
        names[29] = "FeeModuleDirectoryV21";
        string[4] memory moduleNames = ["EatPriceCoinFeeModuleV21", "HoldersTFeeModuleV21", "ItemsTFeeModuleV21", "PileFeeModuleV21"];
        for (uint8 i; i < 4; ++i) {
            (parts[30 + i],) = IFeeModulesV21(f.implementation(5)).feeModule(i + 6);
            names[30 + i] = moduleNames[i];
        }
        parts[34] = libraries[1]; names[34] = "ReceiverPendingV21";
        parts[35] = libraries[2]; names[35] = "ReceiverRewardsV21";
        parts[36] = libraries[3]; names[36] = "RewardAccountingV21";
        names[28] = "BoxReceiverV2Extension";
        parts[37] = libraries[4]; names[37] = "ReceiverBooksV21";
        parts[38] = libraries[5]; names[38] = "FeeModuleProofV21";
        parts[39] = libraries[6]; names[39] = "ReceiverModuleCallV21";
        parts[40] = libraries[7]; names[40] = "ReceiverShopV21";
        parts[41] = IBoxRoyaltyRouterV2(payable(f.implementation(8))).cowHandler();
        names[41] = "RoyaltyCowHandler";
        hashes = new bytes32[](parts.length);
        for (uint256 i; i < parts.length; ++i) {
            if (parts[i].code.length == 0 || parts[i].code.length > 22_118) revert BadPart(parts[i]);
            for (uint256 j; j < i; ++j) {
                if (parts[i] == parts[j]) revert BadPart(parts[i]);
            }
            hashes[i] = parts[i].codehash;
        }
    }

    /// @dev Stateless views and the CoW handler have no immutables or links; match exact artifact runtime.
    function _checkViews(address[] memory parts, string[] memory names) internal view {
        bytes32 handlerHash = keccak256(vm.getDeployedCode("RoyaltyCowHandler.sol:RoyaltyCowHandler"));
        if (parts[41].codehash != handlerHash) revert CodeHashMismatch(parts[41], handlerHash, parts[41].codehash);
        for (uint256 i = 22; i < 26; ++i) {
            bytes32 expected = keccak256(vm.getDeployedCode(string.concat(names[i], ".sol:", names[i])));
            if (parts[i].codehash != expected) revert CodeHashMismatch(parts[i], expected, parts[i].codehash);
        }
    }
}
