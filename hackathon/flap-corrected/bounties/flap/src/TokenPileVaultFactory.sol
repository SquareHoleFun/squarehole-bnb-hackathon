// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPortal} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "src/flap/IVaultSchemas.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {PileVault} from "./PileVault.sol";
import {IPortalFloor} from "./IPortalFloor.sol";

/// @title TokenPileVaultFactory: Flap's direct-launch vault factory ("pl-v1") for a PileVault held in one ERC-20
/// @notice The same as `PileVaultFactory`, for launches quoted in one ERC-20 `quote` fixed at deployment (for example
/// a test USDT): the Portal's tax processor pays the vault slot's share in that quote (a transfer, then an empty
/// wake call), and the PileVault holds and pays it. The factory deploys only when the Portal reports the quote as
/// enabled, and serves exactly that quote. Each vault is an ERC-1967 beacon proxy of this factory's beacon; only Flap's
/// Guardian can upgrade it (`upgradeVaultImplementation`, as Flap's `SplitVaultFactory`).
contract TokenPileVaultFactory is DirectLaunchVaultFactoryBase {
    address public immutable hub;
    /// @notice The one quote this factory's piles are held in.
    address public immutable quote;
    /// @notice The solady `UpgradeableBeacon` every pile of this factory points at (owned by this factory).
    address public immutable beacon;
    /// @notice The one launcher factory whose Launchers this vault factory serves, fixed at construction. It is the
    /// deployer's next CREATE address, predicted before this factory is deployed (only that account's next transaction
    /// can create a contract there, so nobody else can take it); the launcher factory's constructor refuses a vault
    /// factory that does not name it.
    address public immutable pairedLauncherFactory;

    event PileVaultCreated(address indexed token, address indexed vault, address indexed creator, address quoteToken);

    event FlapVaultImplementationUpgraded(address implementation);
    error QuoteNotEnabled(address quote);
    /// @notice The launch's caller is not a Launcher of the paired launcher factory.
    error NotPaired(address launcher);

    constructor(address hub_, address quote_, address pairedLauncherFactory_) {
        if (hub_ == address(0) || quote_ == address(0) || pairedLauncherFactory_ == address(0)) revert ZeroAddress();
        (bool enabled,) = IPortalFloor(hub_).launchQuoteConfig(0, quote_);
        if (!enabled) revert QuoteNotEnabled(quote_);
        hub = hub_;
        quote = quote_;
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
        (, Distribution memory d, bytes memory vaultData) = _validateLaunch(token, creator, launchKind, launchParams);
        _requireNoReserveDistribution(d);
        if (vaultData.length != 0) revert InvalidVaultData();
        // Only a Launcher the Portal recorded as made by the paired launcher factory (Flap's pre-audit R3; Flap's own
        // CrowdVaultFactory does the same): a launcher of any other factory naming this vault factory is refused.
        if (IPortal(hub).getLauncher(creator).launcherFactory != pairedLauncherFactory) revert NotPaired(creator);
        vault = LibClone.deployDeterministicERC1967BeaconProxy(beacon, bytes32(uint256(uint160(token))));
        PileVault(payable(vault)).initialize(token, quote);
        emit PileVaultCreated(token, vault, creator, quote);
    }

    /// @notice The vault address a launch of `token` gets (also before the launch).
    function predictVault(address token) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(
            beacon, bytes32(uint256(uint160(token))), address(this)
        );
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    /// @dev Exactly the one quote fixed at deployment.
    function isQuoteTokenSupported(address quoteToken) public view override returns (bool) {
        return quoteToken == quote;
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description = "Pile vault in an ERC-20 quote: no settings. The VAULT slot's share of every trade's tax "
            "fills a pile that any holder redeems by handing tokens in (pile x tokens / circulating supply).";
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
