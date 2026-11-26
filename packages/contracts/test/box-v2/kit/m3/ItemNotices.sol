// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IItemLedgerCalls} from "../../../../src/box-v2/interfaces/ILedgerCalls.sol";

/// @dev TEST ONLY vault-call driver. The frozen notices do NOT authenticate exact ticket identity.
contract ItemNotices {
    uint256 public constant ITEM_LEDGER_GAS = 1_000_000;
    uint256 public constant NOTICE_OVERHEAD = 10_000;
    uint256 public attempts;
    /// @notice Anyone driving a test may send a notice; no assets or actual vault state live here.
    function notify(address ledger, bytes calldata data) external returns (bool ok) {
        if (ledger == address(0)) return true;
        bytes memory payload = data;
        uint256 cap = ITEM_LEDGER_GAS;
        // Pay fixture storage costs before measuring headroom, including Amsterdam's fresh-slot cost.
        // A rejected floor rolls this write back. After a hostile call only the return remains.
        ++attempts;
        require(gasleft() >= cap + cap / 63 + NOTICE_OVERHEAD, "gas floor");
        // Drop returndata so a hostile callee cannot make the caller copy an unbounded buffer.
        assembly ("memory-safe") { ok := call(cap, ledger, 0, add(payload, 32), mload(payload), 0, 0) }
    }
}

/// @dev TEST ONLY hostile implementation of the unchanged notice interface.
contract NoticeProbe is IItemLedgerCalls {
    address public immutable vault;
    uint8 public mode;
    uint256 public calls;
    bytes4 public last;
    constructor(address v) { vault = v; }
    /// @notice Any test driver may configure pass (0), revert (1), or exhaust stipend (2).
    function setMode(uint8 m) external { require(m <= 2); mode = m; }
    /// @notice Vault only; no funds move. Each notice uses the same hostile switch.
    function onTicketsOpened(uint256, uint256) external { _notice(); }
    /// @notice Vault only; no funds move.
    function onTicketsReleased(address, uint256, uint256, uint256) external { _notice(); }
    /// @notice Vault only; no funds move.
    function onWithdrawn(address, uint256[] calldata) external { _notice(); }
    /// @notice Vault only; no funds move.
    function onReturned(address, uint256[] calldata) external { _notice(); }
    /// @notice Vault only; no funds move. requestedAt is deliberately not used as identity.
    function onDelivered(uint256, address, uint64) external { _notice(); }
    function _notice() private {
        require(msg.sender == vault, "vault");
        require(mode != 1, "refused");
        if (mode == 2) { assembly ("memory-safe") { for {} 1 {} {} } }
        ++calls; last = msg.sig;
    }
}
