// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types; DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneReader} from "./BoxCloneReader.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxHook, IBoxPriceAverage} from "./interfaces/IBoxHook.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxSwapModule, IBoxSwapModuleWiring} from "./interfaces/IBoxSwapModule.sol";
import {ModuleProceedsTo} from "./interfaces/BoxTypes.sol";
import {BoxSwapBounds} from "./libraries/BoxSwapBounds.sol";

interface IBurnableBoxT {
    function totalSupply() external view returns (uint256);
    function burn(uint256 amount) external;
}

/// @title BoxSwapModule (slices S5.M2 and S5.M3; the implementation behind every Standard box's swap module clone)
/// @notice See `IBoxSwapModule` for the behaviour (docs/design/swap-module-v1.md § 4.3-4.8, § 5, § 6). Builds the
/// engine with `BuyBurn` (BUYBACK_BURN_T, and add-on 5's BURN excess in Q) and `SellForFit` (W4, R F75: sellers' FIT
/// share sold in small capped steps, its Q to FIT; SELL_FOR_Q on the same ledger) on `BoxSwapBounds`, and since S5.M3
/// the creator conversions `BuyForCreator` (CREATOR_IN_T: T bought for the payee, minted as claims to the receiver and
/// booked by `moduleProceeds`, CreatorT) and `SellForCreator` (CREATOR_IN_Q: its Q booked the same way, CreatorQ, where
/// the receiver applies add-on 5's cap at face); returned fees go back to the creator ledger that paid them first (§
/// 4.8). Copies
/// FitBuybackExecutor's swap (FitBuybackExecutor.sol:273-311, :452-481: the guarded unlock, the delta and √price checks,
/// the minimum output) for one direction or the other, and its fee report (`:259-269`), with four changes:
/// 1. **Claims in, claims out.** The input is paid by burning this module's own ERC-6909 claims, which only its
///    receiver hands it (`pullForModule`); a sell's Q is minted as claims to the receiver inside the unlock and booked
///    right after (`moduleProceeds`, FitQ, at most what arrived since the step's pull); bought T is taken as real T and
///    burned. No approval, operator or allowance anywhere.
/// 2. **No ring of its own.** The reference is the box's price sampler (the hook's `priceAverage`), read as `deepen()`
///    reads it; nothing here can move the average.
/// 3. **One step per block per box**, all actions together, and a budget below SWAP_STEP_MIN_Q waits; the caller's tip
///    comes from the step itself, last inside the unlock (as `deepen()`).
/// 4. **No slot from zero after `initialize`** (§ 6): the ledgers are stored plus 1 (written by `initialize`, in the
///    creation transaction), and a step spends at most a ledger less 1 raw unit and burns T less 1 raw unit, so this
///    module's claim balances and its T balance never return to zero once filled.
/// @dev No owner, admin, pause, upgrade, setter, rescue or `receive` (F23 C2). A stranger's clone of this code cannot be
/// initialised for a real box (only the box's receiver calls `initialize`, once, for the module its own arguments name).
contract BoxSwapModule is IBoxSwapModule, TransientReentrancyGuard, BoxCloneReader {
    /// @notice Length of the clone arguments.
    uint256 public constant ARGS_LENGTH = 102;

    uint256 private constant _A_RECEIVER = 0;
    uint256 private constant _A_HOOK = 20;
    uint256 private constant _A_AVERAGE = 40;
    uint256 private constant _A_Q = 60;
    uint256 private constant _A_TOKEN = 80;
    uint256 private constant _A_Q_ACTION = 100;
    uint256 private constant _A_T_ACTION = 101;

    // `_s`: initialised (bit 0), graduation latched (bit 1), the last step's block (bits 8-71).
    uint256 private constant _B_INIT = 1;
    uint256 private constant _B_GRADUATED = 2;
    uint256 private constant _O_STEP = 8;
    uint256 private constant _M64 = (1 << 64) - 1;
    uint256 private constant _LIQUIDITY_OFFSET = 3;

    /// @dev Raw units, each stored plus 1 (`initialize` writes the 1s), so a ledger slot is never zero after it.
    /// Q ledgers and T ledgers are this module's claims; `tBurnPending` is real T it holds to burn.
    struct Ledgers {
        uint128 qBurn;
        uint128 qCreator;
        uint128 tForFit;
        uint128 tForCreator;
        uint128 tBurnPending;
        /// S5.M3 (REV-16's attribution, § 4.8): the T fees the SellForCreator steps reported, not yet returned.
        uint128 tBackCreator;
    }

    /// @dev One swap's result, from the unlock.
    struct Swap {
        uint256 amountIn;
        uint256 amountOut;
        uint256 tip;
        uint160 sqrtBefore;
        uint160 sqrtAfter;
    }

    /// @dev One step's plan, from the guards: the budget it may spend (its ledger less the 1 raw unit it keeps), the
    /// reference tick, the limit, and the direction's swap fee and LP share (pips).
    struct Plan {
        uint256 spend;
        int24 refTick;
        uint160 limit;
        uint24 swapFee;
        uint24 lpShare;
        /// § 13 point 7: SellForCreator with the creator's room spent and a BURN excess burns its T, no swap (at most
        /// what the sale would have sold: `spend` capped).
        bool burn;
    }

    IPoolManager public immutable poolManager;

    uint256 internal _s;
    Ledgers internal _l;
    /// @dev S5.M3 (§ 6's fifth slot): the Q fees the BuyForCreator steps reported, not yet returned, plus 1; written by
    /// `initialize` for a CREATOR_IN_T box only (no other box ever reads or writes it).
    uint256 internal _qBackCreator;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
        // The implementation itself is never a box's module.
        _s = _B_INIT;
    }

    // ================================================================== lifecycle

    /// @inheritdoc IBoxSwapModuleWiring
    /// @dev Checks what the receiver cannot: its streams are this clone's actions, the hook names this receiver and the
    /// price average named here. The receiver checks the rest (`wiring()`: receiver, Q, T, hook).
    function initialize() external {
        address r = _argAddress(_A_RECEIVER);
        if (msg.sender != r) revert NotReceiver(msg.sender);
        if (_s != 0) revert AlreadyInitialised();
        (address q_, address t_) = _argAddress2(_A_Q);
        if (q_ != address(0)) revert QNotSupported(q_);
        uint8 qa = _argUint8(_A_Q_ACTION);
        uint8 ta = _argUint8(_A_T_ACTION);
        IBoxHook h = IBoxHook(_argAddress(_A_HOOK));
        if (
            IBoxReceiver(r).qStream() != qa || IBoxReceiver(r).tStream() != ta || h.receiver() != r
                || address(h.priceAverage()) != _argAddress(_A_AVERAGE) || h.token() != t_
        ) revert WiringMismatch();
        _s = _B_INIT;
        _l = Ledgers(1, 1, 1, 1, 1, 1);
        if (qa == BoxSpecV1.Q_STREAM_CREATOR_IN_T) _qBackCreator = 1;
    }

    // ================================================================== steps

    /// @inheritdoc IBoxSwapModule
    function step(Action action, address tipTo)
        external
        nonReentrant
        returns (Stop stop, uint256 amountIn, uint256 amountOut, uint256 tip)
    {
        uint256 s = _initialised();
        if (action == Action.None) revert ActionNotBuilt(_argUint8(_A_Q_ACTION), _argUint8(_A_T_ACTION));
        // Buys (Q → T): BuyBurn, BuyForCreator; sells (T → Q): SellForFit, SellForCreator.
        bool buy = uint8(action) <= uint8(Action.BuyForCreator);
        // 1. What the receiver owes (this also opens the receiver's snapshot for the proceeds), and T waiting to burn.
        _pull();
        _burnHeld();
        // 2-6. Every guard; a failed one is a skip with the budget kept.
        Plan memory p;
        stop = _plan(s, action, buy, p);
        if (stop != Stop.None) {
            emit StepSkipped(action, stop);
            return (stop, 0, 0, 0);
        }
        if (p.burn) {
            // § 13 point 7, bounded (S5 review): one step, the block recorded as a sale's.
            _markStep();
            return (Stop.None, _burnCreatorT(p.spend), 0, 0);
        }
        // 7. The swap (the step block recorded before the unlock); 8. ledgers, the burn, the proceeds, the fee report.
        Swap memory w = _swap(action, buy, p, tipTo);
        _book(action, buy, w, p.lpShare);
        _emitStepped(action, tipTo, p, w);
        return (Stop.None, w.amountIn, w.amountOut, w.tip);
    }

    /// @inheritdoc IBoxSwapModule
    function sync() external nonReentrant {
        _initialised();
        _pull();
    }

    /// @inheritdoc IBoxSwapModule
    function burnPending() external nonReentrant returns (uint256 burned) {
        _initialised();
        burned = _burnHeld();
    }

    /// @notice PoolManager callback of `step`'s own unlock (inside its guarded call only): one exact-input swap within
    /// the limit, checked; the input paid from this module's claims; the output taken as T to burn (BuyBurn), or minted
    /// as claims to the receiver (BuyForCreator's T, the sells' Q); the tip in Q to `tipTo`, last.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert NotPoolManager();
        (Action action, uint256 maxIn, uint160 limit, uint24 swapFee, address tipTo) =
            abi.decode(data, (Action, uint256, uint160, uint24, address));
        bool buy = uint8(action) <= uint8(Action.BuyForCreator);
        (address q_, address t_) = _argAddress2(_A_Q);
        if (action == Action.None) {
            // `_burnCreatorT`: the creator's T claims redeemed here, to be burned (no swap).
            poolManager.burn(address(this), uint256(uint160(t_)), maxIn);
            poolManager.take(Currency.wrap(t_), address(this), maxIn);
            return "";
        }
        Swap memory w;
        w.sqrtBefore = _slot0().sqrtPriceX96();
        BalanceDelta delta = poolManager.swap(
            _key(q_, t_),
            // casting to 'int256' is safe because maxIn is a ledger (uint128)
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: buy, amountSpecified: -int256(maxIn), sqrtPriceLimitX96: limit}),
            ""
        );
        (int128 dIn, int128 dOut) = buy ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (dIn > 0 || dOut < 0) revert UnexpectedDelta();
        // casting to 'uint128' is safe because dIn ≤ 0 and dOut ≥ 0 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        (w.amountIn, w.amountOut) = (uint256(uint128(-dIn)), uint256(uint128(dOut)));
        if (w.amountIn > maxIn) revert UnexpectedDelta();
        w.sqrtAfter = _slot0().sqrtPriceX96();
        if (buy ? w.sqrtAfter < limit : w.sqrtAfter > limit) revert PriceBoundBreached(w.sqrtAfter, limit);
        uint256 minOut_ = BoxSwapBounds.minOut(buy, w.amountIn, limit, swapFee);
        if (w.amountOut < minOut_) revert OutputBelowBound(w.amountOut, minOut_);
        uint256 tId = uint256(uint160(t_));
        if (w.amountIn != 0) poolManager.burn(address(this), buy ? 0 : tId, w.amountIn);
        if (buy) {
            if (w.amountOut != 0) {
                // The creator's T as claims to the receiver (booked to its payee right after); T to burn taken here.
                if (action == Action.BuyForCreator) poolManager.mint(_argAddress(_A_RECEIVER), tId, w.amountOut);
                else poolManager.take(Currency.wrap(t_), address(this), w.amountOut);
            }
            w.tip = tipTo == address(0) ? 0 : BoxSwapBounds.tipOf(w.amountIn);
            if (w.tip != 0) poolManager.burn(address(this), 0, w.tip);
        } else {
            w.tip = tipTo == address(0) ? 0 : BoxSwapBounds.tipOf(w.amountOut);
            if (w.amountOut > w.tip) poolManager.mint(_argAddress(_A_RECEIVER), 0, w.amountOut - w.tip);
        }
        // Last: a tip recipient's code runs after the trade (as deepen(), BoxHookExtension `_settleDepth`).
        if (w.tip != 0) poolManager.take(Currency.wrap(q_), tipTo, w.tip);
        return abi.encode(w);
    }

    // ================================================================== views

    /// @inheritdoc IBoxSwapModule
    function budgets()
        external
        view
        returns (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 tBurnPending)
    {
        Ledgers memory l = _l;
        return (_real(l.qBurn), _real(l.qCreator), _real(l.tForFit), _real(l.tForCreator), _real(l.tBurnPending));
    }

    /// @inheritdoc IBoxSwapModule
    function bounds(Action action) external view returns (bool ready, int24 referenceTick, uint160 sqrtPriceLimitX96) {
        bool buy = action == Action.BuyBurn || action == Action.BuyForCreator;
        int24 twapTick;
        int24 sampleTick;
        (ready, twapTick, sampleTick) = BoxSwapBounds.viewAverage(IBoxPriceAverage(_argAddress(_A_AVERAGE)));
        if (!ready) return (ready, 0, 0);
        referenceTick = BoxSwapBounds.referenceTick(buy, twapTick, sampleTick);
        sqrtPriceLimitX96 = BoxSwapBounds.stepLimit(buy, _slot0().sqrtPriceX96(), referenceTick);
        ready = sqrtPriceLimitX96 != 0;
    }

    /// @inheritdoc IBoxSwapModule
    function creatorFeesPending() external view returns (uint256 qFee, uint256 tFee) {
        uint256 q_ = _qBackCreator;
        return (q_ == 0 ? 0 : q_ - 1, _real(_l.tBackCreator));
    }

    /// @inheritdoc IBoxSwapModule
    function lastStepBlock() external view returns (uint256) {
        return (_s >> _O_STEP) & _M64;
    }

    /// @inheritdoc IBoxSwapModule
    function graduationSeen() external view returns (bool) {
        return _s & _B_GRADUATED != 0;
    }

    /// @inheritdoc IBoxSwapModuleWiring
    function wiring() external view returns (address, address, address, address) {
        (address q_, address t_) = _argAddress2(_A_Q);
        return (_argAddress(_A_RECEIVER), q_, t_, _argAddress(_A_HOOK));
    }

    /// @inheritdoc IBoxSwapModule
    function receiver() external view returns (address) {
        return _argAddress(_A_RECEIVER);
    }

    /// @inheritdoc IBoxSwapModule
    function hook() external view returns (address) {
        return _argAddress(_A_HOOK);
    }

    /// @inheritdoc IBoxSwapModule
    function priceAverage() external view returns (IBoxPriceAverage) {
        return IBoxPriceAverage(_argAddress(_A_AVERAGE));
    }

    /// @inheritdoc IBoxSwapModule
    function q() external view returns (address) {
        return _argAddress(_A_Q);
    }

    /// @inheritdoc IBoxSwapModule
    function token() external view returns (address) {
        return _argAddress(_A_TOKEN);
    }

    /// @inheritdoc IBoxSwapModule
    function actions() external view returns (uint8, uint8) {
        return (_argUint8(_A_Q_ACTION), _argUint8(_A_T_ACTION));
    }

    /// @notice The box's pool (its own closed pool: static 1% fee, spacing 60, the box's hook).
    function poolKey() external view returns (PoolKey memory) {
        (address q_, address t_) = _argAddress2(_A_Q);
        return _key(q_, t_);
    }

    // ================================================================== internals

    function _initialised() private view returns (uint256 s) {
        s = _s;
        // The implementation's word is _B_INIT too (its constructor), but its code is not a 147-byte clone: it acts for
        // no box.
        if (s & _B_INIT == 0 || address(this).code.length != 45 + ARGS_LENGTH) revert NotInitialised();
    }

    /// @dev Every guard of § 4.3 steps 2-6, in that order (NothingToDo before the price reads); fills `p`.
    function _plan(uint256 s, Action action, bool buy, Plan memory p) private returns (Stop) {
        if (!_graduated(s)) return Stop.NotGraduated;
        Ledgers storage l = _l;
        uint256 budget = _real(
            action == Action.BuyBurn
                ? l.qBurn
                : action == Action.BuyForCreator ? l.qCreator : action == Action.SellForFit ? l.tForFit : l.tForCreator
        );
        if (budget <= 1) return Stop.NothingToDo;
        p.spend = budget - 1;
        if (!BoxSwapBounds.stepDue((s >> _O_STEP) & _M64)) return Stop.BlockLimit;
        (bool ready, int24 twapTick, int24 sampleTick) =
            BoxSwapBounds.readAverage(IBoxPriceAverage(_argAddress(_A_AVERAGE)));
        if (!ready) return Stop.AverageNotReady;
        bytes32 slot = _stateSlot();
        if (uint256(poolManager.extsload(bytes32(uint256(slot) + _LIQUIDITY_OFFSET))) == 0) return Stop.NoLiquidity;
        Slot0 s0 = Slot0.wrap(poolManager.extsload(slot));
        p.refTick = BoxSwapBounds.referenceTick(buy, twapTick, sampleTick);
        p.limit = BoxSwapBounds.stepLimit(buy, s0.sqrtPriceX96(), p.refTick);
        if (p.limit == 0) return Stop.AtBand;
        if ((buy ? p.spend : BoxSwapBounds.tInQ(p.spend, p.refTick)) < BoxSpecV1.SWAP_STEP_MIN_Q) {
            return Stop.BelowStepMin;
        }
        (p.swapFee, p.lpShare) = BoxSwapBounds.fees(s0, buy);
        if (action == Action.SellForCreator) _planBurn(p, slot, s0);
        return Stop.None;
    }

    /// @dev § 13 point 7 (decided by size in S5.M3): with the creator's room for this epoch spent and add-on 5's
    /// excess BURN, a sale's Q would all be bought back and burned (two tips, two fees, the price between the legs);
    /// the T is burned instead. Bounded after the S5 review: every guard of a sale (`_plan`) applies first, and it burns
    /// at most what this one sale would have sold (BoxSwapBounds.sellInput to the sell limit), so a backlog leaves one
    /// step a block, as sales do, and what is left sells once a new epoch gives room.
    function _planBurn(Plan memory p, bytes32 slot, Slot0 s0) private view {
        (uint256 cap, uint8 ex,,, uint256 room) = IBoxReceiver(_argAddress(_A_RECEIVER)).creatorCap();
        if (cap == 0 || room != 0 || ex != BoxSpecV1.CAP_EXCESS_BURN) return;
        p.burn = true;
        uint256 most = BoxSwapBounds.sellInput(poolManager, slot, s0, p.limit, p.swapFee);
        if (most < p.spend) p.spend = most;
    }

    /// @dev § 13 point 7: `amount` of the creator's T (at most one sale's worth, within its ledger less the 1 raw unit
    /// it keeps) redeemed in this module's own unlock and burned (a burn the vault's floor refuses waits, as a
    /// BuyBurn's).
    function _burnCreatorT(uint256 amount) private returns (uint256) {
        _l.tForCreator -= _u128(amount);
        _l.tBurnPending += _u128(amount);
        poolManager.unlock(abi.encode(Action.None, amount, uint160(0), uint24(0), address(0)));
        emit CreatorTBurned(amount);
        _burnHeld();
        return amount;
    }

    /// @dev The step's block: one step per block per box, all actions together (a point-7 burn included).
    function _markStep() private {
        _s = (_s & ~(_M64 << _O_STEP)) | (block.number << _O_STEP);
    }

    /// @dev The step's unlock, with its block recorded first; a buy reserves its tip before sizing its input.
    function _swap(Action action, bool buy, Plan memory p, address tipTo) private returns (Swap memory) {
        _markStep();
        uint256 maxIn = buy ? p.spend - BoxSwapBounds.tipOf(p.spend) : p.spend;
        return abi.decode(poolManager.unlock(abi.encode(action, maxIn, p.limit, p.swapFee, tipTo)), (Swap));
    }

    /// @dev After the unlock: the ledgers, the burn of bought T, the proceeds booked in the receiver (FIT's Q, or the
    /// creator's T or Q; at most what arrived since this step's pull), and REV-16's note of the step's own LP fee, which
    /// a creator step also records as its own (§ 4.8).
    function _book(Action action, bool buy, Swap memory w, uint24 lpShare) private {
        IBoxReceiver r = IBoxReceiver(_argAddress(_A_RECEIVER));
        Ledgers storage l = _l;
        uint256 fee = BoxSwapBounds.feeNote(w.amountIn, lpShare);
        if (action == Action.BuyBurn) {
            l.qBurn -= _u128(w.amountIn + w.tip);
            l.tBurnPending += _u128(w.amountOut);
            _burnHeld();
        } else if (action == Action.BuyForCreator) {
            l.qCreator -= _u128(w.amountIn + w.tip);
            if (fee != 0) _qBackCreator += fee;
            if (w.amountOut != 0) r.moduleProceeds(ModuleProceedsTo.CreatorT, w.amountOut);
        } else {
            bool creator = action == Action.SellForCreator;
            if (creator) {
                l.tForCreator -= _u128(w.amountIn);
                l.tBackCreator += _u128(fee);
            } else {
                l.tForFit -= _u128(w.amountIn);
            }
            if (w.amountOut > w.tip) {
                r.moduleProceeds(creator ? ModuleProceedsTo.CreatorQ : ModuleProceedsTo.FitQ, w.amountOut - w.tip);
            }
        }
        if (fee != 0) {
            (uint256 qFee, uint256 tFee) = buy ? (fee, uint256(0)) : (uint256(0), fee);
            emit ModuleFeesReported(qFee, tFee);
            r.noteModuleFees(qFee, tFee);
        }
    }

    function _emitStepped(Action action, address tipTo, Plan memory p, Swap memory w) private {
        emit Stepped(action, w.amountIn, w.amountOut, w.tip, tipTo, p.refTick, w.sqrtBefore, w.sqrtAfter, p.limit);
    }

    /// @dev The hook's migration, latched once seen (FitBuybackExecutor `_graduated`).
    function _graduated(uint256 s) private returns (bool) {
        if (s & _B_GRADUATED != 0) return true;
        if (IBoxHook(_argAddress(_A_HOOK)).migratedAtBlock() == 0) return false;
        _s = _s | _B_GRADUATED;
        return true;
    }

    /// @dev Books what the receiver hands (zeros before its settlement), returned fees to the ledger that paid them
    /// (§ 4.8, deterministic and exact once every return arrived): returned Q first to the creator-buy ledger up to the
    /// fees its steps reported, the rest to the burn-buy ledger; returned T first to the creator-sell ledger likewise,
    /// the rest to the sell-for-FIT ledger.
    function _pull() private {
        (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 qBack, uint256 tBack) =
            IBoxReceiver(_argAddress(_A_RECEIVER)).pullForModule();
        if (qBurn | qCreator | tForFit | tForCreator | qBack | tBack == 0) return;
        Ledgers storage l = _l;
        // Only a CREATOR_IN_T box has the Q attribution slot (written by `initialize`).
        if (qBack != 0 && _argUint8(_A_Q_ACTION) == BoxSpecV1.Q_STREAM_CREATOR_IN_T) {
            uint256 owe = _qBackCreator - 1;
            uint256 c = qBack < owe ? qBack : owe;
            (_qBackCreator, qBack, qCreator) = (_qBackCreator - c, qBack - c, qCreator + c);
        }
        if (tBack != 0) {
            uint256 oweT = _real(l.tBackCreator);
            uint256 c = tBack < oweT ? tBack : oweT;
            if (c != 0) (l.tBackCreator, tBack, tForCreator) = (_u128(oweT + 1 - c), tBack - c, tForCreator + c);
        }
        if (qBurn | qBack != 0) l.qBurn += _u128(qBurn + qBack);
        if (qCreator != 0) l.qCreator += _u128(qCreator);
        if (tForFit | tBack != 0) l.tForFit += _u128(tForFit + tBack);
        if (tForCreator != 0) l.tForCreator += _u128(tForCreator);
        emit Pulled(qBurn, qCreator, tForFit, tForCreator, qBack, tBack);
    }

    /// @dev Burns the T held to burn less 1 raw unit (the T balance never returns to zero, § 6); a refused burn (the
    /// vault's supply floor) leaves it waiting, never counted as burned (BoxReceiver `_burnPending`; BC-016).
    function _burnHeld() private returns (uint256 amount) {
        uint256 held = _real(_l.tBurnPending);
        if (held <= 1) return 0;
        amount = held - 1;
        IBurnableBoxT t = IBurnableBoxT(_argAddress(_A_TOKEN));
        uint256 supplyBefore = t.totalSupply();
        try t.burn(amount) {
            if (t.totalSupply() + amount != supplyBefore) revert BurnDidNotReduceSupply();
            _l.tBurnPending = 2;
            emit TokensBurned(amount, 1);
        } catch {
            emit TokensBurned(0, held);
            return 0;
        }
    }

    function _key(address q_, address t_) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(q_),
            currency1: Currency.wrap(t_),
            fee: BoxSpecV1.LP_FEE,
            tickSpacing: BoxSpecV1.TICK_SPACING,
            hooks: IHooks(_argAddress(_A_HOOK))
        });
    }

    /// @dev The pool's Pool.State slot: keccak256(PoolId, POOLS_SLOT = 6) (StateLibrary @ 46c68346).
    function _stateSlot() private view returns (bytes32) {
        (address q_, address t_) = _argAddress2(_A_Q);
        return keccak256(abi.encodePacked(keccak256(abi.encode(_key(q_, t_))), bytes32(uint256(6))));
    }

    function _slot0() private view returns (Slot0) {
        return Slot0.wrap(poolManager.extsload(_stateSlot()));
    }

    /// @dev A ledger's amount: stored plus 1 once `initialize` ran (0 before, so the views read zeros).
    function _real(uint128 stored) private pure returns (uint256) {
        return stored == 0 ? 0 : uint256(stored) - 1;
    }

    function _u128(uint256 x) private pure returns (uint128) {
        // Raw Q and T amounts are far below 2^128 (T issuance 1e27).
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(x);
    }
}
