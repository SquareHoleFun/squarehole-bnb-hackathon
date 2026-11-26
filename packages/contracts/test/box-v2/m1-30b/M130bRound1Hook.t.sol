// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AHookMatrixBase} from "../cq11-a/Hook.t.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxHookV2} from "../../../src/box-v2/BoxHookV2.sol";
contract M130bRound1HookTest is CQ11AHookMatrixBase {
    function test_M130b_r1_bc229_deepenTipIsCappedByTipMaxQ() public {
        _graduate(); trader.gift(address(p), address(hook), RAISE);
        uint256 before = hook.depthBudget(); (,,,uint256 tip) = hook.deepen(address(0xCAFE));
        uint256 moved = before - hook.depthBudget() - tip;
        assertEq(tip, moved / 20 < hook.deepenTipCap() ? moved / 20 : hook.deepenTipCap());
        assertEq(p.balanceOf(address(0xCAFE)), tip);
    }
    // C14 removed depthConvertMinQ; stepMinQ is the retained dust guard.
    function test_M130b_r1_bc229_deepenWaitsBelowStepMinQ() public {
        _graduate(); uint256 excess = hook.depthBudget() - 1;
        vm.prank(address(hook)); pm.transfer(address(trader), uint160(address(p)), excess);
        uint256 small = hook.depthBudget(); assertLt(small, RAISE / 100000);
        (ProtocolSkip skip,,,) = hook.deepen(address(0)); assertEq(uint8(skip), uint8(ProtocolSkip.BelowMinimum));
        assertEq(hook.lastProtocolBlock(), 0); assertEq(hook.depthBudget(), small);
    }
    function test_M130b_r1_receiverHarvestsTheCurveFromTheDeadline() public {
        _open(); _buy(RAISE / 10); vm.warp(box.deadline()); receiver.collect(address(0));
        assertGt(receiver.fitOwed(), 0); assertEq(hook.saleFeesPending(), 0);
    }
    function test_M130b_r1_bc100_strangersHookCloneIsInert() public {
        address foreign = address(0x12342aec); vm.etch(foreign, address(hook).code);
        vm.expectRevert(); IBoxHookV2(foreign).initialize();
        vm.expectRevert(); IBoxHookV2(foreign).launch();
    }
    function test_M130b_r1_hookSetOpenTakesOnlyARealTime() public {
        holdGate = true; _make(RAISE);
        vm.startPrank(address(box));
        vm.expectRevert(); hook.setOpen(0); vm.expectRevert(); hook.setOpen(1 << 40);
        vm.stopPrank(); box.loadChunk(ChunkPart.Texts, hex"00", 0); assertEq(hook.openAt(), box.effectiveOpenAt());
    }
    function test_M130b_r1_hookRefusesAnAddressWithAnExtraFlag() public {
        address extra = address(0x12342aed); vm.etch(extra, address(hook).code);
        vm.prank(address(box)); vm.expectRevert(IBoxHookV2.InvalidHookAddress.selector); IBoxHookV2(extra).initialize();
    }
    function test_M130b_r1_hookTakesBuysInTheWindowOnlyFromTheRouter() public {
        _case(0, 2, 0, false);
        vm.warp(box.effectiveOpenAt()); p.approve(address(router), type(uint256).max);
        assertGt(router.buy(RAISE / 1000, 0, address(this), block.timestamp), 0);
    }
}
