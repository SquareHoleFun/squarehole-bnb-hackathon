// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../../kit/RoyaltyRelease.sol";

import {ReceiverFixture} from "../../cq11-b/ReceiverFixture.sol";
import {CustodyFixture} from "./CustodyFixture.sol";
import {BoxRoyaltyRouterV2} from "../../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxRoyaltyRouterV2Args} from "../../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {ReleaseConstantsV2} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {RoyaltyWeth} from "../../cq11-c/RoyaltyRouter.t.sol";
import {CQAAsset} from "../../cq11-a/Fixture.sol";

/// @notice M1-63-CUST-01: a royalty router must retain an exit when ordinary receipts accumulate.
/// Real receiver, royalty router and PoolManager; only the phase provider and price token are doubles.
contract CustodyRoyaltyIntakeTest is ReceiverFixture {
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));

    function _royaltyRouter() private returns (BoxRoyaltyRouterV2) {
        address implementation_ = deployCode("BoxRoyaltyRouterV2.sol:BoxRoyaltyRouterV2", abi.encode(RoyaltyRelease.config()));
        return BoxRoyaltyRouterV2(
            payable(BoxClones.create(
                    BoxClones.initCodeReceiving(
                        implementation_,
                        RoyaltyRelease.args(
                            address(coord), address(r), address(0), RoyaltyDestination.FeeHandling, r.q()
                        )
                    )
                ))
        );
    }

    function test_royaltyAtSingleDeltaLimitHasExit() public {
        BoxRoyaltyRouterV2 royalties = _royaltyRouter();
        p.mint(address(this), MAX_PART);
        p.transfer(address(royalties), MAX_PART);
        assertEq(royalties.sweep(address(p)), MAX_PART);
        assertEq(p.balanceOf(address(royalties)), 0);
        assertEq(r.royaltyHeldP(), MAX_PART);
        assertEq(_balance(address(r)), MAX_PART);
    }

    // CUST-01: accumulated receipts cross the manager's single-delta boundary.
    function test_accumulatedRoyaltyAboveSingleDeltaLimitHasExit() public {
        BoxRoyaltyRouterV2 royalties = _royaltyRouter();
        uint256 receipt = (MAX_PART + 1) / 2;
        p.mint(address(this), 2 * receipt);
        p.transfer(address(royalties), receipt);
        p.transfer(address(royalties), receipt);
        assertEq(p.balanceOf(address(royalties)), MAX_PART + 1);
        assertEq(royalties.sweep(address(p)), MAX_PART + 1);
        assertEq(p.balanceOf(address(royalties)), 0);
        assertEq(r.royaltyHeldP(), MAX_PART + 1);
        assertEq(_balance(address(r)), MAX_PART + 1);
        assertEq(p.allowance(address(royalties), address(r)), 0);
    }

    function test_directRoyaltyPairsMultipleSettlementsAtomically() public {
        uint256 amount = 3 * MAX_PART + 17;
        _royalty(address(p), amount);
        assertEq(r.royaltyHeldP(), amount);
        assertEq(r.booked(address(p)), amount);
        assertEq(_balance(address(r)), amount);
        assertEq(p.balanceOf(address(r)), 0);
    }

    function testFuzz_boundedRoyaltySweepPreservesPhaseAndDestination(uint8 phase, uint8 destination) public {
        phase = uint8(bound(phase, 0, 2));
        destination = uint8(bound(destination, 1, 3));
        r = _receiver(1, 1, destination, address(p), true);
        if (phase == 1) coord.graduation(r);
        if (phase == 2) coord.failure(r);
        BoxRoyaltyRouterV2 royalties = _royaltyRouter();
        uint256 amount = 5 * MAX_PART + 17;
        p.mint(address(royalties), amount);
        uint256 delivered;
        for (uint256 i; i < 2; ++i) {
            uint256 expected = i == 0 ? 4 * MAX_PART : MAX_PART + 17;
            assertEq(royalties.sweep(address(p)), expected);
            delivered += expected;
            assertEq(p.balanceOf(address(royalties)), amount - delivered);
            assertEq(p.allowance(address(royalties), address(r)), 0);
            assertEq(_balance(address(r)) + _balance(address(hook)) + _balance(address(coord)), delivered);
            assertEq(r.booked(address(p)), _balance(address(r)));
            if (phase == 0) assertEq(r.royaltyHeldP(), delivered);
            else if (phase == 2) { assertEq(r.fitOwed(), 0); assertEq(_balance(address(coord)), delivered); }
            else {
                assertEq(r.fitOwed(), delivered / 15 * 2);
                assertEq(r.platformOwed(), delivered / 15);
                assertEq(r.creatorP(), delivered / 15 * 10);
                assertEq(_balance(address(hook)), delivered / 15 * 2);
            }
        }
    }

    function test_arbitraryRoyaltyBalanceMakesBoundedProgress() public {
        BoxRoyaltyRouterV2 royalties = _royaltyRouter();
        uint256 amount = type(uint256).max / 2;
        p.mint(address(royalties), amount);
        assertEq(royalties.sweep(address(p)), 4 * MAX_PART);
        assertEq(p.balanceOf(address(royalties)), amount - 4 * MAX_PART);
        assertEq(r.royaltyHeldP(), 4 * MAX_PART);
    }

    function test_boundedNativeAndWethRoyaltiesKeepRemainder() public {
        r = _receiver(1, 1, 1, address(0), true);
        RoyaltyWeth weth = new RoyaltyWeth();
        BoxRoyaltyRouterV2 royalties = BoxRoyaltyRouterV2(payable(BoxClones.create(BoxClones.initCodeReceiving(
            address(new BoxRoyaltyRouterV2(RoyaltyRelease.config())),
            RoyaltyRelease.args(address(coord), address(r), address(weth), RoyaltyDestination.FeeHandling, address(0))
        ))));
        uint256 amount = 5 * MAX_PART + 17;
        vm.deal(address(royalties), amount);
        vm.prank(address(royalties));
        weth.deposit{value: 3 * MAX_PART}();
        vm.expectEmit(true, false, false, true, address(royalties));
        emit Flushed(address(r), 4 * MAX_PART, 2 * MAX_PART - 17);
        assertEq(royalties.flush(), 4 * MAX_PART);
        assertEq(address(royalties).balance, 0);
        assertEq(weth.balanceOf(address(royalties)), MAX_PART + 17);
        assertEq(r.royaltyHeldP(), 4 * MAX_PART);
        assertEq(royalties.sweep(address(weth)), MAX_PART + 17);
        assertEq(weth.balanceOf(address(royalties)), 0);
        assertEq(r.royaltyHeldP(), amount);
        assertEq(_balance(address(r)), amount);
    }

    event Flushed(address indexed receiver, uint256 ethSent, uint256 wethUnwrapped);
}

/// @notice M1-63-CUST-02: real window buys must not build a tax balance that can never be swept.
/// All box parts and PoolManager are real; creation uses the existing admitted-large-raise fixture.
contract CustodyWindowTaxTest is CustodyFixture {
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));
    function _largeWindowTax() private returns (uint256 tax) {
        _make(LARGE);
        vm.warp(box.effectiveOpenAt());
        p.approve(address(router), type(uint256).max);
        uint256 clip = LARGE / 4;
        for (uint256 i; i < 3; ++i) {
            router.buy(clip, 1, address(this), block.timestamp);
        }
        tax = p.balanceOf(address(router));
        assertGt(tax, uint256(uint128(type(int128).max)));
        assertFalse(hook.closed());
    }

    // CUST-02: failure must sweep the accumulated tax within its named stipend.
    function test_accumulatedWindowTaxHasFailureExit() public {
        uint256 tax = _largeWindowTax();
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed());
        assertEq(p.balanceOf(address(router)), 0, "all window tax reaches the failure pot");
        (uint256 pot,) = box.claimState();
        assertGe(pot, tax - hook.deepenTipCap());
    }

    // The same aggregate also belongs to depth after successful graduation.
    function test_accumulatedWindowTaxHasGraduationExit() public {
        uint256 tax = _largeWindowTax();
        _graduate();
        uint256 beforeDepth = hook.depthBudget();
        assertEq(router.sweep(), tax);
        assertEq(p.balanceOf(address(router)), 0);
        assertEq(hook.depthBudget(), beforeDepth + tax);
    }

    function test_boundedTaxSweepFitsStipendAndReportsOnlyDelivered() public {
        _graduate();
        uint256 amount = 5 * MAX_PART + 17;
        p.mint(address(router), amount);
        uint256 beforeDepth = hook.depthBudget();
        uint256 swept = router.totalSwept();
        _coldSweep();
        vm.expectEmit(true, false, false, true, address(router));
        emit Swept(address(hook), 4 * MAX_PART, true);
        uint256 beforeGas = gasleft();
        assertEq(router.sweep{gas: ReleaseConstantsV2.SWEEP_GAS}(), 4 * MAX_PART);
        emit log_named_uint("four-part sweep gas including caller assertion", beforeGas - gasleft());
        assertEq(router.totalSwept(), swept + 4 * MAX_PART);
        assertEq(p.balanceOf(address(router)), MAX_PART + 17);
        assertEq(hook.depthBudget(), beforeDepth + 4 * MAX_PART);
        assertEq(router.sweep{gas: ReleaseConstantsV2.SWEEP_GAS}(), MAX_PART + 17);
        assertEq(hook.depthBudget(), beforeDepth + amount);
        assertEq(p.balanceOf(address(router)), 0);
    }

    function test_claimRetriesRemainingTaxBeforeComputingShare() public {
        _open();
        _buy(RAISE / 4);
        p.mint(address(router), 5 * MAX_PART + 17);
        vm.warp(box.deadline());
        box.fail();
        assertEq(p.balanceOf(address(router)), MAX_PART + 17);
        uint256 pot = _claims(address(box));
        (, uint256 left) = box.claimState();
        assertEq(t.balanceOf(address(trader)), left);
        vm.startPrank(address(trader));
        t.approve(address(box), left);
        assertEq(box.claim(left, address(trader)), pot + MAX_PART + 17);
        vm.stopPrank();
        assertEq(p.balanceOf(address(router)), 0);
        assertEq(_claims(address(box)), 0);
    }

    function test_nativeTaxSweepFitsStipendAcrossBatches() public {
        p = CQAAsset(address(0));
        _make(RAISE);
        _graduate();
        uint256 amount = 5 * MAX_PART + 17;
        vm.deal(address(router), amount);
        uint256 depth = hook.depthBudget();
        _coldSweep();
        assertEq(router.sweep{gas: ReleaseConstantsV2.SWEEP_GAS}(), 4 * MAX_PART);
        assertEq(address(router).balance, MAX_PART + 17);
        assertEq(hook.depthBudget(), depth + 4 * MAX_PART);
        assertEq(router.sweep{gas: ReleaseConstantsV2.SWEEP_GAS}(), MAX_PART + 17);
        assertEq(hook.depthBudget(), depth + amount);
        assertEq(address(router).balance, 0);
    }

    function test_refusedLaterTaxPartRollsBackWholeBatchThenRetries() public {
        _graduate();
        uint256 amount = MAX_PART + 17;
        p.mint(address(router), amount);
        uint256 depth = hook.depthBudget();
        uint256 swept = router.totalSwept();
        vm.mockCallRevert(address(p), abi.encodeWithSignature("transfer(address,uint256)", address(pm), 17), "blocked");
        vm.expectRevert();
        router.sweep();
        assertEq(p.balanceOf(address(router)), amount);
        assertEq(hook.depthBudget(), depth);
        assertEq(router.totalSwept(), swept);
        vm.clearMockedCalls();
        assertEq(router.sweep(), amount);
        assertEq(hook.depthBudget(), depth + amount);
        assertEq(router.totalSwept(), swept + amount);
    }

    function _coldSweep() private {
        // Model a keeper's fresh transaction, including clone implementations and all storage reads.
        vm.cool(address(router));
        vm.cool(li);
        vm.cool(address(hook));
        vm.cool(hi);
        vm.cool(address(box));
        vm.cool(ci);
        vm.cool(address(pm));
        vm.cool(address(p));
    }

    event Swept(address indexed to, uint256 amount, bool toDepth);
}
