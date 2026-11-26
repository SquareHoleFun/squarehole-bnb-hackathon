// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFeeCollector} from "../interfaces/IFeeCollector.sol";
import {IRewardLedger} from "../interfaces/IRewardLedger.sol";
import {ISquareHoleToken} from "../interfaces/ISquareHoleToken.sol";

/// @title LaunchTokenCore
/// @notice The part of T shared by both Square Hole launch templates (the DN404 collection `SquareHoleToken` and the
/// plain ERC-20 `SquareHoleFungibleToken`): immutable launch identity, wiring checks against the per-launch ledger
/// and collector, the reward checkpoint on every balance write, and the fee collector's burn of its own balance.
/// @dev Both templates use 18 decimals and the same fixed supply: exactly `FIXED_WHOLE_SUPPLY` = 1,000,000,000
/// whole tokens (`FIXED_SUPPLY` = 1e27 raw units), minted once to the initial holder (ADR-0009 F10: every NFT
/// collection has exactly 1e9 fractional tokens whatever its NFT count; plain token launches use the same fixed
/// supply, because no template carries another one). There is no owner, no transfer fee, no mint after launch and
/// no upgrade path.
abstract contract LaunchTokenCore is ISquareHoleToken {
    error InvalidSupply(uint256 wholeSupply);
    error ZeroAddress();
    error InvalidInitialHolder();
    error WiringMismatch();
    error NotFeeCollector();

    /// @notice Raw units per whole token (18 decimals).
    uint256 public constant WHOLE_TOKEN = 1e18;
    /// @notice The supply of every launch, in whole tokens (F10: exactly 1,000,000,000; F08's upper bound became the
    /// fixed value).
    uint256 public constant FIXED_WHOLE_SUPPLY = 1e9;
    /// @notice The supply of every launch in raw units: 1e9 × 1e18 = 1e27 (< 2^96, DN404's balance width).
    uint256 public constant FIXED_SUPPLY = FIXED_WHOLE_SUPPLY * WHOLE_TOKEN;

    /// @notice Whole tokens minted at launch: always FIXED_WHOLE_SUPPLY (kept as a getter for readers).
    uint256 public immutable wholeSupply;
    /// @notice Raw units minted at launch: always FIXED_SUPPLY = 1e27.
    uint256 public immutable initialSupply;
    /// @notice Receives the whole initial supply (the pool hook, which seeds it as launch liquidity).
    address public immutable initialHolder;
    address public immutable feeCollector;
    address public immutable rewardLedger;
    /// @notice Commitment to the launch's metadata manifest.
    bytes32 public immutable metadataManifestHash;

    string internal _name;
    string internal _symbol;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 wholeSupply_,
        address initialHolder_,
        address feeCollector_,
        address rewardLedger_,
        bytes32 metadataManifestHash_
    ) {
        if (wholeSupply_ != FIXED_WHOLE_SUPPLY) revert InvalidSupply(wholeSupply_);
        if (initialHolder_ == address(0) || feeCollector_ == address(0) || rewardLedger_ == address(0)) {
            revert ZeroAddress();
        }
        if (initialHolder_ == feeCollector_ || initialHolder_ == rewardLedger_) revert InvalidInitialHolder();

        // The ledger and collector were deployed first against this contract's predicted address.
        IRewardLedger ledger = IRewardLedger(rewardLedger_);
        IFeeCollector collector = IFeeCollector(feeCollector_);
        if (
            ledger.token() != address(this) || ledger.feeCollector() != feeCollector_
                || collector.token() != address(this) || collector.ledger() != rewardLedger_
        ) revert WiringMismatch();
        // Unsold launch inventory is not an ordinary reward owner (spec 05): the initial holder must be an excluded
        // role of the ledger (the hook), or the whole supply would earn holder Q from block 0.
        if (!ledger.isExcluded(initialHolder_)) revert InvalidInitialHolder();

        wholeSupply = wholeSupply_;
        initialSupply = wholeSupply_ * WHOLE_TOKEN;
        initialHolder = initialHolder_;
        feeCollector = feeCollector_;
        rewardLedger = rewardLedger_;
        metadataManifestHash = metadataManifestHash_;
        _name = name_;
        _symbol = symbol_;
    }

    /// @inheritdoc ISquareHoleToken
    /// @dev Reduces totalSupply. The collector is a contract (the collection template's skipNFT default), so no NFT
    /// is materialized to be burned.
    function burnFeeInventory(uint256 amount) external {
        if (msg.sender != feeCollector) revert NotFeeCollector();
        _burnFeeInventory(amount);
    }

    /// @dev Burns `amount` of the fee collector's own balance through the template's checkpointed burn path.
    function _burnFeeInventory(uint256 amount) internal virtual;

    /// @dev The template's current balance of `account` (pre-change when called from a write path).
    function _balanceForCheckpoint(address account) internal view virtual returns (uint256);

    /// @dev Settles `from` and `to` in the ledger at their pre-change balances. When `amount` exceeds `from`'s
    /// balance the template reverts right after this with its own insufficient-balance error, so the ledger call is
    /// skipped to keep that error; nothing persists either way.
    function _checkpoint(address from, address to, uint256 amount) internal {
        uint256 fromBalance = 0;
        if (from != address(0)) {
            fromBalance = _balanceForCheckpoint(from);
            if (amount > fromBalance) return;
        }
        uint256 toBalance = to == address(0) ? 0 : _balanceForCheckpoint(to);
        IRewardLedger(rewardLedger).beforeBalanceChange(from, fromBalance, to, toBalance, amount);
    }
}
