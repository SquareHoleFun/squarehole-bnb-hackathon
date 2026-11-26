// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxShuffle
/// @notice The keyed permutation that gives every placeholder its Misfit number, and the index of a draw's pick (F36 a;
/// docs/design/draw-and-reveal.md § 4; plan D5). Internal and pure: nothing is stored.
///
/// - **π_w on [0, N):** an 8-round Feistel network over b = max(2, ⌈log₂ N⌉) bits, split into u = ⌊b/2⌋ high bits (A)
///   and v = b − u low bits (B), with alternating round widths so an odd b works (the binary form of NIST SP 800-38G's
///   FF1 structure). Round i: C = (A ⊕ F(i, B)) mod 2^|A|, then (A, B) ← (B, C); after the eighth round the widths are
///   back to (u, v) and the output is A·2^v + B. F(i, B) = keccak256(w ‖ (i·2^128 + B)) as two 32-byte words: every
///   round is keyed by the word and its own index. The network permutes [0, 2^b); cycle-walking (apply it again while
///   the result is ≥ N) restricts it to a permutation of [0, N), and the inverse walks the inverse network the same
///   way. Placeholder j gets Misfit `firstId + π_w(j)`; the draw pool is the positions [q, N) of the same permutation.
/// - **pickIndex:** keccak256(word ‖ ticketId) mod R, the lazy Fisher–Yates index of a draw (R ≤ 2^32, so the modulo
///   bias is below 2^−224).
///
/// The TypeScript mirror (`packages/chain/src/placeholder-shuffle.ts`) computes the same values; the two share the
/// vectors in `test/vectors/placeholder-shuffle.json`.
/// @dev A verbatim copy of v2's PlaceholderShuffle (src/v2/libraries/PlaceholderShuffle.sol:4-167 at 46a030f6) under the
/// box core's name (BoxTickets uses it); `test/box/items/BoxLibraries.t.sol` runs the shared vectors and compares it
/// with the original. Written for Square Hole (MIT, no third-party code).
library BoxShuffle {
    /// @notice Feistel rounds. The domain is at most 2^64 values, so eight rounds cost about 1,000 gas a pass.
    uint256 internal constant ROUNDS = 8;

    error EmptyDomain();

    /// @notice b = max(2, ⌈log₂ n⌉) split into u = ⌊b/2⌋ high bits and v = b − u low bits.
    function halves(uint256 n) internal pure returns (uint256 u, uint256 v) {
        if (n == 0) revert EmptyDomain();
        uint256 b = 2;
        while ((uint256(1) << b) < n) {
            ++b;
        }
        u = b / 2;
        v = b - u;
    }

    /// @notice π_key(x) for x < n (with `u`, `v` from `halves(n)`).
    function permute(bytes32 key, uint256 x, uint256 n, uint256 u, uint256 v) internal pure returns (uint256 y) {
        y = _forward(key, x, u, v);
        while (y >= n) {
            y = _forward(key, y, u, v);
        }
    }

    /// @notice π_key⁻¹(y) for y < n.
    function invert(bytes32 key, uint256 y, uint256 n, uint256 u, uint256 v) internal pure returns (uint256 x) {
        x = _backward(key, y, u, v);
        while (x >= n) {
            x = _backward(key, x, u, v);
        }
    }

    /// @notice How many Feistel passes π_key(x) takes (1 when no cycle-walk is needed). Tests and gas estimates only.
    function passes(bytes32 key, uint256 x, uint256 n, uint256 u, uint256 v) internal pure returns (uint256 count) {
        uint256 y = _forward(key, x, u, v);
        count = 1;
        while (y >= n) {
            y = _forward(key, y, u, v);
            ++count;
        }
    }

    /// @notice keccak256(word ‖ ticketId) mod remaining: the index a draw picks among the `remaining` positions.
    function pickIndex(bytes32 word, uint256 ticketId, uint256 remaining) internal pure returns (uint256 index) {
        uint256 h;
        assembly ("memory-safe") {
            mstore(0x00, word)
            mstore(0x20, ticketId)
            h := keccak256(0x00, 0x40)
        }
        index = h % remaining;
    }

    /// @dev One pass of the network. Before round i, A is u bits wide on even rounds and v bits on odd ones; round i
    /// sets C = (A ⊕ F(i, B)) masked to A's width, then (A, B) ← (B, C). F(i, B) = keccak256(key ‖ (i·2^128 + B)),
    /// hashed in the scratch space (0x00–0x3f). u, v ≤ 32 for every N the callers allow, so nothing overflows.
    /// The eight rounds are unrolled (ROUNDS = 8): no loop counter, and each round's mask is fixed.
    function _forward(bytes32 key, uint256 x, uint256 u, uint256 v) private pure returns (uint256 y) {
        assembly ("memory-safe") {
            let mu := sub(shl(u, 1), 1)
            let mv := sub(shl(v, 1), 1)
            let a := shr(v, x)
            let b := and(x, mv)
            let c := 0
            mstore(0x00, key)
            mstore(0x20, b) // round 0: A is u bits
            c := and(xor(a, keccak256(0x00, 0x40)), mu)
            a := b
            b := c
            mstore(0x20, or(shl(128, 1), b)) // round 1: v bits
            c := and(xor(a, keccak256(0x00, 0x40)), mv)
            a := b
            b := c
            mstore(0x20, or(shl(128, 2), b))
            c := and(xor(a, keccak256(0x00, 0x40)), mu)
            a := b
            b := c
            mstore(0x20, or(shl(128, 3), b))
            c := and(xor(a, keccak256(0x00, 0x40)), mv)
            a := b
            b := c
            mstore(0x20, or(shl(128, 4), b))
            c := and(xor(a, keccak256(0x00, 0x40)), mu)
            a := b
            b := c
            mstore(0x20, or(shl(128, 5), b))
            c := and(xor(a, keccak256(0x00, 0x40)), mv)
            a := b
            b := c
            mstore(0x20, or(shl(128, 6), b))
            c := and(xor(a, keccak256(0x00, 0x40)), mu)
            a := b
            b := c
            mstore(0x20, or(shl(128, 7), b))
            c := and(xor(a, keccak256(0x00, 0x40)), mv)
            a := b
            b := c
            y := or(shl(v, a), b)
        }
    }

    /// @dev The inverse pass: rounds 7 … 0, each undone as A = C ⊕ F(i, B) with B = the current A.
    function _backward(bytes32 key, uint256 y, uint256 u, uint256 v) private pure returns (uint256 x) {
        assembly ("memory-safe") {
            let mu := sub(shl(u, 1), 1)
            let mv := sub(shl(v, 1), 1)
            let a := shr(v, y)
            let b := and(y, mv)
            let p := 0
            mstore(0x00, key)
            mstore(0x20, or(shl(128, 7), a)) // round 7: A was v bits
            p := and(xor(b, keccak256(0x00, 0x40)), mv)
            b := a
            a := p
            mstore(0x20, or(shl(128, 6), a)) // round 6: u bits
            p := and(xor(b, keccak256(0x00, 0x40)), mu)
            b := a
            a := p
            mstore(0x20, or(shl(128, 5), a))
            p := and(xor(b, keccak256(0x00, 0x40)), mv)
            b := a
            a := p
            mstore(0x20, or(shl(128, 4), a))
            p := and(xor(b, keccak256(0x00, 0x40)), mu)
            b := a
            a := p
            mstore(0x20, or(shl(128, 3), a))
            p := and(xor(b, keccak256(0x00, 0x40)), mv)
            b := a
            a := p
            mstore(0x20, or(shl(128, 2), a))
            p := and(xor(b, keccak256(0x00, 0x40)), mu)
            b := a
            a := p
            mstore(0x20, or(shl(128, 1), a))
            p := and(xor(b, keccak256(0x00, 0x40)), mv)
            b := a
            a := p
            mstore(0x20, a)
            p := and(xor(b, keccak256(0x00, 0x40)), mu)
            b := a
            a := p
            x := or(shl(v, a), b)
        }
    }
}
