// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ItemModel} from "../../m3-00/ItemModel.sol";
import {ItemHistoryModel} from "../../m3-00/ItemHistoryModel.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";

/// @dev Compare canonical NFT ids and exact ticket keys against M3-00's anonymous-slot reference.
library ItemKit {
    enum Domain { Draw, Placeholder }
    error ItemMismatch(uint256 id);
    error TicketMismatch(bytes32 key);
    error CursorMismatch();
    error Conservation();
    function key(Domain domain, uint256 id) internal pure returns (bytes32) { return keccak256(abi.encode(domain, id)); }
    function compare(ItemModel model, IItemLedgerV2 actual, uint256 firstId, uint256 n, bytes32[] memory keys)
        internal view
    {
        if (model.accounted() != model.history().ledgerTransferred()) revert Conservation();
        if (actual.fundingCursor() != model.fundingCursor() || actual.lifecycleCursor() != model.lifecycleCursor())
            revert CursorMismatch();
        for (uint256 i; i < n; ++i) {
            uint256 id = firstId + i;
            (uint256 c, uint256 s) = model.itemCredit(id);
            (uint256 ac, uint256 ast) = actual.itemCredit(id);
            if (c != ac || s != ast) revert ItemMismatch(id);
        }
        for (uint256 i; i < keys.length; ++i) {
            (uint256 start, uint256 c, bool open) = model.ticketCredit(keys[i]);
            (uint256 astart, uint256 ac, bool aopen) = actual.ticketCredit(keys[i]);
            if (start != astart || c != ac || open != aopen) revert TicketMismatch(keys[i]);
        }
    }
}
