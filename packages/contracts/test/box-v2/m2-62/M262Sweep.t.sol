// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {YearSweepTest} from "../r40a/YearSweep.t.sol";

contract M262Sweep is YearSweepTest {}
