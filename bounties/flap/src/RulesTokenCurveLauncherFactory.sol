// SPDX-License-Identifier: MIT
// Text-only copy of src/TokenCurveLauncherFactory.sol for the rules pair (script/rules-launchers.py): only names, string
// literals and comments differ.
pragma solidity ^0.8.26;

import {IPortal} from "src/flap/IPortal.sol";
import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherDataSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {CurveConfig} from "./RulesCurveLauncher.sol";
import {RulesTokenCurveLauncher} from "./RulesTokenCurveLauncher.sol";
import {CurveMath} from "./CurveMath.sol";
import {IPortalFloor} from "./IPortalFloor.sol";
import {TokenPileVaultFactory} from "./TokenPileVaultFactory.sol";

/// @title RulesTokenCurveLauncherFactory: Flap's Launcher Factory ("lf-v1") for RulesTokenCurveLauncher, one ERC-20 quote
/// @notice The same two ways in and the same checks as `RulesCurveLauncherFactory`, for sales priced, paid and pooled in
/// one ERC-20 `quote` fixed at deployment (the quote of its `TokenPileVaultFactory`). It deploys only when the Portal
/// reports that quote as enabled, and reads the floor at the Portal's own price for it. The value of a creation call
/// is exactly the Portal's salt-lock fee (in the native coin); there is no first buy in this variant.
/// Launchers are EIP-1167 clones whose code cannot change: `upgradeVaultImplementation` always reverts; no owner,
/// no fee, no switch.
contract RulesTokenCurveLauncherFactory is LauncherFactoryBase {
    /// @notice The Pool Launch Portal.
    address public immutable hub;
    /// @notice The vault factory every Launcher of this factory names in its VAULT fee slot.
    address public immutable pileVaultFactory;
    /// @notice The tax-token implementation the Portal clones (for `predictToken`).
    address public immutable tokenImpl;
    /// @notice The Launcher code every clone runs.
    address public immutable implementation;
    /// @notice The one quote of every sale of this factory.
    address public immutable quote;

    uint64 public constant MIN_DURATION = 5 minutes;
    uint64 public constant MAX_DURATION = 30 days;
    /// @notice The Portal's tax bounds, measured on the test network Portal v1.2.0 (25 Nov 2026, fork tests): each
    /// rate is 0 or 100..1000 bps (1..99 revert `InvalidTaxBps`), and the tax runs at least the anti-farmer window
    /// (shorter reverts "taxDuration < antiFarmerDuration"); every value up to 2^32 - 1 seconds was accepted.
    uint16 public constant MIN_TAX_BPS = 100;
    uint16 public constant MAX_TAX_BPS = 1000;
    uint32 public constant MIN_TAX_DURATION = 1 days;
    /// @notice The raise must be the target within one millionth (R(S) rounds; see `curveFor`).
    uint256 public constant RAISE_TOLERANCE_DIVISOR = 1_000_000;
    /// @notice The pool gets at least one whole token, so its opening price is the curve's final price within one
    /// part in poolToken base units (the pool's token side is rounded down).
    uint256 public constant MIN_POOL_TOKEN = 1 ether;
    /// @notice Supply bounds of a Pool Launch token (Flap: 100 to 1e15 whole tokens).
    uint256 public constant MIN_SUPPLY = 100 ether;
    uint256 public constant MAX_SUPPLY = 1e15 ether;

    event TokenCurveLauncherCreated(address indexed launcher, address indexed creator, bytes32 salt, bool viaPortal);

    error InvalidConfig(string reason);
    error QuoteNotEnabled();
    error BelowLiquidityFloor(uint256 quoteUsdWad, uint256 requiredUsdWad);
    error LaunchersAreImmutable();

    constructor(address hub_, address pileVaultFactory_, address tokenImpl_) {
        if (hub_ == address(0) || pileVaultFactory_ == address(0) || tokenImpl_ == address(0)) {
            revert InvalidConfig("zero address");
        }
        // The vault factory must answer to the same Portal, or no launch could ever create its vault.
        if (TokenPileVaultFactory(pileVaultFactory_).hub() != hub_) revert InvalidConfig("vault factory answers to another hub");
        address quote_ = TokenPileVaultFactory(pileVaultFactory_).quote();
        (bool enabled,) = IPortalFloor(hub_).launchQuoteConfig(0, quote_);
        if (!enabled) revert QuoteNotEnabled();
        hub = hub_;
        pileVaultFactory = pileVaultFactory_;
        tokenImpl = tokenImpl_;
        quote = quote_;
        implementation = address(new RulesTokenCurveLauncher(hub_, pileVaultFactory_, tokenImpl_, quote_));
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Creating a Launcher
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc LauncherFactoryBase
    function _newLauncher(address creator, bytes calldata data) internal override returns (address) {
        CurveConfig memory c = abi.decode(data, (CurveConfig));
        return _create(creator, c, true);
    }

    /// @notice The direct way: anyone creates a Launcher for themselves without `Portal.newLauncher`.
    function createLauncher(CurveConfig calldata c) external payable returns (address) {
        return _create(msg.sender, c, false);
    }

    function _create(address creator, CurveConfig memory c, bool viaPortal) private returns (address launcher) {
        checkConfig(c, viaPortal);
        launcher = LibClone.cloneDeterministic(implementation, _cloneSalt(creator, c.salt));
        RulesTokenCurveLauncher(launcher).initialize{value: msg.value}(creator, c);
        emit TokenCurveLauncherCreated(launcher, creator, c.salt, viaPortal);
    }

    function _cloneSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Checks and previews (views a launch page calls)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The curve a config gives: virtual tokens Y0, the exact raise R(saleTokens), the pool's tokens, the
    /// token's supply, and the start and final prices (quote base units per whole token).
    function curveFor(uint256 saleTokens, uint256 targetRaise, uint256 virtualBnb)
        public
        pure
        returns (
            uint256 virtualTokens,
            uint256 raise,
            uint256 poolToken,
            uint256 totalSupply,
            uint256 startPrice,
            uint256 finalPrice
        )
    {
        virtualTokens = CurveMath.virtualTokens(virtualBnb, targetRaise, saleTokens);
        if (virtualTokens <= saleTokens) revert InvalidConfig("curve too steep for its sale");
        raise = CurveMath.reserve(virtualBnb, virtualTokens, saleTokens);
        poolToken = CurveMath.poolToken(virtualBnb, virtualTokens, saleTokens, raise);
        totalSupply = saleTokens + poolToken;
        startPrice = CurveMath.price(virtualBnb, virtualTokens, 0);
        finalPrice = CurveMath.price(virtualBnb, virtualTokens, saleTokens);
    }

    /// @notice Reverts with the reason a sale would be refused; returns quietly when it would be accepted.
    function checkConfig(CurveConfig memory c, bool viaPortal) public view {
        if (bytes(c.name).length == 0 || bytes(c.symbol).length == 0) revert InvalidConfig("name or symbol empty");
        if (c.salt == bytes32(0)) revert InvalidConfig("salt is zero");
        if (uint16(uint160(predictToken(c.salt))) != 0x7777) revert InvalidConfig("token address must end in 7777");
        if (c.saleTokens == 0 || c.targetRaise == 0 || c.virtualBnb == 0) revert InvalidConfig("zero curve value");
        if (c.duration < MIN_DURATION || c.duration > MAX_DURATION) revert InvalidConfig("duration out of range");
        if (c.tradeFeeBps > 500) revert InvalidConfig("trade fee above 5%");
        if (c.buyTaxBps > MAX_TAX_BPS || c.sellTaxBps > MAX_TAX_BPS) revert InvalidConfig("tax above 10%");
        if ((c.buyTaxBps != 0 && c.buyTaxBps < MIN_TAX_BPS) || (c.sellTaxBps != 0 && c.sellTaxBps < MIN_TAX_BPS)) {
            revert InvalidConfig("a tax below 1% that is not 0");
        }
        if (c.buyTaxBps == 0 && c.sellTaxBps == 0) revert InvalidConfig("no tax: the pile would never fill");
        if (c.burnShareBps >= 10_000) revert InvalidConfig("burn share leaves nothing for the pile");
        if (c.taxDuration < MIN_TAX_DURATION) revert InvalidConfig("tax duration below one day");
        (, uint256 raise, uint256 poolToken, uint256 total,,) = curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        if (poolToken < MIN_POOL_TOKEN || raise == 0) revert InvalidConfig("pool below one token");
        // a standard V2 pair keeps each reserve in 112 bits; the token side is already bounded by MAX_SUPPLY (1e33)
        if (raise > type(uint112).max) revert InvalidConfig("raise above a V2 reserve");
        uint256 off = raise > c.targetRaise ? raise - c.targetRaise : c.targetRaise - raise;
        if (off > c.targetRaise / RAISE_TOLERANCE_DIVISOR) revert InvalidConfig("raise off target");
        if (total < MIN_SUPPLY || total > MAX_SUPPLY) revert InvalidConfig("supply out of range");
        (uint256 quoteUsd, uint256 required) = liquidityFloor(raise, poolToken, total, viaPortal);
        if (quoteUsd < required) revert BelowLiquidityFloor(quoteUsd, required);
    }

    /// @notice The Portal's creation floor for a launch: the pool's quote in USD (at the Portal's own price) and the
    /// USD it requires, with the multiplier that would apply (this factory's, when enabled and used through Flap).
    function liquidityFloor(uint256 poolQuote, uint256 poolToken, uint256 totalSupply, bool viaPortal)
        public
        view
        returns (uint256 quoteUsdWad, uint256 requiredUsdWad)
    {
        (bool enabled, uint256 price) = IPortalFloor(hub).launchQuoteConfig(0, quote);
        if (!enabled) revert QuoteNotEnabled();
        IPortalFloor.GraduationFloorResultV2 memory r = IPortalFloor(hub).graduationFloorV2(
            IPortalFloor.GraduationFloorParams({
                quoteToken: quote,
                quotePriceUsd: price,
                poolQuote: poolQuote,
                poolToken: poolToken,
                totalSupply: totalSupply,
                vaultFactory: pileVaultFactory
            })
        );
        quoteUsdWad = r.quoteUsdWad;
        requiredUsdWad = r.createFloorUsdWad;
        if (viaPortal && r.multiplierBps >= 10_000) {
            (bool lfEnabled, uint16 m) = IPortalFloor(hub).launcherFactoryMultiplier(address(this));
            if (lfEnabled && m < 10_000) requiredUsdWad = requiredUsdWad * m / 10_000;
        }
    }

    /// @notice The token address the Portal will create for `salt` (a launch needs it to end in 0x7777).
    /// @dev The Portal clones with OpenZeppelin's EIP-1167 init code (45-byte runtime), as Flap's fork tests predict
    ///      it; solady's shorter clone would give another address.
    function predictToken(bytes32 salt) public view returns (address) {
        return ClonesUpgradeable.predictDeterministicAddress(tokenImpl, salt, hub);
    }

    /// @notice The Launcher address `creator` gets for `salt`.
    function predictLauncher(address creator, bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, _cloneSalt(creator, salt), address(this));
    }

    /// @notice The exact value a creation call carries: the Portal's salt-lock fee, in the native coin.
    function creationFee() external view returns (uint256) {
        return IPortal(hub).SALT_LOCK_FEE();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ILauncherFactory
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc LauncherFactoryBase
    function upgradeVaultImplementation(address) external pure override {
        revert LaunchersAreImmutable();
    }

    /// @inheritdoc LauncherFactoryBase
    function launcherDataSchema() external pure override returns (LauncherDataSchema memory schema) {
        schema.description = "Curve sale with the creator's rules: buy and sell along a price curve fixed at creation, before any "
            "pool exists. The last sale token launches the token with the raise as its pool at the curve's final price; "
            "a missed deadline unwinds the sale. Curve fees and part of every later trade's tax are shared by the "
            "creator's rules (creator, pile, buy and burn), set at the RulesVaultFactory before the sale is created "
            "(rulesOf); without rules, all of it fills a pile any holder redeems. Priced, paid and pooled in this factory's ERC-20 quote. Value: the salt lock fee only.";
        schema.isArray = false;
        FieldDescriptor[] memory f = new FieldDescriptor[](13);
        f[0] = FieldDescriptor("name", "string", "Token name", 0);
        f[1] = FieldDescriptor("symbol", "string", "Token symbol", 0);
        f[2] = FieldDescriptor("meta", "string", "Metadata URI", 0);
        f[3] = FieldDescriptor("salt", "bytes32", "CREATE2 salt; the token address must end in 0x7777", 0);
        f[4] = FieldDescriptor("saleTokens", "uint256", "Tokens sold along the curve", 18);
        f[5] = FieldDescriptor("targetRaise", "uint256", "Quote raised when all are sold; all of it seeds the pool", 18);
        f[6] = FieldDescriptor("virtualBnb", "uint256", "Virtual quote of the curve (larger is flatter)", 18);
        f[7] = FieldDescriptor("duration", "uint64", "Seconds until the deadline", 0);
        f[8] = FieldDescriptor("tradeFeeBps", "uint16", "Fee on curve trades, bps (max 500); goes to the pile", 0);
        f[9] = FieldDescriptor("buyTaxBps", "uint16", "Buy tax after launch, bps (max 1000)", 0);
        f[10] = FieldDescriptor("sellTaxBps", "uint16", "Sell tax after launch, bps (max 1000)", 0);
        f[11] = FieldDescriptor("burnShareBps", "uint16", "Share of the tax burned, bps (rest: the pile)", 0);
        f[12] = FieldDescriptor("taxDuration", "uint32", "Seconds the tax runs after launch", 0);
        schema.fields = f;
    }
}
