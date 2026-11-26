// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreV2LocalTest} from "script/local/CoreV2Local.t.sol";

/// Runs the actual local scripts' creation/life actions on both EVMs without a listener or broadcast.
contract Round2LocalTest is CoreV2LocalTest {}
