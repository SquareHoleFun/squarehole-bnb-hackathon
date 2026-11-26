// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreBox0BackupBase} from "../../backup/CoreBox0BackupBase.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";

/// @notice Deterministic test art, committed before factory creation. Every real item has an index-directed proof;
/// no collection/source/vault call is mocked. This replaces only the spec's art commitment, not contract behavior.
contract AuditU6LaneArt {
    bytes32[] internal tree;
    uint256 public immutable width;
    uint256 public immutable first;

    constructor(uint256 n, uint256 first_) {
        first = first_;
        uint256 w = 1;
        while (w < n) w *= 2;
        width = w;
        bytes32[] memory nodes = new bytes32[](2 * w);
        for (uint256 i; i < n; ++i) {
            ItemReveal memory r = data(first_ + i);
            nodes[w + i] =
                keccak256(abi.encode(first_ + i, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt));
        }
        for (uint256 i = w - 1; i > 0; --i) {
            nodes[i] = keccak256(abi.encodePacked(nodes[2 * i], nodes[2 * i + 1]));
        }
        tree = nodes;
    }

    function root() external view returns (bytes32) {
        return tree[1];
    }

    function data(uint256 id) public pure returns (ItemReveal memory r) {
        r.imageHash = keccak256(abi.encode("audit image", id));
        r.avatarHash = keccak256(abi.encode("audit avatar", id));
        r.salt = keccak256(abi.encode("audit salt", id));
    }

    function reveal(uint256 id) external view returns (ItemReveal memory r) {
        r = data(id);
        uint256 depth;
        for (uint256 w = width; w > 1; w /= 2) {
            ++depth;
        }
        r.proof = new bytes32[](depth);
        uint256 node = width + id - first;
        for (uint256 i; i < depth; ++i) {
            r.proof[i] = tree[node ^ 1];
            node /= 2;
        }
    }
}

abstract contract AuditU6LaneBase is CoreBox0BackupBase {
    AuditU6LaneArt internal art;
    BoxToken internal token;
    BoxVault internal vault;
    BoxCollection internal collection;
    address internal alice;
    address internal bob;

    function setUp() public virtual override {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        src = b.source();
        drand = b.drand();
        vm.warp(src.roundTime(r0) - 1 days);
        BoxSpecV1.BoxSpec memory s = _spec();
        s.openAt = _openTime();
        // Test-data construction is not a production transaction (Amsterdam charges state creation separately).
        vm.pauseGasMetering();
        art = new AuditU6LaneArt(s.n, s.firstId);
        vm.resumeGasMetering();
        s.revealRoot = art.root();
        b.build(s);
        a = b.addresses();
        tickets = BoxTickets(a.tickets);
        token = BoxToken(a.token);
        vault = BoxVault(a.vault);
        collection = BoxCollection(a.collection);
        alice = b.alice();
        bob = b.bob();
        b.toBonding(); // one live placeholder, the real launch and real T bought from the curve
        _approve(alice);
        _approve(bob);
        vm.fee(0);
    }

    function _openTime() internal view virtual returns (uint32) {
        return 0;
    }

    function _approve(address who) internal {
        vm.startPrank(who);
        token.approve(a.tickets, type(uint256).max);
        token.approve(a.vault, type(uint256).max);
        collection.setApprovalForAll(a.vault, true);
        vm.stopPrank();
        vm.deal(who, 10 ether);
    }

    function _fund(address who) internal {
        b.buy(who, b.eth(0.5 ether), 0);
        _approve(who);
    }

    function _closeGraduate() internal returns (uint256) {
        b.buy(b.carol(), 3 * b.spec().raise, b.curve().sqrtPriceLowerX96);
        return _graduate();
    }

    function _postRound(uint256 offset) internal {
        uint256 round = r0 + offset;
        if (block.timestamp < src.roundTime(round)) vm.warp(src.roundTime(round));
        drand.postRound(round, _localSig(offset));
    }

    function _ready() internal {
        _closeGraduate();
        _postRound(0);
        tickets.acceptGraduationWord();
    }

    function _take(address who, uint256 count) internal returns (uint256 id) {
        vm.prank(who);
        id = tickets.take(count, type(uint256).max, block.timestamp);
    }

    function _draw(address who, uint256 value) internal returns (uint256 id) {
        vm.prank(who);
        id = tickets.draw{value: value}(type(uint256).max, block.timestamp);
    }

    function _onRound(uint256 offset) internal {
        uint256 at = src.roundTime(r0 + offset) - 12;
        assertGe(at, block.timestamp, "test must never travel back in time");
        vm.warp(at);
        vm.roll(block.number + 1);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _empty() internal view {
        assertEq(token.balanceOf(a.tickets), 0, "no T retained");
        assertEq(a.tickets.balance, 0, "no ETH retained");
        assertEq(tickets.ticketInFlight(), 0, "no draw in flight outside delivery/release");
    }
}
