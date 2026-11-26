// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {HolderLedgerTest} from "../m2-30/HolderLedger.t.sol";

contract M262Holder is HolderLedgerTest {}
