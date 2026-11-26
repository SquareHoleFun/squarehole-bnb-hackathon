// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SepoliaAllLifeTest} from "test/box-v2/sepolia-all/Life.t.sol";
import {SepoliaDryRunTest} from "test/box-v2/m1-64/TestSetPins.t.sol";

// These wrappers reproduce the actual combined offline scripts. Run with the documented
// --gas-limit 10000000000 aggregate test allowance; individual transaction guards stay intact.
contract Round2SepoliaLifeTest is SepoliaAllLifeTest {}
contract Round2SepoliaDryRunTest is SepoliaDryRunTest {}
