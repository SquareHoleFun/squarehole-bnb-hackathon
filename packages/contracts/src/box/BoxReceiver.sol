// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types; DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {BoxReceiverBase} from "./BoxReceiverBase.sol";
import {BoxReceiverExtension} from "./BoxReceiverExtension.sol";
import {IBoxCoordinator} from "./interfaces/IBoxCoordinator.sol";
import {IBoxHook, IBoxPriceQuote} from "./interfaces/IBoxHook.sol";
import {IBoxItemStream} from "./interfaces/IBoxItemStream.sol";
import {IBoxReceiver, IFitBuybackExecutor, IBoxStreamSettlement} from "./interfaces/IBoxReceiver.sol";
import {BoxKind, FeeBatch, ModuleProceedsTo, RoyaltyDestination} from "./interfaces/BoxTypes.sol";

interface IBurnableBoxToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function burn(uint256 amount) external;
}

/// @title BoxReceiver (slice S5; the implementation behind every box's receiver clone)
/// @notice See `IBoxReceiver` for the behaviour. Generalises FitFeeCollector (src/v2/FitFeeCollector.sol:43-151):
/// the claims-first custody and their redemption in its own unlock (`:96-100`, `:131-145`), the T burn that must
/// lower supply and otherwise waits (`:117-127`), ETH accepted only from the PoolManager inside its own call
/// (`:147-150`), with D2 (batches, `collect` instead of per-swap notices `:84-92`), D6 (the reserve is the hook's,
/// minted to the coordinator), F59, F62, F64, F65, F68, F69 C1, F72 and F77:
/// - **Custody:** every ledger is held as ERC-6909 claims on the PoolManager until it is paid out; Q and T claims not
///   yet in a ledger are the next batch. So fees the hook mints outside `collect` (the migration's last poke and its
///   Q dust, `deepen()`'s poke of the pair) join the next batch with nothing lost or counted twice.
/// - **Splits** (BoxSpecV1 FEE_SHARE_*, BOX0_FEE_SHARE_*): exact fifteenths with the remainder carried per side.
///   Box 0 (F77, like every box): Q 11/15 FIT (held until graduation, BC-020), 2/15 to depth, 2/15 = P under the cap
///   (`_capPlatform`); T 13/15 burned (or to the per-item stream after graduation, S8), 2/15 to depth. Other boxes:
///   each side 10/15 reward, 3/15 FIT (Q; T waits in `fitWaitingT`), 2/15 to depth.
/// - **Depth** (pair and lock, F72 (B); one hold rule for every box, F77): the depth parts are held here before
///   graduation (`depthHeld`; BC-109: the refund range's at a failure, S11; box 0 has none), then moved whole to the
///   hook's claims at the settlement, and at once after. Box 0's depth T is never redeemed, so a refused burn or a
///   failed stream notice never touches it (BC-139).
/// - **The cap** (R F62; BC-106): epoch = ⌊(now − graduatedAt) / PLATFORM_EPOCH_SECONDS⌋; keep = min(P,
///   PLATFORM_CAP_WEI − kept this epoch), the rest at once into the hook's claims (box 0's depth); no carry-over; the
///   graduation settlement (the pre-graduation P held, then the claims the final harvest left) counts in epoch 0,
///   however late it runs (review of sh-core-v1).
/// - **v1 builds** box 0's split and stream call, ALL_TO_FIT, BURN_T and TO_CREATOR on either side (paid as
///   collected, F72 (A)) and, since S5.M1, the swap module's four actions (BUYBACK_BURN_T and CREATOR_IN_T on the Q
///   side, SELL_FOR_Q and CREATOR_IN_Q on the T side), and refuses at `initialize` what needs S14 or S12
///   (`ActionNotBuilt`; core-v1-interfaces § 5 item 10): HOLDERS_IN_* (7), the PAY_HOLDERS_* values and BURN_Q. The
///   payout currency is part of the stream value, so there is no separate payout mode; v1 serves native-ETH Q
///   (`QNotSupported` otherwise; S12).
/// - **The swap module** (S5.M1; docs/design/swap-module-v1.md § 4.1-4.2, § 4.7-4.8): every Standard box names one
///   (W4 makes every Standard box sell), box 0 none. The split books its Q and T into the module's ledgers, held until
///   the settlement; nothing moves to it inside `collect()`. The module pulls (`pullForModule`: each ledger less 1 raw
///   unit, by ERC-6909 transfer, which records the step's snapshot in transient storage and adds 1% of what it hands
///   to its fee-note allowance), books its proceeds (`moduleProceeds`: at most the claims that arrived since that
///   snapshot and are in no ledger, so never the next batch) and notes its own swap fees (`noteModuleFees`, within the
///   allowance; the rest clipped). REV-16 returns them in the next batch before the tip and the split; the hook's
///   conversion fees (S5.M5) go back to the hook's claims.
/// - **The creator-fee cap** (add-on 5, S5.M3; R F74 U2, F75 U9; swap-module § 4.1-4.2): a Standard box's clone
///   arguments may carry a cap per 30-day epoch (Q raw units) and its excess destination. Every creator payout with a Q
///   amount counts at face when it becomes owed: TO_CREATOR Q and royalties (`fundCreator`) when credited,
///   CREATOR_IN_T at the Q handed for its buy (at the split), CREATOR_IN_Q at the Q its sale paid (`moduleProceeds`).
///   T paid as T (TO_CREATOR on the sellers' side) has no Q amount: it stays held (`creatorHeld`) until a `collect()`
///   finds the box's sampler ready (`quoteTInQ`, the 1-hour average, rounded up; in try/catch, so no path ever waits
///   for it) and passes the cap then. Curve-time payouts count in epoch 0 at the settlement, however late it runs.
///   The excess goes where the arguments say, in the currency it arrived in: BURN (Q to the module's burn-buy ledger,
///   which buys T and burns it; T burned here) or POOL_DEPTH (the hook's claims). Box 0's platform cap and this cap
///   share one epoch counter: a box has at most one of them.
/// - **Only the box's coordinator initialises**, and it must be a clone of the version's coordinator implementation
///   (`coordinatorImplementation`, whose `deploy` and `launch` only the factory can call): a stranger's clone of this
///   code stays inert (BC-100; review of sh-core-v1, S0 decision 7).
/// - **Two halves** (S5.M1's size gate, swap-module § 7; `BoxReceiverBase`): this code is the hot half; `initialize`
///   and the payee changes run in `extension` (`BoxReceiverExtension`) by DELEGATECALL, as the hook runs `launch`,
///   `migrate` and `deepen` in its extension.
///
/// **Clone arguments** (`abi.encodePacked`, 201 bytes): `kind` (1) · `q` (20) · `token` (20) · `coordinator` (20) ·
/// `hook` (20) · `executor` (20) · `platformSafe` (20; zero for every box but box 0) · `itemStream` (20; zero but
/// box 0's) · `qStream` (1) · `tStream` (1) · `royaltyDestination` (1) · initial `creatorPayee` (20; the spec's
/// `creatorFeeRecipient`) · `swapModule` (20; S5.M1: every Standard box's, zero for box 0) · `creatorCap` (16; S5.M3,
/// add-on 5's `capPerEpoch` in Q raw units, zero without it and for box 0) · `capExcess` (1; its `excess`).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2). Other boxes have no platform payee: their
/// `platformSafe` argument must be zero and `payPlatform` reverts (BC-109, BC-021).
contract BoxReceiver is IBoxReceiver, IBoxStreamSettlement, BoxReceiverBase {
    /// @notice The extension names another coordinator implementation than this code.
    error ExtensionMismatch(address extension);
    /// @notice A collect or settlement was sent with too little gas to give the stream its whole cap (EIP-150).
    error StreamGasTooLow(uint256 gasLeft, uint256 required);

    // ------------------------------------------------------------------ version constants

    /// @inheritdoc IBoxReceiver
    uint256 public constant FEE_SHARE_DENOMINATOR = BoxSpecV1.FEE_SHARE_DENOMINATOR;
    /// @inheritdoc IBoxReceiver
    uint256 public constant TIP_BPS = BoxSpecV1.FEE_BATCH_TIP_BPS;
    /// @inheritdoc IBoxReceiver
    uint256 public constant PLATFORM_CAP_WEI = BoxSpecV1.PLATFORM_CAP_WEI;
    /// @inheritdoc IBoxReceiver
    uint256 public constant PLATFORM_EPOCH_SECONDS = BoxSpecV1.PLATFORM_EPOCH_SECONDS;
    /// @notice Gas the per-item stream's `onStreamFunds` gets (capped and fail-safe, as FitPoolHook.sol:159-166):
    /// BoxSpecV1.STREAM_NOTIFY_GAS (a literal here for the assembly call; BoxSpecV1Vectors pins the two equal). S8
    /// measured the stream's notice with its burn at 99,555 gas today and 124,880 under Glamsterdam from cold and raised
    /// it from 100,000 (SH-S8-stream § 5).
    uint256 public constant STREAM_NOTIFY_GAS = 200_000;
    /// @notice Length of the clone arguments.
    uint256 public constant ARGS_LENGTH = 201;

    uint256 private constant _STREAM_GAS_REQUIRED = STREAM_NOTIFY_GAS + STREAM_NOTIFY_GAS / 63 + 5_000;
    /// @dev Add-on 5's epoch (S5.M3): 30 days from graduation, as box 0's platform epoch.
    uint256 private constant _CREATOR_EPOCH_SECONDS = BoxSpecV1.ADD_ON_CREATOR_FEE_CAP_EPOCH_SECONDS;

    uint8 private constant _ACT_REDEEM = 1;
    uint8 private constant _ACT_DEPOSIT = 2;

    /// @dev The step's snapshot (S5.M1), in transient storage: this contract's Q claims + 1 after `pullForModule`,
    /// advanced by each booking (the T claims' at the next slot); zero: no pull in this transaction.
    /// `uint256(keccak256("squarehole.receiver.module.snapshot.q")) - 1`.
    uint256 private constant _SNAP = 0xd51179e6eabe3da5d3cd770323c492b96daf34d73e03ae7bc5e9bc174ad3a1bb;

    /// @dev One batch's split, for the event.
    struct Split {
        uint256 qReward;
        uint256 qFit;
        uint256 qDepth;
        uint256 qPlatform;
        uint256 tReward;
        uint256 tFit;
        uint256 tDepth;
        uint256 tBurned;
        uint256 tToStream;
    }

    IPoolManager public immutable poolManager;
    /// @inheritdoc IBoxReceiver
    address public immutable coordinatorImplementation;
    /// @inheritdoc IBoxReceiver
    address public immutable extension;

    constructor(IPoolManager poolManager_, address coordinatorImplementation_, address extension_) {
        if (BoxReceiverExtension(extension_).coordinatorImplementation() != coordinatorImplementation_) {
            revert ExtensionMismatch(extension_);
        }
        poolManager = poolManager_;
        coordinatorImplementation = coordinatorImplementation_;
        extension = extension_;
        // The implementation is never a box's receiver.
        _s = _B_INIT;
    }

    // ================================================================== lifecycle

    /// @inheritdoc IBoxReceiver
    /// @dev In the extension (S5.M1's split).
    function initialize() external {
        _forward();
    }

    // ================================================================== batches

    /// @inheritdoc IBoxReceiver
    function collect(address tipTo) external nonReentrantCall returns (FeeBatch memory batch) {
        _initialised();
        bool graduated = _settleIfDue();
        uint256 harvestedQ;
        (harvestedQ, batch.t, batch.qToReserve) = IBoxHook(_argAddress(_A_HOOK)).harvest();
        (uint256 newQ, uint256 newT) = _unbooked();
        batch.q = newQ + batch.qToReserve;
        batch.t = newT;
        uint256 minQ = batchMin();
        if (batch.q < minQ) revert BatchTooSmall(batch.q, minQ);
        // REV-16 first: the box's own swaps' fees go back whole (BC-019, BC-133).
        (uint256 restQ, uint256 restT) = _returnFees(newQ, newT);
        uint256 tip = newQ * TIP_BPS / 10_000;
        if (tip > tipMax()) tip = tipMax();
        if (tip > restQ) tip = restQ;
        batch.tip = tip;
        Split memory sp = _split(restQ - tip, restT, graduated, false);
        emit Collected(msg.sender, tipTo, batch.q, batch.t, batch.qToReserve, tip);
        _emitSplit(sp);
        // Add-on 5: T paid as T passes the cap once the sampler can value it; a BURN excess burns with the batch's T.
        if (graduated) sp.tBurned += _valueHeldT();
        _payOut(tipTo, tip, sp);
        harvestedQ; // the hook's figure is informational: the claims themselves are the accounting
    }

    /// @inheritdoc IBoxReceiver
    function onGraduation() external nonReentrantCall {
        _initialised();
        if (!_graduated()) revert NotGraduated();
        if (_s & _B_SETTLED != 0) revert AlreadySettled();
        _settleGraduation();
    }

    /// @inheritdoc IBoxReceiver
    /// @dev In the extension (S5.M1's split): its callers (the module, FIT's executor, the hook) note once a step.
    function noteModuleFees(uint256, uint256) external {
        _forward();
    }

    // ================================================================== the swap module's hand-off (S5.M1)

    /// @inheritdoc IBoxReceiver
    function pullForModule()
        external
        nonReentrantCall
        returns (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 qBack, uint256 tBack)
    {
        _initialised();
        address m = _onlyModule();
        // Nothing before the settlement (BC-130): no hand-over, no snapshot.
        if (!_settleIfDue()) return (0, 0, 0, 0, 0, 0);
        ModuleLedgers storage x = _m;
        (qBurn, x.qBurn) = _hand(x.qBurn);
        (qCreator, x.qCreator) = _hand(x.qCreator);
        (qBack, _l.moduleBackQ) = _hand(_l.moduleBackQ);
        (tForCreator, x.tForCreator) = _hand(x.tForCreator);
        (tBack, _l.moduleBackT) = _hand(_l.moduleBackT);
        (tForFit, _l.fitWaitingT) = _hand(_l.fitWaitingT);
        uint256 tId = uint256(uint160(_argAddress(_A_TOKEN)));
        uint256 q_ = qBurn + qCreator + qBack;
        uint256 t_ = tForFit + tForCreator + tBack;
        // The allowance: the most the module's swaps of what it was handed can pay the pool (LP_FEE of the input).
        x.allowanceQ += _u128(q_ * BoxSpecV1.LP_FEE / 1_000_000);
        x.allowanceT += _u128(t_ * BoxSpecV1.LP_FEE / 1_000_000);
        // ERC-6909 transfers: no token code runs.
        if (q_ != 0) poolManager.transfer(m, 0, q_);
        if (t_ != 0) poolManager.transfer(m, tId, t_);
        uint256 sq = poolManager.balanceOf(address(this), 0) + 1;
        uint256 st = poolManager.balanceOf(address(this), tId) + 1;
        assembly ("memory-safe") {
            tstore(_SNAP, sq)
            tstore(add(_SNAP, 1), st)
        }
        emit ModulePulled(qBurn, qCreator, tForFit, tForCreator, qBack, tBack);
    }

    /// @inheritdoc IBoxReceiver
    function moduleProceeds(ModuleProceedsTo dest, uint256 amount) external nonReentrantCall {
        _initialised();
        _onlyModule();
        bool isT = dest == ModuleProceedsTo.CreatorT;
        uint256 slot = isT ? _SNAP + 1 : _SNAP;
        uint256 snap;
        assembly ("memory-safe") {
            snap := tload(slot)
        }
        if (snap == 0) revert NoStepOpen();
        (uint256 qb, uint256 tb) = booked();
        uint256 bal = poolManager.balanceOf(address(this), isT ? uint256(uint160(_argAddress(_A_TOKEN))) : 0);
        // At most what arrived since the snapshot (snap − 1) and is in no ledger: never the next batch, never an
        // arrival booked already, never what a collect inside the step booked.
        uint256 room = bal >= snap ? bal + 1 - snap : 0;
        uint256 free = bal - (isT ? tb : qb);
        if (free < room) room = free;
        // Only where the box's streams pay: FIT's Q (W4, SELL_FOR_Q) always, the creator's per CREATOR_IN_Q (Q) or
        // CREATOR_IN_T (T). One read of both stream bytes: Q stream then T stream.
        uint256 streams = _argUint(_A_Q_STREAM, 2);
        if (!(dest == ModuleProceedsTo.FitQ
                    || (dest == ModuleProceedsTo.CreatorQ && streams & 0xff == BoxSpecV1.T_STREAM_CREATOR_IN_Q)
                    || (isT && streams >> 8 == BoxSpecV1.Q_STREAM_CREATOR_IN_T))) room = 0;
        if (amount > room) revert ProceedsTooLarge(amount, room);
        assembly ("memory-safe") {
            tstore(slot, add(snap, amount))
        }
        if (dest == ModuleProceedsTo.FitQ) {
            _l.fitOwed += _u128(amount);
            _t.toFit += _u128(amount);
        } else {
            // Owed at once (a step runs only after the settlement); creator Q through add-on 5's cap at face, the T a
            // CREATOR_IN_T buy bought never again (its Q counted at the split).
            _creditCreator(isT ? 0 : amount, isT ? amount : 0, true, false);
        }
        emit ModuleProceeds(dest, amount);
    }

    // ================================================================== ETH intake (hook point receiver.ethIntake)

    /// @inheritdoc IBoxReceiver
    function fundFees() external payable nonReentrantCall {
        _initialised();
        uint256 amount = msg.value;
        if (amount == 0) return;
        bool graduated = _settleIfDue();
        // Claims first (as every fee), then the split of a batch without tip or minimum.
        poolManager.unlock(abi.encode(_ACT_DEPOSIT, abi.encode(amount, address(this))));
        emit FeesFunded(msg.sender, amount);
        Split memory sp = _split(amount, 0, graduated, false);
        _emitSplit(sp);
    }

    /// @inheritdoc IBoxReceiver
    /// @dev Takes this contract's whole ETH balance: `msg.value` plus any ETH forced in, which is never fees and may
    /// only join the depth budget (BC-107). Every box holds it here until graduation, like its 2/15 (BC-109, F77).
    function fundDepth() external payable nonReentrantCall {
        _initialised();
        bool hold = !_settleIfDue();
        uint256 amount = address(this).balance;
        if (amount == 0) return;
        _t.qToDepth += _u128(amount);
        poolManager.unlock(abi.encode(_ACT_DEPOSIT, abi.encode(amount, hold ? address(this) : _argAddress(_A_HOOK))));
        emit DepthGifted(msg.sender, amount);
        if (hold) {
            _l.depthHeldQ += _u128(amount);
            emit DepthHeld(amount, 0);
        } else {
            emit DepthFunded(amount, 0);
        }
    }

    /// @inheritdoc IBoxReceiver
    /// @dev The Creator royalty destination (review of sh-core-v1): the box's royalty router flushes here, so ERC-2981
    /// names a receiver that never refuses a payment, and the one payee (F72 (3)) pulls with `claimCreator`.
    function fundCreator() external payable nonReentrantCall {
        _initialised();
        if (RoyaltyDestination(_argUint(_A_ROYALTY, 1)) != RoyaltyDestination.Creator) revert NotCreatorRoyalties();
        uint256 amount = msg.value;
        if (amount == 0) return;
        bool graduated = _settleIfDue();
        poolManager.unlock(abi.encode(_ACT_DEPOSIT, abi.encode(amount, address(this))));
        emit CreatorFunded(msg.sender, amount);
        // Royalties for the creator count under add-on 5's cap like every creator payout in Q (P, SH-S5-swap M3).
        _creditCreator(amount, 0, graduated, false);
    }

    // ================================================================== payouts (pulled, or triggered by anyone)

    /// @inheritdoc IBoxReceiver
    function payFit() external nonReentrantCall returns (uint256 amount) {
        _initialised();
        if (!_settleIfDue()) revert NotGraduated();
        address exec = _argAddress(_A_EXECUTOR);
        // Other boxes' FIT share waits until FIT itself graduated (its executor buys nothing before, BC-102).
        if (_argUint(_A_KIND, 1) != uint8(BoxKind.Box0) && !IFitBuybackExecutor(payable(exec)).fitGraduated()) {
            revert NotGraduated();
        }
        amount = _l.fitOwed;
        if (amount == 0) revert NothingOwed();
        _l.fitOwed = 0;
        _redeem(address(0), address(this), amount);
        emit FitPaid(exec, amount);
        // The executor is a clone argument: FIT's fixed executor, never a caller's choice.
        // forge-lint: disable-next-line(arbitrary-send-eth)
        IFitBuybackExecutor(payable(exec)).fundBudget{value: amount}();
    }

    /// @inheritdoc IBoxReceiver
    function payPlatform() external nonReentrantCall returns (uint256 amount) {
        _initialised();
        if (_argUint(_A_KIND, 1) != uint8(BoxKind.Box0)) revert NotBox0();
        _settleIfDue();
        amount = _l.platformOwed;
        if (amount == 0) revert NothingOwed();
        _l.platformOwed = 0;
        address safe = _argAddress(_A_SAFE);
        emit PlatformPaid(safe, amount);
        // The PoolManager pays the fixed Safe directly; if it refuses, all of this reverts and the credit stays.
        _redeem(address(0), safe, amount);
    }

    /// @inheritdoc IBoxReceiver
    function claimCreator(address to) external nonReentrantCall returns (uint256 qAmount, uint256 tAmount) {
        _initialised();
        address payee = creatorPayee();
        if (msg.sender != payee || payee == address(0)) revert NotPayee(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        _settleIfDue();
        qAmount = _l.creatorOwedQ;
        tAmount = _l.creatorOwedT;
        if (qAmount | tAmount == 0) revert NothingOwed();
        (_l.creatorOwedQ, _l.creatorOwedT) = (0, 0);
        emit CreatorClaimed(payee, to, qAmount, tAmount);
        if (qAmount != 0) _redeem(address(0), to, qAmount);
        if (tAmount != 0) _redeem(_argAddress(_A_TOKEN), to, tAmount);
    }

    /// @inheritdoc IBoxReceiver
    /// @dev In the extension (S5.M1's split).
    function proposeCreatorPayee(address) external {
        _forward();
    }

    /// @inheritdoc IBoxReceiver
    /// @dev In the extension (S5.M1's split).
    function acceptCreatorPayee() external {
        _forward();
    }

    /// @notice PoolManager callback of this contract's own unlocks (inside its guarded calls only).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert NotPoolManager();
        (uint8 action, bytes memory arg) = abi.decode(data, (uint8, bytes));
        if (action == _ACT_DEPOSIT) {
            (uint256 amount, address to) = abi.decode(arg, (uint256, address));
            poolManager.sync(Currency.wrap(address(0)));
            if (poolManager.settle{value: amount}() != amount) revert PaymentFailed();
            poolManager.mint(to, 0, amount);
            return "";
        }
        (address[] memory assets, address[] memory tos, uint256[] memory amounts) =
            abi.decode(arg, (address[], address[], uint256[]));
        for (uint256 i; i < assets.length; ++i) {
            poolManager.burn(address(this), uint256(uint160(assets[i])), amounts[i]);
            poolManager.take(Currency.wrap(assets[i]), tos[i], amounts[i]);
        }
        return "";
    }

    /// @notice Native ETH only from the PoolManager, inside this contract's own guarded calls.
    receive() external payable {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert EthRefused(msg.sender);
    }

    // ================================================================== views: wiring

    /// @inheritdoc IBoxReceiver
    function kind() external view returns (BoxKind) {
        return BoxKind(_argUint(_A_KIND, 1));
    }

    /// @inheritdoc IBoxReceiver
    function coordinator() external view returns (address) {
        return _argAddress(_A_COORDINATOR);
    }

    /// @inheritdoc IBoxReceiver
    function hook() external view returns (address) {
        return _argAddress(_A_HOOK);
    }

    /// @inheritdoc IBoxReceiver
    function token() external view returns (address) {
        return _argAddress(_A_TOKEN);
    }

    /// @inheritdoc IBoxReceiver
    function q() external view returns (address) {
        return _argAddress(_A_Q);
    }

    /// @inheritdoc IBoxReceiver
    function executor() external view returns (address) {
        return _argAddress(_A_EXECUTOR);
    }

    /// @inheritdoc IBoxReceiver
    function platformSafe() external view returns (address) {
        return _argAddress(_A_SAFE);
    }

    /// @inheritdoc IBoxReceiver
    function itemStream() external view returns (address) {
        return _argAddress(_A_STREAM);
    }

    /// @inheritdoc IBoxReceiver
    function qStream() external view returns (uint8) {
        return _argUint8(_A_Q_STREAM);
    }

    /// @inheritdoc IBoxReceiver
    function tStream() external view returns (uint8) {
        return _argUint8(_A_T_STREAM);
    }

    /// @inheritdoc IBoxReceiver
    function royaltyDestination() external view returns (RoyaltyDestination) {
        return RoyaltyDestination(_argUint(_A_ROYALTY, 1));
    }

    /// @inheritdoc IBoxReceiver
    function creatorPayee() public view returns (address) {
        return _payee();
    }

    /// @inheritdoc IBoxReceiver
    function pendingCreatorPayee() external view returns (address) {
        return _pendingPayee;
    }

    // ================================================================== views: ledgers

    /// @inheritdoc IBoxStreamSettlement
    function streamCurveDepthT() external view returns (uint256) {
        return _s & _B_SETTLED == 0 ? _l.depthHeldT : _streamCurveDepthT;
    }

    /// @inheritdoc IBoxReceiver
    function graduationSettled() external view returns (bool) {
        return _s & _B_SETTLED != 0;
    }

    /// @inheritdoc IBoxReceiver
    function platformEpoch() external view returns (uint256 epoch, uint256 kept, uint256 remaining) {
        if (_argUint(_A_KIND, 1) != uint8(BoxKind.Box0)) return (0, 0, 0);
        return _capView(PLATFORM_CAP_WEI, PLATFORM_EPOCH_SECONDS);
    }

    /// @inheritdoc IBoxReceiver
    function creatorCap()
        external
        view
        returns (uint256 capPerEpoch, uint8 excess, uint256 epoch, uint256 kept, uint256 remaining)
    {
        capPerEpoch = _argUint(_A_CAP, 16);
        if (capPerEpoch == 0) return (0, 0, 0, 0, 0);
        excess = _argUint8(_A_CAP_EXCESS);
        (epoch, kept, remaining) = _capView(capPerEpoch, _CREATOR_EPOCH_SECONDS);
    }

    /// @inheritdoc IBoxReceiver
    function platformOwed() external view returns (uint256) {
        return _l.platformOwed;
    }

    /// @inheritdoc IBoxReceiver
    function platformHeld() external view returns (uint256) {
        return _l.platformHeld;
    }

    /// @inheritdoc IBoxReceiver
    function fitOwed() external view returns (uint256) {
        return _l.fitOwed;
    }

    /// @inheritdoc IBoxReceiver
    function fitWaitingT() external view returns (uint256) {
        return _l.fitWaitingT;
    }

    /// @inheritdoc IBoxReceiver
    function depthHeld() external view returns (uint256 qAmount, uint256 tAmount) {
        return (_l.depthHeldQ, _l.depthHeldT);
    }

    /// @inheritdoc IBoxReceiver
    function creatorOwed() external view returns (uint256 qAmount, uint256 tAmount) {
        return (_l.creatorOwedQ, _l.creatorOwedT);
    }

    /// @inheritdoc IBoxReceiver
    function creatorHeld() external view returns (uint256 qAmount, uint256 tAmount) {
        return (_l.creatorHeldQ, _l.creatorHeldT);
    }

    /// @inheritdoc IBoxReceiver
    function moduleFeesPending() external view returns (uint256 qAmount, uint256 tAmount) {
        return (_l.moduleQPending, _l.moduleTPending);
    }

    /// @inheritdoc IBoxReceiver
    function hookFeesPending() external view returns (uint256) {
        return _s >> _O_HOOK_FEES;
    }

    /// @inheritdoc IBoxReceiver
    function swapModule() external view returns (address) {
        return _argAddress(_A_MODULE);
    }

    /// @inheritdoc IBoxReceiver
    function moduleOwed() external view returns (uint256, uint256, uint256, uint256, uint256, uint256, bool) {
        ModuleLedgers storage x = _m;
        Ledgers storage l = _l;
        return (x.qBurn, x.qCreator, l.fitWaitingT, x.tForCreator, l.moduleBackQ, l.moduleBackT, _s & _B_SETTLED == 0);
    }

    /// @inheritdoc IBoxReceiver
    function moduleFeeAllowance() external view returns (uint256, uint256) {
        // Stored plus 1 for a box with a module (BoxReceiverExtension.initialize); box 0's are 0.
        (uint256 aq, uint256 at) = (_m.allowanceQ, _m.allowanceT);
        return (aq == 0 ? 0 : aq - 1, at == 0 ? 0 : at - 1);
    }

    /// @inheritdoc IBoxReceiver
    function totals()
        external
        view
        returns (
            uint256 toFit,
            uint256 toPlatform,
            uint256 qToDepth,
            uint256 tToDepth,
            uint256 tBurned,
            uint256 qToCreator,
            uint256 tToCreator
        )
    {
        Totals memory t = _t;
        return (t.toFit, t.toPlatform, t.qToDepth, t.tToDepth, t.tBurned, t.qToCreator, t.tToCreator);
    }

    /// @notice The T waiting to be burned because the last burn was refused (real T held here, not claims).
    function tBurnPending() external view returns (uint256) {
        return _l.tBurnPending;
    }

    /// @notice The Q and T remainders (below one fifteenth) carried to the next batch, held as claims.
    function carried() external view returns (uint256 qCarry, uint256 tCarry) {
        uint256 s = _s;
        return ((s >> _O_QCARRY) & _M8, (s >> _O_TCARRY) & _M8);
    }

    /// @notice The Q and T claims every ledger holds (the rest of this contract's claims is the next batch).
    function booked() public view returns (uint256 qBooked, uint256 tBooked) {
        Ledgers storage l = _l;
        uint256 s = _s;
        qBooked = uint256(l.fitOwed) + l.platformOwed + l.platformHeld + l.creatorOwedQ + l.creatorHeldQ + l.depthHeldQ
            + ((s >> _O_QCARRY) & _M8);
        tBooked = uint256(l.creatorOwedT) + l.creatorHeldT + l.fitWaitingT + l.depthHeldT + ((s >> _O_TCARRY) & _M8);
        // The swap module's ledgers (a Standard box's; box 0 has none, so its collects read none of them).
        if (_argAddress(_A_MODULE) != address(0)) {
            ModuleLedgers storage x = _m;
            qBooked += uint256(x.qBurn) + x.qCreator + l.moduleBackQ;
            tBooked += uint256(x.tForCreator) + l.moduleBackT;
        }
    }

    // ================================================================== views: version constants

    /// @inheritdoc IBoxReceiver
    function batchMin() public pure returns (uint256) {
        return BoxSpecV1.FEE_BATCH_MIN_ETH;
    }

    /// @inheritdoc IBoxReceiver
    function tipMax() public pure returns (uint256) {
        return BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    }

    // ================================================================== internals: splits

    /// @dev One batch's split (no tip, no minimum here). Books Q and T claims into ledgers, credits the depth parts
    /// (`_creditDepth`), and marks T to burn or to stream (paid out after, by `_payOut`). `atSettlement`: the graduation
    /// settlement's split, whose platform share counts in epoch 0.
    function _split(uint256 qAmount, uint256 tAmount, bool graduated, bool atSettlement)
        private
        returns (Split memory sp)
    {
        bool box0 = _argUint(_A_KIND, 1) == uint8(BoxKind.Box0);
        uint256 s = _s;
        uint256 qTotal = qAmount + ((s >> _O_QCARRY) & _M8);
        uint256 qUnit = qTotal / FEE_SHARE_DENOMINATOR;
        uint256 qCarry = qTotal % FEE_SHARE_DENOMINATOR;
        uint256 tTotal = tAmount + ((s >> _O_TCARRY) & _M8);
        uint256 tUnit = tTotal / FEE_SHARE_DENOMINATOR;
        uint256 tCarry = tTotal % FEE_SHARE_DENOMINATOR;
        if (box0) {
            // F77: Q 11/15 FIT, 2/15 its own pool, 2/15 P under the cap; T 13/15 burned (or streamed), 2/15 its own
            // pool. Exact fifteenths: the unit first, the remainder carried (divide-then-multiply on purpose).
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.qFit = qUnit * BoxSpecV1.BOX0_FEE_SHARE_FIT;
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.qDepth = qUnit * BoxSpecV1.FEE_SHARE_DEPTH;
            // forge-lint: disable-next-line(divide-before-multiply)
            uint256 p = qUnit * BoxSpecV1.BOX0_FEE_SHARE_PLATFORM;
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.tDepth = tUnit * BoxSpecV1.FEE_SHARE_DEPTH;
            // forge-lint: disable-next-line(divide-before-multiply)
            uint256 tRest = tUnit * BoxSpecV1.BOX0_FEE_SHARE_T_BURN;
            _l.fitOwed += _u128(sp.qFit);
            _t.toFit += _u128(sp.qFit);
            _creditDepth(sp.qDepth, sp.tDepth, graduated);
            if (graduated) {
                uint256 excess;
                // The cap credits its excess to depth itself; the event reports all of the batch's Q depth.
                (sp.qPlatform, excess) = _capPlatform(p, atSettlement);
                sp.qDepth += excess;
            } else {
                _l.platformHeld += _u128(p); // counts in epoch 0 (BC-106)
            }
            // T side: 13/15 burned, or the per-item stream after graduation (S8); the 2/15 is never redeemed.
            if (graduated && _argAddress(_A_STREAM) != address(0)) sp.tToStream = tRest;
            else sp.tBurned = tRest;
        } else {
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.qReward = qUnit * BoxSpecV1.FEE_SHARE_Q_STREAM;
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.qFit = qUnit * BoxSpecV1.FEE_SHARE_FIT;
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.qDepth = qUnit * BoxSpecV1.FEE_SHARE_DEPTH;
            _l.fitOwed += _u128(sp.qFit);
            _t.toFit += _u128(sp.qFit);
            _rewardQ(sp.qReward, graduated, atSettlement);
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.tReward = tUnit * BoxSpecV1.FEE_SHARE_Q_STREAM;
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.tFit = tUnit * BoxSpecV1.FEE_SHARE_FIT;
            // forge-lint: disable-next-line(divide-before-multiply)
            sp.tDepth = tUnit * BoxSpecV1.FEE_SHARE_DEPTH;
            uint8 ts = _argUint8(_A_T_STREAM);
            if (ts == BoxSpecV1.T_STREAM_TO_CREATOR) {
                // Add-on 5: T paid as T has no Q amount, so with a cap it stays held until the sampler values it
                // (`_valueHeldT`, in collect); without one it is owed at once after graduation.
                _creditCreator(0, sp.tReward, graduated && _argUint(_A_CAP, 16) == 0, false);
            } else if (ts == BoxSpecV1.T_STREAM_CREATOR_IN_Q) {
                _m.tForCreator += _u128(sp.tReward); // the module sells it for the creator (S5.M3)
            } else if (ts == BoxSpecV1.T_STREAM_SELL_FOR_Q && graduated) {
                sp.tFit += sp.tReward; // sold by the module with FIT's share, its Q to FIT (W4)
            } else {
                // BURN_T; SELL_FOR_Q before graduation (a sale on the curve would take Q from the raise).
                sp.tBurned = sp.tReward;
            }
            _l.fitWaitingT += _u128(sp.tFit);
            _creditDepth(sp.qDepth, sp.tDepth, graduated);
        }
        // Re-read: `_capPlatform` may have moved the epoch in this call.
        _s = (_s & ~((_M8 << _O_QCARRY) | (_M8 << _O_TCARRY))) | (qCarry << _O_QCARRY) | (tCarry << _O_TCARRY);
    }

    function _rewardQ(uint256 amount, bool graduated, bool atSettlement) private {
        if (amount == 0) return;
        uint8 qs = _argUint8(_A_Q_STREAM);
        if (qs == BoxSpecV1.Q_STREAM_TO_CREATOR) {
            _creditCreator(amount, 0, graduated, atSettlement);
        } else if (qs == BoxSpecV1.Q_STREAM_BUYBACK_BURN_T) {
            _m.qBurn += _u128(amount); // the module buys T and burns it (S5.M2)
        } else if (qs == BoxSpecV1.Q_STREAM_CREATOR_IN_T) {
            // The module buys T for the creator (S5.M3); add-on 5 counts the Q handed for the buy, here, at face.
            _m.qCreator += _u128(graduated ? _capQ(amount, atSettlement) : amount);
        } else {
            // ALL_TO_FIT: the reward side joins FIT's share (fundBudget, no treasury cut).
            _l.fitOwed += _u128(amount);
            _t.toFit += _u128(amount);
        }
    }

    /// @dev TO_CREATOR (F68 (3)): held until graduation (F69 C1), then owed to the payee, paid as collected (F72 (A)).
    /// Q owed after graduation passes add-on 5's cap first (`inEpochZero`: the settlement's split).
    function _creditCreator(uint256 qAmount, uint256 tAmount, bool graduated, bool inEpochZero) private {
        if (graduated) qAmount = _capQ(qAmount, inEpochZero);
        if (qAmount | tAmount == 0) return;
        if (graduated) {
            _l.creatorOwedQ += _u128(qAmount);
            _l.creatorOwedT += _u128(tAmount);
        } else {
            _l.creatorHeldQ += _u128(qAmount);
            _l.creatorHeldT += _u128(tAmount);
        }
        _t.qToCreator += _u128(qAmount);
        _t.tToCreator += _u128(tAmount);
        emit CreatorCredited(qAmount, tAmount, !graduated);
    }

    /// @dev Box 0's platform share under the cap (R F62; BC-106): keep = min(P, CAP − kept this epoch), credited to
    /// the fixed Safe; the rest at once to the hook's claims (box 0's depth, beside its own 2/15, F77). No carry-over
    /// between epochs. The graduation settlement (`inEpochZero`) counts in epoch 0 even when it runs later (a failed
    /// graduation poke and no receiver call for 30 days): it is the first call that caps, so the stored epoch is still 0
    /// then.
    function _capPlatform(uint256 p, bool inEpochZero) private returns (uint256 keep, uint256 toDepth) {
        if (p == 0) return (0, 0);
        uint256 epoch = inEpochZero ? 0 : _epochNow(PLATFORM_EPOCH_SECONDS);
        uint256 kept;
        (keep, kept) = _count(p, PLATFORM_CAP_WEI, epoch);
        toDepth = p - keep;
        _l.platformOwed += _u128(keep);
        _t.toPlatform += _u128(keep);
        _creditDepth(toDepth, 0, true);
        emit PlatformCredited(epoch, keep, toDepth, kept);
    }

    /// @dev The one epoch counter (box 0's platform cap, F62; or a Standard box's creator-fee cap, add-on 5): keep =
    /// min(amount, cap − kept in `epoch`); a new epoch starts from zero (no carry-over).
    function _count(uint256 amount, uint256 cap, uint256 epoch) private returns (uint256 keep, uint256 kept) {
        uint256 s = _s;
        kept = _l.keptInEpoch;
        if (epoch != (s >> _O_EPOCH) & _M32) {
            kept = 0;
            _s = (s & ~(_M32 << _O_EPOCH)) | (epoch << _O_EPOCH);
        }
        uint256 room = cap - kept;
        keep = amount < room ? amount : room;
        kept += keep;
        _l.keptInEpoch = _u128(kept);
    }

    /// @dev Add-on 5 on creator Q, at face (R F74 U2, F75 U9): what the creator keeps of `q` in this epoch (epoch 0 at
    /// the settlement, however late); the excess to its destination in Q. Without the add-on: all of it.
    function _capQ(uint256 q, bool inEpochZero) private returns (uint256 keep) {
        if (q == 0) return 0;
        uint256 cap = _argUint(_A_CAP, 16);
        if (cap == 0) return q;
        uint256 epoch = inEpochZero ? 0 : _epochNow(_CREATOR_EPOCH_SECONDS);
        uint256 kept;
        (keep, kept) = _count(q, cap, epoch);
        _toExcess(q - keep, 0);
        emit CreatorCapped(epoch, keep, q - keep, 0, kept);
    }

    /// @dev Add-on 5 on T paid as T: the T held for the creator, valued by the box's sampler at its 1-hour average
    /// (`quoteTInQ`, rounded up; try/catch: a failing or unready average leaves it held, no revert), passes the cap in
    /// the epoch now; the creator keeps the share of it its value allows (rounded down). Returns the T to burn (BURN).
    function _valueHeldT() private returns (uint256 tBurn) {
        uint256 cap = _argUint(_A_CAP, 16);
        if (cap == 0) return 0;
        uint256 t = _l.creatorHeldT;
        if (t == 0) return 0;
        uint256 v;
        try IBoxPriceQuote(address(IBoxHook(_argAddress(_A_HOOK)).priceAverage())).quoteTInQ(t) returns (
            bool ready, uint256 q_
        ) {
            if (!ready || q_ == 0) return 0;
            v = q_;
        } catch {
            return 0;
        }
        uint256 epoch = _epochNow(_CREATOR_EPOCH_SECONDS);
        (uint256 keepQ, uint256 kept) = _count(v, cap, epoch);
        uint256 keepT = keepQ == v ? t : t * keepQ / v;
        _l.creatorHeldT = 0;
        _l.creatorOwedT += _u128(keepT);
        // Counted for the creator when it was held; the excess never was the creator's.
        _t.tToCreator -= _u128(t - keepT);
        tBurn = _toExcess(0, t - keepT);
        emit CreatorCapped(epoch, keepQ, 0, t - keepT, kept);
    }

    /// @dev Add-on 5's excess, in the currency it arrived in: BURN puts Q in the module's burn-buy ledger (it buys T
    /// and burns it: a Q without a real burn) and returns T to be burned with the batch; POOL_DEPTH sends both to the
    /// hook's claims (depth, as the 2/15, no platform part).
    function _toExcess(uint256 q, uint256 t) private returns (uint256 tBurn) {
        if (q | t == 0) return 0;
        if (_argUint8(_A_CAP_EXCESS) == BoxSpecV1.CAP_EXCESS_BURN) {
            _m.qBurn += _u128(q);
            return t;
        }
        _creditDepth(q, t, true);
    }

    /// @dev The depth parts of a split (counted in the totals when credited), one rule for every box (F77): before
    /// graduation they wait here (`depthHeld`; BC-109: the refund range's at a failure, S11; box 0 has no failure, so
    /// holding changes none of its money) and move whole at the settlement; after graduation they move to the hook's
    /// claims at once.
    function _creditDepth(uint256 qAmount, uint256 tAmount, bool graduated) private {
        if (qAmount | tAmount == 0) return;
        _t.qToDepth += _u128(qAmount);
        _t.tToDepth += _u128(tAmount);
        if (!graduated) {
            _l.depthHeldQ += _u128(qAmount);
            _l.depthHeldT += _u128(tAmount);
            emit DepthHeld(qAmount, tAmount);
        } else {
            _moveDepth(qAmount, tAmount);
        }
    }

    /// @dev Depth claims to the hook: an ERC-6909 transfer (no unlock, no allowance; dynamic-pool-share § 4 finding
    /// 5). The hook's claims are its depth budget.
    function _moveDepth(uint256 qAmount, uint256 tAmount) private {
        address hook_ = _argAddress(_A_HOOK);
        if (qAmount != 0) poolManager.transfer(hook_, 0, qAmount);
        if (tAmount != 0) poolManager.transfer(hook_, uint256(uint160(_argAddress(_A_TOKEN))), tAmount);
        emit DepthFunded(qAmount, tAmount);
    }

    /// @dev Once, at or after graduation: box 0's held P through epoch 0's cap; every box's held depth parts to the
    /// hook; the creator's held credits become owed (and the swap module's held ledgers, which `pullForModule` hands
    /// over from now on: nothing moves to the module here); then the claims the final harvest left (the migration's
    /// last poke and Q dust), less any fee note to return, split with no minimum, also in epoch 0.
    function _settleGraduation() private {
        _s |= _B_SETTLED;
        uint256 held = _l.platformHeld;
        uint256 keep;
        uint256 toDepth;
        if (held != 0) {
            _l.platformHeld = 0;
            (keep, toDepth) = _capPlatform(held, true);
        }
        uint256 dq = _l.depthHeldQ;
        uint256 dt = _l.depthHeldT;
        if (_argAddress(_A_STREAM) != address(0)) _streamCurveDepthT = dt;
        if (dq | dt != 0) {
            (_l.depthHeldQ, _l.depthHeldT) = (0, 0);
            _moveDepth(dq, dt);
        }
        uint256 cq = _l.creatorHeldQ;
        // Add-on 5: T paid as T stays held until the sampler can value it (never at the settlement: the sampler
        // records nothing before migration); held creator Q, then the module's held creator-buy Q, count in epoch 0.
        bool capped = _argUint(_A_CAP, 16) != 0;
        uint256 ct = capped ? 0 : _l.creatorHeldT;
        if (cq | ct != 0) {
            _l.creatorHeldQ = 0;
            if (ct != 0) _l.creatorHeldT = 0;
            uint256 kq = _capQ(cq, true);
            // Counted for the creator when it was held; the cap's excess never was the creator's.
            if (kq != cq) _t.qToCreator -= _u128(cq - kq);
            _l.creatorOwedQ += _u128(kq);
            _l.creatorOwedT += _u128(ct);
            cq = kq;
        }
        if (capped) {
            uint256 mq = _m.qCreator;
            if (mq != 0) _m.qCreator = _u128(_capQ(mq, true));
        }
        emit GraduationSettled(_l.fitOwed, keep, toDepth, cq, ct);
        (uint256 newQ, uint256 newT) = _unbooked();
        // A note made before a late settlement goes back first, as in a collect.
        (newQ, newT) = _returnFees(newQ, newT);
        if (newQ | newT != 0) {
            Split memory sp = _split(newQ, newT, true, true);
            _emitSplit(sp);
            _payOut(address(0), 0, sp);
        }
    }

    /// @dev REV-16 (BC-019, BC-133), before the tip and the split, never more than the batch's new claims: the module's
    /// notes (a Standard box's to `moduleBackQ` / `moduleBackT`, which the next pull hands back; box 0's executor's to
    /// `fitOwed`, its budget, as built) and the hook's conversion notes (back to its claims: depth). Returns the Q and
    /// T left to split.
    function _returnFees(uint256 newQ, uint256 newT) private returns (uint256, uint256) {
        bool box0 = _argUint(_A_KIND, 1) == uint8(BoxKind.Box0);
        uint256 back = _l.moduleQPending;
        if (back > newQ) back = newQ;
        uint256 backT = box0 ? 0 : _l.moduleTPending;
        if (backT > newT) backT = newT;
        newQ -= back;
        uint256 s = _s;
        uint256 hookBack = s >> _O_HOOK_FEES;
        if (hookBack > newQ) hookBack = newQ;
        if (back | backT | hookBack == 0) return (newQ, newT);
        _l.moduleQPending -= _u128(back);
        _l.moduleTPending -= _u128(backT);
        if (box0) {
            _l.fitOwed += _u128(back);
            _t.toFit += _u128(back);
        } else {
            _l.moduleBackQ += _u128(back);
            _l.moduleBackT += _u128(backT);
        }
        if (hookBack != 0) {
            _s = s - (hookBack << _O_HOOK_FEES);
            poolManager.transfer(_argAddress(_A_HOOK), 0, hookBack);
        }
        emit ModuleFeesReturned(back, backT, hookBack);
        return (newQ - hookBack, newT - backT);
    }

    /// @dev A module ledger handed over less 1 raw unit (box-factory § 2.2: no slot returns to zero).
    function _hand(uint128 x) private pure returns (uint256 handed, uint128 kept) {
        return x > 1 ? (uint256(x) - 1, uint128(1)) : (0, x);
    }

    // ================================================================== internals: payouts

    /// @dev After a split: one unlock redeems the tip (Q to `tipTo`), the T to burn (to this contract) and the T for
    /// the stream (to the stream); then the burn (which must lower supply, else the T waits) and the stream's capped,
    /// fail-safe notice. The tip goes last inside the unlock.
    function _payOut(address tipTo, uint256 tip, Split memory sp) private {
        address t_ = _argAddress(_A_TOKEN);
        address stream = _argAddress(_A_STREAM);
        uint256 n = (sp.tBurned != 0 ? 1 : 0) + (sp.tToStream != 0 ? 1 : 0) + (tip != 0 ? 1 : 0);
        if (n != 0) {
            address[] memory assets = new address[](n);
            address[] memory tos = new address[](n);
            uint256[] memory amounts = new uint256[](n);
            uint256 i;
            if (sp.tBurned != 0) (assets[i], tos[i], amounts[i++]) = (t_, address(this), sp.tBurned);
            if (sp.tToStream != 0) (assets[i], tos[i], amounts[i++]) = (t_, stream, sp.tToStream);
            if (tip != 0) (assets[i], tos[i], amounts[i]) = (address(0), tipTo, tip);
            poolManager.unlock(abi.encode(_ACT_REDEEM, abi.encode(assets, tos, amounts)));
        }
        if (sp.tBurned != 0) _l.tBurnPending += _u128(sp.tBurned);
        _burnPending(t_);
        if (sp.tToStream != 0) _notifyStream(stream, sp.tToStream);
    }

    /// @dev Burns every T waiting here; a refused burn (the vault's supply floor) leaves it waiting, never counted as
    /// burned (FitFeeCollector.sol:117-127; BC-016).
    function _burnPending(address t_) private {
        uint256 amount = _l.tBurnPending;
        if (amount == 0) return;
        IBurnableBoxToken tok = IBurnableBoxToken(t_);
        uint256 supplyBefore = tok.totalSupply();
        try tok.burn(amount) {
            if (tok.totalSupply() + amount != supplyBefore) revert BurnDidNotReduceSupply();
            _l.tBurnPending = 0;
            _t.tBurned += _u128(amount);
        } catch {}
    }

    /// @dev The stream accounts from its T balance; the notice is capped and fail-safe (IBoxItemStream).
    function _notifyStream(address stream, uint256 amount) private {
        uint256 left = gasleft();
        if (left < _STREAM_GAS_REQUIRED) revert StreamGasTooLow(left, _STREAM_GAS_REQUIRED);
        bytes memory data = abi.encodeCall(IBoxItemStream.onStreamFunds, (amount));
        bool ok;
        assembly ("memory-safe") {
            ok := call(STREAM_NOTIFY_GAS, stream, 0, add(data, 0x20), mload(data), 0, 0)
        }
        if (ok) emit StreamFunded(stream, amount);
        else emit StreamNotifyFailed(stream, amount);
    }

    /// @dev Burns `amount` of this contract's `asset` claims and takes the asset to `to`, in its own unlock.
    function _redeem(address asset, address to, uint256 amount) private {
        address[] memory assets = new address[](1);
        address[] memory tos = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        (assets[0], tos[0], amounts[0]) = (asset, to, amount);
        poolManager.unlock(abi.encode(_ACT_REDEEM, abi.encode(assets, tos, amounts)));
    }

    function _emitSplit(Split memory sp) private {
        emit BatchSplit(sp.qReward, sp.qFit, sp.qDepth, sp.qPlatform, sp.tReward, sp.tFit, sp.tDepth, sp.tBurned);
    }

    // ================================================================== internals: reads

    /// @dev Runs the current call's calldata in the extension by DELEGATECALL and returns or reverts with its data (as
    /// `BoxHook._forward`).
    function _forward() private {
        address ext = extension;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    /// @dev The box's swap module (box 0 has none: every caller is refused there).
    function _onlyModule() private view returns (address m) {
        m = _argAddress(_A_MODULE);
        if (msg.sender != m || m == address(0)) revert NotModule(msg.sender);
    }

    /// @dev Claims of this contract not in any ledger: the next batch.
    function _unbooked() private view returns (uint256 qNew, uint256 tNew) {
        (uint256 qb, uint256 tb) = booked();
        qNew = poolManager.balanceOf(address(this), 0) - qb;
        tNew = poolManager.balanceOf(address(this), uint256(uint160(_argAddress(_A_TOKEN)))) - tb;
    }

    /// @dev Whether the box graduated; the first call after graduation runs the settlement (anyone's call does it,
    /// so held shares never wait for the coordinator's fail-safe poke).
    function _settleIfDue() private returns (bool graduated) {
        graduated = _graduated();
        if (graduated && _s & _B_SETTLED == 0) _settleGraduation();
    }

    function _graduated() private view returns (bool) {
        return IBoxCoordinator(_argAddress(_A_COORDINATOR)).graduated();
    }

    /// @dev ⌊(now − graduatedAt) / period⌋: box 0's platform epoch (PLATFORM_EPOCH_SECONDS) or add-on 5's
    /// (ADD_ON_CREATOR_FEE_CAP_EPOCH_SECONDS), both 30 days.
    function _epochNow(uint256 period) private view returns (uint256) {
        return (block.timestamp - IBoxCoordinator(_argAddress(_A_COORDINATOR)).graduatedAt()) / period;
    }

    /// @dev A cap's epoch now, what was kept in it and what may still be: the whole cap until the settlement.
    function _capView(uint256 cap, uint256 period)
        private
        view
        returns (uint256 epoch, uint256 kept, uint256 remaining)
    {
        uint256 s = _s;
        if (s & _B_SETTLED == 0) return (0, 0, cap);
        epoch = _epochNow(period);
        kept = epoch == (s >> _O_EPOCH) & _M32 ? _l.keptInEpoch : 0;
        remaining = cap - kept;
    }
}
