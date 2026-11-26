// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ItemsInsidePolicy, ItemsDestParams} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {PileParams} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ItemFundingV2, IBoxReceiverItemsV2, IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLifecycleV2, IBoxVaultItemsV2, IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxTicketsItemsV2, IBoxTicketsV2} from "../../../src/box-v2/interfaces/IBoxPeripheryV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxFactoryPileV2, IBoxFactoryV2, IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxRolesV2 as R} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";

/// SH-V2-M3-SHAPES S1-S5: ABI declarations only, not a claim that the producers are implemented.
contract M3DeclarationsTest is Test {
    function test_S1_policyNumbers() public pure {
        assertEq(uint8(ItemsInsidePolicy.None), 0);
        assertEq(uint8(ItemsInsidePolicy.Keep), 1);
        assertEq(uint8(ItemsInsidePolicy.BuyBackBurn), 2);
    }

    function test_S1_S4_ledgerSelectors() public pure {
        assertEq(IItemLedgerV2.insidePolicies.selector, bytes4(keccak256("insidePolicies()")));
        assertEq(IItemLedgerV2.lifecycleCursor.selector, bytes4(keccak256("lifecycleCursor()")));
        assertEq(IItemLedgerV2.ItemSyncPending.selector, bytes4(keccak256("ItemSyncPending(uint256,uint256)")));
    }

    function test_S2_receiptSelectorsAndEvent() public pure {
        assertEq(IBoxReceiverItemsV2.itemFundingCount.selector, bytes4(keccak256("itemFundingCount()")));
        assertEq(IBoxReceiverItemsV2.itemFunding.selector, bytes4(keccak256("itemFunding(uint256)")));
        assertEq(IBoxReceiverItemsV2.ItemFunded.selector, keccak256("ItemFunded(uint256,uint256,uint8,uint8,uint256,uint256)"));
    }

    function test_S3_lifecycleSelectorsEventAndError() public pure {
        assertEq(IBoxVaultItemsV2.itemLifecycleCount.selector, bytes4(keccak256("itemLifecycleCount()")));
        assertEq(IBoxVaultItemsV2.itemLifecycle.selector, bytes4(keccak256("itemLifecycle(uint256)")));
        assertEq(IBoxVaultItemsV2.ITEM_BATCH_MAX.selector, bytes4(keccak256("ITEM_BATCH_MAX()")));
        assertEq(IBoxVaultItemsV2.ItemBatchTooLarge.selector, bytes4(keccak256("ItemBatchTooLarge(uint256,uint256)")));
        assertEq(IBoxVaultItemsV2.ItemLifecycleRecorded.selector,
            keccak256("ItemLifecycleRecorded(uint256,bytes32,uint256,uint256,uint64,uint8)"));
        assertEq(IBoxTicketsItemsV2.activeItemTicket.selector, bytes4(keccak256("activeItemTicket(uint256)")));
    }

    function test_S5_factoryPredicateSelector() public pure {
        assertEq(IBoxFactoryPileV2.isPileVault.selector, bytes4(keccak256("isPileVault(address)")));
    }

    function testFuzz_S1_itemsTuple(uint8 policy) public pure {
        // All uint8 wire values can decode; validation of 1/2 is M3-10's responsibility.
        bytes memory encoded = abi.encode(ItemsDestParams({insidePolicy: policy}));
        assertEq(encoded.length, 32);
        assertEq(encoded, abi.encode(policy));
        uint8 decoded = abi.decode(encoded, (ItemsDestParams)).insidePolicy;
        assertEq(decoded, policy);
    }

    function testFuzz_S1_pileTuple(address asset, uint256 seed) public pure {
        bytes memory encoded = abi.encode(PileParams({asset: asset, seedAmount: seed}));
        assertEq(encoded.length, 64);
        assertEq(encoded, abi.encode(asset, seed));
        PileParams memory decoded = abi.decode(encoded, (PileParams));
        assertEq(decoded.asset, asset);
        assertEq(decoded.seedAmount, seed);
    }

    function testFuzz_S2_fundingTuple(ItemFundingV2 memory receipt) public pure {
        bytes memory encoded = abi.encode(receipt);
        assertEq(encoded.length, 256);
        assertEq(encoded, abi.encode(receipt.batchId, receipt.lifecycleCursor, receipt.choiceP, receipt.ledgerP,
            receipt.insideCount, receipt.hiddenCount, receipt.side, receipt.source));
        ItemFundingV2 memory decoded = abi.decode(encoded, (ItemFundingV2));
        assertEq(abi.encode(decoded), encoded);
    }

    function testFuzz_S3_lifecycleTuple(ItemLifecycleV2 memory operation) public pure {
        bytes memory encoded = abi.encode(operation);
        assertEq(encoded.length, 160);
        assertEq(encoded, abi.encode(operation.ticketKey, operation.itemId, operation.fundingCursor, operation.at, operation.kind));
        ItemLifecycleV2 memory decoded = abi.decode(encoded, (ItemLifecycleV2));
        assertEq(abi.encode(decoded), encoded);
    }

    function test_existingImplementationsStillSatisfyTheirInheritedInterfaces() public pure {
        // Implicit conversions (no interface address casts) prove the current inheritance still compiles.
        // Importing the concrete classes also catches any newly unimplemented abstract member.
        address target = address(0xBEEF);
        IBoxReceiverV2 receiver = BoxReceiverV2(payable(target));
        IBoxVaultV2 vault = BoxVaultV2(target);
        IBoxTicketsV2 tickets = BoxTicketsV2(target);
        IBoxFactoryV2 factory = BoxFactoryV2(target);
        IBoxCoordinatorV2 coordinator = BoxCoordinatorV2(payable(target));
        assertEq(address(receiver), target);
        assertEq(address(vault), target);
        assertEq(address(tickets), target);
        assertEq(address(factory), target);
        assertEq(address(coordinator), target);
    }

    function test_existingRoleNumbers() public pure {
        assertEq(R.ROLE_COORDINATOR, 0);
        assertEq(R.ROLE_TOKEN, 1);
        assertEq(R.ROLE_HOOK, 2);
        assertEq(R.ROLE_VAULT, 3);
        assertEq(R.ROLE_COLLECTION, 4);
        assertEq(R.ROLE_RECEIVER, 5);
        assertEq(R.ROLE_LAUNCH_ROUTER, 6);
        assertEq(R.ROLE_TICKETS, 7);
        assertEq(R.ROLE_ROYALTY_ROUTER, 8);
        assertEq(R.ROLE_EXECUTOR, 9);
        assertEq(R.ROLE_ITEM_STREAM, 10);
        assertEq(R.ROLE_SWAP_MODULE, 11);
        assertEq(R.ROLE_METADATA_TABLE, 12);
        assertEq(R.ROLE_SAMPLER, 13);
        assertEq(R.ROLE_LEG_0, 14);
        assertEq(R.ROLE_LEG_1, 15);
        assertEq(R.ROLE_ITEM_LEDGER, 16);
        assertEq(R.ROLE_HOLDER_LEDGER, 17);
        assertEq(R.ROLE_HELD_ITEM_EARNINGS, 18);
        assertEq(R.ROLE_STARTER_SET_LOADER, 19);
        assertEq(R.ROLE_RESERVED_20, 20);
        assertEq(R.ROLE_RESERVED_21, 21);
        assertEq(R.ROLE_RESERVED_22, 22);
        assertEq(R.ROLE_RESERVED_23, 23);
        assertEq(R.ROLE_COUNT, 24);
    }
}
