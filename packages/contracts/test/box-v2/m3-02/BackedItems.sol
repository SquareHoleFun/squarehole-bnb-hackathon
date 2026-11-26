// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IBoxVaultV2, IBoxVaultItemsV2, ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverItemsV2, ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";

/// Test-only M3-23 substitute: already-net Keep money, real vault journal, native PM backing.
/// Does not implement production source allocation, fee splitting or receiver admission.
contract BackedItems is IBoxReceiverItemsV2 {
    address public immutable driver = msg.sender;
    IPoolManager public immutable pm;
    IBoxVaultV2 public immutable vault;
    address public ledger;
    uint256 public immutable n;
    uint8 public constant buyers = 1;
    uint8 public constant sellers = 0;
    uint256 public ledgerTransferred;
    ItemFundingV2[] private receipts;
    uint256 private pending;
    bool private publishing;

    constructor(IPoolManager manager, IBoxVaultV2 v) {
        pm = manager;
        vault = v;
        n = v.collectionSize();
    }

    /// Test driver fixes the recipient once, before the first funding record.
    function wire(address target) external {
        require(msg.sender == driver && ledger == address(0) && target != address(0), "driver/wired");
        ledger = target;
    }

    /// Test driver supplies exact native P, already net of the receiver's fees and source carry.
    function publish(uint8 source) external payable {
        require(msg.sender == driver && ledger != address(0), "driver/wiring");
        require(source == 2 || (source == 3 && receipts.length == 0), "source");
        require(!publishing, "reentry");
        publishing = true;
        pending = msg.value;
        if (msg.value != 0) pm.unlock("");
        pending = 0;
        ledgerTransferred += msg.value;
        receipts.push(
            ItemFundingV2(
                0,
                itemLifecycleCount(),
                msg.value,
                msg.value,
                uint32(vault.inside()),
                uint32(vault.hiddenCount()),
                1,
                source
            )
        );
        publishing = false;
    }

    /// Only the real PM during this driver's active publication settles and transfers exact backing.
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm) && publishing, "manager/active");
        uint256 amount = pending;
        require(pm.settle{value: amount}() == amount, "exact settlement");
        pm.mint(address(this), 0, amount);
        require(pm.transfer(ledger, 0, amount), "claims transfer");
        return "";
    }

    /// Anyone reads a committed receipt count; never substitutes for an unsupported production read.
    function itemFundingCount() external view returns (uint256) {
        return receipts.length;
    }

    /// Anyone reads a valid one-based receipt.
    function itemFunding(uint256 id) external view returns (ItemFundingV2 memory) {
        return receipts[id - 1];
    }

    /// Oracle facade reads the production vault journal, without copying or manufacturing operations.
    function itemLifecycleCount() public view returns (uint256) {
        return IBoxVaultItemsV2(address(vault)).itemLifecycleCount();
    }

    /// Oracle facade reads the production vault journal.
    function itemLifecycle(uint256 id) external view returns (ItemLifecycleV2 memory) {
        return IBoxVaultItemsV2(address(vault)).itemLifecycle(id);
    }

    /// Oracle facade maps vault ownership to its inside sentinel; actual collection owns the truth.
    function ownerOf(uint256 id) external view returns (address) {
        address owner = IBoxCollection(vault.collection()).ownerOf(id);
        return owner == address(vault) ? address(0) : owner;
    }
}
