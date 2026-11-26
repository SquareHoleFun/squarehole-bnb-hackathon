// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "./M132aBase.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract M132aRereadsTest is M132aBase {
    function _rejectRead(uint256 role, string memory sig, uint256 answer, uint256 check, bool art) internal {
        BoxSpec memory s = role >= 7 ? _hiddenSpec() : art ? _collectionSpec() : _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        vm.mockCall(p.roles[role], abi.encodeWithSelector(bytes4(keccak256(bytes(sig)))), abi.encode(answer));
        // mockCall gives an empty target code; clear that synthetic code so CREATE can deploy the real clone.
        vm.etch(p.roles[role], "");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.Miswired.selector, check));
        vm.prank(CREATOR);
        factory.createBox{value: p.payment}(s, cs, hs);
        assertEq(registry.boxCount(), 0);
        assertEq(p.roles[0].code.length, 0);
    }

    function test_hookPoolIdOffPlanRollsBackPayment() public {
        _rejectRead(2, "poolId()", 123, 202, false);
    }

    function test_tokenSupplyWithoutBootstrapBurnRefused() public {
        _rejectRead(1, "totalSupply()", 1e27, 201, false);
    }

    function test_routerMustHaveBootstrapped() public {
        _rejectRead(6, "bootstrapped()", 0, 206, false);
    }

    function test_receiverChoiceOffSpecRefused() public {
        _rejectRead(5, "buyersChoice()", 1, 205, false);
    }

    function test_vaultMustOwnItsInitialItems() public {
        _rejectRead(3, "inside()", 0, 203, true);
    }

    function test_collectionSizeOffSpecRefused() public {
        _rejectRead(4, "collectionSize()", 1, 204, true);
    }

    function test_ticketSourceOffReleaseRefused() public {
        _rejectRead(7, "source()", 123, 207, true);
    }

    function test_royaltyReceiverOffPlanRefused() public {
        _rejectRead(8, "receiver()", 123, 208, true);
    }

    function test_coordinatorCreatorOffCallerRefused() public {
        _rejectRead(0, "creator()", 123, 1, false);
    }

    function test_receiverRegistryOffReleaseRefused() public {
        _rejectRead(5, "registry()", 123, 105, false);
    }
}
