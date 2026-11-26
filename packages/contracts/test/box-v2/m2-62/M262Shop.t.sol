// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {M244ShopCompatibilityTest} from "../m2-44/ShopCompatibility.t.sol";

contract M262Shop is M244ShopCompatibilityTest {}
