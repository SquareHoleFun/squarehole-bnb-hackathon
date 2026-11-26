// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPortalTypes} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "src/flap/IVaultSchemas.sol";
import {PileVault} from "./PileVault.sol";

/// @title PileVaultFactory: Flap's direct-launch vault factory ("pl-v1") for PileVault
/// @notice The Portal calls `newVault` while it creates a launch whose fee slots name this factory in a VAULT slot.
/// The factory checks the launch, then deploys one PileVault per token at an address fixed by the token
/// (CREATE2, salt = the token's predicted address). It takes no `vaultData` and none of the reserve: the vault
/// only receives tax revenue. Vaults are plain contracts: `upgradeVaultImplementation` always reverts, so neither
/// Flap's Guardian nor anyone else can change a pile's rules after its launch.
contract PileVaultFactory is DirectLaunchVaultFactoryBase {
    /// @notice The Pool Launch Portal allowed to call `newVault`.
    address public immutable hub;

    event PileVaultCreated(address indexed token, address indexed vault, address indexed creator, address quoteToken);

    /// @notice Vaults of this factory cannot be upgraded by anyone.
    error VaultsAreImmutable();

    constructor(address hub_) {
        if (hub_ == address(0)) revert ZeroAddress();
        hub = hub_;
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
        vault = address(new PileVault{salt: bytes32(uint256(uint160(token)))}(token, p.quoteToken));
        emit PileVaultCreated(token, vault, creator, p.quoteToken);
    }

    /// @notice The vault address a launch of `token` gets (also before the launch).
    function predictVault(address token, address quoteToken) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(uint256(uint160(token))),
                keccak256(abi.encodePacked(type(PileVault).creationCode, abi.encode(token, quoteToken)))
            )
        );
        return address(uint160(uint256(h)));
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

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function upgradeVaultImplementation(address) external pure override {
        revert VaultsAreImmutable();
    }
}
