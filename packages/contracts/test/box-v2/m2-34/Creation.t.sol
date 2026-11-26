// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M234Base} from "./Fixture.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IStarterSetLoaderV2, IShopVaultV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";

contract M234CreationTest is M234Base {
    function test_plainBoxKeepsThreeClonesAndNoLedger() public {
        _assertCreation(_spec(), hex"01050608");
    }

    function test_eachHolderSideSelectsOneLedgerAndTheLedgerToken() public {
        for (uint256 side = 1; side <= 3; ++side) {
            BoxSpec memory s = _holders();
            if (side == 1) s.sellers = _spec().sellers;
            if (side == 2) s.buyers = _spec().buyers;
            _assertCreation(s, hex"0105060811");
        }
    }

    function test_shopHolderStarterOrderAndClosedGate() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), bytes32(uint256(42)), 10, 100 ether);
        BoxCoordinatorV2 c = _assertCreation(s, hex"01050603081113");
        assertFalse(c.gateOpen()); assertTrue(c.starterSetPending());
        IShopVaultV2 shop = IShopVaultV2(c.vault());
        assertEq(shop.inside(), 0); assertEq(shop.budgetT(), 0); assertFalse(shop.seedReady());
        (uint32 loaded, bytes32 remaining, bool notified) = IStarterSetLoaderV2(c.starterSetLoader()).progress();
        assertEq(loaded, 0); assertEq(remaining, bytes32(uint256(42))); assertFalse(notified);
    }

    function test_holderCollectionKeepsItsVaultAndChunkGate() public {
        BoxSpec memory s = _collectionSpec();
        s.buyers = _holders().buyers;
        _assertCreation(s, hex"01050603040811");
    }

    function test_seedOnlyShopOpensOnlyAfterFundingAndLoaderCompletion() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), 0, 0, 100 ether);
        BoxCoordinatorV2 c = _assertCreation(s, hex"01050603081113");
        IStarterSetLoaderV2 loader = IStarterSetLoaderV2(c.starterSetLoader());
        vm.expectRevert(); loader.complete();
        vm.startPrank(CREATOR);
        BoxTokenV2Ledger(c.token()).approve(c.vault(), 100 ether);
        vm.stopPrank();
        IShopVaultV2(c.vault()).fundSeed();
        assertFalse(c.gateOpen());
        loader.complete();
        assertTrue(c.gateOpen()); assertFalse(c.starterSetPending());
        assertEq(IShopVaultV2(c.vault()).budgetT(), 100 ether);
    }

    function test_zeroSeedShopCannotOmitFundingGate() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), 0, 0, 0);
        s.addOns = new AddOn[](1); s.addOns[0] = AddOn(7, "");
        s.buyers = _spec().buyers; s.sellers = _spec().sellers;
        bytes memory refusal = abi.encodeWithSignature("InvalidSpec(uint16,uint16)", uint16(4), uint16(30));
        assertEq(factory.refusal(s, CREATOR), refusal);
        vm.prank(CREATOR); vm.expectRevert(refusal); factory.createBox(s, 0, 0);
    }

    function test_plannerRefusesMissingLedgerLoaderOrAlternativeCode() public {
        for (uint256 i; i < 4; ++i) {
            BoxFactoryV2Planner.Release memory r = release;
            uint256 slot = i == 0 ? 17 : i == 1 ? 19 : i == 2 ? 20 : 21;
            r.implementations[slot] = address(0);
            BoxSpec memory s = _shop(address(0x721), 0, 0, 40 ether);
            vm.expectRevert(abi.encodeWithSelector(BoxFactoryV2Planner.NoCode.selector, address(0)));
            planner.plan(r, CREATOR, s, 0, 0);
        }
    }

    function _assertCreation(BoxSpec memory s, bytes memory order) internal returns (BoxCoordinatorV2 c) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        assertEq(p.nonces, order);
        (address predicted, address t, bytes32 initHash) = factory.predictBox(CREATOR, s, cs);
        assertEq(predicted, p.roles[0]); assertEq(t, p.roles[1]);
        assertEq(initHash, keccak256(p.hookInit));
        assertEq(factory.predictHook(CREATOR, s, cs, hs), p.roles[2]);
        vm.prank(CREATOR);
        (uint256 id, address at, address h) = factory.createBox{value: p.payment}(s, cs, hs);
        c = BoxCoordinatorV2(at);
        assertEq(at, predicted); assertEq(h, p.roles[2]);
        IBoxRegistryV2.BoxRecordV2 memory record = registry.recordOf(id);
        (,,,, bytes32 recordedHash) = registry.entry(id);
        assertEq(recordedHash, keccak256(abi.encode(record)));
        for (uint256 role; role < 24; ++role) {
            assertEq(c.roleAddress(role), p.roles[role]);
            assertEq(record.contracts[role], p.roles[role]);
            assertEq(record.codeHashes[role], p.roles[role] == address(0) ? bytes32(0) : p.roles[role].codehash);
            if (p.roles[role] != address(0) && role != 8) {
                uint256 slot = role == 1 && p.roles[17] != address(0) ? 20 : role == 3 && s.boxType == 4 ? 21 : role;
                assertTrue(BoxClones.isCloneOf(p.roles[role], release.implementations[slot]));
            }
        }
        assertEq(record.contracts[20], address(0)); assertEq(record.contracts[21], address(0));
        assertEq(BoxTokenV2Ledger(t).ledger(), p.roles[17]);
        assertEq(IBoxReceiverV2(c.receiver()).holderLedger(), p.roles[17]);
        assertEq(IBoxHookV2(h).holderLedger(), p.roles[17]);
        assertEq(IBoxHookV2(h).currentTradeBatch(true), p.roles[17] == address(0) ? 0 : 1);
        assertEq(IBoxHookV2(h).currentTradeBatch(false), p.roles[17] == address(0) ? 0 : 2);
        if (p.roles[17] != address(0)) {
            BoxTokenV2Ledger ledgerToken = BoxTokenV2Ledger(t);
            uint256 checkpoint = ledgerToken.holderCheckpoint();
            assertGt(checkpoint, 0);
            assertEq(ledgerToken.eligibleSupplyAt(checkpoint), ledgerToken.balanceOf(CREATOR));
            for (uint256 role; role < 24; ++role) {
                assertEq(ledgerToken.eligibleBalanceAt(p.roles[role], checkpoint), 0);
            }
            assertEq(ledgerToken.eligibleBalanceAt(address(pm), checkpoint), 0);
        }
    }
}
