// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {HolderAdversarialTest} from "../m2-30/HolderAdversarial.t.sol";

contract M262Adversarial is HolderAdversarialTest {}
