// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TicketPhase} from "../box/interfaces/BoxTypes.sol";
import {IBoxVaultV2} from "./interfaces/IBoxVaultV2.sol";
import {IVaultFailureClock} from "./libraries/VaultFailure.sol";
import {IBoxTickets} from "../box/interfaces/IBoxTickets.sol";
import {BoxEncoding} from "../box/libraries/BoxEncoding.sol";
import {BoxShuffle} from "../box/libraries/BoxShuffle.sol";
import {IBoxCollectionTextsV2} from "./libraries/BoxCollectionV2Args.sol";

/// @notice Stateless Tickets code part, created once by its implementation constructor and fixed in its code.
/// Anyone may read it; it holds no storage or funds. Tickets uses ordinary static calls, never delegatecall.
contract BoxTicketsV2Views {
    /// @notice Anyone computes a placeholder's item offset with the unchanged v1 permutation; no funds move.
    function permute(bytes32 word, uint256 position, uint256 n) external pure returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return BoxShuffle.permute(word, position, n, u, v);
    }

    /// @notice Anyone reads an item's pool position (or unassigned status) from a Tickets clone; no funds move.
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

    /// @notice Anyone reads placeholder metadata. Tickets checks token existence before calling; no funds move.
    function tokenURI(address tickets) external view returns (string memory) {
        address collection = IBoxTickets(tickets).collection();
        string memory name = IBoxTickets(tickets).name();
        (string memory description, bytes memory svg) = IBoxCollectionTextsV2(collection).placeholderTexts();
        bytes memory json = bytes(
            string.concat(
                '{"name":"',
                name,
                '","description":"',
                description,
                '","image":"data:image/svg+xml;base64,',
                BoxEncoding.base64(svg),
                '","attributes":[{"trait_type":"Status","value":"Placeholder"}]}'
            )
        );
        return string.concat("data:application/json;base64,", BoxEncoding.base64(json));
    }
    /// @notice Anyone reads the existing ticket phase; no storage or funds change.
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

    /// @notice Anyone checks numbered-take admission and reads its fallback time. Tickets keeps the deadline,
    /// payment, delivery and caller checks; this helper reads only the existing public views.
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
