// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M332Base} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2, IBoxFactoryV2Wiring} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {IBoxFactoryPileV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

contract M332BoundariesTest is M332Base {
    function testFuzz_S1_itemPackedArgsPreservePriceAndLegacyWords(address price, uint256 minimum, uint256 maximum) public view {
        BoxFactoryV2Parts.Box memory b;
        for (uint256 i; i < 24; ++i) b.roles[i] = address(uint160(0x100 + i));
        b.nonces = hex"10";
        b.q.batchMinQ = minimum;
        b.q.tipMaxQ = maximum;
        BoxSpec memory s = _spec();
        s.buyers.a.leg = 1;
        s.buyers.a.dest = 8;
        s.buyers.a.destParams = abi.encode(uint8(1));
        s.sellers.a.leg = 1;
        s.sellers.a.dest = 8;
        s.sellers.a.destParams = abi.encode(uint8(2));
        s.pricing.token = price;
        (bytes[] memory args,) = planner.parts().partArgs(b, s);
        assertEq(args[0], bytes.concat(
            abi.encodePacked(b.roles[0], b.roles[3], b.roles[4], b.roles[7]),
            abi.encodePacked(b.roles[5], b.roles[2], price, uint8(1), uint8(2), minimum, maximum)
        ));
    }

    function test_S6_releaseCommitmentIncludesBothM3Implementations() public view {
        bytes32[24] memory hashes;
        for (uint256 i; i < 24; ++i) {
            if (release.implementations[i] != address(0)) hashes[i] = release.implementations[i].codehash;
        }
        assertNotEq(hashes[16], bytes32(0));
        assertNotEq(hashes[22], bytes32(0));
        bytes32 expected = keccak256(abi.encode(
            uint16(2), hashes, address(factory.checks()).codehash,
            IBoxFactoryV2Wiring(release.implementations[2]).extension().codehash,
            address(planner).codehash, address(planner.parts()).codehash, address(planner.validator()).codehash
        ));
        assertEq(factory.versionCodeHash(), expected);
    }

    function test_S1_itemAndPileArgumentsMatchEveryPackedOffset() public view {
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, _items(1, 2), 0, 0);
        bytes memory args = abi.encodePacked(
            p.roles[0], p.roles[3], p.roles[4], p.roles[7], p.roles[5], p.roles[2], address(0),
            uint8(1), uint8(2), p.q.batchMinQ, p.q.tipMaxQ
        );
        assertEq(args.length, 206);
        assertEq(p.codes[p.codes.length - 1], BoxClones.initCode(release.implementations[16], args));
        p = planner.plan(release, CREATOR, _pile(address(0), 42), 0, 0);
        args = abi.encodePacked(p.roles[0], p.roles[1], address(0), CREATOR, uint256(42));
        assertEq(args.length, 112);
        assertEq(p.codes[3], BoxClones.initCode(release.implementations[22], args));
        assertEq(p.roles[19], p.roles[3]);
    }

    function test_S1_nonItemsAndZeroSeedDoNotAllocateOptionalRoles() public view {
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, _collectionSpec(), 0, 0);
        assertEq(p.roles[16], address(0));
        p = planner.plan(release, CREATOR, _pile(address(0), 0), 0, 0);
        assertEq(p.roles[19], address(0));
        assertEq(p.roles[4], address(0));
        assertEq(p.roles[7], address(0));
        assertEq(p.roles[16], address(0));
    }

    function test_S1_plannerRefusesUnlistedSeedEvenWithZeroSeed() public {
        BoxSpec memory s = _pile(address(0xBAD), 0);
        bytes memory reason = abi.encodeWithSelector(BoxFactoryV2Planner.UnlistedPileAsset.selector, address(0xBAD));
        assertEq(factory.refusal(s, CREATOR), reason);
        vm.expectRevert(reason);
        planner.plan(release, CREATOR, s, 0, 0);
    }

    function test_S6_missingSelectedImplementationsFailBeforeCreation() public {
        BoxFactoryV2Planner.Release memory r = release;
        r.implementations[16] = address(0);
        BoxSpec memory s = _items(1, 0);
        vm.expectRevert(abi.encodeWithSelector(BoxFactoryV2Planner.NoCode.selector, address(0)));
        planner.plan(r, CREATOR, s, 0, 0);
        r = release;
        r.implementations[22] = address(0);
        s = _pile(address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(BoxFactoryV2Planner.NoCode.selector, address(0)));
        planner.plan(r, CREATOR, s, 0, 0);
    }

    function test_S1_receiverCannotEncodeItemsToZeroLedger() public {
        BoxFactoryV2Parts.Box memory b;
        b.nonces = hex"05";
        BoxFactoryV2Parts parts = planner.parts();
        BoxSpec memory s = _items(1, 0);
        vm.expectRevert(BoxFactoryV2Parts.InvalidChoice.selector);
        parts.partArgs(b, s);
        s = _items(0, 2);
        vm.expectRevert(BoxFactoryV2Parts.InvalidChoice.selector);
        parts.partArgs(b, s);
    }

    function test_S5_predicateChecksWholePrefixAndExactLength() public {
        IBoxFactoryPileV2 identity = IBoxFactoryPileV2(address(factory));
        address impl = release.implementations[22];
        bytes memory args = new bytes(112);
        address clone = BoxClones.create(BoxClones.initCode(impl, args));
        assertTrue(identity.isPileVault(clone));
        assertFalse(identity.isPileVault(address(0)));
        assertFalse(identity.isPileVault(impl));
        assertFalse(identity.isPileVault(BoxClones.create(BoxClones.initCode(impl, new bytes(111)))));
        assertFalse(identity.isPileVault(BoxClones.create(BoxClones.initCode(impl, new bytes(113)))));
        assertFalse(identity.isPileVault(BoxClones.create(BoxClones.initCode(release.implementations[21], args))));
        assertFalse(identity.isPileVault(BoxClones.create(BoxClones.initCode(release.implementations[3], args))));
        assertFalse(identity.isPileVault(BoxClones.create(BoxClones.initCodeReceiving(impl, new bytes(106)))));
        bytes memory valid = clone.code;
        for (uint256 i; i < 45; ++i) {
            bytes memory corrupt = bytes.concat(valid);
            corrupt[i] = bytes1(uint8(corrupt[i]) ^ 1);
            vm.etch(clone, corrupt);
            assertFalse(identity.isPileVault(clone), "every prefix byte authenticated");
        }
    }

    function test_S6_implementationsAndUnauthenticatedCopiesAreInert() public {
        IItemLedgerV2 item = IItemLedgerV2(release.implementations[16]);
        vm.expectRevert(); item.initialize();
        vm.expectRevert(); item.sync(1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.expectRevert(); item.claim(ids, CREATOR);
        IPileVaultV2 pile = IPileVaultV2(release.implementations[22]);
        vm.expectRevert(); pile.initialize();
        vm.expectRevert(); pile.loadSeed();
        vm.expectRevert(); pile.redeem(1, 0, CREATOR);
        vm.expectRevert(); pile.returnSeed();
        pile = IPileVaultV2(BoxClones.create(BoxClones.initCode(release.implementations[22], new bytes(112))));
        vm.expectRevert(); pile.initialize();
    }

    function test_S6_releaseRefusesWrongM3Coordinator() public {
        for (uint256 i; i < 2; ++i) {
            uint256 slot = i == 0 ? 16 : 22;
            BoxFactoryV2Planner.Release memory r = release;
            address next = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
            vm.mockCall(r.implementations[0], abi.encodeWithSignature("factory()"), abi.encode(next));
            vm.mockCall(r.registry, abi.encodeWithSignature("factory()"), abi.encode(next));
            vm.mockCall(r.implementations[slot], abi.encodeWithSignature("coordinatorImplementation()"), abi.encode(address(0xBAD)));
            address checks = address(factory.checks());
            vm.expectRevert(abi.encodeWithSelector(BoxFactoryV2.ImplementationMiswired.selector, slot));
            vm.prank(DEPLOYER);
            new BoxFactoryV2(r, address(planner), checks);
            vm.clearMockedCalls();
        }
    }
}
