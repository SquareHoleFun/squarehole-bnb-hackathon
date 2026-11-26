// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPortalTypes, IPortal} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "src/flap/IVaultSchemas.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {PileVault} from "./PileVault.sol";

/// @title PileVaultFactory: Flap's direct-launch vault factory ("pl-v1") for PileVault
/// @notice The Portal calls `newVault` while it creates a launch whose fee slots name this factory in a VAULT slot.
/// The factory checks the launch, then deploys one PileVault per token at an address fixed by the token: an ERC-1967
/// beacon proxy of this factory's beacon (salt = the token's predicted address), initialized in the same call. It takes
/// no `vaultData` and none of the reserve: the vault only receives tax revenue. Upgrades as Flap's guide asks: this
/// factory owns the beacon and `upgradeVaultImplementation` is Flap's Guardian's only (Flap's `SplitVaultFactory`).
contract PileVaultFactory is DirectLaunchVaultFactoryBase {
    /// @notice The Pool Launch Portal allowed to call `newVault`.
    address public immutable hub;
    /// @notice The solady `UpgradeableBeacon` every pile of this factory points at (owned by this factory).
    address public immutable beacon;
    /// @notice The one launcher factory whose Launchers this vault factory serves, fixed at construction. It is the
    /// deployer's next CREATE address, predicted before this factory is deployed (only that account's next transaction
    /// can create a contract there, so nobody else can take it); the launcher factory's constructor refuses a vault
    /// factory that does not name it.
    address public immutable pairedLauncherFactory;

    event PileVaultCreated(address indexed token, address indexed vault, address indexed creator, address quoteToken);

    event FlapVaultImplementationUpgraded(address implementation);
    /// @notice The launch's caller is not a Launcher of the paired launcher factory.
    error NotPaired(address launcher);

    constructor(address hub_, address pairedLauncherFactory_) {
        if (hub_ == address(0) || pairedLauncherFactory_ == address(0)) revert ZeroAddress();
        hub = hub_;
        pairedLauncherFactory = pairedLauncherFactory_;
        beacon = address(new UpgradeableBeacon(address(this), address(new PileVault())));
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function newVault(address token, address creator, uint8 launchKind, bytes calldata launchParams)
        external
        override
        onlyHub
        returns (address vault)
    {
        (IPortalTypes.CreateTaxTokenParams memory p, Distribution memory d, bytes memory vaultData) =
            _validateLaunch(token, creator, launchKind, launchParams);
        _requireNoReserveDistribution(d);
        if (vaultData.length != 0) revert InvalidVaultData();
        // Only a Launcher the Portal recorded as made by the paired launcher factory (Flap's pre-audit R3; Flap's own
        // CrowdVaultFactory does the same): a launcher of any other factory naming this vault factory is refused.
        if (IPortal(hub).getLauncher(creator).launcherFactory != pairedLauncherFactory) revert NotPaired(creator);
        vault = LibClone.deployDeterministicERC1967BeaconProxy(beacon, bytes32(uint256(uint160(token))));
        PileVault(payable(vault)).initialize(token, p.quoteToken);
        emit PileVaultCreated(token, vault, creator, p.quoteToken);
    }

    /// @notice The vault address a launch of `token` gets (also before the launch).
    /// @dev `quoteToken` is kept for the callers' form; the address depends on the token alone.
    function predictVault(address token, address quoteToken) external view returns (address) {
        quoteToken;
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(
            beacon, bytes32(uint256(uint160(token))), address(this)
        );
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    /// @dev Native BNB only. The pile pays exactly or not at all, so an ERC-20 quote whose transfers are taxed would
    ///      make every redemption revert; this factory does not offer what the core cannot pay exactly.
    function isQuoteTokenSupported(address quoteToken) public pure override returns (bool) {
        return quoteToken == address(0);
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description = "Pile vault: no settings. The VAULT slot's share of every trade's tax fills a pile that "
            "any holder redeems by handing tokens in (pile x tokens / circulating supply).";
        schema.fields = new FieldDescriptor[](0);
        schema.isArray = false;
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory) {
        return new FactoryPolicy[](0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Beacon administration (Guardian only), as Flap's SplitVaultFactory / CrowdVaultFactory
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc DirectLaunchVaultFactoryBase
    /// @dev Flap's Guardian only (`onlyGuardian`, the chain's Guardian from `LaunchVaultAddresses`); no other upgrade
    /// path: this factory owns the beacon and has no owner.
    function upgradeVaultImplementation(address newImplementation) external override onlyGuardian {
        UpgradeableBeacon(beacon).upgradeTo(newImplementation);
        emit FlapVaultImplementationUpgraded(newImplementation);
    }

    /// @notice The implementation every vault of this factory currently delegates to.
    function beaconImplementation() external view returns (address) {
        return UpgradeableBeacon(beacon).implementation();
    }
}
