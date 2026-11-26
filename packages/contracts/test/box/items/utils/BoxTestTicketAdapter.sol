// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";

/// @notice TEST ONLY. A copy of test/v2/utils/TestTicketAdapter.sol for BoxVault (renamed errors and types). A stand-in
/// for the vault's ticket adapter (`BoxTickets` in production): it opens,
/// releases and delivers tickets for whoever it is told, with no randomness, no placeholder token and no phase rules.
/// It exercises the vault's ticket plumbing (who may call, who pays, who receives, the fees) and lets the T07 tests
/// and the trace replay take a Misfit "by ID" in one atomic call: `draw` = open k tickets paid by `payer` (pulled here
/// first, so the vault only ever spends this contract's FIT) and deliver the listed IDs to `payer`.
///
/// Labels (trace replay): the reference ledger names the IDs a take reserves (the lowest unreserved hidden IDs); this
/// adapter records who holds each label, checks every label is hidden in the vault, and releases and delivers by label.
contract BoxTestTicketAdapter {
    error Bound();
    error NotTicketHolder(uint256 id);
    error LabelNotHidden(uint256 id);
    error LabelTaken(uint256 id);
    error LabelCountMismatch(uint256 labels, uint256 count);

    BoxVault public vault;
    IBoxToken public fit;
    /// @notice Unlabelled tickets per holder (T07 tests).
    mapping(address => uint256) public ticketsOf;
    /// @notice Labelled tickets: reserved ID → holder (trace replay).
    mapping(uint256 => address) public holderOf;
    mapping(address => uint256) public labelsOf;

    /// TEST ONLY: the vault is created after this adapter (it needs the adapter's address first).
    function bind(BoxVault vault_) external {
        if (address(vault) != address(0)) revert Bound();
        vault = vault_;
        fit = IBoxToken(vault_.token());
        fit.approve(address(vault_), type(uint256).max);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Unlabelled (T07 tests)

    /// @notice Opens `count` tickets paid by `payer` (who approved this adapter for FIT).
    function take(address payer, uint256 count, uint256 maxFitIn) public returns (uint256 principal, uint256 fee) {
        (uint256 p, uint256 f) = vault.quoteTake(count);
        if (p + f > maxFitIn) revert IBoxVault.MaxTokenExceeded(p + f, maxFitIn);
        fit.transferFrom(payer, address(this), p + f);
        (principal, fee) = vault.openTickets(count, maxFitIn);
        ticketsOf[payer] += count;
    }

    /// @notice Releases `count` of `holder`'s tickets; `to` receives principal − fee.
    function release(address holder, uint256 count, address to, uint256 minFitOut)
        external
        returns (uint256 principal, uint256 fee)
    {
        ticketsOf[holder] -= count;
        (principal, fee) = vault.releaseTickets(count, to, minFitOut);
    }

    /// @notice Delivers hidden Misfit `id` to `to` for one of `holder`'s tickets.
    function deliver(address holder, uint256 id, address to) public {
        ticketsOf[holder] -= 1;
        vault.deliverTicket(id, to);
    }

    /// @notice The old `adapterWithdraw` in one call: tickets for `ids.length`, then each ID delivered to `payer`.
    /// The deadline is this adapter's own check (the vault's ticket functions take none).
    function draw(address payer, uint256[] calldata ids, uint256 maxFitIn, uint256 deadline)
        external
        returns (uint256 principal)
    {
        if (block.timestamp > deadline) revert IBoxVault.DeadlineExpired(deadline, block.timestamp);
        (principal,) = take(payer, ids.length, maxFitIn);
        for (uint256 i; i < ids.length; ++i) {
            deliver(payer, ids[i], payer);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Labelled (trace replay)

    function takeLabelled(address payer, uint256 count, uint256 maxFitIn, uint256[] calldata labels)
        external
        returns (uint256 principal, uint256 fee)
    {
        (uint256 p, uint256 f) = vault.quoteTake(count);
        if (p + f > maxFitIn) revert IBoxVault.MaxTokenExceeded(p + f, maxFitIn);
        fit.transferFrom(payer, address(this), p + f);
        (principal, fee) = vault.openTickets(count, maxFitIn);
        if (labels.length != count) revert LabelCountMismatch(labels.length, count);
        for (uint256 i; i < labels.length; ++i) {
            uint256 id = labels[i];
            if (!vault.isHidden(id)) revert LabelNotHidden(id);
            if (holderOf[id] != address(0)) revert LabelTaken(id);
            holderOf[id] = payer;
        }
        labelsOf[payer] += count;
    }

    function releaseLabelled(address holder, uint256[] calldata ids, uint256 minFitOut)
        external
        returns (uint256 principal, uint256 fee)
    {
        _checkLabels(holder, ids);
        for (uint256 i; i < ids.length; ++i) {
            delete holderOf[ids[i]];
        }
        labelsOf[holder] -= ids.length;
        (principal, fee) = vault.releaseTickets(ids.length, holder, minFitOut);
    }

    function deliverLabelled(address holder, uint256[] calldata ids) external {
        _checkLabels(holder, ids);
        for (uint256 i; i < ids.length; ++i) {
            delete holderOf[ids[i]];
        }
        labelsOf[holder] -= ids.length;
        for (uint256 i; i < ids.length; ++i) {
            vault.deliverTicket(ids[i], holder);
        }
    }

    function transferLabel(address from, address to, uint256 id) external {
        if (holderOf[id] != from || from == address(0)) revert NotTicketHolder(id);
        holderOf[id] = to;
        labelsOf[from] -= 1;
        labelsOf[to] += 1;
    }

    /// @dev Non-empty, distinct (O(k), a transient set cleared again), all held by `holder` (the vault's own refusal
    /// names, as the reference codes them).
    function _checkLabels(address holder, uint256[] calldata ids) private {
        if (ids.length == 0) revert IBoxVault.InvalidIdList();
        for (uint256 i; i < ids.length; ++i) {
            bytes32 slot = keccak256(abi.encode("test.ticket.adapter.seen", ids[i]));
            uint256 seen;
            assembly ("memory-safe") {
                seen := tload(slot)
                tstore(slot, 1)
            }
            if (seen != 0) revert IBoxVault.InvalidIdList();
        }
        for (uint256 i; i < ids.length; ++i) {
            bytes32 slot = keccak256(abi.encode("test.ticket.adapter.seen", ids[i]));
            assembly ("memory-safe") {
                tstore(slot, 0)
            }
        }
        for (uint256 i; i < ids.length; ++i) {
            if (holderOf[ids[i]] != holder || holder == address(0)) revert NotTicketHolder(ids[i]);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
