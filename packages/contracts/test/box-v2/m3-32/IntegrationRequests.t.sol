// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M332Base} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// Former handoff refusals now require successful creation with the production hook and checker.
contract M332IntegrationRequestsTest is M332Base {
    function test_request_hookMustJournalItemsOnlyBeforeReceiverInitialization() public {
        _accepted(_items(1, 0));
        assertEq(IBoxHookV2(box.hook()).currentTradeBatch(true), 1);
        assertEq(IBoxHookV2(box.hook()).currentTradeBatch(false), 2);
    }

    function test_request_checkerMustReadSeededPileAfterAuthenticatedAlias() public {
        _accepted(_pile(address(0), 1 ether));
        assertEq(box.roleAddress(19), box.vault());
        assertTrue(box.starterSetPending());
    }

    function test_request_checkerMustReadPileInsteadOfCollectionVault() public {
        _accepted(_pile(address(0), 0));
        assertEq(box.roleAddress(19), address(0));
        assertFalse(box.starterSetPending());
    }

    function test_request_checkerMustAdmitMixedHolderItemsReadback() public {
        BoxSpec memory s = _items(1, 0);
        s.sellers.a.leg = 1;
        s.sellers.a.dest = 6;
        s.sellers.a.destParams = abi.encode(uint8(1));
        _accepted(s);
        assertTrue(box.roleAddress(16) != address(0));
        assertTrue(box.roleAddress(17) != address(0));
    }

    function _accepted(BoxSpec memory s) private {
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        (, address created,) = factory.createBox{value: p.payment}(s, cs, hs);
        box = BoxCoordinatorV2(created);
        assertEq(created, p.roles[0]);
        assertEq(CREATOR.balance, before - p.payment);
        assertEq(registry.boxCount(), 1);
        assertEq(address(factory).balance, 0);
        for (uint256 i; i < 24; ++i) {
            assertEq(box.roleAddress(i), p.roles[i]);
            if (p.roles[i] != address(0)) assertGt(p.roles[i].code.length, 0);
        }
    }
}
