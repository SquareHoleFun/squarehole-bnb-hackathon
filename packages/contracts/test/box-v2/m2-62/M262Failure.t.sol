// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {FailureMutationTest} from "../m1-62/MoneyMutation.t.sol";

contract M262Failure is FailureMutationTest {}
