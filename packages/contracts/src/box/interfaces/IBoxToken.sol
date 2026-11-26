// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What T asks the box's vault before every burn (generalises IFitSupplyFloor, src/v2/interfaces/
/// IFitSupplyFloor.sol:8-11).
interface IBoxSupplyFloor {
    /// @return floor The lowest totalSupply T may reach after a burn: the vault's escrow principal E plus the items
    /// inside n, so at least one raw T backs every item inside (VLT-11; BC-005).
    function supplyFloor() external view returns (uint256 floor);
}

/// @title IBoxToken (slice S3)
/// @notice The box token T: a plain ERC-20 (exchanges list it as one, plan § 2 P4), a full contract per box (not a
/// clone). Generalises FitTokenBase (src/v2/FitTokenBase.sol:30-144) with the name and symbol as runtime data
/// (plan § 3.8) instead of compile-time constants.
///
/// - **Issuance.** Exactly `ISSUANCE()` = 1e27 raw units (1,000,000,000 T at 18 decimals; BoxSpecV1.ISSUANCE, F10 (c))
///   once, in the constructor, to `initialHolder()`, the box's coordinator. No mint of any kind afterwards (BC-004).
/// - **Burn rules.** `burn` destroys only the caller's own balance and lowers totalSupply by exactly that amount; no
///   burnFrom, no approved burn, no burn by any role. Once `vault()` has code, a burn that would leave totalSupply
///   below `IBoxSupplyFloor(vault()).supplyFloor()` reverts `BurnBelowSupplyFloor` (BC-005). T sent to a dead address
///   stays in totalSupply (F26 (1)).
/// - **Refused sends** (F24 (d), F25 (3); BC-043): a transfer to `vault()` reverts unless the vault itself is the
///   caller (its own pull); a transfer to the token's own address always reverts. Nothing else is refused.
/// - **Fixed forever** (F72 (2), F23 C2): name, symbol, decimals, issuance, vault. No owner, admin, pause, blacklist,
///   transfer fee, permit, upgrade or rescue.
/// @dev Invariants: totalSupply + totalBurned() == ISSUANCE(); Σ balances == totalSupply; totalSupply never rises.
/// Transfers to or from address(0) revert; zero-amount transfers pass; a max allowance is never decremented.
interface IBoxToken {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error ZeroAddress();
    /// @notice A name or symbol outside the spec's string rule (printable ASCII without `"` or `\`; 1-32 and 1-11
    /// bytes). The factory validates the spec first; the token re-checks so a direct deployment cannot differ.
    error InvalidName();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error InsufficientAllowance(uint256 allowance, uint256 needed);
    error TransferFromZeroAddress();
    error TransferToZeroAddress();
    error ApproveToZeroAddress();
    /// @notice A burn would take totalSupply below the vault's floor E + n.
    error BurnBelowSupplyFloor(uint256 supplyAfter, uint256 floor);
    /// @notice T sent to the vault by anyone but the vault, or to the token's own address.
    error DirectSendRefused(address to);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    /// @notice Always 18.
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Burn `amount` of the caller's own T. Anyone, for their own balance only.
    function burn(uint256 amount) external;

    /// @notice 1e27: the one issuance (BoxSpecV1.ISSUANCE).
    function ISSUANCE() external view returns (uint256);
    /// @notice Equal to ISSUANCE(); kept under FitTokenBase's name for the indexer.
    function initialSupply() external view returns (uint256);
    /// @notice The box's coordinator, which received the issuance (BC-004: no externally owned account held T).
    function initialHolder() external view returns (address);
    /// @notice The box's vault: the only allowed sender of a transfer to itself, and the supply-floor source.
    function vault() external view returns (address);
    /// @notice ISSUANCE() − totalSupply.
    function totalBurned() external view returns (uint256);
}
