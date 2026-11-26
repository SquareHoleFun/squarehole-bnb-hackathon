// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFitSupplyFloor} from "./interfaces/IFitSupplyFloor.sol";
import {FIT_NAME, FIT_SYMBOL} from "sh-public-names/PublicNames.sol";

/// @title FitTokenBase
/// @notice The FIT ERC-20 (v2 T07): one issuance in the constructor, then no mint of any kind. The only way the supply
/// changes afterwards is `burn`, which burns the caller's own balance and nothing else (no `burnFrom`, no approved
/// burn, no burn by any role). No owner, admin, pause, blacklist, transfer fee, permit, upgrade or rescue path.
///
/// One rule ties FIT to the Misfits vault (v2 docs/03 "Rounding and boundaries", acceptance VLT-11): a burn may not
/// leave fewer than one raw FIT per Misfit inside the vault. `vault` is fixed at construction (its address is known in
/// advance, as the existing launch contracts do); once code exists there, every burn asks it for the supply floor
/// E + n and is refused below it. Before the vault exists (the pre-graduation phase has no Misfits inside) no floor
/// applies. The vault checks at its own construction that it is this token's `vault`, so the pair cannot be mis-wired.
///
/// **Refused sends** (F24 d, superseding F23 C2; F25 3 makes it the rule for every Square Hole token): a transfer to
/// the vault reverts unless the vault itself is the caller, which is exactly a withdrawal pulling its principal with
/// `transferFrom` (msg.sender == vault); a transfer to this token's own address always reverts. Both addresses are
/// fixed at construction: no owner, no list, no switch. Nothing else is refused, so wallet transfers, pool swaps
/// (the PoolManager and routers move FIT between themselves and traders), `burn` and the buy-back are unaffected. FIT
/// sent to a "dead" address such as 0x…dEaD is an ordinary transfer: it stays in totalSupply, and the vault works
/// with totalSupply as it is (F26 1). The only way to reduce totalSupply is `burn`.
///
/// @dev Written for Square Hole (MIT, no third-party code), following `SquareHoleFungibleToken`'s ERC-20 choices:
/// transfers to or from the zero address revert, zero-amount transfers are allowed, and a `type(uint256).max`
/// allowance is never decremented. Abstract only so tests can issue other supplies through the same code; the
/// deployed token is `FitToken`, which fixes the issuance at 1e27 raw units.
abstract contract FitTokenBase {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error ZeroAddress();
    error ZeroIssuance();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error InsufficientAllowance(uint256 allowance, uint256 needed);
    error TransferFromZeroAddress();
    error TransferToZeroAddress();
    error ApproveToZeroAddress();
    /// @notice A burn would take totalSupply below the vault's floor E + n (fewer than one raw FIT per Misfit inside).
    error BurnBelowSupplyFloor(uint256 supplyAfter, uint256 floor);
    /// @notice FIT sent to the vault by anyone but the vault itself, or to FIT's own address (F24 d).
    error DirectSendRefused(address to);

    uint8 public constant decimals = 18;

    /// @notice FIT issued once, in the constructor, to `initialHolder`. S + totalBurned() == initialSupply always.
    uint256 public immutable initialSupply;
    address public immutable initialHolder;
    /// @notice The Misfits vault whose supply floor every burn respects (fixed at construction).
    address public immutable vault;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint256 issuance, address recipient, address vault_) {
        if (recipient == address(0) || vault_ == address(0)) revert ZeroAddress();
        if (issuance == 0) revert ZeroIssuance();
        initialSupply = issuance;
        initialHolder = recipient;
        vault = vault_;
        // The one and only issuance (GOV-05): there is no mint function and no internal mint path.
        totalSupply = issuance;
        balanceOf[recipient] = issuance;
        emit Transfer(address(0), recipient, issuance);
    }

    /// @notice "FIT" (`FIT_NAME` of the launch set, `sh-public-names/`; the Sepolia rehearsal build compiles a neutral
    /// name). Virtual only so a placeholder rehearsal token (`RehearsalToken`, F30 Q2) runs the same code under a neutral
    /// name; the ABI is the ERC-20 `name()` getter either way.
    function name() public pure virtual returns (string memory) {
        return FIT_NAME;
    }

    /// @notice "FIT" (see `name`).
    function symbol() public pure virtual returns (string memory) {
        return FIT_SYMBOL;
    }

    /// @notice Cumulative true burns: initialSupply − totalSupply.
    function totalBurned() external view returns (uint256) {
        return initialSupply - totalSupply;
    }

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

    /// @notice Burn `amount` of the caller's own FIT. Refused when the caller holds less, or when the new supply would
    /// fall below the vault's floor E + n (VLT-11). Nothing else can reduce totalSupply.
    function burn(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        if (amount > balance) revert InsufficientBalance(balance, amount);
        uint256 supplyAfter = totalSupply - amount; // amount ≤ balance ≤ totalSupply
        if (vault.code.length != 0) {
            // A view call (STATICCALL): the vault cannot change state or re-enter here.
            uint256 floor = IFitSupplyFloor(vault).supplyFloor();
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
        // F24 (d): FIT enters the vault only through the vault's own pull, and never enters this contract.
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
}
