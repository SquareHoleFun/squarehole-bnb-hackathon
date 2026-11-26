// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxSwapBoundsV2} from "../box-v2/libraries/BoxSwapBoundsV2.sol";

/// @notice Founder-owned test liquidity, restricted to hookless native/test-coin pools at 3000 / 60.
/// A seed atomically initializes a new pool and pays at most the explicit budgets. Existing pools refuse.
/// Positions belong to this helper; only its immutable owner can remove them and receives all proceeds.
contract TestPoolLiquidity is TransientReentrancyGuard {
    address public constant SEPOLIA_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    IPoolManager public immutable manager;
    address public immutable owner;

    struct Seed {
        address coin;
        uint160 sqrtPriceX96; // sqrt(raw coin / wei) * 2**96; ETH is always currency0.
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Max;
        uint256 amount1Max;
        uint256 deadline;
    }

    event Seeded(address indexed coin, int24 lower, int24 upper, uint128 liquidity, uint256 ethPaid, uint256 coinPaid);
    event Removed(address indexed coin, uint128 liquidity, uint256 ethReceived, uint256 coinReceived);

    constructor(IPoolManager manager_, address owner_) {
        require(block.chainid == 11_155_111 || block.chainid == 31337 || block.chainid == 97, "testnet only");
        require(block.chainid != 11_155_111 || address(manager_) == SEPOLIA_MANAGER, "Sepolia manager");
        require(address(manager_).code.length > 0 && owner_ != address(0), "manager and owner");
        manager = manager_; owner = owner_;
    }

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    function key(address coin) public pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(coin), 3000, 60, IHooks(address(0)));
    }

    /// @notice Validate budgets, range and room for both 49-tick directions; return integer liquidity.
    function quote(Seed memory s) public view returns (uint128 liquidity) {
        require(s.coin.code.length > 0 && s.deadline >= block.timestamp, "coin or deadline");
        require(s.tickLower >= -887220 && s.tickUpper <= 887220 && s.tickLower < s.tickUpper
            && s.tickLower % 60 == 0 && s.tickUpper % 60 == 0, "ticks");
        uint160 lo = TickMath.getSqrtPriceAtTick(s.tickLower);
        uint160 hi = TickMath.getSqrtPriceAtTick(s.tickUpper);
        require(s.sqrtPriceX96 > lo && s.sqrtPriceX96 < hi, "price outside range");
        require(BoxSwapBoundsV2.roomLimit(true, s.sqrtPriceX96, 49) > lo
            && BoxSwapBoundsV2.roomLimit(false, s.sqrtPriceX96, 49) < hi, "49 tick room");
        require(s.amount0Max > 0 && s.amount1Max > 0
            && s.amount0Max <= uint128(type(int128).max) && s.amount1Max <= uint128(type(int128).max), "budgets");
        liquidity = LiquidityAmounts.getLiquidityForAmounts(s.sqrtPriceX96, lo, hi, s.amount0Max, s.amount1Max);
        require(liquidity > 0 && liquidity <= uint128(type(int128).max), "liquidity");
    }

    function seed(Seed calldata s) external payable onlyOwner nonReentrant returns (uint128 liquidity) {
        require(msg.value == s.amount0Max, "native budget");
        liquidity = quote(s);
        manager.initialize(key(s.coin), s.sqrtPriceX96);
        (uint256 paid0, uint256 paid1) = abi.decode(
            manager.unlock(abi.encode(s, int256(uint256(liquidity)), uint256(0), uint256(0))), (uint256, uint256)
        );
        uint256 refund = msg.value - paid0;
        if (refund != 0) {
            (bool ok,) = owner.call{value: refund}("");
            require(ok, "refund");
        }
        emit Seeded(s.coin, s.tickLower, s.tickUpper, liquidity, paid0, paid1);
    }

    /// @notice Owner recovers a specified position's liquidity and fees; minima and deadline bind the withdrawal.
    function remove(Seed calldata s, uint128 liquidity, uint256 minimum0, uint256 minimum1)
        external onlyOwner nonReentrant
    {
        require(s.deadline >= block.timestamp && liquidity > 0, "deadline or liquidity");
        (uint256 out0, uint256 out1) = abi.decode(
            manager.unlock(abi.encode(s, -int256(uint256(liquidity)), minimum0, minimum1)), (uint256, uint256)
        );
        emit Removed(s.coin, liquidity, out0, out1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager) && _insideGuardedCall(), "callback");
        (Seed memory s, int256 liquidity, uint256 min0, uint256 min1) =
            abi.decode(data, (Seed, int256, uint256, uint256));
        (BalanceDelta delta,) = manager.modifyLiquidity(key(s.coin),
            ModifyLiquidityParams(s.tickLower, s.tickUpper, liquidity, bytes32(0)), "");
        int256 d0 = delta.amount0();
        int256 d1 = delta.amount1();
        if (liquidity > 0) {
            require(d0 <= 0 && d1 <= 0, "seed delta");
            uint256 paid0 = uint256(-d0);
            uint256 paid1 = uint256(-d1);
            require(paid0 <= s.amount0Max && paid1 <= s.amount1Max, "budget exceeded");
            manager.settle{value: paid0}();
            manager.sync(Currency.wrap(s.coin));
            require(IERC20(s.coin).transferFrom(owner, address(manager), paid1), "coin transfer");
            require(manager.settle() == paid1, "inexact coin");
            return abi.encode(paid0, paid1);
        }
        require(d0 >= 0 && d1 >= 0 && uint256(d0) >= min0 && uint256(d1) >= min1, "withdrawal minimum");
        if (d0 != 0) manager.take(Currency.wrap(address(0)), owner, uint256(d0));
        if (d1 != 0) manager.take(Currency.wrap(s.coin), owner, uint256(d1));
        return abi.encode(uint256(d0), uint256(d1));
    }
}
