// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {SetReleaseFixture, ISetFactory, ISetPlannerQueries} from "./SetReleaseFixture.sol";
import {SetFactoryV2Checks} from "../../../src/box-v2/set/SetFactoryV2Checks.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {SetFactoryV2Planner} from "../../../src/box-v2/set/SetFactoryV2Planner.sol";
import {SetReleaseV2} from "../../../src/box-v2/set/SetReleaseV2.sol";
import {SetSpecV2, SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetConstantsV2 as C, SetReason as Reason} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {SetVaultV2Args, SetVaultV2Config} from "../../../src/box-v2/set/SetVaultV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {HostileToken} from "../kit/HostileToken.sol";

contract SetFactoryTest is SetReleaseFixture {
    function test_E06_predictionsNoncesArgsRegistryAndGate() public {
        SetSpecV2 memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        SetFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        assertEq(
            p.salt,
            keccak256(
                abi.encode(
                    C.RELEASE, C.TEMPLATE, block.chainid, address(factory), CREATOR, keccak256(abi.encode(s)), cs
                )
            )
        );
        assertEq(p.coordinatorInit.length, 10 + 45 + 234);
        assertEq(p.codes.length, 5);
        bytes memory order = hex"0105060313";
        assertEq(planner.nonces(), order);
        for (uint256 i; i < 5; ++i) {
            assertEq(p.roles[uint8(order[i])], vm.computeCreateAddress(p.roles[0], i + 1));
        }
        assertEq(factory.predictHook(CREATOR, s, cs, hs), p.roles[2]);
        assertEq(
            p.codes[3],
            BoxClones.initCode(
                release.implementations[3],
                SetVaultV2Args.encode(
                    SetVaultV2Config(
                        p.roles[0], p.roles[1], p.roles[19], CREATOR, address(nft), s.count, s.setHash, s.pickFeeBps
                    )
                )
            )
        );
        assertEq(
            p.codes[4],
            BoxClones.initCode(
                release.implementations[19], abi.encodePacked(p.roles[0], p.roles[3], s.setHash, s.count)
            )
        );
        vm.recordLogs();
        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        (uint256 id, address c, address h) = factory.createBox{value: p.payment}(s, cs, hs);
        assertEq(id, 0);
        assertEq(c, p.roles[0]);
        assertEq(h, p.roles[2]);
        assertEq(before - CREATOR.balance, p.payment);
        _assertState(p, id);
        _assertRecord(s, p, id, vm.getRecordedLogs());
        assertEq(registry.registryAt(1), address(oldRegistry));
        assertEq(oldRegistry.boxCount(), 0);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.NotFactory.selector, address(factory)));
        oldRegistry.record(c, C.TEMPLATE, abi.encode(s));
    }

    function _assertState(SetFactoryV2Planner.Plan memory p, uint256 id) private view {
        BoxCoordinatorV2 box = BoxCoordinatorV2(p.roles[0]);
        assertFalse(box.gateOpen());
        assertTrue(box.starterSetPending());
        assertEq(box.effectiveOpenAt(), 0);
        assertEq(box.deadline(), 0);
        assertEq(box.randomness(), address(0));
        assertEq(address(box).code.length, 45 + 234);
        for (uint256 i; i < 24; ++i) {
            assertEq(box.roleAddress(i), p.roles[i]);
            assertEq(registry.roleOf(id, i), p.roles[i]);
            if (i != 0 && i != 1 && i != 2 && i != 3 && i != 5 && i != 6 && i != 19) {
                assertEq(p.roles[i], address(0));
                assertEq(factory.implementation(i), address(0));
            }
        }
        assertTrue(p.roles[19] != p.roles[3]);
        assertFalse(factory.isPileVault(p.roles[3]));
        SetVaultV2 v = SetVaultV2(p.roles[3]);
        assertTrue(v.initialized());
        assertFalse(v.seedReady());
        assertEq(v.creator(), CREATOR);
        assertEq(v.collection(), address(nft));
        assertEq(v.inside(), 0);
        assertEq(v.supplyFloor(), 0);
        assertEq(uint8(BoxReceiverV2(payable(p.roles[5])).buyersChoice()), 3);
        assertEq(uint8(BoxReceiverV2(payable(p.roles[5])).sellersChoice()), 3);
        (uint32 loaded, bytes32 remaining, bool notified) = StarterSetLoaderV2(p.roles[19]).progress();
        assertEq(loaded, 0);
        assertEq(remaining, root);
        assertFalse(notified);
    }

    function _assertRecord(SetSpecV2 memory s, SetFactoryV2Planner.Plan memory p, uint256 id, Vm.Log[] memory logs)
        private
        view
    {
        IBoxRegistryV2.BoxRecordV2 memory record = registry.recordOf(id);
        assertEq(record.templateId, C.TEMPLATE);
        assertEq(record.specHash, keccak256(abi.encode(s)));
        for (uint256 i; i < 24; ++i) {
            assertEq(record.contracts[i], p.roles[i]);
            assertEq(record.codeHashes[i], p.roles[i] == address(0) ? bytes32(0) : p.roles[i].codehash);
        }
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == keccak256("BoxSpec(uint256,bytes)")) {
                assertEq(abi.decode(logs[i].data, (bytes)), abi.encode(s));
                found = true;
            }
        }
        assertTrue(found, "canonical spec emitted");
    }

    function test_E06_identitySeparatesCreatorChainFactoryAndSpec() public {
        SetSpecV2 memory s = _spec();
        (address a,,) = factory.predictBox(CREATOR, s, 0);
        (address b,,) = factory.predictBox(address(0xCA12), s, 0);
        assertTrue(a != b);
        vm.chainId(block.chainid + 1);
        (b,,) = factory.predictBox(CREATOR, s, 0);
        assertTrue(a != b);
        vm.chainId(block.chainid - 1);
        SetReleaseV2 memory r = release;
        r.factory = address(0xFF);
        (b,,) = planner.predictBox(r, CREATOR, s, 0);
        assertTrue(a != b);
        s.description = "changed commitment";
        (b,,) = factory.predictBox(CREATOR, s, 0);
        assertTrue(a != b);
    }

    function test_E06_exactNativePaymentAndDonations() public {
        SetSpecV2 memory s = _spec();
        s.creatorBuy = s.raise / 100;
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = factory.boxQParameters(0, s.raise).bootstrapQ + s.creatorBuy;
        vm.deal(address(factory), 123);
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.WrongValue.selector, payment + 1, payment));
        factory.createBox{value: payment + 1}(s, cs, hs);
        assertEq(registry.boxCount(), 0);
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.WrongValue.selector, payment - 1, payment));
        factory.createBox{value: payment - 1}(s, cs, hs);
        BoxCoordinatorV2 c = _create(s);
        assertEq(address(factory).balance, 123);
        assertGt(BoxTokenV2(c.token()).balanceOf(CREATOR), 0);
    }

    function test_E06_exactErc20AndNoResidualApproval() public {
        (SetSpecV2 memory s, HostileToken p) = _pricing();
        s.creatorBuy = 1_000_000;
        p.mint(address(factory), 123);
        vm.deal(address(factory), 456);
        uint256 before = p.balanceOf(CREATOR);
        BoxCoordinatorV2 c = _create(s);
        assertEq(
            before - p.balanceOf(CREATOR),
            factory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy
        );
        assertEq(p.balanceOf(address(factory)), 123);
        assertEq(address(factory).balance, 456);
        assertEq(p.allowance(address(factory), address(c)), 0);
        assertEq(p.balanceOf(address(c)), 0);
        assertEq(p.balanceOf(c.launchRouter()), 0);
    }

    function test_E06_shortPaymentAndReentryRollBack() public {
        (SetSpecV2 memory s, HostileToken p) = _pricing();
        (bytes32 cs, bytes32 hs) = _salts(s);
        (address predicted,,) = factory.predictBox(CREATOR, s, cs);
        uint256 before = p.balanceOf(CREATOR);
        p.setFeeBps(100);
        vm.prank(CREATOR);
        vm.expectPartialRevert(IBoxFactoryV2.ShortTransfer.selector);
        factory.createBox(s, cs, hs);
        assertEq(p.balanceOf(CREATOR), before);
        assertEq(predicted.code.length, 0);
        assertEq(registry.boxCount(), 0);
        p.setFeeBps(0);
        p.armReentry(address(factory), abi.encodeCall(ISetFactory.createBox, (s, cs, hs)));
        vm.prank(CREATOR);
        vm.expectRevert(bytes4(keccak256("Reentrancy()")));
        factory.createBox(s, cs, hs);
        assertEq(p.balanceOf(CREATOR), before);
        assertEq(predicted.code.length, 0);
        assertEq(registry.boxCount(), 0);
    }

    function test_E06_strictCalldataAndCurrentListing() public {
        SetSpecV2 memory s = _spec();
        bytes memory data = bytes.concat(abi.encodeCall(ISetFactory.createBox, (s, bytes32(0), bytes32(0))), hex"00");
        vm.prank(CREATOR);
        (bool ok, bytes memory err) = address(factory).call(data);
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(SetRefused.selector, Reason.NONCANONICAL_ABI, Reason.GLOBAL));
        s.raise += 1;
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, Reason.RAISE_NOT_A_PRESET, uint16(6)));
        factory.predictBox(CREATOR, s, 0);
        s = _spec();
        s.pricing.listingId = 99;
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, Reason.LISTING_UNKNOWN, uint16(5)));
        factory.predictBox(CREATOR, s, 0);
    }

    function test_E06_refusesEveryImplementationHashAndUnusedSlot() public {
        uint256 snap = beforeFactory;
        for (uint256 i; i < 24; ++i) {
            vm.revertToState(snap);
            SetReleaseV2 memory r = release;
            r.implementationHashes[i] = bytes32(uint256(1));
            vm.expectRevert(abi.encodeWithSignature("ReleaseCode(uint256)", i));
            _deployFactory(r);
        }
    }

    function test_E06_refusesEveryDependencyHash() public {
        uint256 snap = beforeFactory;
        for (uint256 i; i < 13; ++i) {
            vm.revertToState(snap);
            SetReleaseV2 memory r = release;
            r.dependencyHashes[i] = bytes32(uint256(1));
            vm.expectRevert(abi.encodeWithSignature("ReleaseCode(uint256)", 100 + i));
            _deployFactory(r);
        }
    }

    function test_E06_refusesWrongCoordinatorImmutableEvenWithMatchingHash() public {
        vm.revertToState(beforeFactory);
        SetReleaseV2 memory r = release;
        r.implementations[1] = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(address(0xBAD)));
        r.implementationHashes[1] = r.implementations[1].codehash;
        vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 1));
        _deployFactory(r);
    }

    function test_E06_refusesImplementationCodeDriftAtCreation() public {
        SetSpecV2 memory s = _spec();
        vm.etch(release.implementations[1], hex"00");
        vm.expectRevert(abi.encodeWithSignature("ReleaseCode(uint256)", 1));
        factory.createBox(s, 0, 0);
    }

    function test_E06_allCoordinatorImplementationLinksAreChecked() public {
        uint256 snap = beforeFactory;
        bytes memory roles = hex"010203050613";
        for (uint256 i; i < roles.length; ++i) {
            vm.revertToState(snap);
            uint256 role = uint8(roles[i]);
            vm.mockCall(
                release.implementations[role],
                abi.encodeWithSignature("coordinatorImplementation()"),
                abi.encode(address(0xBAD))
            );
            vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", role));
            _deployFactory(release);
            vm.clearMockedCalls();
        }
    }

    function test_E06_poolManagerLinksAreChecked() public {
        uint256 snap = beforeFactory;
        bytes memory roles = hex"00020506";
        for (uint256 i; i < roles.length; ++i) {
            vm.revertToState(snap);
            uint256 role = uint8(roles[i]);
            vm.mockCall(
                release.implementations[role], abi.encodeWithSignature("poolManager()"), abi.encode(address(0xBAD))
            );
            vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", role));
            _deployFactory(release);
            vm.clearMockedCalls();
        }
    }

    function test_E06_vaultLoaderAndReceiverCallbackLinksAreChecked() public {
        uint256 snap = beforeFactory;
        vm.revertToState(snap);
        vm.mockCall(
            release.implementations[3],
            abi.encodeWithSignature("starterSetLoaderImplementation()"),
            abi.encode(address(0xBAD))
        );
        vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 3));
        _deployFactory(release);
        vm.clearMockedCalls();
        vm.revertToState(snap);
        (, address callback,) = BoxReceiverV2(payable(release.implementations[5])).receiverCode();
        vm.mockCall(callback, abi.encodeWithSignature("receiverImplementation()"), abi.encode(address(0xBAD)));
        vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 107));
        _deployFactory(release);
    }

    function test_E06_pricingRegistryAndSafeWiringAreChecked() public {
        uint256 snap = beforeFactory;
        string[4] memory selectors = ["boxRegistry()", "poolManager()", "weth()", "lister()"];
        for (uint256 i; i < selectors.length; ++i) {
            vm.revertToState(snap);
            vm.mockCall(address(listings), abi.encodeWithSignature(selectors[i]), abi.encode(address(0xBAD)));
            vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 101));
            _deployFactory(release);
            vm.clearMockedCalls();
        }
        for (uint256 i; i < 2; ++i) {
            vm.revertToState(snap);
            SetReleaseV2 memory r = release;
            if (i == 0) r.fitSafe = address(0xBAD);
            else r.platformSafe = r.fitSafe;
            // Matching lister does not make equal or misbound Safe endpoints acceptable.
            vm.mockCall(address(listings), abi.encodeWithSignature("lister()"), abi.encode(r.platformSafe));
            vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 5));
            _deployFactory(r);
            vm.clearMockedCalls();
        }
    }

    function test_E06_oldRegistryAndCoordinatorFactoryLinksAreChecked() public {
        uint256 snap = beforeFactory;
        vm.revertToState(snap);
        vm.mockCall(release.implementations[0], abi.encodeWithSignature("factory()"), abi.encode(address(0xBAD)));
        vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 0));
        _deployFactory(release);
        vm.clearMockedCalls();
        vm.revertToState(snap);
        SetReleaseV2 memory r = release;
        r.registry = address(oldRegistry);
        r.dependencyHashes[0] = address(oldRegistry).codehash;
        r.directoryHash = keccak256(abi.encode(new address[](0), new bytes32[](0)));
        vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 100));
        _deployFactory(r);
    }

    function test_E06_releaseHelpersAreAuthenticated() public {
        uint256 snap = beforeFactory;
        vm.revertToState(snap);
        SetReleaseV2 memory r = release;
        r.plannerHash = keccak256("substituted planner");
        vm.expectRevert(abi.encodeWithSignature("ReleaseCode(uint256)", 200));
        _deployFactory(r);
        vm.revertToState(snap);
        checks = address(planner.parts());
        vm.expectRevert(bytes4(keccak256("WrongRelease()")));
        _deployFactory(release);
    }

    function test_E06_loaderActuallyCompletesFactoryCreatedSet() public {
        BoxCoordinatorV2 box = _create(_spec());
        address loader = box.starterSetLoader();
        address[] memory collections = new address[](10);
        uint256[] memory ids = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            collections[i] = address(nft);
            ids[i] = i * 101;
        }
        vm.startPrank(CREATOR);
        nft.setApprovalForAll(box.vault(), true);
        StarterSetLoaderV2(loader).load(collections, ids, new uint8[](10), 0);
        vm.stopPrank();
        assertFalse(box.gateOpen());
        StarterSetLoaderV2(loader).complete();
        assertTrue(box.gateOpen());
        assertFalse(box.starterSetPending());
        assertTrue(SetVaultV2(box.vault()).seedReady());
        assertFalse(SetVaultV2(box.vault()).gateOpen());
    }

    function test_E06_differentRaiseOnlyChangesFutureCreation() public {
        (SetSpecV2 memory s,) = _pricing();
        BoxCoordinatorV2 box = _create(s);
        listings.updateRaise(s.pricing.listingId, s.raise * 2);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, Reason.RAISE_NOT_A_PRESET, uint16(6)));
        factory.predictBox(CREATOR, s, 0);
        assertEq(box.raise(), s.raise);
        assertEq(registry.recordOf(0).raise, s.raise);
        s.raise *= 2;
        factory.predictBox(CREATOR, s, 0);
    }

    function test_E06_liveCollectionAdmissionBeforePayment() public {
        SetSpecV2 memory s = _spec();
        nft.setReply(abi.encodeWithSignature("getTransferValidator()"), HostileERC721.ReplyMode.Return, 0, 32);
        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, Reason.TRANSFER_VALIDATOR, uint16(10)));
        factory.createBox{value: 1}(s, 0, 0);
        assertEq(CREATOR.balance, before);
        assertEq(registry.boxCount(), 0);
    }

    function test_E06_directoryIsPartOfReleaseIdentity() public {
        vm.revertToState(beforeFactory);
        vm.mockCall(address(registry), abi.encodeWithSignature("directory()"), abi.encode(new address[](0)));
        vm.expectRevert(abi.encodeWithSignature("ReleaseWiring(uint256)", 102));
        _deployFactory(release);
    }

    function test_E06_wrongHookSaltAndDuplicateCreationRollBack() public {
        SetSpecV2 memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        bytes32 bad = bytes32(uint256(hs) + 1);
        address wrongHook = factory.predictHook(CREATOR, s, cs, bad);
        while (uint160(wrongHook) & 0x3fff == 0x2ae0) {
            bad = bytes32(uint256(bad) + 1);
            wrongHook = factory.predictHook(CREATOR, s, cs, bad);
        }
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.HookSaltNotMined.selector, wrongHook));
        vm.prank(CREATOR);
        factory.createBox(s, cs, bad);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        vm.prank(CREATOR);
        factory.createBox{value: value}(s, cs, hs);
        vm.expectRevert(BoxClones.DeployFailed.selector);
        vm.prank(CREATOR);
        factory.createBox{value: value, gas: 8_000_000}(s, cs, hs);
        assertEq(registry.boxCount(), 1);
    }

    function test_E06_downstreamPaymentFailureRollsBackDeployment() public {
        (SetSpecV2 memory s, HostileToken p) = _pricing();
        (bytes32 cs, bytes32 hs) = _salts(s);
        (address predicted,,) = factory.predictBox(CREATOR, s, cs);
        p.setBlocked(predicted, true);
        uint256 before = p.balanceOf(CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(HostileToken.Blocked.selector, predicted));
        factory.createBox(s, cs, hs);
        assertEq(p.balanceOf(CREATOR), before);
        assertEq(p.balanceOf(address(factory)), 0);
        assertEq(p.allowance(address(factory), predicted), 0);
        assertEq(predicted.code.length, 0);
        assertEq(registry.boxCount(), 0);
    }

    function test_E06_registryRejectsMismatchedSpecAndRewrites() public {
        SetSpecV2 memory s = _spec();
        BoxCoordinatorV2 box = _create(s);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.AlreadyRecorded.selector, address(box)));
        registry.record(address(box), C.TEMPLATE, abi.encode(s));
        // A fresh matching-writer registry still checks the bytes against the coordinator's commitment.
        BoxRegistryV2 other = new BoxRegistryV2(address(factory), new address[](0));
        s.description = "wrong bytes";
        bytes32 recordedHash = box.specHash();
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(IBoxRegistryV2.SpecHashMismatch.selector, keccak256(abi.encode(s)), recordedHash)
        );
        other.record(address(box), C.TEMPLATE, abi.encode(s));
        assertEq(other.boxCount(), 0);
    }

    function test_E06_eachCloneCodeAndArgumentsAreRechecked() public {
        SetSpecV2 memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        SetFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        _create(s);
        for (uint256 i; i < p.codes.length; ++i) {
            uint256 last = p.codes[i].length - 1;
            p.codes[i][last] ^= 0x01;
            vm.expectRevert(abi.encodeWithSignature("Miswired(uint256)", uint8(planner.nonces()[i])));
            SetFactoryV2Checks(checks).verify(release, CREATOR, s, p);
            p.codes[i][last] ^= 0x01;
        }
        p.coordinatorInit[p.coordinatorInit.length - 1] ^= 0x01;
        vm.expectRevert(abi.encodeWithSignature("Miswired(uint256)", 0));
        SetFactoryV2Checks(checks).verify(release, CREATOR, s, p);
        p.coordinatorInit[p.coordinatorInit.length - 1] ^= 0x01;
        p.hookInit[p.hookInit.length - 1] ^= 0x01;
        vm.expectRevert(abi.encodeWithSignature("Miswired(uint256)", 2));
        SetFactoryV2Checks(checks).verify(release, CREATOR, s, p);
    }

    function test_E06_publicRefusalsAndPlannerHookPrediction() public {
        SetSpecV2 memory s = _spec();
        ISetPlannerQueries queries = ISetPlannerQueries(address(planner));
        assertEq(factory.refusal(s, CREATOR), "");
        assertEq(queries.refusal(release, CREATOR, s), "");
        assertEq(queries.predictHook(release, CREATOR, s, 0, 0), factory.predictHook(CREATOR, s, 0, 0));
        s.count = 9;
        bytes memory refused = abi.encodeWithSelector(SetRefused.selector, Reason.OUT_OF_RANGE, uint16(11));
        assertEq(factory.refusal(s, CREATOR), refused);
        assertEq(queries.refusal(release, CREATOR, s), refused);
        s = _spec();
        nft.setReply(abi.encodeWithSignature("getTransferValidator()"), HostileERC721.ReplyMode.Return, 0, 32);
        assertEq(
            factory.refusal(s, CREATOR),
            abi.encodeWithSelector(SetRefused.selector, Reason.TRANSFER_VALIDATOR, uint16(10))
        );
    }

    function test_E06_listerRenunciationDoesNotBlockCreation() public {
        listings.proposeRenounce();
        listings.renounce();
        _create(_spec());
        assertEq(registry.boxCount(), 1);
    }

    function test_E06_emptyRevertIsNeverSuccessfulRefusal() public {
        vm.mockCallRevert(address(listings), abi.encodeWithSignature("listingCount()"), "");
        assertEq(
            factory.refusal(_spec(), CREATOR),
            abi.encodeWithSelector(SetFactoryV2Planner.ValidationUnavailable.selector)
        );
    }

    function test_E06_deploymentSizes() public view {
        assertLe(address(factory).code.length, 22_118);
        assertLe(address(planner).code.length, 22_118);
        assertLe(checks.code.length, 22_118);
        assertLe(
            vm.getCode("SetFactoryV2.sol:SetFactoryV2").length + abi.encode(release, address(planner), checks).length,
            49_152
        );
        assertLe(vm.getCode("SetFactoryV2Planner.sol:SetFactoryV2Planner").length + 64, 49_152);
        assertLe(vm.getCode("SetFactoryV2Checks.sol:SetFactoryV2Checks").length, 49_152);
        for (uint256 i; i < 24; ++i) {
            assertLe(release.implementations[i].code.length, 24_576);
        }
        address[13] memory d = _dependencies();
        for (uint256 i; i < 13; ++i) {
            assertLe(d[i].code.length, 24_576);
        }
    }
}
