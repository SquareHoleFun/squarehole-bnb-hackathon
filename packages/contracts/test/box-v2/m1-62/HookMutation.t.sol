// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11AHookTest} from "../cq11-a/Hook.t.sol";
import {CQ11AProtocolTest} from "../cq11-a/Protocol.t.sol";

/// CQ11-F / M1-62b: run the merged callback matrix against production hook mutations.
/// Includes every phase, caller and swap kind, partial fills and the zero stored LP fee.
contract HookMutationTest is CQ11AHookTest {}

/// Public buy-back/deepen calls, both step orderings, rollback and ordinary buy fees.
contract StepMutationTest is CQ11AProtocolTest {}
