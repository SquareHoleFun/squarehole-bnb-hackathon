// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Maintained dependency properties, re-executed through owned final-review entry points.
/// Unit-test doubles retain their original scope; production creation is checked separately.
import {CQ11WOperationsTest} from "../../gas/CQ11WOperations.t.sol";
import {M260ShopTest} from "../../gas/m2/Shop.t.sol";
import {M260BoundariesTest} from "../../gas/m2/Boundaries.t.sol";
import {M260EntryLimitsTest} from "../../gas/m2/EntryLimits.t.sol";
import {M360LifecycleTest} from "../../gas/m3/Lifecycle.t.sol";
import {M360BoundariesTest} from "../../gas/m3/Boundaries.t.sol";
import {M360ClaimsTest} from "../../gas/m3/Claims.t.sol";
import {M360PlainCreationTest} from "../../gas/m3/PlainCreation.t.sol";

contract FinalCQ11WOperationsTest is CQ11WOperationsTest {}

contract FinalM260ShopTest is M260ShopTest {}

contract FinalM260BoundariesTest is M260BoundariesTest {}

contract FinalM260EntryLimitsTest is M260EntryLimitsTest {}

contract FinalM360LifecycleTest is M360LifecycleTest {}

contract FinalM360BoundariesTest is M360BoundariesTest {}

contract FinalM360ClaimsTest is M360ClaimsTest {}

contract FinalM360PlainCreationTest is M360PlainCreationTest {}
