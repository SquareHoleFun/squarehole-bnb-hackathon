// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StipendEnvelopesTest} from "test/box-v2/stipends/Envelopes.t.sol";
import {PokeStipendsTest} from "test/box-v2/stipends/Pokes.t.sol";

/// @notice Reuse FINAL2-GAS's real-entry conservation, full-exhaustion and retry assertions unchanged.
/// @dev These are the contract premises for the keeper's 15M failure (five optional calls since RC6-RR-INBOX's
///      inbox sweep; the five-sink failure test now submits up to the transaction cap), 8M, 3M and 1.5M floors,
///      not additional independent implementations or aggregate transaction gas measurements.
contract KeeperMeasuredEnvelopesTest is StipendEnvelopesTest {}
contract KeeperGraduationPokesTest is PokeStipendsTest {}
