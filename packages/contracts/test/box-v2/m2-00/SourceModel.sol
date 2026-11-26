// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// @dev Reference receiver source allocator, with authenticated receipt/backing supplied by the test owner.
/// No balance-difference inference: receipt 1's shortage cannot touch receipt 2's backing or booked debt.
contract SourceModel {
    struct Source { uint256 netReceipt; uint256 backed; }
    mapping(uint256 => Source) private sources;
    address immutable owner = msg.sender;
    uint256 private next = 1;
    uint256 public fit;
    uint256 public platform;
    uint256 public depth;
    uint256 public pot;
    uint256 public debt;
    uint256 public balance;
    uint256 public tips;
    mapping(uint256 => uint256) public funding;
    mapping(uint256 => bool) public finalFunding;
    modifier upstream() { require(msg.sender == owner); _; }
    function receipt(uint256 id, uint256 gross, uint256 reserve, uint256 backed) external upstream {
        require(id >= next && reserve <= gross && backed <= gross - reserve, "receipt");
        sources[id].netReceipt += gross - reserve; sources[id].backed += backed; balance += backed;
    }
    function booked(uint256 amount) external upstream { debt += amount; balance += amount; }
    function allocate(uint256 id, uint256 actualTip, bool failed) external upstream {
        Source storage s = sources[id];
        require(id == next && actualTip <= s.backed / 20 && (id % 2 == 1 || actualTip == 0), "order/tip");
        ++next; finalFunding[id] = true;
        uint256 net = s.backed - actualTip; uint256 unit = net / 15;
        funding[id] = 10 * unit; fit += 2 * unit; platform += unit;
        if (failed) pot += 2 * unit; else depth += 2 * unit;
        if (failed) fit += net % 15; else depth += net % 15;
        tips += actualTip; balance -= actualTip + funding[id];
        s.backed = 0;
    }
    function royalty(uint256 amount, bool failed) external upstream {
        balance += amount;
        if (failed) { fit += amount; return; } // late P never obtains a trade id
        uint256 unit = amount / 15; fit += 2 * unit; platform += unit;
        depth += 12 * unit + amount % 15; // holder-choice and terminal carry have no holder entitlement
    }
}
