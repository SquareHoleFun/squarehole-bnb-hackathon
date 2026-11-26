// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PayInTLifecycleTest, PayInTReceiver} from "./Lifecycle.t.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
interface RewardQueues { function rewardsPendingByKind() external view returns (uint256, uint256, uint256); }
contract PayInTSchedulingTest is PayInTLifecycleTest {
    function test_T34_eachQueueRetainsTheExistingStepMinimum() public {
        BoxSpec memory s = _rewardSpec(true, false);
        s.sellers.a = Branch(2, 8, "", abi.encode(uint8(1)));
        _start(s); _fill(); box.graduate(); receiver.collect(address(0));
        uint256 pending = PayInTReceiver(address(receiver)).rewardsPendingP();
        // A partial sellers' purchase can leave a one-wei tail before a ready buyers' queue.
        vm.store(address(receiver), bytes32(uint256(27)), bytes32(pending - 1));
        vm.store(address(receiver), bytes32(uint256(28)), bytes32(uint256(1)));
        vm.store(address(receiver), bytes32(uint256(34)), bytes32(uint256(3)));
        _booked(); vm.roll(block.number + 1);
        (, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(spent, 1, "choose the queue that meets the step minimum"); assertGt(bought, 0);
        (,, uint256 sellersP) = RewardQueues(address(receiver)).rewardsPendingByKind();
        assertEq(sellersP, 1); _booked();
    }
    function test_T18_burnTailCannotBlockReadyRewardSimulation() public {
        BoxSpec memory s = _rewardSpec(true, false);
        s.sellers.a = Branch(2, 1, "", "");
        _start(s); _fill(); box.graduate(); receiver.collect(address(0));
        uint256 pending = PayInTReceiver(address(receiver)).rewardsPendingP();
        // Model the backed one-wei Burn tail left by a partial step: shift exactly one P claim
        // from the buyers' reward queue (slot 27) to existing buyBackP (slot 5), no minted debt.
        vm.store(address(receiver), bytes32(uint256(27)), bytes32(pending - 1));
        vm.store(address(receiver), bytes32(uint256(5)), bytes32(uint256(1)));
        _booked(); vm.roll(block.number + 1);
        (, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(spent, 0, "simulation must choose executable reward work");
        assertGt(bought, 0); assertEq(receiver.buyBackP(), 1); _booked();
    }
}
