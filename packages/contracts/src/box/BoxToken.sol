// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxSupplyFloor, IBoxToken} from "./interfaces/IBoxToken.sol";

/// @title BoxTokenBase
/// @notice The box token T's code (slice S3; IBoxToken): one issuance in the constructor, then no mint of any kind; the
/// only way the supply changes is `burn`, of the caller's own balance, above the box vault's floor E + n. A copy of
/// FitTokenBase (src/v2/FitTokenBase.sol:30-144 at 46a030f6) with the name and symbol as constructor data (plan § 3.8)
/// instead of compile-time constants, re-checked against the spec's string rule, and BoxSpecV1's names for the
/// issuance. No owner, admin, pause, blacklist, transfer fee, permit, upgrade or rescue (F23 C2, F72 (2)).
///
/// **Refused sends** (F24 (d), F25 (3); BC-043): a transfer to the vault reverts unless the vault itself is the caller
/// (its own pull with `transferFrom`); a transfer to this token's own address always reverts. Nothing else is refused:
/// wallet transfers, pool swaps, `burn` and every other box contract are unaffected (BC-055). T sent to a dead address
/// stays in totalSupply (F26 (1)).
///
/// **The supply floor** (VLT-11; BC-005): once `vault` has code, every burn asks it for E + n and is refused below it.
/// A box's vault clone exists from the coordinator's deployment on and reports 0 until it is initialised, so a burn
/// before then (none happens: the bootstrap burn follows the vault's `initialize`) meets a floor of 0.
///
/// @dev Abstract only so tests can issue another supply through the same code (the vault trace vectors carry their
/// own); the deployed token is `BoxToken`, which fixes the issuance at BoxSpecV1.ISSUANCE = 1e27. ERC-20 choices as
/// FitTokenBase: transfers to or from the zero address revert, zero-amount transfers pass, a max allowance is never
/// decremented. Written for Square Hole (MIT, no third-party code).
abstract contract BoxTokenBase is IBoxToken {
    /// @dev The spec's string rule (BoxSpecV1 RULE_JSON_TEXT): bytes 0x20-0x21, 0x23-0x5b, 0x5d-0x7e
    /// (BoxSpecV1.sol:519).
    uint256 private constant _JSON_TEXT = 0x000000000000000000000000000000007fffffffeffffffffffffffb00000000;
    uint256 private constant _MAX_NAME_BYTES = 32;
    uint256 private constant _MAX_SYMBOL_BYTES = 11;

    uint8 public constant decimals = 18;

    /// @notice T issued once, in the constructor, to `initialHolder`. totalSupply + totalBurned() == initialSupply.
    uint256 public immutable initialSupply;
    /// @inheritdoc IBoxToken
    address public immutable initialHolder;
    /// @inheritdoc IBoxToken
    address public immutable vault;
    /// @dev The name (≤ 32 bytes) and symbol (≤ 11 bytes), left-aligned, and their lengths: fixed for good (F72 (2)).
    bytes32 private immutable _name;
    bytes32 private immutable _symbol;
    uint256 private immutable _nameLength;
    uint256 private immutable _symbolLength;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @param issuance The one issuance (1e27 for every box; other values in tests only).
    /// @param name_ The spec's tokenName: 1-32 bytes, printable ASCII without `"` or `\`.
    /// @param symbol_ The spec's tokenSymbol: 1-11 bytes, the same rule.
    /// @param holder The box's coordinator, which receives the whole issuance (BC-004).
    /// @param vault_ The box's vault (its address is fixed before either exists, SH-S0-spikes § 2.2).
    constructor(uint256 issuance, string memory name_, string memory symbol_, address holder, address vault_) {
        if (holder == address(0) || vault_ == address(0)) revert ZeroAddress();
        _checkText(bytes(name_), _MAX_NAME_BYTES);
        _checkText(bytes(symbol_), _MAX_SYMBOL_BYTES);
        initialSupply = issuance;
        initialHolder = holder;
        vault = vault_;
        _name = bytes32(bytes(name_));
        _symbol = bytes32(bytes(symbol_));
        _nameLength = bytes(name_).length;
        _symbolLength = bytes(symbol_).length;
        // The one and only issuance (GOV-05): there is no mint function and no internal mint path.
        totalSupply = issuance;
        balanceOf[holder] = issuance;
        emit Transfer(address(0), holder, issuance);
    }

    /// @inheritdoc IBoxToken
    function name() external view returns (string memory) {
        return _string(_name, _nameLength);
    }

    /// @inheritdoc IBoxToken
    function symbol() external view returns (string memory) {
        return _string(_symbol, _symbolLength);
    }

    /// @inheritdoc IBoxToken
    function ISSUANCE() external view returns (uint256) {
        return initialSupply;
    }

    /// @inheritdoc IBoxToken
    function totalBurned() external view returns (uint256) {
        return initialSupply - totalSupply;
    }

    /// @inheritdoc IBoxToken
    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ApproveToZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @inheritdoc IBoxToken
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @inheritdoc IBoxToken
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

    /// @inheritdoc IBoxToken
    function burn(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        if (amount > balance) revert InsufficientBalance(balance, amount);
        uint256 supplyAfter = totalSupply - amount; // amount ≤ balance ≤ totalSupply
        if (vault.code.length != 0) {
            // A view call (STATICCALL): the vault cannot change state or re-enter here.
            uint256 floor = IBoxSupplyFloor(vault).supplyFloor();
            if (supplyAfter < floor) revert BurnBelowSupplyFloor(supplyAfter, floor);
        }
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }
        totalSupply = supplyAfter;
        emit Transfer(msg.sender, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) private {
        // A zero `from` is only reachable through a zero-amount transferFrom; its event would read as a mint.
        if (from == address(0)) revert TransferFromZeroAddress();
        if (to == address(0)) revert TransferToZeroAddress();
        // F24 (d): T enters the vault only through the vault's own pull, and never enters this contract.
        if (to == address(this) || (to == vault && msg.sender != vault)) revert DirectSendRefused(to);
        uint256 fromBalance = balanceOf[from];
        if (amount > fromBalance) revert InsufficientBalance(fromBalance, amount);
        unchecked {
            balanceOf[from] = fromBalance - amount;
            // Σ balances = totalSupply ≤ issuance: no overflow.
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    /// @dev 1 … `max` bytes, each allowed by the spec's string rule, else `InvalidName`.
    function _checkText(bytes memory text, uint256 max) private pure {
        uint256 length = text.length;
        if (length == 0 || length > max) revert InvalidName();
        for (uint256 i; i < length; ++i) {
            if ((_JSON_TEXT >> uint8(text[i])) & 1 == 0) revert InvalidName();
        }
    }

    function _string(bytes32 word, uint256 length) private pure returns (string memory s) {
        s = new string(length);
        assembly ("memory-safe") {
            mstore(add(s, 0x20), word)
        }
    }
}

/// @title BoxToken
/// @notice A box's token T (slice S3): exactly 1,000,000,000 T (1e27 raw units, 18 decimals; BoxSpecV1.ISSUANCE,
/// F10 (c)) issued once, at construction, to the box's coordinator. A full contract per box, not a clone, so exchanges
/// list it as a plain ERC-20 (plan § 2, P4; BC-055). See `BoxTokenBase` for the full rule set.
contract BoxToken is BoxTokenBase {
    /// @param name_ The spec's tokenName.
    /// @param symbol_ The spec's tokenSymbol.
    /// @param holder The box's coordinator.
    /// @param vault_ The box's vault.
    constructor(string memory name_, string memory symbol_, address holder, address vault_)
        BoxTokenBase(BoxSpecV1.ISSUANCE, name_, symbol_, holder, vault_)
    {}
}
