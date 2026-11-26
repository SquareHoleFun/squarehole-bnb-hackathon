// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PairPriceGuard: a capped, paced buy of a token on its PancakeSwap V2 (Uniswap V2) pair
/// @notice One library for the two buys anyone can trigger (the RuleSplitter's buy-and-burn and the RailShop's refill),
/// answering Flap's pre-audit finding R2 ("two swaps can be sandwiched") with the fix it suggests. Each buyer keeps one
/// `State`, the time of its last buy.
/// What it does: a buy is at most `CAP_BPS` (5 bps) of the pair's quote reserve as read in that call; it passes the
/// router a nonzero minimum output computed from the pair's reserves for that amount, less room for the token's buy tax
/// (10%), the pool fee and 1% slippage; and a buyer buys at most once per `MIN_GAP` (60) seconds, counted from its last
/// buy that spent (a failed swap, a refused slice or a call too soon records nothing).
/// What it does NOT stop: a trade placed earlier in the same transaction, or by the block's producer just before, moves
/// the reserves that the cap and the minimum are read from, so against such a trade the cap and the minimum protect
/// nothing. Measured (bounties/core/proof/sandwich-break-even.py, a 0.25% pool, front-runs from 10^-6 to 1000 times the
/// pool): against a buy whose size was fixed before the trade, up to 25 bps of the reserve, no size searched gains
/// anything; with the cap read after an earlier trade of 1000 times the pool, such a trade takes about 99% of a buy. A reference that such a trade cannot move (the pair's
/// time-weighted price) is the planned next step and is not in this version.
/// @dev Every read is a low-level static call whose answer is checked: a missing pair, a failed or short read, empty
/// reserves or a slice that would buy nothing never revert here; they answer `Wait.NO_POOL` and the caller decides
/// (the splitter keeps its part owed, the shop reverts its refill).
library PairPriceGuard {
    /// @notice The largest buy, in bps of the pair's quote reserve read in the same call. The case we measured is a
    /// splitter and three shops of the same token in one transaction: 4 x 5 = 20 bps, under the 25 bps below which a
    /// sandwich of a buy whose size was fixed before the front-run gains nothing for the sizes searched, on a 0.25% pool
    /// with no tax (bounties/core/proof/sandwich-break-even.py). It is not a ceiling: the factory lets any number of
    /// shops exist for one token, and each buy reads its own reserve.
    uint256 internal constant CAP_BPS = 5;
    /// @notice At least this many seconds between two buys of one buyer (time, not blocks: a validator can produce a run
    /// of consecutive blocks, several in one second).
    uint256 internal constant MIN_GAP = 60;
    /// @notice Room in the minimum for the token's own buy tax: 10% is Flap's highest tax rate (our launch factories
    /// refuse more), taken from what the pair sends, so at most 10% less than the pair's output arrives. With the fee
    /// and slippage rooms the cut-off is about 11% (rounding at outputs of a few base units lets a little more pass).
    uint256 internal constant MAX_BUY_TAX_BPS = 1_000;
    /// @notice Room in the minimum for the pool's fee: 0.25% on PancakeSwap V2, 0.3% on Uniswap V2; the larger.
    uint256 internal constant POOL_FEE_ROOM_BPS = 30;
    /// @notice The capped slippage: price movement allowed on top of the buy's own price impact (which the minimum
    /// already includes, as it is computed for the capped amount on the constant product).
    uint256 internal constant SLIPPAGE_BPS = 100;

    enum Wait {
        NONE, // buy now: `amountIn` with at least `minOut` arriving
        NO_POOL, // no pair, a failed or short read, empty reserves, or a slice too small to buy anything
        TOO_SOON // the last buy of this buyer was less than MIN_GAP seconds ago
    }

    /// @dev One buyer's memory, one storage slot: the time of its last buy that spent (0: none yet).
    struct State {
        uint64 lastBuyAt;
    }

    /// @dev A pair as read in this call: its address and the reserves oriented (quote, token).
    struct Pool {
        address pair;
        uint256 quoteReserve;
        uint256 tokenReserve;
    }

    bytes4 private constant FACTORY = 0xc45a0155; // factory()
    bytes4 private constant GET_PAIR = 0xe6a43905; // getPair(address,address)
    bytes4 private constant GET_RESERVES = 0x0902f1ac; // getReserves()

    /// @notice What a buyer of `token` with `quote` (WBNB for the native coin) on `router`'s pair may buy now, with
    /// `amount` waiting: the amount (at most the cap) and the minimum output to pass the router. Changes nothing.
    function plan(State storage s, address router, address quote, address token, uint256 amount)
        internal
        view
        returns (Wait wait, uint256 amountIn, uint256 minOut)
    {
        if (s.lastBuyAt != 0 && block.timestamp < uint256(s.lastBuyAt) + MIN_GAP) return (Wait.TOO_SOON, 0, 0);
        (bool ok, Pool memory p) = readPair(router, quote, token);
        if (!ok) return (Wait.NO_POOL, 0, 0);
        uint256 cap = p.quoteReserve * CAP_BPS / 10_000;
        amountIn = amount < cap ? amount : cap;
        minOut = minimumOut(amountIn, p.quoteReserve, p.tokenReserve);
        if (amountIn == 0 || minOut == 0) return (Wait.NO_POOL, 0, 0);
    }

    /// @notice Records a buy that spent: the next one waits MIN_GAP seconds. Called only after a successful buy.
    function markBought(State storage s) internal {
        s.lastBuyAt = uint64(block.timestamp);
    }

    /// @notice The constant-product output for `amountIn` against these reserves (no fee), less the tax, fee and
    /// slippage rooms: 88.7% of it. Reserves are at most 2^112 and `amountIn` at most the cap: no overflow.
    function minimumOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 out = amountIn * reserveOut / (reserveIn + amountIn);
        return out * (10_000 - MAX_BUY_TAX_BPS - POOL_FEE_ROOM_BPS - SLIPPAGE_BPS) / 10_000;
    }

    /// @notice The pair of `quote` and `token` on `router`'s factory and its reserves, oriented: `ok` is false when the
    /// router or factory does not answer one address word, there is no pair, or either reserve is empty. A V2 factory
    /// sorts a pair's tokens by address, so the token is token0 exactly when its address is the lower one.
    function readPair(address router, address quote, address token) internal view returns (bool ok, Pool memory p) {
        address factory = _addressAnswer(router, abi.encodeWithSelector(FACTORY));
        if (factory == address(0)) return (false, p);
        p.pair = _addressAnswer(factory, abi.encodeWithSelector(GET_PAIR, quote, token));
        if (p.pair == address(0)) return (false, p);
        (bool callOk, bytes memory ret) = p.pair.staticcall(abi.encodeWithSelector(GET_RESERVES));
        if (!callOk || ret.length < 96) return (false, p);
        (uint256 r0, uint256 r1, uint256 t) = abi.decode(ret, (uint256, uint256, uint256));
        if (r0 == 0 || r1 == 0 || r0 > type(uint112).max || r1 > type(uint112).max || t > type(uint32).max) {
            return (false, p);
        }
        (p.quoteReserve, p.tokenReserve) = token < quote ? (r1, r0) : (r0, r1);
        return (true, p);
    }

    /// @dev One address word from a static call, or zero for any other answer (a failure, a short answer, high bits).
    function _addressAnswer(address target, bytes memory data) private view returns (address) {
        if (target.code.length == 0) return address(0);
        (bool callOk, bytes memory ret) = target.staticcall(data);
        if (!callOk || ret.length < 32) return address(0);
        uint256 word = abi.decode(ret, (uint256));
        return word > type(uint160).max ? address(0) : address(uint160(word));
    }
}
