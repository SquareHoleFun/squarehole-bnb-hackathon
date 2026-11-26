// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverBuyBackTest} from "../cq11-b/ReceiverBuyBack.t.sol";
import {ReceiverFailureTest} from "../cq11-b/ReceiverFailure.t.sol";
import {ReceiverRoyaltyTest} from "../cq11-b/ReceiverRoyalty.t.sol";
import {ReceiverPayoutsTest} from "../cq11-b/ReceiverPayouts.t.sol";
import {ReceiverBatchTest} from "../m2-seam/ReceiverBatch.t.sol";

// The changed receiver shares split/booking code with M1. Preserve these existing money-path checks locally.
contract M230BuyBackCompatibilityTest is ReceiverBuyBackTest {}
contract M230FailureCompatibilityTest is ReceiverFailureTest {}
contract M230RoyaltyCompatibilityTest is ReceiverRoyaltyTest {}
contract M230PayoutCompatibilityTest is ReceiverPayoutsTest {}
contract M230FundingSeamCompatibilityTest is ReceiverBatchTest {}
