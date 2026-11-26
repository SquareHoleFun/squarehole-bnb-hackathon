// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PlanningDTest, BoxFactoryV2Planner, BoxSpec} from "../cq11-d/Planning.t.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {ReleaseContext, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";

// Test-only admission: the production M1 validator must continue refusing these M2 choices.
contract M2AdmissionStub {
    function validate(BoxSpec calldata, ReleaseContext calldata) external pure returns (uint16, uint16) { return (0, 0); }
}
contract CreationSlotsTest is PlanningDTest {
    function test_W1_holderSlotsReachTokenReceiverAndHook() public {
        BoxFactoryV2Parts.Box memory b;
        b.roles[17] = address(0x1717);
        b.roles[1] = address(0x7171);
        b.nonces = hex"0105";
        b.q = planner.boxQParameters(release, 0, spec().raise);
        BoxSpec memory s = spec();
        (bytes[] memory args,) = planner.parts().partArgs(b, s);
        assertEq(_address(args[0], 40), b.roles[17], "token ledger clone slot");
        assertEq(_address(args[1], 223), b.roles[17], "receiver ledger clone slot");
        (bytes memory h,) = planner.parts().hookArgs(b.roles, b.q, s);
        assertEq(_address(h, 211), b.roles[17], "hook optional notice slot");
    }
    function test_W1_reservedRolesPredictBeforeDeployWhileM1StillRefuses() public {
        BoxSpec memory s = spec();
        s.boxType = 4;
        s.buyers.a.leg = 1; s.buyers.a.dest = 6; s.buyers.a.destParams = abi.encode(uint8(1));
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(8, abi.encode(bytes32(uint256(42)), uint32(2)));
        assertGt(planner.refusal(release, s).length, 0, "M2 not admitted yet");
        BoxFactoryV2Planner future = new BoxFactoryV2Planner(address(new M2AdmissionStub()), deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts"));
        release.implementations[17] = release.implementations[1];
        release.implementations[19] = release.implementations[1];
        release.implementations[20] = address(new M2AdmissionStub()); // ledger-token implementation slot
        release.implementations[21] = address(new M2AdmissionStub()); // shop implementation slot
        BoxFactoryV2Planner.Plan memory plan = future.plan(release, address(this), s, bytes32(0), bytes32(0));
        assertEq(plan.nonces, hex"01050603081113");
        assertEq(plan.roles[3], vm.computeCreateAddress(plan.roles[0], 4));
        assertEq(plan.roles[17], vm.computeCreateAddress(plan.roles[0], 6));
        assertEq(plan.roles[19], vm.computeCreateAddress(plan.roles[0], 7));
        assertEq(plan.roles[20], address(0), "implementation slots never become per-box roles");
        assertEq(_address(plan.codes[0], 20), release.implementations[20], "ledger token selected");
        assertEq(_address(plan.codes[3], 20), release.implementations[21], "shop selected");
    }
    function test_W1_starterArgumentsHaveOnlyRequiredFixedSlots() public {
        BoxFactoryV2Parts.Box memory b;
        b.roles[0] = address(0xC0); b.roles[3] = address(0x30); b.roles[19] = address(0x190);
        b.nonces = hex"13";
        BoxSpec memory s = spec();
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(8, abi.encode(bytes32(uint256(42)), uint32(2)));
        (bytes[] memory args,) = planner.parts().partArgs(b, s);
        assertEq(args[0].length, 76, "coordinator, shop, commitment, count; creator read from coordinator");
        assertEq(_address(args[0], 0), b.roles[0]);
        assertEq(_address(args[0], 20), b.roles[3]);
    }
    function _address(bytes memory data, uint256 offset) private pure returns (address a) {
        require(data.length >= offset + 20, "missing clone slot");
        assembly ("memory-safe") { a := shr(96, mload(add(add(data, 32), offset))) }
    }
}
