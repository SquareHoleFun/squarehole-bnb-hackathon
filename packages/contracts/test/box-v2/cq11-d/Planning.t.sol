// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {ListingsDTest} from "./Listings.t.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxSpec, ReleaseContext} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {QParameters} from "../../../src/box-v2/interfaces/IListingRegistry.sol";

contract PlanningDTest is ListingsDTest {
    BoxFactoryV2Planner internal planner;
    BoxFactoryV2Planner.Release internal release;

    function setUp() public override {
        super.setUp();
        address validator = deployCode("BoxSpecV2Validator.sol:BoxSpecV2Validator");
        planner = BoxFactoryV2Planner(deployCode("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts"))));
        release.factory = address(this);
        release.registry = address(this);
        release.listingRegistry = address(registry);
        release.poolManager = manager;
        for (uint256 i; i < 9; ++i) {
            release.implementations[i] = validator;
        }
    }

    function boxCount() external pure returns (uint256) {
        return 42;
    }

    function spec() internal view returns (BoxSpec memory s) {
        s.format = 2;
        s.version = 2;
        s.boxType = 3;
        s.tokenName = "Token";
        s.tokenSymbol = "TOK";
        s.raise = registry.listing(0).raise;
        s.layout = 1;
        s.gradLayout = 3;
        s.launchFormat = 1;
        s.deadlineDays = 30;
        s.buyers.split = 1;
        s.buyers.a.leg = 2;
        s.buyers.a.dest = 1;
        s.sellers.split = 1;
        s.sellers.a.leg = 2;
        s.sellers.a.dest = 1;
        s.coverSha256 = bytes32(uint256(1));
    }

    function test_currentListingOnlyAndStaleRaiseRefused() public {
        BoxSpec memory s = spec();
        assertEq(planner.refusal(release, s).length, 0);
        ReleaseContext memory ctx = planner.context(release, s);
        assertEq(ctx.listing.raise, s.raise);
        registry.updateRaise(0, 8.4 ether);
        bytes memory err = planner.refusal(release, s);
        assertGt(err.length, 0);
        assertEq(bytes4(err), IBoxFactoryV2.InvalidSpec.selector);
        s.raise = 8.4 ether;
        assertEq(planner.refusal(release, s).length, 0);
        s.pricing.listingId = 99;
        assertGt(planner.refusal(release, s).length, 0);
    }

    function test_raiseChangesBothPredictionsButNotOldPlanOrThresholds() public {
        BoxSpec memory s = spec();
        BoxFactoryV2Planner.Plan memory old = planner.plan(release, address(this), s, bytes32(0), bytes32(0));
        assertEq(old.nonces, hex"01050608");
        assertEq(old.roles[9], address(0));
        assertEq(old.roles[11], address(0));
        assertEq(old.roles[13], address(0));
        assertEq(old.codes.length, 4);
        assertEq(old.boxId, 42);
        registry.updateRaise(0, 8.4 ether);
        QParameters memory oldQ = planner.boxQParameters(release, 0, s.raise);
        assertEq(abi.encode(oldQ), abi.encode(old.q));
        s.raise = 8.4 ether;
        BoxFactoryV2Planner.Plan memory fresh = planner.plan(release, address(this), s, bytes32(0), bytes32(0));
        assertNotEq(old.specHash, fresh.specHash);
        assertNotEq(old.roles[0], fresh.roles[0]);
        assertNotEq(old.roles[2], fresh.roles[2]);
        assertNotEq(keccak256(old.coordinatorInit), keccak256(fresh.coordinatorInit));
        assertGt(fresh.q.bootstrapQ, old.q.bootstrapQ);
        assertEq(old.templateId, fresh.templateId);
    }

    function test_partsEncodeEveryMenuChoiceWithoutRetiredParts() public {
        BoxFactoryV2Parts parts = new BoxFactoryV2Parts();
        BoxFactoryV2Parts.Box memory b;
        b.nonces = hex"05";
        b.boxId = 42;
        b.q = QParameters(1, 2, 3, 4);
        BoxSpec memory s = spec();
        for (uint8 choice = 1; choice <= 3; ++choice) {
            s.buyers.a.leg = choice == 2 ? 2 : 1;
            s.buyers.a.dest = choice == 1 ? 2 : choice == 2 ? 1 : 4;
            (bytes[] memory args,) = parts.partArgs(b, s);
            assertEq(args[0].length, 263);
            assertEq(uint8(args[0][220]), choice);
            assertEq(uint8(args[0][221]), 2);
        }
    }
    function test_realCoordinatorAndRegistryRetainCreationRaise() public {
        BoxRegistryV2 boxes = new BoxRegistryV2(address(this), new address[](0));
        release.registry = address(boxes);
        release.implementations[0] = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(manager, address(this)));
        BoxSpec memory s = spec();
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, address(this), s, bytes32(0), bytes32(0));
        bytes memory init = p.coordinatorInit; bytes32 salt = p.salt; address c;
        assembly ("memory-safe") { c := create2(0, add(init, 32), mload(init), salt) }
        assertEq(c, p.roles[0]);
        assertEq(IBoxCoordinator(c).raise(), s.raise);
        boxes.record(c, p.templateId, abi.encode(s));
        registry.updateRaise(0, 8.4 ether);
        assertEq(IBoxCoordinator(c).raise(), s.raise);
        assertEq(boxes.recordOf(0).raise, s.raise);
        assertEq(boxes.recordOf(0).specHash, p.specHash);
    }

}
