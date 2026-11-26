// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCloneReader} from "../box/BoxCloneReader.sol";
import {IBoxSupplyFloor} from "../box/interfaces/IBoxToken.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxTokenV2Args as A, IBoxTokenV2} from "./interfaces/IBoxTokenV2.sol";

import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IHolderLedgerV2, IHolderTokenHistoryV2, HolderLedgerLimitsV2 as Limits} from "./interfaces/IHolderLedgerV2.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";

/// @notice M2 T: the frozen ERC-20/137-byte clone contract plus permanent eligibility history.
/// @dev ERC-20 clauses copied from BoxTokenV2 because that frozen M1 implementation has no override hooks.
/// No money is held here. Ledger calls are optional hints after local history commits; missed hints lose no history.
/// Fixed roles are resolved once before issuance. No coordinator/registry reads run on transfers or trades.
contract BoxTokenV2Ledger is IBoxTokenV2, IHolderTokenHistoryV2, BoxCloneReader {
    /// @notice Anyone reads the fixed 18 decimals; no funds move.
    uint8 public constant decimals = 18;

    /// @notice The release's coordinator implementation: only a clone of it, named as `initialHolder()`, initialises.
    address public immutable coordinatorImplementation;

    bool private _initialised;
    /// @notice Anyone reads live issuance less burns; no funds move.
    uint256 public totalSupply;
    /// @notice Anyone reads a balance; no funds move.
    mapping(address => uint256) public balanceOf;
    /// @notice Anyone reads a spending allowance; no funds move.
    mapping(address => mapping(address => uint256)) public allowance;

    struct Point { uint256 at; uint256 value; }
    // 0 unseen, 1 ordinary contract, 2 permanently eligible, 3 permanently excluded.
    mapping(address => uint8) private _status;
    mapping(address => Point[]) private _balances;
    Point[] private _supply;
    address[] private _holders;
    /// @inheritdoc IHolderTokenHistoryV2
    uint256 public holderCheckpoint;

    /// @notice Invalid registration or a future history query; no state or money changes.
    error InvalidHistoryRequest();

    /// @param coordinatorImplementation_ the release's coordinator implementation (file map § 11 step 1b).
    constructor(address coordinatorImplementation_) {
        coordinatorImplementation = coordinatorImplementation_;
        // The implementation itself is never a box's T: the once-guard locked here leaves it inert alone.
        _initialised = true;
    }

    /// @inheritdoc IBoxTokenV2
    function initialize() external {
        if (_initialised) revert AlreadyInitialised();
        address holder = initialHolder();
        if (msg.sender != holder || !BoxClones.isCloneOf(holder, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        _initialised = true;
        if (_argAddress(A.LEDGER) != address(0)) {
            IBoxCoordinatorV2 c = IBoxCoordinatorV2(holder);
            _status[address(0)] = 3;
            _status[address(this)] = 3;
            _status[holder] = 3;
            _status[c.poolManager()] = 3;
            for (uint256 i; i < 24; ++i) _status[c.roleAddress(i)] = 3;
        }
        uint256 supply = initialSupply();
        // A standard `_mint`: add, never assign (rule 1; `IBoxTokenV2`).
        totalSupply += supply;
        balanceOf[holder] += supply;
        emit Transfer(address(0), holder, supply);
        _checkpoint(address(0), holder, supply);
    }

    // ------------------------------------------------------------------ the clone's arguments

    /// @notice The box's coordinator, which receives the whole issuance (BC-004).
    function initialHolder() public view returns (address) {
        return _argAddress(A.HOLDER);
    }

    /// @notice The box's vault, or address(0) for a token-only box.
    function vault() public view returns (address) {
        return _argAddress(A.VAULT);
    }

    /// @inheritdoc IBoxTokenV2
    function ledger() external view returns (address) {
        return _argAddress(A.LEDGER);
    }

    /// @notice The one issuance. totalSupply + totalBurned() == initialSupply once initialised.
    function initialSupply() public view returns (uint256) {
        return _argUint(A.SUPPLY, 32);
    }

    /// @notice Anyone reads the fixed initial issuance; no funds move.
    function ISSUANCE() external view returns (uint256) {
        return initialSupply();
    }

    /// @notice Anyone reads the immutable name; no funds move.
    function name() external view returns (string memory) {
        return _text(A.NAME, A.MAX_NAME_BYTES, A.NAME_LENGTH);
    }

    /// @notice Anyone reads the immutable symbol; no funds move.
    function symbol() external view returns (string memory) {
        return _text(A.SYMBOL, A.MAX_SYMBOL_BYTES, A.SYMBOL_LENGTH);
    }

    /// @notice Anyone reads cumulative burned T; no funds move.
    function totalBurned() external view returns (uint256) {
        return initialSupply() - totalSupply;
    }

    // ------------------------------------------------------------------ ERC-20, v1's clauses

    /// @notice Anyone sets only their own allowance to a nonzero spender; no funds move.
    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ApproveToZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Anyone transfers their own T in full, subject only to the fixed destination rules.
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice An approved spender transfers from the named holder, consuming only a finite allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (amount > allowed) revert InsufficientAllowance(allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    /// @notice Anyone burns only their own T above the vault floor; an optional hint cannot block it.
    function burn(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        if (amount > balance) revert InsufficientBalance(balance, amount);
        uint256 supplyAfter = totalSupply - amount; // amount ≤ balance ≤ totalSupply
        address v = vault();
        // A token-only box (no vault) reads no floor and touches no other account.
        if (v != address(0) && v.code.length != 0) {
            // A view call (STATICCALL): the vault cannot change state or re-enter here.
            uint256 floor = IBoxSupplyFloor(v).supplyFloor();
            if (supplyAfter < floor) revert BurnBelowSupplyFloor(supplyAfter, floor);
        }
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }
        totalSupply = supplyAfter;
        emit Transfer(msg.sender, address(0), amount);
        _checkpoint(msg.sender, address(0), amount);
    }

    // ------------------------------------------------------------------ internals

    function _transfer(address from, address to, uint256 amount) private {
        // A zero `from` is only reachable through a zero-amount transferFrom; its event would read as a mint.
        if (from == address(0)) revert TransferFromZeroAddress();
        if (to == address(0)) revert TransferToZeroAddress();
        // F24 (d): T enters the vault only through the vault's own pull, and never enters this contract.
        if (to == address(this)) revert DirectSendRefused(to);
        if (to == vault() && msg.sender != to) revert DirectSendRefused(to);
        uint256 fromBalance = balanceOf[from];
        if (amount > fromBalance) revert InsufficientBalance(fromBalance, amount);
        unchecked {
            balanceOf[from] = fromBalance - amount;
            // Σ balances = totalSupply ≤ issuance: no overflow.
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        _checkpoint(from, to, amount);
    }

    /// @inheritdoc IHolderTokenHistoryV2
    function registerHolder(address holder) external {
        address l = _argAddress(A.LEDGER);
        if (l == address(0) || msg.sender != l) revert IHolderLedgerV2.Unauthorized(msg.sender);
        if (!_initialised || holder == address(0) || _status[holder] == 3) revert InvalidHistoryRequest();
        if (_status[holder] == 2) return;
        _enable(holder);
        uint256 supply = _currentEligibleSupply() + balanceOf[holder];
        ++holderCheckpoint;
        _write(holder);
        _supply.push(Point(holderCheckpoint, supply));
    }

    /// @inheritdoc IHolderTokenHistoryV2
    function eligibleSupplyAt(uint256 checkpoint) external view returns (uint256) {
        // Every live trade notice asks for this point. Keep its allowance independent of
        // lifetime history length; historical settlement still uses the exact binary search.
        if (checkpoint == holderCheckpoint) return _currentEligibleSupply();
        return _at(_supply, checkpoint);
    }

    /// @inheritdoc IHolderTokenHistoryV2
    function eligibleBalanceAt(address holder, uint256 checkpoint) external view returns (uint256) {
        return _at(_balances[holder], checkpoint);
    }

    /// @inheritdoc IHolderTokenHistoryV2
    function holderCount() external view returns (uint256) { return _holders.length; }

    /// @inheritdoc IHolderTokenHistoryV2
    function holderAt(uint256 index) external view returns (address) { return _holders[index]; }

    function _enable(address holder) private {
        _status[holder] = 2;
        _holders.push(holder);
    }

    function _checkpoint(address from, address to, uint256 amount) private {
        address l = _argAddress(A.LEDGER);
        if (l == address(0) || amount == 0 || from == to) return;
        if (_status[to] == 0) {
            // Copy only the designation prefix, never arbitrarily large recipient bytecode.
            uint256 size = to.code.length;
            bytes3 prefix;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                extcodecopy(to, ptr, 0, 3)
                prefix := mload(ptr)
            }
            if (size == 0 || (size == 23 && prefix == hex"ef0100")) _enable(to);
            else _status[to] = 1;
        }
        uint256 supply = _currentEligibleSupply();
        if (_status[from] == 2) supply -= amount;
        if (_status[to] == 2) supply += amount;
        ++holderCheckpoint;
        _write(from);
        _write(to);
        _supply.push(Point(holderCheckpoint, supply));
        bytes memory data = abi.encodeCall(IHolderLedgerV2.onTokenCheckpoint, (holderCheckpoint, from, to));
        uint256 cap = C.TOKEN_SETTLEMENT_GAS;
        if (gasleft() < cap + cap / 63 + C.POKE_OVERHEAD_GAS + Limits.TOKEN_SETTLEMENT_RESERVE_GAS) return;
        assembly ("memory-safe") { pop(call(cap, l, 0, add(data, 32), mload(data), 0, 0)) }
    }

    function _write(address holder) private {
        if (holder != address(0)) {
            _balances[holder].push(Point(holderCheckpoint, _status[holder] == 2 ? balanceOf[holder] : 0));
        }
    }

    // The last history point is also the current supply: no redundant zero-to-nonzero
    // supply slot on a first receipt (material under Amsterdam's storage pricing).
    function _currentEligibleSupply() private view returns (uint256) {
        uint256 n = _supply.length;
        return n == 0 ? 0 : _supply[n - 1].value;
    }

    function _at(Point[] storage points, uint256 checkpoint) private view returns (uint256) {
        if (checkpoint > holderCheckpoint) revert InvalidHistoryRequest();
        uint256 low;
        uint256 high = points.length;
        while (low < high) {
            uint256 mid = low + (high - low) / 2;
            if (points[mid].at <= checkpoint) low = mid + 1;
            else high = mid;
        }
        return low == 0 ? 0 : points[low - 1].value;
    }

    /// @dev The text at `offset` (left-aligned, at most `max` bytes) with its length byte at `lengthAt`.
    function _text(uint256 offset, uint256 max, uint256 lengthAt) private view returns (string memory s) {
        uint256 length = _argUint8(lengthAt);
        if (length > max) length = max;
        bytes32 word = bytes32(_argUint(offset, max) << (256 - 8 * max));
        s = new string(length);
        assembly ("memory-safe") {
            mstore(add(s, 0x20), word)
        }
    }
}
