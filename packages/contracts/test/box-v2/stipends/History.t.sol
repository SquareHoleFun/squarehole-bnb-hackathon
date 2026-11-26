// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";

/// A live holder notice always asks for the current checkpoint. Its cost must not grow with history.
contract CurrentHistoryStipendTest is M363Base {
    function test_currentSupplyReadDoesNotSpendStipendOnOldHistory() public {
        BoxSpec memory s = _menu(3, 3);
        s.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _fill();
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(token));
        address wallet = address(0x12345);
        uint256 prior = history.holderCheckpoint();
        vm.prank(address(buyer)); token.transfer(wallet, 10_000);
        uint256 first = history.holderCheckpoint();
        vm.pauseGasMetering();
        for (uint256 i; i < 1024; ++i) {
            vm.prank(i % 2 == 0 ? wallet : address(buyer));
            token.transfer(i % 2 == 0 ? address(buyer) : wallet, 1);
        }
        vm.resumeGasMetering();
        uint256 current = history.holderCheckpoint();
        assertEq(history.eligibleSupplyAt(prior), 0);
        assertEq(history.eligibleSupplyAt(first), 10_000);
        assertEq(history.eligibleSupplyAt(first + 1), 9_999);
        vm.cool(address(token)); vm.cool(release.implementations[20]);
        uint256 start = gasleft();
        uint256 eligible = history.eligibleSupplyAt(current);
        uint256 used = start - gasleft();
        emit log_named_uint("current eligible supply cold read", used);
        assertEq(eligible, 10_000);
        assertLe(used, 20_000, "current notice query must be constant work, independent of old history");
        vm.expectRevert(BoxTokenV2Ledger.InvalidHistoryRequest.selector);
        history.eligibleSupplyAt(current + 1);
    }
}
