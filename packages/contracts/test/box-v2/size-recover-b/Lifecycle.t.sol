// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverMoneyTest} from "../cq11-b/ReceiverMoney.t.sol";
import {
    M230BuyBackCompatibilityTest,
    M230FailureCompatibilityTest,
    M230RoyaltyCompatibilityTest,
    M230PayoutCompatibilityTest,
    M230FundingSeamCompatibilityTest
} from "../m2-30/ReceiverCompatibility.t.sol";
import {ReceiverFundingTest} from "../m2-30/ReceiverFunding.t.sol";
import {HolderReceiverTest} from "../m2-30/HolderReceiver.t.sol";
import {HolderLedgerTest} from "../m2-30/HolderLedger.t.sol";
import {HolderAdversarialTest} from "../m2-30/HolderAdversarial.t.sol";
import {FableReceiverTest} from "../fable-fixes/Receiver.t.sol";
import {ReceiverInitializationTest} from "../fable-fixes/ReceiverInitialization.t.sol";

// SIZE-B4: execute unchanged money, failure, authorization and M2 model assertions against the refactor.
contract SizeBReceiverMoneyTest is ReceiverMoneyTest {}

contract SizeBM230BuyBackCompatibilityTest is M230BuyBackCompatibilityTest {}

contract SizeBM230FailureCompatibilityTest is M230FailureCompatibilityTest {}

contract SizeBM230RoyaltyCompatibilityTest is M230RoyaltyCompatibilityTest {}

contract SizeBM230PayoutCompatibilityTest is M230PayoutCompatibilityTest {}

contract SizeBM230FundingSeamCompatibilityTest is M230FundingSeamCompatibilityTest {}

contract SizeBReceiverFundingTest is ReceiverFundingTest {}

contract SizeBHolderReceiverTest is HolderReceiverTest {}

contract SizeBHolderLedgerTest is HolderLedgerTest {}

contract SizeBHolderAdversarialTest is HolderAdversarialTest {}

contract SizeBFableReceiverTest is FableReceiverTest {}

contract SizeBReceiverInitializationTest is ReceiverInitializationTest {}
