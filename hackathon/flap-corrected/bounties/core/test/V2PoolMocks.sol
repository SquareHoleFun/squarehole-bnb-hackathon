// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test stand-ins for a PancakeSwap V2 pool, written for these tests from the pool's published behaviour (its
/// interface, the Uniswap V2 core whitepaper's section on the constant product, and PancakeSwap's 0.25% fee): a
/// factory, a pair with reserves and a fee-paying swap, a router with the two
/// fee-on-transfer buy functions for one hop, a wrapped native coin, a coin with any decimals, and a token that takes a
/// buy and a sell tax on transfers from and to its pair (as Flap's tax token does: the buyer receives the pair's output
/// less the buy tax).

contract Coin {
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 d) {
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address f, address to, uint256 amount) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= amount;
        _move(f, to, amount);
        return true;
    }

    function _move(address f, address to, uint256 amount) internal virtual {
        balanceOf[f] -= amount;
        balanceOf[to] += amount;
    }
}

contract WrappedNative is Coin(18) {
    function deposit() external payable {
        totalSupply += msg.value;
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw");
    }
}

/// @dev A token taxed on its pair: a transfer FROM the pair (a buy) loses `buyBps`, a transfer TO the pair (a sell)
/// loses `sellBps`; the tax goes to `SINK`.
contract TaxToken is Coin(18) {
    address public constant SINK = address(0x7A8);
    address public pair;
    uint256 public buyBps;
    uint256 public sellBps;

    function setPair(address p) external {
        pair = p;
    }

    function setTax(uint256 b, uint256 s) external {
        buyBps = b;
        sellBps = s;
    }

    function _move(address f, address to, uint256 amount) internal override {
        uint256 tax = f == pair ? amount * buyBps / 10_000 : to == pair ? amount * sellBps / 10_000 : 0;
        balanceOf[f] -= amount;
        balanceOf[to] += amount - tax;
        balanceOf[SINK] += tax;
    }
}

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract V2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /// Books new balances as the reserves, with the time of the change.
    function _book(uint256 bal0, uint256 bal1) private {
        require(bal0 <= type(uint112).max && bal1 <= type(uint112).max, "balance above 112 bits");
        (reserve0, reserve1, blockTimestampLast) = (uint112(bal0), uint112(bal1), uint32(block.timestamp));
    }

    function sync() external {
        _book(IERC20T(token0).balanceOf(address(this)), IERC20T(token1).balanceOf(address(this)));
    }

    /// Sends the outputs, then requires the inputs that arrived to pay for them: with 0.25% of each input set aside,
    /// the product of the balances may not fall below the product of the reserves.
    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        require(out0 != 0 || out1 != 0, "no output");
        (uint256 r0, uint256 r1) = (uint256(reserve0), uint256(reserve1));
        require(out0 < r0 && out1 < r1, "too little liquidity");
        if (out0 != 0) IERC20T(token0).transfer(to, out0);
        if (out1 != 0) IERC20T(token1).transfer(to, out1);
        uint256 b0 = IERC20T(token0).balanceOf(address(this));
        uint256 b1 = IERC20T(token1).balanceOf(address(this));
        uint256 in0 = b0 + out0 > r0 ? b0 + out0 - r0 : 0;
        uint256 in1 = b1 + out1 > r1 ? b1 + out1 - r1 : 0;
        require(in0 != 0 || in1 != 0, "no input");
        require((b0 * 10_000 - in0 * 25) * (b1 * 10_000 - in1 * 25) >= r0 * r1 * 1e8, "product fell");
        _book(b0, b1);
    }
}

contract V2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        pair = address(new V2Pair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

contract V2Router {
    address public immutable factory;
    address public immutable WETH;
    uint256 public lastAmountOutMin; // what the last buy was given, for the tests
    uint256 public calls;

    constructor(address f, address w) {
        factory = f;
        WETH = w;
    }

    receive() external payable {}

    /// What `paid` of one side buys of the other on these reserves after the 0.25% fee (25 of every 10,000 kept).
    function quote(uint256 paid, uint256 sideIn, uint256 sideOut) public pure returns (uint256) {
        uint256 counted = paid * 9975;
        return counted * sideOut / (sideIn * 10_000 + counted);
    }

    /// One hop: what arrived at the pair beyond its reserve is the input (a taxed token may deliver less than it was
    /// sent); the output is quoted on the reserves with the 0.25% fee and sent to `to`.
    function _swapOneHop(address input, address output, address to) internal {
        V2Pair pair = V2Pair(V2Factory(factory).getPair(input, output));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool inIsFirst = input == pair.token0();
        (uint256 sideIn, uint256 sideOut) = inIsFirst ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 arrived = IERC20T(input).balanceOf(address(pair)) - sideIn;
        uint256 out = quote(arrived, sideIn, sideOut);
        (uint256 a0, uint256 a1) = inIsFirst ? (uint256(0), out) : (out, uint256(0));
        pair.swap(a0, a1, to, new bytes(0));
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable {
        require(deadline >= block.timestamp, "EXPIRED");
        require(path.length == 2 && path[0] == WETH, "INVALID_PATH");
        lastAmountOutMin = amountOutMin;
        ++calls;
        WrappedNative(payable(WETH)).deposit{value: msg.value}();
        WrappedNative(payable(WETH)).transfer(V2Factory(factory).getPair(path[0], path[1]), msg.value);
        uint256 before = IERC20T(path[1]).balanceOf(to);
        _swapOneHop(path[0], path[1], to);
        require(IERC20T(path[1]).balanceOf(to) - before >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(deadline >= block.timestamp, "EXPIRED");
        require(path.length == 2, "INVALID_PATH");
        lastAmountOutMin = amountOutMin;
        ++calls;
        IERC20T(path[0]).transferFrom(msg.sender, V2Factory(factory).getPair(path[0], path[1]), amountIn);
        uint256 before = IERC20T(path[1]).balanceOf(to);
        _swapOneHop(path[0], path[1], to);
        require(IERC20T(path[1]).balanceOf(to) - before >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
    }
}

/// @dev A router whose `factory()` reverts: the pool cannot be read.
contract NoFactoryRouter {
    address public immutable WETH;

    constructor(address w) {
        WETH = w;
    }

    function factory() external pure returns (address) {
        revert("no factory");
    }
}

/// @dev A static stand-in for a deep pool, for the older tests whose routers mint at a fixed rate: `factory()` and
/// `getPair()` answer this contract, and it answers equal reserves of 2^111 (its 5 bps cap, about 1.3e30, is far above
/// their amounts) at a constant price.
abstract contract StaticDeepPool {
    function factory() external view returns (address) {
        return address(this);
    }

    function getPair(address, address) external view returns (address) {
        return address(this);
    }

    function getReserves() external pure returns (uint112, uint112, uint32) {
        return (uint112(1 << 111), uint112(1 << 111), 0);
    }
}
