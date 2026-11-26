// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {BoxSwapBoundsV2} from "../libraries/BoxSwapBoundsV2.sol";
import {PricingToken} from "../libraries/PricingToken.sol";
import {TransientReentrancyGuard} from "../../libraries/TransientReentrancyGuard.sol";

/// @notice kind 2 = canonical 0.3% v2 pair, 3 = v3, 4 = static-fee hookless v4 in the fixed manager.
struct AlchemistHopV21 { uint8 kind; address tokenIn; address tokenOut; address pool; uint24 fee; int24 tickSpacing; }
interface IAlchemistPairV21 {
    /// @notice Anyone reads the pool's first currency.
    function token0() external view returns (address);
    /// @notice Anyone reads the pool's second currency.
    function token1() external view returns (address);
    /// @notice Anyone reads the pair's current reserves.
    function getReserves() external view returns (uint112, uint112, uint32);
    /// @notice Any funded caller requests output; canonical pair invariant and exact receipts are required.
    function swap(uint256, uint256, address, bytes calldata) external;
}
interface IAlchemistV3V21 {
    /// @notice Anyone reads the pool's first currency.
    function token0() external view returns (address);
    /// @notice Anyone reads the pool's second currency.
    function token1() external view returns (address);
    /// @notice Anyone reads the pool's immutable fee.
    function fee() external view returns (uint24);
    /// @notice Anyone reads the pool's immutable tick spacing.
    function tickSpacing() external view returns (int24);
    /// @notice Anyone reads the pool's current price and status.
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    /// @notice Anyone swaps within the price limit and must pay the authenticated pool callback.
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

/// @notice Immutable route executor, deployed once with the directory action, shared by all selecting boxes.
/// @dev Only its immutable module can fund/execute it. No administration, approval, unlock or rescue entry.
/// Transient state authenticates v3 callbacks; the directory action itself has no storage instructions.
contract AlchemistRouteV21 is TransientReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    /// @notice Anyone reads the only authorized action; no funds move.
    address public immutable module;
    /// @notice Anyone reads the only manager whose claims may fund this route.
    IPoolManager public immutable manager;
    /// @notice Anyone reads the immutable hop count (1 through 3).
    uint256 public immutable length;
    /// @notice Anyone reads the largest raw-P clip a zero minimum moves to box depth, fixed by the module; no money moves.
    uint256 public immutable dustMax;
    address private immutable _a0; address private immutable _a1;
    address private immutable _a2; address private immutable _a3;
    address private immutable _p0; address private immutable _p1; address private immutable _p2;
    uint256 private immutable _c0; uint256 private immutable _c1; uint256 private immutable _c2;
    // Packed config: kind (8 bits), fee (24), positive spacing (24).
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant MAX_AMOUNT = uint256(uint128(type(int128).max));
    bytes32 private constant CALLBACK_POOL = keccak256("alchemist.v21.callback.pool");
    bytes32 private constant CALLBACK_TOKEN = keccak256("alchemist.v21.callback.token");
    bytes32 private constant CALLBACK_AMOUNT = keccak256("alchemist.v21.callback.amount");
    bytes32 private constant CALLBACK_ZERO = keccak256("alchemist.v21.callback.zero");
    error InvalidRoute();
    error OnlyModule();
    error SwapRefused();
    error InexactMovement();
    error BadCallback();
    error OnlySelf();
    error ZeroMinimum();
    struct Snapshot { uint160 spot; uint112 r0; uint112 r1; uint24 fee; }

    /// @notice Deployment by the action only; fixes all route fields and the module's checked dust size, accepts no money.
    constructor(IPoolManager pm, AlchemistHopV21[] memory route, uint256 dust) {
        module = msg.sender; manager = pm; dustMax = dust;
        uint256 n = route.length;
        if (address(pm).code.length == 0 || n == 0 || n > 3) revert InvalidRoute();
        for (uint256 i; i < n; ++i) {
            AlchemistHopV21 memory h = route[i];
            if (h.tokenIn == h.tokenOut || (i > 0 && h.tokenIn != route[i-1].tokenOut)
                || (h.tokenIn != address(0) && h.tokenIn.code.length == 0)
                || (h.tokenOut != address(0) && h.tokenOut.code.length == 0)
                || h.pool.code.length == 0 || h.fee < 3000 || h.fee >= 1_000_000) revert InvalidRoute();
            for (uint256 j; j <= i; ++j) if (h.tokenOut == route[j].tokenIn) revert InvalidRoute();
            (address a, address b) = h.tokenIn < h.tokenOut ? (h.tokenIn,h.tokenOut) : (h.tokenOut,h.tokenIn);
            if (h.kind == 4) {
                if (h.pool != address(pm) || h.tickSpacing <= 0 || h.tickSpacing > 32767) revert InvalidRoute();
            } else if (h.kind == 2 || h.kind == 3) {
                if (a == address(0) || IAlchemistPairV21(h.pool).token0() != a
                    || IAlchemistPairV21(h.pool).token1() != b) revert InvalidRoute();
                if (h.kind == 2) {
                    if (h.fee != 3000 || h.tickSpacing != 0) revert InvalidRoute();
                } else if (IAlchemistV3V21(h.pool).fee() != h.fee || h.tickSpacing <= 0
                    || IAlchemistV3V21(h.pool).tickSpacing() != h.tickSpacing) revert InvalidRoute();
            } else revert InvalidRoute();
        }
        length = n; _a0 = route[0].tokenIn; _a1 = route[0].tokenOut;
        _p0 = route[0].pool; _c0 = _pack(route[0]);
        _a2 = n > 1 ? route[1].tokenOut : address(0);
        _a3 = n > 2 ? route[2].tokenOut : address(0);
        _p1 = n > 1 ? route[1].pool : address(0); _c1 = n > 1 ? _pack(route[1]) : 0;
        _p2 = n > 2 ? route[2].pool : address(0); _c2 = n > 2 ? _pack(route[2]) : 0;
    }
    /// @notice Anyone reads the fixed route; no money moves. No user may supply or replace a hop.
    function hop(uint256 i) public view returns (AlchemistHopV21 memory h) {
        if (i >= length) revert InvalidRoute();
        uint256 c = i == 0 ? _c0 : i == 1 ? _c1 : _c2;
        h = AlchemistHopV21(uint8(c), i == 0 ? _a0 : i == 1 ? _a1 : _a2,
            i == 0 ? _a1 : i == 1 ? _a2 : _a3, i == 0 ? _p0 : i == 1 ? _p1 : _p2,
            uint24(c >> 8), int24(uint24(c >> 32)));
    }
    /// @notice Immutable module only, inside its receiver's existing unlock; consumes all funded claims or reverts.
    /// @dev If a hop's minimum for its actual input rounds to zero and the clip is at most dustMax, roll back every
    /// attempted swap, then transfer the whole original P input as claims to dustTo (the box's authenticated hook,
    /// supplied by the module) for its next eligible deepen. Return zero. A larger zero-minimum clip refuses.
    /// Pool/token failures cannot trigger this exit. A refused or inexact claims transfer restores the
    /// whole pending clip for retry.
    /// ReceiverPendingV21 owns the fail-safe 2,800,000 gas cap and 200,000 restoration reserve.
    function convert(address pile, uint256 amount, address dustTo) external nonReentrant returns (uint256 output) {
        if (msg.sender != module) revert OnlyModule();
        if (amount == 0 || amount > MAX_AMOUNT) revert SwapRefused();
        try this.attempt(pile,amount) returns (uint256 result) { return result; }
        catch (bytes memory reason) {
            if (reason.length != 4 || bytes4(reason) != ZeroMinimum.selector || amount > dustMax) revert SwapRefused();
        }
        if (dustTo == address(0)) revert InvalidRoute();
        uint256 claims = manager.balanceOf(address(this),uint160(_a0));
        uint256 depth = manager.balanceOf(dustTo,uint160(_a0));
        if (!manager.transfer(dustTo,uint160(_a0),amount)
            || manager.balanceOf(address(this),uint160(_a0)) != claims - amount
            || manager.balanceOf(dustTo,uint160(_a0)) != depth + amount) revert InexactMovement();
        return 0;
    }
    /// @notice Guarded self-call only. Turn a trusted zero result into rollback of all route effects.
    /// @dev The success-block revert is deliberately outside the catch: every external failure from swapRoute,
    /// including a forged ZeroMinimum error from a token/pool, is normalized to SwapRefused instead.
    function attempt(address pile, uint256 amount) external returns (uint256) {
        if (msg.sender != address(this) || !_insideGuardedCall()) revert OnlySelf();
        try this.swapRoute(pile,amount) returns (uint256 output) {
            if (output == 0) revert ZeroMinimum();
            return output;
        } catch { revert SwapRefused(); }
    }
    /// @notice Guarded self-call only; snapshots all pools before movements, then executes the immutable route.
    /// Zero means a locally computed minimum rounded away. Only attempt may observe it and roll back this frame.
    function swapRoute(address pile, uint256 amount) external returns (uint256 output) {
        if (msg.sender != address(this) || !_insideGuardedCall()) revert OnlySelf();
        uint256 n = length;
        Snapshot[] memory start = new Snapshot[](n);
        uint256[] memory balances = new uint256[](n + 1);
        for (uint256 i; i < n; ++i) {
            AlchemistHopV21 memory h = hop(i);
            start[i] = _snapshot(h);
            balances[i] = PricingToken.balanceOf(h.tokenIn,address(this));
        }
        address out = hop(n-1).tokenOut;
        balances[n] = PricingToken.balanceOf(out,address(this));
        uint256 claims = manager.balanceOf(address(this),uint160(_a0));
        manager.burn(address(this),uint160(_a0),amount);
        _take(_a0, address(this), amount);
        output = amount;
        for (uint256 i; i < n; ++i) {
            AlchemistHopV21 memory h = hop(i);
            Snapshot memory now_ = _snapshot(h);
            if (keccak256(abi.encode(now_)) != keccak256(abi.encode(start[i]))) revert SwapRefused();
            uint256 beforeIn = PricingToken.balanceOf(h.tokenIn,address(this));
            uint256 beforeOut = PricingToken.balanceOf(h.tokenOut,address(this));
            uint256 spent = output;
            output = h.kind == 2 ? _v2(h,start[i],spent) : _concentrated(h,start[i],spent);
            if (output == 0) return 0;
            if (PricingToken.balanceOf(h.tokenIn,address(this)) != beforeIn - spent
                || PricingToken.balanceOf(h.tokenOut,address(this)) != beforeOut + output) revert InexactMovement();
        }
        // Native piles accept only their PoolManager. Use the same settlement/take path for both asset kinds.
        PricingToken.settle(manager,out,output);
        _take(out,pile,output);
        for (uint256 i; i < n; ++i) {
            if (PricingToken.balanceOf(hop(i).tokenIn,address(this)) != balances[i]) revert InexactMovement();
        }
        if (PricingToken.balanceOf(out,address(this)) != balances[n]
            || manager.balanceOf(address(this),uint160(_a0)) != claims - amount) revert InexactMovement();
    }
    /// @notice Only the currently armed immutable-route v3 pool may collect exactly its input once.
    /// No caller-supplied callback data grants authority; clear before calling the token.
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        bytes32 sp = CALLBACK_POOL; bytes32 st = CALLBACK_TOKEN; bytes32 sa = CALLBACK_AMOUNT; bytes32 sz = CALLBACK_ZERO;
        address pool; address token; uint256 amount; bool zero;
        assembly ("memory-safe") { pool := tload(sp) token := tload(st) amount := tload(sa) zero := tload(sz) }
        if (!_insideGuardedCall() || msg.sender != pool || amount == 0
            || (zero ? a0 : a1) != int256(amount) || (zero ? a1 : a0) >= 0) revert BadCallback();
        assembly ("memory-safe") { tstore(sp,0) tstore(st,0) tstore(sa,0) tstore(sz,0) }
        PricingToken.sendExact(token,pool,amount);
    }
    /// @notice Only the fixed PoolManager may supply native route funds, during conversion.
    receive() external payable {
        if (msg.sender != address(manager) || !_insideGuardedCall()) revert OnlyModule();
    }
    function _concentrated(AlchemistHopV21 memory h, Snapshot memory s, uint256 amount) private returns (uint256 output) {
        if (amount > MAX_AMOUNT) revert SwapRefused();
        bool zero = h.tokenIn < h.tokenOut;
        uint160 limit = BoxSwapBoundsV2.roomLimit(zero,s.spot,49);
        if (limit == 0) revert SwapRefused();
        uint256 minimum = BoxSwapBoundsV2.minOut(zero,amount,limit,s.fee);
        if (minimum == 0) return 0;
        int256 a0; int256 a1;
        if (h.kind == 4) {
            BalanceDelta d = manager.swap(_key(h),SwapParams(zero,-int256(amount),limit),"");
            a0 = d.amount0(); a1 = d.amount1();
            // v4 uses the caller's signs; v3 uses the pool's signs.
            a0 = -a0; a1 = -a1;
        } else {
            _arm(h.pool,h.tokenIn,amount,zero);
            (a0,a1) = IAlchemistV3V21(h.pool).swap(address(this),zero,int256(amount),limit,"");
            bytes32 sa = CALLBACK_AMOUNT; uint256 stillArmed;
            assembly ("memory-safe") { stillArmed := tload(sa) }
            if (stillArmed != 0) revert BadCallback();
        }
        int256 received = zero ? a1 : a0;
        if ((zero ? a0 : a1) != int256(amount) || received >= 0 || received < -int256(MAX_AMOUNT)) revert SwapRefused();
        output = uint256(-received);
        uint160 end = _snapshot(h).spot;
        if (zero ? (end < limit || end > s.spot) : (end > limit || end < s.spot)) revert SwapRefused();
        if (output < minimum) revert SwapRefused();
        if (h.kind == 4) {
            PricingToken.settle(manager,h.tokenIn,amount);
            _take(h.tokenOut,address(this),output);
        }
    }
    function _v2(AlchemistHopV21 memory h, Snapshot memory s, uint256 amount) private returns (uint256 output) {
        bool zero = h.tokenIn < h.tokenOut;
        (uint256 x,uint256 y) = zero ? (s.r0,s.r1) : (s.r1,s.r0);
        if (x == 0 || y == 0 || amount > type(uint112).max - x) revert SwapRefused();
        uint256 net = amount * 997;
        output = FullMath.mulDiv(net,y,x * 1000 + net);
        if (output == 0) return 0;
        uint256 down = BoxSwapBoundsV2.sqrtImpactDownX96();
        // (y-out)/(x+in) >= (y/x) * 1.0001^-49, rounded toward refusal.
        uint256 floorPrice = FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(x + amount,down,Q96),down,Q96);
        if (FullMath.mulDiv(x,y-output,y) < floorPrice) revert SwapRefused();
        PricingToken.sendExact(h.tokenIn,h.pool,amount);
        IAlchemistPairV21(h.pool).swap(zero ? 0 : output,zero ? output : 0,address(this),"");
        Snapshot memory end = _snapshot(h);
        if ((zero ? end.r0 : end.r1) != x + amount || (zero ? end.r1 : end.r0) != y - output) revert InexactMovement();
    }
    function _snapshot(AlchemistHopV21 memory h) private view returns (Snapshot memory s) {
        if (h.kind == 2) {
            (s.r0,s.r1,) = IAlchemistPairV21(h.pool).getReserves(); s.fee = 3000;
            // Check at entry, at the hop, and after it. A token callback may not repair a bad entry snapshot.
            bool zero = h.tokenIn < h.tokenOut;
            if (PricingToken.balanceOf(h.tokenIn,h.pool) != (zero ? s.r0 : s.r1)
                || PricingToken.balanceOf(h.tokenOut,h.pool) != (zero ? s.r1 : s.r0)) revert SwapRefused();
        }
        else if (h.kind == 3) { (s.spot,,,,,,) = IAlchemistV3V21(h.pool).slot0(); s.fee = h.fee; }
        else {
            uint24 protocol; uint24 lp;
            (s.spot,,protocol,lp) = manager.getSlot0(_key(h).toId());
            if (lp != h.fee) revert SwapRefused();
            uint16 pf = h.tokenIn < h.tokenOut ? ProtocolFeeLibrary.getZeroForOneFee(protocol) : ProtocolFeeLibrary.getOneForZeroFee(protocol);
            s.fee = pf == 0 ? lp : ProtocolFeeLibrary.calculateSwapFee(pf,lp);
        }
    }
    function _take(address asset, address to, uint256 amount) private {
        uint256 beforeTo = PricingToken.balanceOf(asset,to);
        uint256 beforePm = PricingToken.balanceOf(asset,address(manager));
        manager.take(Currency.wrap(asset),to,amount);
        if (PricingToken.balanceOf(asset,to) != beforeTo + amount
            || PricingToken.balanceOf(asset,address(manager)) != beforePm - amount) revert InexactMovement();
    }
    function _arm(address pool, address token, uint256 amount, bool zero) private {
        bytes32 sp = CALLBACK_POOL; bytes32 st = CALLBACK_TOKEN; bytes32 sa = CALLBACK_AMOUNT; bytes32 sz = CALLBACK_ZERO;
        assembly ("memory-safe") { tstore(sp,pool) tstore(st,token) tstore(sa,amount) tstore(sz,zero) }
    }
    function _key(AlchemistHopV21 memory h) private pure returns (PoolKey memory) {
        (address a,address b) = h.tokenIn < h.tokenOut ? (h.tokenIn,h.tokenOut) : (h.tokenOut,h.tokenIn);
        return PoolKey(Currency.wrap(a),Currency.wrap(b),h.fee,h.tickSpacing,IHooks(address(0)));
    }
    function _pack(AlchemistHopV21 memory h) private pure returns (uint256) {
        return uint256(h.kind) | (uint256(h.fee) << 8) | (uint256(uint24(h.tickSpacing)) << 32);
    }
}
