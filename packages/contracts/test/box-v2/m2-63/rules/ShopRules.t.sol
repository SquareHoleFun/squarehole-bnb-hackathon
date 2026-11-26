// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Retain the dependency oracle unchanged; these owned entries run the reviewed properties at this pin.
import {M244ShopCompatibilityTest} from "../../m2-44/ShopCompatibility.t.sol";
import {BoundariesTest} from "../../m2-32/Boundaries.t.sol";
contract M263M244ShopCompatibilityTest is M244ShopCompatibilityTest {}
contract M263BoundariesTest is BoundariesTest {}
