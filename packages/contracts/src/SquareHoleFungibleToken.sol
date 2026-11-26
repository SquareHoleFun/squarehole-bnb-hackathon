// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IRewardLedger} from "./interfaces/IRewardLedger.sol";
import {ISquareHoleToken} from "./interfaces/ISquareHoleToken.sol";
import {LaunchTokenCore} from "./base/LaunchTokenCore.sol";

/// @title SquareHoleFungibleToken
/// @notice T for one Square Hole plain token launch ("token" asset kind): a standard 18-decimal ERC-20 with the fixed
/// supply of every launch, exactly 1,000,000,000 whole tokens (1e27 raw; ADR-0009 F10), minted once to the pool hook,
/// the same reward-checkpoint semantics as the DN404 collection template (every balance write settles both parties in
/// the ledger first), and the fee collector's burn of its own balance as the only burn. No transfer fee, no owner, no
/// mint after launch, no permit, no Permit2 default allowance, no upgrade path.
/// @dev Minimal ERC-20 written for Square Hole (MIT, no third-party code). Behaviour chosen to match the DN404 base
/// where ERC-20 standards leave a choice: transfers to the zero address revert; a `type(uint256).max` allowance is
/// never decremented (an explicit user choice; nothing grants it by default); zero-amount transfers are allowed and
/// still checkpoint. Three balance-write paths exist (initial mint, transfer, fee burn) and all checkpoint.
contract SquareHoleFungibleToken is LaunchTokenCore {
    /// @notice Immutable launch terms.
    struct LaunchTerms {
        string name;
        string symbol;
        uint256 wholeSupply; // must equal FIXED_WHOLE_SUPPLY (1e9, F10); initial supply = 1e27 raw
        address initialHolder; // receives the whole initial supply (the pool hook)
        address feeCollector;
        address rewardLedger;
        bytes32 metadataManifestHash; // commitment to the metadata manifest (logo, description)
    }

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Launched(
        address indexed initialHolder,
        uint256 wholeSupply,
        address feeCollector,
        address rewardLedger,
        bytes32 metadataManifestHash
    );

    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZeroAddress();
    error TransferFromZeroAddress();
    error ApproveToZeroAddress();

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    constructor(LaunchTerms memory terms)
        LaunchTokenCore(
            terms.name,
            terms.symbol,
            terms.wholeSupply,
            terms.initialHolder,
            terms.feeCollector,
            terms.rewardLedger,
            terms.metadataManifestHash
        )
    {
        // No mirror: the ledger must not predict one (its mirror role stays unused).
        if (IRewardLedger(terms.rewardLedger).mirror() != address(0)) revert WiringMismatch();
        _mint(terms.initialHolder, initialSupply);
        emit Launched(
            terms.initialHolder, terms.wholeSupply, terms.feeCollector, terms.rewardLedger, terms.metadataManifestHash
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 ERC-20
    //////////////////////////////////////////////////////////////*/

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    /// @inheritdoc ISquareHoleToken
    function totalSupply() public view override returns (uint256) {
        return _totalSupply;
    }

    /// @inheritdoc ISquareHoleToken
    function balanceOf(address owner) public view override returns (uint256) {
        return _balances[owner];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ApproveToZeroAddress();
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (amount > allowed) revert InsufficientAllowance();
            unchecked {
                _allowances[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                    BALANCE WRITES (ALL CHECKPOINTED)
    //////////////////////////////////////////////////////////////*/

    function _transfer(address from, address to, uint256 amount) internal {
        // `from` zero is only reachable through a zero-amount transferFrom; it would read as a mint to the ledger.
        if (from == address(0)) revert TransferFromZeroAddress();
        if (to == address(0)) revert TransferToZeroAddress();
        _checkpoint(from, to, amount);
        uint256 fromBalance = _balances[from];
        if (amount > fromBalance) revert InsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
            // Σ balances = totalSupply ≤ 1e27: no overflow.
            _balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    /// @dev Only reached from the constructor (the initial supply): there is no external mint.
    function _mint(address to, uint256 amount) internal {
        _checkpoint(address(0), to, amount);
        _totalSupply += amount;
        unchecked {
            _balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        _checkpoint(from, address(0), amount);
        uint256 fromBalance = _balances[from];
        if (amount > fromBalance) revert InsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
            _totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    function _burnFeeInventory(uint256 amount) internal override {
        _burn(msg.sender, amount);
    }

    function _balanceForCheckpoint(address account) internal view override returns (uint256) {
        return _balances[account];
    }
}
