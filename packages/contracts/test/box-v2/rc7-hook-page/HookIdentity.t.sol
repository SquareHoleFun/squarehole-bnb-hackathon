// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";

/// HP-3: run unchanged before/after the hook edit to compare CREATE2 inputs and release identities.
contract HookIdentityTest is M132aBase {
    function test_hookCloneAddressAndReleaseIdentity() public {
        BoxSpec memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        (address coordinator, address token, bytes32 initHash) = factory.predictBox(CREATOR, s, cs);
        address predicted = factory.predictHook(CREATOR, s, cs, hs);
        BoxCoordinatorV2 created = _create(s);
        assertEq(address(created), coordinator);
        assertEq(created.token(), token);
        assertEq(created.hook(), predicted);
        assertEq(uint160(predicted) & 0x3fff, 0x2AE0);
        assertTrue(uint160(predicted) >> 152 != 0x91);
        emit log_named_address("hook implementation", release.implementations[2]);
        emit log_named_address("coordinator", coordinator);
        emit log_named_address("hook clone", predicted);
        emit log_named_bytes32("coordinator salt", cs);
        emit log_named_bytes32("hook salt", hs);
        emit log_named_bytes32("hook init hash", initHash);
        emit log_named_bytes32("hook runtime hash", release.implementations[2].codehash);
        emit log_named_bytes32("versionCodeHash", factory.versionCodeHash());
        emit log_named_bytes32("template id", factory.templateIdOf(s));
        emit log_named_uint("hook runtime size", release.implementations[2].code.length);
    }
}
