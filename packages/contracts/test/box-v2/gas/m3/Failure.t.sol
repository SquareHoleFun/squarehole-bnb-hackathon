// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";
import {M360Measure} from "./Measure.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxLayoutV2} from "../../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../../kit/BoxV2TestBase.sol";

contract M360FailureTest is M360Measure {
    function test_itemsDeadline() public {
        _failure(1, false);
    }

    function test_itemsUnopened() public {
        _failure(2, false);
    }

    function test_itemsHatch() public {
        _failure(3, false);
    }

    function test_pileDeadline() public {
        _failure(1, true);
    }

    function test_pileUnopened() public {
        _failure(2, true);
    }

    function test_pileHatch() public {
        _failure(3, true);
    }

    function _failure(uint8 cause, bool pile) private {
        BoxSpec memory s = pile ? _pile(address(0), cause == 2 ? 1 ether : 0) : _hiddenItems(1, 2);
        address owner;
        if (cause == 2) {
            s.creatorBuy = s.raise / 10;
            box = _create(s);
            assertFalse(box.gateOpen());
            owner = CREATOR;
            token = BoxTokenV2(box.token());
            hook = IBoxHookV2(box.hook());
            receiver = IBoxReceiverV2(box.receiver());
            layout = BoxLayoutV2.curve(s.raise, false);
            buyer = new PoolDriver(pm);
            vm.deal(address(buyer), s.raise * 10);
        } else {
            _start(s);
            _buy(s.raise / 5);
            owner = address(buyer);
        }
        _gift(address(receiver), 15000);
        receiver.collect(address(0));
        if (!pile) assertGt(receiver.itemsHeldP(), 0);
        if (cause == 3) _fill();
        vm.warp(cause == 1 ? box.deadline() : cause == 2 ? box.openAt() + 14 days : hook.closedAt() + 7 days);
        bytes memory data =
            cause == 2 ? abi.encodeCall(IBoxCoordinatorV2.failClosed, ()) : abi.encodeCall(IBoxCoordinatorV2.fail, ());
        uint256 money = _money();
        _measure(
            string.concat(pile ? "pile failure " : "items failure ", vm.toString(cause)),
            address(box),
            address(this),
            data,
            15_000_000
        );
        assertEq(_money(), money);
        assertTrue(box.failed());
        assertEq(receiver.itemsHeldP(), 0);
        if (!pile) assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        (uint256 pot, uint256 left) = box.claimState();
        uint256 held = token.balanceOf(owner);
        assertEq(left, held);
        assertGt(held, 0);
        vm.prank(owner);
        token.approve(address(box), held);
        uint256 snapshot = vm.snapshotState();
        uint256 before = owner.balance;
        (bytes memory ret,) = _measure(
            "failure owner claim",
            address(box),
            owner,
            abi.encodeCall(IBoxCoordinatorV2.claim, (held, owner)),
            9_000_000 // RC7: inbox allowance plus its retained post-sweep reserve, even when empty.
        );
        assertEq(abi.decode(ret, (uint256)), pot);
        assertEq(owner.balance - before, pot);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, 0);
        assertEq(afterLeft, 0);
        assertTrue(vm.revertToState(snapshot));
        vm.warp(box.failedAt() + 365 days);
        uint256 fit = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        assertEq(box.quoteClaim(left), pot);
        if (!pile) {
            address vault = box.vault();
            _measure(
                "failed item creator release",
                vault,
                BOB,
                abi.encodeCall(IBoxVaultV2.releaseToCreator, (_one(1))),
                CUSTODY_LIMIT
            );
            assertEq(IBoxVaultItemsV2(vault).itemLifecycleCount(), 1);
        }
    }
}
