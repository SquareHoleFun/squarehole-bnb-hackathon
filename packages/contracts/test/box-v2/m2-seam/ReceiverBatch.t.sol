// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {ReceiverFixture, ReceiverArgs, BoxReceiverV2, BoxReceiverV2Args, BoxClones} from "../cq11-b/ReceiverFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

interface BatchReceiver {
    function holderBatchClosed(uint256 id) external view returns (bool);
    function harvestedFees() external view returns (uint256 buyers, uint256 sellers, uint256 reserve);
}
// Only a test harness exposes final funding: M2-30 will call the internal seam from collect.
contract ReceiverFundingHarness is BoxReceiverV2 {
    constructor(IPoolManager pm, address c, address f, address p, address x) BoxReceiverV2(pm, c, f, p, ReceiverDeploy.code(pm)) {}
    function fundBatch(uint256 id, uint256 amount) external locked { _fundHolderBatch(id, amount); }
}
contract ReceiverBatchTest is ReceiverFixture {
    function test_B2_openAndClosedZeroAreDifferent() public {
        (bool ok, bytes memory data) = address(r).staticcall(abi.encodeCall(BatchReceiver.holderBatchClosed, (1)));
        assertTrue(ok, "B2: closed-zero needs an explicit closure read");
        assertFalse(abi.decode(data, (bool)));
        assertEq(r.holderBatchPaid(1), 0);
    }
    function test_B2_finalFundingIsImmutableAndCannotSpendBookedFees() public {
        implementation = new ReceiverFundingHarness(pm, coordinatorCode, FIT, PLATFORM, CONVERSION);
        ReceiverArgs memory args = _args(1, 1, 1, address(p));
        args.holderLedger = address(0x1717);
        r = _clone(args);
        coord.initialize(r);
        ReceiverFundingHarness funded = ReceiverFundingHarness(address(r));
        // Only the hook authenticates a closed trade batch; an open id cannot be funded.
        vm.mockCall(address(hook), abi.encodeWithSignature("tradeBatch(uint256)", 1), abi.encode(7, 0, 0, false));
        vm.expectRevert(); funded.fundBatch(1, 0);
        vm.mockCall(address(hook), abi.encodeWithSignature("tradeBatch(uint256)", 1), abi.encode(7, 0, 0, true));
        funded.fundBatch(1, 0);
        assertTrue(BatchReceiver(address(r)).holderBatchClosed(1));
        assertEq(r.holderBatchPaid(1), 0);
        assertFalse(BatchReceiver(address(r)).holderBatchClosed(3));
        _fees(150, 0); r.collect(address(0)); // all 150 are booked, even though physically here
        vm.mockCall(address(hook), abi.encodeWithSignature("tradeBatch(uint256)", 3), abi.encode(10, 0, 60, true));
        vm.expectRevert(); funded.fundBatch(3, 1);
        driver.mintClaims(_currency(), address(r), 17);
        uint256 before = _balance(address(r));
        funded.fundBatch(3, 17);
        assertEq(r.holderBatchPaid(3), 17);
        assertEq(_balance(args.holderLedger), 17);
        assertEq(_balance(address(r)), before - 17);
        driver.mintClaims(_currency(), address(r), 43); // later funding cannot refill a closed shortfall
        vm.expectRevert(); funded.fundBatch(3, 0);
        vm.expectRevert(); funded.fundBatch(1, 1); // later money cannot revive a zero-funded batch
        assertEq(r.booked(r.q()), 150);
    }
    function test_B3_receiverKeepsHarvestSidesApartFromGiftsAndFailedTips() public {
        ReceiverArgs memory args = _args(1, 1, 1, address(p));
        args.holderLedger = address(0x1717);
        r = _clone(args);
        coord.initialize(r);
        _fees(3000, 1500);
        driver.mintClaims(_currency(), address(r), 900);
        hook.script(3000, 1500, 30);
        p.setPaused(true);
        assertEq(r.collect(TIP).tip, 0, "paused P refuses only the last tip");
        assertEq(r.booked(r.q()), 5300, "refused tip stays unbooked");
        r.collect(address(0)); // book the old 100 without inventing a new trade receipt
        (bool ok, bytes memory data) = address(r).staticcall(abi.encodeCall(BatchReceiver.harvestedFees, ()));
        assertTrue(ok, "B3: harvest's buyers return cannot be discarded");
        (uint256 b, uint256 s, uint256 reserve) = abi.decode(data, (uint256, uint256, uint256));
        assertEq(b, 3000); assertEq(s, 1500); assertEq(reserve, 30);
        assertEq(r.creatorP(), 3600, "M1 still splits all 5400");
        assertEq(r.booked(r.q()), 5400);
    }
    function _currency() private view returns (Currency) { return Currency.wrap(r.q()); }
}
import {Currency} from "v4-core/src/types/Currency.sol";
