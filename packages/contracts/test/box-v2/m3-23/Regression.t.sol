// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverMoneyTest} from "../cq11-b/ReceiverMoney.t.sol";
import {
    M230BuyBackCompatibilityTest, M230FailureCompatibilityTest, M230RoyaltyCompatibilityTest,
    M230PayoutCompatibilityTest, M230FundingSeamCompatibilityTest
} from "../m2-30/ReceiverCompatibility.t.sol";
import {ReceiverFundingTest} from "../m2-30/ReceiverFunding.t.sol";
import {HolderReceiverTest} from "../m2-30/HolderReceiver.t.sol";
import {FableReceiverTest} from "../fable-fixes/Receiver.t.sol";
import {ReceiverInitializationTest} from "../fable-fixes/ReceiverInitialization.t.sol";
import {ReceiverMovedResultsTest} from "../size-recover-b/MovedResults.t.sol";
import {ReceiverViewsWiringTest} from "../size-recover-b/Wiring.t.sol";
import {ReceiverConfigResultsTest} from "../size-recover-b/ConfigResults.t.sol";
import {ReceiverSizeRecoveryTest} from "../size-recover-b/SizeRecovery.t.sol";

// Execute inherited assertions unchanged through this owned suite, including the real buy-back exit.
contract M323MoneyRegression is ReceiverMoneyTest {}
contract M323BuyBackRegression is M230BuyBackCompatibilityTest {}
contract M323FailureRegression is M230FailureCompatibilityTest {}
contract M323RoyaltyRegression is M230RoyaltyCompatibilityTest {}
contract M323PayoutRegression is M230PayoutCompatibilityTest {}
contract M323FundingRegression is M230FundingSeamCompatibilityTest {}
contract M323SourceRegression is ReceiverFundingTest {}
contract M323HolderRegression is HolderReceiverTest {}
contract M323BookingRegression is FableReceiverTest {}
contract M323InitRegression is ReceiverInitializationTest {}
contract M323MovedRegression is ReceiverMovedResultsTest {}
contract M323WiringRegression is ReceiverViewsWiringTest {}
contract M323ConfigRegression is ReceiverConfigResultsTest {}
contract M323SizeRegression is ReceiverSizeRecoveryTest {}
