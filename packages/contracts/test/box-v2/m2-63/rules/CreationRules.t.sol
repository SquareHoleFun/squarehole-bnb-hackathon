// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Retain the dependency oracle unchanged; these owned entries run the reviewed properties at this pin.
import {M234CreationTest} from "../../m2-34/Creation.t.sol";
import {M234BoundariesTest} from "../../m2-34/Boundaries.t.sol";
contract M263M234CreationTest is M234CreationTest {}
contract M263M234BoundariesTest is M234BoundariesTest {}
