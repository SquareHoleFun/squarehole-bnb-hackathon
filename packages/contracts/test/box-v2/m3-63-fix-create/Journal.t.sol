// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "./Fixture.sol";
import {TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract M363JournalTest is M363Base {
    function test_itemsOnlyAttributesBothSidesAndSealsEachSourceOnce() public {
        _start(_items(1, 2));
        assertEq(hook.holderLedger(), address(0));
        assertGt(hook.tradeBatch(1).protocolUnits, 0, "bootstrap remains protocol money");
        assertEq(hook.tradeBatch(1).tradeUnits, 0);
        assertEq(hook.currentTradeBatch(true), 1);
        assertEq(hook.currentTradeBatch(false), 2);

        // Initialization is the last role-16 read. No item code, including views, may run on fees.
        address item = box.roleAddress(16);
        vm.mockCallRevert(address(box), abi.encodeCall(box.roleAddress, (16)), "no role reread");
        vm.expectCall(item, bytes(""), uint64(0));
        (uint256 paid, uint256 received) = _buy(1 ether);
        assertEq(hook.tradeBatch(1).tradeUnits, (paid + 99) / 100);
        buyer.swap(hook.poolKey(), false, received / 4, layout.sqrtPriceStartX96);
        uint256 saleFees = hook.saleFeesPending();
        assertEq(saleFees, 0, "curve T fees burn");
        assertEq(hook.tradeBatch(2).tradeUnits, (received / 4 + 99) / 100);
        assertEq(hook.tradeBatch(2).netP, saleFees);
        receiver.collect(address(0));
        TradeBatchV2 memory buy = hook.tradeBatch(1);
        TradeBatchV2 memory sell = hook.tradeBatch(2);
        assertTrue(buy.closed && sell.closed);
        assertGt(buy.netP, 0, "actual post-D6 buyer backing recorded");
        assertEq(sell.netP, saleFees);
        assertEq(hook.currentTradeBatch(true), 3);
        assertEq(hook.currentTradeBatch(false), 4);
        assertGt(receiver.itemsHeldP(), 0);
        _booked();
        _buy(0.01 ether);
        receiver.collect(address(0));
        assertEq(abi.encode(hook.tradeBatch(1)), abi.encode(buy), "closed buyer source immutable");
        assertEq(abi.encode(hook.tradeBatch(2)), abi.encode(sell), "closed seller source immutable");
        assertEq(hook.currentTradeBatch(true), 5);
    }

    function test_plainBoxNeverStartsJournalingAfterInitialization() public {
        _start(_spec());
        vm.mockCall(address(box), abi.encodeCall(box.roleAddress, (16)), abi.encode(address(0xBAD)));
        _buy(1 ether);
        receiver.collect(address(0));
        assertEq(hook.currentTradeBatch(true), 0);
        assertEq(hook.currentTradeBatch(false), 0);
        TradeBatchV2 memory empty;
        assertEq(abi.encode(hook.tradeBatch(1)), abi.encode(empty));
        assertEq(abi.encode(hook.tradeBatch(2)), abi.encode(empty));
    }

    function test_itemsOnlyFailureSealsFinalFeesAndHeldMoneyExitsThroughClaim() public {
        _start(_items(2, 1));
        _buy(1 ether);
        receiver.collect(address(0));
        assertGt(receiver.itemsHeldP(), 0);
        uint256 id = hook.currentTradeBatch(true);
        _buy(0.01 ether);
        vm.warp(box.deadline());
        box.fail();
        assertTrue(hook.tradeBatch(id).closed);
        assertTrue(hook.tradeBatch(id + 1).closed);
        assertEq(receiver.itemsHeldP(), 0);
        assertEq(pm.balanceOf(box.roleAddress(16), 0), 0);
        uint256 next = hook.currentTradeBatch(true);
        receiver.collect(address(0));
        assertEq(hook.currentTradeBatch(true), next, "failed harvest does not close twice");
        assertGt(_claimBuyer(), 0);
    }

    function test_itemsOnlyMigrationClosesPairButDeepenKeepsCurrentPair() public {
        _start(_items(1, 2));
        _fill();
        uint256 id = hook.currentTradeBatch(true);
        box.graduate();
        assertTrue(hook.tradeBatch(id).closed);
        assertTrue(hook.tradeBatch(id + 1).closed);
        receiver.collect(address(0));
        id = hook.currentTradeBatch(true);
        _gift(address(hook), 0.1 ether);
        vm.roll(block.number + 1);
        hook.deepen(address(0));
        assertEq(hook.currentTradeBatch(true), id);
        assertFalse(hook.tradeBatch(id).closed);
    }
}
