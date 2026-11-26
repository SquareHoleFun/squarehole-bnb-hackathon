// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BookingFixture, ItemCodeExhausts} from "../m3-23/Fixture.sol";

contract ItemsPoolBookingTest is BookingFixture {
    function test_IP01_graduationDepthReleasesWholeHeldSideOnce() public {
        _items(5, 5, 3, 2);
        _source(1, 150, 150); _source(2, 300, 300); r.collect(address(0));
        assertEq(r.itemsHeldP(), 300);
        vault.request(bytes32(uint256(1)));
        coord.graduation(r);
        _record(1, 1, 3, 0, 100, 0); _record(2, 2, 3, 0, 200, 0);
        assertEq(_balance(address(hook)), 160); assertEq(r.buyBackP(), 200);
        assertEq(r.growHeldP(), 0); assertEq(r.itemsHeldP(), 0);
        items.sync(32); coord.graduation(r); r.collect(address(0));
        assertEq(funding.itemFundingCount(), 2); _booked();
    }
    function testFuzz_IP02_livePConservation(uint96 raw, uint8 out, bool sellers) public {
        uint256 amount = bound(raw, 15, 1e24);
        uint256 outside = bound(out, 0, 4);
        _items(5, 5, 3, 3); coord.graduation(r);
        for (uint256 i; i < outside; ++i) vault.request(bytes32(i + 1));
        uint256 id = sellers ? 2 : 1;
        if (sellers) _source(1, 0, 0);
        _source(id, amount, amount); r.collect(address(0));
        uint256 choice = amount / 15 * 10;
        uint256 depth = (4 - outside) * (choice / 4);
        assertEq(_balance(address(items)), choice - depth);
        assertEq(_balance(address(hook)), amount / 15 * 2 + amount % 15 + depth);
        assertEq(r.buyBackP(), 0); assertEq(r.growHeldP(), 0);
        assertEq(_balance(address(r)) + _balance(address(items)) + _balance(address(hook)), amount);
        items.sync(32);
        uint256 beforeDepth = _balance(address(hook));
        assertEq(items.flushResidue(), choice % 4);
        assertEq(_balance(address(hook)), beforeDepth + choice % 4);
        _booked();
    }
    function testFuzz_IP03_failureHeldDepthGoesToPot(uint96 raw) public {
        uint256 amount = bound(raw, 15, 1e24);
        _items(5, 5, 3, 3); _source(1, amount, amount); r.collect(address(0));
        uint256 beforeHook = _balance(address(hook));
        coord.failure(r);
        assertEq(_balance(address(coord)), amount / 15 * 12);
        assertEq(_balance(address(r)) + _balance(address(coord)) + beforeHook, amount);
        assertEq(r.itemsHeldP(), 0); assertEq(funding.itemFundingCount(), 0);
        assertEq(_balance(address(items)), 0); _booked();
    }
    function test_IP04_depthTransferRefusalRollsBackGraduationAndRetries() public {
        _items(5, 1, 3, 0); _source(1, 150, 150); r.collect(address(0));
        vm.mockCall(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", address(hook), uint160(address(p)), 100), abi.encode(false));
        vm.expectRevert(bytes("ClaimsTransferFailed")); coord.graduation(r);
        assertFalse(r.graduationSettled()); assertEq(r.itemsHeldP(), 100);
        assertEq(funding.itemFundingCount(), 0);
        vm.clearMockedCalls(); coord.graduation(r);
        assertEq(_balance(address(hook)), 120); _booked();
    }
    function test_IP05_noItemCodeOrPriceTokenCodeOnDepthFunding() public {
        _items(5, 5, 3, 3); _source(1, 150, 150); r.collect(address(0));
        vm.etch(address(items), address(new ItemCodeExhausts()).code); coord.graduation(r); _source(3, 150, 150); p.setPaused(true); r.collect{gas: 4_000_000}(address(0));
        assertEq(_balance(address(hook)), 240); assertEq(r.buyBackP(), 0); _booked();
    }
}
