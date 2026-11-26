// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IRewardLedger} from "./interfaces/IRewardLedger.sol";
import {PoolManagerClaims} from "./libraries/PoolManagerClaims.sol";
import {SafeERC20Lite} from "./libraries/SafeERC20Lite.sol";
import {TransientReentrancyGuard} from "./libraries/TransientReentrancyGuard.sol";

/// @title RewardLedger
/// @notice Historical Q rewards for one Square Hole launch (one T, one Q). Holder Q is added to a cumulative
/// Q-per-eligible-T index at the authenticated fee event; T checkpoints every account at its pre-change balance
/// before any balance mutation, so an entitlement belongs to whoever held T when the fee was earned (spec 05,
/// G03, ECO-05, ECO-09). Nothing here is upgradeable and there is no owner.
/// @dev Fixed point: the index is Q × INDEX_SCALE per raw T unit. Per-account entitlements are kept in the same
/// scaled units, so sub-wei fractions are never discarded at settlement; only the final payout floors to raw Q
/// and the fractional rest stays on the account. The index division remainder is carried to the next fee event.
/// Custody (ADR-0011): holder Q is held as ERC-6909 claims on the Uniswap v4 PoolManager, delivered by the fee
/// collector at the fee event. `claim` redeems them to the holder inside a PoolManager unlock; `claimFor` hands
/// them to the R = T converter as claims. See docs/decisions/0010 and 0011 for bounds and the dust policy.
contract RewardLedger is IRewardLedger, IUnlockCallback, TransientReentrancyGuard {
    using SafeERC20Lite for address;
    using PoolManagerClaims for IPoolManager;

    /// @notice Launch wiring. Every non-zero role address except `quote` is excluded from rewards, immutably
    /// (`quote` is only required to be distinct from the roles). T requires its initial holder to be one of the
    /// excluded roles (the hook, which seeds the launch position).
    struct Config {
        address token; // T, deployed after this ledger at a predicted address
        address quote; // Q (an ERC-20; native ETH is not supported, use WETH)
        address feeCollector; // the only caller of notifyHolderQ
        address treasury; // protocol treasury (excluded; receives unsolicited deposits)
        PayoutAsset payoutAsset; // R, immutable
        address converter; // R = T claim converter (required iff R = T)
        address launcher; // launch factory role (optional)
        address poolManager; // Uniswap v4 PoolManager: custody of holder Q claims and AMM reserves (required)
        address hook; // pool hook / authenticated fee source role (optional)
        bool nftMirror; // true for the DN404 template: T's first CREATE (its mirror) is excluded too
    }

    struct AccountState {
        uint256 checkpoint; // reward index at the account's last settlement
        uint256 accruedScaled; // unpaid entitlement in Q × INDEX_SCALE
    }

    error ZeroAddress();
    error DuplicateRole(address account);
    error InvalidPayoutConfig();
    error NotToken();
    error NotFeeCollector();
    error NotConverter();
    error NotAccount();
    error NotPoolManager();
    error WrongPayoutAsset();
    error HolderQCapExceeded();
    /// @notice A fee event with holder Q ran while T lent out by the pool manager earlier in the same transaction was
    /// still with eligible accounts (`poolNetOutflow`); the swap reverts (fail-closed flash guard, ADR-0011 §3).
    error PoolOutflowAtFeeEvent(uint256 poolNetOutflow);
    error NotSweepable(address asset);
    error NothingToSweep();

    /// @notice Fixed-point scale of the reward index.
    uint256 public constant INDEX_SCALE = 1e36;
    /// @notice Lifetime cap on holder Q (raw units). Keeps every product in the accounting below 2^256
    /// (ADR-0010 "Bounds"); a Q asset whose supply exceeds it is unsupported.
    uint256 public constant MAX_TOTAL_HOLDER_Q = type(uint128).max;
    /// @dev EIP-1153 slot of the same-transaction pool-manager net outflow:
    /// `uint256(keccak256("squarehole.ledger.pool-net-outflow")) - 1`.
    uint256 private constant _POOL_OUTFLOW_SLOT = 0xc026f32121a94c52e6c43a3674ed6296224237e59b3f7f915e694ff4eecf3d1d;

    address public immutable token;
    /// @notice T's DN404 mirror: the first contract T creates (CREATE nonce 1). Excluded. Zero for the fungible
    /// template, which has no mirror.
    address public immutable mirror;
    address public immutable quote;
    address public immutable feeCollector;
    address public immutable treasury;
    address public immutable converter;
    address public immutable launcher;
    address public immutable poolManager;
    address public immutable hook;
    PayoutAsset public immutable payoutAsset;

    /// @notice Cumulative holder Q per raw eligible T unit, scaled by INDEX_SCALE.
    uint256 public rewardIndex;
    /// @notice Undistributed remainder of the last index division, in Q × INDEX_SCALE units.
    uint256 public indexRemainder;
    /// @notice T held by non-excluded accounts (= totalSupply − Σ excluded balances), tracked on every change.
    uint256 public eligibleSupply;
    /// @notice Deferred holder Q: received while eligibleSupply was zero (bootstrap, spec 05). Released at the next
    /// clean fee event that finds eligible T. (A fee event during a same-transaction pool-manager outflow never defers:
    /// it reverts, see `notifyHolderQ`.)
    uint256 public bootstrapQ;
    /// @notice Lifetime holder Q (claims) pulled from the fee collector.
    uint256 public totalHolderQReceived;
    /// @notice Lifetime holder Q added to the index (received − bootstrapQ).
    uint256 public totalHolderQIndexed;
    /// @notice Lifetime Q paid out by claims.
    uint256 public totalClaimed;

    mapping(address => AccountState) private _accounts;

    constructor(Config memory config) {
        if (
            config.token == address(0) || config.quote == address(0) || config.feeCollector == address(0)
                || config.treasury == address(0) || config.poolManager == address(0)
        ) revert ZeroAddress();
        if (config.payoutAsset == PayoutAsset.T ? config.converter == address(0) : config.converter != address(0)) {
            revert InvalidPayoutConfig();
        }

        address predictedMirror = config.nftMirror ? _firstCreateAddress(config.token) : address(0);
        address[10] memory roles = [
            address(this),
            config.token,
            predictedMirror,
            config.quote,
            config.feeCollector,
            config.treasury,
            config.converter,
            config.launcher,
            config.poolManager,
            config.hook
        ];
        for (uint256 i; i < roles.length; ++i) {
            if (roles[i] == address(0)) continue;
            for (uint256 j = i + 1; j < roles.length; ++j) {
                if (roles[i] == roles[j]) revert DuplicateRole(roles[i]);
            }
        }

        token = config.token;
        mirror = predictedMirror;
        quote = config.quote;
        feeCollector = config.feeCollector;
        treasury = config.treasury;
        converter = config.converter;
        launcher = config.launcher;
        poolManager = config.poolManager;
        hook = config.hook;
        payoutAsset = config.payoutAsset;
    }

    /*//////////////////////////////////////////////////////////////
                            TOKEN CHECKPOINTS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRewardLedger
    /// @dev Never reverts for a valid transfer: products are bounded by MAX_TOTAL_HOLDER_Q (ADR-0010) and an
    /// eligible sender's balance is part of eligibleSupply. T skips this call when `amount > fromBalance`, because
    /// the token reverts in that case anyway.
    /// Also maintains the same-transaction pool-manager net outflow (see `notifyHolderQ`): T moving from the pool
    /// manager to an eligible account adds to it, T moving from an eligible account into the pool manager reduces
    /// it, never below zero. (`poolManager` is never zero, so it cannot match a mint's `from` or a burn's `to`.)
    function beforeBalanceChange(address from, uint256 fromBalance, address to, uint256 toBalance, uint256 amount)
        external
    {
        if (msg.sender != token) revert NotToken();
        uint256 index = rewardIndex;
        bool fromEligible = from != address(0) && !_isExcluded(from);
        bool toEligible = to != address(0) && !_isExcluded(to);
        if (fromEligible) _settle(from, fromBalance, index);
        if (toEligible) _settle(to, toBalance, index);
        if (fromEligible != toEligible) {
            if (fromEligible) {
                eligibleSupply -= amount;
                if (to == poolManager) _reducePoolOutflow(amount);
            } else {
                eligibleSupply += amount;
                if (from == poolManager) _addPoolOutflow(amount);
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                              FEE EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRewardLedger
    /// @dev The collector grants an exact ERC-6909 allowance and this function pulls it, checking the balance delta
    /// of that pull. Unsolicited Q or Q claims sent to the ledger can neither satisfy nor block the check. With zero
    /// eligible supply the Q waits in `bootstrapQ` (05-ECONOMICS default) and is released at the next clean fee
    /// event that finds eligible T, including a T-only fee event (`amount == 0`), matching the reference model.
    /// Flash guard, fail-closed (ADR-0010, ADR-0011 §3): if T that left the pool manager earlier in this transaction
    /// is still with eligible accounts (`poolNetOutflow() != 0`, e.g. Uniswap v4 take → swap → settle inside one
    /// unlock, or an earlier V4_SWAP's take), the current eligible supply is inflated by T that may not really be
    /// owned. A fee event with holder Q then reverts (and so does the swap): deferring it would let whoever holds T
    /// at the next release, the trader included, recover that holder share (review round A, finding 1). A T-only
    /// event (`amount == 0`) is not reverted but releases nothing. A fee event is "clean" when the outflow is zero.
    function notifyHolderQ(uint256 amount) external nonReentrant {
        if (msg.sender != feeCollector) revert NotFeeCollector();
        if (amount != 0) {
            if (amount > MAX_TOTAL_HOLDER_Q - totalHolderQReceived) revert HolderQCapExceeded();
            IPoolManager(poolManager).pullExact(feeCollector, quote, amount);
            totalHolderQReceived += amount;
        }

        // Read after the pull, so an outflow created during it would be seen too.
        uint256 outflow = _poolOutflow();
        if (outflow != 0) {
            // Holder Q of this event must reach neither the (possibly borrowed) current holders nor a later release.
            if (amount != 0) revert PoolOutflowAtFeeEvent(outflow);
            return;
        }

        uint256 supply = eligibleSupply;
        uint256 deferred = bootstrapQ;
        if (supply == 0) {
            if (amount != 0) {
                deferred += amount;
                bootstrapQ = deferred;
                emit HolderQDeferred(amount, deferred);
            }
            return;
        }

        uint256 allocation = amount + deferred;
        if (allocation == 0) return;
        if (deferred != 0) bootstrapQ = 0;
        totalHolderQIndexed += allocation;

        // allocation ≤ 2^128 and INDEX_SCALE < 2^120, indexRemainder < 2^96: no overflow.
        uint256 numerator = allocation * INDEX_SCALE + indexRemainder;
        uint256 delta = numerator / supply;
        indexRemainder = numerator - delta * supply;
        uint256 newIndex = rewardIndex + delta;
        rewardIndex = newIndex;
        emit HolderQAllocated(amount, deferred, supply, delta, newIndex);
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIMS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRewardLedger
    /// @dev Only the account itself can claim (ECO-16), and only when R = Q. The entitlement is reduced before the
    /// payout, exactly once; the sub-wei rest stays on the account. The payout redeems the ledger's Q claims inside a
    /// PoolManager unlock (burn the claims, take the ERC-20 to the account), so it cannot run inside another unlock.
    function claim(address account) external nonReentrant returns (uint256 amount) {
        if (msg.sender != account) revert NotAccount();
        if (payoutAsset != PayoutAsset.Q) revert WrongPayoutAsset();
        amount = _consume(account, account, type(uint256).max);
        if (amount != 0) IPoolManager(poolManager).unlock(abi.encode(account, amount));
    }

    /// @inheritdoc IRewardLedger
    /// @dev Only the immutable converter may consume an entitlement (so R = T), and the Q goes to the converter as
    /// ERC-6909 claims, never to an arbitrary recipient. The converter authenticates `account`, spends the claims
    /// in its own swap through the canonical pool (or, in its sold-out fallback, redeems them to the account) and
    /// enforces the holder's minimum output and deadline; a failed conversion reverts this call too (ECO-07).
    /// Partial settlement: at most `maxAmount` raw Q is consumed (the rest of the entitlement stays intact), so a
    /// holder can convert a slice the pool can fill.
    function claimFor(address account, uint256 maxAmount) external nonReentrant returns (uint256 amount) {
        if (msg.sender != converter) revert NotConverter();
        amount = _consume(account, msg.sender, maxAmount);
        if (amount != 0) IPoolManager(poolManager).transfer(msg.sender, PoolManagerClaims.claimId(quote), amount);
    }

    /// @notice PoolManager callback of `claim`'s own unlock: redeems the claimed Q to the account.
    /// @dev Accepted only from the PoolManager while this ledger's guarded `claim` is running (the PoolManager
    /// calls back the contract that unlocked it, and only `claim` unlocks).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager || !_insideGuardedCall()) revert NotPoolManager();
        (address recipient, uint256 amount) = abi.decode(data, (address, uint256));
        IPoolManager(poolManager).redeem(quote, recipient, amount);
        return "";
    }

    /// @notice Moves an unsolicited ERC-20 deposit of T or Q to the treasury. Holder Q is held only as claims, so
    /// every ERC-20 unit here is unsolicited.
    function sweepUnaccounted(address asset) external nonReentrant returns (uint256 amount) {
        if (asset != quote && asset != token) revert NotSweepable(asset);
        amount = IERC20Minimal(asset).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        emit UnaccountedSwept(asset, amount, false);
        asset.safeTransfer(treasury, amount);
    }

    /// @notice Moves unsolicited ERC-6909 claims of T or Q to the treasury (as claims). Holder Q owed
    /// (received − claimed, including rounding dust) is never sweepable.
    function sweepUnaccountedClaims(address asset) external nonReentrant returns (uint256 amount) {
        if (asset != quote && asset != token) revert NotSweepable(asset);
        uint256 balance = IPoolManager(poolManager).claimsOf(asset);
        uint256 owed = asset == quote ? totalHolderQReceived - totalClaimed : 0;
        amount = balance > owed ? balance - owed : 0;
        if (amount == 0) revert NothingToSweep();
        emit UnaccountedSwept(asset, amount, true);
        IPoolManager(poolManager).transfer(treasury, PoolManagerClaims.claimId(asset), amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IRewardLedger
    function isExcluded(address account) public view returns (bool) {
        return _isExcluded(account);
    }

    /// @inheritdoc IRewardLedger
    /// @dev Earned and allocated Q only. Pending (unharvested) fees are never part of this number.
    function claimable(address account) external view returns (uint256) {
        if (account == address(0) || _isExcluded(account)) return 0;
        AccountState storage state = _accounts[account];
        uint256 balance = IERC20Minimal(token).balanceOf(account);
        return (state.accruedScaled + balance * (rewardIndex - state.checkpoint)) / INDEX_SCALE;
    }

    /// @inheritdoc IRewardLedger
    /// @notice Entitlement already settled onto the account (raw Q, floored).
    function accrued(address account) external view returns (uint256) {
        return _accounts[account].accruedScaled / INDEX_SCALE;
    }

    function accountState(address account) external view returns (uint256 checkpoint, uint256 accruedScaled) {
        AccountState storage state = _accounts[account];
        return (state.checkpoint, state.accruedScaled);
    }

    /// @inheritdoc IRewardLedger
    /// @notice Net T moved from the pool manager to eligible accounts earlier in the current transaction (EIP-1153:
    /// zero at the start of every transaction). A fee event with holder Q while it is non-zero reverts.
    function poolNetOutflow() external view returns (uint256) {
        return _poolOutflow();
    }

    /// @notice Holder Q the ledger must still hold as claims: lifetime received minus lifetime claimed.
    function holderQOutstanding() external view returns (uint256) {
        return totalHolderQReceived - totalClaimed;
    }

    /// @notice The ledger's Q claim balance on the PoolManager (≥ holderQOutstanding).
    function quoteClaims() external view returns (uint256) {
        return IPoolManager(poolManager).claimsOf(quote);
    }

    /// @notice Every excluded role address (zero entries are unused roles).
    function excludedAccounts() external view returns (address[9] memory accounts) {
        accounts = [address(this), token, mirror, feeCollector, treasury, converter, launcher, poolManager, hook];
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Unused optional roles are zero; the zero address itself is never an excluded account.
    function _isExcluded(address account) private view returns (bool) {
        if (account == address(0)) return false;
        return account == feeCollector || account == address(this) || account == treasury || account == token
            || account == poolManager || account == hook || account == launcher || account == converter
            || account == mirror;
    }

    function _settle(address account, uint256 balance, uint256 index) private {
        AccountState storage state = _accounts[account];
        uint256 checkpoint = state.checkpoint;
        if (checkpoint == index) return;
        if (balance != 0) {
            // balance ≤ eligibleSupply at every index step it spans, so balance × Δindex ≤ Σ allocation × SCALE.
            uint256 accrual = balance * (index - checkpoint);
            state.accruedScaled += accrual;
            emit Settled(account, balance, checkpoint, index, accrual);
        }
        state.checkpoint = index;
    }

    /// @dev Settles `account`, reduces its entitlement by min(floored raw entitlement, `maxAmount`) and records the
    /// payout. The sub-wei rest and anything above `maxAmount` stay on the account.
    function _consume(address account, address recipient, uint256 maxAmount) private returns (uint256 amount) {
        if (account == address(0) || _isExcluded(account)) return 0;
        _settle(account, IERC20Minimal(token).balanceOf(account), rewardIndex);
        AccountState storage state = _accounts[account];
        uint256 scaled = state.accruedScaled;
        amount = scaled / INDEX_SCALE;
        if (amount > maxAmount) amount = maxAmount;
        if (amount == 0) return 0;
        state.accruedScaled = scaled - amount * INDEX_SCALE;
        totalClaimed += amount;
        emit Claimed(account, recipient, amount);
    }

    function _poolOutflow() private view returns (uint256 outflow) {
        assembly ("memory-safe") {
            outflow := tload(_POOL_OUTFLOW_SLOT)
        }
    }

    /// @dev amount < 2^96 per write and a transaction holds far fewer than 2^150 writes: no overflow.
    function _addPoolOutflow(uint256 amount) private {
        assembly ("memory-safe") {
            tstore(_POOL_OUTFLOW_SLOT, add(tload(_POOL_OUTFLOW_SLOT), amount))
        }
    }

    /// @dev max(outflow − amount, 0): T paid into the pool manager before a loan builds no credit for it.
    function _reducePoolOutflow(uint256 amount) private {
        assembly ("memory-safe") {
            let outflow := tload(_POOL_OUTFLOW_SLOT)
            if outflow {
                let rest := 0
                if gt(outflow, amount) { rest := sub(outflow, amount) }
                tstore(_POOL_OUTFLOW_SLOT, rest)
            }
        }
    }

    /// @dev Address of the first contract created by `deployer` (a contract's CREATE nonce starts at 1).
    function _firstCreateAddress(address deployer) private pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x01))))));
    }
}
