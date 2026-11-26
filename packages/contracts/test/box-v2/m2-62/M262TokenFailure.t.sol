// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {LedgerFailureTest} from "../m2-31/Failure.t.sol";

contract M262TokenFailure is LedgerFailureTest {}
