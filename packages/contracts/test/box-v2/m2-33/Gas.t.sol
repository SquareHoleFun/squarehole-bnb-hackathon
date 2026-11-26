// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {StarterFixture} from "./StarterFixture.sol";

contract StarterGasTest is StarterFixture {
    function test_tenThousandItemsInBoundedColdPages() public {
        vm.pauseGasMetering(); _make(10000, 400, false, 0, false); _seed();
        uint256 maximum; uint256 total; uint256 pages;
        for (uint256 start; start < 10000;) {
            uint256 n = 10000 - start < 32 ? 10000 - start : 32;
            (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(start, n);
            bytes32 next = suffix[start + n];
            // Reset access warmth between pages, as in separate creator transactions.
            vm.cool(address(loader)); vm.cool(loaderImpl); vm.cool(address(shop)); vm.cool(shopImpl);
            vm.cool(address(box)); vm.cool(address(nft));
            vm.resetGasMetering(); vm.resumeGasMetering();
            vm.prank(CREATOR);
            uint256 beforeGas = gasleft();
            loader.load{gas: 25_000_000}(cs, ids, tiers, next);
            uint256 used = beforeGas - gasleft();
            vm.pauseGasMetering();
            if (used > maximum) maximum = used; total += used; ++pages; start += n;
            (uint32 loaded, bytes32 remaining, bool done) = loader.progress();
            assertEq(loaded, start); assertEq(remaining, next); assertFalse(done); assertFalse(box.gateOpen());
            assertEq(shop.inside(), start); assertEq(nft.balanceOf(address(shop)), start);
        }
        loader.complete(); assertTrue(box.gateOpen()); assertEq(nft.balanceOf(CREATOR), 0);
        assertEq(pages, 313); assertGt(maximum, 0); assertLt(maximum, 25_000_000);
        emit log_named_uint("largest 32-item page gas", maximum);
        emit log_named_uint("10000-item load gas total", total);
        emit log_named_uint("pages", pages);
        vm.resumeGasMetering();
    }
}
