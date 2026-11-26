// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";

/// @title SpikeItemStream
/// @notice SPIKE ONLY (S0 item 3, the prototype run of BC-065; docs/evidence/SH-S0-spikes.md; never deployed). The
/// STATEFUL per-item stream (the PER_ITEM_STREAM add-on; ADR-0014 G07): `checkpoint()` reads the T-side fee growth
/// inside the protocol's ranges (read only, one batched `extsload`), books what they earned since the last checkpoint
/// to a per-slot index (Q128, all N slots) and the inside share to the burn. Called after EVERY swap it is G07's
/// per-swap index (the test's reference); called only at transfers and vault actions it is the checkpoint design.
/// Every global slot is set non-zero at creation, so only an item's first snapshot and an owner's first accrual are
/// written from zero.
contract SpikeItemStream {
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant TICKS_OFFSET = 4;
    uint256 internal constant FEE_GROWTH_GLOBAL1_OFFSET = 2;

    IPoolManager public immutable pm;
    bytes32 public immutable stateSlot;
    uint256 public immutable n;
    // The protocol's ranges (today's layout b′ as a fixture: bid, sentinel, ask) and their fixed liquidity.
    int24 internal immutable lower0;
    int24 internal immutable upper0;
    int24 internal immutable lower1;
    int24 internal immutable upper1;
    int24 internal immutable lower2;
    int24 internal immutable upper2;
    uint128 internal immutable liquidity0;
    uint128 internal immutable liquidity1;
    uint128 internal immutable liquidity2;

    /// @notice Cumulative T fee per slot, Q128, offset by 1 so it is never zero.
    uint256 public index = 1;
    /// @dev Last T-side fee growth inside each range, offset by 1 (never zero).
    uint256[3] internal _last;
    /// @notice Items outside the vault (m), offset by 1 (never zero).
    uint256 public outside = 1;
    /// @notice The inside share, owed to the burn (offset by 1).
    uint256 public burnOwed = 1;
    /// @notice Per item: the index at its last owner change (0: inside, never booked).
    mapping(uint256 => uint256) public snap;
    /// @notice Per owner: T booked at its sales and returns, not yet claimed.
    mapping(address => uint256) public owed;

    struct Range {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    constructor(IPoolManager pm_, bytes32 stateSlot_, uint256 n_, Range[3] memory r) {
        (pm, stateSlot, n) = (pm_, stateSlot_, n_);
        (lower0, upper0, liquidity0) = (r[0].lower, r[0].upper, r[0].liquidity);
        (lower1, upper1, liquidity1) = (r[1].lower, r[1].upper, r[1].liquidity);
        (lower2, upper2, liquidity2) = (r[2].lower, r[2].upper, r[2].liquidity);
        uint256[3] memory g = _growthInside();
        for (uint256 i; i < 3; ++i) {
            _last[i] = g[i] + 1;
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // The observer points (called with capped gas by the collection and the vault)

    /// @notice The collection's `transferObserver` (between outside owners).
    function onTransfer(address from, address, uint256 id) external {
        checkpoint();
        uint256 s = snap[id];
        uint256 i = index;
        owed[from] += (i - s) / Q128;
        snap[id] = i;
    }

    /// @notice The vault's observer: an item leaves the vault to `owner` (draw, pick, placeholder opened).
    function onExit(address, uint256 id) external {
        checkpoint();
        snap[id] = index;
        ++outside;
    }

    /// @notice The vault's observer: an item comes back from `owner` (return).
    function onReturn(address owner, uint256 id) external {
        checkpoint();
        owed[owner] += (index - snap[id]) / Q128;
        snap[id] = 0;
        --outside;
    }

    /// @notice Books what the ranges earned since the last checkpoint (anyone; the reference calls it after every swap).
    function checkpoint() public {
        uint256[3] memory g = _growthInside();
        uint128[3] memory l = [liquidity0, liquidity1, liquidity2];
        uint256 earned;
        for (uint256 k; k < 3; ++k) {
            uint256 last = _last[k] - 1;
            if (g[k] == last) continue;
            unchecked {
                earned += FullMath.mulDiv(g[k] - last, l[k], Q128);
            }
            _last[k] = g[k] + 1;
        }
        if (earned == 0) return;
        index += FullMath.mulDiv(earned, Q128, n);
        burnOwed += FullMath.mulDiv(earned, n - (outside - 1), n);
    }

    /// @notice What item `id`'s current owner would be booked if it were settled now, in T.
    function pendingOf(uint256 id) external view returns (uint256) {
        uint256 s = snap[id];
        return s == 0 ? 0 : (index - s) / Q128;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Read-only pool reads: slot0, the global T growth and the four boundary ticks' outside T growth, one extsload

    function _growthInside() internal view returns (uint256[3] memory g) {
        int24[4] memory t = [lower0, upper0, upper1, lower2]; // P1, P0, max usable, min usable for layout b′
        bytes32[] memory slots = new bytes32[](6);
        slots[0] = stateSlot;
        slots[1] = bytes32(uint256(stateSlot) + FEE_GROWTH_GLOBAL1_OFFSET);
        bytes32 ticksSlot = bytes32(uint256(stateSlot) + TICKS_OFFSET);
        for (uint256 i; i < 4; ++i) {
            slots[2 + i] = bytes32(uint256(keccak256(abi.encodePacked(int256(t[i]), ticksSlot))) + 2);
        }
        bytes32[] memory v = pm.extsload(slots);
        int24 tick = Slot0.wrap(v[0]).tick();
        uint256 global = uint256(v[1]);
        g[0] = _inside(tick, global, lower0, upper0, uint256(v[2]), uint256(v[3]));
        g[1] = _inside(tick, global, lower1, upper1, uint256(v[3]), uint256(v[4]));
        g[2] = _inside(tick, global, lower2, upper2, uint256(v[5]), uint256(v[2]));
    }

    /// @dev Pool.getFeeGrowthInside for one currency.
    function _inside(int24 tick, uint256 global, int24 lower, int24 upper, uint256 outLower, uint256 outUpper)
        internal
        pure
        returns (uint256)
    {
        unchecked {
            if (tick < lower) return outLower - outUpper;
            if (tick >= upper) return outUpper - outLower;
            return global - outLower - outUpper;
        }
    }
}

/// @title SpikeItemStreamLean
/// @notice SPIKE ONLY (S0 item 3): the checkpoint design with NO global write at a transfer. The per-slot index is a
/// pure function of the pool: (fee growth inside each protocol range since the stream's creation × its fixed
/// liquidity, summed) × 2^64 / N, read with one batched `extsload`; nothing is booked per swap or per checkpoint. A
/// transfer writes the seller's accrual and the item's snapshot; a vault action writes the item's snapshot and one
/// packed word (outside count, the index at the last change of that count) plus the owners' booked total, from which
/// the burn share follows (earned − owners' share). Fixed liquidity holds for a closed pool (D3) after graduation.
contract SpikeItemStreamLean {
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant SCALE = 1 << 64;
    uint256 internal constant TICKS_OFFSET = 4;
    uint256 internal constant FEE_GROWTH_GLOBAL1_OFFSET = 2;
    uint256 internal constant MASK32 = (1 << 32) - 1;

    IPoolManager public immutable pm;
    bytes32 public immutable stateSlot;
    uint256 public immutable n;
    int24 internal immutable lower0;
    int24 internal immutable upper0;
    int24 internal immutable upper1;
    int24 internal immutable lower2;
    uint128 internal immutable liquidity0;
    uint128 internal immutable liquidity1;
    uint128 internal immutable liquidity2;
    uint256 internal immutable base0;
    uint256 internal immutable base1;
    uint256 internal immutable base2;

    /// @notice Per item: 1 + the index at its last owner change (0: inside).
    mapping(uint256 => uint256) public snap;
    /// @notice Per owner: T booked at its sales and returns.
    mapping(address => uint256) public owed;
    /// @dev Outside count (low 32 bits) and the index when it last changed (above), plus a marker bit: never zero.
    uint256 internal _book = 1 << 255;
    /// @notice The owners' share booked at outside-count changes, offset by 1.
    uint256 public ownersShareBooked = 1;

    constructor(IPoolManager pm_, bytes32 stateSlot_, uint256 n_, SpikeItemStream.Range[3] memory r) {
        (pm, stateSlot, n) = (pm_, stateSlot_, n_);
        (lower0, upper0, liquidity0) = (r[0].lower, r[0].upper, r[0].liquidity);
        (upper1, liquidity1) = (r[1].upper, r[1].liquidity);
        (lower2, liquidity2) = (r[2].lower, r[2].liquidity);
        (uint256 g0, uint256 g1, uint256 g2) = _growthInside();
        (base0, base1, base2) = (g0, g1, g2);
    }

    /// @notice T earned by the protocol's ranges since creation (what `collect` will have collected, up to rounding).
    function earned() public view returns (uint256 e) {
        (uint256 g0, uint256 g1, uint256 g2) = _growthInside();
        unchecked {
            e = FullMath.mulDiv(g0 - base0, liquidity0, Q128) + FullMath.mulDiv(g1 - base1, liquidity1, Q128)
                + FullMath.mulDiv(g2 - base2, liquidity2, Q128);
        }
    }

    function indexNow() public view returns (uint256) {
        return FullMath.mulDiv(earned(), SCALE, n);
    }

    /// @notice The collection's `transferObserver` (between outside owners): two writes, no global one.
    function onTransfer(address from, address, uint256 id) external {
        uint256 i = indexNow();
        owed[from] += (i - (snap[id] - 1)) / SCALE;
        snap[id] = i + 1;
    }

    function onExit(address, uint256 id) external {
        uint256 i = indexNow();
        _moveOutside(i, true);
        snap[id] = i + 1;
    }

    function onReturn(address owner, uint256 id) external {
        uint256 i = indexNow();
        _moveOutside(i, false);
        owed[owner] += (i - (snap[id] - 1)) / SCALE;
        snap[id] = 0;
    }

    function pendingOf(uint256 id) external view returns (uint256) {
        uint256 s = snap[id];
        return s == 0 ? 0 : (indexNow() - (s - 1)) / SCALE;
    }

    /// @notice The inside share owed to the burn: what the ranges earned less the owners' share.
    function burnOwed() external view returns (uint256) {
        uint256 b = _book;
        uint256 m = b & MASK32;
        uint256 at = (b >> 32) & ((1 << 223) - 1);
        uint256 owners = ownersShareBooked - 1 + m * (indexNow() - at) / SCALE;
        return earned() - owners;
    }

    function _moveOutside(uint256 i, bool up) private {
        uint256 b = _book;
        uint256 m = b & MASK32;
        uint256 at = (b >> 32) & ((1 << 223) - 1);
        if (m != 0) ownersShareBooked += m * (i - at) / SCALE;
        m = up ? m + 1 : m - 1;
        _book = (1 << 255) | (i << 32) | m;
    }

    function _growthInside() internal view returns (uint256 g0, uint256 g1, uint256 g2) {
        int24[4] memory t = [lower0, upper0, upper1, lower2];
        bytes32[] memory slots = new bytes32[](6);
        slots[0] = stateSlot;
        slots[1] = bytes32(uint256(stateSlot) + FEE_GROWTH_GLOBAL1_OFFSET);
        bytes32 ticksSlot = bytes32(uint256(stateSlot) + TICKS_OFFSET);
        for (uint256 i; i < 4; ++i) {
            slots[2 + i] = bytes32(uint256(keccak256(abi.encodePacked(int256(t[i]), ticksSlot))) + 2);
        }
        bytes32[] memory v = pm.extsload(slots);
        int24 tick = Slot0.wrap(v[0]).tick();
        uint256 global = uint256(v[1]);
        g0 = _inside(tick, global, lower0, upper0, uint256(v[2]), uint256(v[3]));
        g1 = _inside(tick, global, upper0, upper1, uint256(v[3]), uint256(v[4]));
        g2 = _inside(tick, global, lower2, lower0, uint256(v[5]), uint256(v[2]));
    }

    function _inside(int24 tick, uint256 global, int24 lower, int24 upper, uint256 outLower, uint256 outUpper)
        internal
        pure
        returns (uint256)
    {
        unchecked {
            if (tick < lower) return outLower - outUpper;
            if (tick >= upper) return outUpper - outLower;
            return global - outLower - outUpper;
        }
    }
}

/// @notice SPIKE ONLY: calls an observer the way `MisfitsCollection` does (`OBSERVER_GAS`, fail-safe: a failure is
/// skipped, the action goes on) and records the gas the call used and whether it was skipped.
contract CappedObserverCaller {
    uint256 public cap;
    uint256 public skipped;
    uint256 public maxUsed;
    uint256 public lastUsed;

    constructor(uint256 cap_) {
        cap = cap_;
    }

    function setCap(uint256 cap_) external {
        cap = cap_;
    }

    function relay(address observer, bytes calldata data) external returns (bool ok) {
        uint256 c = cap;
        bytes memory d = data;
        uint256 g = gasleft();
        assembly ("memory-safe") {
            ok := call(c, observer, 0, add(d, 0x20), mload(d), 0, 0)
        }
        uint256 used = g - gasleft();
        lastUsed = used;
        if (used > maxUsed) maxUsed = used;
        if (!ok) ++skipped;
    }
}
