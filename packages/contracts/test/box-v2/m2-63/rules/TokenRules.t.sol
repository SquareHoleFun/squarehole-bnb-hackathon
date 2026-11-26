// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Retain the dependency oracle unchanged; these owned entries run the reviewed properties at this pin.
import {LedgerTokenTest} from "../../m2-31/Token.t.sol";
import {LedgerGasTest} from "../../m2-31/Gas.t.sol";
contract M263LedgerTokenTest is LedgerTokenTest {}
contract M263LedgerGasTest is LedgerGasTest {}
