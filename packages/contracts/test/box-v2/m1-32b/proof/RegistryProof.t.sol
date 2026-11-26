// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "../../m1-32a/M132aBase.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxCoordinatorV2} from "../../../../src/box-v2/BoxCoordinatorV2.sol";

contract RegistryProofTest is M132aBase {
    function testFuzz_creationCommitmentSurvivesTimeAndListingChange(uint32 elapsed) public {
        BoxSpec memory s = _spec();
        _create(s);
        (,,,, bytes32 hash) = registry.entry(0);
        vm.warp(block.timestamp + uint256(elapsed));
        vm.roll(block.number + 100);
        listings.updateRaise(0, 8 ether);
        assertEq(keccak256(abi.encode(registry.recordOf(0))), hash);
    }

    function test_replacedCodeIsDetectableAgainstStoredRecordHash() public {
        BoxCoordinatorV2 c = _create(_spec());
        (,,,, bytes32 hash) = registry.entry(0);
        vm.etch(c.token(), hex"00");
        assertNotEq(keccak256(abi.encode(registry.recordOf(0))), hash);
    }
}
