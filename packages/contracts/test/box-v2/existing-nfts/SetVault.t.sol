// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetVaultFixture, CustodyVault, SetStandardERC721} from "./SetVaultFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {SetReason as R} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {SetVaultV2Args, SetVaultV2Config} from "../../../src/box-v2/set/SetVaultV2Args.sol";
import {Vm} from "forge-std/Vm.sol";

contract SetVaultTest is SetVaultFixture {
    function test_constructorRejectsWrongReleaseAndNoCode() public {
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        new SetVaultV2(address(0), loaderImpl);
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        new SetVaultV2(coordinatorImpl, address(0));
        address other = address(new SetStandardERC721());
        address wrongLoader = address(new StarterSetLoaderV2(other));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        new SetVaultV2(coordinatorImpl, wrongLoader);
    }

    function test_packedEncoderMatchesIndependentIdentityOracle() public {
        _standard(10);
        _deploy(true);
        SetVaultV2Config memory cfg =
            SetVaultV2Config(address(box), address(token), address(loader), CREATOR, collection, 10, hashes[0], 500);
        assertEq(SetVaultV2Args.encode(cfg), _vaultArgs());
        assertEq(SetVaultV2Args.encode(cfg).length, 138);
    }

    function test_memberEventsReconstructOrderedSet() public {
        _standard(10);
        _deploy(true);
        vm.recordLogs();
        _page(0, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 members;
        bytes32 signature = keccak256("SetLoaded(uint256,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != signature) continue;
            assertEq(logs[i].topics.length, 4);
            assertEq(logs[i].data.length, 0);
            assertEq(uint256(logs[i].topics[1]), members);
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(collection))));
            assertEq(uint256(logs[i].topics[3]), ids[members]);
            ++members;
        }
        assertEq(members, 10);
    }

    function test_identityAndEmptyInitialization() public {
        _standard(33);
        _deploy(true);
        assertTrue(vault.initialized());
        assertEq(vault.coordinatorImplementation(), coordinatorImpl);
        assertEq(vault.starterSetLoaderImplementation(), loaderImpl);
        assertEq(vault.coordinator(), address(box));
        assertEq(vault.token(), address(token));
        assertEq(vault.creator(), CREATOR);
        assertEq(vault.collection(), collection);
        assertEq(vault.starterSetLoader(), address(loader));
        assertEq(vault.collectionSize(), 33);
        assertEq(vault.setHash(), hashes[0]);
        assertEq(vault.pickFeeBps(), 500);
        assertEq(vault.escrowPrincipal(), 0);
        assertFalse(vault.seedReady());
        _progress(0, false);
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.initialize();
    }

    function test_realERC721Pages32Plus1AndBothGates() public {
        SetStandardERC721 nft = _standard(33);
        _deploy(true);
        _page(0, 32);
        _progress(32, false);
        assertFalse(vault.seedReady());
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.openGate();
        assertFalse(box.gateOpen());
        assertFalse(vault.gateOpen());
        _page(32, 1);
        _progress(33, false);
        assertTrue(vault.seedReady());
        assertFalse(box.gateOpen());
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.openGate();
        vm.prank(ALICE);
        loader.complete();
        _progress(33, true);
        assertTrue(box.gateOpen());
        assertFalse(vault.gateOpen());
        assertEq(box.effectiveOpenAt(), block.timestamp + 1);
        for (uint256 i; i < 33; ++i) {
            assertEq(vault.memberAt(i), ids[i]);
            assertTrue(vault.eligible(ids[i]));
            assertFalse(vault.isOutside(ids[i]));
            assertEq(nft.ownerOf(ids[i]), address(vault));
            assertEq(nft.getApproved(ids[i]), address(0));
        }
        assertEq(nft.balanceOf(address(vault)), 33);
        assertFalse(nft.isApprovedForAll(address(vault), CREATOR));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.memberAt(33);
        vm.prank(address(box));
        token.transfer(ALICE, 700);
        hook.fill();
        box.graduate();
        assertTrue(vault.gateOpen());
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.openGate();
        vm.prank(address(loader));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.loadStarter(collection, 5, 0);
    }

    function test_realERC72110000In313Pages() public {
        // Minting 10,000 ids and loading 313 pages needs more than the default 1,073,741,824-gas test budget. It runs
        // under FOUNDRY_PROFILE=sepolia-rehearsal (10e9), like the whole-release rehearsals, and skips elsewhere.
        if (gasleft() < 5_000_000_000) vm.skip(true);
        SetStandardERC721 nft = _standard(10_000);
        _deploy(true);
        uint256 pages;
        uint256 largestPageGas;
        for (uint256 start; start < 10_000; start += 32) {
            uint256 n = start + 32 > 10_000 ? 10_000 - start : 32;
            uint256 beforeGas = gasleft();
            _page(start, n);
            uint256 used = beforeGas - gasleft();
            if (used > largestPageGas) largestPageGas = used;
            ++pages;
            _progress(start + n, false);
            assertFalse(box.gateOpen());
            assertFalse(vault.gateOpen());
            if (start + n < 10_000) {
                assertFalse(vault.seedReady());
                vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
                loader.complete();
            }
        }
        assertEq(pages, 313);
        assertTrue(vault.seedReady());
        assertEq(nft.balanceOf(address(vault)), 10_000);
        for (uint256 i; i < 10_000; ++i) {
            assertEq(vault.memberAt(i), ids[i]);
            assertTrue(vault.eligible(ids[i]));
            assertEq(nft.ownerOf(ids[i]), address(vault));
        }
        loader.complete();
        _progress(10_000, true);
        assertTrue(box.gateOpen());
        emit log_named_uint("largest 32-item page execution (local harness)", largestPageGas);
    }

    function test_failedHookAndRouterSetOpenCanRetry() public {
        _standard(33);
        _deploy(true);
        _page(0, 32);
        _page(32, 1);
        hook.setRejectOpen(true);
        vm.expectRevert("open refused");
        loader.complete();
        _progress(33, false);
        assertTrue(box.starterSetPending());
        assertFalse(box.gateOpen());
        hook.setRejectOpen(false);
        vm.mockCallRevert(
            box.launchRouter(), abi.encodeWithSignature("setOpen(uint256)", block.timestamp + 1), "router refused"
        );
        vm.expectRevert(bytes("router refused"));
        loader.complete();
        _progress(33, false);
        assertEq(hook.openAt(), 0);
        assertFalse(box.gateOpen());
        vm.clearMockedCalls();
        vm.prank(ALICE);
        loader.complete();
        _progress(33, true);
        assertTrue(box.gateOpen());
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
    }

    function test_onlyCreatorPagesAndOnlyFixedLoaderPullsAndCoordinatorNotices() public {
        _standard(10);
        _deploy(true);
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(0, 10);
        vm.expectRevert(abi.encodeWithSelector(StarterSetLoaderV2.Unauthorized.selector, address(this)));
        loader.load(cs, ns, ts, 0);
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.Unauthorized.selector, CREATOR));
        vault.loadStarter(collection, ids[0], 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.NotStarterSetLoader.selector, address(this)));
        box.starterSetLoaded();
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.Unauthorized.selector, address(this)));
        vault.openGate();
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.Unauthorized.selector, address(this)));
        vault.enterFailure();
        _progress(0, false);
    }

    function test_uninitializedAndImplementationRefuseMutation() public {
        _standard(10);
        _deploy(false);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.Unauthorized.selector, address(this)));
        vault.initialize();
        vm.prank(address(loader));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.loadStarter(collection, ids[0], 0);
        assertFalse(vault.seedReady());
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        CustodyVault(vaultImpl).initialize();
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        CustodyVault(vaultImpl).openGate();
    }

    function testFuzz_identityArgsCannotBeSubstituted(uint8 field) public {
        _standard(10);
        _deploy(false);
        bytes memory args = _vaultArgs();
        uint256[8] memory offsets = [uint256(0), 20, 40, 60, 80, 100, 104, 136];
        args[offsets[bound(field, 0, 7)]] ^= bytes1(0x80);
        vm.etch(address(vault), BoxClones.runtime(vaultImpl, args));
        vm.expectRevert();
        box.launch();
        assertFalse(vault.initialized());
    }

    function testFuzz_loaderIdentityAndCommitmentMustMatch(uint8 field) public {
        _standard(10);
        _deploy(false);
        bytes memory args = abi.encodePacked(address(box), address(vault), hashes[0], uint32(10));
        uint256[4] memory offsets = [uint256(0), 20, 40, 72];
        args[offsets[bound(field, 0, 3)]] ^= bytes1(0x80);
        vm.etch(address(loader), BoxClones.runtime(loaderImpl, args));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        box.launch();
    }

    function test_rejectWrongCloneImplementationsAndArgumentLengths() public {
        _standard(10);
        _deploy(false);
        bytes memory original = address(loader).code;
        vm.etch(
            address(loader),
            BoxClones.runtime(vaultImpl, abi.encodePacked(address(box), address(vault), hashes[0], uint32(10)))
        );
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        box.launch();
        vm.etch(address(loader), original);
        vm.etch(address(vault), BoxClones.runtime(vaultImpl, bytes.concat(_vaultArgs(), hex"00")));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        box.launch();
        vm.etch(address(vault), BoxClones.runtime(vaultImpl, new bytes(137)));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        box.launch();
    }

    function test_foreignCoordinatorCloneAndOrdinaryContractCannotInitialize() public {
        _standard(10);
        _deploy(false);
        bytes memory runtime = address(box).code;
        vm.etch(address(box), address(hook).code);
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.initialize();
        vm.etch(address(box), runtime);
        bytes memory args = _vaultArgs();
        CustodyVault stranger = CustodyVault(BoxClones.create(BoxClones.initCode(vaultImpl, args)));
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        stranger.initialize();
    }

    function test_rejectInvalidCountRootAndFeeEvenIfLoaderMatches() public {
        _standard(10);
        _deploy(false);
        uint32[3] memory counts = [uint32(0), 9, 10_001];
        for (uint256 i; i < counts.length; ++i) {
            _replaceTerms(counts[i], hashes[0], 500);
            vm.expectRevert(CustodyVault.InvalidRequest.selector);
            box.launch();
        }
        _replaceTerms(10, bytes32(0), 500);
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        box.launch();
        _replaceTerms(10, hashes[0], 501);
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        box.launch();
        _replaceTerms(10, hashes[0], 100);
        box.launch();
        assertEq(vault.pickFeeBps(), 100);
    }

    function _replaceTerms(uint32 count, bytes32 root, uint16 fee) private {
        vm.etch(
            address(vault),
            BoxClones.runtime(
                vaultImpl,
                abi.encodePacked(address(box), address(token), address(loader), CREATOR, collection, count, root, fee)
            )
        );
        vm.etch(
            address(loader), BoxClones.runtime(loaderImpl, abi.encodePacked(address(box), address(vault), root, count))
        );
    }

    function test_collectionTierAndDuplicateRefusalWithRehashedPages() public {
        HostileERC721 nft = _hostile(10);
        tiers[9] = 1;
        _deploy(true);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.NONZERO_TIER, uint16(12)));
        _page(0, 10);
        _progress(0, false);
        assertEq(nft.actualOwner(ids[0]), CREATOR);
        tiers[9] = 0;
        collections[9] = address(new SetStandardERC721());
        _deploy(true);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.COLLECTION_MISMATCH, uint16(10)));
        _page(0, 10);
        _progress(0, false);
        collections[9] = collection;
        ids[9] = ids[0];
        _deploy(true);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(0, 10);
        _progress(0, false);
    }

    function test_duplicateAcrossPagesAndDirectLoaderDuplicate() public {
        _standard(33);
        ids[32] = ids[0];
        _deploy(true);
        _page(0, 32);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(32, 1);
        _progress(32, false);
        vm.prank(address(loader));
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.DUPLICATE_ID, uint16(12)));
        vault.loadStarter(collection, ids[0], 0);
    }

    function test_hashOrderShapeAndCountRefusalsPrecedeCustody() public {
        _standard(33);
        _deploy(true);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(0, 33);
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(0, 32);
        (ns[0], ns[1]) = (ns[1], ns[0]);
        vm.prank(CREATOR);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.load(cs, ns, ts, hashes[32]);
        (ns[0], ns[1]) = (ns[1], ns[0]);
        ns[0] = 42;
        vm.prank(CREATOR);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.load(cs, ns, ts, hashes[32]);
        ns[0] = ids[0];
        vm.prank(CREATOR);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.load(cs, ns, ts, 0);
        vm.prank(CREATOR);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.load(cs, ns, new uint8[](0), hashes[32]);
        _progress(0, false);
        assertFalse(vault.eligible(42));
    }

    function test_directSafePushRefusedAndUnsafeGiftNeverBecomesMember() public {
        SetStandardERC721 nft = _standard(10);
        _deploy(true);
        nft.mint(CREATOR, 42);
        vm.prank(CREATOR);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        nft.safeTransferFrom(CREATOR, address(vault), ids[0]);
        vm.prank(CREATOR);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        nft.safeTransferFrom(CREATOR, address(vault), 42);
        vm.prank(CREATOR);
        nft.transferFrom(CREATOR, address(vault), 42);
        assertFalse(vault.eligible(42));
        assertFalse(vault.isOutside(42));
        _progress(0, false);
        _page(0, 10);
        loader.complete();
        assertEq(vault.inside(), 10);
        assertEq(nft.balanceOf(address(vault)), 11);
        assertFalse(vault.eligible(42));
    }

    function test_unsafeGiftOfCommittedIdCannotSkipGuardedLoad() public {
        SetStandardERC721 nft = _standard(10);
        _deploy(true);
        vm.prank(CREATOR);
        nft.transferFrom(CREATOR, address(vault), ids[9]);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, uint16(10)));
        _page(0, 10);
        _progress(0, false);
        assertFalse(vault.eligible(ids[9]));
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
    }

    function test_failureFreezeUsesNoCollectionCallsAndStopsLoading() public {
        HostileERC721 nft = _hostile(33);
        _deploy(true);
        _page(0, 32);
        vm.etch(address(nft), hex"fe"); // Every NFT selector is now fatal; failure must never touch it.
        vm.warp(box.openAt() + box.GATE_CAP());
        box.failClosed();
        assertTrue(box.failed());
        assertTrue(vault.failed());
        assertFalse(vault.seedReady());
        _progress(32, false);
        (uint256 k, uint256 r) = vault.escrowSurplus();
        assertEq(k, 0);
        assertEq(r, 0);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(32, 1);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
        vm.prank(address(loader));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.loadStarter(collection, ids[32], 0);
        vm.prank(address(box));
        vm.expectRevert(CustodyVault.InvalidRequest.selector);
        vault.openGate();
    }

    function testFuzz_arbitrarySparseIds(uint256 seed) public {
        SetStandardERC721 nft = new SetStandardERC721();
        _configure(address(nft), 10);
        for (uint256 i; i < 10; ++i) {
            ids[i] = seed ^ i;
            nft.mint(CREATOR, ids[i]);
        }
        _deploy(true);
        _page(0, 10);
        loader.complete();
        for (uint256 i; i < 10; ++i) {
            assertEq(vault.memberAt(i), seed ^ i);
            assertEq(nft.ownerOf(seed ^ i), address(vault));
        }
    }
}
