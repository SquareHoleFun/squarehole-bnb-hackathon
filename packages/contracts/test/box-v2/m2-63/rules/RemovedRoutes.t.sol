// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M244Base} from "../../m2-44/Fixture.sol";

contract M263RemovedRoutesTest is M244Base {
    function test_P06_removedRoutesHaveNoDispatcherEntryBeforeOrAfterFailure() public {
        _createShop(0, 1000 ether, false, true); _trade(); receiver.collect(address(0));
        _refuseRemoved();
        vm.warp(box.deadline()); box.fail(); _refuseRemoved();
    }

    function _refuseRemoved() private {
        // These retired M2/CQ11 routes must never be admitted by a fallback, including with full calldata.
        string[12] memory signatures = [string("claimFor(uint256,address)"), "claimFor(uint256[])",
            "settleCap()", "claimTip(address)", "redeemHeldT()", "enterClosing()", "priceAverage()",
            "convert(address,uint256)", "gift(address,uint256)", "setRule(address)",
            "setTarget(address)", "setLeg(address)"];
        uint256[7] memory roles = [uint256(0), 1, 2, 3, 5, 17, 19];
        uint256 held = _pClaims(address(ledger));
        uint256 supply = token.totalSupply(); uint256 creatorT = token.balanceOf(CREATOR);
        for (uint256 i; i < roles.length; ++i) {
            address target = box.roleAddress(roles[i]); assertGt(target.code.length, 0);
            for (uint256 j; j < signatures.length; ++j) {
                // Offset 32 also encodes a valid empty array. Other entries receive nonzero scalar/address words.
                bytes memory data = j == 1
                    ? abi.encodeWithSelector(bytes4(keccak256(bytes(signatures[j]))), new uint256[](0))
                    : abi.encodePacked(bytes4(keccak256(bytes(signatures[j]))), abi.encode(uint256(1), CREATOR, uint256(0)));
                vm.prank(CREATOR); (bool ok,) = target.call(data);
                assertFalse(ok, signatures[j]);
            }
        }
        assertEq(_pClaims(address(ledger)), held); assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(CREATOR), creatorT);
        assertEq(box.roleAddress(11), address(0), "no swap module clone");
        assertEq(box.roleAddress(20), address(0), "implementation slots are not roles");
        assertEq(box.roleAddress(21), address(0));
    }
}
