// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IHolderLedgerV2, IHolderTokenHistoryV2, HolderLedgerLimitsV2 as L} from "./interfaces/IHolderLedgerV2.sol";
import {IBoxHookV2, TradeBatchV2} from "./interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "./interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {BoxReceiverV2Args as Args} from "./libraries/BoxReceiverV2Args.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";
import {CheckedBurn} from "./libraries/CheckedBurn.sol";
import {PricingToken} from "./libraries/PricingToken.sol";

/// @notice Immutable role 17: per-trade historical units, bounded settlement and P or T claims without expiry.
/// @dev M2SeamArgs.holder: coordinator/T/hook/receiver/P at 0/20/40/60/80. No initializer or administrator.
contract HolderLedgerV2 is IHolderLedgerV2, IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    IPoolManager private immutable _pm;
    address private immutable _implementation;
    bytes32 private constant LOCK = keccak256("squarehole.holder.v2.lock");
    bytes32 private constant PAYOUT = keccak256("squarehole.holder.v2.payout");
    uint256 private constant PAYOUT_RESERVE_GAS = 200_000;
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));
    /// @notice Anyone reads the capped complete T payout allowance; no funds move.
    uint256 public constant CLAIM_T_GAS = 2_600_000;
    /// @notice Anyone reads the batch payout coin. New clones append per-side T bits at offset 100.
    function payoutAsset(uint256 id) public view returns (address) {
        return Args.uintAt(100, 1) & (id % 2 == 1 ? 1 : 2) != 0 ? Args.addressAt(20) : Args.addressAt(80);
    }
    struct Notice { uint256 checkpoint; uint256 supply; uint256 units; }
    struct Batch {
        Notice[] notices;
        uint256 count;
        uint256 holderCursor;
        uint256 noticeCursor;
        uint256 units;
        uint256 allocated;
        uint256 residue;
        bool complete;
    }
    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => mapping(address => uint256)) private _credit;

    // T-only append; legacy P batch/credit slots and their one-time settlement are unchanged.
    struct StagedCredit { uint256 round; uint256 amount; }
    struct Tranche {
        uint256 cumulative;
        uint256 amount;
        uint256 round;
        mapping(address => StagedCredit) credits;
    }
    mapping(uint256 => Tranche) private _tranches;

    /// @notice Release deployer fixes PoolManager only; implementation itself cannot receive accounting calls.
    constructor(IPoolManager pm) {
        if (address(pm) == address(0)) revert InvalidRequest();
        _pm = pm; _implementation = address(this);
    }
    modifier locked() {
        bytes32 slot = LOCK; uint256 entered;
        assembly ("memory-safe") { entered := tload(slot) }
        if (entered != 0 || address(this) == _implementation) revert InvalidRequest();
        assembly ("memory-safe") { tstore(slot, 1) }
        _;
        assembly ("memory-safe") { tstore(slot, 0) }
    }
    function _token() private view returns (IHolderTokenHistoryV2) { return IHolderTokenHistoryV2(Args.addressAt(20)); }
    function _receiver() private view returns (IBoxReceiverV2) { return IBoxReceiverV2(Args.addressAt(60)); }
    function _outsideUnlock() private view { if (_pm.isUnlocked()) revert InvalidRequest(); }

    /// @inheritdoc IHolderLedgerV2
    function register() external locked { _token().registerHolder(msg.sender); }

    /// @inheritdoc IHolderLedgerV2
    function onTokenCheckpoint(uint256, address, address) external view {
        if (msg.sender != Args.addressAt(20)) revert Unauthorized(msg.sender);
        // History is authoritative. No cache is necessary, so a missed or replayed hint has no effect.
    }

    /// @notice Immutable hook only, under HOLDER_NOTICE_GAS; snapshot history without any holder loop or payout.
    function onTradeFeeBatch(uint256 id, address, bool buy, uint256 units) external locked {
        if (msg.sender != Args.addressAt(40)) revert Unauthorized(msg.sender);
        if (id == 0 || (id % 2 == 1) != buy || _batches[id].complete) revert InvalidRequest();
        if (units == 0) return;
        IHolderTokenHistoryV2 token = _token();
        uint256 checkpoint = token.holderCheckpoint();
        Batch storage b = _batches[id];
        b.notices.push(Notice(checkpoint, token.eligibleSupplyAt(checkpoint), units));
        b.count = token.holderCount();
    }

    /// @inheritdoc IHolderLedgerV2
    function settleBatch(uint256 id, uint256 steps) external locked returns (bool complete) {
        if (steps == 0 || steps > L.MAX_SETTLE_STEPS) revert InvalidRequest();
        Batch storage b = _batches[id];
        bool inT = payoutAsset(id) == Args.addressAt(20);
        if (b.complete && !inT) return true;
        TradeBatchV2 memory source = IBoxHookV2(Args.addressAt(40)).tradeBatch(id);
        if (id == 0 || !source.closed || !_receiver().holderBatchClosed(id)) revert BatchNotReady(id);
        uint256 funding = _receiver().holderBatchPaid(id);
        if (inT) {
            Tranche storage tranche = _tranches[id];
            if (b.complete && funding == tranche.cumulative) return true;
            if (b.complete || tranche.round == 0) {
                tranche.amount = funding - tranche.cumulative;
                tranche.cumulative = funding;
                ++tranche.round;
                b.complete = false; b.holderCursor = 0; b.noticeCursor = 0;
                b.units = 0; b.allocated = 0;
            }
            // New purchases during a page never change this tranche's frozen funding.
            funding = tranche.amount;
        }
        uint256 denominator = source.tradeUnits + source.protocolUnits;
        // Zero denominator and missing notices can only produce residue, never a division or wallet credit.
        if (b.notices.length == 0 || denominator == 0) b.holderCursor = b.count;
        while (steps != 0 && b.holderCursor < b.count) {
            address holder = _token().holderAt(b.holderCursor);
            Notice storage n = b.notices[b.noticeCursor];
            if (n.supply != 0) {
                b.units += FullMath.mulDiv(n.units, _token().eligibleBalanceAt(holder, n.checkpoint), n.supply);
            }
            ++b.noticeCursor; --steps;
            if (b.noticeCursor == b.notices.length) {
                uint256 amount = FullMath.mulDiv(funding, b.units, denominator);
                if (inT) _stage(id, holder, amount);
                else _credit[id][holder] = amount;
                b.allocated += amount;
                b.units = 0; b.noticeCursor = 0; ++b.holderCursor;
            }
        }
        if (b.holderCursor == b.count) {
            uint256 residue = funding - b.allocated;
            b.residue += residue; b.complete = true;
            emit BatchSettled(id, funding, b.allocated, residue);
        }
        return b.complete;
    }

    function _stage(uint256 id, address holder, uint256 amount) private {
        Tranche storage tranche = _tranches[id];
        StagedCredit storage staged = tranche.credits[holder];
        _credit[id][holder] += staged.amount; // Mature previous tranche, less any claims.
        staged.round = tranche.round; staged.amount = amount;
    }

    /// @inheritdoc IHolderLedgerV2
    function claimable(uint256 id, address holder) external view returns (uint256) {
        if (payoutAsset(id) == Args.addressAt(20)) return _credit[id][holder] + _matured(id, holder);
        return _batches[id].complete ? _credit[id][holder] : 0;
    }
    /// @inheritdoc IHolderLedgerV2
    function batchState(uint256 id) external view returns (bool, uint256, uint256, uint256) {
        Batch storage b = _batches[id];
        bool complete = b.complete;
        if (complete && payoutAsset(id) == Args.addressAt(20)) {
            complete = _receiver().holderBatchPaid(id) == _tranches[id].cumulative;
        }
        return (complete, b.holderCursor, b.noticeCursor, b.residue);
    }
    function _matured(uint256 id, address holder) private view returns (uint256) {
        Tranche storage tranche = _tranches[id];
        StagedCredit storage staged = tranche.credits[holder];
        return _batches[id].complete || staged.round < tranche.round ? staged.amount : 0;
    }
    function _take(uint256 id, address holder) private returns (uint256 amount) {
        _outsideUnlock();
        bool inT = payoutAsset(id) == Args.addressAt(20);
        if (inT) {
            uint256 matured = _matured(id, holder);
            if (matured != 0) {
                _credit[id][holder] += matured;
                _tranches[id].credits[holder].amount = 0;
            }
        } else if (!_batches[id].complete) revert BatchNotReady(id);
        amount = _credit[id][holder];
        if (amount == 0) revert InvalidRequest();
        if (inT && amount > MAX_PART) amount = MAX_PART;
        _credit[id][holder] -= amount;
    }
    /// @inheritdoc IHolderLedgerV2
    function claim(uint256 id, address to) external locked returns (uint256 paidP) {
        if (to == address(0)) revert InvalidRequest();
        paidP = _take(id, msg.sender); _pay(payoutAsset(id), to, paidP, false);
        emit HolderPaid(id, msg.sender, to, paidP, 0);
    }
    /// @inheritdoc IHolderLedgerV2
    function flushResidue(uint256 id) external locked returns (uint256 amountP) {
        _outsideUnlock();
        Batch storage b = _batches[id];
        amountP = b.residue;
        address asset = payoutAsset(id);
        if (asset == Args.addressAt(20)) {
            if (amountP > MAX_PART) amountP = MAX_PART;
            b.residue -= amountP;
            _pay(asset, address(this), amountP, true);
            if (amountP != 0) emit ResidueFlushed(id, address(0), amountP);
            return amountP;
        }
        if (!b.complete) revert BatchNotReady(id);
        b.residue = 0;
        address to = IBoxCoordinatorV2(Args.addressAt(0)).failed() ? Args.addressAt(60) : Args.addressAt(40);
        if (amountP != 0) {
            if (!_pm.transfer(to, uint160(Args.addressAt(80)), amountP)) revert InvalidRequest();
            emit ResidueFlushed(id, to, amountP);
        }
    }
    function _arm(bool armed) private {
        bytes32 slot = PAYOUT;
        assembly ("memory-safe") { tstore(slot, armed) }
    }
    function _pay(address asset, address to, uint256 amount, bool burn) private {
        if (amount == 0) return;
        _arm(true);
        bytes memory data = abi.encode(asset, to, amount, burn);
        if (asset == Args.addressAt(20)) {
            uint256 cap = burn ? C.BURN_GAS : CLAIM_T_GAS;
            if (gasleft() < cap + cap / 63 + PAYOUT_RESERVE_GAS) revert InvalidRequest();
            _pm.unlock{gas: cap}(data);
        } else _pm.unlock(data);
        _arm(false);
    }
    /// @notice PoolManager only in this ledger's armed payout; redeems the selected asset atomically.
    /// @dev Foreign callbacks cannot consume credit. P refusal rolls the individual claim back for retry.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_pm)) revert Unauthorized(msg.sender);
        bytes32 slot = PAYOUT; uint256 armed;
        assembly ("memory-safe") { armed := tload(slot) tstore(slot, 0) }
        if (armed == 0) revert InvalidRequest();
        (address p, address to, uint256 amount, bool burn) = abi.decode(data, (address, address, uint256, bool));
        bool inT = p == Args.addressAt(20);
        uint256 beforePM = inT ? PricingToken.balanceOf(p, address(_pm)) : 0;
        uint256 beforeBalance = PricingToken.balanceOf(p, to);
        uint256 remaining = amount;
        while (remaining != 0) {
            uint256 part = remaining > MAX_PART ? MAX_PART : remaining;
            _pm.burn(address(this), uint160(p), part); _pm.take(Currency.wrap(p), to, part); remaining -= part;
        }
        if (PricingToken.balanceOf(p, to) - beforeBalance != amount) revert InvalidRequest();
        if (inT && beforePM - PricingToken.balanceOf(p, address(_pm)) != amount) revert InvalidRequest();
        if (burn) CheckedBurn.burn(p, amount);
        return "";
    }
}
