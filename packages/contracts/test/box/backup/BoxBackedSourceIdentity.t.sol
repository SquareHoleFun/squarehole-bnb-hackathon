// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @title BoxBackedSourceIdentityTest (F143: what the backup leaves unchanged)
/// @notice BoxTickets and DrandSource are byte for byte `core-v21-rc7`'s (commit 7be0cda9c): their creation code's
/// sha256 (of the lower-case hex text, scripts/bytecode-hashes.py's format) equals rc7's box0 pin
/// (test/vectors/box0-pin/box0-pin.v1.json at the tag) in this build, default or rehearsal; the DrandSource's init code
/// hash is still `DrandSourcePins.INIT_CODE_HASH`, so its pinned address and code are rc7's. The backup lives only in
/// the new BoxBackedSource: no consumer and no drand code changed.
contract BoxBackedSourceIdentityTest is Test {
    string internal constant TICKETS_RC7_DEFAULT = "220f251969028787823038fd2e1d41c1d966dc728bd6e0e47a4b22768b0dce55";
    string internal constant TICKETS_RC7_REHEARSAL = "4cf4df09d8cd2326707c9bd2df197e01d6fd3991f7f86e1337087bfd1e6f779e";
    string internal constant DRAND_RC7 = "a9cb29703dbba70f04d7e1a7c0d46be75a6262fa20d27250ff308d66195897f5";
    bytes32 internal constant DRAND_RC7_INIT_CODE_HASH =
        0x62dddec17789f5c5d01823829943fd55e7a5241badaf36c824f11d8b9ef8895b;

    function _sha(bytes memory code) internal pure returns (string memory) {
        bytes memory text = bytes(vm.toString(code));
        bytes memory hexOnly = new bytes(text.length - 2);
        for (uint256 i; i < hexOnly.length; ++i) {
            hexOnly[i] = text[i + 2];
        }
        bytes memory h = bytes(vm.toString(sha256(hexOnly)));
        bytes memory out = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            out[i] = h[i + 2];
        }
        return string(out);
    }

    function test_ticketsAndDrandSource_byteIdenticalToRc7() public pure {
        bool rehearsal = BoxBuildV1.REFUSED_CHAIN_ID == 1;
        assertEq(
            _sha(type(BoxTickets).creationCode),
            rehearsal ? TICKETS_RC7_REHEARSAL : TICKETS_RC7_DEFAULT,
            "BoxTickets is rc7's (this build)"
        );
        assertEq(_sha(type(DrandSource).creationCode), DRAND_RC7, "DrandSource is rc7's");
        assertEq(keccak256(type(DrandSource).creationCode), DRAND_RC7_INIT_CODE_HASH, "DrandSource's init code");
        assertEq(DrandSourcePins.INIT_CODE_HASH, DRAND_RC7_INIT_CODE_HASH, "its pin unchanged");
        assertEq(type(BoxTickets).creationCode.length > 0, true);
    }
}
