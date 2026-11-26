// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Factory encodes the hook clone, read by both halves; 211 bytes, no money moved.
library BoxHookV2Args {
    /// @notice A raise or `QParameters` field wider than its 16 bytes.
    error AmountTooLarge(uint256 amount);

    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant Q = 0;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant TOKEN = 20;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant SQRT_P1 = 40;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant SQRT_P0 = 60;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant ROUTER = 80;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant KIND = 100;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant TICK_LOWER = 101;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant TICK_UPPER = 104;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant LIQUIDITY = 107;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant RAISE = 123;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant COORDINATOR = 139;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant RECEIVER = 159;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant TIP_MAX_Q = 179;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant STEP_MIN_Q = 195;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    uint256 internal constant LENGTH = 211;

    /// @notice Optional M2 tail; absent bytes read as zero. Existing M1 encodings and offsets stay unchanged.
    uint256 internal constant HOLDER_LEDGER = LENGTH;

    /// @notice Factory encodes the optional holder ledger only for a holder box; no funds move.
    function withHolderLedger(bytes memory args, address ledger) internal pure returns (bytes memory) {
        return ledger == address(0) ? args : bytes.concat(args, abi.encodePacked(ledger));
    }

    struct Args {
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        address q;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        address token;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint160 sqrtP1;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint160 sqrtP0;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        address launchRouter;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint8 kind;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        int24 tickLower;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        int24 tickUpper;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint128 liquidity;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint256 raise;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        address coordinator;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        address receiver;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint256 tipMaxQ;
    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
        uint256 stepMinQ;
    }

    /// @notice Internal clone encoder/readers only; immutable wiring or raw amount, moves no money.
    function encode(Args memory a) internal pure returns (bytes memory) {
        /// @dev Encoders/readers use head as data; no funds move.
        bytes memory head = abi.encodePacked(a.q, a.token, a.sqrtP1, a.sqrtP0, a.launchRouter);
        /// @dev Encoders/readers use mid as data; no funds move.
        bytes memory mid = abi.encodePacked(a.kind, a.tickLower, a.tickUpper, a.liquidity, _u128(a.raise));
        bytes memory tail =
            abi.encodePacked(a.coordinator, a.receiver, _u128(a.tipMaxQ), _u128(a.stepMinQ));
        return bytes.concat(head, mid, tail);
    }

    /// @dev Anyone may read _u128; no funds move.
    function _u128(uint256 amount) private pure returns (uint128) {
        if (amount > type(uint128).max) revert AmountTooLarge(amount);
        // casting to 'uint128' is safe because the bound was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(amount);
    }
}
