// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Distribution} from "src/flap/Distribution.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "src/flap/IVaultSchemas.sol";
import {PileVault} from "./PileVault.sol";
import {IPortalFloor} from "./IPortalFloor.sol";

/// @title TokenPileVaultFactory: Flap's direct-launch vault factory ("pl-v1") for a PileVault held in one ERC-20
/// @notice The same as `PileVaultFactory`, for launches quoted in one ERC-20 `quote` fixed at deployment (for example
/// a test USDT): the Portal's tax processor pays the vault slot's share in that quote (a transfer, then an empty
/// wake call), and the PileVault holds and pays it. The factory deploys only when the Portal reports the quote as
/// enabled, and serves exactly that quote. Vaults are plain contracts: `upgradeVaultImplementation` always reverts.
contract TokenPileVaultFactory is DirectLaunchVaultFactoryBase {
    address public immutable hub;
    /// @notice The one quote this factory's piles are held in.
    address public immutable quote;

    event PileVaultCreated(address indexed token, address indexed vault, address indexed creator, address quoteToken);

    error VaultsAreImmutable();
    error QuoteNotEnabled(address quote);

    constructor(address hub_, address quote_) {
        if (hub_ == address(0) || quote_ == address(0)) revert ZeroAddress();
        (bool enabled,) = IPortalFloor(hub_).launchQuoteConfig(0, quote_);
        if (!enabled) revert QuoteNotEnabled(quote_);
        hub = hub_;
        quote = quote_;
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
        vault = address(new PileVault{salt: bytes32(uint256(uint160(token)))}(token, quote));
        emit PileVaultCreated(token, vault, creator, quote);
    }

    /// @notice The vault address a launch of `token` gets (also before the launch).
    function predictVault(address token) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(uint256(uint160(token))),
                keccak256(abi.encodePacked(type(PileVault).creationCode, abi.encode(token, quote)))
            )
        );
        return address(uint160(uint256(h)));
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

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function upgradeVaultImplementation(address) external pure override {
        revert VaultsAreImmutable();
    }
}
