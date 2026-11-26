// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SepoliaBox0TestSet} from "./lib/SepoliaBox0TestSet.sol";

/// @title SepoliaBox0Reveal
/// @notice The reveal of one item of box 0's Sepolia TEST set (`lib/SepoliaBox0TestSet.sol`; docs/runbooks/sepolia-core-v1.md
/// § After graduation): the `ItemReveal` tuple that `BoxTickets.open(tokenId, r)` and `openDraw(ticketId, to, r)` take,
/// printed as one `cast` argument after `REVEAL|`. Every value follows from the test set's public label; the proof is
/// checked against the committed root before it is printed. Local only: no RPC, no key, nothing signed or sent.
///
///   forge script script/SepoliaBox0Reveal.s.sol --sig 'run(uint256)' <item id>
contract SepoliaBox0Reveal is Script {
    /// @notice The test set's root (test/vectors/box/sepolia-box0-test-set.json `.root`; the Sepolia spec's reveal root).
    bytes32 public constant ROOT = 0xf983840bf08a7deb54c03a65382418390b9cdc259e2152a01d56d340ca3679ec;

    error ProofDoesNotReachTheRoot(uint256 id, bytes32 reached);

    function run(uint256 id) external pure {
        console.log(string.concat("REVEAL|", revealArg(id)));
    }

    /// @notice `(traitsPacked,imageHash,avatarHash,modelHash,salt,[proof...])` for `cast send ... '(uint128,bytes32,
    /// bytes32,bytes32,bytes32,bytes32[])'`.
    function revealArg(uint256 id) public pure returns (string memory s) {
        (SepoliaBox0TestSet.Entry memory e, bytes32[] memory p) = revealOf(id);
        s = string.concat(
            "(",
            _dec(e.traitsPacked),
            ",",
            _hex(e.imageHash),
            ",",
            _hex(e.avatarHash),
            ",",
            _hex(e.modelHash),
            ",",
            _hex(e.salt),
            ",["
        );
        for (uint256 i; i < p.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ",", _hex(p[i]));
        }
        s = string.concat(s, "])");
    }

    /// @notice The leaf preimage and its 13 siblings, the proof checked against `ROOT` as BoxCollection checks it
    /// (index-directed: position id − 1, node = keccak256(left ‖ right)).
    function revealOf(uint256 id) public pure returns (SepoliaBox0TestSet.Entry memory e, bytes32[] memory p) {
        e = SepoliaBox0TestSet.entry(id);
        p = SepoliaBox0TestSet.proof(id);
        bytes32 h = SepoliaBox0TestSet.leafOf(id);
        uint256 index = id - 1;
        for (uint256 i; i < p.length; ++i) {
            h = index & 1 == 0 ? keccak256(abi.encodePacked(h, p[i])) : keccak256(abi.encodePacked(p[i], h));
            index >>= 1;
        }
        if (h != ROOT) revert ProofDoesNotReachTheRoot(id, h);
    }

    function _hex(bytes32 v) private pure returns (string memory) {
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        bytes16 digits = "0123456789abcdef";
        for (uint256 i; i < 32; ++i) {
            out[2 + 2 * i] = digits[uint8(v[i]) >> 4];
            out[3 + 2 * i] = digits[uint8(v[i]) & 0x0f];
        }
        return string(out);
    }

    function _dec(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 x = v; x != 0; x /= 10) {
            ++len;
        }
        bytes memory out = new bytes(len);
        for (; v != 0; v /= 10) {
            // casting to 'uint8' is safe because v % 10 < 10
            // forge-lint: disable-next-line(unsafe-typecast)
            out[--len] = bytes1(uint8(48 + v % 10));
        }
        return string(out);
    }
}
