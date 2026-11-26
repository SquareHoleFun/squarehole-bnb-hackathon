// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M360LifecycleTest} from "../../gas/m3/Lifecycle.t.sol";
import {M360BoundariesTest} from "../../gas/m3/Boundaries.t.sol";

// Real M3 custody/callback paths with M340Base's explicit source/checker doubles.
// Check both cold half-cap success and continuation after a full-cap hostile callback.
contract RulesNoticeHeadroomTest is M360LifecycleTest {}
contract RulesNoticeActivationTest is M360BoundariesTest {}
