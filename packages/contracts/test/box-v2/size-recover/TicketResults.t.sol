// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxShuffle} from "../../../src/box/libraries/BoxShuffle.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IVaultFailureClock} from "../../../src/box-v2/libraries/VaultFailure.sol";
import {BoxTicketsV2Views} from "../../../src/box-v2/BoxTicketsV2Views.sol";

// Frozen decisions from BoxTicketsV2 at a592d29f, exposed over the existing getters for differential calls.
contract ReferenceTicketViews {
    function numberPosition(address consumer, uint256 itemId) public view returns (bool numbered, uint256 position) {
        IBoxTickets tickets = IBoxTickets(consumer);
        uint256 first = tickets.firstId();
        uint256 n = tickets.collectionSize();
        if (itemId < first || itemId - first >= n) revert IBoxTickets.IneligibleId(itemId);
        uint256 offset = itemId - first;
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.slots != 0 && s.wordAcceptedAt == 0) return (false, 0);
        if (s.slots == 0) return (true, offset);
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return (true, BoxShuffle.invert(tickets.graduationWord(), offset, n, u, v));
    }

    function phase(address consumer) external view returns (TicketPhase) {
        IBoxTickets tickets = IBoxTickets(consumer);
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt != 0) return TicketPhase.Terminal;
        uint256 end = IVaultFailureClock(tickets.vault()).failureWindowEnds();
        uint256 at = end == 0 ? IBoxVaultV2(tickets.vault()).gateOpenedAt() : end;
        if (at == 0) return block.timestamp < tickets.openAt() ? TicketPhase.BeforeOpen : TicketPhase.Curve;
        if (block.timestamp < at) return TicketPhase.Curve;
        return s.slots != 0 && s.wordAcceptedAt == 0 ? TicketPhase.AwaitingWord : TicketPhase.Drawing;
    }

    function checkNumber(address consumer, uint256 itemId, uint256 poolIndex) external view returns (uint256 takeFrom) {
        IBoxTickets tickets = IBoxTickets(consumer);
        if (IVaultFailureClock(tickets.vault()).failureWindowEnds() != 0) revert IBoxVaultV2.AlreadyFailed();
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt == 0) revert IBoxTickets.NotTerminal();
        takeFrom = uint256(s.terminalAt) + 3 days;
        if (block.timestamp < takeFrom) revert IBoxTickets.TooEarly(takeFrom);
        (bool numbered, uint256 position) = numberPosition(consumer, itemId);
        if (numbered) {
            if (position < s.slots) revert IBoxTickets.NumberTaken(itemId);
            if (
                poolIndex >= tickets.collectionSize() - s.slots - s.drawsSettled
                    || tickets.poolPositionAt(poolIndex) != position
            ) revert IBoxTickets.NotInPool(itemId, poolIndex);
        }
    }
}

contract TicketReadFixture {
    IBoxTickets.TicketState internal _state;
    uint256 public firstId = 100;
    uint256 public collectionSize = 10;
    bytes32 public graduationWord = keccak256("frozen permutation");
    uint256 public failureWindowEnds;
    uint256 public gateOpenedAt;
    uint256 public openAt;
    uint256 public poolPosition;

    function vault() external view returns (address) {
        return address(this);
    }

    function status() external view returns (IBoxTickets.TicketState memory) {
        return _state;
    }

    function poolPositionAt(uint256) external view returns (uint256) {
        return poolPosition;
    }

    function configure(uint256 mode, uint256 since, uint32 slots, uint32 settled, bool accepted, uint256 position)
        external
    {
        _state = IBoxTickets.TicketState({
            minted: 0,
            slots: slots,
            wordRequestedAt: 0,
            wordAcceptedAt: accepted ? 1 : 0,
            drawsRequested: settled,
            drawsSettled: settled,
            terminalAt: mode == 3 ? uint40(since) : 0
        });
        failureWindowEnds = mode == 2 ? since : 0;
        gateOpenedAt = mode == 1 ? since : 0;
        openAt = since;
        poolPosition = position;
    }
}

contract TicketResultsTest is Test {
    ReferenceTicketViews private old;
    BoxTicketsV2Views private candidate;
    TicketReadFixture private fixture;

    function setUp() public {
        old = new ReferenceTicketViews();
        candidate = new BoxTicketsV2Views();
        fixture = new TicketReadFixture();
        vm.warp(100 days);
    }

    function testFuzz_phaseAndAdmission(
        uint8 mode,
        uint32 since,
        uint8 slots,
        uint8 settled,
        bool accepted,
        uint8 item,
        uint8 poolIndex,
        uint8 position
    ) public {
        fixture.configure(mode % 4, since, slots % 11, settled % 11, accepted, position % 11);
        _same(abi.encodeCall(old.phase, (address(fixture))));
        _same(abi.encodeCall(old.checkNumber, (address(fixture), 99 + uint256(item % 12), poolIndex % 12)));
    }

    function test_phaseAndTakeDelayBoundaries() public {
        for (uint256 mode; mode < 4; ++mode) {
            for (uint256 offset; offset < 3; ++offset) {
                uint256 since = 100 days;
                fixture.configure(mode, since, 2, 0, true, 9);
                vm.warp(since - 1 + offset);
                _same(abi.encodeCall(old.phase, (address(fixture))));
                vm.warp(since + 3 days - 1 + offset);
                for (uint256 item = 99; item <= 110; ++item) {
                    _same(abi.encodeCall(old.checkNumber, (address(fixture), item, 0)));
                }
            }
        }
        fixture.configure(3, 1, 2, 0, false, 9);
        _same(abi.encodeCall(old.checkNumber, (address(fixture), 101, type(uint256).max)));
    }

    function _same(bytes memory data) private view {
        (bool expectedOk, bytes memory expected) = address(old).staticcall(data);
        (bool actualOk, bytes memory actual) = address(candidate).staticcall(data);
        assertEq(actualOk, expectedOk, "ticket decision changed");
        assertEq(actual, expected, "ticket return/revert bytes changed");
    }
}
