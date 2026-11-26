// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M363Base} from "../../../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxTokenV2} from "../../../../../src/box-v2/BoxTokenV2.sol";
import {ClaimCap} from "../../../gas/m3/ClaimCap.sol";

/// Round 2: the same mandatory token history must fit every non-discretionary money exit.
/// Protocol parts are real factory clones. No runtime replacement in the production assertions.
contract Round2RemainingExitsTest is M363Base {
    function _holdersAndBurn() internal {
        BoxSpec memory s = _menu(2, 3);
        s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s);
        _fill();
        box.graduate();
        receiver.collect(address(0));
        assertGt(receiver.buyBackP(), 0);
        assertTrue(box.roleAddress(17) != address(0));
        // A real eligible holder makes the authoritative eligible-supply history nonzero.
        // An all-unregistered-contract fixture misses that mandatory storage write on every burn.
        vm.prank(address(buyer)); token.transfer(address(0xA11CE), 1 ether);
        vm.roll(block.number + 1);
    }

    function test_FINAL2_M02_boughtLedgerTAlwaysHasBurnExit() public {
        _holdersAndBurn();
        uint256 supply = token.totalSupply();
        (,, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(bought, 0);
        // Either immediate burn or the documented permissionless retry must destroy all bought T.
        receiver.burnPending();
        assertEq(receiver.tBurnPending(), 0, "bought T must not be stranded by the fixed burn allowance");
        assertEq(token.totalSupply(), supply - bought);
        assertEq(token.balanceOf(address(receiver)), 0);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
    }

    function test_pendingBurnCapControlDestroysSameTOnceWithoutSpendingP() public {
        _holdersAndBurn();
        bytes memory implementation = release.implementations[5].code;
        uint256 supply = token.totalSupply();
        // Hold actual purchased T on both EVMs; the production assertion above uses no double.
        vm.etch(release.implementations[5], ClaimCap.replace(abi.encodePacked(implementation), 1_000_000, 1, 1));
        (,, uint256 bought,) = receiver.buyBack(address(0));
        assertGt(bought, 0);
        assertEq(receiver.tBurnPending(), bought);
        assertEq(token.balanceOf(address(receiver)), bought);
        assertEq(token.totalSupply(), supply);
        bytes32 money = _burnMoney();
        vm.etch(release.implementations[5],
            ClaimCap.replace(abi.encodePacked(implementation), 1_000_000, 1_500_000, 1));
        vm.cool(address(token)); vm.cool(release.implementations[20]);
        vm.cool(address(receiver)); vm.cool(release.implementations[5]); vm.cool(address(pm));
        assertEq(receiver.burnPending(), bought);
        assertEq(token.balanceOf(address(receiver)), 0);
        assertEq(receiver.tBurnPending(), 0);
        assertEq(token.totalSupply(), supply - bought);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
        assertEq(_burnMoney(), money, "retry burns only the bought T; no P or holder balance moves");
        assertEq(receiver.burnPending(), 0);
        assertEq(token.totalSupply(), supply - bought);
    }

    function _burnMoney() private view returns (bytes32) {
        return keccak256(abi.encode(pm.balanceOf(address(receiver), 0), receiver.buyBackP(),
            receiver.fitOwed(), receiver.platformOwed(), receiver.booked(address(0)),
            address(pm).balance, token.balanceOf(address(0xA11CE))));
    }

    function _royaltyReady() internal returns (BoxTokenV2 royalty) {
        BoxSpec memory s = _menu(3, 3);
        s.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s);
        _fill();
        box.graduate();
        royalty = token;
        vm.prank(address(buyer));
        royalty.transfer(address(this), 1 ether);
        // A different ETH-priced box accepts A's token as a non-P royalty.
        _start(_menu(3, 3));
        royalty.approve(address(receiver), 1 ether);
    }

    function test_RC5_foreignRoyaltyRejectedBeforeCustody() public {
        _royaltyReady();
        uint256 beforeBalance = address(receiver).balance;
        (bool ok,) = address(receiver).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(0xDEAD), 1));
        assertFalse(ok, "RC5: receiver accepts only P");
        assertEq(address(receiver).balance, beforeBalance);
    }

    /// F136 (SH-V21-RC5-INT fix round): the held lot survives the failure and then stays in the box for good, with the
    /// historical stipend control too; pot, count and FIT are untouched.

}
