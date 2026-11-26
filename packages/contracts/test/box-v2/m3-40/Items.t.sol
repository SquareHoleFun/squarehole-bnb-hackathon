// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M340Base} from "./Fixture.sol";
import {Vm} from "forge-std/Vm.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";

contract M340ItemsTest is M340Base {
    function test_R9_deadlineBothPolicies() public { _itemsFailure(1, false); }
    function test_R9_unopenedBothPolicies() public { _itemsFailure(2, false); }
    function test_R9_hatchBothPolicies() public { _itemsFailure(3, false); }
    function test_R9_deadlineReversedPolicies() public { _itemsFailure(1, true); }
    function test_R9_unopenedReversedPolicies() public { _itemsFailure(2, true); }
    function test_R9_hatchReversedPolicies() public { _itemsFailure(3, true); }

    function _itemsFailure(uint8 cause, bool reverse) private {
        BoxSpec memory s = _hiddenSpec();
        s.buyers.a = Branch(1, 8, "", abi.encode(uint8(reverse ? 2 : 1)));
        s.sellers.a = Branch(1, 8, "", abi.encode(uint8(reverse ? 1 : 2)));
        if (cause == 2) {
            // Real metadata/text chunks deliberately remain unloaded, with a real creation-block buyer.
            s.creatorBuy = s.raise / 10;
            box = _create(s);
            assertFalse(box.gateOpen());
            _bind(s);
        } else {
            _start(s);
            _buy(s.raise / 5);
            buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 9, layout.sqrtPriceStartX96);
        }
        _gift(address(receiver), 1500);
        receiver.collect(address(0));
        uint256 held = receiver.itemsHeldP();
        assertGt(held, 0);
        if (cause == 3) _fill();
        // Direct pot and hook gifts are principal. Neither may enter the D6 fee split.
        _gift(address(box), 300001);
        _gift(address(hook), 500003);
        _gift(address(receiver), 14);
        receiver.fundRoyalty{value: 17}(address(0), 17);
        uint256 beforeMoney = _money();
        uint256 next = hook.currentTradeBatch(true);
        uint256 fitBefore = receiver.fitOwed();
        uint256 platformBefore = receiver.platformOwed();
        uint256 boundary = cause == 1 ? box.deadline() : cause == 2 ? box.openAt() + 14 days : hook.closedAt() + 7 days;
        vm.warp(boundary - 1);
        vm.expectRevert();
        _fail(cause);
        assertFalse(box.failed());
        vm.warp(boundary);
        // No NFT transfer or ledger code may participate in closure.
        vm.mockCallRevert(box.collection(), abi.encodeWithSignature("transferFrom(address,address,uint256)"), "NFT paused");
        vm.mockCallRevert(box.roleAddress(16), abi.encodeWithSignature("sync(uint256)"), "ledger paused");
        vm.recordLogs();
        _fail(cause);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reserve = hook.reserveMinted();
        uint256 units;
        uint256 dust;
        for (uint256 id = next; id < next + 4; ++id) {
            uint256 net = hook.tradeBatch(id).netP;
            units += net / 15;
            dust += net % 15;
        }
        units += (reserve + 14) / 15;
        dust += (reserve + 14) % 15;
        assertEq(receiver.platformOwed(), platformBefore + units, "only final source fees and D6 split");
        assertEq(receiver.fitOwed(), fitBefore + 2 * units, "source dust stays in pot");
        _routing(logs, reserve, held + 10 * units);
        assertEq(_money(), beforeMoney, "closure conserves real native P including tip");
        assertEq(receiver.itemsHeldP(), 0);
        assertEq(receiver.poolHeldP(), 0);
        assertEq(receiver.royaltyHeldP(), 0);
        assertEq(receiver.buyBackP(), 0, "inside policy never burns failed Items");
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        assertEq(pm.balanceOf(box.roleAddress(16), 0), 0);
        assertEq(uint256(box.failCause()), uint256(cause == 1 ? FailCause.Deadline : cause == 2 ? FailCause.ClosedPastCap : FailCause.GraduationTimedOut));
        (uint256 pot, uint256 left) = box.claimState();
        assertGt(pot, 800004 + dust, "principal and held Items join the pot");
        assertEq(left, token.balanceOf(address(buyer)) + token.balanceOf(CREATOR));
        assertEq(BoxVaultV2(box.vault()).failureWindowEnds(), boundary + 14 days);
        vm.prank(address(box));
        receiver.enterFailure();
        receiver.collect(address(0));
        (uint256 samePot, uint256 sameLeft) = box.claimState();
        assertEq(samePot, pot, "no replay of held allocations");
        assertEq(sameLeft, left);
        uint256 fit = receiver.fitOwed();
        receiver.fundRoyalty{value: 23}(address(0), 23);
        assertEq(receiver.fitOwed(), fit, "converted late royalty is whole pot");
        assertEq(box.quoteClaim(left), pot + 23);
        _booked();
        vm.clearMockedCalls();
    }

    function _routing(Vm.Log[] memory logs, uint256 reserve, uint256 held) private view {
        uint256 forwarded;
        uint256 items;
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(box) && l.topics[0] == keccak256("ClaimsForwarded(address,uint256)")) {
                assertEq(address(uint160(uint256(l.topics[1]))), address(receiver));
                forwarded += abi.decode(l.data, (uint256));
            }
            if (l.emitter == address(receiver) && l.topics[0] == keccak256("FailureRouted(uint8,uint8,address,uint256)") && uint256(l.topics[1]) == 7) {
                assertEq(uint256(l.topics[2]), 1);
                items += abi.decode(l.data, (uint256));
                ++count;
            }
        }
        assertEq(forwarded, reserve, "D6 alone crosses to receiver, never principal");
        assertEq(items, held, "both held sides plus final D6 Items exactly once");
        assertEq(count, 1);
    }

    function test_R28B_placeholderHandBackAtFourteenDayBoundaryThenClaim() public {
        BoxSpec memory s = _hiddenSpec();
        s.buyers.a = Branch(1, 8, "", abi.encode(uint8(1)));
        _start(s);
        _buy(s.raise / 4);
        BoxTicketsV2 tickets = BoxTicketsV2(box.tickets());
        vm.startPrank(address(buyer));
        token.approve(address(tickets), type(uint256).max);
        uint256 id = tickets.take(1, type(uint256).max, block.timestamp);
        vm.stopPrank();
        vm.warp(box.deadline());
        box.fail();
        IBoxVaultV2 v = IBoxVaultV2(box.vault());
        (uint256 q,) = v.quoteHandBack(1);
        (, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(address(buyer)) + q);
        (, uint256 waivedFee) = v.quoteHandBack(1);
        assertEq(waivedFee, 0);
        vm.warp(BoxVaultV2(address(v)).failureWindowEnds() - 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(address(buyer));
        (uint256 returned, uint256 fee) = tickets.handBack(ids, q, block.timestamp);
        assertEq(returned, q);
        assertEq(fee, 0);
        _claimBuyer();
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
    }

    function _bind(BoxSpec memory s) private {
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        layout = BoxLayoutV2.curve(s.raise, false);
        buyer = new PoolDriver(pm);
        vm.deal(address(buyer), s.raise * 10);
    }

    function _fail(uint8 cause) private {
        if (cause == 2) box.failClosed(); else box.fail();
    }
}
