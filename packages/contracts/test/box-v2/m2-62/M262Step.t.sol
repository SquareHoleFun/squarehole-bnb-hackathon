// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {StepMutationTest} from "../m1-62/HookMutation.t.sol";

contract M262Step is StepMutationTest {}
