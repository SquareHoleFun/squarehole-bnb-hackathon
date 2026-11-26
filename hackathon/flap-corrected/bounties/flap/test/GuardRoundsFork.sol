// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PileForkBase, IERC20F} from "./PileForkBase.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PairPriceGuard} from "fee-rules/PairPriceGuard.sol";

interface IV2PairG {
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IV2RouterFactoryG {
    function factory() external view returns (address);
}

interface IV2FactoryG {
    function getPair(address, address) external view returns (address);
}

/// @notice The test-network fork suites' share-out under the swap guard as Flap's pre-audit wrote it (SH-308 R2,
/// bounties/core/src/PairPriceGuard): a buy is at most 5 bps of the pair's quote reserve read in the call, with a nonzero
/// minimum from those reserves, and at most one buy per minute. The first share-out after the pool exists buys at once,
/// exactly min(owed, 5 bps of the quote reserve); the rest stays owed; share-outs 61 seconds apart buy the next slices
/// until nothing is owed. What the old single share-out proved ("the whole burn part is bought and burned") now holds
/// over those rounds, each round exact.
abstract contract GuardRoundsFork is PileForkBase {
    /// @dev The pair of `token` and the splitter's quote (WBNB for the native coin) on ROUTER's factory, oriented.
    function _guardReserves(RulesVault s) internal view returns (uint256 rq, uint256 rt) {
        address quote = s.asset() == address(0) ? WBNB : s.asset();
        address token = s.token();
        address pair = IV2FactoryG(IV2RouterFactoryG(ROUTER).factory()).getPair(quote, token);
        (uint112 r0, uint112 r1,) = IV2PairG(pair).getReserves();
        (rq, rt) = token < quote ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
    }

    /// @dev The part of `income` distribute() assigns rule `i` of `bps` (the last rule takes the remainder).
    function _assigned(RulesVault s, uint256 income, uint256 i) internal view returns (uint256 part) {
        uint256 n = s.ruleCount();
        uint256 assigned;
        for (uint256 j; j <= i; ++j) {
            (, uint16 bps,) = s.rule(j);
            part = j == n - 1 ? income - assigned : income / 10_000 * bps + income % 10_000 * bps / 10_000;
            assigned += part;
        }
    }

    /// @dev The first share-out since the pool exists buys at once: exactly min(burn part, 5 bps of the quote reserve).
    /// Returns rule `burnIdx`'s whole part and what this round bought and burned. The caller checks the other rules around it.
    function _firstShareOut(RulesVault s, uint256 burnIdx)
        internal
        returns (uint256 burnPart, uint256 bought, uint256 burnt)
    {
        burnPart = s.owed(burnIdx) + _assigned(s, s.pending(), burnIdx);
        (bought, burnt) = _oneBuyRound(s, burnIdx);
        assertGt(bought, 0, "the first share-out buys at once");
    }

    /// @dev Share-outs 61 seconds apart, each buying exactly min(owed, 5 bps of the quote reserve), until nothing is
    /// owed (at most `maxRounds`). Returns what was bought and burned over the rounds.
    function _buyRoundsUntilBurnt(RulesVault s, uint256 burnIdx, uint256 maxRounds)
        internal
        returns (uint256 bought, uint256 burnt, uint256 rounds)
    {
        while (s.owed(burnIdx) != 0 && rounds < maxRounds) {
            vm.warp(block.timestamp + PairPriceGuard.MIN_GAP + 1);
            (uint256 b, uint256 got) = _oneBuyRound(s, burnIdx);
            bought += b;
            burnt += got;
            ++rounds;
        }
        assertEq(s.owed(burnIdx), 0, "the whole burn part bought and burned over the rounds");
        emit log_named_uint("buy-and-burn rounds, 61 s apart", rounds);
        emit log_named_uint("bought over the rounds", bought);
        emit log_named_uint("burned over the rounds", burnt);
    }

    /// @dev One share-out that buys: exactly min(owed, 5 bps of the quote reserve), the rest owed, at least the guard's
    /// minimum at DEAD.
    function _oneBuyRound(RulesVault s, uint256 burnIdx) internal returns (uint256 expect, uint256 got) {
        uint256 owedBurn = s.owed(burnIdx) + _assigned(s, s.pending(), burnIdx);
        (uint256 rq, uint256 rt) = _guardReserves(s);
        uint256 cap = rq * PairPriceGuard.CAP_BPS / 10_000;
        expect = owedBurn < cap ? owedBurn : cap;
        uint256 d0 = s.delivered(burnIdx);
        uint256 dead0 = IERC20F(s.token()).balanceOf(DEAD);
        s.distribute();
        got = IERC20F(s.token()).balanceOf(DEAD) - dead0;
        assertEq(s.delivered(burnIdx) - d0, expect, "each round buys exactly min(owed, 5 bps of the quote reserve)");
        assertEq(s.owed(burnIdx), owedBurn - expect, "the rest stays owed");
        assertGe(got, PairPriceGuard.minimumOut(expect, rq, rt), "at least the guard's minimum arrived");
        assertGt(got, 0);
    }
}
