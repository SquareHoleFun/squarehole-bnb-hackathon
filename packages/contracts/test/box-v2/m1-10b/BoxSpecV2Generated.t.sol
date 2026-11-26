// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV2} from "../../../src/box-v2/BoxSpecV2.sol";
import {BoxSpec, BoxType, ReleaseContext, Listing} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Dest, Leg, Split} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ReleaseConstantsV2} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxSpecV2VectorsFile} from "./BoxSpecV2VectorsFile.sol";

/// @notice M1-10-b (BoxSpec v2 generators): the generated `BoxSpecV2` library on the format 2 vectors
/// (`BoxSpecV2VectorsFile`: M1-10-a's box-spec-v2.json), which vitest
/// runs on the generated TypeScript twin (packages/box-spec/src/m1-10b/generators-v2.test.ts). Each vector is ABI bytes
/// of M1-00's frozen `BoxSpec` with a verdict declared by hand; both twins must return it and the same spec hash. BC-230
/// maps both matrices in coverage.v2.json.
contract BoxSpecV2GeneratedTest is BoxSpecV2VectorsFile {
    string internal vectorsFile;
    bytes[] internal contextBytes;
    string[] internal contextNames;

    function setUp() public {
        vectorsFile = _vectorsFile();
        string memory json = vm.readFile(vectorsFile);
        uint256 contextCount = vm.parseJsonUint(json, ".contextCount");
        for (uint256 i; i < contextCount; ++i) {
            string memory at = string.concat(".contexts[", vm.toString(i), "]");
            contextBytes.push(vm.parseJsonBytes(json, string.concat(at, ".encoded")));
            contextNames.push(vm.parseJsonString(json, string.concat(at, ".name")));
        }
    }

    function _context(string memory name) internal view returns (ReleaseContext memory) {
        for (uint256 i; i < contextNames.length; ++i) {
            if (keccak256(bytes(contextNames[i])) == keccak256(bytes(name))) {
                return abi.decode(contextBytes[i], (ReleaseContext));
            }
        }
        revert(string.concat("no vector context ", name));
    }

    function _vector(string memory file, uint256 i) internal view returns (BoxSpec memory) {
        bytes[] memory encoded = vm.parseJsonBytesArray(vm.readFile(file), ".columns.encoded");
        return abi.decode(encoded[i], (BoxSpec));
    }

    /// M1-10 requires the real source and its independently declared vectors.
    function test_M110b_theLibraryReadsTheVectorsOfItsOwnSource() public view {
        assertFalse(BoxSpecV2.SOURCE_IS_STUB, "M1-10 must use the real source");
        assertEq(vectorsFile, REAL_VECTORS);
    }

    /// Every vector: the declared (reason, field), the spec hash, and abi.encode of the decoded frozen struct giving
    /// back the exact bytes viem wrote (wire parity of the nested tuples).
    function test_BC230_theFormat2TwinsAgree() public view {
        string memory json = vm.readFile(vectorsFile);
        string[] memory names = vm.parseJsonStringArray(json, ".columns.name");
        uint256[] memory contextOf = vm.parseJsonUintArray(json, ".columns.context");
        uint256[] memory reasons = vm.parseJsonUintArray(json, ".columns.reason");
        uint256[] memory fields = vm.parseJsonUintArray(json, ".columns.field");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".columns.specHash");
        bytes[] memory encoded = vm.parseJsonBytesArray(json, ".columns.encoded");
        uint256 count = vm.parseJsonUint(json, ".count");
        assertEq(encoded.length, count);
        assertGt(count, 30, "the vectors cover the vocabulary");
        uint256 accepted;
        for (uint256 i; i < count; ++i) {
            BoxSpec memory s = abi.decode(encoded[i], (BoxSpec));
            assertEq(keccak256(abi.encode(s)), keccak256(encoded[i]), string.concat(names[i], ": re-encoding"));
            ReleaseContext memory ctx = abi.decode(contextBytes[contextOf[i]], (ReleaseContext));
            (uint16 reason, uint16 field) = BoxSpecV2.validate(s, ctx);
            assertEq(reason, reasons[i], string.concat(names[i], ": reason"));
            assertEq(field, fields[i], string.concat(names[i], ": field"));
            assertEq(BoxSpecV2.specHash(s), hashes[i], string.concat(names[i], ": hash"));
            if (reason == BoxSpecV2.REASON_OK) ++accepted;
        }
        assertGt(accepted, 5, "valid specs are part of the vectors");
        assertGt(count - accepted, 20, "refused specs are part of the vectors");
    }

}
