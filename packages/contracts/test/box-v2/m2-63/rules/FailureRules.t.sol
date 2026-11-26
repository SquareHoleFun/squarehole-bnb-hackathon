// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Retain the dependency oracle unchanged; these owned entries run the reviewed properties at this pin.
import {M244RecoveryTest} from "../../m2-44/Recovery.t.sol";
import {M244MoneyTest} from "../../m2-44/Money.t.sol";
import {YearSweepTest} from "../../r40a/YearSweep.t.sol";
contract M263M244RecoveryTest is M244RecoveryTest {}
contract M263M244MoneyTest is M244MoneyTest {}
contract M263YearSweepTest is YearSweepTest {}
