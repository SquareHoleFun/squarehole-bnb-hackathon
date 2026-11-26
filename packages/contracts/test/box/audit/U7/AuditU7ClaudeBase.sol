// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";

/// @title AuditU7ClaudeMath
/// @notice TEST ONLY (SH-AUDIT-B0-U7, Claude auditor). 512-bit products and quotes computed independently of the
/// vault's FullMath, so a quote check is not the vault's own arithmetic read back.
library AuditU7ClaudeMath {
    /// @notice The full product x·y as (hi, lo).
    function mul512(uint256 x, uint256 y) internal pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            lo := mul(x, y)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }

    /// @notice x·y ≥ z·w in 512 bits.
    function productGe(uint256 x, uint256 y, uint256 z, uint256 w) internal pure returns (bool) {
        (uint256 aHi, uint256 aLo) = mul512(x, y);
        (uint256 bHi, uint256 bLo) = mul512(z, w);
        return aHi > bHi || (aHi == bHi && aLo >= bLo);
    }

    /// @notice True when q = ⌈a·k/n⌉: q·n ≥ a·k and (q − 1)·n < a·k (q ≥ 1), checked in 512 bits.
    function isCeil(uint256 q, uint256 a, uint256 k, uint256 n) internal pure returns (bool) {
        if (!productGe(q, n, a, k)) return false;
        if (q == 0) return true; // then a·k == 0
        return !productGe(q - 1, n, a, k);
    }

    /// @notice True when q = ⌊a·k/n⌋: q·n ≤ a·k and (q + 1)·n > a·k, checked in 512 bits.
    function isFloor(uint256 q, uint256 a, uint256 k, uint256 n) internal pure returns (bool) {
        if (!productGe(a, k, q, n)) return false;
        if (q == type(uint256).max) return true;
        return !productGe(a, k, q + 1, n);
    }

    /// @notice ⌊x·y/d⌋ (a helper for test amounts only; the quote checks above are independent of FullMath).
    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return FullMath.mulDiv(x, y, d);
    }

    /// @notice ⌈p·bps/10,000⌉ for the p of box 0 (p·bps < 2^256).
    function feeOf(uint256 p, uint256 bps) internal pure returns (uint256) {
        return bps == 0 ? 0 : (p * bps + 9_999) / 10_000;
    }
}

/// @title AuditU7ClaudeTree
/// @notice TEST ONLY. The Sepolia test commitment's tree (`AuditRevealSet`, BoxCollection's index-directed layout) for
/// one edition size, built once and kept in storage, so a proof costs `depth` reads instead of a rebuild of the tree
/// (AuditRevealSet.proof rebuilds 2,048 leaves at N = 1,969 on every call).
contract AuditU7ClaudeTree {
    uint256 public immutable n;
    uint256 public immutable depth;
    /// @dev Level l (0 = leaves) starts at offset 2^(depth + 1) − 2^(depth + 1 − l).
    bytes32[] internal _nodes;
    bytes32 public root;

    constructor(uint256 n_) {
        n = n_;
        depth = AuditRevealSet.depth(n_);
        uint256 width = uint256(1) << AuditRevealSet.depth(n_);
        bytes32[] memory level = new bytes32[](width);
        for (uint256 id = 1; id <= n_; ++id) {
            level[id - 1] = AuditRevealSet.leafOf(id);
        }
        for (uint256 i; i < width; ++i) {
            _nodes.push(level[i]);
        }
        while (width > 1) {
            width >>= 1;
            for (uint256 i; i < width; ++i) {
                bytes32 h = _pair(level[2 * i], level[2 * i + 1]);
                level[i] = h;
                _nodes.push(h);
            }
        }
        root = level[0];
    }

    /// @notice The siblings of `id` from the leaf upwards (BoxCollection._verify's order).
    function proof(uint256 id) public view returns (bytes32[] memory p) {
        require(id >= 1 && id <= n, "tree: id");
        uint256 d = depth;
        p = new bytes32[](d);
        uint256 index = id - 1;
        uint256 start;
        uint256 width = uint256(1) << d;
        for (uint256 level; level < d; ++level) {
            p[level] = _nodes[start + (index ^ 1)];
            start += width;
            width >>= 1;
            index >>= 1;
        }
    }

    /// @notice What BoxTickets.open / openDraw / takeByNumber take to reveal `id`.
    function itemReveal(uint256 id) external view returns (ItemReveal memory r) {
        SepoliaBox0TestSet.Entry memory e = AuditRevealSet.entry(id);
        r.traitsPacked = e.traitsPacked;
        r.imageHash = e.imageHash;
        r.avatarHash = e.avatarHash;
        r.modelHash = e.modelHash;
        r.salt = e.salt;
        r.proof = proof(id);
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            h := keccak256(0x00, 0x40)
        }
    }
}

/// @title AuditU7ClaudeBase
/// @notice TEST ONLY (SH-AUDIT-B0-U7, Claude auditor). The audit world's box 0 (`AuditPhases`) with the checks every U7
/// test reuses: VLT-08 in the vault's own numbers (`BoxVault.sol:42`, `IBoxVault.sol:28`), the collection's Σ balances
/// == N with one owner per id (`BoxCollection.sol:52`), quotes recomputed from the state before an action
/// (`BoxVault.sol:24`; BC-006), and drivers for takes by number and picks that pick their own ids.
abstract contract AuditU7ClaudeBase is AuditPhases {
    uint256 internal constant PICK_BPS = 2_500;
    uint256 internal constant RETURN_BPS = 500;
    uint256 internal constant DRAW_BPS = 100;
    uint256 internal constant OBSERVER_CAP = 460_000;
    /// @dev The vault's and the collection's floor at the observer call (cap + cap / 63 + 10,000).
    uint256 internal constant OBSERVER_FLOOR = 477_301;

    AuditU7ClaudeTree internal tree;

    /// @notice The vault's and T's numbers at one moment.
    struct VaultState {
        uint256 s;
        uint256 e;
        uint256 n;
        uint256 h;
        uint256 t;
        uint256 m;
        uint256 a;
        uint256 gateAt;
        uint256 vaultT;
        uint256 vaultItems;
    }

    function _buildTree() internal {
        if (address(tree) != address(0)) return;
        vm.pauseGasMetering();
        tree = new AuditU7ClaudeTree(editionSize);
        vm.resumeGasMetering();
        require(tree.root() == collection.revealRoot(), "U7: the cached tree has the world's root");
    }

    function _vaultState() internal view returns (VaultState memory v) {
        v.s = token.totalSupply();
        v.e = vault.escrowPrincipal();
        v.n = vault.inside();
        v.h = vault.hiddenCount();
        v.t = vault.pendingTickets();
        v.m = editionSize - v.n;
        v.a = v.s - v.e;
        v.gateAt = vault.gateOpenedAt();
        v.vaultT = token.balanceOf(a.vault);
        v.vaultItems = collection.balanceOf(a.vault);
    }

    /// @notice The vault and T moved from `b` by exactly: E by `de`, S down by `burned`, n by `dn`, h by `dh`, t by
    /// `dt`; and A/n did not rise (A_after·n_before ≤ A_before·n_after).
    function _assertMoved(VaultState memory b, int256 de, uint256 burned, int256 dn, int256 dh, int256 dt)
        internal
        view
    {
        VaultState memory c = _vaultState();
        assertEq(int256(c.e) - int256(b.e), de, "E moved by the principal");
        assertEq(b.s - c.s, burned, "S fell by exactly the fee");
        assertEq(int256(c.n) - int256(b.n), dn, "n moved");
        assertEq(int256(c.h) - int256(b.h), dh, "h moved");
        assertEq(int256(c.t) - int256(b.t), dt, "t moved");
        assertTrue(AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n), "A/n never rises");
    }

    /// @notice VLT-08 without the per-id walk: T balance == E (no unsolicited T); E·n ≥ m·A; n ≥ 1; h ≤ n; E + n ≤ S;
    /// the collection holds n + t for the vault (so n + t + outside == N); the floor reads E + n.
    function _assertVlt08Light(string memory ctx) internal view {
        VaultState memory v = _vaultState();
        assertEq(v.vaultT, v.e, string.concat(ctx, ": T balance == E"));
        assertEq(vault.unsolicitedToken(), 0, string.concat(ctx, ": no unsolicited T"));
        assertTrue(AuditU7ClaudeMath.productGe(v.e, v.n, v.m, v.a), string.concat(ctx, ": E*n >= m*A"));
        assertGe(v.n, 1, string.concat(ctx, ": n >= 1"));
        assertLe(v.h, v.n, string.concat(ctx, ": h <= n"));
        assertLe(v.e + v.n, v.s, string.concat(ctx, ": E + n <= S"));
        assertEq(v.vaultItems, v.n + v.t, string.concat(ctx, ": the vault holds n + t items"));
        assertEq(vault.supplyFloor(), v.e + v.n, string.concat(ctx, ": floor == E + n"));
        assertEq(vault.outside(), v.m, string.concat(ctx, ": outside() == N - n"));
        assertEq(vault.shelfCount(), v.n - v.h, string.concat(ctx, ": s == n - h"));
    }

    /// @notice VLT-08 with every id walked: n + t + (ids outside) == N in the vault's bits, the bits agree with the
    /// collection's owners (outside ⇔ not the vault's), hidden ids (never left) == h + t, shelf ids == n − h; and the
    /// collection's Σ balances == N with one owner per id.
    function _assertVlt08(string memory ctx) internal view {
        _assertVlt08Light(ctx);
        VaultState memory v = _vaultState();
        uint256 first = collection.firstId();
        uint256 outsideIds;
        uint256 hiddenIds;
        uint256 shelfIds;
        for (uint256 id = first; id < first + editionSize; ++id) {
            bool out = vault.isOutside(id);
            address owner = collection.ownerOf(id);
            if (out) {
                ++outsideIds;
                assertTrue(owner != a.vault, string.concat(ctx, ": an outside id is not the vault's"));
            } else {
                assertEq(owner, a.vault, string.concat(ctx, ": an inside id is the vault's"));
                if (vault.hasLeftVault(id)) ++shelfIds;
                else ++hiddenIds;
            }
        }
        assertEq(v.n + v.t + outsideIds, editionSize, string.concat(ctx, ": n + t + outside == N"));
        assertEq(hiddenIds, v.h + v.t, string.concat(ctx, ": never-left ids == h + t"));
        assertEq(shelfIds, v.n - v.h, string.concat(ctx, ": shelf ids == n - h"));
    }

    /// @notice Σ balances == N over every owner, one owner per id (ownerOf is a function; its owners' balances agree).
    function _assertCollectionConserved(address[] memory holders, string memory ctx) internal view {
        uint256 first = collection.firstId();
        uint256[] memory counted = new uint256[](holders.length);
        uint256 vaultCount;
        for (uint256 id = first; id < first + editionSize; ++id) {
            address owner = collection.ownerOf(id);
            if (owner == a.vault) {
                ++vaultCount;
                continue;
            }
            bool known;
            for (uint256 j; j < holders.length; ++j) {
                if (holders[j] == owner) {
                    ++counted[j];
                    known = true;
                    break;
                }
            }
            assertTrue(known, string.concat(ctx, ": every owner is a known holder"));
        }
        uint256 sum = collection.balanceOf(a.vault);
        assertEq(sum, vaultCount, string.concat(ctx, ": the vault's balance == its ids"));
        for (uint256 j; j < holders.length; ++j) {
            assertEq(collection.balanceOf(holders[j]), counted[j], string.concat(ctx, ": balance == ids owned"));
            sum += counted[j];
        }
        assertEq(sum, editionSize, string.concat(ctx, ": sum of balances == N"));
        assertEq(collection.totalSupply(), editionSize, string.concat(ctx, ": totalSupply == N"));
    }

    /// @notice Every holder the world's actors and this unit's tests use.
    function _holders(address[] memory extra) internal view returns (address[] memory h) {
        h = new address[](11 + extra.length);
        for (uint256 i; i < 8; ++i) {
            h[i] = eoa[i];
        }
        h[8] = eoa7702;
        h[9] = address(contractDrawer);
        h[10] = address(this);
        for (uint256 i; i < extra.length; ++i) {
            h[11 + i] = extra[i];
        }
    }

    function _noExtra() internal pure returns (address[] memory) {
        return new address[](0);
    }

    // ------------------------------------------------------------------------------------------------ drivers

    /// @notice The draw-pool item at pool index `index` and whether the vault still hides it.
    function _poolItemAt(uint256 index) internal view returns (uint256 item, bool hidden) {
        return _poolItem(index);
    }

    /// @notice The number of undrawn pool positions (BoxTickets `_left`).
    function _poolLeft() internal view returns (uint256) {
        IBoxTickets.TicketState memory s = tickets.status();
        return editionSize - s.slots - s.drawsSettled;
    }

    /// @notice A hidden pool item from `seed` (walks forward from the seed's index until it finds one).
    function _hiddenPoolItem(uint256 seed) internal view returns (uint256 item, uint256 index) {
        uint256 left = _poolLeft();
        index = seed % left;
        for (uint256 i; i < left; ++i) {
            (uint256 it, bool hidden) = _poolItem(index);
            if (hidden) return (it, index);
            index = (index + 1) % left;
        }
        revert("U7: no hidden pool item");
    }

    /// @notice Terminal mode's take by number of a hidden pool item as `who`, with its reveal from the cached tree or
    /// without one (the safety net: from TAKE_DELAY on the taker may take it unrevealed).
    function _takeItem(address who, uint256 seed, bool withReveal) internal returns (uint256 item) {
        uint256 index;
        (item, index) = _hiddenPoolItem(seed);
        _approveT(who, a.tickets);
        ItemReveal memory r;
        if (withReveal) r = tree.itemReveal(item);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        tickets.takeByNumber(item, index, type(uint256).max, deadline, r);
        _noteTChange(t0, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
    }

    /// @notice The revealed shelf ids among `candidates` (returned items).
    function _isPickable(uint256 id) internal view returns (bool) {
        return vault.isOnShelf(id) && collection.isRevealed(id);
    }

    function _ids1(uint256 x) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = x;
    }

    function _ids2(uint256 x, uint256 y) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = x;
        r[1] = y;
    }

    function _ids3(uint256 x, uint256 y, uint256 z) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = x;
        r[1] = y;
        r[2] = z;
    }

    /// @dev The shuffle the tickets use (BoxShuffle) for the item a placeholder slot opens into.
    function _slotItem(uint256 slot) internal view returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
        return tickets.firstId() + BoxShuffle.permute(tickets.graduationWord(), slot, editionSize, u, v);
    }
}
