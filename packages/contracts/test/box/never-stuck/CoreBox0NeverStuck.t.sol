// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {DrawStatus, TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {BoxDrandVectors} from "../randomness/utils/BoxDrandVectors.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../conformance/core/CoreBox0Kit.sol";

abstract contract CoreBox0NeverStuckBase is BoxDrandVectors {
    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    /// Box 0's source (F143: the pinned BoxBackedSource): its requests, words and clocks.
    IDrandSource internal src;
    /// The pinned DrandSource the backed source names: rounds are posted here.
    IDrandSource internal drand;
    BoxTickets internal tickets;
    uint256 internal r0;
    uint256 internal gate;
    address internal drawer;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        src = IDrandSource(address(b.source()));
        drand = IDrandSource(address(b.drand()));
        vm.warp(src.roundTime(r0) - 1 days);
        string memory json = vm.readFile("test/vectors/box-spec/box-spec-v1.json");
        BoxSpecV1.BoxSpec memory spec = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        spec.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
        b.prepare(spec);
        b.create();
        a = b.addresses();
        tickets = BoxTickets(a.tickets);
        b.toClosed();
        assertLt(block.timestamp, src.roundTime(r0) - 12);
    }

    function _graduate(bool failedPoke) internal {
        vm.warp(src.roundTime(r0) - 12);
        gate = block.timestamp;
        if (failedPoke) vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "failed poke");
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        assertEq(tickets.status().wordRequestedAt, failedPoke ? 0 : gate);
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord));
    }

    function _post(uint256 offset, uint256 at) internal {
        vm.warp(at);
        vm.prank(makeAddr("other poster"));
        drand.postRound(r0 + offset, _localSig(offset));
    }

    function _drawing() internal {
        _graduate(false);
        _post(0, src.roundTime(r0));
        tickets.acceptGraduationWord();
        drawer = makeAddr("drawer");
        b.buy(drawer, b.eth(0.5 ether), 0);
        vm.prank(drawer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
    }

    function _draw(uint256 offset) internal returns (uint256 id, uint256 at) {
        vm.warp(src.roundTime(r0 + offset) - 12);
        at = block.timestamp;
        vm.prank(drawer);
        id = tickets.draw(type(uint256).max, block.timestamp);
        (, uint64 round) = src.requestOf(a.tickets, id);
        assertEq(round, r0 + offset);
    }

    function _alive(uint256 key, uint256 deadline) internal {
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, key, deadline));
        tickets.enterTerminal();
    }

    function test_timelyWordSurvivesSixtyDays() public {
        _graduate(false);
        _post(0, gate + 7 days - 1);
        vm.warp(gate + 60 days);
        _alive(0, gate + 7 days);
        tickets.acceptGraduationWord();
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
    }

    function test_exactSevenDaysCounts() public {
        _graduate(false);
        _post(0, gate + 7 days);
        vm.warp(block.timestamp + 1);
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
    }

    function test_oneSecondLateBlocksQueueBeforeTerminal() public {
        _graduate(false);
        _post(0, gate + 7 days + 1);
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.QueueDead.selector, 0, gate + 7 days));
        tickets.draw(type(uint256).max, block.timestamp);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    function test_failedPokeRecoveredOnDayTwentyNine() public {
        _graduate(true);
        vm.warp(gate + 29 days);
        _alive(0, gate + 30 days);
        vm.prank(makeAddr("other requester"));
        tickets.requestGraduationWord();
        uint256 requestedAt = block.timestamp;
        vm.warp(gate + 30 days + 1);
        _alive(0, requestedAt + 7 days);
    }

    function test_unrequestedThirtyDayBoundary() public {
        _graduate(true);
        vm.warp(gate + 30 days);
        _alive(0, gate + 30 days);
        vm.warp(block.timestamp + 1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    function test_timelyDrawSettlesAfterThirtyDays() public {
        _drawing();
        (uint256 id, uint256 at) = _draw(3);
        _post(3, at + 7 days - 1);
        vm.warp(at + 30 days);
        assertEq(tickets.settle(8), 1);
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Settled));
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
    }

    function test_secondLateDrawBecomesDeadHead() public {
        _drawing();
        (, uint256 firstAt) = _draw(3);
        (, uint256 secondAt) = _draw(6);
        _post(3, firstAt + 7 days - 1);
        _post(6, secondAt + 7 days + 1);
        assertEq(tickets.settle(8), 1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }
}

/// forge-config: default.evm_version = "osaka"
contract CoreBox0NeverStuckOsakaTest is CoreBox0NeverStuckBase {}

/// forge-config: default.evm_version = "amsterdam"
contract CoreBox0NeverStuckAmsterdamTest is CoreBox0NeverStuckBase {}
