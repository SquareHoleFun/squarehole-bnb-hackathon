// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M234Base} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxTokenV2} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IStarterSetLoaderV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";

contract M234BoundariesTest is M234Base {
    function test_holderReceiverEncodingRefusesZeroLedgerOnEitherSide() public {
        BoxFactoryV2Parts.Box memory b;
        b.nonces = hex"05";
        BoxFactoryV2Parts parts = planner.parts();
        for (uint256 side; side < 2; ++side) {
            BoxSpec memory s = _holders();
            if (side == 0) s.sellers = _spec().sellers;
            else s.buyers = _spec().buyers;
            vm.expectRevert(BoxFactoryV2Parts.InvalidChoice.selector);
            parts.partArgs(b, s);
        }
    }

    function test_m2ImplementationsAreInert() public {
        vm.expectRevert(IBoxTokenV2.AlreadyInitialised.selector);
        IBoxTokenV2(release.implementations[20]).initialize();
        vm.expectRevert(IHolderLedgerV2.InvalidRequest.selector);
        IHolderLedgerV2(release.implementations[17]).register();
        vm.expectRevert(IHolderLedgerV2.InvalidRequest.selector);
        IHolderLedgerV2(release.implementations[17]).settleBatch(1, 64);
        vm.expectRevert();
        IStarterSetLoaderV2(release.implementations[19]).complete();
        (bool ok,) = release.implementations[21].call(abi.encodeWithSignature("initialize()"));
        assertFalse(ok);
        for (uint256 i = 17; i <= 21; ++i) assertEq(release.implementations[i].balance, 0);
    }

    function test_releaseCommitsAllTwentyFourImplementationSlots() public view {
        bytes32[24] memory hashes;
        for (uint256 i; i < 24; ++i) {
            if (release.implementations[i] != address(0)) hashes[i] = release.implementations[i].codehash;
        }
        (bool ok, bytes memory ret) = release.implementations[2].staticcall(abi.encodeWithSignature("extension()"));
        assertTrue(ok);
        address ext = abi.decode(ret, (address));
        assertEq(factory.versionCodeHash(), keccak256(abi.encode(
            uint16(2), hashes, address(factory.checks()).codehash, ext.codehash,
            address(planner).codehash, address(planner.parts()).codehash, address(planner.validator()).codehash
        )));
    }

    function test_releaseRefusesUnpairedHolderAndLedgerToken() public {
        for (uint256 i; i < 2; ++i) {
            BoxFactoryV2Planner.Release memory r = release;
            r.implementations[i == 0 ? 17 : 20] = address(0);
            _refuse(r, abi.encodeWithSelector(BoxFactoryV2.BadPreviewRelease.selector));
        }
    }

    function test_releaseRefusesPlainTokenInLedgerSlot() public {
        BoxFactoryV2Planner.Release memory r = _nextRelease();
        r.implementations[20] = r.implementations[1];
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.ImplementationMiswired.selector, 20));
    }

    function test_releaseRefusesWrongM2CoordinatorAndShopManager() public {
        for (uint256 slot = 19; slot <= 21; ++slot) {
            BoxFactoryV2Planner.Release memory r = _nextRelease();
            vm.mockCall(r.implementations[slot], abi.encodeWithSignature("coordinatorImplementation()"), abi.encode(address(0xBAD)));
            _refuse(r, abi.encodeWithSelector(BoxFactoryV2.ImplementationMiswired.selector, slot));
            vm.clearMockedCalls();
        }
        BoxFactoryV2Planner.Release memory r = _nextRelease();
        vm.mockCall(r.implementations[21], abi.encodeWithSignature("poolManager()"), abi.encode(address(0xBAD)));
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.ImplementationMiswired.selector, 21));
    }

    function test_zeroLedgerReadbackRollsBackEveryCloneAndPayment() public {
        _rejectRead(_holders(), 5, abi.encodeWithSignature("holderLedger()"), abi.encode(address(0)), 105);
    }

    function test_missingTokenHistoryRollsBackEveryCloneAndPayment() public {
        _rejectRead(_holders(), 1, abi.encodeWithSignature("holderCheckpoint()"), abi.encode(uint256(0)), 201);
    }

    function test_missingHookLedgerRollsBackEveryCloneAndPayment() public {
        _rejectRead(_holders(), 2, abi.encodeWithSignature("holderLedger()"), abi.encode(address(0)), 2);
    }

    function test_shopSeedReadbackRollsBackEveryCloneAndPayment() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), 0, 0, 40 ether);
        _rejectRead(s, 3, abi.encodeWithSignature("seedReady()"), abi.encode(true), 203);
    }

    function test_loaderCommitmentReadbackRollsBackEveryCloneAndPayment() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), bytes32(uint256(42)), 10, 40 ether);
        _rejectRead(s, 19, abi.encodeWithSignature("progress()"), abi.encode(uint32(0), bytes32(0), false), 119);
    }

    function _nextRelease() private returns (BoxFactoryV2Planner.Release memory r) {
        r = release;
        address next = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        vm.mockCall(r.implementations[0], abi.encodeWithSignature("factory()"), abi.encode(next));
        vm.mockCall(r.registry, abi.encodeWithSignature("factory()"), abi.encode(next));
    }

    function _refuse(BoxFactoryV2Planner.Release memory r, bytes memory reason) private {
        address checker = address(factory.checks());
        vm.expectRevert(reason);
        vm.prank(DEPLOYER);
        new BoxFactoryV2(r, address(planner), checker);
    }

    function _rejectRead(BoxSpec memory s, uint256 role, bytes memory call_, bytes memory answer, uint256 check) private {
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        uint256 before_ = CREATOR.balance;
        vm.mockCall(p.roles[role], call_, answer);
        // Remove only the mock's synthetic code before CREATE deploys the real clone, as in M1-32a.
        vm.etch(p.roles[role], "");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.Miswired.selector, check));
        vm.prank(CREATOR);
        factory.createBox{value: p.payment}(s, cs, hs);
        assertEq(CREATOR.balance, before_);
        assertEq(address(factory).balance, 0);
        assertEq(registry.boxCount(), 0);
        for (uint256 i; i < 24; ++i) assertEq(p.roles[i].code.length, 0);
    }
}
