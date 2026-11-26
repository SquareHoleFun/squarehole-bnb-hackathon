// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AHookMatrixBase} from "./Hook.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
contract CQ11AProtocolTest is CQ11AHookMatrixBase {
    using StateLibrary for IPoolManager;
    function _burnBox() internal { choice = 2; _make(RAISE); _graduate(); receiver.collect(address(0)); }
    function _swapLog(Vm.Log[] memory logs) private view returns (int128 a0, int128 a1, uint24 fee) {
        bytes32 signature = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
        uint256 found;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(pm) && logs[i].topics[0] == signature) {
            (a0, a1,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24)); ++found;
        }
        assertEq(found, 1);
    }
    function test_C3_publicRouterBuyPaysTaxAndLPFee() public {
        vm.warp(box.effectiveOpenAt()); p.approve(address(router), type(uint256).max);
        uint256 amount = RAISE / 1000000; (uint256 tax, uint256 swapIn) = router.quote(amount);
        uint256 balance = p.balanceOf(address(this)); vm.recordLogs();
        uint256 out = router.buy(amount, 0, address(this), block.timestamp);
        (int128 d0, int128 d1, uint24 fee) = _swapLog(vm.getRecordedLogs());
        assertEq(fee, 10000); assertEq(uint256(-int256(d0)), swapIn); assertEq(uint256(int256(d1)), out);
        assertEq(balance - p.balanceOf(address(this)), amount); assertEq(router.totalTaxCollected(), tax);
        assertEq(hook.lastProtocolBlock(), 0);
    }
    function test_C8_realBuyBackPaysFeeAndSharesStepWithDeepen() public {
        _burnBox(); uint256 budget = receiver.buyBackP(); assertGt(budget, 0);
        uint256 supply = t.totalSupply(); uint256 claims = _claims(address(receiver));
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        vm.recordLogs(); (ProtocolSkip skip, uint256 spent, uint256 bought, uint256 tip) = receiver.buyBack(address(0));
        (int128 d0, int128 d1, uint24 fee) = _swapLog(vm.getRecordedLogs());
        assertEq(uint8(skip), 0); assertEq(fee, 10000); assertEq(spent, uint256(-int256(d0))); assertEq(bought, uint256(int256(d1)));
        assertEq(receiver.buyBackP(), budget - spent); assertEq(_claims(address(receiver)), claims - spent);
        assertEq(t.totalSupply(), supply - bought); assertEq(tip, 0); assertEq(hook.lastProtocolBlock(), block.number);
        (uint160 afterPrice,,,) = pm.getSlot0(hook.poolId()); assertGe(afterPrice, Bounds.roomLimit(true, spot, 49));
        bytes32 state = _state(); (skip,,,) = hook.deepen(address(0)); assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken)); assertEq(_state(), state);
        vm.roll(block.number + 1); (skip,,,) = hook.deepen(address(0)); assertEq(uint8(skip), 0);
        (skip,,,) = receiver.buyBack(address(0)); assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
    }
    function test_C9_revertedReceiverSwapRollsBackStepAndAllowsRetry() public {
        address sender = _prepare(2, 1); Before memory b = _before(sender);
        vm.expectRevert(); this._attempt(sender, SwapParams(true, -1e38, TickMath.MIN_SQRT_PRICE + 1));
        assertEq(_state(), b.state); assertEq(p.balanceOf(sender), b.pBalance); assertEq(t.balanceOf(sender), b.tBalance);
        this._attempt(sender, SwapParams(true, -int256(RAISE / 1000000), b.price - b.price / 1000));
        assertEq(hook.lastProtocolBlock(), block.number);
    }
    function test_C9_secondReceiverSwapRejectsAllStateChanges() public {
        address sender = _prepare(2, 1); Before memory b = _before(sender);
        SwapParams memory params = SwapParams(true, -int256(RAISE / 1000000), b.price - b.price / 1000);
        this._attempt(sender, params); b = _before(sender);
        _reject(sender, params, b, abi.encodeWithSelector(IBoxHookV2.ProtocolStepTaken.selector), false);
    }
    function test_C15_realDeepenPaysLPFeeAndHarvestDoesNotDoubleMint() public {
        _graduate(); receiver.collect(address(0)); trader.gift(address(p), address(hook), RAISE);
        vm.recordLogs(); hook.deepen(address(0));
        (,,uint24 fee) = _swapLog(vm.getRecordedLogs()); assertEq(fee, 10000);
        uint256 before = _claims(address(receiver)) + hook.depthBudget();
        receiver.collect(address(0)); uint256 collected = _claims(address(receiver));
        assertEq(collected + hook.depthBudget(), before, "collect splits already-minted self-buy fees");
        receiver.collect(address(0)); assertEq(_claims(address(receiver)), collected); assertEq(hook.saleFeesPending(), 0);
    }
}
