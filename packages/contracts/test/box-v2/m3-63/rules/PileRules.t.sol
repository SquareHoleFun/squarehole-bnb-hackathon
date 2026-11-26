// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PileVaultTest} from "../../m3-30/PileVault.t.sol";
import {PileIntegrationTest} from "../../m3-30/Integration.t.sol";

// Real pile tests pin caller-only pulls, once-only initialization/loading, seed-only custody,
// exact native/ERC20 transport, gate rollback, zero seed, paused/reentrant asset and immutable seed return.
contract RulesPileTest is PileVaultTest {}
contract RulesPileGateTest is PileIntegrationTest {}
