// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {ItemReveal, VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection, IERC721TokenReceiver} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {Vm} from "forge-std/Vm.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";

/// @notice Real factory box 0, mainnet build and stream. The cached complete Merkle tree is test data only.
abstract contract AuditU7LaneBase is AuditPhases {
    bytes32[] internal nodes;
    uint256 internal width;
    uint256 internal creationEvents;
    uint256 internal creationIds;

    function setUp() public virtual override {
        vm.recordLogs();
        super.setUp();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != a.collection || l.topics[0] != IBoxCollection.ConsecutiveTransfer.selector) continue;
            uint256 first = uint256(l.topics[1]);
            uint256 last = abi.decode(l.data, (uint256));
            assertEq(first, creationIds + 1);
            assertEq(l.topics[2], bytes32(0));
            assertEq(address(uint160(uint256(l.topics[3]))), a.vault);
            assertLe(last - first + 1, 5000);
            creationIds += last - first + 1;
            ++creationEvents;
        }
    }

    function _cacheTree() internal {
        if (width != 0) return;
        // Fixture construction, not a production transaction or part of any measured gas interval.
        vm.pauseGasMetering();
        width = 1 << AuditRevealSet.depth(editionSize);
        bytes32[] memory tree = new bytes32[](2 * width);
        for (uint256 i; i < editionSize; ++i) {
            tree[width + i] = AuditRevealSet.leafOf(i + 1);
        }
        for (uint256 i = width - 1; i > 0; --i) {
            tree[i] = keccak256(abi.encode(tree[2 * i], tree[2 * i + 1]));
        }
        nodes = tree;
        vm.resumeGasMetering();
        assertEq(nodes[1], collection.revealRoot(), "independent tree agrees with committed root");
    }

    function _data(uint256 id) internal view returns (ItemReveal memory r) {
        r = _entry(id);
        uint256 pos = width + id - 1;
        r.proof = new bytes32[](collection.treeDepth());
        for (uint256 i; i < r.proof.length; ++i) {
            r.proof[i] = nodes[pos ^ 1];
            pos >>= 1;
        }
    }

    function _entry(uint256 id) internal pure returns (ItemReveal memory r) {
        // Same public data as the shared world, without rebuilding its tree per reveal.
        SepoliaBox0TestSet.Entry memory e = AuditRevealSet.entry(id);
        r.traitsPacked = e.traitsPacked;
        r.imageHash = e.imageHash;
        r.avatarHash = e.avatarHash;
        r.modelHash = e.modelHash;
        r.salt = e.salt;
    }

    function _revealCall(uint256 id, ItemReveal memory r) internal pure returns (bytes memory) {
        return abi.encodeCall(
            IBoxCollection.reveal, (id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof)
        );
    }

    function _publish(uint256 id) internal {
        _cacheTree();
        (bool ok, bytes memory err) = a.collection.call(_revealCall(id, _data(id)));
        if (!ok) {
            assembly ("memory-safe") { revert(add(err, 32), mload(err)) }
        }
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _ceil(uint256 x, uint256 k, uint256 n) internal pure returns (uint256) {
        // Independent quotient/remainder oracle; k <= n keeps these products within 256 bits.
        return (x / n) * k + ((x % n) * k + n - 1) / n;
    }

    function _floor(uint256 x, uint256 k, uint256 n) internal pure returns (uint256) {
        return (x / n) * k + (x % n) * k / n;
    }

    function _fee(uint256 x, uint256 bps) internal pure returns (uint256) {
        return (x / 10_000) * bps + ((x % 10_000) * bps + 9999) / 10_000;
    }

    function _assertVault() internal view {
        uint256 n = vault.inside();
        uint256 e = vault.escrowPrincipal();
        uint256 supply = token.totalSupply();
        assertEq(token.balanceOf(a.vault), e, "VLT-08 balance = E");
        assertGe(n, 1, "last item");
        // Factory issuance is 1e27, so both products fit. Boundary view tests use the division oracle above.
        assertGe(e * n, (editionSize - n) * (supply - e), "VLT-08 solvency");
        assertLe(vault.hiddenCount(), n);
        assertLe(e + n, supply);
        assertEq(collection.balanceOf(a.vault), n + vault.pendingTickets());
        if (n > 1) assertEq(vault.quoteWithdraw(1), _ceil(supply - e, 1, n));
        if (n < editionSize) assertEq(vault.quoteReturn(1), _floor(supply - e, 1, n));
        assertFalse(vault.handBackFeeWaived());
        assertEq(vault.observer(), a.itemStream);
        assertEq(collection.transferObserver(), a.itemStream);
        for (uint256 i; i < eoa.length; ++i) {
            assertEq(token.allowance(a.vault, eoa[i]), 0);
            assertFalse(collection.isApprovedForAll(a.vault, eoa[i]));
        }
        assertEq(token.allowance(a.vault, a.tickets), 0);
        assertEq(token.allowance(a.vault, a.itemStream), 0);
    }
}

/// @notice Deliberate receiver behaviour only; it returns its newly owned item through the real vault.
contract AuditU7LaneReturningReceiver is IERC721TokenReceiver {
    BoxVault public immutable vault;
    BoxCollection public immutable collection;
    bool public finalOwnerSeen;
    uint256 public callbacks;

    constructor(BoxVault v, BoxCollection c) {
        vault = v;
        collection = c;
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(collection));
        finalOwnerSeen = collection.ownerOf(id) == address(this) && collection.balanceOf(address(this)) == 1;
        ++callbacks;
        collection.approve(address(vault), id);
        vault.returnItem(id, 0, block.timestamp);
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}
