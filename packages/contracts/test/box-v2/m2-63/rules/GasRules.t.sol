// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M260BoundariesTest} from "../../gas/m2/Boundaries.t.sol";
import {M260ShopTest} from "../../gas/m2/Shop.t.sol";

// Pin continuation for production and proposed caps, using the maintained M2-60 fault/cap doubles.
contract M263GasBoundariesTest is M260BoundariesTest {}
contract M263GasShopTest is M260ShopTest {}
