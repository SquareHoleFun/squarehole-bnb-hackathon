// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReferenceViews} from "./ReferenceViews.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";

/// @notice SIZE-2: compare exact return/revert bytes, including 512-bit arithmetic and invalid inputs.
contract MovedResultsTest is Test {
    ReferenceViews private old;
    address private coordinatorViews;
    address private vaultViews;

    function setUp() public {
        old = new ReferenceViews();
        coordinatorViews = deployCode("CoordinatorViews.sol:CoordinatorViews");
        vaultViews = deployCode("VaultViews.sol:VaultViews");
    }

    function testFuzz_nonceTable(bytes24 nonces, uint8 n) public view {
        _same(coordinatorViews, abi.encodeCall(old.checkNonces, (n, nonces)));
    }

    function test_nonceAdmissionAndEveryRoleRefusal() public view {
        bytes memory nonces = new bytes(24);
        nonces[BoxRolesV2.ROLE_TOKEN] = bytes1(uint8(1));
        nonces[BoxRolesV2.ROLE_RECEIVER] = bytes1(uint8(2));
        nonces[BoxRolesV2.ROLE_LAUNCH_ROUTER] = bytes1(uint8(3));
        _same(coordinatorViews, abi.encodeCall(old.checkNonces, (3, bytes24(nonces))));
        for (uint256 role; role < 24; ++role) {
            bytes1 before = nonces[role];
            for (uint256 nonce; nonce <= 128; ++nonce) {
                // Includes zero-required, repeated, forbidden, above-count and highest accepted nonce.
                nonces[role] = bytes1(uint8(nonce));
                _same(coordinatorViews, abi.encodeCall(old.checkNonces, (127, bytes24(nonces))));
            }
            nonces[role] = before;
        }
        _same(coordinatorViews, abi.encodeCall(old.checkNonces, (0, bytes24(nonces))));
        _same(coordinatorViews, abi.encodeCall(old.checkNonces, (128, bytes24(nonces))));
    }

    function testFuzz_claimQuote(uint256 pot, uint256 t, uint256 left) public view {
        _same(coordinatorViews, abi.encodeCall(old.quoteClaim, (pot, t, left)));
        _same(coordinatorViews, abi.encodeCall(old.quoteClaim, (pot, left, left)));
    }

    function testFuzz_vaultQuotes(uint256 a, uint32 rawN, uint32 rawK, uint256 e, uint16 bps) public view {
        uint256 n = uint256(rawN) % 10_001;
        uint256 k = uint256(rawK) % 10_002;
        _same(vaultViews, abi.encodeCall(old.quoteWithdraw, (k, n, a)));
        _same(vaultViews, abi.encodeCall(old.quoteReturn, (k, n, 10_000 - n, a)));
        _same(vaultViews, abi.encodeCall(old.fee, (a, bps)));
        _same(vaultViews, abi.encodeCall(old.surplus, (e, 10_000 - n, a, n)));
    }

    function test_vaultRoundingAndOverflowBoundaries() public view {
        uint256[5] memory amounts = [uint256(0), 1, 10_001, uint256(1) << 255, type(uint256).max];
        for (uint256 i; i < amounts.length; ++i) {
            _same(vaultViews, abi.encodeCall(old.quoteWithdraw, (1, 3, amounts[i])));
            _same(vaultViews, abi.encodeCall(old.quoteReturn, (2, 3, 2, amounts[i])));
            _same(vaultViews, abi.encodeCall(old.fee, (amounts[i], 500)));
            _same(vaultViews, abi.encodeCall(old.fee, (amounts[i], 0)));
            _same(vaultViews, abi.encodeCall(old.surplus, (amounts[i], 2, amounts[i], 3)));
        }
        _same(vaultViews, abi.encodeCall(old.quoteWithdraw, (3, 3, 10)));
        _same(vaultViews, abi.encodeCall(old.quoteReturn, (1, 0, 2, 10)));
    }

    function testFuzz_inversePermutation(bytes32 word, uint32 rawN, uint32 rawOffset) public view {
        uint256 n = 1 + uint256(rawN) % 10_000;
        uint256 offset = uint256(rawOffset) % n;
        _same(vaultViews, abi.encodeCall(old.invert, (word, offset, n)));
    }

    function test_inverseEmptyDomain() public view {
        _same(vaultViews, abi.encodeCall(old.invert, (bytes32(0), 0, 0)));
    }

    function _same(address candidate, bytes memory data) private view {
        (bool expectedOk, bytes memory expected) = address(old).staticcall(data);
        (bool actualOk, bytes memory actual) = candidate.staticcall(data);
        assertEq(actualOk, expectedOk, "success/revert changed");
        assertEq(actual, expected, "return/revert bytes changed");
    }
}
