// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReferenceModel} from "./ReferenceModel.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {QParameters, ListingClass, IListingRegistry} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {KitPlainToken} from "../m1-20c/M1_20cTokens.sol";

contract RaiseReferenceTest is ReferenceModel {
    ListingRegistry internal listings;
    BoxRegistryV2 internal boxes;
    BoxFactoryV2Planner internal planner;
    BoxFactoryV2Planner.Release internal release;

    function setUp() public {
        address manager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        boxes = new BoxRegistryV2(address(this), new address[](0));
        listings = ListingRegistry(
            deployCode(
                "ListingRegistry.sol:ListingRegistry",
                abi.encode(address(this), address(boxes), manager, address(0x777))
            )
        );
        address validator = deployCode("BoxSpecV2Validator.sol:BoxSpecV2Validator");
        planner = BoxFactoryV2Planner(deployCode("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts"))));
        release.factory = address(this);
        release.registry = address(boxes);
        release.listingRegistry = address(listings);
        release.poolManager = manager;
        for (uint256 i; i < 9; ++i) {
            release.implementations[i] = validator;
        }
        release.implementations[0] =
            deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(manager, address(this)));
    }

    function testFuzz_creationSnapshotSurvivesUpdate(uint128 oldSeed, uint128 newSeed, uint8 asset)
        public
        checkedModel
    {
        (oldSeed, newSeed, asset) =
            abi.decode(modelCase("raise", abi.encode(oldSeed, newSeed, asset)), (uint128, uint128, uint8));
        uint256 oldRaise = bound(oldSeed, 1_000_000, type(uint128).max);
        uint256 newRaise = bound(newSeed, 1_000_000, type(uint128).max);
        // C13 admits buildable raises only. This test does not replace the layout's independent proof.
        try listings.checkLayout(oldRaise) {}
        catch {
            vm.assume(false);
        }
        try listings.checkLayout(newRaise) {}
        catch {
            vm.assume(false);
        }
        uint32 id;
        if (asset % 4 == 0) {
            listings.updateRaise(0, oldRaise);
        } else {
            uint8 decimals = asset % 4 == 1 ? 6 : asset % 4 == 2 ? 8 : 18;
            KitPlainToken coin = new KitPlainToken("Price", "P", decimals);
            coin.mint(address(this), 10_000);
            coin.approve(address(listings), 10_000);
            id = listings.add(address(coin), ListingClass.OTHER, oldRaise);
        }
        uint256[] memory input = new uint256[](2);
        input[0] = oldRaise;
        input[1] = newRaise;
        uint256[] memory e = model("raise", input);
        BoxSpec memory s = _spec(id, oldRaise);
        s.pricing.token = listings.listing(id).token;
        BoxFactoryV2Planner.Plan memory old = planner.plan(release, address(this), s, bytes32(0), bytes32(0));
        address oldBox = _deploy(old);
        boxes.record(oldBox, old.templateId, abi.encode(s));
        _assertQ(old.q, e, 1);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(0xBAD)));
        vm.prank(address(0xBAD));
        listings.updateRaise(id, newRaise);
        listings.updateRaise(id, newRaise);
        assertEq(listings.listing(id).raise, e[5]);
        assertEq(IBoxCoordinator(oldBox).raise(), e[0]);
        assertEq(boxes.recordOf(0).raise, e[0]);
        _assertQ(planner.boxQParameters(release, id, oldRaise), e, 1);
        assertEq(planner.refusal(release, s).length == 0, oldRaise == newRaise);
        s.raise = newRaise;
        assertEq(planner.refusal(release, s).length, 0);
        BoxFactoryV2Planner.Plan memory fresh = planner.plan(release, address(this), s, bytes32(uint256(1)), bytes32(0));
        address newBox = _deploy(fresh);
        assertEq(IBoxCoordinator(newBox).raise(), e[5]);
        _assertQ(fresh.q, e, 6);
        _assertQ(listings.listing(id).q, e, 6);
        assertEq(listings.listingCount(), id == 0 ? 1 : 2);
    }

    function _assertQ(QParameters memory q, uint256[] memory e, uint256 offset) internal pure {
        assertEq(q.bootstrapQ, e[offset]);
        assertEq(q.batchMinQ, e[offset + 1]);
        assertEq(q.tipMaxQ, e[offset + 2]);
        assertEq(q.swapStepMinQ, e[offset + 3]);
    }

    function _deploy(BoxFactoryV2Planner.Plan memory plan) internal returns (address c) {
        bytes memory init = plan.coordinatorInit;
        bytes32 salt = plan.salt;
        assembly ("memory-safe") { c := create2(0, add(init, 32), mload(init), salt) }
        assertEq(c, plan.roles[0]);
        assertNotEq(c, address(0));
    }

    function _spec(uint32 id, uint256 raise) internal pure returns (BoxSpec memory s) {
        s.format = 2;
        s.version = 2;
        s.boxType = 3;
        s.tokenName = "Reference";
        s.tokenSymbol = "REF";
        s.pricing.listingId = id;
        s.raise = raise;
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
}
