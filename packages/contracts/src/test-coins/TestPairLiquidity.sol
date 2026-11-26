// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "v4-core/lib/openzeppelin-contracts/contracts/utils/math/Math.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";

/// @notice Owner's full-range liquidity in hookless ERC-20 test pairs (3000 / 60).
/// No transferable positions, arbitrary calls, approvals, or rescue path. Only seed/remove move coins.
contract TestPairLiquidity is TransientReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address public constant SEPOLIA_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    int24 public constant LOWER = -887220;
    int24 public constant UPPER = 887220;
    IPoolManager public immutable manager;
    address public immutable owner;

    struct Seed {
        address coinA;
        address coinB;
        uint256 amountA;
        uint256 amountB;
        uint256 deadline;
    }

    struct Change {
        PoolKey pool;
        int256 liquidityDelta;
        uint256 limit0;
        uint256 limit1;
    }

    event Seeded(PoolId indexed pool, uint128 liquidity, uint256 paid0, uint256 paid1);
    event Removed(PoolId indexed pool, uint128 liquidity, uint256 received0, uint256 received1);

    constructor(IPoolManager manager_, address owner_) {
        require(block.chainid == 11_155_111 || block.chainid == 31337 || block.chainid == 97, "testnet only");
        require(block.chainid != 11_155_111 || address(manager_) == SEPOLIA_MANAGER, "Sepolia manager");
        require(address(manager_).code.length > 0 && owner_ != address(0), "manager and owner");
        manager = manager_;
        owner = owner_;
    }

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    function key(address a, address b) public pure returns (PoolKey memory) {
        require(a != address(0) && b != address(0) && a != b, "coins");
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
    }

    function liquidity(address a, address b) public view returns (uint128 amount) {
        (amount,,) = manager.getPositionInfo(key(a, b).toId(), address(this), LOWER, UPPER, bytes32(0));
    }

    /// @notice Initialize at amount1/amount0 in raw units, or add at an existing price within one tick of that ratio.
    /// Exact finite allowances are consumed in full; unused budgets and accrued fees return to the owner.
    function seed(Seed calldata s) external onlyOwner nonReentrant returns (uint128 added) {
        require(s.deadline >= block.timestamp, "deadline");
        require(s.coinA.code.length > 0 && s.coinB.code.length > 0, "coin code");
        PoolKey memory k = key(s.coinA, s.coinB);
        (uint256 amount0, uint256 amount1) = s.coinA < s.coinB ? (s.amountA, s.amountB) : (s.amountB, s.amountA);
        uint160 target = _startingPrice(amount0, amount1);
        (uint160 price,,,) = manager.getSlot0(k.toId());
        if (price == 0) {
            manager.initialize(k, target);
            price = target;
        } else {
            // Refuse a pre-initialized or moved pool at an unapproved price; the owner can re-budget a top-up.
            int256 distance = int256(TickMath.getTickAtSqrtPrice(price)) - TickMath.getTickAtSqrtPrice(target);
            require(distance >= -1 && distance <= 1, "pool price");
        }
        uint160 lo = TickMath.getSqrtPriceAtTick(LOWER);
        uint160 hi = TickMath.getSqrtPriceAtTick(UPPER);
        require(price > lo && price < hi, "price outside range");
        added = LiquidityAmounts.getLiquidityForAmounts(price, lo, hi, amount0, amount1);
        require(added > 0 && added <= uint128(type(int128).max), "liquidity");
        _pull(k.currency0, amount0);
        _pull(k.currency1, amount1);
        (int256 d0, int256 d1) = abi.decode(
            manager.unlock(abi.encode(Change(k, int256(uint256(added)), amount0, amount1))), (int256, int256)
        );
        _refund(k.currency0);
        _refund(k.currency1);
        // modifyLiquidity's delta includes accrued fees on an existing position.
        emit Seeded(k.toId(), added, d0 < 0 ? uint256(-d0) : 0, d1 < 0 ? uint256(-d1) : 0);
    }

    /// @notice Remove this helper's entire position and fees. Minima are in sorted currency0/currency1 order.
    function remove(address a, address b, uint256 minimum0, uint256 minimum1, uint256 deadline)
        external onlyOwner nonReentrant
    {
        require(deadline >= block.timestamp, "deadline");
        PoolKey memory k = key(a, b);
        uint128 held = liquidity(a, b);
        require(held != 0, "no liquidity");
        (int256 d0, int256 d1) = abi.decode(
            manager.unlock(abi.encode(Change(k, -int256(uint256(held)), minimum0, minimum1))), (int256, int256)
        );
        _refund(k.currency0);
        _refund(k.currency1);
        emit Removed(k.toId(), held, uint256(d0), uint256(d1));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager) && _insideGuardedCall(), "callback");
        Change memory c = abi.decode(data, (Change));
        (BalanceDelta delta,) = manager.modifyLiquidity(c.pool,
            ModifyLiquidityParams(LOWER, UPPER, c.liquidityDelta, bytes32(0)), "");
        int256 d0 = delta.amount0();
        int256 d1 = delta.amount1();
        if (c.liquidityDelta > 0) {
            require(d0 >= -int256(c.limit0) && d1 >= -int256(c.limit1), "budget exceeded");
        } else {
            require(d0 >= 0 && d1 >= 0 && uint256(d0) >= c.limit0 && uint256(d1) >= c.limit1,
                "withdrawal minimum");
        }
        _settle(c.pool.currency0, d0);
        _settle(c.pool.currency1, d1);
        return abi.encode(d0, d1);
    }

    function _startingPrice(uint256 amount0, uint256 amount1) private pure returns (uint160 price) {
        require(amount0 > 0 && amount1 > 0 && amount0 <= uint128(type(int128).max)
            && amount1 <= uint128(type(int128).max), "budgets");
        // Q192 where the quotient fits; otherwise Q128 followed by a 32-bit shift.
        // The latter is used only above 2**64, so its discarded precision is far below one tick.
        uint256 root = (amount1 >> 64) < amount0
            ? Math.sqrt(FullMath.mulDiv(amount1, uint256(1) << 192, amount0))
            : Math.sqrt(FullMath.mulDiv(amount1, uint256(1) << 128, amount0)) << 32;
        require(root > TickMath.getSqrtPriceAtTick(LOWER) && root < TickMath.getSqrtPriceAtTick(UPPER),
            "price outside range");
        price = uint160(root);
    }

    function _pull(Currency currency, uint256 amount) private {
        IERC20 coin = IERC20(Currency.unwrap(currency));
        require(coin.allowance(owner, address(this)) == amount, "exact approval");
        uint256 before_ = coin.balanceOf(address(this));
        require(coin.transferFrom(owner, address(this), amount), "coin transfer");
        require(coin.balanceOf(address(this)) == before_ + amount, "inexact coin");
        require(coin.allowance(owner, address(this)) == 0, "remaining approval");
    }

    function _settle(Currency currency, int256 delta) private {
        if (delta < 0) {
            uint256 paid = uint256(-delta);
            manager.sync(currency);
            require(IERC20(Currency.unwrap(currency)).transfer(address(manager), paid), "coin transfer");
            require(manager.settle() == paid, "inexact coin");
        } else if (delta > 0) {
            manager.take(currency, owner, uint256(delta));
        }
    }

    function _refund(Currency currency) private {
        IERC20 coin = IERC20(Currency.unwrap(currency));
        uint256 amount = coin.balanceOf(address(this));
        if (amount != 0) require(coin.transfer(owner, amount), "refund");
        require(coin.balanceOf(address(this)) == 0, "remaining coin");
    }
}
