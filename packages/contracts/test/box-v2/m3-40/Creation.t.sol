// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M340Base} from "./Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M340CreationTest is M340Base {
    function test_S6_role16IsInitializedBeforeReceiver() public {
        box = _create(_items(1, 2));
        IItemLedgerV2(box.roleAddress(16)).sync(1);
        assertEq(uint256(vm.load(address(box), bytes32(0))) >> 249, 0, "collection is not PILE");
    }

    function test_S5_seededAliasAuthenticatesAndOpensOnlyAfterSeed() public {
        box = _create(_pile(address(0), 1 ether));
        assertEq(box.starterSetLoader(), box.vault());
        assertFalse(box.gateOpen());
        assertTrue(box.starterSetPending());
        assertEq(uint256(vm.load(address(box), bytes32(0))) >> 249, 1, "cached authenticated PILE");
        IPileVaultV2 pile = IPileVaultV2(payable(box.vault()));
        vm.prank(CREATOR);
        pile.loadSeed{value: 1 ether}();
        assertTrue(box.gateOpen());
        assertFalse(box.starterSetPending());
    }

    function test_S5_zeroSeedPileExcludesLiquidAndClaimsT() public {
        _start(_pile(address(0), 0));
        _buy(box.raise() / 5);
        uint256 held = token.balanceOf(address(buyer));
        uint256 liquid = held / 5;
        uint256 claims = held / 7;
        address pile = box.vault();
        // Adversarial custody setup: T refuses public direct gifts to its vault.
        vm.prank(address(buyer));
        token.approve(pile, liquid);
        vm.prank(pile);
        token.transferFrom(address(buyer), pile, liquid);
        buyer.mintClaims(Currency.wrap(address(token)), box.vault(), claims);
        vm.warp(box.deadline());
        box.fail();
        (, uint256 left) = box.claimState();
        assertEq(left, held - liquid - claims, "only holder T may claim");
        assertEq(left, token.balanceOf(address(buyer)));
        _claimBuyer();
        assertEq(token.balanceOf(box.vault()), liquid);
        assertEq(pm.balanceOf(box.vault(), uint160(address(token))), claims);
    }
}
