// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {M244FailureTest} from "../m2-44/Failure.t.sol";

contract M262Custody is M244FailureTest {}
