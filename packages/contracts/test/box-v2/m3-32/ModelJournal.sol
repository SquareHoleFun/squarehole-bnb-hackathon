// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxVaultV2, IBoxVaultItemsV2, ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverItemsV2, ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";

interface M332Owner { function ownerOf(uint256 id) external view returns (address); }

/// Test-only view adapter: forwards the real immutable journals to the unmodified small-N oracle.
/// Its only translation is the collection's firstId into the oracle's 1..N numbering.
contract M332ModelJournal {
    IBoxVaultV2 public immutable vault;
    IBoxReceiverItemsV2 public immutable receiver;
    uint256 public immutable n;
    uint256 public immutable firstId;
    uint8 public immutable buyers;
    uint8 public immutable sellers;

    constructor(address v, address r, address ledger) {
        vault = IBoxVaultV2(v);
        receiver = IBoxReceiverItemsV2(r);
        n = vault.collectionSize();
        firstId = vault.firstId();
        (buyers, sellers) = IItemLedgerV2(ledger).insidePolicies();
    }

    function itemLifecycleCount() external view returns (uint256) {
        return IBoxVaultItemsV2(address(vault)).itemLifecycleCount();
    }
    function itemLifecycle(uint256 seq) external view returns (ItemLifecycleV2 memory op) {
        op = IBoxVaultItemsV2(address(vault)).itemLifecycle(seq);
        if (op.kind == 2 || op.kind == 4 || op.kind == 5 || op.kind == 6) op.itemId = op.itemId - firstId + 1;
    }
    function itemFundingCount() external view returns (uint256) { return receiver.itemFundingCount(); }
    function itemFunding(uint256 id) external view returns (ItemFundingV2 memory) { return receiver.itemFunding(id); }
    function ownerOf(uint256 id) external view returns (address) {
        return M332Owner(vault.collection()).ownerOf(firstId + id - 1);
    }
    function ledgerTransferred() external view returns (uint256 total) {
        for (uint256 i = 1; i <= receiver.itemFundingCount(); ++i) total += receiver.itemFunding(i).ledgerP;
    }
}
