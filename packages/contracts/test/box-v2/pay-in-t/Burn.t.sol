// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {PayInTLifecycleTest} from "./Lifecycle.t.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxReceiverV2Args as A} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
contract RewardBurnProbe is BoxReceiverV2 {
    constructor(IPoolManager pm, address c, address f, address p, address x) BoxReceiverV2(pm, c, f, p, ReceiverDeploy.code(pm)) {}
    function measure(uint256 cap) external locked returns (uint256 used) {
        uint256 amount = _rewards.burnClaims; _rewards.burnClaims = 0;
        uint256 before_ = gasleft();
        require(_tryUnlock(BURN_CLAIMS, A.addressAt(A.T), address(0), amount, cap), "refused");
        used = before_ - gasleft();
    }
}
contract PayInTBurnTest is PayInTLifecycleTest {
    function _cold(address code) private {
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address impl = release.implementations[i]; if (impl != address(0)) vm.cool(impl);
        }
        ReceiverDeploy.cool(code);
        vm.cool(code); vm.cool(address(pm));
    }
    function test_T17_refusedInsideBurnKeepsExactClaimsAndStrictStipendHasTwiceMargin() public {
        BoxSpec memory s = _rewardSpec(true, false);
        s.buyers.a.destParams = abi.encode(uint8(2)); s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _fill(); box.graduate(); receiver.collect(address(0));
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), "paused");
        vm.roll(block.number + 1); receiver.buyBack(address(0));
        vm.clearMockedCalls();
        uint256 amount = BoxReceiverV2(address(receiver)).rewardBurnPendingT(); assertGt(amount, 0);
        assertEq(pm.balanceOf(address(receiver), uint160(address(token))), amount);
        RewardBurnProbe code = new RewardBurnProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(code))[i];
        vm.etch(address(receiver), runtime);
        uint256 supply = token.totalSupply(); uint256 snap = vm.snapshotState(); uint256 low; uint256 high = C.BURN_GAS;
        while (low + 1 < high) {
            assertTrue(vm.revertToState(snap)); uint256 mid = (low + high) / 2; _cold(address(code));
            (bool ok,) = address(receiver).call{gas: 6_000_000}(abi.encodeCall(RewardBurnProbe.measure, (mid)));
            if (ok) high = mid; else low = mid;
        }
        emit log_named_uint("strict cold receiver T claim burn stipend", high); assertLe(high * 2, C.BURN_GAS);
        assertTrue(vm.revertToState(snap)); _cold(address(code)); RewardBurnProbe(address(receiver)).measure(C.BURN_GAS / 2);
        assertEq(token.totalSupply(), supply - amount);
        assertEq(pm.balanceOf(address(receiver), uint160(address(token))), 0);
    }
}
