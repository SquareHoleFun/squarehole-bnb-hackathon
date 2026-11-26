// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @notice Internal receiver accounting only; no external calls, transfers or authority of its own.
library RewardAccountingV21 {
    struct Point { uint256 p; uint256 t; }
    struct Range { uint256 start; uint256 end; }
    struct State {
        uint256[3] pending; // holders, buyers items, sellers items, all P
        uint256 fundedP;
        uint256 consumedP;
        uint256 boughtT;
        mapping(uint256 => Range) batches;
        Point[] purchases;
        uint256 next;
        uint256 burnClaims;
    }
    /// @notice Locked receiver allocator reserves one historical batch's P interval; no funds move.
    function fund(State storage s, uint256 id, uint256 p) public {
        s.batches[id] = Range(s.fundedP, s.fundedP + p);
        s.fundedP += p;
        s.pending[0] += p;
    }
    /// @notice Locked receiver records a successful purchase (or a zero-T failure/deficit exit).
    function consume(State storage s, uint256 p, uint256 t) public {
        if (p == 0) return;
        s.consumedP += p;
        s.boughtT += t;
        s.purchases.push(Point(s.consumedP, s.boughtT));
    }
    /// @notice Internal view: cumulative bought T is available even before all P is consumed.
    /// @dev The funded prefix only grows; adjacent floor differences assign every bought T exactly once.
    /// Closed means no further funding can arrive, not a prerequisite for settling the purchased prefix.
    function funding(State storage s, uint256 id) public view returns (bool closed, uint256 t) {
        Range storage r = s.batches[id];
        closed = r.end <= s.consumedP || r.start == r.end;
        uint256 end = r.end < s.consumedP ? r.end : s.consumedP;
        if (end > r.start) t = at(s, end) - at(s, r.start);
    }
    function at(State storage s, uint256 p) private view returns (uint256) {
        if (p == 0) return 0;
        uint256 lo;
        uint256 hi = s.purchases.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (s.purchases[mid].p < p) lo = mid + 1; else hi = mid;
        }
        Point storage end = s.purchases[lo];
        Point memory start = lo == 0 ? Point(0, 0) : s.purchases[lo - 1];
        return start.t + FullMath.mulDiv(p - start.p, end.t - start.t, end.p - start.p);
    }
    /// @notice Internal view totals P debt; never includes bought T or any other asset.
    function total(State storage s) internal view returns (uint256) {
        return s.pending[0] + s.pending[1] + s.pending[2];
    }
}
