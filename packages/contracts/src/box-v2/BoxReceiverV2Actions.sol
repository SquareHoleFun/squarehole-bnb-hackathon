// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Internal callback vocabulary shared by the receiver and its fixed code part; no storage.
abstract contract BoxReceiverV2Actions {
    uint256 internal constant BUY_ITEMS_REWARDS = 11;
    uint256 internal constant MOVE_PILE = 10;
    uint256 internal constant EAT_PRICE = 7;
    uint256 internal constant BUY_REWARDS = 8;
    uint256 internal constant BURN_CLAIMS = 9;
    uint256 internal constant MAX_PAYOUT_PART = uint256(uint128(type(int128).max));
    uint256 internal constant PAY = 1;
    uint256 internal constant FUND = 2;
    uint256 internal constant RESERVED_FORWARD = 3;
    uint256 internal constant BURN = 4;
    uint256 internal constant BUY = 5;
    uint256 internal constant TIP = 6;
}
