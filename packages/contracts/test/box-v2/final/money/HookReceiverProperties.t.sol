// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11AHookTest} from "../../cq11-a/Hook.t.sol";
import {CQ11AProtocolTest} from "../../cq11-a/Protocol.t.sol";
import {CQ11AClosedInventoryTest} from "../../cq11-a/ClosedInventory.t.sol";
import {CQ11ALargeRaiseTest} from "../../cq11-a/LargeRaise.t.sol";
import {CQ11AStipendTest} from "../../cq11-a/Stipend.t.sol";
import {ReceiverMoneyTest} from "../../cq11-b/ReceiverMoney.t.sol";
import {ReceiverPayoutsTest} from "../../cq11-b/ReceiverPayouts.t.sol";
import {ReceiverRoyaltyTest} from "../../cq11-b/ReceiverRoyalty.t.sol";
import {ReceiverBuyBackTest} from "../../cq11-b/ReceiverBuyBack.t.sol";
import {ReceiverFailureTest} from "../../cq11-b/ReceiverFailure.t.sol";

// Final-review entry points preserve the existing assertions and their fixture boundaries.
// These are regression checks, not newly designed tests or proof beyond their tested cases.
// R44A's pending Safe-trigger negative tests are intentionally not selected.
contract FinalMoneyHookMatrixProperties is CQ11AHookTest {}

contract FinalMoneyProtocolStepsProperties is CQ11AProtocolTest {}

contract FinalMoneyClosedInventoryProperties is CQ11AClosedInventoryTest {}

contract FinalMoneyLargeRaisesProperties is CQ11ALargeRaiseTest {}

contract FinalMoneyHookStipendsProperties is CQ11AStipendTest {}

contract FinalMoneyReceiverAccountingProperties is ReceiverMoneyTest {}

contract FinalMoneyReceiverExitsProperties is ReceiverPayoutsTest {}

contract FinalMoneyRoyaltyIsolationProperties is ReceiverRoyaltyTest {}

contract FinalMoneyBuyBackProperties is ReceiverBuyBackTest {}

contract FinalMoneyFailureMenuProperties is ReceiverFailureTest {}

