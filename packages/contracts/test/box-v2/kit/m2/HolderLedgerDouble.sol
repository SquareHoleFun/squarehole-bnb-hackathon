// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IHolderLedgerV2, HolderLedgerLimitsV2 as H} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {TradeBatchV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {LedgerTokenMock} from "./LedgerTokenMock.sol";
import {BatchDriver, NetFundingMock} from "./BatchDriver.sol";

/// @dev TEST ONLY independently computed accounting/custody double, NOT the future M2-30 production ledger.
/// Constructor wiring substitutes for clones. F127: only the holder claims; no minimum or tip.
/// Consumers may replace this double with IHolderLedgerV2 production code while retaining the driver/oracles.
contract HolderLedgerDouble is IHolderLedgerV2 {
    struct Notice { uint256 checkpoint; uint256 supply; uint256 units; }
    struct Batch {
        Notice[] notices; uint256 count; uint256 holder; uint256 notice; uint256 units;
        uint256 allocated; uint256 residue; bool complete;
    }
    LedgerTokenMock public immutable token;
    BatchDriver public immutable hook;
    NetFundingMock public immutable receiver;
    IPoolManager public immutable pm;
    Currency private immutable p;
    uint256 public hints;
    bool private locked;
    mapping(uint256 => Batch) private batches;
    mapping(uint256 => mapping(address => uint256)) private credit;
    modifier lock() { require(!locked, "locked"); locked = true; _; locked = false; }
    constructor(LedgerTokenMock t, BatchDriver h, NetFundingMock r, IPoolManager manager, address price) {
        token = t; hook = h; receiver = r; pm = manager; p = Currency.wrap(price);
    }
    function register() external { token.registerHolder(msg.sender); }
    function onTokenCheckpoint(uint256, address, address) external {
        if (msg.sender != address(token)) revert Unauthorized(msg.sender); ++hints;
    }
    function onTradeFeeBatch(uint256 id, address, bool buy, uint256 units) external {
        if (msg.sender != address(hook)) revert Unauthorized(msg.sender);
        require(id == hook.currentTradeBatch(buy) && units != 0, "active batch");
        uint256 cp = token.holderCheckpoint();
        batches[id].notices.push(Notice(cp, token.eligibleSupplyAt(cp), units));
        batches[id].count = token.holderCount();
    }
    function settleBatch(uint256 id, uint256 steps) external returns (bool) {
        if (steps == 0 || steps > H.MAX_SETTLE_STEPS) revert InvalidRequest();
        TradeBatchV2 memory receipt = hook.tradeBatch(id);
        if (!receipt.closed || !receiver.holderBatchClosed(id)) revert BatchNotReady(id);
        Batch storage b = batches[id]; if (b.complete) return true;
        uint256 funded = receiver.holderBatchPaid(id);
        while (steps != 0 && b.holder < b.count) {
            address who = token.holderAt(b.holder); Notice storage n = b.notices[b.notice];
            if (n.supply != 0) b.units += FullMath.mulDiv(n.units, token.eligibleBalanceAt(who, n.checkpoint), n.supply);
            ++b.notice; --steps;
            if (b.notice == b.notices.length) {
                uint256 amount = FullMath.mulDiv(funded, b.units, receipt.tradeUnits + receipt.protocolUnits);
                credit[id][who] = amount; b.allocated += amount; b.units = 0; b.notice = 0; ++b.holder;
            }
        }
        if (b.holder == b.count) { b.complete = true; b.residue = funded - b.allocated; emit BatchSettled(id, funded, b.allocated, b.residue); }
        return b.complete;
    }
    function claimable(uint256 id, address who) public view returns (uint256) { return batches[id].complete ? credit[id][who] : 0; }
    function batchState(uint256 id) external view returns (bool, uint256, uint256, uint256) {
        Batch storage b = batches[id]; return (b.complete, b.holder, b.notice, b.residue);
    }
    function _take(uint256 id, address who) private returns (uint256 amount) {
        if (!batches[id].complete) revert BatchNotReady(id);
        amount = credit[id][who]; if (amount == 0) revert InvalidRequest(); credit[id][who] = 0;
    }
    function _pay(address to, uint256 amount) private {
        if (to == address(0)) revert InvalidRequest();
        if (amount != 0) pm.unlock(abi.encode(to, amount));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm"); (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.burn(address(this), p.toId(), amount); pm.take(p, to, amount); return "";
    }
    function claim(uint256 id, address to) external lock returns (uint256 amount) {
        amount = _take(id, msg.sender); _pay(to, amount); emit HolderPaid(id, msg.sender, to, amount, 0);
    }
    function flushResidue(uint256 id) external lock returns (uint256 amount) {
        if (!batches[id].complete) revert BatchNotReady(id);
        amount = batches[id].residue; batches[id].residue = 0;
        address to = receiver.failed() ? address(receiver) : address(hook);
        require(pm.transfer(to, p.toId(), amount)); emit ResidueFlushed(id, to, amount);
    }
}
