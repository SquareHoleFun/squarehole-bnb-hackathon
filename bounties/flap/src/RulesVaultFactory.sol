// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Distribution} from "src/flap/Distribution.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "src/flap/IVaultSchemas.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {IPortalFloor} from "./IPortalFloor.sol";
import {PileDeployer, RulesVaultDeployer} from "./RulesDeployers.sol";

interface ILauncherFactoryImpl {
    function implementation() external view returns (address);
    function pileVaultFactory() external view returns (address);
}

interface IV2RouterWeth {
    function WETH() external view returns (address);
}

/// @title RulesVaultFactory: Flap's direct-launch vault factory ("pl-v1") whose vault shares income by the creator's
/// rules
/// @notice Paired with a second deployment of the unchanged `CurveLauncherFactory` (native quote) or
/// `TokenCurveLauncherFactory` (one ERC-20 quote), which names this factory in every launch's VAULT slot.
/// The creator chooses the rules BEFORE the sale exists: `setRules(launcherFactory, salt, rules)` stores them under the
/// Launcher address that factory will give this creator for this salt, and is refused once that address has code.
/// Write-once. A sale created without rules gets PILE 100% (the pile launch of before) for good.
/// At the launch the Portal calls `newVault`: this factory deploys the token's pile (the existing `PileVault`) and a
/// `RulesVault` holding the stored rules, with the pile and this factory's router filled in as the PILE and BUY_BURN
/// targets (through two stateless deployers, which keep this contract under the size limit). Both are plain contracts
/// at addresses fixed by the token and this factory. No owner, no setter beyond the creator's one
/// write before its sale exists, no upgrade (`upgradeVaultImplementation` always reverts).
contract RulesVaultFactory is DirectLaunchVaultFactoryBase {
    address public immutable hub;
    /// @notice The launch quote this factory serves: address(0) = the native coin, otherwise one ERC-20.
    address public immutable quote;
    /// @notice The PancakeSwap V2 router a BUY_BURN rule buys on.
    address public immutable router;
    /// @notice The stateless deployers that create the pile and the splitter (kept out of this contract's code size).
    PileDeployer public immutable pileDeployer;
    RulesVaultDeployer public immutable rulesDeployer;

    mapping(address launcher => IRuleSplitter.Rule[]) private _rulesOf;
    mapping(address launcher => bool) public rulesSet;
    mapping(address token => address) public vaultOf;
    mapping(address token => address) public pileOf;

    event RulesSet(address indexed launcher, address indexed creator, IRuleSplitter.Rule[] rules);
    event RulesVaultCreated(address indexed token, address indexed splitter, address indexed pile, address launcher);

    error VaultsAreImmutable();
    error QuoteNotEnabled(address quote);
    error SaleExists(address launcher);
    error RulesAlreadySet(address launcher);
    error InvalidRules(string reason);
    error NotPaired(address launcherFactory);

    constructor(address hub_, address quote_, address router_, PileDeployer pileDeployer_, RulesVaultDeployer rulesDeployer_) {
        if (
            hub_ == address(0) || router_.code.length == 0 || address(pileDeployer_).code.length == 0
                || address(rulesDeployer_).code.length == 0
        ) revert ZeroAddress();
        // a router the splitter could never buy on would make every launch with a buy-back revert inside the launch
        if (quote_ == address(0) && IV2RouterWeth(router_).WETH() == address(0)) revert ZeroAddress();
        pileDeployer = pileDeployer_;
        rulesDeployer = rulesDeployer_;
        (bool enabled,) = IPortalFloor(hub_).launchQuoteConfig(0, quote_);
        if (!enabled) revert QuoteNotEnabled(quote_);
        hub = hub_;
        quote = quote_;
        router = router_;
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The creator's rules
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The Launcher `launcherFactory` gives `creator` for `salt` (EIP-1167 clone of its implementation at
    /// salt keccak256(abi.encode(creator, salt)), as both curve launcher factories derive it).
    function launcherFor(address launcherFactory, address creator, bytes32 salt) public view returns (address) {
        return LibClone.predictDeterministicAddress(
            ILauncherFactoryImpl(launcherFactory).implementation(), keccak256(abi.encode(creator, salt)), launcherFactory
        );
    }

    /// @notice Stores the caller's rules for its sale (`launcherFactory`, `salt`) before that sale exists. Each rule:
    /// CREATOR with its payee as target; PILE and BUY_BURN with target address(0) (filled in at the launch). One to
    /// four rules, each bps > 0, summing to 10,000; at most one PILE and one BUY_BURN, and a BUY_BURN only as the last
    /// rule (it makes the heaviest outside call; the splitter runs the rules in the order given, so a call short of
    /// gas inside the buy cannot leave too little for the rules after it). Write-once.
    function setRules(address launcherFactory, bytes32 salt, IRuleSplitter.Rule[] calldata rules)
        external
        returns (address launcher)
    {
        // rules for a launcher factory that does not name this vault factory would never be used: refuse them
        if (ILauncherFactoryImpl(launcherFactory).pileVaultFactory() != address(this)) {
            revert NotPaired(launcherFactory);
        }
        launcher = launcherFor(launcherFactory, msg.sender, salt);
        if (launcher.code.length != 0) revert SaleExists(launcher);
        if (rulesSet[launcher]) revert RulesAlreadySet(launcher);
        _check(rules);
        rulesSet[launcher] = true;
        for (uint256 i; i < rules.length; ++i) _rulesOf[launcher].push(rules[i]);
        emit RulesSet(launcher, msg.sender, rules);
    }

    /// @notice The rules stored for `launcher` (PILE and BUY_BURN targets read 0 until the launch); PILE 100% when
    /// none were set.
    function rulesOf(address launcher) public view returns (IRuleSplitter.Rule[] memory r) {
        if (!rulesSet[launcher]) {
            r = new IRuleSplitter.Rule[](1);
            r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 10_000, target: address(0)});
            return r;
        }
        return _rulesOf[launcher];
    }

    function _check(IRuleSplitter.Rule[] calldata rules) private pure {
        uint256 n = rules.length;
        if (n == 0 || n > 4) revert InvalidRules("one to four rules");
        uint256 sum;
        uint256 piles;
        uint256 burns;
        for (uint256 i; i < n; ++i) {
            IRuleSplitter.Rule calldata r = rules[i];
            if (r.bps == 0) revert InvalidRules("a part of 0 bps");
            sum += r.bps;
            if (r.kind == IRuleSplitter.Kind.CREATOR) {
                if (r.target == address(0)) revert InvalidRules("a creator rule needs its payee");
            } else if (r.kind == IRuleSplitter.Kind.PILE) {
                if (r.target != address(0) || ++piles > 1) revert InvalidRules("one pile, target filled at launch");
            } else if (r.kind == IRuleSplitter.Kind.BUY_BURN) {
                if (r.target != address(0) || ++burns > 1) revert InvalidRules("one buy and burn, target filled at launch");
                if (i != n - 1) revert InvalidRules("the buy and burn goes last");
            } else {
                revert InvalidRules("unknown kind");
            }
        }
        if (sum != 10_000) revert InvalidRules("parts must sum to 10000");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The Portal's call
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc DirectLaunchVaultFactoryBase
    /// @dev `creator` is the launch's caller: the Launcher. Its stored rules (or PILE 100%) are fixed into the vault.
    function newVault(address token, address creator, uint8 launchKind, bytes calldata launchParams)
        external
        override
        onlyHub
        returns (address vault)
    {
        (, Distribution memory d, bytes memory vaultData) = _validateLaunch(token, creator, launchKind, launchParams);
        _requireNoReserveDistribution(d);
        if (vaultData.length != 0) revert InvalidVaultData();

        address pile = pileDeployer.deploy(token, quote);
        IRuleSplitter.Rule[] memory rules = rulesOf(creator);
        for (uint256 i; i < rules.length; ++i) {
            if (rules[i].kind == IRuleSplitter.Kind.PILE) rules[i].target = pile;
            else if (rules[i].kind == IRuleSplitter.Kind.BUY_BURN) rules[i].target = router;
        }
        vault = rulesDeployer.deploy(token, quote, rules);
        vaultOf[token] = vault;
        pileOf[token] = pile;
        emit RulesVaultCreated(token, vault, pile, creator);
    }

    /// @notice The vault of `token` once its launch created it (address(0) before). The native launcher calls this
    /// form after the launch and requires the vault it got from the Portal to equal it.
    function predictVault(address token, address) external view returns (address) {
        return vaultOf[token];
    }

    /// @notice The same, in the form the token-quote launcher calls.
    function predictVault(address token) external view returns (address) {
        return vaultOf[token];
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function isQuoteTokenSupported(address quoteToken) public view override returns (bool) {
        return quoteToken == quote;
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description = "Rules vault: no settings here. The creator sets the rules with setRules before the sale "
            "exists; the VAULT slot's share of every trade's tax is shared among them (creator, pile, buy and burn).";
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
