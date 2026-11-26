// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCloneReader} from "../box/BoxCloneReader.sol";
import {IBoxSupplyFloor} from "../box/interfaces/IBoxToken.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxTokenV2Args as A, IBoxTokenV2} from "./interfaces/IBoxTokenV2.sol";

/// @title BoxTokenV2 (core v2 M1, ticket M1-30-b; F102, F103, change queues 1-3)
/// @notice The release's one T implementation: every v2 box's T is a non-upgradeable EIP-1167 clone of this code, its
/// runtime exactly the 45-byte standard proxy followed by `BoxTokenV2Args` (182 bytes; `BoxClones.runtime`). A copy of
/// v1's `BoxTokenBase` (`BoxToken.sol:24-170`) with what F102 changes (`IBoxTokenV2`):
/// - **Arguments, not immutables**: holder, vault, ledger, supply, name and symbol are read from the clone's own code
///   at the frozen offsets (EXTCODECOPY from byte 45; in the DELEGATECALL frame `address()` is the clone). The texts'
///   rule is `validate()`'s (format 2); `BoxTokenV2Args.encode` bounds their lengths.
/// - **`initialize()` instead of the constructor's issuance**, with the clone scanner research's design rules for T
///   (`docs/research/clone-scanner-check.md` Part 2): it takes no parameters (rule 2); it runs once behind a hand-rolled
///   once-guard, locked in the implementation's constructor, so it is inert alone (rule 3 asks for OZ's or Solady's
///   `initializer` and `_disableInitializers()`; the research found hand-rolled guards unflagged on GoPlus, SEND and
///   PMD, and M1-64's Sepolia scan checks this form); it mints as a standard
///   `_mint` does, `totalSupply += SUPPLY; balanceOf[HOLDER] += SUPPLY`, with the one `Transfer` from address(0), never
///   by direct assignment (rule 1, the pattern GoPlus flags as `owner_change_balance`); and it keeps the
///   coordinator-only check (change queue 3, L8): the caller must be the clone's `initialHolder()`, and that account a
///   standard clone of the release's coordinator implementation (`coordinatorImplementation`, an immutable here; ADR-0016
///   § 4, file map § 11 step 1b), so a stranger's clone of this code naming any other holder can never be initialised
///   and holds no supply.
/// - **Every other clause is v1's** (BC-055): full amounts and one standard event for `transfer`, `approve` and
///   `transferFrom`; zero-amount transfers pass; a max allowance is never decremented; transfers to or from address(0)
///   refused; a send to the vault refused unless the vault pulls, a send to T itself always (`DirectSendRefused`);
///   `burn` of the caller's own balance, refused below the vault's `supplyFloor()` once the vault has code. A token-only
///   box has no vault (address(0)): nothing is refused for it and no floor is read.
/// - **M2's ledger** (`ledger()`, role 17) is read and never called: M1 writes it as address(0), and M2's ledger variant
///   is a second implementation (`IBoxTokenV2`).
/// @dev No owner, admin, pause, blocklist, fee, permit, mint, setter, upgrade or rescue (rule 4); no DELEGATECALL,
/// CALLCODE or SELFDESTRUCT; no EIP-1967 slot. Storage: the initialised flag, then v1's three ERC-20 slots, so
/// `totalSupply()` and `balanceOf()` each read one slot. Written for Square Hole (MIT, no third-party code).
contract BoxTokenV2 is IBoxTokenV2, BoxCloneReader {
    uint8 public constant decimals = 18;

    /// @notice The release's coordinator implementation: only a clone of it, named as `initialHolder()`, initialises.
    address public immutable coordinatorImplementation;

    bool private _initialised;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

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
        uint256 supply = initialSupply();
        // A standard `_mint`: add, never assign (rule 1; `IBoxTokenV2`).
        totalSupply += supply;
        balanceOf[holder] += supply;
        emit Transfer(address(0), holder, supply);
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

    function ISSUANCE() external view returns (uint256) {
        return initialSupply();
    }

    function name() external view returns (string memory) {
        return _text(A.NAME, A.MAX_NAME_BYTES, A.NAME_LENGTH);
    }

    function symbol() external view returns (string memory) {
        return _text(A.SYMBOL, A.MAX_SYMBOL_BYTES, A.SYMBOL_LENGTH);
    }

    function totalBurned() external view returns (uint256) {
        return initialSupply() - totalSupply;
    }

    // ------------------------------------------------------------------ ERC-20, v1's clauses

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ApproveToZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

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
