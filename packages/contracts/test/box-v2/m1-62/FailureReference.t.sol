// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {FailureTestBase, IBoxCoordinatorV2, IBoxCoordinator, FailCause, BoxClones} from "../m1-31/FailureTestBase.sol";
import {FailureHook} from "../m1-31/FailureShells.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {ReferenceModel} from "./ReferenceModel.sol";

// Local recipient avoids importing the PoolManager source and recompiling the coordinator
// under v4's upstream compiler profile. The release coordinator uses the default profile.
contract ReferenceSafe {
    receive() external payable {}
}

/// Only the unfinished hook boundary is scripted. Principal, reserve and fees are funded as real v4 claims.
contract ReferenceFailureHook is FailureHook {
    uint256 private sellers;
    constructor(IPoolManager m, address c, address r, address t, address p_) FailureHook(m, c, r, t, p_) {}

    function scriptSellers(uint256 amount) external {
        sellers = amount;
    }

    function harvest() external returns (uint256, uint256, uint256) {
        require(msg.sender == receiver);
        uint256 amount = sellers;
        sellers = 0;
        return (0, amount, 0);
    }
}

contract FailureReferenceTest is FailureTestBase, ReferenceModel {
    BoxReceiverV2 internal realReceiver;

    function setUp() public override {
        super.setUp();
        // Release Safes already have code. Empty accounts would test Amsterdam account-creation gas
        // against the payout stipend instead of the model's successfully payable allocations.
        ReferenceSafe safe = new ReferenceSafe();
        vm.etch(address(0xF17), address(safe).code);
        vm.etch(address(0xF18), address(safe).code);
        vm.etch(address(0xF19), address(safe).code);
        _box(address(0), true, true);
        _wireReceiver(1, 1);
    }

    function _wireReceiver(uint8 buyers, uint8 sellers) internal {
        hook = new ReferenceFailureHook(pm, address(box), address(receiver), address(t), p);
        box.seed(address(hook), block.timestamp, true);
        address code = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, address(implementation), address(0xF17), address(0xF18))
        );
        ReceiverArgs memory args = ReceiverArgs(
            address(box),
            address(hook),
            p,
            address(t),
            address(router),
            address(0xAB),
            CREATOR,
            1,
            1000,
            100,
            100,
            buyers,
            sellers,
            1,
            address(0),
            address(0)
        );
        // The reused shell set choice=1. Clear that fixture state before replacing its code:
        // otherwise its slot would masquerade as an already-booked production platform liability.
        receiver.configure(0, 0);
        vm.etch(address(receiver), BoxClones.runtime(code, BoxReceiverV2Args.encode(args)));
        realReceiver = BoxReceiverV2(address(receiver));
        vm.prank(address(box));
        realReceiver.initialize();
    }

    function testFuzz_claimsFollowLivePot(uint120 pot, uint96 coinsSeed, uint96 firstSeed, uint96 tax)
        public
        checkedModel
    {
        (pot, coinsSeed, firstSeed, tax) = abi.decode(
            modelCase("claim", abi.encode(pot, coinsSeed, firstSeed, tax)), (uint120, uint96, uint96, uint96)
        );
        uint256 coins = bound(coinsSeed, 2, 1e28);
        uint256 first = bound(firstSeed, 1, coins - 1);
        _fail(pot, coins);
        _tax(tax);
        uint256[] memory input = new uint256[](3);
        input[0] = uint256(pot) + tax;
        input[1] = coins;
        input[2] = first;
        uint256[] memory e = model("claim", input);
        assertEq(_claim(ALICE, first, BOB), e[0]);
        assertEq(_pot(), e[1]);
        assertEq(_left(), e[2]);
        assertEq(box.quoteClaim(e[2]), e[1]);
        assertEq(_claim(ALICE, e[2], ALICE), e[1]);
        assertEq(_balance(ALICE) + _balance(BOB), uint256(pot) + tax);
        assertEq(_pot(), 0);
        assertEq(_left(), 0);
    }

    function testFuzz_reserveSplitNeverSplitsPrincipal(
        uint96 principal,
        uint64 reserve,
        uint64 buyers,
        uint64 sellers,
        uint8 bc,
        uint8 sc,
        uint32 tip
    ) public checkedModel {
        (principal, reserve, buyers, sellers, bc, sc, tip) = abi.decode(
            modelCase("reserve", abi.encode(principal, reserve, buyers, sellers, bc, sc, tip)),
            (uint96, uint64, uint64, uint64, uint8, uint8, uint32)
        );
        bc = uint8(bound(bc, 1, 3));
        sc = uint8(bound(sc, 1, 3));
        // Fresh receiver storage, without changing any production member or shape.
        _box(address(0), true, true);
        _wireReceiver(bc, sc);
        _give(ALICE, 100);
        _fund(p, address(hook), uint256(principal) + reserve + buyers + sellers);
        hook.configure(uint256(buyers) + sellers, reserve, tip);
        ReferenceFailureHook(address(hook)).scriptSellers(sellers);
        uint256[] memory input = new uint256[](7);
        input[0] = principal;
        input[1] = reserve;
        input[2] = buyers;
        input[3] = sellers;
        input[4] = bc;
        input[5] = sc;
        input[6] = tip;
        uint256[] memory e = model("failure", input);
        _expire();
        vm.deal(BOB, 1); // existing recipient: exercise a successful capped tip on both hardforks
        vm.prank(BOB);
        box.fail();
        assertEq(_pot(), e[0]);
        assertEq(realReceiver.fitOwed(), e[1]);
        assertEq(realReceiver.platformOwed(), e[2]);
        assertEq(BOB.balance - 1, e[3]);
        assertEq(e[0] + e[1] + e[2] + e[3], uint256(principal) + reserve + buyers + sellers);
        assertEq(realReceiver.booked(p), e[1] + e[2]);
        assertEq(_claim(ALICE, 100, ALICE), e[0]);
        assertEq(realReceiver.payFit(), e[1]);
        assertEq(realReceiver.payPlatform(), e[2]);
        assertEq(pm.balanceOf(address(box), 0) + pm.balanceOf(address(realReceiver), 0), 0);
    }

    function testFuzz_hatchBoundary(uint32 fillDelay, uint32 timeSeed, bool filled, bool graduated)
        public
        checkedModel
    {
        (fillDelay, timeSeed, filled, graduated) = abi.decode(
            modelCase("hatch", abi.encode(fillDelay, timeSeed, filled, graduated)), (uint32, uint32, bool, bool)
        );
        vm.warp(1); // Reproducible first-fill origin in the committed corpus and live campaign.
        uint256 fillTime = block.timestamp + bound(fillDelay, 0, 1 days);
        vm.warp(fillTime);
        if (filled) hook.fill();
        if (filled && graduated) box.graduate();
        uint256 elapsed = bound(timeSeed, 7 days - 1, 7 days + 1);
        vm.warp(fillTime + elapsed);
        uint256[] memory input = new uint256[](5);
        input[0] = filled ? fillTime : 0;
        input[1] = block.timestamp;
        input[2] = filled ? 1 : 0;
        input[3] = box.graduated() ? 1 : 0;
        uint256[] memory e = model("hatch", input);
        if (e[0] == 0) {
            if (box.graduated()) {
                vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
            } else if (!filled) {
                vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, box.deadline()));
            } else {
                vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, e[1]));
            }
            box.fail();
            assertFalse(box.failed());
        } else {
            vm.prank(BOB);
            box.fail();
            assertTrue(box.failed());
            assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
            assertEq(vault.windowEnds(), block.timestamp + 14 days);
            vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
            box.fail();
            vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
            box.graduate();
        }
    }

    function testFuzz_lateMoneyBeforeAndAfterLastClaim(uint96 pot, uint96 gift, uint96 tax, uint96 royalty)
        public
        checkedModel
    {
        (pot, gift, tax, royalty) =
            abi.decode(modelCase("late", abi.encode(pot, gift, tax, royalty)), (uint96, uint96, uint96, uint96));
        _fail(pot, 2);
        _fund(p, address(box), gift);
        _tax(tax);
        uint256[] memory input = new uint256[](3);
        input[0] = uint256(pot) + gift;
        input[1] = 2;
        uint256[] memory e = model("late", input);
        assertEq(e[0], 0);
        NoFailureSweep.check(address(box));
        // Returned royalties enter the receiver; after failure they join the holder pot.
        vm.deal(address(this), royalty);
        realReceiver.fundRoyalty{value: royalty}(p, royalty);
        assertEq(realReceiver.fitOwed(), 0);
        assertEq(_claim(ALICE, 2, ALICE), uint256(pot) + gift + tax + royalty);
        _fund(p, address(box), gift);
        _tax(tax);
        if (tax != 0) router.sweep();
        input[0] = uint256(gift) + tax;
        input[1] = 0;
        e = model("late", input);
        NoFailureSweep.check(address(box));
        assertEq(_pot(), e[1]);
        vm.deal(address(this), royalty);
        realReceiver.fundRoyalty{value: royalty}(p, royalty);
        assertEq(realReceiver.payFit(), 0);
        assertEq(_pot(), uint256(gift) + tax + royalty);
    }

    function testFuzz_fixedNoBuyerReturnHasNoSweep(uint96 pot, uint96 gift, uint96 tax) public checkedModel {
        (pot, gift, tax) = abi.decode(modelCase("noBuyer", abi.encode(pot, gift, tax)), (uint96, uint96, uint96));
        _fail(pot, 0);
        _fund(p, address(box), gift);
        _tax(tax);
        if (tax != 0) router.sweep();
        uint256[] memory input = new uint256[](3);
        input[0] = uint256(pot) + gift + tax;
        input[2] = pot;
        uint256[] memory e = model("late", input);
        NoFailureSweep.check(address(box));
        assertEq(_pot(), e[1]);
        assertEq(_claim(CREATOR, 0, CREATOR), pot); // even a fixed zero return may be consumed once
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
        assertEq(realReceiver.payFit(), 0);
    }
}
