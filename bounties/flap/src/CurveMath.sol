// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title CurveMath: a constant-product price curve defined by one rounded function of the tokens sold
/// @notice The curve is the virtual pool (X0 BNB, Y0 tokens), K = X0 * Y0. The BNB that must be on the curve when
/// `s` tokens are sold is
///     R(s) = ceil(K / (Y0 - s)) - X0.
/// Every buy of n tokens costs exactly R(s + n) - R(s) and every sell of n returns exactly R(s) - R(s - n), so after
/// any sequence of buys and sells the curve holds exactly R(sold): the price path cannot be gamed by splitting or
/// reordering trades, and selling everything back always finds the BNB for it. R is non-decreasing (the ceiling of
/// a non-decreasing function), so no trade costs less than zero.
/// Creation fixes three numbers: the tokens for sale S, the BNB target T and the virtual BNB X0 (the start price is
/// X0 / Y0). Y0 is derived so that R(S) is T within rounding; the exact raise target is R(S).
/// At the target the pool opens at the curve's last marginal price (X0 + R(S)) / (Y0 - S) with R(S) BNB, so it gets
/// poolToken = (Y0 - S) * R(S) / (X0 + R(S)) tokens, and the supply is S + poolToken.
library CurveMath {
    /// @notice Y0 = (X0 + T) * S / T, rounded down.
    function virtualTokens(uint256 x0, uint256 target, uint256 saleTokens) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDiv(x0 + target, saleTokens, target);
    }

    /// @notice R(s): the BNB on the curve when `s` tokens are sold. Requires s < y0.
    function reserve(uint256 x0, uint256 y0, uint256 s) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDivUp(x0, y0, y0 - s) - x0;
    }

    /// @notice The most tokens whose cost R(s + n) - R(s) is at most `net`. Exact: with r' = R(s) + net,
    /// n = Y0 - s - ceil(K / (X0 + r')) gives ceil(K / (Y0 - s - n)) <= X0 + r', hence R(s + n) <= r'.
    function tokensForNet(uint256 x0, uint256 y0, uint256 s, uint256 net) internal pure returns (uint256) {
        uint256 r = reserve(x0, y0, s) + net;
        return y0 - s - FixedPointMathLib.fullMulDivUp(x0, y0, x0 + r);
    }

    /// @notice Tokens the pool gets at the target: (Y0 - S) * R(S) / (X0 + R(S)), rounded down.
    function poolToken(uint256 x0, uint256 y0, uint256 saleTokens, uint256 raise) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDiv(y0 - saleTokens, raise, x0 + raise);
    }

    /// @notice The marginal price at `s` sold, in BNB wei per whole token (1e18 units): K * 1e18 / (Y0 - s)^2.
    function price(uint256 x0, uint256 y0, uint256 s) internal pure returns (uint256) {
        uint256 left = y0 - s;
        return FixedPointMathLib.fullMulDiv(FixedPointMathLib.fullMulDiv(x0, y0, left), 1e18, left);
    }

    /// @notice ceil(amount * bps / 10_000): the unit of rounding goes to the fee (and so to the pile).
    function feeOf(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDivUp(amount, bps, 10_000);
    }
}
