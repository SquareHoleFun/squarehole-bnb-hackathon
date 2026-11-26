// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU7LaneBase, ItemReveal, IBoxCollection} from "./AuditU7LaneBase.sol";

/// @notice AR-12/14 regression, F141: complete commitment, indexed sibling proofs, permissionless one-time reveal.
/// The authorized adapter is impersonated ONLY to choose a specific hidden id for the vault delivery; ticket
/// randomness is covered through real take/open/draw paths in the campaign. No collection or observer substitute.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneReveal1969 is AuditU7LaneBase {
    function setUp() public virtual override {
        super.setUp();
        _cacheTree();
        _toGraduated();
    }

    function testProperty_AUDIT_U7_everyIndexHasOneCommittedLeaf() public view {
        for (uint256 id = 1; id <= editionSize; ++id) {
            this.checkIndex(id); // reset scratch memory for each complete proof
        }
    }

    function checkIndex(uint256 id) external view {
        ItemReveal memory r = _data(id);
        bytes32 leaf = collection.leafOf(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt);
        assertEq(_fold(id, leaf, r.proof), collection.revealRoot());
        uint256 other = id == editionSize ? 1 : id + 1;
        ItemReveal memory wrong = _data(other);
        bytes32 otherLeaf = collection.leafOf(
            other, wrong.traitsPacked, wrong.imageHash, wrong.avatarHash, wrong.modelHash, wrong.salt
        );
        assertNotEq(_fold(id, otherLeaf, r.proof), collection.revealRoot(), "wrong item at this index");
    }

    function _fold(uint256 id, bytes32 h, bytes32[] memory p) private pure returns (bytes32) {
        uint256 index = id - 1;
        for (uint256 i; i < p.length; ++i) {
            h = index & 1 == 0 ? keccak256(abi.encode(h, p[i])) : keccak256(abi.encode(p[i], h));
            index >>= 1;
        }
        return h;
    }

    function testFuzz_AUDIT_U7_revealBindsFieldsPositionAndDepth(uint256 seed, uint256 mutation) public {
        uint256 id = 1 + seed % editionSize;
        ItemReveal memory r = _data(id);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealable.selector, id));
        collection.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof);
        vm.prank(a.tickets);
        vault.deliverTicket(id, eoa[0]);
        ItemReveal memory wrong = _data(id);
        mutation %= 10;
        if (mutation == 0) wrong.traitsPacked ^= 1;
        else if (mutation == 1) wrong.imageHash ^= bytes32(uint256(1));
        else if (mutation == 2) wrong.avatarHash ^= bytes32(uint256(1));
        else if (mutation == 3) wrong.modelHash ^= bytes32(uint256(1));
        else if (mutation == 4) wrong.salt ^= bytes32(uint256(1));
        else if (mutation == 5) wrong.proof[seed % wrong.proof.length] ^= bytes32(uint256(1));
        else if (mutation == 6) wrong.proof = new bytes32[](r.proof.length - 1);
        else if (mutation == 7) wrong.proof = new bytes32[](r.proof.length + 1);
        else if (mutation == 8) wrong = _data(id == editionSize ? 1 : id + 1);
        else wrong.proof = _data(id == editionSize ? 1 : id + 1).proof;
        (bool ok, bytes memory err) = a.collection.call(_revealCall(id, wrong));
        assertFalse(ok);
        assertEq(bytes4(err), IBoxCollection.InvalidProof.selector);
        assertEq(collection.revealedCount(), 0);
        vm.prank(eoa[7]);
        (ok,) = a.collection.call(_revealCall(id, r));
        assertTrue(ok, "anyone with the correct proof");
        assertEq(collection.revealedCount(), 1);
        assertTrue(collection.isRevealed(id));
        (ok, err) = a.collection.call(_revealCall(id, r));
        assertFalse(ok);
        assertEq(bytes4(err), IBoxCollection.AlreadyRevealed.selector);
        assertEq(collection.revealedCount(), 1);
    }
}

/// @notice The former rehearsal edition: depth 13 rather than 11, with non-power-of-two padding.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneReveal4269 is AuditU7LaneReveal1969 {
    function _auditN() internal pure override returns (uint256) {
        return 4269;
    }
}
