// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M263AllocationTest} from "../../m2-63/money/Allocation.t.sol";
import {M263SourceDustTest} from "../../m2-63/money/Allocation.t.sol";
import {HolderClaimOnlyTest} from "../../m2-30/ClaimOnly.t.sol";
import {HolderLedgerTest} from "../../m2-30/HolderLedger.t.sol";
import {HolderAdversarialTest} from "../../m2-30/HolderAdversarial.t.sol";
import {HolderReceiverTest} from "../../m2-30/HolderReceiver.t.sol";
import {LedgerTokenTest} from "../../m2-31/Token.t.sol";
import {LedgerTradeTest} from "../../m2-31/Trade.t.sol";
import {BoundariesTest} from "../../m2-32/Boundaries.t.sol";
import {M244ShopCompatibilityTest} from "../../m2-44/ShopCompatibility.t.sol";
import {StarterTest} from "../../m2-33/Starter.t.sol";
import {ShopAdmissionTest} from "../../m2-63-fix-shop/Admission.t.sol";

// Final-review entry points preserve the existing assertions and their fixture boundaries.
// These are regression checks, not newly designed tests or proof beyond their tested cases.
// R44A's pending Safe-trigger negative tests are intentionally not selected.
contract FinalMoneyHolderRoundingProperties is M263AllocationTest {}

contract FinalMoneySourceIsolationProperties is M263SourceDustTest {}

contract FinalMoneyHolderOwnerOnlyProperties is HolderClaimOnlyTest {}

contract FinalMoneyHolderSettlementProperties is HolderLedgerTest {}

contract FinalMoneyHolderHostilityProperties is HolderAdversarialTest {}

contract FinalMoneyHolderFundingProperties is HolderReceiverTest {}

contract FinalMoneyTokenHistoryProperties is LedgerTokenTest {}

contract FinalMoneyTradeNoticeProperties is LedgerTradeTest {}

contract FinalMoneyShopBoundsProperties is BoundariesTest {}

contract FinalMoneyShopMoneyProperties is M244ShopCompatibilityTest {}

contract FinalMoneyStarterCustodyProperties is StarterTest {}

contract FinalMoneyShopAdmissionClosureProperties is ShopAdmissionTest {}
