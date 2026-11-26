// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Maintained dependency properties, re-executed through owned final-review entry points.
/// Unit-test doubles retain their original scope; production creation is checked separately.
import {M263AccessTest} from "../../m2-63/rules/Access.t.sol";
import {LedgerTokenTest} from "../../m2-31/Token.t.sol";
import {HolderLedgerTest} from "../../m2-30/HolderLedger.t.sol";
import {HolderAdversarialTest} from "../../m2-30/HolderAdversarial.t.sol";
import {StarterTest} from "../../m2-33/Starter.t.sol";
import {StarterGateCompatibilityTest} from "../../m2-33/Bounds.t.sol";
import {BoundariesTest} from "../../m2-32/Boundaries.t.sol";
import {M244ShopCompatibilityTest} from "../../m2-44/ShopCompatibility.t.sol";
import {M244RecoveryTest} from "../../m2-44/Recovery.t.sol";
import {M244MoneyTest} from "../../m2-44/Money.t.sol";

contract FinalM263AccessTest is M263AccessTest {}

contract FinalLedgerTokenTest is LedgerTokenTest {}

contract FinalHolderLedgerTest is HolderLedgerTest {}

contract FinalHolderAdversarialTest is HolderAdversarialTest {}

contract FinalStarterTest is StarterTest {}

contract FinalStarterGateCompatibilityTest is StarterGateCompatibilityTest {}

contract FinalBoundariesTest is BoundariesTest {}

contract FinalM244ShopCompatibilityTest is M244ShopCompatibilityTest {}

contract FinalM244RecoveryTest is M244RecoveryTest {}

contract FinalM244MoneyTest is M244MoneyTest {}

import {M263LifecycleTest} from "../../m2-63/rules/Lifecycle.t.sol";

contract FinalM263LifecycleTest is M263LifecycleTest {}
