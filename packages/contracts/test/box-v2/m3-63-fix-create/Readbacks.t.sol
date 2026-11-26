// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxFactoryV2Checks} from "../../../src/box-v2/libraries/BoxFactoryV2Checks.sol";

contract M363ReadbacksTest is M363Base {
    function testFuzz_itemPolicyOrientationsAndMixedHoldersPassReadbacks(uint8 buyers, uint8 sellers) public {
        buyers = uint8(bound(buyers, 0, 2));
        sellers = uint8(bound(sellers, 0, 2));
        if (buyers + sellers == 0) sellers = 1;
        BoxSpec memory s = _items(buyers, sellers);
        // A non-Items side may independently choose holders.
        if (buyers == 0) { s.buyers.a.leg = 1; s.buyers.a.dest = 6; s.buyers.a.destParams = abi.encode(uint8(1)); }
        if (sellers == 0) { s.sellers.a.leg = 1; s.sellers.a.dest = 6; s.sellers.a.destParams = abi.encode(uint8(1)); }
        box = _create(s);
        assertTrue(box.roleAddress(16) != address(0));
        assertEq(box.roleAddress(17) != address(0), buyers == 0 || sellers == 0);
    }

    function test_itemPoliciesAndBothJournalCursorsAreChecked() public {
        BoxSpec memory s = _items(1, 2);
        BoxFactoryV2Planner.Plan memory p = _admit(s);
        _badRead(s, p, 16, abi.encodeWithSignature("insidePolicies()"), abi.encode(uint8(2), uint8(1)), 116);
        _badRead(s, p, 16, abi.encodeWithSignature("fundingCursor()"), abi.encode(uint256(1)), 116);
        _badRead(s, p, 16, abi.encodeWithSignature("lifecycleCursor()"), abi.encode(uint256(1)), 116);
        _badRead(s, p, 5, abi.encodeWithSignature("itemFundingCount()"), abi.encode(uint256(1)), 116);
        _badRead(s, p, 3, abi.encodeWithSignature("itemLifecycleCount()"), abi.encode(uint256(1)), 116);
    }

    function test_itemReceiverVaultAndCountWiringCannotBeRelaxed() public {
        BoxSpec memory s = _items(1, 0);
        BoxFactoryV2Planner.Plan memory p = _admit(s);
        _badRead(s, p, 5, abi.encodeWithSignature("itemLedger()"), abi.encode(address(0)), 105);
        _badRead(s, p, 3, abi.encodeWithSignature("itemLedger()"), abi.encode(address(0xBAD)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("collectionSize()"), abi.encode(uint256(s.n + 1)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("inside()"), abi.encode(uint256(s.n - 1)), 203);
        _badRead(s, p, 2, abi.encodeWithSignature("currentTradeBatch(bool)", true), abi.encode(uint256(0)), 2);
        _badRead(s, p, 2, abi.encodeWithSignature("currentTradeBatch(bool)", false), abi.encode(uint256(0)), 2);
    }

    function test_itemRuntimePrefixAndEveryArgumentByteRemainAuthenticated() public {
        BoxSpec memory s = _items(1, 2);
        BoxFactoryV2Planner.Plan memory p = _admit(s);
        address item = p.roles[16];
        bytes memory original = item.code;
        assertEq(original.length, 45 + 206);
        for (uint256 i; i < original.length; ++i) {
            bytes memory changed = bytes.concat(original);
            changed[i] = bytes1(uint8(changed[i]) ^ 1);
            vm.etch(item, changed);
            _rejected(s, p, 116);
        }
        vm.etch(item, original);
        factory.checks().verify(release, CREATOR, s, p, box.boxId());
    }

    function test_role16MustUseTheReleaseImplementationEvenIfPlanHashMatches() public {
        BoxSpec memory s = _items(1, 2);
        BoxFactoryV2Planner.Plan memory p = _admit(s);
        // An equivalent deployed implementation still is not this release's role-16 identity.
        address other = deployCode("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(pm, release.implementations[0]));
        bytes memory args = abi.encodePacked(p.roles[0], p.roles[3], p.roles[4], p.roles[7],
            p.roles[5], p.roles[2], s.pricing.token, uint8(1), uint8(2), p.q.batchMinQ, p.q.tipMaxQ);
        p.codes[p.codes.length - 1] = BoxClones.initCode(other, args);
        address copy = BoxClones.create(p.codes[p.codes.length - 1]);
        vm.etch(p.roles[16], copy.code);
        _rejected(s, p, 116);
    }

    function test_pileUsesOnlyItsOwnAssetSeederCountsAndInitializationReadbacks() public {
        BoxSpec memory s = _pile(address(0), 1 ether);
        BoxFactoryV2Planner.Plan memory p = _admit(s);
        assertEq(p.roles[3].balance, 0, "creation never loads the seed");
        _badRead(s, p, 3, abi.encodeWithSignature("asset()"), abi.encode(address(0xBAD)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("seeder()"), abi.encode(address(0xBAD)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("seedAmount()"), abi.encode(uint256(2 ether)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("collectionSize()"), abi.encode(uint256(1)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("inside()"), abi.encode(uint256(1)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("supplyFloor()"), abi.encode(uint256(1)), 203);
        _badRead(s, p, 3, abi.encodeWithSignature("quoteRedeem(uint256)", uint256(0)), abi.encode(uint256(1)), 203);
        vm.mockCall(address(factory), abi.encodeCall(factory.isPileVault, (p.roles[3])), abi.encode(false));
        _rejected(s, p, 203);
    }

    function test_seededPileLoaderMustAliasRoleThree() public {
        BoxSpec memory s = _pile(address(0), 1 ether);
        BoxFactoryV2Planner.Plan memory p = _admit(s);
        p.roles[19] = address(0xBAD);
        vm.mockCall(address(box), abi.encodeCall(box.roleAddress, (19)), abi.encode(p.roles[19]));
        _rejected(s, p, 203);
    }

    function test_badReadbackRollsBackPaymentRegistrationAndAllClones() public {
        BoxSpec memory s = _items(1, 2);
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        vm.mockCall(p.roles[16], abi.encodeWithSignature("fundingCursor()"), abi.encode(uint256(1)));
        vm.etch(p.roles[16], ""); // Clear only the cheatcode's synthetic code so CREATE can run.
        uint256 before = CREATOR.balance;
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.Miswired.selector, uint256(116)));
        vm.prank(CREATOR);
        factory.createBox{value: p.payment}(s, cs, hs);
        assertEq(CREATOR.balance, before);
        assertEq(registry.boxCount(), 0);
        assertEq(address(factory).balance, 0);
        for (uint256 i; i < 24; ++i) assertEq(p.roles[i].code.length, 0);
    }

    function _admit(BoxSpec memory s) private returns (BoxFactoryV2Planner.Plan memory p) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        p = planner.plan(release, CREATOR, s, cs, hs);
        vm.prank(CREATOR);
        (, address created,) = factory.createBox{value: p.payment}(s, cs, hs);
        box = BoxCoordinatorV2(created);
        factory.checks().verify(release, CREATOR, s, p, box.boxId());
    }

    function _badRead(BoxSpec memory s, BoxFactoryV2Planner.Plan memory p, uint256 role,
        bytes memory call_, bytes memory answer, uint256 check) private {
        vm.mockCall(p.roles[role], call_, answer);
        _rejected(s, p, check);
        vm.clearMockedCalls();
    }

    function _rejected(BoxSpec memory s, BoxFactoryV2Planner.Plan memory p, uint256 check) private {
        uint256 id = box.boxId();
        BoxFactoryV2Checks checks = factory.checks();
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.Miswired.selector, check));
        checks.verify(release, CREATOR, s, p, id);
    }
}
