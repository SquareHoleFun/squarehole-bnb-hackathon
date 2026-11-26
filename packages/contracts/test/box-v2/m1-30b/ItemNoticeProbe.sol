// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IItemLedgerCalls} from "../../../src/box-v2/interfaces/ILedgerCalls.sol";
/// Isolated item-notice adversary; CQ11 removed the old fee-ledger callbacks.
contract MockLedger is IItemLedgerCalls {
    enum Mode { HEALTHY, REVERTS, BURNS_GAS }
    Mode public mode;
    mapping(bytes4 => uint256) public calls;
    constructor(IPoolManager) {}
    function setMode(Mode m) external { mode = m; }
    function _note() private {
        require(mode != Mode.REVERTS, "notice refused");
        if (mode == Mode.BURNS_GAS) { assembly { invalid() } }
        ++calls[msg.sig];
    }
    function onTicketsOpened(uint256, uint256) external { _note(); }
    function onTicketsReleased(address, uint256, uint256, uint256) external { _note(); }
    function onWithdrawn(address, uint256[] calldata) external { _note(); }
    function onReturned(address, uint256[] calldata) external { _note(); }
    function onDelivered(uint256, address, uint64) external { _note(); }
}
