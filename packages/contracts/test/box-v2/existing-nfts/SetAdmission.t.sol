// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721ALayoutFixture} from "./fixtures/MainstreamERC721.sol";
import {SetAdmissionV2} from "../../../src/box-v2/set/SetAdmissionV2.sol";
import {SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {HostileERC721, GasWindowERC721, UpgradeableFixture} from "./fixtures/HostileERC721.sol";

/// @dev Intentionally non-view entrypoints: prove the library enforces static context inside a normal CALL.
contract AdmissionHarness {
    uint256 public mutations = 1;

    function mutate() external {
        ++mutations;
    }

    function callbackControl() external returns (bool ok) {
        // A nested call, just like the fixture callback; an isolated top-level transaction has other gas costs.
        (ok,) = address(this).call{gas: 16_000}(abi.encodeCall(this.mutate, ()));
    }

    function collection(address nft) external returns (bool) {
        return SetAdmissionV2.requireCollection(nft);
    }

    function token(address nft, uint256 id) external {
        SetAdmissionV2.requireToken(nft, id);
    }

    function owner(address nft, uint256 id, address expected) external {
        SetAdmissionV2.requireOwner(nft, id, expected);
    }

    function intake(address nft, uint256 id, address expected) external {
        SetAdmissionV2.requireToken(nft, id);
        SetAdmissionV2.requireOwner(nft, id, expected);
    }

    // Keep both measurements in one call frame even when Forge isolates top-level calls as transactions.
    function measureIntake(address nft, uint256 id, address expected) external returns (uint256 cold, uint256 warm) {
        uint256 start = gasleft();
        SetAdmissionV2.requireToken(nft, id);
        SetAdmissionV2.requireOwner(nft, id, expected);
        cold = start - gasleft();
        start = gasleft();
        SetAdmissionV2.requireToken(nft, id);
        SetAdmissionV2.requireOwner(nft, id, expected);
        warm = start - gasleft();
    }

    function memoryIntact(address nft) external returns (bytes32) {
        bytes memory before_ = abi.encode(uint256(7), uint256(11), uint256(13));
        bytes32 digest = keccak256(before_);
        SetAdmissionV2.requireToken(nft, type(uint256).max);
        bytes memory after_ = abi.encode(uint256(17), uint256(19));
        require(keccak256(before_) == digest, "memory");
        require(abi.decode(after_, (uint256)) == 17, "allocation");
        return digest;
    }
}

contract SetAdmissionTest is Test {
    AdmissionHarness private harness;
    HostileERC721 private nft;
    bytes4 private constant ERC165 = 0x01ffc9a7;
    bytes4 private constant ERC721 = 0x80ac58cd;
    bytes4 private constant ERC5192 = 0xb45a3c0e;
    bytes4 private constant INVALID = 0xffffffff;
    uint256 private constant ID = type(uint256).max;
    address private constant OWNER = address(0xbeef);

    function setUp() public {
        harness = new AdmissionHarness();
        nft = new HostileERC721();
        nft.mint(OWNER, ID);
    }

    function _supports(bytes4 id) private pure returns (bytes memory) {
        return abi.encodeWithSelector(ERC165, id);
    }

    function _validator() private pure returns (bytes memory) {
        return abi.encodeWithSignature("getTransferValidator()");
    }

    function _locked() private pure returns (bytes memory) {
        return abi.encodeWithSignature("locked(uint256)", ID);
    }

    function _owner() private pure returns (bytes memory) {
        return abi.encodeWithSignature("ownerOf(uint256)", ID);
    }

    function _reply(bytes memory data, HostileERC721.ReplyMode mode, uint256 word, uint256 size) private {
        nft.setReply(data, mode, word, size);
    }

    function _error(uint16 reason) private pure returns (bytes memory) {
        return abi.encodeWithSelector(SetRefused.selector, reason, uint16(10));
    }

    function _collectionRefused(uint16 reason) private {
        vm.expectRevert(_error(reason));
        harness.collection(address(nft));
    }

    function _tokenRefused(uint16 reason) private {
        vm.expectRevert(_error(reason));
        harness.token(address(nft), ID);
    }

    function _ownerRefused() private {
        vm.expectRevert(_error(40));
        harness.owner(address(nft), ID, OWNER);
    }

    function test_E02_erc165TrueFalseInvalidIdMatrix() public {
        for (uint256 mask; mask < 8; ++mask) {
            _reply(_supports(ERC165), HostileERC721.ReplyMode.Return, mask & 1, 32);
            _reply(_supports(INVALID), HostileERC721.ReplyMode.Return, (mask >> 1) & 1, 32);
            _reply(_supports(ERC721), HostileERC721.ReplyMode.Return, (mask >> 2) & 1, 32);
            if (mask == 5) assertFalse(harness.collection(address(nft)));
            else _collectionRefused(37);
        }
    }

    function test_E02_erc1155OnlyRefusedAndDualInterfaceAllowed() public {
        _reply(_supports(0xd9b67a26), HostileERC721.ReplyMode.Return, 1, 32);
        _reply(_supports(ERC721), HostileERC721.ReplyMode.Return, 0, 32);
        _collectionRefused(37);
        _reply(_supports(ERC721), HostileERC721.ReplyMode.Return, 1, 32);
        harness.token(address(nft), ID);
    }

    function test_E02_zeroEOAPrecompileAndRemovedCodeRefused() public {
        address[4] memory addresses = [address(0), OWNER, address(1), address(nft)];
        vm.etch(address(nft), hex"");
        for (uint256 i; i < addresses.length; ++i) {
            vm.expectRevert(_error(36));
            harness.collection(addresses[i]);
        }
    }

    function test_E02_everyInterfaceRejectsRevertOOGAndWrongLength() public {
        bytes4[4] memory ids = [ERC165, INVALID, ERC721, ERC5192];
        uint256[6] memory sizes = [uint256(0), 1, 31, 33, 64, 65_536];
        for (uint256 i; i < ids.length; ++i) {
            bytes memory data = _supports(ids[i]);
            uint256 word = i == 0 || i == 2 ? 1 : 0;
            _reply(data, HostileERC721.ReplyMode.Revert, word, 65_536);
            _collectionRefused(37);
            _reply(data, HostileERC721.ReplyMode.BurnGas, word, 0);
            _collectionRefused(37);
            for (uint256 j; j < sizes.length; ++j) {
                _reply(data, HostileERC721.ReplyMode.Return, word, sizes[j]);
                _collectionRefused(37);
            }
            _reply(data, HostileERC721.ReplyMode.Default, 0, 0);
        }
    }

    function testFuzz_E02_noncanonicalInterfaceBools(uint256 word) public {
        word = bound(word, 2, type(uint256).max);
        bytes4[4] memory ids = [ERC165, INVALID, ERC721, ERC5192];
        for (uint256 i; i < ids.length; ++i) {
            _reply(_supports(ids[i]), HostileERC721.ReplyMode.Return, word, 32);
            _collectionRefused(37);
            _reply(_supports(ids[i]), HostileERC721.ReplyMode.Default, 0, 0);
        }
    }

    function test_E02_validatorAbsentEmptyRevertingAndOOGAreUndetected() public {
        harness.collection(address(nft)); // unknown selector reverts
        _reply(_validator(), HostileERC721.ReplyMode.Return, 0, 0);
        harness.collection(address(nft));
        _reply(_validator(), HostileERC721.ReplyMode.Revert, 0, 0);
        harness.collection(address(nft));
        _reply(_validator(), HostileERC721.ReplyMode.Revert, 1, 65_536);
        harness.collection(address(nft));
        _reply(_validator(), HostileERC721.ReplyMode.BurnGas, 0, 0);
        harness.collection(address(nft));
    }

    function test_E02_validatorZeroNonzeroDirtyAndOddRepliesRefused() public {
        uint256[4] memory words = [uint256(0), 1, uint256(type(uint160).max), uint256(1) << 160];
        for (uint256 i; i < words.length; ++i) {
            _reply(_validator(), HostileERC721.ReplyMode.Return, words[i], 32);
            _collectionRefused(38);
        }
        uint256[5] memory sizes = [uint256(1), 31, 33, 64, 65_536];
        for (uint256 i; i < sizes.length; ++i) {
            _reply(_validator(), HostileERC721.ReplyMode.Return, 0, sizes[i]);
            _collectionRefused(38);
        }
    }

    function test_E02_lockedUnsupportedFalseTrueAndChangedAfterObservation() public {
        _reply(_locked(), HostileERC721.ReplyMode.BurnGas, 0, 0);
        harness.token(address(nft), ID); // not queried without ERC-5192
        nft.setSupports5192(true);
        assertTrue(harness.collection(address(nft))); // no token-specific query at creation
        _tokenRefused(39);
        _reply(_locked(), HostileERC721.ReplyMode.Default, 0, 0);
        harness.intake(address(nft), ID, OWNER);
        nft.setLocked(ID, true);
        _tokenRefused(39);
        nft.setLocked(ID, false);
        harness.intake(address(nft), ID, OWNER);
        _reply(_validator(), HostileERC721.ReplyMode.Return, 0, 32);
        _tokenRefused(38); // collection-level rules are repeated too
    }

    function test_E02_lockedRevertOOGMalformedAndHugeRefused() public {
        nft.setSupports5192(true);
        _reply(_locked(), HostileERC721.ReplyMode.Revert, 0, 65_536);
        _tokenRefused(39);
        _reply(_locked(), HostileERC721.ReplyMode.BurnGas, 0, 0);
        _tokenRefused(39);
        uint256[6] memory sizes = [uint256(0), 1, 31, 33, 64, 65_536];
        for (uint256 i; i < sizes.length; ++i) {
            _reply(_locked(), HostileERC721.ReplyMode.Return, 0, sizes[i]);
            _tokenRefused(39);
        }
    }

    function testFuzz_E02_lockedOnlyCanonicalFalse(uint256 word) public {
        nft.setSupports5192(true);
        _reply(_locked(), HostileERC721.ReplyMode.Return, word, 32);
        if (word == 0) harness.token(address(nft), ID);
        else _tokenRefused(39);
    }

    function test_E02_approveButNotOwnerAndSeizedOrBurned() public {
        vm.prank(OWNER);
        nft.approve(address(harness), ID);
        assertEq(nft.getApproved(ID), address(harness));
        vm.expectRevert(_error(40));
        harness.owner(address(nft), ID, address(harness));
        harness.owner(address(nft), ID, OWNER);
        nft.seize(ID, address(0xcafe));
        _ownerRefused();
        nft.burn(ID);
        _ownerRefused();
    }

    function test_E02_ownerRejectsRevertOOGZeroDirtyAndHuge() public {
        _reply(_owner(), HostileERC721.ReplyMode.Revert, uint160(OWNER), 65_536);
        _ownerRefused();
        _reply(_owner(), HostileERC721.ReplyMode.BurnGas, 0, 0);
        _ownerRefused();
        _reply(_owner(), HostileERC721.ReplyMode.Return, (uint256(1) << 160) | uint160(OWNER), 32);
        _ownerRefused();
        _reply(_owner(), HostileERC721.ReplyMode.Return, 0, 32);
        vm.expectRevert(_error(40));
        harness.owner(address(nft), ID, address(0));
        uint256[6] memory sizes = [uint256(0), 1, 31, 33, 64, 65_536];
        for (uint256 i; i < sizes.length; ++i) {
            _reply(_owner(), HostileERC721.ReplyMode.Return, uint160(OWNER), sizes[i]);
            _ownerRefused();
        }
    }

    function test_E02_staticContextBlocksFixtureWritesAtEveryProbe() public {
        nft.setSupports5192(true);
        bytes[7] memory calls = [
            _supports(ERC165),
            _supports(INVALID),
            _supports(ERC721),
            _validator(),
            _supports(ERC5192),
            _locked(),
            _owner()
        ];
        for (uint256 i; i < calls.length; ++i) {
            uint256 word = i == 0 || i == 2 || i == 4 ? 1 : (i == 6 ? uint160(OWNER) : 0);
            _reply(calls[i], HostileERC721.ReplyMode.WriteState, word, 32);
            if (i == 3) {
                harness.intake(address(nft), ID, OWNER); // failed optional probe is absence
            } else {
                vm.expectRevert(_error(i < 5 ? 37 : (i == 5 ? 39 : 40)));
                harness.intake(address(nft), ID, OWNER);
            }
            assertEq(nft.mutations(), 0);
            // Positive control: this fixture really writes under an ordinary CALL.
            (bool ok,) = address(nft).call(calls[i]);
            assertTrue(ok);
            assertEq(nft.mutations(), 1);
            // Do not rely on storage layout for the next case: deploy a fresh fixture.
            nft = new HostileERC721();
            nft.mint(OWNER, ID);
            nft.setSupports5192(true);
        }
    }

    function test_E02_staticContextBlocksReentrantStateChangesAtEveryProbe() public {
        nft.setSupports5192(true);
        nft.setCallback(address(harness), abi.encodeCall(harness.mutate, ()));
        bytes[7] memory calls = [
            _supports(ERC165),
            _supports(INVALID),
            _supports(ERC721),
            _validator(),
            _supports(ERC5192),
            _locked(),
            _owner()
        ];
        for (uint256 i; i < calls.length; ++i) {
            uint256 word = i == 0 || i == 2 || i == 4 ? 1 : (i == 6 ? uint160(OWNER) : 0);
            _reply(calls[i], HostileERC721.ReplyMode.Callback, word, i == 3 ? 0 : 32);
            harness.intake(address(nft), ID, OWNER);
            assertEq(harness.mutations(), 1);
            assertEq(nft.mutations(), 0);
            _reply(calls[i], HostileERC721.ReplyMode.Default, 0, 0);
        }
        assertTrue(harness.callbackControl());
        assertEq(harness.mutations(), 2);
    }

    function test_E02_metadataNeverReadAndMemoryIntact() public {
        nft.setSupports5192(true);
        nft.setMetadata(7, true, 65_536);
        assertEq(harness.memoryIntact(address(nft)), keccak256(abi.encode(uint256(7), uint256(11), uint256(13))));
        nft.setMetadata(9, false, 65_536);
        harness.intake(address(nft), ID, OWNER);
        nft.mint(OWNER, 0);
        harness.intake(address(nft), 0, OWNER);
    }

    function test_E02_fakeOwnerIsAnObservationNotCustodyProof() public {
        _reply(_owner(), HostileERC721.ReplyMode.Return, uint160(address(harness)), 32);
        harness.owner(address(nft), ID, address(harness));
        assertEq(nft.actualOwner(ID), OWNER);
    }

    function test_E02_upgradedCollectionRechecked() public {
        UpgradeableFixture proxy = new UpgradeableFixture(address(nft));
        harness.token(address(proxy), ID);
        proxy.upgradeTo(address(new GasWindowERC721(0, 0)));
        vm.expectRevert(_error(37));
        harness.token(address(proxy), ID);
    }

    function test_E09C_separateProbeAndOwnerBudgetsColdAndWarm() public {
        GasWindowERC721 meter = new GasWindowERC721(29_500, 30_000);
        vm.cool(address(meter));
        harness.token(address(meter), ID);
        harness.token(address(meter), ID);
        GasWindowERC721 ownerMeter = new GasWindowERC721(299_500, 300_000);
        vm.cool(address(ownerMeter));
        harness.owner(address(ownerMeter), ID, OWNER);
        harness.owner(address(ownerMeter), ID, OWNER);
        // The upper/lower assertions really reject a wrong budget, rather than silently accepting it.
        GasWindowERC721 needsMore = new GasWindowERC721(30_001, 40_000);
        GasWindowERC721 needsLess = new GasWindowERC721(0, 20_000);
        vm.expectRevert(_error(37));
        harness.token(address(needsMore), ID);
        vm.expectRevert(_error(37));
        harness.token(address(needsLess), ID);
    }

    function test_E02_lowOuterGasFailsClosedIncludingOptionalProbe() public {
        GasWindowERC721 meter = new GasWindowERC721(29_500, 30_000);
        bytes memory data = abi.encodeCall(harness.token, (address(meter), ID));
        bool observedRefusal;
        bool observedSuccess;
        for (uint256 cap = 25_000; cap <= 110_000; cap += 1_000) {
            (bool ok, bytes memory result) = address(harness).call{gas: cap}(data);
            if (ok) {
                observedSuccess = true;
            } else {
                observedRefusal = true;
                assertEq(result, _error(41)); // never an underfunded probe misclassified as absent/invalid
            }
        }
        assertTrue(observedRefusal);
        assertTrue(observedSuccess);
    }

    function test_E09C_ownerFloorNeverClipsTheStipend() public {
        GasWindowERC721 meter = new GasWindowERC721(299_500, 300_000);
        bytes memory data = abi.encodeCall(harness.owner, (address(meter), ID, OWNER));
        bool refused;
        bool succeeded;
        for (uint256 cap = 300_000; cap <= 350_000; cap += 1_000) {
            vm.cool(address(meter));
            (bool ok, bytes memory result) = address(harness).call{gas: cap}(data);
            if (ok) {
                succeeded = true;
            } else {
                refused = true;
                assertEq(result, _error(41));
            }
        }
        assertTrue(refused);
        assertTrue(succeeded);
    }

    function test_E09C_coldERC721AWalkAtDepth11_12_30_50_99() public {
        ERC721ALayoutFixture lazy = new ERC721ALayoutFixture();
        lazy.mintBatch(OWNER, 100);
        uint256[5] memory depths = [uint256(11), 12, 30, 50, 99];
        for (uint256 i; i < depths.length; ++i) {
            vm.cool(address(lazy));
            harness.owner(address(lazy), 3 + depths[i], OWNER);
        }
    }

    function test_E02_gasEvidenceBoundedBombsAndOOG() public {
        nft.setSupports5192(true);
        vm.cool(address(nft));
        (uint256 cold, uint256 warm) = harness.measureIntake(address(nft), ID, OWNER);
        assertLt(warm, cold);
        emit log_named_uint("cold intake probes (inside harness)", cold);
        emit log_named_uint("warm intake probes (same frame)", warm);
        _reply(_validator(), HostileERC721.ReplyMode.BurnGas, 0, 0);
        _reply(_locked(), HostileERC721.ReplyMode.BurnGas, 0, 0);
        uint256 start = gasleft();
        (bool ok, bytes memory result) =
            address(harness).call{gas: 300_000}(abi.encodeCall(harness.token, (address(nft), ID)));
        uint256 spent = start - gasleft();
        assertFalse(ok);
        assertEq(result, _error(39));
        assertLt(spent, 200_000);
        emit log_named_uint("two exhausted probes", spent);
        _reply(_supports(ERC165), HostileERC721.ReplyMode.Return, 1, 65_536);
        start = gasleft();
        (ok, result) = address(harness).call{gas: 100_000}(abi.encodeCall(harness.collection, (address(nft))));
        spent = start - gasleft();
        assertFalse(ok);
        assertEq(result, _error(37));
        assertLt(spent, 60_000);
        emit log_named_uint("65536-byte response refused", spent);
    }
}
