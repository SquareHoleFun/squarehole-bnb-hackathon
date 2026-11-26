// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "./BoxSpecV1.sol";
import {BoxReceiverBase} from "./BoxReceiverBase.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxSwapModule} from "./interfaces/IBoxSwapModule.sol";
import {BoxKind, RoyaltyDestination} from "./interfaces/BoxTypes.sol";
import {BoxClones} from "./libraries/BoxClones.sol";

/// @title BoxReceiverExtension (slice S5.M1; docs/design/swap-module-v1.md § 7, the two-half split)
/// @notice The receiver's cold half: `initialize` (the stream menu, the swap module's wiring, add-on 5's cap arguments
/// since S5.M3), the fee notes of the box's own swappers (`noteModuleFees`: once a step, beside a swap) and the creator
/// payee's two-step hand-over, run by DELEGATECALL from `BoxReceiver` in a box's receiver clone context (so
/// `address(this)` is the clone and the arguments, storage and reentrancy lock are the clone's). S11's failure release
/// joins it. Its address is an immutable of `BoxReceiver`'s code, the same for every box of the version, box 0
/// included.
/// @dev Called directly (not through a delegatecall) every entry point reverts (`NotDelegated`). No owner, admin,
/// pause, upgrade, setter or rescue (F23 C2). Its errors and events are `IBoxReceiver`'s.
contract BoxReceiverExtension is BoxReceiverBase {
    error NotDelegated();

    /// @dev The swap module's menu (S5.M1; bit = stream value): Q side ALL_TO_FIT, TO_CREATOR, BUYBACK_BURN_T and
    /// CREATOR_IN_T; T side BURN_T, TO_CREATOR, SELL_FOR_Q and CREATOR_IN_Q. Those paying the creator need a payee.
    uint256 private constant _Q_MENU = (1 << BoxSpecV1.Q_STREAM_ALL_TO_FIT) | (1 << BoxSpecV1.Q_STREAM_TO_CREATOR)
        | (1 << BoxSpecV1.Q_STREAM_BUYBACK_BURN_T) | (1 << BoxSpecV1.Q_STREAM_CREATOR_IN_T);
    uint256 private constant _T_MENU = (1 << BoxSpecV1.T_STREAM_BURN_T) | (1 << BoxSpecV1.T_STREAM_TO_CREATOR)
        | (1 << BoxSpecV1.T_STREAM_SELL_FOR_Q) | (1 << BoxSpecV1.T_STREAM_CREATOR_IN_Q);
    uint256 private constant _Q_CREATOR = (1 << BoxSpecV1.Q_STREAM_TO_CREATOR) | (1 << BoxSpecV1.Q_STREAM_CREATOR_IN_T);
    uint256 private constant _T_CREATOR = (1 << BoxSpecV1.T_STREAM_TO_CREATOR) | (1 << BoxSpecV1.T_STREAM_CREATOR_IN_Q);

    /// @notice The version's coordinator implementation: only a clone of it may initialise a receiver (BC-100). The
    /// receiver's hot half names the same one (its constructor checks).
    address public immutable coordinatorImplementation;
    address internal immutable _self;

    constructor(address coordinatorImplementation_) {
        coordinatorImplementation = coordinatorImplementation_;
        _self = address(this);
    }

    modifier onlyDelegated() {
        if (address(this) == _self) revert NotDelegated();
        _;
    }

    // ================================================================== lifecycle

    /// @notice `IBoxReceiver.initialize`: the box's coordinator only, once, in createBox.
    function initialize() external onlyDelegated {
        if (msg.sender != _argAddress(_A_COORDINATOR) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert IBoxReceiver.NotCoordinator(msg.sender);
        }
        if (_s & _B_INIT != 0) revert IBoxReceiver.AlreadyInitialised();
        uint8 k = _argUint8(_A_KIND);
        address q_ = _argAddress(_A_Q);
        if (q_ != address(0)) revert QNotSupported(q_);
        uint8 qs = _argUint8(_A_Q_STREAM);
        uint8 ts = _argUint8(_A_T_STREAM);
        RoyaltyDestination dest = RoyaltyDestination(_argUint(_A_ROYALTY, 1));
        address payee = _argAddress(_A_PAYEE);
        address m = _argAddress(_A_MODULE);
        bool ok;
        if (k == uint8(BoxKind.Box0)) {
            // Box 0: its Q stream is FIT's executor itself; T burned or to the per-item stream; no creator; no swap
            // module (S5.M1).
            ok = qs == BoxSpecV1.Q_STREAM_BUYBACK_BURN_T
                && (ts == BoxSpecV1.T_STREAM_BURN_T || ts == BoxSpecV1.T_STREAM_PER_ITEM_STREAM)
                && dest != RoyaltyDestination.Creator && payee == address(0);
            if (_argAddress(_A_SAFE) == address(0) || _argAddress(_A_EXECUTOR) == address(0)) {
                revert IBoxReceiver.ZeroAddress();
            }
            if (m != address(0)) revert IBoxReceiver.ModuleMismatch(m);
            // S8: the stream receives the T side after graduation whenever it is named, so it is named exactly with
            // PER_ITEM_STREAM (BURN_T with a stream would stream; PER_ITEM_STREAM without one would burn).
            address stream = _argAddress(_A_STREAM);
            if ((ts == BoxSpecV1.T_STREAM_PER_ITEM_STREAM) != (stream != address(0))) {
                revert IBoxReceiver.StreamMismatch(stream);
            }
        } else if (k == uint8(BoxKind.Standard)) {
            bool creator =
                (_Q_CREATOR >> qs) & 1 != 0 || (_T_CREATOR >> ts) & 1 != 0 || dest == RoyaltyDestination.Creator;
            ok = (_Q_MENU >> qs) & 1 != 0 && (_T_MENU >> ts) & 1 != 0 && (!creator || payee != address(0))
                && _argAddress(_A_STREAM) == address(0);
            // No platform payee for any box but box 0 (F64; BC-109); every Standard box has a swap module (W4).
            if (_argAddress(_A_SAFE) != address(0) || _argAddress(_A_EXECUTOR) == address(0) || m == address(0)) {
                revert IBoxReceiver.ZeroAddress();
            }
        } else {
            revert UnknownKind(k);
        }
        // Holder payouts (7, PAY_HOLDERS_*) need S14, BURN_Q S12.
        if (!ok) revert IBoxReceiver.ActionNotBuilt(qs, ts);
        // Add-on 5 (S5.M3): a cap needs a creator kind on a fee side (as validate(): royalties alone do not take it) and
        // an excess destination this receiver routes (BURN or POOL_DEPTH; HOLDERS is S14); none for box 0.
        uint256 cap = _argUint(_A_CAP, 16);
        uint8 ex = _argUint8(_A_CAP_EXCESS);
        if (
            cap | ex != 0
                && (k == uint8(BoxKind.Box0)
                    || cap == 0
                    || (ex != BoxSpecV1.CAP_EXCESS_BURN && ex != BoxSpecV1.CAP_EXCESS_POOL_DEPTH)
                    || ((_Q_CREATOR >> qs) | (_T_CREATOR >> ts)) & 1 == 0)
        ) revert IBoxReceiver.CreatorCapRefused(cap, ex);
        _s = _B_INIT;
        if (m != address(0)) {
            // The module names this receiver and the box's Q, T and hook; its first storage writes are paid here.
            (address r, address mq, address mt, address mh) = IBoxSwapModule(m).wiring();
            if (r != address(this) || mq != q_ || mt != _argAddress(_A_TOKEN) || mh != _argAddress(_A_HOOK)) {
                revert IBoxReceiver.ModuleMismatch(m);
            }
            IBoxSwapModule(m).initialize();
            // The fee-note allowances, stored plus 1 (S5 review, BC-138): written here, so the module's first pull
            // and note write no slot from zero; they are not claims, so `booked()` is unaffected.
            (_m.allowanceQ, _m.allowanceT) = (1, 1);
        }
    }

    // ================================================================== REV-16's notes (BC-019, BC-132, BC-133)

    /// @notice `IBoxReceiver.noteModuleFees`: FIT's executor (box 0), the box's swap module (Standard boxes) or the
    /// box's hook (every box) only. `collect` returns the notes before the tip and the split.
    function noteModuleFees(uint256 qFee, uint256 tFee) external onlyDelegated nonReentrantCall {
        _initialised();
        bool box0 = _argUint(_A_KIND, 1) == uint8(BoxKind.Box0);
        uint256 qClipped;
        uint256 tClipped;
        if (msg.sender == _argAddress(_A_HOOK)) {
            // The hook's depth conversions (F76, F77; S5.M5), every box: Q only, it never sells T (F72 (B)); no
            // allowance, the hook holds the whole depth budget (swap-module § 4.2). Raw amounts stay below 2^128.
            (tClipped, tFee) = (tFee, 0);
            _s += qFee << _O_HOOK_FEES;
        } else if (msg.sender == _argAddress(box0 ? _A_EXECUTOR : _A_MODULE)) {
            // Box 0: FIT's executor, unbounded as built (every box's payFit() feeds it). Standard boxes: the swap
            // module, up to its allowance (Σ handed × LP_FEE / 10^6 per side); the rest clipped, never reverted.
            if (!box0) {
                // Stored plus 1 since `initialize` (so the slots never return to zero).
                uint256 aq = _m.allowanceQ - 1;
                uint256 at = _m.allowanceT - 1;
                if (qFee > aq) (qClipped, qFee) = (qFee - aq, aq);
                if (tFee > at) (tClipped, tFee) = (tFee - at, at);
                (_m.allowanceQ, _m.allowanceT) = (_u128(aq - qFee + 1), _u128(at - tFee + 1));
            }
            _l.moduleQPending += _u128(qFee);
            _l.moduleTPending += _u128(tFee);
        } else {
            revert IBoxReceiver.NotModule(msg.sender);
        }
        emit IBoxReceiver.ModuleFeesNoted(msg.sender, qFee, tFee);
        if (qClipped | tClipped != 0) emit IBoxReceiver.ModuleFeesClipped(msg.sender, qClipped, tClipped);
    }

    // ================================================================== creator payee (F72 (1), (3))

    /// @notice `IBoxReceiver.proposeCreatorPayee`: the current payee only.
    function proposeCreatorPayee(address proposed) external onlyDelegated nonReentrantCall {
        _initialised();
        address payee = _payee();
        if (msg.sender != payee || payee == address(0)) revert IBoxReceiver.NotPayee(msg.sender);
        if (proposed == address(0)) revert IBoxReceiver.ZeroAddress();
        _pendingPayee = proposed;
        emit IBoxReceiver.CreatorPayeeProposed(payee, proposed);
    }

    /// @notice `IBoxReceiver.acceptCreatorPayee`: the proposed payee only.
    function acceptCreatorPayee() external onlyDelegated nonReentrantCall {
        _initialised();
        address pending = _pendingPayee;
        if (msg.sender != pending || pending == address(0)) revert IBoxReceiver.NotPendingPayee(msg.sender);
        address previous = _payee();
        _payeeOverride = pending;
        _pendingPayee = address(0);
        emit IBoxReceiver.CreatorPayeeChanged(previous, pending);
    }
}
