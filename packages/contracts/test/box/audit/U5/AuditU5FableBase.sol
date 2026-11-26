// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";

/// @title AuditU5FableReads
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). Independent reads of what unit U5 computes from the pool: box 0's four hook
/// positions (the ask [MIN, P1], the bid [P1, MAX], the sentinel [P0, MAX] at the L7 salt, the pair [MIN, MAX] at the
/// pair salt; BoxHookBase `_SALT_L7` 1, `_SALT_PAIR` 3) through v4's `StateLibrary` (`getFeeGrowthInside` +
/// `getPositionInfo`, the formula of `Position.update`), never through the stream's own `extsload` slot arithmetic.
/// Used to recompute the stream's X and the LP fee the executor's own chunks paid (currency0).
library AuditU5FableReads {
    using StateLibrary for IPoolManager;

    uint256 internal constant Q128 = 1 << 128;
    bytes32 internal constant SALT_L7 = bytes32(uint256(1));
    bytes32 internal constant SALT_PAIR = bytes32(uint256(3));

    struct Positions {
        int24 p1;
        int24 p0;
    }

    struct Range {
        int24 lower;
        int24 upper;
        bytes32 salt;
    }

    /// @notice The uncollected fees (currency0, currency1) of one hook position, as v4 would pay them on a poke.
    function owed(IPoolManager pm, PoolId id, address hook, Range memory r)
        internal
        view
        returns (uint256 owed0, uint256 owed1)
    {
        bytes32 key = keccak256(abi.encodePacked(hook, r.lower, r.upper, r.salt));
        (uint128 l, uint256 last0, uint256 last1) = pm.getPositionInfo(id, key);
        if (l == 0) return (0, 0);
        (uint256 in0, uint256 in1) = pm.getFeeGrowthInside(id, r.lower, r.upper);
        unchecked {
            owed0 = FullMath.mulDiv(in0 - last0, l, Q128);
            owed1 = FullMath.mulDiv(in1 - last1, l, Q128);
        }
    }

    /// @notice Σ uncollected fees of the four positions (U for currency1, the Q twin for currency0).
    function uncollected(IPoolManager pm, PoolId id, address hook, Positions memory p)
        internal
        view
        returns (uint256 u0, uint256 u1)
    {
        (uint256 a0, uint256 a1) = owed(pm, id, hook, Range(BoxSpecV1.MIN_USABLE_TICK, p.p1, SALT_L7));
        (uint256 b0, uint256 b1) = owed(pm, id, hook, Range(p.p1, BoxSpecV1.MAX_USABLE_TICK, SALT_L7));
        (uint256 s0, uint256 s1) = owed(pm, id, hook, Range(p.p0, BoxSpecV1.MAX_USABLE_TICK, SALT_L7));
        (uint256 r0, uint256 r1) =
            owed(pm, id, hook, Range(BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, SALT_PAIR));
        u0 = a0 + b0 + s0 + r0;
        u1 = a1 + b1 + s1 + r1;
    }
}

/// @title AuditU5FableExecLogs
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). The executor's events of one call, decoded from recorded logs, and the
/// floor it must have used.
library AuditU5FableExecLogs {
    struct ExecLog {
        uint256 chunks;
        uint256 ethSpent;
        uint256 fitBought;
        uint256 fitBurned;
        int24 twapTick;
        uint160 floorSqrt;
        FitBuybackExecutor.Stop reason;
        uint256 feeReported;
        uint256 chunkEvents;
        uint160 lastSqrtBefore;
        uint160 lastSqrtAfter;
        uint160 lastLimit;
        uint256 observed;
        int24 observedRecorded;
        uint256 unsolicitedBurned;
        bool seen;
    }

    function decode(VmSafe.Log[] memory logs, address executor) internal pure returns (ExecLog memory e) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != executor) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == FitBuybackExecutor.Executed.selector) {
                (e.chunks, e.ethSpent, e.fitBought, e.fitBurned, e.twapTick, e.floorSqrt, e.reason) = abi.decode(
                    logs[i].data, (uint256, uint256, uint256, uint256, int24, uint160, FitBuybackExecutor.Stop)
                );
                e.seen = true;
            } else if (t0 == FitBuybackExecutor.ChunkBought.selector) {
                (,, e.lastSqrtBefore, e.lastSqrtAfter, e.lastLimit) =
                    abi.decode(logs[i].data, (uint256, uint256, uint160, uint160, uint160));
                ++e.chunkEvents;
            } else if (t0 == FitBuybackExecutor.ModuleFeesReported.selector) {
                e.feeReported = abi.decode(logs[i].data, (uint256));
            } else if (t0 == FitBuybackExecutor.Observed.selector) {
                (, e.observedRecorded,) = abi.decode(logs[i].data, (int24, int24, int56));
                ++e.observed;
            } else if (t0 == FitBuybackExecutor.TokensBurned.selector) {
                (, e.unsolicitedBurned) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// @notice The executor's floor as `_floorSqrtPrice(_referenceTick(twap))` computes it
    /// (FitBuybackExecutor.sol:501-511): max(latest sample, twap) − 99 ticks, clamped at MIN_TICK and MIN_SQRT_PRICE.
    function expectedFloor(int24 sampleTick, int24 twapTick) internal pure returns (uint160 f) {
        int24 ref = sampleTick > twapTick ? sampleTick : twapTick;
        int24 t = ref - BoxSpecV1.EXECUTOR_TWAP_BAND_TICKS;
        if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
        f = TickMath.getSqrtPriceAtTick(t);
        if (f < BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96) f = BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96;
    }
}

/// @title AuditU5FableRevealCache
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). `AuditRevealSet`'s tree for one edition built once into storage (the library
/// rebuilds it on every `proof`: 27.7M gas at N 1,969), so a handler can reveal any item for a few thousand gas.
contract AuditU5FableRevealCache {
    uint256 public immutable n;
    uint256 public immutable depth;
    /// @dev level 0 = the padded leaves; level `depth` = the root.
    mapping(uint256 => mapping(uint256 => bytes32)) internal _node;

    constructor(uint256 n_) {
        n = n_;
        uint256 d = AuditRevealSet.depth(n_);
        depth = d;
        uint256 width = uint256(1) << d;
        bytes32[] memory nodes = new bytes32[](width);
        for (uint256 id = 1; id <= n_; ++id) {
            nodes[id - 1] = AuditRevealSet.leafOf(id);
        }
        for (uint256 level; level < d; ++level) {
            for (uint256 i; i < width; ++i) {
                _node[level][i] = nodes[i];
            }
            for (uint256 i; i < width >> 1; ++i) {
                nodes[i] = keccak256(abi.encodePacked(nodes[2 * i], nodes[2 * i + 1]));
            }
            width >>= 1;
        }
        _node[d][0] = nodes[0];
        require(nodes[0] == AuditRevealSet.root(n_), "AuditU5FableRevealCache: the root");
    }

    function proof(uint256 id) public view returns (bytes32[] memory p) {
        p = new bytes32[](depth);
        uint256 index = id - 1;
        for (uint256 level; level < depth; ++level) {
            p[level] = _node[level][index ^ 1];
            index >>= 1;
        }
    }

    function reveal(uint256 id) external view returns (ItemReveal memory r) {
        SepoliaBox0TestSet.Entry memory e = AuditRevealSet.entry(id);
        r.traitsPacked = e.traitsPacked;
        r.imageHash = e.imageHash;
        r.avatarHash = e.avatarHash;
        r.modelHash = e.modelHash;
        r.salt = e.salt;
        r.proof = proof(id);
    }
}

/// @title AuditU5FableBase
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). The world of R0-A plus unit U5's independent reads: the stream's X
/// recomputed from `StateLibrary` and the receiver's claims, the executor's events decoded, and small helpers.
abstract contract AuditU5FableBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using AuditU5FableExecLogs for VmSafe.Log[];

    uint256 internal constant Q96 = 1 << 96;

    function _pid() internal view returns (PoolId) {
        return poolKey.toId();
    }

    function _positions() internal view returns (AuditU5FableReads.Positions memory p) {
        p.p1 = curve.tickLower;
        p.p0 = curve.tickUpper;
    }

    /// @notice U (currency1, T) and its currency0 twin: the four positions' uncollected fees, by StateLibrary.
    function _uncollected() internal view returns (uint256 u0, uint256 u1) {
        return AuditU5FableReads.uncollected(pm, _pid(), a.hook, _positions());
    }

    /// @notice X = F + 13·⌊(U + R)/15⌋ recomputed independently of the stream (IBoxItemStream.sol:41-48;
    /// BoxItemStream.sol:29-36): F = the stream's T balance + claimed + burned; U by StateLibrary; R the receiver's T
    /// claims (less its held curve-depth T while the settlement has not run, F126).
    function _streamXIndependent() internal view returns (uint256) {
        (uint256 claimed, uint256 burned) = stream.totals();
        uint256 f = token.balanceOf(a.itemStream) + claimed + burned;
        (, uint256 u1) = _uncollected();
        uint256 r = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
        if (!receiver.graduationSettled()) r -= receiver.streamCurveDepthT();
        return f + BoxSpecV1.BOX0_FEE_SHARE_T_BURN * ((u1 + r) / BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// @notice `execute(maxChunks)` as `caller`, with its events decoded.
    function _execute(address caller, uint256 maxChunks) internal returns (AuditU5FableExecLogs.ExecLog memory e) {
        vm.recordLogs();
        vm.prank(caller);
        (uint256 c, uint256 spent, uint256 burned) = executor.execute(maxChunks);
        e = _decodeExec(vm.getRecordedLogs());
        require(e.seen, "AuditU5FableBase: Executed event");
        require(e.chunks == c && e.ethSpent == spent && e.fitBurned == burned, "AuditU5FableBase: returns == event");
    }

    function _decodeExec(VmSafe.Log[] memory logs) internal view returns (AuditU5FableExecLogs.ExecLog memory e) {
        return logs.decode(a.executor);
    }

    function _expectedFloor(int24 sampleTick, int24 twapTick) internal pure returns (uint160) {
        return AuditU5FableExecLogs.expectedFloor(sampleTick, twapTick);
    }

    function _poolTick() internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(_pid());
    }

    function _poolSqrt() internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(_pid());
    }

    function _tickOf(uint160 sqrtP) internal pure returns (int24) {
        return TickMath.getTickAtSqrtPrice(sqrtP);
    }

    /// @notice A Q batch big enough to collect (BatchTooSmall below 0.005 ETH of Q): a 0.6 ETH buy, next block, collect.
    function _collectWithQ(address caller) internal {
        _buy(eoa[4], 0.6 ether);
        _advance(1);
        _collect(caller, caller);
    }

    /// @notice Uniswap's protocol fee on box 0's pool, as governance could set it (`IProtocolFees.setProtocolFee` by
    /// the controller the PoolManager's owner names; the kit's owner is `makeAddr("core.pmOwner")`).
    function _setProtocolFee(uint24 zeroForOne, uint24 oneForZero) internal {
        address owner = makeAddr("core.pmOwner");
        vm.prank(owner);
        IProtocolFees(address(pm)).setProtocolFeeController(address(this));
        IProtocolFees(address(pm)).setProtocolFee(poolKey, (oneForZero << 12) | zeroForOne);
    }

    function _ids(uint256 x) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = x;
    }

    function _ids(uint256 x, uint256 y) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = x;
        ids[1] = y;
    }

    function _owner(uint256 id) internal view returns (address) {
        return collection.ownerOf(id);
    }

    function _streamT() internal view returns (uint256) {
        return token.balanceOf(a.itemStream);
    }

    /// @notice A plain item transfer between holders (ERC-721 `transferFrom`); nothing crosses the ledger's boundary.
    function _transferItem(address from, address to, uint256 id) internal {
        vm.prank(from);
        collection.transferFrom(from, to, id);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    /// @notice Σ owed + the open tickets' accrual: the per-item side of the stream's ledger, for the accounts and
    /// outside items given (what `liabilities()` must equal when every observer call ran).
    function _ledgerFromRecords(address[] memory accounts, uint256[] memory outsideItems)
        internal
        view
        returns (uint256 total)
    {
        for (uint256 i; i < accounts.length; ++i) {
            total += stream.owedOf(accounts[i]);
        }
        for (uint256 i; i < outsideItems.length; ++i) {
            (, uint256 pending) = stream.pendingOf(outsideItems[i]);
            total += pending;
        }
        uint256 j = stream.index();
        (uint256 p, uint256 d, uint256 sum) = stream.openTickets();
        total += p * j + (d * j - sum);
    }
}
