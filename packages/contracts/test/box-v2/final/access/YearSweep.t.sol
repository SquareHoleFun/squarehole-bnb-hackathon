// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {YearSweepTest} from "../../r40a/YearSweep.t.sol";
/// @dev Final access gate runs RC5's no-expiry, blocked-payout and foreign-unlock regressions.
contract FinalPermanentClaimsTest is YearSweepTest {}
