// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Receiver allocation oracle. Source id is local provenance, NOT an item receipt or hook batch id.
/// Produces the choice amount; ItemHistoryModel applies custody/policy and transfer-backing to it afterwards.
contract ItemSourceModel {
    struct SourceAllocation { uint256 batchId; uint256 choiceP; uint8 side; uint8 source; }
    struct Source { uint256 available; uint256 carry; uint256 batch; uint8 side; uint8 kind; bool closed; }
    mapping(uint256 => Source) private sources;
    mapping(uint256 => uint256) public choice;
    SourceAllocation[] private receipts;
    address immutable driver = msg.sender;
    uint256 public next = 1;
    uint256 public received;
    uint256 public pending;
    uint256 public debt;
    uint256 public fit;
    uint256 public platform;
    uint256 public depth;
    uint256 public pot;
    uint256 public tips;
    uint256 public choiceTotal;
    bool public failed;
    modifier upstream() { require(msg.sender == driver,"upstream"); _; }
    /// @notice Driver alone adds unrelated debt that source allocation cannot spend.
    function bookDebt(uint256 p) external upstream { debt += p; }
    /// @notice Driver authenticates actual backing of this source after D6; a shortfall is never repaired after close.
    function receiveSource(uint256 id,uint8 side,uint8 kind,uint256 batch,uint256 gross,uint256 reserve,uint256 backed)
        external upstream
    {
        require(!failed,"phase");
        require(id >= next && reserve <= gross && backed <= gross-reserve,"source");
        require(side == 1 || side == 2,"side");
        require(kind == 1 ? batch != 0 && batch%2 == side%2 : kind == 2 && batch == 0,"kind/batch");
        Source storage s = sources[id];
        require(s.side == 0 || (s.side == side && s.kind == kind && s.batch == batch),"identity");
        s.side = side; s.kind = kind; s.batch = batch; s.available += backed; pending += backed; received += backed;
    }
    /// @notice Driver marks failure once, after supplying final close fees and D6 backing.
    /// Settle every pending source in order, forward its choice allocations to the still-held history,
    /// then fail that history and freeze the pot. Late receiver P bypasses this fee splitter and joins the pot.
    function enterFailure() external upstream { require(!failed,"phase"); failed = true; }
    /// @notice Driver supplies actual successful tip, zero on refusal, before final receipt; only buyers pay tips.
    /// After failure each allocation must close with no collect tip; choice P still belongs to held Items.
    function allocate(uint256 id,uint256 actualTip,bool close) external upstream {
        require(!failed || (close && actualTip == 0),"failure settlement");
        Source storage s = sources[id];
        require(id == next && s.side != 0 && !s.closed,"order");
        require(actualTip <= s.available/20 && (s.side == 1 || actualTip == 0),"tip");
        uint256 net = s.available+s.carry-actualTip; uint256 u = net/15;
        pending -= s.available+s.carry; s.available = 0; s.carry = net%15;
        fit += 2*u; platform += u; tips += actualTip;
        if (failed) pot += 2*u; else depth += 2*u;
        choice[id] += 10*u; choiceTotal += 10*u;
        // Counts and ledgerP are deliberately not asserted here: custody policy is a subsequent atomic stage.
        receipts.push(SourceAllocation(s.batch,10*u,s.side,s.kind));
        if (close) {
            if (failed) pot += s.carry; else depth += s.carry;
            s.carry = 0; s.closed = true; ++next;
        }
        else pending += s.carry;
    }
    /// @notice Anyone reads source-local carry; no funds move.
    function carry(uint256 id) external view returns (uint256) { return sources[id].carry; }
    /// @notice Anyone reads an intermediate allocation, not a published item funding receipt.
    function receipt(uint256 id) external view returns (SourceAllocation memory) { require(id != 0); return receipts[id-1]; }
    /// @notice Anyone reads conservation including unrelated debt and pending allocations.
    function accounted() external view returns (uint256) { return debt+pending+fit+platform+depth+pot+tips+choiceTotal; }
}
