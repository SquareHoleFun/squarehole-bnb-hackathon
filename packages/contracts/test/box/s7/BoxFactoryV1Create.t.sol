// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxPhase, TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxRegistry} from "../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../src/box/interfaces/IBoxVault.sol";
import {BoxCloneArgs} from "../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxS7Base} from "./BoxS7Base.sol";

/// @notice Factory v1's createBox (slice S7): who may create, what is refused and why, the addresses fixed at the
/// factory's deployment, the record and its events, the re-reads after the launch, the per-item stream created and
/// wired with box 0 (S7 × S8). Cases BC-008 (createBox's half), BC-011, BC-012, BC-013, BC-014, BC-034, BC-064, BC-065
/// (the factory's half), BC-066, BC-072, BC-113, BC-116 (version 1's halves; the multi-box and version-2 halves are
/// S11's).
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1CreateTest is BoxS7Base {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // ============================================================================================================
    // BC-064: version 1 builds only box 0

    function test_BC064_box0IsCreatedAtTheAddressesFixedAtTheFactorysDeployment() public {
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        assertEq(a.coordinator, vm.computeCreateAddress(address(factory), 2), "the factory's second CREATE");
        assertEq(a.executor, vm.computeCreateAddress(a.coordinator, 7), "FIT's executor: the coordinator's nonce 7");
        assertEq(
            a.itemStream, vm.computeCreateAddress(a.coordinator, 9), "the per-item stream: the coordinator's nonce 9"
        );
        assertEq(a.royaltyRouter, vm.computeCreateAddress(a.coordinator, 10), "the royalty router: nonce 10");
        assertEq(a.executor.code.length, 0, "FIT's executor does not exist before box 0");
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        address hook = factory.predictHook(s.openAt, salt);
        (uint256 boxId, address coordinator, address created) = _create(s);
        assertEq(boxId, 0, "box 0");
        assertEq(coordinator, a.coordinator);
        assertEq(created, hook, "the hook at its mined address");
        BoxCoordinator c = BoxCoordinator(coordinator);
        assertEq(c.token(), a.token);
        assertEq(c.vault(), a.vault);
        assertEq(c.collection(), a.collection);
        assertEq(c.receiver(), a.receiver);
        assertEq(c.launchRouter(), a.launchRouter);
        assertEq(c.tickets(), a.tickets);
        assertEq(c.royaltyRouter(), a.royaltyRouter);
        assertEq(c.itemStream(), a.itemStream, "the per-item stream");
        assertEq(c.executor(), a.executor, "only box 0's creation produces FIT's executor");
        assertGt(a.executor.code.length, 0);
        assertEq(BoxCollection(a.collection).metadataTable(), a.table);
        assertEq(c.boxId(), 0);
        assertEq(c.creator(), address(this), "the coordinator names its creator");
    }

    /// BC-064: openAt, the reveal root and the metadata table can be fixed up to the creation: none moves box
    /// 0's addresses (the coordinator is the factory's CREATE, every other contract the coordinator's CREATE); only the
    /// hook, mined over its final init code, follows openAt (a hook argument), never the reveal data or table.
    function test_BC064_addressesAreTheSameForEveryOpenAtRevealRootAndTable() public {
        IBoxFactoryV1.Box0Addresses memory fixedAddresses = factory.box0Addresses();
        BoxSpecV1.BoxSpec memory base = _box0Spec();
        BoxSpecV1.BoxSpec[5] memory variants;
        variants[0] = _copy(base);
        variants[1] = _copy(base);
        variants[1].openAt = uint32(block.timestamp + 1 hours);
        variants[2] = _copy(base);
        variants[2].openAt = uint32(block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS);
        variants[3] = _copy(base);
        variants[3].revealRoot = keccak256("another sealed root");
        variants[4] = _copy(base);
        variants[4].metadataTable =
            vm.parseJsonBytes(vm.readFile("test/vectors/box/misfits-trait-table-r7.json"), ".table");
        address baseHook = factory.predictHook(base.openAt, _salt(base));
        for (uint256 i; i < variants.length; ++i) {
            uint256 snap = vm.snapshotState();
            (, address coordinator, address hook) = _create(variants[i]);
            assertEq(coordinator, fixedAddresses.coordinator, "the coordinator never moves");
            BoxCoordinator c = BoxCoordinator(coordinator);
            assertEq(c.token(), fixedAddresses.token, "T");
            assertEq(c.vault(), fixedAddresses.vault, "vault");
            assertEq(c.collection(), fixedAddresses.collection, "collection");
            assertEq(c.receiver(), fixedAddresses.receiver, "receiver");
            assertEq(c.launchRouter(), fixedAddresses.launchRouter, "launch router");
            assertEq(c.executor(), fixedAddresses.executor, "FIT's executor");
            assertEq(c.tickets(), fixedAddresses.tickets, "tickets");
            assertEq(c.royaltyRouter(), fixedAddresses.royaltyRouter, "royalty router");
            assertEq(c.itemStream(), fixedAddresses.itemStream, "per-item stream");
            assertEq(BoxCollection(c.collection()).metadataTable(), fixedAddresses.table, "table");
            if (variants[i].openAt == base.openAt) assertEq(hook, baseHook, "same hook");
            else assertNotEq(hook, baseHook, "the hook follows openAt only");
            vm.revertToState(snap);
        }
    }

    function testFuzz_BC064_noOtherCallerCreates(address caller) public {
        vm.assume(caller != address(this));
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        vm.deal(caller, 1 ether);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, caller));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        _assertNothingCreated();
    }

    function test_BC064_box0IsCreatedOnce() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        _create(s);
        _assertRefused(s, abi.encodeWithSelector(IBoxFactoryV1.Box0Exists.selector));
        BoxSpecV1.BoxSpec memory other = _copy(s);
        other.openAt = uint32(block.timestamp + 84);
        _assertRefused(other, abi.encodeWithSelector(IBoxFactoryV1.Box0Exists.selector));
        assertEq(registry.boxCount(), 1);
    }

    /// F80 (open-at-clock-time.md § 2.1): a time more than 14 days after the creation block is refused before anything
    /// is created, before the spec's own checks; exactly 14 days is accepted (BC-064's variants above create it).
    function test_BC023_openAtTooFarIsRefused() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        uint256 latest = block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS;
        s.openAt = uint32(latest + 1);
        _assertRefused(s, abi.encodeWithSelector(IBoxFactoryV1.OpenAtTooFar.selector, latest + 1, latest));
        // The horizon comes first (one comparison, no call): a far time with a bad name names the time; once the time
        // is within 14 days, the name.
        s.tokenName = "";
        _assertRefused(s, abi.encodeWithSelector(IBoxFactoryV1.OpenAtTooFar.selector, latest + 1, latest));
        s.openAt = uint32(latest);
        _assertRefused(s, _invalid(BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE, BoxSpecV1.FIELD_TOKEN_NAME));
    }

    /// F80: every openAt the factory sees, refused or accepted as the model says: 0 (Now) and every time from
    /// MIN_OPEN_AT up to 14 days after this block pass; 1 … MIN_OPEN_AT − 1 (a block count or a delay typed into the
    /// field) is OUT_OF_RANGE in validate(); later than 14 days is OpenAtTooFar.
    function testFuzz_BC023_openAtRefusalFollowsTheRule(uint32 openAt, uint32 now_) public {
        vm.warp(bound(now_, BoxSpecV1.MIN_OPEN_AT, 4_000_000_000));
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        s.openAt = openAt;
        uint256 latest = block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS;
        bytes memory expected;
        if (openAt != 0 && openAt < BoxSpecV1.MIN_OPEN_AT) {
            expected = _invalid(BoxSpecV1.REASON_OUT_OF_RANGE, BoxSpecV1.FIELD_OPEN_AT);
        } else if (openAt > latest) {
            expected = abi.encodeWithSelector(IBoxFactoryV1.OpenAtTooFar.selector, openAt, latest);
        }
        assertEq(factory.refusal(s, address(this)), expected);
    }

    /// F80 (open-at-clock-time.md § 2.3): Now (0), a time the creation reached (long past, the creation's own second)
    /// and a future time not on a slot: the hook, the router and the tickets hold the same open, to the second; Now and
    /// a time reached open at the creation block's time + 1, never in the creation block. The factory re-reads all three.
    function test_BC023_nowAndATimeReachedOpenInTheNextBlock() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        uint32[4] memory asked =
            [uint32(0), BoxSpecV1.MIN_OPEN_AT, uint32(block.timestamp), uint32(block.timestamp + 1 hours + 7)];
        for (uint256 i; i < asked.length; ++i) {
            uint256 snap = vm.snapshotState();
            s.openAt = asked[i];
            (, address coordinator, address hook) = _create(s);
            uint256 expected = asked[i] <= block.timestamp ? block.timestamp + 1 : asked[i];
            BoxCoordinator c = BoxCoordinator(coordinator);
            assertEq(BoxHook(hook).openAt(), expected, "hook");
            assertEq(BoxLaunchRouter(payable(c.launchRouter())).openAt(), expected, "router");
            assertEq(BoxTickets(c.tickets()).openAt(), expected, "tickets");
            assertEq(registry.recordOf(0).openAt, expected, "registry");
            assertEq(uint8(BoxHook(hook).phase()), uint8(BoxPhase.Upcoming), "never open in the creation block");
            vm.revertToState(snap);
        }
    }

    /// F80: the tickets open with the hook, to the second: `take` is refused in the last second before the open
    /// (`NotOpenYet`) and works in the open's own second, for an openAt not on the 12-second grid of the blocks.
    function test_BC023_ticketsOpenToTheSecond() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        uint256 open = block.timestamp + 67;
        s.openAt = uint32(open);
        (, address coordinator, address hook) = _create(s);
        BoxCoordinator c = BoxCoordinator(coordinator);
        BoxTickets t = BoxTickets(c.tickets());
        address alice = makeAddr("s7.openAt.alice");
        vm.roll(block.number + 5);
        vm.warp(open - 1);
        assertEq(uint8(t.phase()), uint8(TicketPhase.BeforeOpen), "open - 1: before the open");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotOpenYet.selector, open));
        t.take(1, type(uint256).max, block.timestamp);
        vm.roll(block.number + 1);
        vm.warp(open);
        assertEq(uint8(t.phase()), uint8(TicketPhase.Curve), "open: the curve");
        assertEq(uint8(BoxHook(hook).phase()), uint8(BoxPhase.Window), "the hook agrees");
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        BoxLaunchRouter(payable(c.launchRouter())).buy{value: 1 ether}(1 ether, 0, alice, block.timestamp);
        BoxToken(c.token()).approve(address(t), type(uint256).max);
        t.take(1, type(uint256).max, block.timestamp);
        vm.stopPrank();
        assertEq(t.balanceOf(alice), 1, "one placeholder taken in the open's second");
    }

    /// BC-064 and BC-066: deadlineDays NONE and the placeholders add-on (the curve's placeholders) are accepted only in
    /// box 0's spec: a version-1 spec with a deadline is invalid, a version-2 spec is not template 0 (and with box 0's
    /// per-item stream not even valid: add-on 2 is version 1's, box 0's only, BC-014), and a version-1 spec without the
    /// placeholders (open art) is not template 0 either.
    function test_BC064_deadlineNoneAndPlaceholdersOnlyInBox0() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        s.deadlineDays = 30;
        _assertRefused(s, _invalid(BoxSpecV1.REASON_DEADLINE_RULE, BoxSpecV1.FIELD_DEADLINE_DAYS));
        s.version = 2;
        _assertRefused(s, _invalid(BoxSpecV1.REASON_ADD_ON_NOT_AVAILABLE, BoxSpecV1.FIELD_ADD_ON_PER_ITEM_STREAM));
        s = _withoutStream();
        s.deadlineDays = 30;
        s.version = 2;
        _assertRefused(s, _notTemplate0(BoxSpecV1.FIELD_VERSION));
        BoxSpecV1.BoxSpec memory open = _box0Spec();
        open.artMode = BoxSpecV1.ART_MODE_OPEN;
        open.revealListId = keccak256("a published reveal list");
        _dropAddOn(open, BoxSpecV1.ADD_ON_PLACEHOLDERS);
        _assertRefused(open, _notTemplate0(BoxSpecV1.FIELD_ART_MODE));
        _assertNothingCreated();
    }

    /// BC-064: every version-1-valid spec that is not template 0 is refused with the field of the rule it breaks; box 0's
    /// spec without its per-item stream (BURN_T, add-on 2 dropped: core v1's gap before S8) is not template 0 either.
    function test_BC064_nonTemplate0SpecsAreRefusedWithAReason() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        s.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        _assertRefused(s, _notTemplate0(BoxSpecV1.FIELD_Q_STREAM));
        s = _box0Spec();
        s.marketplaceOwner = makeAddr("not the Safe");
        _assertRefused(s, _notTemplate0(BoxSpecV1.FIELD_MARKETPLACE_OWNER));
        s = _box0Spec();
        _setAddOnParams(
            s, BoxSpecV1.ADD_ON_ROYALTIES, abi.encode(uint16(250), BoxSpecV1.ROYALTY_DESTINATION_POOL_DEPTH)
        );
        _assertRefused(s, _notTemplate0(BoxSpecV1.FIELD_ADD_ON_ROYALTIES_DESTINATION));
        _assertRefused(_withoutStream(), _notTemplate0(BoxSpecV1.FIELD_T_STREAM));
        s = _box0Spec();
        s.boxType = BoxSpecV1.BOX_TYPE_TOKEN_ONLY;
        _assertRefused(s, _invalid(BoxSpecV1.REASON_MUST_BE_ZERO, BoxSpecV1.FIELD_COLLECTION_NAME));
        s = _box0Spec();
        s.q = address(weth);
        _assertRefused(s, _invalid(BoxSpecV1.REASON_Q_NOT_LISTED, BoxSpecV1.FIELD_Q));
        s = _box0Spec();
        s.raise = 10 ether;
        _assertRefused(s, _invalid(BoxSpecV1.REASON_RAISE_NOT_A_PRESET, BoxSpecV1.FIELD_RAISE));
        _assertNothingCreated();
    }

    // ============================================================================================================
    // BC-014: the fixed menu holds at creation

    /// BC-014 (version 1): of every buyers' × sellers' stream pair only box 0's is accepted (BUYBACK_BURN_T with
    /// PER_ITEM_STREAM, its add-on present: PER_ITEM_STREAM only in box 0's spec); creator kinds and holder payouts are
    /// refused by validate() on version 1, SELL_FOR_Q beside BUYBACK_BURN_T by the menu rule, ALL_TO_FIT and BURN_Q by
    /// template 0; BURN_T beside add-on 2 by validate(), and without it (core v1's gap before S8) by template 0.
    function test_BC014_onlyBox0sMenuPairIsAccepted() public view {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        for (uint8 q = 1; q <= 7; ++q) {
            for (uint8 t = 1; t <= 7; ++t) {
                s.qStream = q;
                s.tStream = t;
                bytes memory err = factory.refusal(s, address(this));
                if (q == BoxSpecV1.Q_STREAM_BUYBACK_BURN_T && t == BoxSpecV1.T_STREAM_PER_ITEM_STREAM) {
                    assertEq(err.length, 0, "box 0's pair");
                } else {
                    assertGt(err.length, 0, string.concat("refused: ", vm.toString(q), "/", vm.toString(t)));
                }
            }
        }
        assertEq(factory.refusal(_withoutStream(), address(this)), _notTemplate0(BoxSpecV1.FIELD_T_STREAM), "BURN_T");
    }

    // ============================================================================================================
    // BC-008, BC-072: N and the strings, refused before anything is created

    function test_BC008_createBoxRefusesNBelowTenOrAboveTenThousand() public {
        uint32[4] memory ns = [uint32(1), 2, 9, 10_001];
        for (uint256 i; i < ns.length; ++i) {
            BoxSpecV1.BoxSpec memory s = _box0Spec();
            s.n = ns[i];
            _assertRefused(s, _invalid(BoxSpecV1.REASON_OUT_OF_RANGE, BoxSpecV1.FIELD_N));
        }
        _assertNothingCreated();
    }

    /// BC-072: in every text the spec carries, a non-ASCII byte, a double quote, a backslash, a control character or too
    /// many bytes is refused by validate() with its field before anything is created (the hidden SVG's rule admits
    /// quotes and backslashes; the link's needs https:// and admits neither); the hidden SVG outside template 0 (open
    /// art keeping the placeholders add-on) is refused too.
    function test_BC072_everyBadStringIsRefusedBeforeAnythingIsCreated() public {
        string[5] memory bad = ["caf\xc3\xa9", "say \"hi\"", "back\\slash", "line\nbreak", ""];
        for (uint256 f; f < 11; ++f) {
            for (uint256 k; k < bad.length; ++k) {
                // Each round's specs are dropped at its end: reset the free memory pointer (test-only, nothing kept).
                uint256 fmp;
                assembly ("memory-safe") {
                    fmp := mload(0x40)
                }
                _checkBadText(f, k, bad[k]);
                assembly ("memory-safe") {
                    mstore(0x40, fmp)
                }
            }
        }
        (BoxSpecV1.BoxSpec memory one, uint16 f0,,,) = _withText(0, "caf\xc3\xa9");
        _assertRefused(one, _invalid(BoxSpecV1.REASON_BAD_CHARACTER, f0));
        // The hidden SVG (the placeholders add-on) only in template 0: open art keeping it is refused by validate().
        BoxSpecV1.BoxSpec memory open = _box0Spec();
        open.artMode = BoxSpecV1.ART_MODE_OPEN;
        open.revealListId = keccak256("a published reveal list");
        _assertRefused(open, _invalid(BoxSpecV1.REASON_ADD_ON_CONFLICT, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS));
        _assertNothingCreated();
    }

    /// @dev Text `f` set to bad kind `k` (or, for k = 4, one byte too long) is refused with its field.
    function _checkBadText(uint256 f, uint256 k, string memory badText) internal view {
        (BoxSpecV1.BoxSpec memory s, uint16 field, uint256 max, bool svg, bool url) = _withText(f, badText);
        if (k == 4) (s,,,,) = _withText(f, _tooLong(max, url));
        if (svg && (k == 1 || k == 2)) {
            assertEq(factory.refusal(s, address(this)).length, 0, "SVG admits quotes and backslashes");
            return;
        }
        uint16 reason = k == 4 ? BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE : BoxSpecV1.REASON_BAD_CHARACTER;
        assertEq(
            factory.refusal(s, address(this)), _invalid(reason, field), string.concat("field ", vm.toString(field))
        );
    }

    /// @dev Box 0's spec with text `f` replaced: its field id, maximum length and rule (SVG, URL).
    function _withText(uint256 f, string memory v)
        internal
        view
        returns (BoxSpecV1.BoxSpec memory s, uint16 field, uint256 max, bool svg, bool url)
    {
        s = _box0Spec();
        if (f == 0) {
            (s.tokenName, field, max) = (v, BoxSpecV1.FIELD_TOKEN_NAME, 32);
        } else if (f == 1) {
            (s.tokenSymbol, field, max) = (v, BoxSpecV1.FIELD_TOKEN_SYMBOL, 11);
        } else if (f == 2) {
            (s.collectionName, field, max) = (v, BoxSpecV1.FIELD_COLLECTION_NAME, 32);
        } else if (f == 3) {
            (s.collectionSymbol, field, max) = (v, BoxSpecV1.FIELD_COLLECTION_SYMBOL, 11);
        } else if (f == 4) {
            (s.description, field, max) = (v, BoxSpecV1.FIELD_DESCRIPTION, 1024);
        } else if (f <= 9) {
            (string memory a, string memory b, string memory c, string memory d, string memory e) =
                abi.decode(_addOnParams(s, BoxSpecV1.ADD_ON_PLACEHOLDERS), (string, string, string, string, string));
            if (f == 5) (a, field, max) = (v, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME, 32);
            if (f == 6) (b, field, max) = (v, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_SYMBOL, 11);
            if (f == 7) (c, field, max) = (v, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_DESCRIPTION, 1024);
            if (f == 8) (d, field, max) = (v, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_DESCRIPTION, 1024);
            if (f == 9) (e, field, max, svg) = (v, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_SVG, 4096, true);
            _setAddOnParams(s, BoxSpecV1.ADD_ON_PLACEHOLDERS, abi.encode(a, b, c, d, e));
        } else {
            (bytes32 banner, bytes32[] memory teasers,) =
                abi.decode(_addOnParams(s, BoxSpecV1.ADD_ON_COLLECTION_METADATA), (bytes32, bytes32[], string));
            string memory link = bytes(v).length == 0 ? v : string.concat("https://", v);
            (field, max, url) = (BoxSpecV1.FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK, 128, true);
            _setAddOnParams(s, BoxSpecV1.ADD_ON_COLLECTION_METADATA, abi.encode(banner, teasers, link));
        }
    }

    /// @dev One byte more than the field allows (a valid letter); a link keeps its https:// prefix in the count.
    function _tooLong(uint256 max, bool url) internal pure returns (string memory) {
        bytes memory b = new bytes(url ? max + 1 - 8 : max + 1);
        for (uint256 i; i < b.length; ++i) {
            b[i] = "a";
        }
        return string(b);
    }

    // ============================================================================================================
    // BC-011: all or nothing; nobody else can take box 0's addresses; dust cannot block it

    /// BC-011: a wrong value, FIT's executor's code other than the pinned hash's, an unmined salt: each reverts with
    /// nothing created (no contract at any fixed address, no record, no pool).
    function test_BC011_invalidCallsLeaveNoContractPoolOrRecord() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        vm.deal(address(this), 10 ether);
        uint256[3] memory wrong = [uint256(0), BoxSpecV1.BOOTSTRAP_ETH - 1, BoxSpecV1.BOOTSTRAP_ETH + 1];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IBoxFactoryV1.WrongValue.selector, wrong[i], BoxSpecV1.BOOTSTRAP_ETH)
            );
            factory.createBox{value: wrong[i]}(s, salt, _executorCode());
        }
        bytes memory notTheExecutor = type(BoxToken).creationCode;
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.ExecutorCodeMismatch.selector, keccak256(notTheExecutor)));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, notTheExecutor);
        bytes32 unmined = bytes32(uint256(salt) + 1);
        address wrongHook = factory.predictHook(s.openAt, unmined);
        assertNotEq(uint160(wrongHook) & 0x3FFF, 0x2AE0, "this salt is not mined");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.HookSaltNotMined.selector, wrongHook));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, unmined, _executorCode());
        _assertNothingCreated();
        PoolKey memory key = PoolKey(
            Currency.wrap(address(0)),
            Currency.wrap(factory.box0Addresses().token),
            BoxSpecV1.LP_FEE,
            BoxSpecV1.TICK_SPACING,
            IHooks(factory.predictHook(s.openAt, salt))
        );
        (uint160 sqrtPrice,,,) = pm.getSlot0(key.toId());
        assertEq(sqrtPrice, 0, "no pool");
    }

    /// BC-011: the same calldata replayed first from another address is refused (version 1 has one creator, fixed at
    /// the factory's deployment); the creator's call then succeeds at the same addresses.
    function test_BC011_aReplayFromAnotherAddressCannotTakeBox0() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        address frontRunner = makeAddr("s7.frontRunner");
        vm.deal(frontRunner, 1 ether);
        vm.prank(frontRunner);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, frontRunner));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        (, address coordinator,) = _create(s);
        assertEq(coordinator, factory.box0Addresses().coordinator);
    }

    // ============================================================================================================
    // BC-012, BC-013, BC-034: the record, the template id

    /// BC-012: createBox writes one record and emits BoxCreated with the record as `recordOf(0)` rebuilds it and BoxSpec
    /// with the spec's encoding, whose hash is the spec hash; only the factory may write; every clone initialises once
    /// and every implementation refuses to be initialised directly.
    function test_BC012_oneRecordItsEventsAndOneInitialisationEach() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        vm.recordLogs();
        (, address coordinator, address hook) = _create(s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        IBoxRegistry.BoxRecord memory rec = registry.recordOf(0);
        bool created;
        bool specLogged;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(registry)) continue;
            if (logs[i].topics[0] == IBoxRegistry.BoxCreated.selector) {
                created = true;
                assertEq(logs[i].topics[1], bytes32(0), "box id 0");
                assertEq(logs[i].topics[2], factory.templateIdOf(s), "template id");
                assertEq(logs[i].topics[3], keccak256(abi.encode(s)), "spec hash");
                assertEq(keccak256(logs[i].data), keccak256(abi.encode(rec)), "the record as recordOf rebuilds it");
            }
            if (logs[i].topics[0] == IBoxRegistry.BoxSpec.selector) {
                specLogged = true;
                bytes memory encoded = abi.decode(logs[i].data, (bytes));
                assertEq(encoded, abi.encode(s), "the whole spec");
                assertEq(keccak256(encoded), BoxCoordinator(coordinator).specHash(), "hashes to the spec hash");
            }
        }
        assertTrue(created && specLogged, "both events");
        (,,,, bytes32 recordHash) = registry.entry(0);
        assertEq(recordHash, keccak256(abi.encode(rec)));
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistry.NotFactory.selector, address(this)));
        registry.record(coordinator, bytes32(0), abi.encode(s));
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistry.AlreadyRecorded.selector, coordinator));
        registry.record(coordinator, bytes32(0), abi.encode(s));
        // Each clone initialises once, from its coordinator only.
        BoxCoordinator c = BoxCoordinator(coordinator);
        (address col, address vault, address router, address receiver) =
            (c.collection(), c.vault(), c.launchRouter(), c.receiver());
        address stream = c.itemStream();
        vm.startPrank(coordinator);
        vm.expectRevert(IBoxCollection.AlreadyInitialised.selector);
        IBoxCollection(col).initialize();
        vm.expectRevert(IBoxVault.AlreadyInitialised.selector);
        IBoxVault(vault).initialize();
        vm.expectRevert(IBoxHook.AlreadyInitialised.selector);
        IBoxHook(hook).initialize();
        vm.expectRevert(IBoxLaunchRouter.AlreadyInitialised.selector);
        IBoxLaunchRouter(router).initialize();
        vm.expectRevert(IBoxReceiver.AlreadyInitialised.selector);
        IBoxReceiver(receiver).initialize();
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        IBoxItemStream(stream).initialize();
        vm.stopPrank();
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        c.launch{value: 0}();
        // The implementations are never boxes.
        IBoxFactoryV1.Implementations memory i = factory.implementations();
        vm.expectRevert();
        IBoxCollection(i.collection).initialize();
        vm.expectRevert();
        IBoxVault(i.vault).initialize();
        vm.expectRevert();
        IBoxHook(i.hook).initialize();
        vm.expectRevert();
        IBoxLaunchRouter(i.launchRouter).initialize();
        vm.expectRevert();
        IBoxReceiver(i.receiver).initialize();
        vm.expectRevert();
        IBoxItemStream(i.itemStream).initialize();
    }

    /// BC-013: the template id is the same for every value that is data (names, N, texts, art, table, open delay,
    /// royalty rate) and differs when the box type, layout, graduated layout, Q class, either stream action, the art
    /// mode, a wiring add-on or its destination, or the module's code hash differs; BoxCreated carries it.
    function test_BC013_templateIdFollowsTheStructureNotTheData() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 id = factory.templateIdOf(s);
        BoxSpecV1.BoxSpec memory d = _copy(s);
        d.tokenName = "Other";
        d.tokenSymbol = "OTH";
        d.collectionName = "Others";
        d.n = 69;
        d.description = "another description";
        d.revealRoot = keccak256("r");
        d.metadataTable = vm.parseJsonBytes(vm.readFile("test/vectors/box/misfits-trait-table-r7.json"), ".table");
        d.openAt = uint32(block.timestamp + 12);
        _setAddOnParams(
            d, BoxSpecV1.ADD_ON_ROYALTIES, abi.encode(uint16(500), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING)
        );
        assertEq(factory.templateIdOf(d), id, "data does not move the template id");
        bytes32[] memory ids = new bytes32[](9);
        BoxSpecV1.BoxSpec memory v;
        (v = _copy(s)).boxType = BoxSpecV1.BOX_TYPE_TOKEN_ONLY;
        ids[0] = factory.templateIdOf(v);
        (v = _copy(s)).layout = 2;
        ids[1] = factory.templateIdOf(v);
        (v = _copy(s)).gradLayout = BoxSpecV1.GRAD_LAYOUT_B_PRIME;
        ids[2] = factory.templateIdOf(v);
        (v = _copy(s)).q = address(weth);
        ids[3] = factory.templateIdOf(v);
        (v = _copy(s)).qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        ids[4] = factory.templateIdOf(v);
        (v = _copy(s)).tStream = BoxSpecV1.T_STREAM_SELL_FOR_Q;
        ids[5] = factory.templateIdOf(v);
        (v = _copy(s)).artMode = BoxSpecV1.ART_MODE_OPEN;
        ids[6] = factory.templateIdOf(v);
        v = _copy(s);
        _setAddOnParams(
            v, BoxSpecV1.ADD_ON_ROYALTIES, abi.encode(uint16(250), BoxSpecV1.ROYALTY_DESTINATION_POOL_DEPTH)
        );
        ids[7] = factory.templateIdOf(v);
        v = _copy(s);
        _dropAddOn(v, BoxSpecV1.ADD_ON_ROYALTIES);
        ids[8] = factory.templateIdOf(v);
        for (uint256 i; i < ids.length; ++i) {
            assertNotEq(ids[i], id, string.concat("structure moves it: ", vm.toString(i)));
            for (uint256 j; j < i; ++j) {
                assertNotEq(ids[i], ids[j], "distinct");
            }
        }
        // The module's code hash: the same spec under another executor code hash is another template.
        bytes32 otherModule = planner.templateIdOf(s, factory.versionCodeHash(), keccak256("another executor"));
        assertNotEq(otherModule, id, "module code hash");
        assertEq(planner.templateIdOf(s, factory.versionCodeHash(), factory.executorInitCodeHash()), id);
        _create(s);
        (,, bytes32 recorded,,) = registry.entry(0);
        assertEq(recorded, id, "BoxCreated / the record carry it");
    }

    /// BC-034 (version 1's half): the same creator with an identical spec twice is refused; two creators and two
    /// boxes in one block are version 2's (S11).
    function test_BC034_theSameSpecTwiceIsRefused() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        _create(s);
        _assertRefused(s, abi.encodeWithSelector(IBoxFactoryV1.Box0Exists.selector));
    }

    // ============================================================================================================
    // BC-113, BC-116: royalties and the creator buy at creation

    /// BC-113 (version 1): each royalty preset with fee handling builds box 0 with that rate, paid to its router; the
    /// creator destination is refused by validate() on version 1, pool depth by template 0, a rate off the presets by
    /// validate(); without the add-on box 0 has no router and no ERC-2981 rate.
    function test_BC113_box0TakesEachRoyaltyPresetToItsFeeHandling() public {
        uint16[4] memory presets = [uint16(0), 100, 250, 500];
        for (uint256 i; i < presets.length; ++i) {
            uint256 snap = vm.snapshotState();
            BoxSpecV1.BoxSpec memory s = _box0Spec();
            _setAddOnParams(
                s, BoxSpecV1.ADD_ON_ROYALTIES, abi.encode(presets[i], BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING)
            );
            (, address coordinator,) = _create(s);
            BoxCoordinator c = BoxCoordinator(coordinator);
            IBoxCollection col = IBoxCollection(c.collection());
            assertEq(col.royaltyBps(), presets[i], "the preset");
            assertEq(col.royaltyRouter(), c.royaltyRouter(), "paid to the box's router");
            (address payTo, uint256 amount) = col.royaltyInfo(1, 10_000);
            assertEq(payTo, c.royaltyRouter());
            assertEq(amount, presets[i]);
            vm.revertToState(snap);
        }
        BoxSpecV1.BoxSpec memory bad = _box0Spec();
        _setAddOnParams(bad, BoxSpecV1.ADD_ON_ROYALTIES, abi.encode(uint16(250), BoxSpecV1.ROYALTY_DESTINATION_CREATOR));
        _assertRefused(bad, _invalid(BoxSpecV1.REASON_ADD_ON_CONFLICT, BoxSpecV1.FIELD_ADD_ON_ROYALTIES));
        _setAddOnParams(
            bad, BoxSpecV1.ADD_ON_ROYALTIES, abi.encode(uint16(300), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING)
        );
        _assertRefused(bad, _invalid(BoxSpecV1.REASON_NOT_A_MEMBER, BoxSpecV1.FIELD_ADD_ON_ROYALTIES_BPS));
        BoxSpecV1.BoxSpec memory none = _box0Spec();
        _dropAddOn(none, BoxSpecV1.ADD_ON_ROYALTIES);
        (, address c0,) = _create(none);
        assertEq(BoxCoordinator(c0).royaltyRouter(), address(0), "no router without the add-on");
        assertEq(BoxCoordinator(c0).itemStream(), factory.box0Addresses().itemStream, "the stream at its fixed address");
        assertEq(IBoxCollection(BoxCoordinator(c0).collection()).royaltyBps(), 0);
        assertEq(registry.recordOf(0).contracts[registry.ROLE_ROYALTY_ROUTER()], address(0));
    }

    /// BC-116 (box 0): no creator buy: createBox refuses any amount (validate(): must be zero on version 1), and box
    /// 0's coordinator and BoxSpec event publish zero.
    function test_BC116_box0HasNoCreatorBuy() public {
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        s.creatorBuy = 1;
        _assertRefused(s, _invalid(BoxSpecV1.REASON_MUST_BE_ZERO, BoxSpecV1.FIELD_CREATOR_BUY));
        s.creatorBuy = 0;
        (, address coordinator,) = _create(s);
        assertEq(BoxCoordinator(coordinator).creatorBuyAmount(), 0);
        assertEq(IBoxLaunchRouter(BoxCoordinator(coordinator).launchRouter()).creatorBought(), false);
    }

    // ============================================================================================================
    // BC-065 (the factory's half): box 0 is created with its per-item stream on its hook points

    /// BC-065 (S7 × S8): createBox creates the per-item stream with box 0 at the address fixed at the factory's
    /// deployment (the coordinator's nonce 9), as a fixed clone of the version's stream implementation whose 182 argument
    /// bytes name box 0's contracts, N and firstId; the coordinator, the collection (its transfer observer), the vault
    /// (its observer) and the receiver (the PER_ITEM_STREAM action) name it; it was initialised once by the coordinator
    /// at the launch, has not started (it starts at graduation) and counts nothing outside; the registry's record carries
    /// it with its code hash.
    function test_BC065_box0IsCreatedWithItsStreamOnItsHookPoints() public {
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        assertEq(a.itemStream.code.length, 0, "no stream before box 0");
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        (, address coordinator, address hook) = _create(s);
        BoxCoordinator c = BoxCoordinator(coordinator);
        address st = c.itemStream();
        assertEq(st, a.itemStream, "at the factory's fixed address");
        assertEq(st, vm.computeCreateAddress(coordinator, 9), "the coordinator's nonce 9");
        assertTrue(BoxClones.isCloneOf(st, factory.implementations().itemStream), "a clone of the version's stream");
        assertEq(st.code.length, BoxClones.ARGS_OFFSET + BoxCloneArgs.S_LENGTH, "proxy + 182 argument bytes");
        IBoxItemStream stream = IBoxItemStream(st);
        assertEq(stream.coordinator(), coordinator, "stream: coordinator");
        assertEq(stream.token(), c.token(), "stream: T");
        assertEq(stream.collection(), c.collection(), "stream: collection");
        assertEq(stream.vault(), c.vault(), "stream: vault");
        assertEq(stream.tickets(), c.tickets(), "stream: tickets");
        assertEq(stream.receiver(), c.receiver(), "stream: receiver");
        assertEq(stream.hook(), hook, "stream: hook");
        assertEq(stream.poolManager(), address(pm), "stream: PoolManager");
        assertEq(stream.collectionSize(), s.n, "stream: N");
        assertEq(stream.firstId(), s.firstId, "stream: firstId");
        assertEq(IBoxCollection(c.collection()).transferObserver(), st, "the collection's transfer observer");
        assertEq(IBoxVault(c.vault()).observer(), st, "the vault's observer");
        assertEq(IBoxReceiver(c.receiver()).itemStream(), st, "the receiver streams the T side to it");
        assertEq(IBoxReceiver(c.receiver()).tStream(), BoxSpecV1.T_STREAM_PER_ITEM_STREAM, "PER_ITEM_STREAM");
        assertFalse(stream.started(), "it starts at graduation");
        assertEq(stream.outsideCount(), 0, "all N in the vault");
        vm.prank(coordinator);
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        stream.initialize();
        IBoxRegistry.BoxRecord memory rec = registry.recordOf(0);
        assertEq(rec.contracts[registry.ROLE_ITEM_STREAM()], st, "the record's stream");
        assertEq(rec.codeHashes[registry.ROLE_ITEM_STREAM()], st.codehash, "and its code hash");
    }

    // ============================================================================================================
    // BC-004: the creation transaction's T transfers

    /// BC-004 (createBox's half): in the creation transaction T is issued once, to the coordinator, and moves only
    /// between the coordinator, the PoolManager and the launch router (the curve's deposit, the bootstrap buy) and the
    /// zero address (the bootstrap's burn); no outside account holds T after it.
    function test_BC004_creationMovesTOnlyAmongTheBoxsContracts() public {
        vm.recordLogs();
        (, address coordinator,) = _create(_box0Spec());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        BoxCoordinator c = BoxCoordinator(coordinator);
        address t = c.token();
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        uint256 mints;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != t || logs[i].topics[0] != transfer) continue;
            address from = address(uint160(uint256(logs[i].topics[1])));
            address to = address(uint160(uint256(logs[i].topics[2])));
            if (from == address(0)) {
                ++mints;
                assertEq(to, coordinator, "issued to the coordinator");
                assertEq(abi.decode(logs[i].data, (uint256)), BoxSpecV1.ISSUANCE, "the whole issue");
            }
            assertTrue(_boxSide(from, c) && _boxSide(to, c), "T moves only among the box's contracts");
        }
        assertEq(mints, 1, "one issuance");
        assertEq(IBoxToken(t).balanceOf(address(this)), 0, "the creator holds no T");
        assertEq(
            IBoxToken(t).balanceOf(coordinator) + IBoxToken(t).balanceOf(address(pm)),
            IBoxToken(t).totalSupply(),
            "all T with the coordinator or in the pool"
        );
    }

    function _boxSide(address a, BoxCoordinator c) internal view returns (bool) {
        return a == address(0) || a == address(c) || a == address(pm) || a == c.launchRouter();
    }

    /// The pool re-read: the static fee, the price inside the curve and the curve's liquidity active.
    function test_BC063_thePoolIsReReadAfterTheLaunch() public {
        (, address coordinator, address hook) = _create(_box0Spec());
        (uint160 sqrtPrice, int24 tick,, uint24 lpFee) = pm.getSlot0(BoxHook(hook).poolId());
        (int24 lower, int24 upper, uint128 liquidity) = BoxHook(hook).curve();
        assertGt(sqrtPrice, 0);
        assertEq(lpFee, BoxSpecV1.LP_FEE);
        assertTrue(tick >= lower && tick < upper, "inside the curve after the bootstrap buy");
        assertEq(pm.getLiquidity(BoxHook(hook).poolId()), liquidity, "the curve's liquidity is active");
        BoxToken t = BoxToken(BoxCoordinator(coordinator).token());
        assertEq(t.totalBurned(), t.initialSupply() - t.totalSupply(), "only the bootstrap's T burned");
        assertEq(address(factory).balance, 0, "the factory keeps no ETH");
    }
}
