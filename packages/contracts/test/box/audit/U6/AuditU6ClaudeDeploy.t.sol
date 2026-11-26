// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L8 (deployment) on the factory's box 0: P6.17 (`initialize` derives the open time by the hook's
/// rule, `BoxTickets.sol:115-125`, `BoxHook.sol:125-130`; the source is the pinned BoxBackedSource), the clone's
/// arguments against the spec (BC-012's part for the tickets), the timers against BoxSpecV1's mirrors, the placeholder's
/// JSON, and BC-097's box-0 instance (nothing leaves the vault before graduation; the map's gap: BC-097 names only
/// open-art boxes and v2).
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeDeployTest is AuditU6ClaudeBase {
    /// P6.17 on the world: the tickets, the hook and the launch router share one open time (the spec's, an hour after
    /// creation); `take` is refused one second before it (NotOpenYet) and works at it.
    function testProperty_AUDIT_U6_oneOpenTime() public {
        uint256 open = hook.openAt();
        assertEq(open, createdAt + AUDIT_OPEN_DELAY, "the spec's time");
        assertEq(tickets.openAt(), open, "the tickets agree");
        assertEq(launchRouter.openAt(), open, "the launch router agrees");
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.BeforeOpen));
        _warpTo(open - 1);
        _approveT(eoa[2], a.tickets);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotOpenYet.selector, open));
        tickets.take(1, type(uint256).max, deadline);
        _warpTo(open);
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Curve));
        _windowBuy(eoa[2], 0.05 ether);
        _take(eoa[2], 1);
        assertEq(tickets.balanceOf(eoa[2]), 1, "a take at the open second");
        _assertGhostLedger();
    }

    /// The tickets clone's arguments are the spec's and the version's: coordinator, vault, collection, T, the pinned
    /// source, N, firstId, the coordinator implementation, the texts (the placeholders add-on's name and symbol); the
    /// clone is the version's tickets implementation; the vault names it as its ticket adapter; the timers equal
    /// BoxSpecV1's mirrors; the fees are the version's flat fees.
    function testProperty_AUDIT_U6_cloneArgumentsAreTheSpecs() public view {
        assertEq(tickets.coordinator(), a.coordinator);
        assertEq(tickets.vault(), a.vault);
        assertEq(tickets.collection(), a.collection);
        assertEq(tickets.token(), a.token);
        assertEq(tickets.source(), BackedSourcePins.ADDRESS_MAINNET);
        assertEq(tickets.collectionSize(), editionSize);
        assertEq(tickets.firstId(), 1);
        assertEq(tickets.coordinatorImplementation(), kit.impls().coordinator);
        assertTrue(BoxClones.isCloneOf(a.tickets, kit.impls().tickets), "a clone of the version's tickets code");
        assertEq(vault.ticketAdapter(), a.tickets, "the vault's adapter");
        assertEq(vault.drawFeeBps(), BoxSpecV1.DRAW_FEE_BPS);
        assertEq(vault.returnFeeBps(), BoxSpecV1.RETURN_FEE_BPS);
        (string memory name_, string memory symbol_,,,) = _placeholderTexts();
        assertEq(tickets.name(), name_);
        assertEq(tickets.symbol(), symbol_);
        assertEq(tickets.SILENCE(), BoxSpecV1.DRAND_SILENCE_SECONDS);
        assertEq(tickets.SILENCE(), src.SILENCE(), "the consumer's 7 days are the source's");
        assertEq(tickets.SILENCE_UNREQUESTED(), 30 days);
        assertEq(tickets.REVEAL_GRACE(), 30 days);
        assertEq(tickets.TAKE_DELAY(), 3 days);
        assertEq(tickets.RETURN_GRACE(), 30 days);
        assertEq(tickets.supportsInterface(0x80ac58cd), true, "ERC-721");
        assertEq(tickets.supportsInterface(0x5b5e139f), true, "ERC-721 metadata");
        assertEq(tickets.supportsInterface(0x01ffc9a7), true, "ERC-165");
        assertEq(tickets.supportsInterface(0xffffffff), false);
    }

    /// A live placeholder's tokenURI is the documented JSON (`BoxTickets.sol:498-514`): the add-on's name and
    /// description, the hidden picture, one Status attribute, base64; the JSON parses.
    function testProperty_AUDIT_U6_placeholderJson() public {
        _toBonding();
        (string memory name_,, string memory description_,, string memory svg_) = _placeholderTexts();
        assertEq(collection.hiddenSvg(), svg_);
        string memory json = string.concat(
            '{"name":"',
            name_,
            '","description":"',
            description_,
            '","image":"data:image/svg+xml;base64,',
            vm.toBase64(bytes(svg_)),
            '","attributes":[{"trait_type":"Status","value":"Placeholder"}]}'
        );
        assertEq(tickets.tokenURI(1), string.concat("data:application/json;base64,", vm.toBase64(bytes(json))));
        assertEq(vm.parseJsonString(json, ".name"), name_, "valid JSON");
        assertEq(vm.parseJsonString(json, ".attributes[0].value"), "Placeholder");
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NonexistentToken.selector, 999));
        tickets.tokenURI(999);
    }

    /// BC-097, box 0's instance: in every phase before graduation (created, window, bonding, closed) no item can
    /// leave: draws, opens, draw opens, picks, the word, terminal mode and takes by number all refuse; the vault still
    /// holds all N items and its pending tickets are the live placeholders.
    function testProperty_AUDIT_U6_nothingLeavesBeforeGraduation() public {
        for (uint256 p; p < 4; ++p) {
            if (p == 1) _toWindow();
            if (p == 2) _toBonding();
            if (p == 3) _toClosed();
            uint256 deadline = vm.getBlockTimestamp();
            vm.deal(eoa[3], 1 ether);
            vm.startPrank(eoa[3]);
            vm.expectRevert(IBoxTickets.NotGraduated.selector);
            tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, deadline);
            vm.expectRevert(IBoxTickets.WordNotAccepted.selector);
            tickets.open(1, _noReveal());
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.UnknownDraw.selector, 1));
            tickets.openDraw(1, eoa[3], _noReveal());
            vm.expectRevert(IBoxTickets.NotGraduated.selector);
            tickets.requestGraduationWord();
            vm.expectRevert(IBoxTickets.WordNotRequested.selector);
            tickets.acceptGraduationWord();
            vm.expectRevert(IBoxTickets.NotGraduated.selector);
            tickets.enterTerminal();
            vm.expectRevert(IBoxTickets.NotTerminal.selector);
            tickets.cancelDraw(1);
            vm.expectRevert(IBoxTickets.NotTerminal.selector);
            tickets.takeByNumber(1, 0, type(uint256).max, deadline, _noReveal());
            vm.expectRevert(IBoxVault.GateClosed.selector);
            vault.withdraw(1, type(uint256).max, deadline);
            vm.stopPrank();
            assertEq(collection.balanceOf(a.vault), editionSize, "every item still in the vault");
            assertEq(vault.outside(), vault.pendingTickets(), "only tickets are outside n");
            assertEq(vault.pendingTickets(), tickets.status().slots, "the tickets are the placeholders");
            assertFalse(vault.gateOpen());
        }
        _assertGhostLedger();
    }

    /// @dev The placeholders add-on's five texts from the world's spec.
    function _placeholderTexts()
        internal
        view
        returns (string memory, string memory, string memory, string memory, string memory)
    {
        BoxSpecV1.BoxSpec memory s = kit.spec();
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_PLACEHOLDERS) {
                return abi.decode(s.addOns[i].params, (string, string, string, string, string));
            }
        }
        revert("no placeholders add-on");
    }
}

/// @notice P6.17's rule at creation, on fresh factory-built boxes 0 (CoreBox0Kit, the deploy script's steps): an
/// `openAt` of 0 (Now), one in the past, one equal to the creation time all open at creation + 1; a future one opens at
/// itself. The tickets, the hook and the launch router always agree.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeOpenAtRuleTest is Test {
    string internal constant SPEC_FILE = "/script/config/box0-spec.11155111.safe.json";

    function _box(uint256 openAtFromNow) internal returns (CoreBoxAddresses memory a_, uint256 created) {
        vm.pauseGasMetering();
        CoreBox0Kit k = new CoreBox0Kit();
        vm.resumeGasMetering();
        k.setUpWorld();
        BoxSpecV1.BoxSpec memory s = abi.decode(
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), SPEC_FILE)), ".encoded"), (BoxSpecV1.BoxSpec)
        );
        created = vm.getBlockTimestamp();
        // forge-lint: disable-next-line(unsafe-typecast)
        s.openAt = openAtFromNow == type(uint256).max ? 0 : uint32(openAtFromNow);
        k.prepare(s);
        k.create();
        a_ = k.addresses();
    }

    function _check(CoreBoxAddresses memory a_, uint256 want) internal view {
        assertEq(BoxTickets(a_.tickets).openAt(), want, "tickets");
        assertEq(BoxHook(a_.hook).openAt(), want, "hook");
        assertEq(BoxLaunchRouter(payable(a_.launchRouter)).openAt(), want, "launch router");
        assertEq(BoxTickets(a_.tickets).source(), BackedSourcePins.ADDRESS_MAINNET, "the pinned source");
    }

    function testProperty_AUDIT_U6_openAtNow() public {
        (CoreBoxAddresses memory a_, uint256 created) = _box(type(uint256).max);
        _check(a_, created + 1);
    }

    function testProperty_AUDIT_U6_openAtInThePast() public {
        (CoreBoxAddresses memory a_, uint256 created) = _box(1_800_000_000 - 1 days);
        _check(a_, created + 1);
    }

    function testProperty_AUDIT_U6_openAtTheCreationSecond() public {
        (CoreBoxAddresses memory a_, uint256 created) = _box(1_800_000_000);
        _check(a_, created + 1);
    }

    function testProperty_AUDIT_U6_openAtInTheFuture() public {
        (CoreBoxAddresses memory a_,) = _box(1_800_000_000 + 7 days);
        _check(a_, 1_800_000_000 + 7 days);
    }
}
