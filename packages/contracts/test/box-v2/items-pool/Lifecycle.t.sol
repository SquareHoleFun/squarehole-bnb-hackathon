// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PayInTLifecycleTest, RewardItemOwner} from "../pay-in-t/Lifecycle.t.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {BoxCollectionV2} from "../../../src/box-v2/BoxCollectionV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {IBoxReceiverPayInTV21} from "../../../src/box-v2/interfaces/IBoxReceiverPayInTV21.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {HeldKind, FailRoute} from "../../../src/box-v2/interfaces/FailureTableV2.sol";

contract ItemsPoolLifecycleTest is PayInTLifecycleTest {
    function _depthSpec(bool inT, bool sellers) private view returns (BoxSpec memory s) {
        s = _rewardSpec(true, sellers);
        if (sellers) { s.sellers.a.leg = inT ? 2 : 1; s.sellers.a.destParams = abi.encode(uint8(3)); }
        else { s.buyers.a.leg = inT ? 2 : 1; s.buyers.a.destParams = abi.encode(uint8(3)); }
    }
    function test_IP07_TGraduationMovesHeldPToExistingDepth() public {
        _start(_depthSpec(true, false)); _buy(box.raise() / 10); receiver.collect(address(0));
        assertGt(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP(), 0);
        _fill(); box.graduate(); receiver.collect(address(0));
        assertEq(receiver.itemsHeldP(), 0);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP(), 0);
        assertEq(receiver.buyBackP(), 0);
        ItemLedgerV2 items = ItemLedgerV2(box.roleAddress(16)); items.sync(32);
        (uint256 outside, uint256 stash) = items.itemCreditT(1); assertEq(outside + stash, 0);
        uint256 liquidity = hook.pairedLiquidity(); vm.roll(block.number + 1); hook.deepen(address(0));
        assertGt(hook.pairedLiquidity(), liquidity); _booked();
    }
    function testFuzz_IP08_TPendingFailureConservesP(uint8 fraction, bool sellers) public {
        _start(_depthSpec(true, sellers)); _buy(box.raise() / bound(fraction, 3, 8));
        if (sellers) buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 3, layout.sqrtPriceStartX96);
        receiver.collect(address(0)); uint256 held = IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP();
        if (sellers) assertEq(held, 0); else assertGt(held, 0);
        vm.warp(box.deadline()); vm.recordLogs(); box.fail(); assertEq(receiver.itemsHeldP(), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs(); uint256 routed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(receiver) && logs[i].topics[0] == keccak256("FailureRouted(uint8,uint8,address,uint256)")
                && logs[i].topics[1] == bytes32(uint256(HeldKind.ITEMS_T_PENDING))) {
                assertEq(logs[i].topics[2], bytes32(uint256(FailRoute.CLOSING_POOL)));
                routed += abi.decode(logs[i].data, (uint256));
            }
        }
        // The final harvest/returned reserve can fund this side again during failure.
        assertGe(routed, held, "all held P plus final funding is transferred to the pot");
        (uint256 pot,) = box.claimState(); assertGe(pot, routed);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP(), 0);
        assertEq(pm.balanceOf(box.roleAddress(16), uint160(box.q())), 0);
        assertEq(pm.balanceOf(box.roleAddress(16), uint160(address(token))), 0);
        _claimBuyer(); _booked();
    }
    function test_IP09_TOutsidePurchaseClaimAndColdGas() public {
        _start(_depthSpec(true, false)); _fill(); box.graduate(); receiver.collect(address(0));
        bytes memory driverCode = address(buyer).code;
        _reveal(1); vm.etch(address(buyer), address(new RewardItemOwner()).code);
        vm.startPrank(address(buyer)); token.approve(box.vault(), type(uint256).max);
        BoxVaultV2(box.vault()).withdraw(1, type(uint256).max, block.timestamp); vm.stopPrank();
        vm.etch(address(buyer), driverCode);
        receiver.collect(address(0));
        uint256 depth = hook.depthBudget(); uint256 pending = IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP();
        vm.deal(address(buyer), 100 ether); _gift(address(receiver), 15 ether); receiver.collect(address(0));
        assertEq(hook.depthBudget() - depth, 11 ether);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP() - pending, 1 ether);
        vm.roll(block.number + 1);
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address impl = release.implementations[i]; if (impl != address(0)) vm.cool(impl);
        }
        ReceiverDeploy.cool(release.implementations[5]); vm.cool(address(pm));
        uint256 beforeGas = gasleft();
        (, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        uint256 used = beforeGas - gasleft(); emit log_named_uint("cold Depth Items T step", used);
        assertLe(used, 3_000_000); assertGt(spent, 0); assertGt(bought, 0);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardBurnPendingT(), 0);
        ItemLedgerV2 items = ItemLedgerV2(box.roleAddress(16)); items.sync(32);
        (uint256 outside, uint256 stash) = items.itemCreditT(1);
        assertEq(outside, bought); assertEq(stash, 0);
        uint256[] memory ids = new uint256[](1); ids[0] = 1;
        uint256 balance = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); assertEq(items.claimT(ids, address(buyer)), bought);
        assertEq(token.balanceOf(address(buyer)), balance + bought); _booked();
    }

    function _take(uint256 count) private {
        bytes memory driverCode = address(buyer).code;
        vm.etch(address(buyer), address(new RewardItemOwner()).code);
        for (uint256 id = 1; id <= count; ++id) {
            _reveal(id);
            vm.startPrank(address(buyer)); token.approve(box.vault(), type(uint256).max);
            BoxVaultV2(box.vault()).withdraw(id, type(uint256).max, block.timestamp); vm.stopPrank();
        }
        vm.etch(address(buyer), driverCode);
        receiver.collect(address(0));
    }

    function testFuzz_IP12_TPurchaseAndResidueConserve(uint96 raw, uint8 out) public {
        uint256 outside = bound(out, 1, 3);
        uint256 gift = bound(raw, 15 ether, 30 ether);
        _start(_depthSpec(true, false)); _fill(); box.graduate(); receiver.collect(address(0));
        _take(outside);
        uint256 depth = hook.depthBudget();
        uint256 pending = IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP();
        vm.deal(address(buyer), gift); _gift(address(receiver), gift); receiver.collect(address(0));
        uint256 choice = gift / 15 * 10;
        uint256 retained = (10 - outside) * (choice / 10);
        assertEq(hook.depthBudget() - depth, gift / 15 * 2 + gift % 15 + retained);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP() - pending, choice - retained);
        pending += choice - retained;
        vm.roll(block.number + 1);
        (, uint256 spent, uint256 bought, uint256 tip) = receiver.buyBack(address(0xBEEF));
        assertGt(bought, 0);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP() + spent + tip, pending);
        ItemLedgerV2 items = ItemLedgerV2(box.roleAddress(16)); items.sync(32);
        uint256[] memory ids = new uint256[](1);
        uint256 paid;
        for (uint256 i; i < outside; ++i) {
            ids[0] = i + 1; vm.prank(address(buyer)); paid += items.claimT(ids, address(buyer));
        }
        uint256 residue = items.flushResidueT();
        assertEq(paid + residue, bought);
        assertEq(pm.balanceOf(address(items), uint160(address(token))), 0);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardBurnPendingT(), 0); _booked();
    }

    function test_IP13_allReturnedItemsReleaseBelowMinimumQueueWithoutBuyingT() public {
        _start(_depthSpec(true, false)); _fill(); box.graduate(); receiver.collect(address(0)); _take(1);
        _gift(address(receiver), 15); receiver.collect(address(0));
        uint256 pending = IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP(); assertGt(pending, 0);
        vm.startPrank(address(buyer));
        BoxCollectionV2(box.collection()).approve(box.vault(), 1);
        BoxVaultV2(box.vault()).returnItem(1, 0, block.timestamp); vm.stopPrank();
        uint256 depth = hook.depthBudget(); uint256 supply = token.totalSupply();
        vm.roll(block.number + 1); (, uint256 spent,,) = receiver.buyBack(address(0));
        assertEq(spent, 0); assertEq(token.totalSupply(), supply);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP(), 0);
        assertGe(hook.depthBudget(), depth + pending); _booked();
    }

    function test_IP17_sellerTTradeRoutesInsidePBeforeBuyingOutsideT() public {
        _start(_depthSpec(true, true)); _fill(); box.graduate(); receiver.collect(address(0)); _take(1);
        vm.deal(address(buyer), 1000 ether);
        buyer.swap(hook.poolKey(), true, 50 ether, TickMath.MIN_SQRT_PRICE + 1); receiver.collect(address(0));
        uint256 pending = IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP();
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 3, layout.sqrtPriceStartX96);
        // Input T fees need enough accumulated conversion proceeds to fund the 10% outside queue.
        for (uint256 i; i < 20; ++i) {
            uint256 beforeT = token.balanceOf(address(buyer));
            buyer.swap(hook.poolKey(), true, box.raise(), TickMath.MIN_SQRT_PRICE + 1);
            buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) - beforeT, TickMath.MAX_SQRT_PRICE - 1);
        }
        _sellFeeP(); vm.recordLogs(); receiver.collect(address(0));
        Vm.Log[] memory logs = vm.getRecordedLogs(); uint256 queued;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(receiver) && logs[i].topics[0] == keccak256("ItemsDepthFunded(uint8,uint8,uint256,uint256,uint256)")) {
                assertEq(logs[i].topics[1], bytes32(uint256(2))); assertEq(logs[i].topics[2], bytes32(uint256(1)));
                (uint256 choice, uint256 depth, uint256 rewards) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(depth, 9 * (choice / 10)); assertEq(choice, depth + rewards); queued += rewards;
            }
        }
        assertGt(queued, 0); assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardsPendingP(), pending + queued);
        vm.roll(block.number + 1); (, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(spent, 0); assertGt(bought, 0);
        ItemLedgerV2 items = ItemLedgerV2(box.roleAddress(16)); items.sync(32);
        (uint256 credit, uint256 stash) = items.itemCreditT(1); assertEq(credit, bought); assertEq(stash, 0);
        assertEq(IBoxReceiverPayInTV21(address(receiver)).rewardBurnPendingT(), 0); _booked();
    }
}
