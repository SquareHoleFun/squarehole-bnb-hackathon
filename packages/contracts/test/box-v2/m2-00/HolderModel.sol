// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {HolderLedgerLimitsV2 as Limits} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";

/// @dev Executable reference, NOT a deployable ledger/token or a PoolManager simulation.
/// Owner supplies authenticated upstream inputs; payout counters stand for successful real P transfers.
contract HolderModel {
    struct Point { uint256 at; uint256 balance; }
    struct Notice { uint256 at; uint256 supply; uint256 units; }
    struct Batch {
        uint256 user; uint256 protocol; uint256 funding; uint256 count;
        uint256 holderCursor; uint256 noticeCursor; uint256 units; uint256 allocated;
        bool closed;
        Notice[] notices;
    }
    address immutable owner = msg.sender;
    address immutable system;
    uint256 public checkpoint;
    uint256 public eligibleSupply;
    uint256 public callbackCount;
    mapping(address => uint256) public balances;
    mapping(address => Point[]) private history;
    address[] private holders;
    mapping(address => bool) private seen;
    mapping(uint256 => Batch) private batches;
    mapping(uint256 => mapping(address => uint256)) public credit;
    mapping(uint256 => uint256) public residue;
    mapping(uint256 => bool) public finalized;
    mapping(address => uint256) public paidTo;
    uint256 public depth;
    uint256 public fit;
    bool private paused;
    bool private failed;
    mapping(address => bool) private eligible;
    modifier upstream() { require(msg.sender == owner, "upstream"); _; }
    constructor(address excluded) { system = excluded; balances[excluded] = type(uint128).max; }
    function move(address from, address to, uint256 amount, bool callbackOK) external upstream {
        require(balances[from] >= amount, "balance");
        if (from == to || amount == 0) return;
        if (!seen[to] && to != system) eligible[to] = _wallet(to);
        if (eligible[from]) eligibleSupply -= amount;
        if (eligible[to]) eligibleSupply += amount;
        ++checkpoint;
        balances[from] -= amount; balances[to] += amount;
        _write(from); _write(to);
        if (callbackOK) ++callbackCount;
    }
    function _write(address who) private {
        if (who == system) return;
        if (!seen[who]) { seen[who] = true; holders.push(who); }
        history[who].push(Point(checkpoint, eligible[who] ? balances[who] : 0));
    }
    function _wallet(address who) private view returns (bool) {
        bytes memory code = who.code;
        return code.length == 0 || (code.length == 23 && bytes3(code) == hex"ef0100");
    }
    function register() external {
        require(msg.sender != system, "system");
        if (eligible[msg.sender]) return;
        eligible[msg.sender] = true; ++checkpoint; eligibleSupply += balances[msg.sender]; _write(msg.sender);
    }
    function balanceAt(address who, uint256 at) public view returns (uint256) {
        require(at <= checkpoint, "future");
        Point[] storage points = history[who];
        uint256 low; uint256 high = points.length;
        while (low < high) {
            uint256 mid = low + (high - low) / 2;
            if (points[mid].at <= at) low = mid + 1; else high = mid;
        }
        return low == 0 ? 0 : points[low - 1].balance;
    }
    function trade(uint256 id, uint256 units, bool protocol, bool noticeOK) external upstream {
        require(id != 0 && !batches[id].closed && !failed, "batch");
        Batch storage b = batches[id];
        if (protocol) { b.protocol += units; return; }
        b.user += units; // survives skipped notices
        if (noticeOK && units != 0) {
            b.notices.push(Notice(checkpoint, eligibleSupply, units)); b.count = holders.length;
        }
    }
    function close(uint256 id, uint256 funding) external upstream {
        Batch storage b = batches[id]; require(id != 0 && !b.closed, "closed");
        b.closed = true; b.funding = funding; // receiver's final BACKED amount, including zero
    }
    function settle(uint256 id, uint256 steps) external {
        Batch storage b = batches[id];
        require(b.closed && steps != 0 && steps <= Limits.MAX_SETTLE_STEPS, "page");
        if (finalized[id]) return;
        if (b.notices.length == 0) b.holderCursor = b.count;
        while (steps != 0 && b.holderCursor < b.count) {
            address who = holders[b.holderCursor]; Notice storage n = b.notices[b.noticeCursor];
            if (n.supply != 0) b.units += FullMath.mulDiv(n.units, balanceAt(who, n.at), n.supply);
            ++b.noticeCursor; --steps;
            if (b.noticeCursor == b.notices.length) {
                uint256 amount = FullMath.mulDiv(b.funding, b.units, b.user + b.protocol);
                credit[id][who] = amount; b.allocated += amount;
                b.units = 0; b.noticeCursor = 0; ++b.holderCursor;
            }
        }
        if (b.holderCursor == b.count) { finalized[id] = true; residue[id] = b.funding - b.allocated; }
    }
    function pause(bool value) external upstream { paused = value; }
    function fail() external upstream { failed = true; }
    function _take(uint256 id, address who) private returns (uint256 amount) {
        require(finalized[id] && !paused, "payout"); amount = credit[id][who]; require(amount != 0, "empty");
        credit[id][who] = 0;
    }
    function claim(uint256 id, address to) external returns (uint256 amount) {
        require(to != address(0), "recipient"); amount = _take(id, msg.sender); paidTo[to] += amount;
    }
    function flush(uint256 id) external returns (uint256 amount) {
        require(finalized[id], "unproved"); amount = residue[id]; residue[id] = 0;
        if (failed) fit += amount; else depth += amount;
    }
    function split(uint256 gross, uint256 reserve, uint256 actualTip)
        external pure returns (uint256, uint256, uint256, uint256, uint256)
    {
        uint256 net = gross - reserve - actualTip; uint256 unit = net / 15;
        return (2 * unit, unit, 2 * unit, 10 * unit, net % 15);
    }
}
