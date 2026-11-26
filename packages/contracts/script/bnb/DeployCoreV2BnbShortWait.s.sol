// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RoyaltyCowConfig} from "../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {ReceiverCodeV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {BoxFactoryV2Planner} from "../../src/box-v2/BoxFactoryV2Planner.sol";
import {CoreV2Deployment} from "../sepolia-v2/CoreV2Deployment.sol";
import {CowOffline} from "../../test/box-v2/kit/RoyaltyRelease.sol";
import {BnbTestnet} from "./BnbTestnet.sol";
// The linked libraries and artifact-only CREATEs, as DeployCoreV2.s.sol makes them reachable to the compiler and linker.
import {FactoryChecksCurve} from "../../src/box-v2/libraries/FactoryChecksCurve.sol";
import {ReceiverShopV21} from "../../src/box-v2/libraries/ReceiverShopV21.sol";
import {ReceiverPendingV21} from "../../src/box-v2/libraries/ReceiverPendingV21.sol";
import {ReceiverRewardsV21} from "../../src/box-v2/libraries/ReceiverRewardsV21.sol";
import {RewardAccountingV21} from "../../src/box-v2/libraries/RewardAccountingV21.sol";
import {ReceiverBooksV21} from "../../src/box-v2/libraries/ReceiverBooksV21.sol";
import {FeeModuleProofV21} from "../../src/box-v2/libraries/FeeModuleProofV21.sol";
import {ReceiverModuleCallV21} from "../../src/box-v2/libraries/ReceiverModuleCallV21.sol";
import {BoxFactoryV2Checks} from "../../src/box-v2/libraries/BoxFactoryV2Checks.sol";
import {ItemLedgerV2} from "../../src/box-v2/ItemLedgerV2.sol";
import {PileVaultV2} from "../../src/box-v2/PileVaultV2.sol";
import {HolderLedgerV2} from "../../src/box-v2/HolderLedgerV2.sol";
import {BoxTokenV2Ledger} from "../../src/box-v2/BoxTokenV2Ledger.sol";
import {StarterSetLoaderV2} from "../../src/box-v2/StarterSetLoaderV2.sol";
import {BoxVaultV2} from "../../src/box-v2/BoxVaultV2.sol";
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {BoxTicketsV2} from "../../src/box-v2/BoxTicketsV2.sol";
import {BoxRoyaltyRouterV2} from "../../src/box-v2/BoxRoyaltyRouterV2.sol";
// The two ten-minute copies, in the script's compilation so their artifacts exist for vm.getCode.
import {ShopVaultV2ShortWait} from "./ShopVaultV2ShortWait.sol";
import {BoxSpecV2ValidatorShortWait} from "./BoxSpecV2ValidatorShortWait.sol";

/// @notice SH-300: a SECOND v2 release on BNB Chain testnet (chain 97) whose card shops may open gives ten minutes
/// after listing. It is the release exactly as `DeployCoreV2Bnb` deploys it (`DeployCoreV2Local._deployLocalCoreV2`,
/// copied line for line) with two parts swapped: role 21 is `ShopVaultV2ShortWait` and the spec validator is
/// `BoxSpecV2ValidatorShortWait`; each is its release original with one accepted value added (600 seconds).
/// It reuses the first release's PoolManager, WBNB, DrandSource and the two holding contracts (the fee addresses and
/// the lister); it makes its own registry, listing registry, fee-module directory, coordinator, hook and every other
/// implementation. This script exposes one entry point, `run`, guarded for chain 97 (it inherits no other script).
contract DeployCoreV2BnbShortWait is Script, CoreV2Deployment {
    string internal constant SHORT_WAIT_SHOP = "ShopVaultV2ShortWait.sol:ShopVaultV2ShortWait";
    string internal constant SHORT_WAIT_VALIDATOR = "BoxSpecV2ValidatorShortWait.sol:BoxSpecV2ValidatorShortWait";

    function run(address manager, address weth, address drand, address firstFee, address platform)
        external returns (address factory)
    {
        BnbTestnet.check(block.chainid);
        require(keccak256(type(ShopVaultV2ShortWait).creationCode) != bytes32(0)
            && keccak256(type(BoxSpecV2ValidatorShortWait).creationCode) != bytes32(0), "variants compiled");
        // As DeployCoreV2Local._measureLocalGas: the linked checks library reachable, the state-gas rule measured.
        require(keccak256(type(BoxFactoryV2Checks).creationCode) != bytes32(0), "missing linked checks");
        chargesStateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;
        vm.startBroadcast(msg.sender);
        address cow = address(new CowOffline());
        Config memory c = Config(msg.sender, manager, weth, drand, address(0), firstFee, platform,
            RoyaltyCowConfig(cow, cow, 0.05 ether));
        factory = _deployShortWaitRelease(c).factory;
        vm.stopBroadcast();
        console.log(string.concat("BNB|factory|", vm.toString(factory)));
    }

    /// @dev `DeployCoreV2Local._deployLocalCoreV2`, unchanged but for role 21 (the shop), the validator, and without
    /// local coins (dead on 97: no older registry).
    function _deployShortWaitRelease(Config memory c) internal returns (BoxFactoryV2Planner.Release memory r) {
        r.factory = vm.computeCreateAddress(c.deployer, uint256(vm.getNonce(c.deployer)) + 29);
        r.poolManager = c.manager;
        r.weth = c.weth;
        r.randomness = c.randomness;
        address[] memory directory = new address[](0);
        r.registry = _deploy("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(r.factory, directory));
        r.listingRegistry =
            _deploy("ListingRegistry.sol:ListingRegistry", abi.encode(c.platformSafe, r.registry, c.manager, c.weth));
        address ci = _deploy("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(c.manager, r.factory));
        r.implementations[0] = ci;
        r.implementations[1] = _deploy("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        address ext = _deploy("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(c.manager));
        r.implementations[2] = _deploy("BoxHookV2.sol:BoxHookV2", abi.encode(c.manager, ci, ext));
        r.implementations[3] = _deploy("BoxVaultV2.sol:BoxVaultV2", abi.encode(ci));
        r.implementations[4] = _deploy("BoxCollectionV2.sol:BoxCollectionV2", abi.encode(ci));
        ReceiverCodeV21 memory receiverCode = _receiverCode(c);
        r.implementations[5] = _deploy(
            "BoxReceiverV2.sol:BoxReceiverV2", abi.encode(c.manager, ci, c.fitSafe, c.platformSafe, receiverCode)
        );
        r.implementations[6] = _deploy("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(c.manager, ci));
        r.implementations[7] = _deploy("BoxTicketsV2.sol:BoxTicketsV2", abi.encode(ci));
        r.implementations[8] = _deploy("BoxRoyaltyRouterV2.sol:BoxRoyaltyRouterV2", abi.encode(c.cow));
        r.implementations[17] = _deploy("HolderLedgerV2.sol:HolderLedgerV2", abi.encode(c.manager));
        r.implementations[19] = _deploy("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        r.implementations[20] = _deploy("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(ci));
        r.implementations[21] = _deploy(SHORT_WAIT_SHOP, abi.encode(c.manager, ci));
        r.implementations[16] = _deploy("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(c.manager, ci));
        r.implementations[22] = _deploy("PileVaultV2.sol:PileVaultV2", abi.encode(ci));
        address validator = _deploy(SHORT_WAIT_VALIDATOR, "");
        address parts = _deploy("BoxFactoryV2Parts.sol:BoxFactoryV2Parts", "");
        address planner = _deploy("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, parts));
        address checks = _deploy("BoxFactoryV2Checks.sol:BoxFactoryV2Checks", "");
        address factory = _deploy("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(r, planner, checks));
        if (factory != r.factory) revert WrongFactoryPrediction(r.factory, factory);
    }
}
