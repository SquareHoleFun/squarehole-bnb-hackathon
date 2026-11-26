// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IRewardLedger} from "./interfaces/IRewardLedger.sol";
import {ISquareHoleToken} from "./interfaces/ISquareHoleToken.sol";
import {LaunchMath} from "./libraries/LaunchMath.sol";
import {RewardLedger} from "./RewardLedger.sol";
import {SquareHoleFungibleToken} from "./SquareHoleFungibleToken.sol";
import {SquareHoleHook} from "./SquareHoleHook.sol";
import {SquareHoleRegistry} from "./SquareHoleRegistry.sol";
import {SquareHoleToken} from "./SquareHoleToken.sol";
import {CollectionTokenDeployer, CoreDeployer, FungibleTokenDeployer} from "./deployers/LaunchDeployers.sol";

/// @notice The converter surface the launcher checks at construction.
interface IClaimConverterWiring {
    function poolManager() external view returns (address);
    function registry() external view returns (address);
}

/// @title SquareHoleLauncher
/// @notice Creates a Square Hole launch in one transaction (ADR-0011 "Launcher"): deploys the reward ledger, fee
/// collector and T (a DN404 collection with its NFT mirror, or a plain ERC-20) at predicted CREATE addresses with
/// constructor cross-checks, initializes the Uniswap v4 pool through the Square Hole hook at the template's start
/// price, seeds the whole supply as single-sided, permanently locked, protocol-owned liquidity, and records every
/// identity in the registry.
/// @dev What the creator controls: kind, name, symbol, the NFT count N of a collection (within the template's NFT
/// bound; one NFT = 1e27 / N raw), template version (which fixes Q), R, base URI and manifest hash. What it does not:
/// the supply (always exactly 1,000,000,000 tokens, ADR-0009 F10), price, range, liquidity shape, fees and
/// recipients. There is no first buy, no creator allocation, no creator fee, no ETH accepted, no owner and no admin
/// function. The creator is recorded and receives nothing (v0 split: protocol 1/3,
/// holders 2/3 of realized Q; fee T burned).
contract SquareHoleLauncher {
    /// @notice Creator inputs.
    struct LaunchParams {
        SquareHoleRegistry.AssetKind kind;
        string name;
        string symbol;
        uint256 units; // collection: N whole NFTs (1e27 % N == 0, N ≤ template bound); token: must be 1e9 (F10)
        uint256 fractionsPerNft; // collection: 0 (derive) or exactly 1e9 / N (cross-check); token: must be 1
        uint32 templateVersion; // registry template (fixes Q, price and shape)
        IRewardLedger.PayoutAsset payoutAsset; // R
        string baseURI; // collection only (empty for a token); tokenURI(id) = baseURI + id + ".json"; immutable
        bytes32 metadataManifestHash;
    }

    struct Deployed {
        address token;
        address mirror;
        address ledger;
        address collector;
    }

    error ZeroAddress();
    error WiringMismatch();
    error InvalidParams();
    error TemplateInactive(uint32 version);
    error PayoutTUnavailable();
    /// @notice N exceeds the template's NFT bound (one NFT would start below `minStartUnitValueQ`; ADR-0011 §4).
    error CollectionTooLarge(uint256 units, uint256 maxUnits);

    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 32;
    uint256 public constant MAX_BASE_URI_BYTES = 512;
    /// @dev Every launch's supply in whole tokens (F10); equal to LaunchTokenCore.FIXED_WHOLE_SUPPLY, which the token
    /// templates enforce.
    uint256 private constant FIXED_WHOLE_SUPPLY = 1e9;

    IPoolManager public immutable poolManager;
    SquareHoleHook public immutable hook;
    SquareHoleRegistry public immutable registry;
    /// @notice Protocol treasury of every launch (receives protocol Q and swept donations).
    address public immutable treasury;
    /// @notice R = T claim converter of every R = T launch (zero: R = T launches are disabled).
    address public immutable converter;
    CoreDeployer public immutable coreDeployer;
    CollectionTokenDeployer public immutable collectionDeployer;
    FungibleTokenDeployer public immutable fungibleDeployer;

    constructor(
        IPoolManager poolManager_,
        SquareHoleHook hook_,
        SquareHoleRegistry registry_,
        address treasury_,
        address converter_,
        CoreDeployer coreDeployer_,
        CollectionTokenDeployer collectionDeployer_,
        FungibleTokenDeployer fungibleDeployer_
    ) {
        if (
            address(poolManager_) == address(0) || address(hook_) == address(0) || address(registry_) == address(0)
                || treasury_ == address(0) || address(coreDeployer_) == address(0)
                || address(collectionDeployer_) == address(0) || address(fungibleDeployer_) == address(0)
        ) revert ZeroAddress();
        if (
            hook_.launcher() != address(this) || address(hook_.poolManager()) != address(poolManager_)
                || registry_.launcher() != address(this) || coreDeployer_.launcher() != address(this)
                || collectionDeployer_.launcher() != address(this) || fungibleDeployer_.launcher() != address(this)
        ) revert WiringMismatch();
        if (converter_ != address(0)) {
            IClaimConverterWiring c = IClaimConverterWiring(converter_);
            if (c.poolManager() != address(poolManager_) || c.registry() != address(registry_)) {
                revert WiringMismatch();
            }
        }
        poolManager = poolManager_;
        hook = hook_;
        registry = registry_;
        treasury = treasury_;
        converter = converter_;
        coreDeployer = coreDeployer_;
        collectionDeployer = collectionDeployer_;
        fungibleDeployer = fungibleDeployer_;
    }

    /// @notice Creates a launch. Returns the canonical pair id and T.
    function createLaunch(LaunchParams calldata p) external returns (bytes32 pairId, address token) {
        SquareHoleRegistry.LaunchTemplate memory t = _validate(p);
        Deployed memory d = _deploy(p, t.quote);
        (PoolKey memory key, LaunchMath.LaunchPosition memory pos) = _launchPool(d, t);
        pairId = _record(p, t, d, key, pos);
        token = d.token;
    }

    function _validate(LaunchParams calldata p) private view returns (SquareHoleRegistry.LaunchTemplate memory t) {
        t = registry.template(p.templateVersion);
        if (t.quote == address(0) || !t.active) revert TemplateInactive(p.templateVersion);
        if (p.payoutAsset == IRewardLedger.PayoutAsset.T && converter == address(0)) revert PayoutTUnavailable();
        uint256 nameLength = bytes(p.name).length;
        uint256 symbolLength = bytes(p.symbol).length;
        if (
            nameLength == 0 || nameLength > MAX_NAME_BYTES || symbolLength == 0 || symbolLength > MAX_SYMBOL_BYTES
                || bytes(p.baseURI).length > MAX_BASE_URI_BYTES
        ) revert InvalidParams();
        // The supply rule is enforced by the token templates themselves (F10: always 1e9 whole tokens; a collection's
        // N must divide 1e27 raw, `InvalidCollectionSize`; a token's units must be 1e9, `InvalidSupply`). The launch
        // template bounds N for collections: every NFT starts at ≥ minStartUnitValueQ, so a reference buy stays far
        // below the EIP-7825 per-transaction NFT cap (registry REFERENCE_BUY_NFTS).
        if (p.kind == SquareHoleRegistry.AssetKind.Token) {
            if (p.fractionsPerNft != 1 || bytes(p.baseURI).length != 0) revert InvalidParams();
        } else {
            uint256 maxUnits = t.startFdvQ / t.minStartUnitValueQ;
            if (p.units > maxUnits) revert CollectionTooLarge(p.units, maxUnits);
        }
    }

    function _deploy(LaunchParams calldata p, address quote) private returns (Deployed memory d) {
        bool collection = p.kind == SquareHoleRegistry.AssetKind.Collection;
        d.ledger = coreDeployer.predict(0);
        d.collector = coreDeployer.predict(1);
        d.token = collection ? collectionDeployer.predict(0) : fungibleDeployer.predict(0);

        coreDeployer.deployLedger(
            RewardLedger.Config({
                token: d.token,
                quote: quote,
                feeCollector: d.collector,
                treasury: treasury,
                payoutAsset: p.payoutAsset,
                converter: p.payoutAsset == IRewardLedger.PayoutAsset.T ? converter : address(0),
                launcher: address(this),
                poolManager: address(poolManager),
                hook: address(hook),
                nftMirror: collection
            })
        );
        coreDeployer.deployCollector(d.token, quote, d.ledger, treasury, address(hook), address(poolManager));
        if (collection) {
            collectionDeployer.deploy(
                SquareHoleToken.LaunchTerms({
                    name: p.name,
                    symbol: p.symbol,
                    fractionsPerNft: _normalizedFractionsPerNft(p.units, p.fractionsPerNft),
                    collectionSize: p.units,
                    initialHolder: address(hook),
                    feeCollector: d.collector,
                    rewardLedger: d.ledger,
                    baseURI: p.baseURI,
                    metadataManifestHash: p.metadataManifestHash
                })
            );
            d.mirror = SquareHoleToken(payable(d.token)).mirrorERC721();
        } else {
            fungibleDeployer.deploy(
                SquareHoleFungibleToken.LaunchTerms({
                    name: p.name,
                    symbol: p.symbol,
                    wholeSupply: p.units,
                    initialHolder: address(hook),
                    feeCollector: d.collector,
                    rewardLedger: d.ledger,
                    metadataManifestHash: p.metadataManifestHash
                })
            );
        }
    }

    /// @dev A creator's r = 0 ("derive") becomes 1e9 / N when that is an integer, so T's constructor arguments (what a
    /// source verifier replays) always equal the recorded `fractionsPerNft`. Any other r is passed through for the
    /// token to check (F10: r must be 0 or exactly 1e9 / N); N = 0 is left to the token's InvalidCollectionSize.
    function _normalizedFractionsPerNft(uint256 units, uint256 r) private pure returns (uint256) {
        if (r != 0 || units == 0) return r;
        return FIXED_WHOLE_SUPPLY % units == 0 ? FIXED_WHOLE_SUPPLY / units : 0;
    }

    function _launchPool(Deployed memory d, SquareHoleRegistry.LaunchTemplate memory t)
        private
        returns (PoolKey memory key, LaunchMath.LaunchPosition memory pos)
    {
        bool tIsCurrency0 = d.token < t.quote;
        key = PoolKey({
            currency0: Currency.wrap(tIsCurrency0 ? d.token : t.quote),
            currency1: Currency.wrap(tIsCurrency0 ? t.quote : d.token),
            fee: hook.LP_FEE(),
            tickSpacing: t.tickSpacing,
            hooks: IHooks(address(hook))
        });
        uint256 supply = ISquareHoleToken(d.token).initialSupply();
        pos = LaunchMath.launchPosition(supply, t.startFdvQ, t.rangeTicks, t.tickSpacing, tIsCurrency0);
        hook.launchPool(
            SquareHoleHook.LaunchPoolParams({
                key: key,
                sqrtPriceX96: pos.sqrtPriceX96,
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                liquidity: pos.liquidity,
                collector: d.collector
            })
        );
    }

    function _record(
        LaunchParams calldata p,
        SquareHoleRegistry.LaunchTemplate memory t,
        Deployed memory d,
        PoolKey memory key,
        LaunchMath.LaunchPosition memory pos
    ) private returns (bytes32 pairId) {
        pairId = registry.computePairId(d.token);
        registry.recordPair(
            SquareHoleRegistry.PairRecord({
                chainId: block.chainid,
                pairId: pairId,
                kind: p.kind,
                token: d.token,
                mirror: d.mirror,
                ledger: d.ledger,
                collector: d.collector,
                hook: address(hook),
                poolId: PoolId.unwrap(key.toId()),
                quote: t.quote,
                rewardSide: uint8(p.payoutAsset),
                converter: p.payoutAsset == IRewardLedger.PayoutAsset.T ? converter : address(0),
                // The token's derived value (1e9 / N, or 0 when N does not divide 1e9), not the creator's input.
                fractionsPerNft: p.kind == SquareHoleRegistry.AssetKind.Collection
                    ? SquareHoleToken(payable(d.token)).fractionsPerNft()
                    : 1,
                units: p.units,
                initialSupply: ISquareHoleToken(d.token).initialSupply(),
                templateVersion: p.templateVersion,
                startFdvQ: t.startFdvQ,
                minStartUnitValueQ: t.minStartUnitValueQ,
                tickSpacing: t.tickSpacing,
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                liquidity: pos.liquidity,
                sqrtPriceX96: pos.sqrtPriceX96,
                metadataManifestHash: p.metadataManifestHash,
                creator: msg.sender,
                // casting to 'uint64' is safe because block numbers stay far below 2^64
                // forge-lint: disable-next-line(unsafe-typecast)
                createdAtBlock: uint64(block.number)
            })
        );
    }
}
