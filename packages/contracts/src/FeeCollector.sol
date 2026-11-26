// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";
import {IRewardLedger} from "./interfaces/IRewardLedger.sol";
import {ISquareHoleToken} from "./interfaces/ISquareHoleToken.sol";
import {PoolManagerClaims} from "./libraries/PoolManagerClaims.sol";
import {SafeERC20Lite} from "./libraries/SafeERC20Lite.sol";
import {TransientReentrancyGuard} from "./libraries/TransientReentrancyGuard.sol";

/// @title FeeCollector
/// @notice Policy BURN_NATIVE_T_ROUTE_Q_V1 for one launch (spec 05): burns 100% of native T fee receipts and splits
/// realized Q 1:2 between the protocol treasury and historical holders. Only the immutable fee source (the pool
/// hook) can create a fee event, and receipts are measured by the balance delta of the collector's own pull, never
/// by raw balances, so unsolicited deposits never become fee events. No owner, no upgrade, no arbitrary calls.
/// @dev Custody (ADR-0011 "Fee realization"): fee receipts arrive as Uniswap v4 ERC-6909 claims that the hook
/// minted from the protocol-owned position's fees inside `afterSwap`, and they wait here as claims. Burning T and
/// paying the protocol share redeem claims inside this contract's own PoolManager unlock.
/// Holder Q is indexed inside `receiveFees`, i.e. at the fee event (ECO-09): a later, permissionless processing step
/// would otherwise apply old fees to present holders. Burning T and paying the protocol share do not change any
/// entitlement (the collector and treasury are excluded), so they are batched in `processFees`.
contract FeeCollector is IFeeCollector, IUnlockCallback, TransientReentrancyGuard {
    using SafeERC20Lite for address;
    using PoolManagerClaims for IPoolManager;

    error ZeroAddress();
    error DuplicateAddress();
    error LedgerMismatch();
    error FeeSourceNotExcluded();
    error NotFeeSource();
    error NotPoolManager();
    error EmptyReceipt();
    error NotSweepable(address asset);
    error NothingToSweep();

    address public immutable token;
    address public immutable quote;
    address public immutable ledger;
    address public immutable treasury;
    /// @notice The only address that can deliver fees (the Square Hole pool hook).
    address public immutable feeSource;
    /// @notice Uniswap v4 PoolManager holding this collector's fee claims.
    address public immutable poolManager;

    /// @notice Native fee T received (as claims) and not yet burned.
    uint256 public pendingBurnT;
    /// @notice Protocol Q allocated (as claims) and not yet sent to the treasury.
    uint256 public protocolQPending;
    /// @notice Realized Q (claims) not yet split because the split works in whole multiples of 3 raw units (< 3).
    uint256 public qRemainder;
    /// @notice Number of authenticated fee receipts; also the id of the latest one.
    uint256 public receiptCount;

    uint256 public totalTReceived;
    uint256 public totalTBurned;
    uint256 public totalQReceived;
    uint256 public totalQProtocol;
    uint256 public totalQHolders;
    uint256 public totalQToTreasury;

    constructor(
        address token_,
        address quote_,
        address ledger_,
        address treasury_,
        address feeSource_,
        address poolManager_
    ) {
        if (
            token_ == address(0) || quote_ == address(0) || ledger_ == address(0) || treasury_ == address(0)
                || feeSource_ == address(0) || poolManager_ == address(0)
        ) revert ZeroAddress();
        if (
            token_ == quote_ || feeSource_ == treasury_ || feeSource_ == ledger_ || feeSource_ == token_
                || feeSource_ == address(this) || feeSource_ == poolManager_
        ) revert DuplicateAddress();
        IRewardLedger l = IRewardLedger(ledger_);
        if (
            l.feeCollector() != address(this) || l.token() != token_ || l.quote() != quote_ || l.treasury() != treasury_
                || l.poolManager() != poolManager_
        ) {
            revert LedgerMismatch();
        }
        // A fee source holding T transiently must not earn holder rewards on it (ECO-12).
        if (!l.isExcluded(feeSource_)) revert FeeSourceNotExcluded();
        token = token_;
        quote = quote_;
        ledger = ledger_;
        treasury = treasury_;
        feeSource = feeSource_;
        poolManager = poolManager_;
    }

    /// @notice Pulls `tAmount` native fee T claims and `qAmount` realized fee Q claims from the fee source (exact
    /// ERC-6909 allowances). Q is split immediately: X = qAmount + carried remainder; protocol = ⌊X/3⌋,
    /// holders = 2⌊X/3⌋, and X mod 3 is carried to the next receipt. Holder Q claims go to the ledger and are
    /// indexed at this moment.
    /// @dev Called by the hook from `afterSwap`. No ERC-20 code runs here (only PoolManager ERC-6909 accounting), so
    /// a Q issuer's pause, denylist or transfer hook cannot make a swap revert through this path.
    function receiveFees(uint256 tAmount, uint256 qAmount) external nonReentrant returns (uint256 receiptId) {
        if (msg.sender != feeSource) revert NotFeeSource();
        if (tAmount == 0 && qAmount == 0) revert EmptyReceipt();
        IPoolManager pm = IPoolManager(poolManager);

        if (tAmount != 0) {
            pm.pullExact(feeSource, token, tAmount);
            pendingBurnT += tAmount;
            totalTReceived += tAmount;
        }

        uint256 protocolQ = 0;
        uint256 holderQ = 0;
        uint256 remainder = qRemainder;
        if (qAmount != 0) {
            pm.pullExact(feeSource, quote, qAmount);
            totalQReceived += qAmount;
            uint256 splittable = qAmount + remainder;
            uint256 third = splittable / 3;
            protocolQ = third;
            holderQ = third * 2;
            remainder = splittable - third * 3;
            qRemainder = remainder;
            protocolQPending += protocolQ;
            totalQProtocol += protocolQ;
            totalQHolders += holderQ;
            if (holderQ != 0) pm.approve(ledger, PoolManagerClaims.claimId(quote), holderQ);
        }

        receiptId = ++receiptCount;
        emit FeesReceived(receiptId, tAmount, qAmount, protocolQ, holderQ, remainder);

        // Also called when holderQ == 0: a valid fee event releases any bootstrap Q (spec 05, reference model).
        IRewardLedger(ledger).notifyHolderQ(holderQ);
    }

    /// @notice Burns all pending native fee T and pays pending protocol Q to the treasury. Permissionless:
    /// neither step changes any holder entitlement.
    function processFees() external nonReentrant returns (uint256 burnedT, uint256 paidQ) {
        burnedT = _burnPendingT();
        paidQ = _payProtocolQ();
    }

    /// @notice Burns all pending native fee T (independent of the Q leg, e.g. if Q blocks the treasury).
    function burnPendingT() external nonReentrant returns (uint256 burnedT) {
        burnedT = _burnPendingT();
    }

    /// @notice Pays all pending protocol Q to the immutable treasury.
    function payProtocolQ() external nonReentrant returns (uint256 paidQ) {
        paidQ = _payProtocolQ();
    }

    /// @notice PoolManager callback of this collector's own unlock: burns `amount` of its `asset` claims and takes
    /// the ERC-20 to `to` (this collector for fee T about to be burned, the treasury for protocol Q).
    /// @dev Accepted only from the PoolManager while one of this collector's guarded functions is running.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager || !_insideGuardedCall()) revert NotPoolManager();
        (address asset, address to, uint256 amount) = abi.decode(data, (address, address, uint256));
        IPoolManager(poolManager).redeem(asset, to, amount);
        return "";
    }

    /// @notice Moves an unsolicited ERC-20 deposit of T or Q to the treasury. Fee funds are held only as claims, so
    /// every ERC-20 unit here is unsolicited (a donated NFT's unit included); nothing here reaches holders.
    function sweepUnaccounted(address asset) external nonReentrant returns (uint256 amount) {
        if (asset != token && asset != quote) revert NotSweepable(asset);
        amount = IERC20Minimal(asset).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        emit UnaccountedSwept(asset, amount, false);
        asset.safeTransfer(treasury, amount);
    }

    /// @notice Moves unsolicited ERC-6909 claims of T or Q to the treasury (as claims). Pending fee T, pending
    /// protocol Q and the carried Q remainder are never sweepable.
    function sweepUnaccountedClaims(address asset) external nonReentrant returns (uint256 amount) {
        uint256 accounted = 0;
        if (asset == token) accounted = pendingBurnT;
        else if (asset == quote) accounted = protocolQPending + qRemainder;
        else revert NotSweepable(asset);
        uint256 balance = IPoolManager(poolManager).claimsOf(asset);
        amount = balance > accounted ? balance - accounted : 0;
        if (amount == 0) revert NothingToSweep();
        emit UnaccountedSwept(asset, amount, true);
        IPoolManager(poolManager).transfer(treasury, PoolManagerClaims.claimId(asset), amount);
    }

    function _burnPendingT() private returns (uint256 amount) {
        amount = pendingBurnT;
        if (amount == 0) return 0;
        pendingBurnT = 0;
        uint256 burnedTotal = totalTBurned + amount;
        totalTBurned = burnedTotal;
        emit FeeTBurned(amount, burnedTotal);
        // Redeem the fee T claims to this collector (PoolManager → collector: both excluded), then destroy exactly
        // that amount of the collector's own balance. Donated ERC-20 T here is never burned (ECO-02).
        IPoolManager(poolManager).unlock(abi.encode(token, address(this), amount));
        ISquareHoleToken(token).burnFeeInventory(amount);
    }

    function _payProtocolQ() private returns (uint256 amount) {
        amount = protocolQPending;
        if (amount == 0) return 0;
        protocolQPending = 0;
        totalQToTreasury += amount;
        emit ProtocolQPaid(treasury, amount);
        IPoolManager(poolManager).unlock(abi.encode(quote, treasury, amount));
    }
}
