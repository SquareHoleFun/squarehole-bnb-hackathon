// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";

/// @title AuditU7FableTree
/// @notice TEST ONLY (SH-AUDIT-B0 U7, Fable auditor). The audit reveal set's tree (`AuditRevealSet`) kept level by
/// level in storage, filled once with gas metering paused, so a proof costs `depth` SLOADs instead of the library's
/// whole-tree rebuild (a few million gas per call). Level 0 holds the padded leaves, the last level the root. No `Test`
/// dependency: a kit-based test and a world-based test both inherit it.
abstract contract AuditU7FableTree {
    bytes32[][] internal _tree;

    function _buildTreeFor(uint256 n) internal {
        delete _tree;
        uint256 d = AuditRevealSet.depth(n);
        uint256 width = uint256(1) << d;
        bytes32[] memory level = new bytes32[](width);
        for (uint256 id = 1; id <= n; ++id) {
            level[id - 1] = AuditRevealSet.leafOf(id);
        }
        _tree.push(level);
        while (width > 1) {
            width >>= 1;
            bytes32[] memory next = new bytes32[](width);
            for (uint256 i; i < width; ++i) {
                next[i] = keccak256(abi.encodePacked(level[2 * i], level[2 * i + 1]));
            }
            _tree.push(next);
            level = next;
        }
    }

    function _treeRoot() internal view returns (bytes32) {
        return _tree[_tree.length - 1][0];
    }

    function _treeDepth() internal view returns (uint256) {
        return _tree.length - 1;
    }

    /// @notice The index-directed siblings of `id` (ids start at 1), as `BoxCollection._verify` walks them.
    function _proofOf(uint256 id) internal view returns (bytes32[] memory p) {
        uint256 d = _treeDepth();
        p = new bytes32[](d);
        uint256 index = id - 1;
        for (uint256 l; l < d; ++l) {
            p[l] = _tree[l][index ^ 1];
            index >>= 1;
        }
    }

    /// @notice Item `id`'s reveal data and proof from the stored tree.
    function _revealOf(uint256 id) internal view returns (ItemReveal memory r) {
        SepoliaBox0TestSet.Entry memory e = AuditRevealSet.entry(id);
        r.traitsPacked = e.traitsPacked;
        r.imageHash = e.imageHash;
        r.avatarHash = e.avatarHash;
        r.modelHash = e.modelHash;
        r.salt = e.salt;
        r.proof = _proofOf(id);
    }
}

/// @title AuditU7FableBase
/// @notice TEST ONLY (SH-AUDIT-B0 U7, Fable auditor). Shared ground of the U7 tests over the audit world (the factory's
/// box 0 on the mainnet build with the real per-item stream as the vault's and the collection's observer): VLT-08 and
/// the custody identities asserted from the chain after an action, the stored reveal tree, openings with stored
/// proofs, and a shelf stocked from the drawing phase (items that left and came back, so named picks exist).
abstract contract AuditU7FableBase is AuditPhases, AuditU7FableTree {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PICK_BPS = 2_500;
    uint256 internal constant RETURN_BPS = 500;
    uint256 internal constant DRAW_BPS = 100;
    uint256 internal constant OBSERVER_GAS = 460_000;
    /// @dev `_OBSERVER_GAS_REQUIRED` of both contracts: the cap, EIP-150's 1/64 and a 10,000 margin.
    uint256 internal constant OBSERVER_FLOOR = OBSERVER_GAS + OBSERVER_GAS / 63 + 10_000;
    /// @dev EIP-7825's transaction gas cap.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    /// @notice The shelf after `_stockShelf`: items that left through tickets and were returned, revealed.
    uint256[] internal shelf;
    /// @notice Items of the placeholders opened by `_stockShelf` (tokens 2, 3, 4), by token id.
    mapping(uint256 => uint256) internal placeholderItem;

    // ------------------------------------------------------------------------------------------------ tree

    function _buildTree() internal {
        vm.pauseGasMetering();
        _buildTreeFor(editionSize);
        vm.resumeGasMetering();
        assertEq(_treeRoot(), collection.revealRoot(), "stored tree: the collection's root");
    }

    /// @notice Opens placeholder `tokenId` as its holder with the stored proof; returns the item.
    function _openWith(address who, uint256 tokenId) internal returns (uint256 item) {
        item = tickets.numberOf(tokenId);
        vm.prank(who);
        uint256 got = tickets.open(tokenId, _revealOf(item));
        assertEq(got, item, "opened the numbered item");
    }

    /// @notice Opens settled draw `ticketId` as `who` to `to` with the stored proof; returns the item.
    function _openDrawWith(address who, uint256 ticketId, address to) internal returns (uint256 item) {
        item = tickets.drawTicket(ticketId).itemId;
        vm.prank(who);
        uint256 got = tickets.openDraw(ticketId, to, _revealOf(item));
        assertEq(got, item, "opened the settled item");
    }

    // ------------------------------------------------------------------------------------------------ shelf

    /// @notice From the drawing phase (items A and P1 outside; placeholders 2-5 live; draw B settled): opens
    /// placeholders 2, 3 (eoa[0]) and 4 (eoa[1]) with their reveals and returns A, P1 and those three, so five revealed
    /// items sit on the shelf; placeholder 5 (eoa[1]) and draw B (the contract drawer) stay open for the tests that
    /// need an item leaving without its reveal. Every move goes through the world's booked helpers.
    function _stockShelf() internal {
        _stockShelfImpl(false);
    }

    /// @notice As `_stockShelf`, but placeholder 4 stays live too (tests that need two live placeholders).
    function _stockShelfKeepingFour() internal {
        _stockShelfImpl(true);
    }

    function _stockShelfImpl(bool keepFour) private {
        require(reached == AuditPhase.Drawing, "stock: from the drawing phase");
        placeholderItem[2] = _openWith(eoa[0], 2);
        placeholderItem[3] = _openWith(eoa[0], 3);
        if (!keepFour) placeholderItem[4] = _openWith(eoa[1], 4);
        _returnItem(eoa[3], itemA);
        uint256[] memory ids0 = new uint256[](3);
        (ids0[0], ids0[1], ids0[2]) = (itemP1, placeholderItem[2], placeholderItem[3]);
        _returnItems(eoa[0], ids0);
        if (!keepFour) _returnItem(eoa[1], placeholderItem[4]);
        shelf.push(itemA);
        shelf.push(itemP1);
        shelf.push(placeholderItem[2]);
        shelf.push(placeholderItem[3]);
        if (!keepFour) shelf.push(placeholderItem[4]);
        for (uint256 i; i < shelf.length; ++i) {
            assertTrue(vault.isOnShelf(shelf[i]), "stocked: on the shelf");
            assertTrue(collection.isRevealed(shelf[i]), "stocked: revealed");
            assertEq(collection.ownerOf(shelf[i]), a.vault);
        }
        assertEq(vault.shelfCount(), shelf.length, "stocked: the shelf");
        assertEq(vault.pendingTickets(), keepFour ? 3 : 2, "stocked: the open tickets");
        assertEq(vault.outside(), keepFour ? 3 : 2);
        _assertGhostLedger();
    }

    /// @notice The number of entries of `.attributes` in a token JSON.
    function _attributeCount(string memory j) internal view returns (uint256 n) {
        while (vm.keyExistsJson(j, string.concat(".attributes[", vm.toString(n), "]"))) {
            ++n;
        }
    }

    /// @notice Gives `who` `amount` T from eoa[2] (the closer, box 0's largest holder) for picks.
    function _fundT(address who, uint256 amount) internal {
        require(token.balanceOf(eoa[2]) >= amount, "fundT: eoa[2] holds enough");
        _transferT(eoa[2], who, amount);
    }

    // ------------------------------------------------------------------------------------------------ VLT-08

    /// @notice VLT-08 and the custody identities, read from the chain (`BoxVault.sol:42`, `IBoxVault.sol:28`, BC-005,
    /// BC-006, BC-007, BC-042, BC-044, BC-097): T balance == E; E·n ≥ m·A (512-bit, through the vault's own surplus
    /// view, which underflows otherwise, and FullMath); n ≥ 1; h ≤ n; n = h + s; E + n ≤ S; the vault holds n + t
    /// items; outside == N − n; the surplus identity ⌊K⌋·n + rem == E·n − m·A.
    function _assertVlt08(string memory where) internal view {
        uint256 n = vault.inside();
        uint256 size = vault.collectionSize();
        uint256 e = vault.escrowPrincipal();
        uint256 s = token.totalSupply();
        uint256 av = s - e;
        uint256 m = size - n;
        assertEq(token.balanceOf(a.vault), e, string.concat(where, ": T balance == E"));
        assertEq(vault.unsolicitedToken(), 0, string.concat(where, ": no unsolicited T"));
        assertGe(n, 1, string.concat(where, ": n >= 1"));
        assertLe(vault.hiddenCount(), n, string.concat(where, ": h <= n"));
        assertEq(n, vault.hiddenCount() + vault.shelfCount(), string.concat(where, ": n = h + s"));
        assertLe(e + n, s, string.concat(where, ": E + n <= S"));
        assertEq(vault.supplyFloor(), e + n, string.concat(where, ": floor = E + n"));
        assertEq(vault.activeSupply(), av, string.concat(where, ": A = S - E"));
        assertEq(vault.outside(), m, string.concat(where, ": outside = N - n"));
        assertEq(
            collection.balanceOf(a.vault), n + vault.pendingTickets(), string.concat(where, ": the vault holds n + t")
        );
        uint256 need = FullMath.mulDivRoundingUp(m, av, n);
        assertGe(e, need, string.concat(where, ": E n >= m A"));
        (uint256 kFloor, uint256 kRem) = vault.escrowSurplus();
        assertEq(kFloor, e - need, string.concat(where, ": K floor"));
        uint256 r0_ = mulmod(m, av, n);
        assertEq(kRem, r0_ == 0 ? 0 : n - r0_, string.concat(where, ": K remainder"));
        assertEq(s + token.totalBurned(), 1e27, string.concat(where, ": supply + burned = issuance"));
    }

    /// @notice The vault approves nobody (VLT-08's last clause; BoxVaultInvariants' VLT-19): no T allowance from the
    /// vault to any actor or box contract, no operator or token approval from the vault on the collection.
    function _assertVaultApprovesNobody() internal view {
        address[12] memory who = [
            eoa[0],
            eoa[1],
            eoa[2],
            eoa[3],
            eoa[4],
            eoa[5],
            eoa[6],
            eoa[7],
            address(contractDrawer),
            eoa7702,
            a.tickets,
            a.itemStream
        ];
        for (uint256 i; i < who.length; ++i) {
            assertEq(token.allowance(a.vault, who[i]), 0, "the vault grants no T allowance");
            assertFalse(collection.isApprovedForAll(a.vault, who[i]), "the vault names no operator");
        }
        for (uint256 i; i < shelf.length; ++i) {
            assertEq(collection.getApproved(shelf[i]), address(0), "no approval on a shelf item");
        }
    }

    // ------------------------------------------------------------------------------------------------ quotes

    function _ceilFee(uint256 principal, uint256 bps) internal pure returns (uint256) {
        return bps == 0 ? 0 : FullMath.mulDivRoundingUp(principal, bps, BPS);
    }

    /// @notice The pick quote from the state now: ⌈A·k/n⌉ and its 25% fee.
    function _pickQuote(uint256 k) internal view returns (uint256 principal, uint256 fee) {
        principal = FullMath.mulDivRoundingUp(vault.activeSupply(), k, vault.inside());
        fee = _ceilFee(principal, PICK_BPS);
    }

    /// @notice The return quote from the state now: ⌊A·k/n⌋ and its 5% fee.
    function _returnQuote(uint256 k) internal view returns (uint256 principal, uint256 fee) {
        principal = FullMath.mulDiv(vault.activeSupply(), k, vault.inside());
        fee = _ceilFee(principal, RETURN_BPS);
    }

    function _ids1(uint256 x) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = x;
    }

    function _ids2(uint256 x, uint256 y) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = (x, y);
    }

    function _emptyReveal() internal pure returns (ItemReveal memory r) {}

    function _status() internal view returns (IBoxTickets.TicketState memory) {
        return tickets.status();
    }
}
