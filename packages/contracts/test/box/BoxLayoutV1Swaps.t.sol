// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxLayoutV1} from "../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";

/// @notice TEST ONLY: a plain ERC-20 with a chosen decimals value (Q of 6 or 18 decimals, and T).
contract BoxTestToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice TEST ONLY: seeds a curve position, buys through it and removes it, settling with the PoolManager inside
/// its own unlocks (no router, no hook: the layout's maths on the pinned v4 PoolManager and nothing else).
contract CurveDriver is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function modify(PoolKey memory key, int24 lower, int24 upper, int256 liquidityDelta)
        external
        returns (BalanceDelta delta, BalanceDelta fees)
    {
        return abi.decode(pm.unlock(abi.encode(uint8(1), abi.encode(key, lower, upper, liquidityDelta))), (BalanceDelta, BalanceDelta));
    }

    function swap(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta delta) {
        return abi.decode(pm.unlock(abi.encode(uint8(2), abi.encode(key, params))), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (uint8 action, bytes memory args) = abi.decode(data, (uint8, bytes));
        PoolKey memory key;
        BalanceDelta delta;
        bytes memory result;
        if (action == 1) {
            int24 lower;
            int24 upper;
            int256 liquidityDelta;
            (key, lower, upper, liquidityDelta) = abi.decode(args, (PoolKey, int24, int24, int256));
            BalanceDelta fees;
            (delta, fees) = pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidityDelta, 0), "");
            result = abi.encode(delta, fees);
        } else {
            SwapParams memory params;
            (key, params) = abi.decode(args, (PoolKey, SwapParams));
            delta = pm.swap(key, params, "");
            result = abi.encode(delta);
        }
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return result;
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount > 0) {
            pm.take(currency, address(this), uint256(uint128(amount)));
        } else if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(currency);
                BoxTestToken(Currency.unwrap(currency)).transfer(address(pm), owed);
                pm.settle();
            }
        }
    }
}

/// @notice BC-003 on the pinned Uniswap v4 PoolManager: for every layout vector (every Q class and raise preset, both
/// token orders), the curve is seeded single-sided in T with exactly the curve T, bought out in one swap or in eight,
/// every buy is Q in and T out, the price ends at exactly P1, and removing the position returns exactly the raise in
/// Q (fees apart, no unit lost or gained) and no T. The order is set by placing T's code below or above Q's address.
contract BoxLayoutV1SwapsTest is Test {
    using StateLibrary for IPoolManager;

    string internal constant VECTORS = "test/vectors/box-spec/layout-v1.json";
    address internal constant LOW = address(0x1000000000000000000000000000000000000001);
    address internal constant MID = address(0x8000000000000000000000000000000000000008);
    address internal constant HIGH = address(0xf00000000000000000000000000000000000000f);

    /// @dev A v4 swap moves in steps that end at the next initialized tick or tick-bitmap word (256 x 60 = 15,360
    /// ticks); the 26,880-tick curve spans at most three words, so a buy takes at most four steps, each rounding the
    /// output down and the input and its fee up by under one raw unit.
    uint256 internal constant MAX_STEPS_PER_SWAP = 4;

    struct Run {
        uint256 swaps;
        uint256 qPaid;
        uint256 tReceived;
        uint256 qPrincipal;
        uint256 tPrincipal;
        uint256 qFees;
    }

    function _k(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".vectors[", vm.toString(i), "].", field);
    }

    function test_bc003_everyLayoutBoughtOutInOneSwap() public {
        _everyVector(1);
    }

    function test_bc003_everyLayoutBoughtOutInEightSwaps() public {
        _everyVector(8);
    }

    function _everyVector(uint256 chunks) internal {
        string memory json = vm.readFile(VECTORS);
        uint256 count = vm.parseJsonUint(json, ".count");
        for (uint256 i; i < count; ++i) {
            // Each vector is an independent world. Snapshot rollback would not refund spent gas;
            // Amsterdam's repeated 38,222,554-gas PoolManager deposits exhaust the test budget.
            // Give each vector a fresh budget, keeping its deployments and swaps fully metered.
            vm.resetGasMetering();
            uint256 raise = vm.parseJsonUint(json, _k(i, "raise"));
            bool tIsC0 = vm.parseJsonBool(json, _k(i, "tIsCurrency0"));
            bool native = keccak256(bytes(vm.parseJsonString(json, _k(i, "qClass")))) == keccak256("NATIVE_ETH");
            uint8 decimals = uint8(vm.parseJsonUint(json, _k(i, "decimals")));
            Run memory r = _run(raise, tIsC0, native, decimals, chunks);
            assertEq(r.qPrincipal, raise, string.concat(vm.toString(i), ": the position returns exactly the raise"));
            assertEq(r.tPrincipal, 0, "no T left on the curve");
            assertGe(r.qPaid, raise + r.qFees, "buyers paid the raise and the fees");
            assertLe(r.qPaid - raise - r.qFees, MAX_STEPS_PER_SWAP * 2 * r.swaps, "rounding only: two raw units a step");
        }
    }

    struct Pool {
        IPoolManager pm;
        CurveDriver driver;
        PoolKey key;
        bool tIsC0;
    }

    function _run(uint256 raise, bool tIsC0, bool native, uint8 decimals, uint256 chunks)
        internal
        returns (Run memory r)
    {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, tIsC0);
        Pool memory p = _pool(raise, tIsC0, native, decimals);
        p.pm.initialize(p.key, c.sqrtPriceStartX96);
        _seed(p, c);
        _buyOut(p, c, chunks, r);
        _remove(p, c, r);
    }

    function _pool(uint256 raise, bool tIsC0, bool native, uint8 decimals) internal returns (Pool memory p) {
        p.pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        p.driver = new CurveDriver(p.pm);
        p.tIsC0 = tIsC0;
        // T below or above Q, so the pool's order is the vector's; native ETH is address(0), always currency0.
        address q = native ? address(0) : MID;
        address t = tIsC0 ? LOW : HIGH;
        vm.etch(t, address(new BoxTestToken(18)).code);
        if (!native) vm.etch(q, address(new BoxTestToken(decimals)).code);
        assertEq(BoxTestToken(t).decimals(), 18);
        assertEq(BoxLayoutV1.tIsCurrency0(t, q), tIsC0);
        BoxTestToken(t).mint(address(p.driver), BoxSpecV1.ISSUANCE);
        if (native) vm.deal(address(p.driver), raise * 2);
        else BoxTestToken(q).mint(address(p.driver), raise * 2);
        p.key = PoolKey({
            currency0: Currency.wrap(tIsC0 ? t : q),
            currency1: Currency.wrap(tIsC0 ? q : t),
            fee: BoxSpecV1.LP_FEE,
            tickSpacing: BoxSpecV1.TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    /// @dev (Q, T) parts of a delta.
    function _qt(Pool memory p, BalanceDelta d) internal pure returns (int128 q, int128 t) {
        (q, t) = p.tIsC0 ? (d.amount1(), d.amount0()) : (d.amount0(), d.amount1());
    }

    /// @dev Seeding takes exactly the curve T and no Q.
    function _seed(Pool memory p, BoxLayoutV1.Curve memory c) internal {
        (BalanceDelta seeded,) = p.driver.modify(p.key, c.tickLower, c.tickUpper, int256(uint256(c.liquidity)));
        (int128 q, int128 t) = _qt(p, seeded);
        assertEq(q, 0, "single-sided: no Q");
        assertEq(uint256(uint128(-t)), c.curveT, "the position takes exactly the curve T");
    }

    /// @dev Q in, T out, the price limited at P1: `chunks` exact-input buys, each of raise / chunks except the last,
    /// which buys whatever is left up to P1.
    function _buyOut(Pool memory p, BoxLayoutV1.Curve memory c, uint256 chunks, Run memory r) internal {
        for (uint256 j; j < chunks; ++j) {
            int256 amountIn = j + 1 < chunks ? -int256(c.raise / chunks) : -int256(c.raise * 2);
            (int128 dq, int128 dt) = _qt(p, p.driver.swap(p.key, SwapParams(!p.tIsC0, amountIn, c.sqrtPriceEndX96)));
            if (dq == 0 && dt == 0) continue;
            assertLt(dq, 0, "a buy is Q in");
            assertGt(dt, 0, "a buy is T out");
            r.qPaid += uint256(uint128(-dq));
            r.tReceived += uint256(uint128(dt));
            ++r.swaps;
        }
        (uint160 sqrtPrice,,,) = p.pm.getSlot0(p.key.toId());
        assertEq(sqrtPrice, c.sqrtPriceEndX96, "the price ends at exactly P1");
        assertLe(r.tReceived, c.curveT);
        assertLe(c.curveT - r.tReceived, MAX_STEPS_PER_SWAP * r.swaps, "buyers got the curve T less rounding");
    }

    /// @dev Removing the whole position: principal = what it returns less its fees.
    function _remove(Pool memory p, BoxLayoutV1.Curve memory c, Run memory r) internal {
        (BalanceDelta out, BalanceDelta fees) =
            p.driver.modify(p.key, c.tickLower, c.tickUpper, -int256(uint256(c.liquidity)));
        (int128 qOut, int128 tOut) = _qt(p, out);
        (int128 qFee, int128 tFee) = _qt(p, fees);
        assertEq(tFee, 0, "buys pay fees in Q only");
        r.qFees = uint256(uint128(qFee));
        r.qPrincipal = uint256(uint128(qOut)) - r.qFees;
        r.tPrincipal = uint256(uint128(tOut));
    }
}
