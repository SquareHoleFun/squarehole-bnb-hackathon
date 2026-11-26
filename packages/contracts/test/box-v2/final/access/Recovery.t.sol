// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M260Measure} from "../../gas/m2/Measure.sol";

contract FinalRecoveryTest is M260Measure {
    /// G01: the old 1M keeper floor silently skips the optional return; the measured 2M envelope makes progress.
    /// The TypeScript check binds the finding to actual M2_GAS, so fixing that source makes the retained red green.
    function test_G01_returnSkipsAtOldFloorThenRecoversAtMeasuredEnvelope() public {
        _createShop(0, 1000 ether, true, false);
        _page(0, 10);
        vm.warp(box.openAt() + 14 days);
        box.failClosed();
        (uint256 pot, uint256 left) = box.claimState();
        uint256[] memory indexes = new uint256[](1);
        bytes memory data = abi.encodeCall(shop.returnStarter, (indexes));
        (bytes memory skipped,) = _measure("old keeper floor", address(shop), ALICE, data, 1_000_000);
        assertEq(abi.decode(skipped, (uint256)), 0, "successful transaction silently does no work");
        assertEq(nft.ownerOf(0), address(shop));
        (bytes memory paid,) = _measure("measured caller envelope", address(shop), ALICE, data, 2_000_000);
        assertEq(abi.decode(paid, (uint256)), 1);
        assertEq(nft.ownerOf(0), CREATOR, "permissionless trigger cannot redirect custody");
        assertEq(shop.inside(), 9);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left);
        (bytes memory retry,) = _measure("already returned", address(shop), ALICE, data, 2_000_000);
        assertEq(abi.decode(retry, (uint256)), 0, "one return only");
    }
}
