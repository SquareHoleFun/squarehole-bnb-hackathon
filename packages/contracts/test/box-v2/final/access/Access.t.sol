// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FinalAccessFixture} from "./Fixture.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {IBoxReceiverV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxCollectionV2} from "../../../../src/box-v2/BoxCollectionV2.sol";

contract FinalAccessTest is FinalAccessFixture {
    function test_A05_collectionOwnerOperatorAndUnlockerRightsHavePositiveControls() public {
        for (uint256 family = 2; family <= 3; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            BoxCollectionV2 c = BoxCollectionV2(box.collection());
            uint256 id = c.firstId();
            address vault = box.vault();
            _refuse(address(c), OUTSIDER, abi.encodeCall(c.approve, (OUTSIDER, id)));
            _refuse(address(c), OUTSIDER, abi.encodeCall(c.unlockReveal, (id)));
            _refuse(address(c), OUTSIDER, abi.encodeCall(c.transferFrom, (vault, OUTSIDER, id)));
            assertEq(c.ownerOf(id), vault);
            // Unit-level collection authorization: act as the fixed vault, without claiming an escrow exit.
            vm.prank(vault);
            c.transferFrom(vault, CREATOR, id);
            _refuse(address(c), OUTSIDER, abi.encodeCall(c.transferFrom, (CREATOR, OUTSIDER, id)));
            vm.prank(CREATOR);
            c.approve(OUTSIDER, id);
            vm.prank(OUTSIDER);
            c.transferFrom(CREATOR, address(this), id);
            assertEq(c.getApproved(id), address(0), "ownership transfer clears a single-id approval");
            _refuse(address(c), OUTSIDER, abi.encodeCall(c.transferFrom, (address(this), OUTSIDER, id)));
            c.setApprovalForAll(OUTSIDER, true);
            vm.prank(OUTSIDER);
            c.transferFrom(address(this), CREATOR, id);
            assertEq(c.ownerOf(id), CREATOR);
            // An unsafe receiving contract cannot partially consume ownership or approval.
            _refuse(
                address(c),
                CREATOR,
                abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", CREATOR, address(this), id)
            );
            assertEq(c.ownerOf(id), CREATOR);
            vm.prank(CREATOR);
            c.safeTransferFrom(CREATOR, OUTSIDER, id);
            assertEq(c.ownerOf(id), OUTSIDER);
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_A01_eachInitializedRoleRefusesSecondInitializationAndCopiedArgsOutsider() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            uint256[8] memory roles = [uint256(1), 2, 3, 4, 5, 6, 7, 16];
            uint256 supply = token.totalSupply();
            for (uint256 i; i < roles.length; ++i) {
                address part = box.roleAddress(roles[i]);
                if (part == address(0)) continue;
                bytes memory callData = abi.encodeWithSignature("initialize()");
                _refuse(part, address(box), callData);
                uint256 slot = roles[i];
                if (slot == 1 && box.roleAddress(17) != address(0)) slot = 20;
                if (slot == 3 && family == 5) slot = 22;
                address impl = release.implementations[slot];
                _refuse(impl, OUTSIDER, callData);
                bytes memory args = new bytes(part.code.length - BoxClones.ARGS_OFFSET);
                uint256 offset = BoxClones.ARGS_OFFSET;
                assembly ("memory-safe") { extcodecopy(part, add(args, 32), offset, mload(args)) }
                address twin = BoxClones.create(BoxClones.initCode(impl, args));
                _refuse(twin, OUTSIDER, callData);
                bytes memory coordinatorCode = address(box).code;
                // Same immutable coordinator address, invalid authenticated runtime prefix.
                vm.etch(address(box), hex"00");
                bytes memory wrongClone = _refuse(twin, address(box), callData);
                bytes memory expected = roles[i] == 16
                    ? abi.encodeWithSignature("Unauthorized()")
                    : (roles[i] == 3 && family == 5)
                        ? abi.encodeWithSignature("NotCoordinator()")
                        : abi.encodeWithSignature("NotCoordinator(address)", address(box));
                assertEq(wrongClone, expected, "recorded address alone is not clone authentication");
                vm.etch(address(box), coordinatorCode);
            }
            _refuse(address(box), address(factory), abi.encodeWithSignature("launch()"));
            assertEq(token.totalSupply(), supply, "initialize cannot repeat issuance");
            assertTrue(box.gateOpen());
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_A02_privilegedMoneyAndLifecycleMembersRejectOutsiderInEveryFamily() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            _buy(box.raise() / 5);
            uint256 supply = token.totalSupply();
            uint256 claims = pm.balanceOf(address(receiver), 0);
            _refuse(address(hook), OUTSIDER, abi.encodeCall(hook.harvest, ()));
            _refuse(address(hook), OUTSIDER, abi.encodeCall(hook.close, ()));
            _refuse(address(hook), OUTSIDER, abi.encodeCall(hook.migrate, (0)));
            _refuse(address(hook), OUTSIDER, abi.encodeWithSignature("setOpen(uint256)", block.timestamp));
            _refuse(address(hook), OUTSIDER, abi.encodeWithSignature("launch()"));
            _refuse(box.launchRouter(), OUTSIDER, abi.encodeWithSignature("bootstrap()"));
            _refuse(box.launchRouter(), OUTSIDER, abi.encodeWithSignature("creatorBuy(address,uint256)", OUTSIDER, 0));
            _refuse(box.launchRouter(), OUTSIDER, abi.encodeWithSignature("setOpen(uint256)", block.timestamp));
            _refuse(address(receiver), OUTSIDER, abi.encodeCall(receiver.onGraduation, ()));
            _refuse(address(receiver), OUTSIDER, abi.encodeCall(receiver.enterFailure, ()));
            _refuse(address(box), OUTSIDER, abi.encodeWithSignature("launch()"));
            _refuse(address(box), OUTSIDER, abi.encodeWithSignature("starterSetLoaded()"));
            if (box.vault() != address(0)) {
                _refuse(box.vault(), OUTSIDER, abi.encodeWithSignature("openGate()"));
                _refuse(box.vault(), OUTSIDER, abi.encodeWithSignature("enterFailure()"));
            }
            assertEq(token.totalSupply(), supply);
            assertEq(pm.balanceOf(address(receiver), 0), claims);
            assertFalse(box.failed());
            assertFalse(box.graduated());
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_A03_fundedCreatorCreditAndPayeeHandoverHavePositiveAuthorizationControls() public {
        _start(_family(0));
        _fill();
        vm.prank(OUTSIDER);
        box.graduate();
        receiver.collect(address(0));
        uint256 credit = receiver.creatorP();
        assertGt(credit, 0, "authorization tested with spendable funds");
        bytes memory err =
            _refuse(address(receiver), OUTSIDER, abi.encodeCall(receiver.claimCreator, (address(0), OUTSIDER)));
        assertEq(err, abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, OUTSIDER));
        _refuse(address(receiver), OUTSIDER, abi.encodeCall(receiver.proposeCreatorPayee, (OUTSIDER)));
        vm.prank(CREATOR);
        receiver.proposeCreatorPayee(OUTSIDER);
        _refuse(address(receiver), CREATOR, abi.encodeCall(receiver.acceptCreatorPayee, ()));
        vm.prank(OUTSIDER);
        receiver.acceptCreatorPayee();
        _refuse(address(receiver), CREATOR, abi.encodeCall(receiver.claimCreator, (address(0), CREATOR)));
        uint256 beforeP = OUTSIDER.balance;
        vm.prank(OUTSIDER);
        assertEq(receiver.claimCreator(address(0), OUTSIDER), credit);
        assertEq(OUTSIDER.balance - beforeP, credit);
        assertEq(receiver.creatorP(), 0);
        uint256 reward = box.rewardOf(OUTSIDER);
        assertGt(reward, 0, "D6 owner check requires funded reward");
        _refuse(address(box), CREATOR, abi.encodeCall(box.claimReward, (CREATOR)));
        vm.prank(OUTSIDER);
        assertEq(box.claimReward(CREATOR), reward);
        assertEq(box.rewardOf(OUTSIDER), 0);
        _booked();
    }

    function test_A04_listingAuthorityTransferCancellationAndRenunciationFollowCallerRules() public {
        uint256 raise = listings.listing(0).raise;
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.updateRaise, (0, raise * 2)));
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.proposeLister, (OUTSIDER)));
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.proposeRenounce, ()));
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.renounce, ()));
        listings.proposeLister(OUTSIDER);
        listings.proposeLister(address(0));
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.acceptLister, ()));
        listings.proposeLister(OUTSIDER);
        _refuse(address(listings), CREATOR, abi.encodeCall(listings.acceptLister, ()));
        vm.prank(OUTSIDER);
        listings.acceptLister();
        assertEq(listings.lister(), OUTSIDER);
        assertEq(listings.pendingLister(), address(0));
        _refuse(address(listings), address(this), abi.encodeCall(listings.updateRaise, (0, raise * 2)));
        vm.prank(OUTSIDER);
        listings.updateRaise(0, raise * 2);
        assertEq(listings.listing(0).raise, raise * 2);
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.renounce, ()));
        vm.prank(OUTSIDER);
        listings.proposeRenounce();
        _refuse(address(listings), CREATOR, abi.encodeCall(listings.renounce, ()));
        vm.prank(OUTSIDER);
        listings.renounce();
        assertTrue(listings.renounced());
        assertEq(listings.lister(), address(0));
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.updateRaise, (0, raise)));
        _refuse(address(listings), OUTSIDER, abi.encodeCall(listings.proposeLister, (OUTSIDER)));
        assertEq(listings.listing(0).raise, raise * 2, "permanent rows survive authority renunciation");
    }
}
