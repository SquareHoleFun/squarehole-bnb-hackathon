// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxReceiverShopV21 as Events} from "../interfaces/IBoxReceiverShopV21.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../interfaces/IBoxHookV2.sol";
import {IShopVaultV2} from "../interfaces/IShopVaultV2.sol";
import {BoxReceiverV2Args as A} from "./BoxReceiverV2Args.sol";
import {RewardAccountingV21 as R} from "./RewardAccountingV21.sol";
import {ReleaseConstantsV2 as C} from "../interfaces/ReleaseConstantsV2.sol";

/// @notice Fixed core shop choice; never a directory module. P stays in the receiver's side slot.
/// @dev A namespaced journal maps each original fee batch to its final P refund. No existing receiver slot moves.
library ReceiverShopV21 {
    using R for R.State;
    bytes32 private constant JOURNAL = keccak256("squarehole.receiver.v21.shop.journal");
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));
    uint256 private constant Q96 = 1 << 96;
    function _state() private pure returns (R.State storage s) {
        bytes32 slot = JOURNAL;
        assembly ("memory-safe") { s.slot := slot }
    }
    function _shop() private view returns (IShopVaultV2) {
        return IShopVaultV2(IBoxCoordinatorV2(A.addressAt(A.COORDINATOR)).vault());
    }
    /// @notice Locked receiver allocator only; reserve the original trade batch's P interval. No funds move.
    function fund(uint256 id, uint256 amount) public {
        R.State storage s = _state(); s.fund(id, amount);
        if (amount != 0) emit Events.ShopBatchQueued(id, s.fundedP - amount, s.fundedP);
    }
    /// @notice Locked receiver only; records spent, refunded or clipped P once. Refunded P is the second amount.
    function consume(uint256 amount, uint256 refunded) public {
        R.State storage s = _state();
        s.pending[0] -= amount;
        s.consume(amount, refunded);
        if (amount != 0) emit Events.ShopPendingConsumed(s.consumedP, s.boughtT);
    }
    /// @notice Anyone through receiver views reads finality and P allocated to this original batch.
    function funding(uint256 id) public view returns (bool, uint256) { return _state().funding(id); }
    /// @notice Receiver booking only; weekly decision plus the live ceiling, also before graduation.
    function wanted() public view returns (bool) {
        IShopVaultV2 shop = _shop();
        return shop.feesWanted() && shop.budgetT() < shop.ceilingT();
    }
    /// @notice Locked, prepared, graduated receiver only via fixed code; anyone may request the step.
    /// Reuse Burn's exact-in BUY, its 49-tick minimum and shared block mark. Any intake refusal rolls back all.
    function run(IPoolManager pm, uint256 slot) public returns (uint256 spent) {
        uint256 pending;
        assembly ("memory-safe") { pending := sload(slot) }
        if (pending == 0) return 0;
        IShopVaultV2 shop = _shop();
        // A short queue can grow on the next collection. Only unusable ceiling room (even with a full
        // queue), or the weekly/live decision, declines fees and resolves them to the original holders.
        if (!wanted() || _input(pm, shop, MAX_PART) == 0) { _refund(pm, slot, pending); return pending; }
        uint256 amount = _input(pm, shop, pending);
        if (amount == 0) return 0;
        if (IBoxHookV2(A.addressAt(A.HOOK)).lastProtocolBlock() == block.number) return 0;
        bytes32 armed = keccak256("squarehole.receiver.v2.unlock");
        assembly ("memory-safe") { tstore(armed, 5) }
        (uint256 paid, uint256 bought) = abi.decode(pm.unlock(abi.encode(uint256(5), address(0), address(0), amount)), (uint256, uint256));
        assembly ("memory-safe") { tstore(armed, 0) sstore(slot, sub(pending, paid)) }
        consume(paid, 0);
        IERC20Minimal t = IERC20Minimal(A.addressAt(A.T));
        uint256 beforeT = t.balanceOf(address(this));
        require(t.approve(address(shop), bought), "ShopApprovalRefused");
        shop.fundFromFees(bought);
        require(t.balanceOf(address(this)) == beforeT - bought && t.allowance(address(this), address(shop)) == 0, "ShopInexactDebit");
        emit Events.ShopFunded(true, paid, bought);
        uint256 left = pending - paid;
        if (left != 0 && (!wanted() || _input(pm, shop, MAX_PART) == 0)) {
            _refund(pm, slot, left); return pending;
        }
        return paid;
    }
    // At decreasing sqrt(T/P), an exact-in purchase returns no more T than input * spot^2.
    // Ignoring the fee is conservative. Two bounded divisions avoid intermediate uint256 overflow.
    function _input(IPoolManager pm, IShopVaultV2 shop, uint256 pending) private view returns (uint256 amount) {
        uint256 ceiling = shop.ceilingT(); uint256 budget = shop.budgetT();
        if (budget >= ceiling) return 0;
        PoolId pool = PoolId.wrap(keccak256(abi.encode(
            A.addressAt(A.P), A.addressAt(A.T), C.V2_POOL_FEE, int24(60), A.addressAt(A.HOOK))));
        (uint160 spot,, uint24 protocolFee,) = StateLibrary.getSlot0(pm, pool);
        if (spot == 0) return 0;
        amount = _dividePrice(_dividePrice(ceiling - budget, spot), spot);
        if (amount > pending) amount = pending;
        if (amount < A.uintAt(A.STEP_MIN_Q, 16) || !_positiveOutput(pm, pool, spot, protocolFee, amount)) return 0;
    }
    // Conservative positive-output bounds for BOTH ways the exact-in swap can stop: exhausted input or
    // the 49-tick/full-range boundary. Use BUY's 8 P / 4 T rounding slack (at most two swap segments).
    // A dust queue waits; dust even at the full ceiling room declines fees to the original holders.
    function _positiveOutput(IPoolManager pm, PoolId pool, uint160 spot, uint24 protocolFee, uint256 amount)
        private view returns (bool)
    {
        uint256 limit = FullMath.mulDivRoundingUp(spot, TickMath.getSqrtPriceAtTick(-C.STEP_TICKS), Q96);
        uint160 floor = TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(60));
        if (limit < floor) limit = floor;
        if (limit >= spot) return false;
        uint24 fee = ProtocolFeeLibrary.calculateSwapFee(ProtocolFeeLibrary.getZeroForOneFee(protocolFee), C.FEE_PIPS);
        uint256 net = FullMath.mulDiv(amount, 1_000_000 - fee, 1_000_000);
        if (net <= 8 || FullMath.mulDiv(FullMath.mulDiv(net - 8, limit, Q96), limit, Q96) <= 4) return false;
        return FullMath.mulDiv(StateLibrary.getLiquidity(pm, pool), spot - limit, Q96) > 4;
    }
    function _dividePrice(uint256 amount, uint160 spot) private pure returns (uint256) {
        if (amount >= FullMath.mulDivRoundingUp(MAX_PART, spot, Q96)) return MAX_PART;
        return FullMath.mulDiv(amount, Q96, spot);
    }
    function _refund(IPoolManager pm, uint256 slot, uint256 amount) private {
        assembly ("memory-safe") { sstore(slot, sub(sload(slot), amount)) }
        consume(amount, amount);
        require(pm.transfer(A.addressAt(A.HOLDER_LEDGER), uint160(A.addressAt(A.P)), amount), "ClaimsTransferFailed");
        emit Events.ShopHoldersFunded(amount);
    }
}
