// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @notice CQ11 release pins; internal callers read constants, never move funds.
library ReleaseConstantsV2 {
    /// @notice Internal callers: basis point denominator; no money moves.
    uint256 internal constant BPS = 10_000;
    /// @notice Factory and token proof read the first CREATE nonce; no money moves.
    uint256 internal constant TOKEN_CREATE_NONCE = 1;
    /// @notice Lister/factory read the native raise; no money moves.
    uint256 internal constant RAISE_ETH = BoxBuildV1.RAISE;
    /// @notice Any reader: native ETH row id; no money moves.
    uint32 internal constant NATIVE_LISTING_ID = 0;
    /// @notice Every pool-key builder: fixed 1% LP fee in the input currency; no money moves.
    uint24 internal constant V2_POOL_FEE = 10_000;
    /// @notice Factory and hook: plain callback permissions, without swap return deltas; no money moves.
    uint160 internal constant V2_HOOK_FLAGS = 0x2AE0;
    /// @notice Hook: 1% LP fee in the input currency; read only.
    /// @dev Encoders/readers use FEE_PIPS as data; no funds move.
    uint24 internal constant FEE_PIPS = 10_000;
    /// @notice Hook: flag accompanying the default buy fee; read only.
    /// @dev Legacy override bit for historical encoders; plain hooks never return it.
    uint24 internal constant FEE_OVERRIDE = 0x400000;
    /// @notice Hook/receiver: current-price limit for protocol swaps; read only.
    /// @dev Encoders/readers use STEP_TICKS as data; no funds move.
    int24 internal constant STEP_TICKS = 49;
    /// @notice Hook: P buy fraction before pairing only the T just bought; read only.
    /// @dev Encoders/readers use DEPTH_BUY_SHARE_BPS as data; no funds move.
    uint256 internal constant DEPTH_BUY_SHARE_BPS = 4975;
    /// @notice Protocol callers: maximum 5% of P actually moved; read only.
    /// @dev Encoders/readers use TIP_BPS as data; no funds move.
    uint256 internal constant TIP_BPS = 500;
    /// @notice Complete real-P tip unlock: twice cold first-holder ledger history, including role checks and EIP-150.
    /// @dev Encoders/readers use TIP_GAS as data; no funds move.
    uint256 internal constant TIP_GAS = 2_800_000;
    /// @notice Fail-safe router sweep: twice cold mandatory ledger history and exact PM settlement; pre-check gas.
    /// @dev Encoders/readers use SWEEP_GAS as data; no funds move.
    uint256 internal constant SWEEP_GAS = 1_600_000;
    /// @notice Inbox's two history-writing P transfers: more than twice cold Amsterdam live and failed intake.
    /// @dev Failure and claims reserve this independent allowance, including EIP-150 headroom.
    uint256 internal constant INBOX_SWEEP_GAS = 3_200_000;
    /// @notice Gas a claim or failure keeps for the rest of its call after the inbox spends its whole allowance.
    /// @dev Admission reserve, separate from the sweep stipend; RC7 pins at least 10% post-sweep headroom.
    uint256 internal constant INBOX_SWEEP_RESERVE_GAS = 4_000_000;
    /// @notice Failed claims only: bounded receiver collect/preview; no token, module or holder-ledger call.
    /// @dev RC6-CC cold collection tests pin headroom on Cancun and Amsterdam.
    uint256 internal constant FAILED_COLLECT_GAS = 400_000;
    /// @notice Hook T redemption and burn: twice cold transfer/burn history with nonzero eligible supply and EIP-150.
    /// @dev Encoders/readers use BURN_GAS as data; no funds move.
    uint256 internal constant BURN_GAS = 2_500_000;
    /// @notice Hook-only fail-safe notice: exceeds twice M2-60's 642349-gas cold Amsterdam bound (1024 history points).
    uint256 internal constant HOLDER_NOTICE_GAS = 1_400_000;
    /// @notice Hook retains gas for fee checkpointing, PoolManager unwind and router token settlement after a notice.
    /// @dev M2-60 checks fresh wallet history and fee checkpointing at the notice's one-gas activation boundary.
    uint256 internal constant HOLDER_NOTICE_RESERVE_GAS = 1_200_000;
    /// @notice Ledger-token fail-safe hint: exceeds twice M2-60's 49308-gas cold bound on both EVMs.
    uint256 internal constant TOKEN_SETTLEMENT_GAS = 600_000;
    /// @notice Provisional M1-60 margin in stipend + stipend/63 pre-check; read only.
    /// @dev Encoders/readers use POKE_OVERHEAD_GAS as data; no funds move.
    uint256 internal constant POKE_OVERHEAD_GAS = 20_000;
    /// @notice Anyone may fail a filled, ungraduated box after this time since fill (F122).
    /// @dev Encoders/readers use GRADUATION_ESCAPE_DELAY as data; no funds move.
    uint256 internal constant GRADUATION_ESCAPE_DELAY = 7 days;
    /// @notice Lister admission bound leaves room to mine T above P; no money moves.
    uint160 internal constant LISTED_TOKEN_CEILING = type(uint160).max - (type(uint160).max >> 16);
    /// @notice Internal accounting sentinel excluded from spendable views; no money moves.
    uint256 internal constant LEDGER_KEEP = 1;
    /// @notice Receiver: FIT share numerator in fifteenths; read only.
    /// @dev Encoders/readers use FEE_SHARE_FIT_V2 as data; no funds move.
    uint256 internal constant FEE_SHARE_FIT_V2 = 2;
    /// @notice Receiver: platform share numerator in fifteenths; read only.
    /// @dev Encoders/readers use FEE_SHARE_PLATFORM_V2 as data; no funds move.
    uint256 internal constant FEE_SHARE_PLATFORM_V2 = 1;
}
