// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PricingToken} from "../../../src/box-v2/libraries/PricingToken.sol";
import {SwapMath} from "v4-core/src/libraries/SwapMath.sol";

/// Offline doubles use constant-product v2 and concentrated v3 arithmetic; no network dependency.
contract AlchemistV2Pool {
    address public immutable token0;
    address public immutable token1;
    uint112 private r0;
    uint112 private r1;
    uint8 public mode;
    constructor(address a, address b) { (token0, token1) = a < b ? (a,b) : (b,a); }
    function setMode(uint8 m) external { mode = m; }
    function sync() external { _sync(); }
    function skim(address to) external {
        uint256 extra0 = PricingToken.balanceOf(token0, address(this)) - r0;
        uint256 extra1 = PricingToken.balanceOf(token1, address(this)) - r1;
        if (extra0 != 0) PricingToken.sendExact(token0, to, extra0);
        if (extra1 != 0) PricingToken.sendExact(token1, to, extra1);
    }
    function _sync() private {
        r0 = uint112(PricingToken.balanceOf(token0, address(this)));
        r1 = uint112(PricingToken.balanceOf(token1, address(this)));
    }
    function getReserves() external view returns (uint112,uint112,uint32) { return (r0,r1,0); }
    function swap(uint256 a0, uint256 a1, address to, bytes calldata) external {
        require(mode != 1, "refused");
        if (mode == 2) { assembly ("memory-safe") { for {} 1 {} {} } }
        uint256 b0 = PricingToken.balanceOf(token0,address(this));
        uint256 b1 = PricingToken.balanceOf(token1,address(this));
        uint256 input = a0 > 0 ? b1 - r1 : b0 - r0;
        uint256 expected = input * 997 * (a0 > 0 ? r0 : r1) / ((a0 > 0 ? r1 : r0) * 1000 + input * 997);
        require(a0 + a1 == expected && input > 0, "constant product");
        uint256 out = mode == 3 ? expected - 1 : expected;
        PricingToken.sendExact(a0 > 0 ? token0 : token1, to, out);
        _sync();
    }
}
interface V3Callback { function uniswapV3SwapCallback(int256,int256,bytes calldata) external; }
contract AlchemistV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 3000;
    int24 public constant tickSpacing = 60;
    uint160 public spot = 1 << 96;
    uint128 public liquidity = 1e24;
    uint8 public mode;
    constructor(address a, address b) { (token0, token1) = a < b ? (a,b) : (b,a); }
    function setMode(uint8 m) external { mode = m; }
    function setLiquidity(uint128 l) external { liquidity = l; }
    function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool) { return (spot,0,0,0,0,0,true); }
    function swap(address to, bool zero, int256 amount, uint160 limit, bytes calldata data) external returns (int256 a0, int256 a1) {
        require(mode != 1, "refused");
        (uint160 next, uint256 input, uint256 output, uint256 paidFee) = SwapMath.computeSwapStep(spot, limit, liquidity, -amount, fee);
        uint256 owed = input + paidFee;
        a0 = zero ? int256(owed) : -int256(output);
        a1 = zero ? -int256(output) : int256(owed);
        uint256 beforeIn = PricingToken.balanceOf(zero ? token0 : token1,address(this));
        PricingToken.sendExact(zero ? token1 : token0,to,output);
        V3Callback(msg.sender).uniswapV3SwapCallback(a0,a1,data);
        require(PricingToken.balanceOf(zero ? token0 : token1,address(this)) == beforeIn + owed, "callback payment");
        if (mode == 2) V3Callback(msg.sender).uniswapV3SwapCallback(a0,a1,data);
        spot = next;
    }
    function forgeCallback(address target, int256 a0, int256 a1) external { V3Callback(target).uniswapV3SwapCallback(a0,a1,""); }
}

/// A funded external trader; used to displace a real-arithmetic pool before the module call.
contract AlchemistTrader {
    address private active;
    function swap(AlchemistV3Pool pool, bool zero, uint256 amount, uint160 limit) external {
        active = address(pool); pool.swap(address(this), zero, int256(amount), limit, ""); active = address(0);
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        require(msg.sender == active);
        AlchemistV3Pool pool = AlchemistV3Pool(active);
        PricingToken.sendExact(a0 > 0 ? pool.token0() : pool.token1(), active, uint256(a0 > 0 ? a0 : a1));
    }
}
