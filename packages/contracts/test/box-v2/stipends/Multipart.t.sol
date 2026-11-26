// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {MultipartPayoutGasTest} from "../payout-gas/Multipart.t.sol";

/// Preserve the existing four-part cold accounting and exact EIP-150 exhaustion boundary tests.
/// Separate compilation unit: its direct PoolManager deployment uses the pinned upstream profile.
contract MultipartPayoutStipendsTest is MultipartPayoutGasTest {}
