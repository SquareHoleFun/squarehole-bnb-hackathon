// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M332IntegrationBase} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxFactoryPileV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

contract M332CreationTest is M332IntegrationBase {
    function test_S6_plainCreationKeepsItsOrderAndNoM3Roles() public {
        BoxCoordinatorV2 c = _assertCreation(_spec(), hex"01050608");
        assertEq(c.roleAddress(16), address(0));
        assertFalse(IBoxFactoryPileV2(address(factory)).isPileVault(c.vault()));
    }

    function test_S1_S6_eachItemsSideCreatesOneAuthenticatedLedger() public {
        for (uint8 side = 1; side <= 3; ++side) {
            uint8 b = side == 2 ? 0 : 1;
            uint8 s = side == 1 ? 0 : 2;
            BoxCoordinatorV2 c = _assertCreation(_items(b, s), hex"01050603040810");
            address ledger = c.roleAddress(16);
            assertEq(ledger.code.length, BoxClones.ARGS_OFFSET + 206);
            assertEq(IBoxReceiverV2(c.receiver()).itemLedger(), ledger);
            assertEq(IBoxVaultV2(c.vault()).itemLedger(), ledger);
            (uint8 actualB, uint8 actualS) = IItemLedgerV2(ledger).insidePolicies();
            assertEq(actualB, b);
            assertEq(actualS, s);
            // Initialization must have run from the authenticated coordinator before the receiver.
            IItemLedgerV2(ledger).sync(1);
        }
    }

    function test_S5_S6_seededPileIsCreatedOnceAndSeedIsSeparate() public {
        uint256 seed = 3 ether;
        BoxSpec memory s = _pile(address(0), seed);
        uint256 before = CREATOR.balance;
        BoxCoordinatorV2 c = _assertCreation(s, hex"0105060308");
        assertEq(before - CREATOR.balance, releasePayment(s));
        assertEq(c.roleAddress(19), c.vault());
        assertEq(c.roleAddress(4), address(0));
        assertEq(c.roleAddress(7), address(0));
        assertEq(c.roleAddress(16), address(0));
        assertEq(c.vault().balance, 0);
        assertTrue(c.starterSetPending());
        assertFalse(c.gateOpen());
        IPileVaultV2 pile = IPileVaultV2(c.vault());
        assertEq(pile.seeder(), CREATOR);
        assertEq(pile.seedAmount(), seed);
        assertEq(pile.asset(), address(0));
        vm.prank(CREATOR);
        pile.loadSeed{value: seed}();
        assertEq(c.vault().balance, seed);
        assertTrue(c.gateOpen());
        assertFalse(c.starterSetPending());
    }

    function test_S6_itemsAndHoldersKeepSeparateRolesAndTokenHistory() public {
        BoxSpec memory s = _items(1, 0);
        s.sellers.a.leg = 1;
        s.sellers.a.dest = 6;
        s.sellers.a.destParams = abi.encode(uint8(1));
        BoxCoordinatorV2 c = _assertCreation(s, hex"0105060304081110");
        assertNotEq(c.roleAddress(16), c.roleAddress(17));
        assertEq(IBoxReceiverV2(c.receiver()).holderLedger(), c.roleAddress(17));
        IItemLedgerV2(c.roleAddress(16)).sync(1);
    }

    function test_S6_maximumNineCreateRolesKeepTheirExactOrder() public {
        BoxSpec memory s = _hiddenSpec();
        s.buyers.a.dest = 8;
        s.buyers.a.leg = 1;
        s.buyers.a.destParams = abi.encode(uint8(1));
        s.sellers.a.dest = 6;
        s.sellers.a.leg = 1;
        s.sellers.a.destParams = abi.encode(uint8(1));
        _assertCreation(s, hex"010506030407081110");
    }

    function test_S5_zeroSeedPileHasNoLoaderAndOpens() public {
        BoxCoordinatorV2 c = _assertCreation(_pile(address(0), 0), hex"0105060308");
        assertEq(c.roleAddress(19), address(0));
        assertTrue(c.gateOpen());
        assertTrue(IBoxFactoryPileV2(address(factory)).isPileVault(c.vault()));
        assertFalse(IBoxFactoryPileV2(address(factory)).isPileVault(release.implementations[22]));
    }

    function releasePayment(BoxSpec memory s) internal view returns (uint256) {
        return factory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy;
    }

    function _assertCreation(BoxSpec memory s, bytes memory order) internal returns (BoxCoordinatorV2 c) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        assertEq(p.nonces, order);
        assertEq(p.codes.length, order.length, "alias creates no extra code");
        (address expected, address t, bytes32 hookHash) = factory.predictBox(CREATOR, s, cs);
        assertEq(expected, p.roles[0]);
        assertEq(t, p.roles[1]);
        assertEq(hookHash, keccak256(p.hookInit));
        assertEq(factory.predictHook(CREATOR, s, cs, hs), p.roles[2]);
        vm.prank(CREATOR);
        (uint256 id, address created, address h) = factory.createBox{value: p.payment}(s, cs, hs);
        assertEq(created, expected);
        assertEq(h, p.roles[2]);
        c = BoxCoordinatorV2(created);
        IBoxRegistryV2.BoxRecordV2 memory record = registry.recordOf(id);
        for (uint256 role; role < 24; ++role) {
            assertEq(c.roleAddress(role), p.roles[role]);
            assertEq(record.contracts[role], p.roles[role]);
            assertEq(record.codeHashes[role], p.roles[role] == address(0) ? bytes32(0) : p.roles[role].codehash);
            if (p.roles[role] == address(0) || role == 8) continue;
            uint256 slot = role == 1 && p.roles[17] != address(0) ? 20 : role;
            if (s.boxType == 5 && (role == 3 || role == 19)) slot = 22;
            assertTrue(BoxClones.isCloneOf(p.roles[role], release.implementations[slot]));
        }
        assertEq(record.contracts[22], address(0), "implementation slot is never a role");
    }
}
