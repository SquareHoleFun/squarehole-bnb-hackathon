// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AHookMatrixBase} from "../cq11-a/Hook.t.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxHookV2} from "../../../src/box-v2/BoxHookV2.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
contract M130bHookTest is CQ11AHookMatrixBase {
    function test_M130b_bc157hook_pIsAlwaysCurrency0() public view {
        assertEq(Currency.unwrap(key.currency0), address(p)); assertEq(Currency.unwrap(key.currency1), address(t));
        assertEq(key.fee, 10_000); assertEq(address(key.hooks), address(hook));
    }
    function test_M130b_bc220hook_theOpenGate() public {
        assertEq(hook.openAt(), box.effectiveOpenAt()); vm.roll(block.number + 1); vm.expectRevert(); _buy(1000);
        _open(); _buy(RAISE / 100); assertGt(t.balanceOf(address(trader)), 0);
    }
    function test_M130b_bc229hook_thresholdsAreTheBoxsQParameters() public view {
        assertEq(hook.raise(), RAISE); assertEq(hook.reserveCap(), RAISE / 1000); assertEq(hook.deepenTipCap(), RAISE / 100);
    }
    function test_M130b_hookHasNoHolderNoticeInM1() public {
        _open(); vm.startStateDiffRecording(); _buy(RAISE / 100);
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].accessor == address(hook) && (accesses[i].kind == VmSafe.AccountAccessKind.Call || accesses[i].kind == VmSafe.AccountAccessKind.StaticCall)) {
                assertEq(accesses[i].account, address(pm), "swap path only calls manager");
            }
        }
    }
    function test_M130b_hookAndExtensionSizeGates() public view {
        assertLe(hi.code.length, 22118); assertLe(BoxHookV2(hi).extension().code.length, 22118);
    }
    function test_C15_closedPoolRefusesForeignLiquidityAndDonations() public {
        bytes32 beforeState = _state();
        vm.startPrank(address(pm));
        vm.expectRevert(IBoxHookV2.LiquidityLocked.selector); hook.beforeAddLiquidity(address(this), key, ModifyLiquidityParams(0, 60, 1, 0), "");
        vm.expectRevert(IBoxHookV2.LiquidityLocked.selector); hook.beforeRemoveLiquidity(address(this), key, ModifyLiquidityParams(0, 60, -1, 0), "");
        vm.expectRevert(IBoxHookV2.DonationsDisabled.selector); hook.beforeDonate(address(this), key, 1, 1, "");
        vm.expectRevert(IBoxHookV2.ForeignInitialize.selector); hook.beforeInitialize(address(this), key, 1 << 96);
        vm.stopPrank(); assertEq(_state(), beforeState);
    }
}
