// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaunchMath} from "./libraries/LaunchMath.sol";

/// @title SquareHoleRegistry
/// @notice Admitted quote assets with immutable per-quote launch templates, and the canonical record of every
/// launched pair (ADR-0011 "Registry"). The feed, the deployment manifest and the claim converter read pairs here.
/// @dev Authority is explicit and minimal:
/// - `admin` (immutable, set at deployment) can only ADD a template (which admits its quote asset) and RETIRE a
///   template for future launches. A template's fields never change after it is added; retiring is one-way and
///   never touches a launched pair, its pool, its funds or its record.
/// - `launcher` (immutable, the Square Hole launcher) can only append a new pair record, once per pair.
/// There is no owner transfer, no pause, no upgrade and no way to edit or delete a pair record.
contract SquareHoleRegistry {
    enum AssetKind {
        Token, // plain ERC-20 T (SquareHoleFungibleToken)
        Collection // DN404 T with an NFT mirror (SquareHoleToken)
    }

    /// @notice Liquidity shape of a template. v0 has one shape: a single protocol-owned range holding the whole
    /// supply, single-sided in T.
    uint8 public constant SHAPE_SINGLE_RANGE_FULL_SUPPLY = 1;

    /// @notice A protocol launch template for one quote asset. Price and shape are template constants, never
    /// creator inputs: every launch on a template starts at the same fully diluted value.
    /// `minStartUnitValueQ` bounds the NFT count of a collection launch (N ≤ startFdvQ / minStartUnitValueQ): one
    /// whole NFT starts at startFdvQ / N ≥ minStartUnitValueQ, so a buy of at most REFERENCE_BUY_NFTS ×
    /// minStartUnitValueQ (the template's reference buy) never materializes more than REFERENCE_BUY_NFTS NFTs, which
    /// keeps typical trades far below the EIP-7825 per-transaction gas cap (ADR-0006, ADR-0011 §4). The price only
    /// rises from the start (the range starts at the start price), so the start is the worst case.
    struct LaunchTemplate {
        address quote; // Q (ERC-20)
        uint256 startFdvQ; // raw Q the whole supply is worth at the start price
        uint256 minStartUnitValueQ; // raw Q one whole NFT is worth at least at the start price (collections)
        int24 tickSpacing; // pool tick spacing
        int24 rangeTicks; // width of the launch position (price rises ×1.0001^rangeTicks across the supply)
        uint8 shape; // SHAPE_SINGLE_RANGE_FULL_SUPPLY
        bool active; // false once retired (future launches only)
        uint64 addedAtBlock;
    }

    /// @notice Every identity of one launched pair, fixed at launch.
    struct PairRecord {
        uint256 chainId;
        bytes32 pairId; // keccak256(abi.encode(chainId, token)); the app's form is "<chainId>:<lowercase token>"
        AssetKind kind;
        address token; // T
        address mirror; // DN404 ERC-721 mirror (zero for the fungible template)
        address ledger;
        address collector;
        address hook;
        bytes32 poolId; // Uniswap v4 PoolId = keccak256(abi.encode(PoolKey))
        address quote; // Q
        uint8 rewardSide; // R: 0 = Q, 1 = T (IRewardLedger.PayoutAsset)
        address converter; // R = T claim converter (zero when R = Q)
        // Collection: whole tokens per NFT, 1e9 / N, when that is an integer, else 0 (the unit is always
        // initialSupply / units, exact); token: 1.
        uint256 fractionsPerNft;
        uint256 units; // N whole NFTs (collection) or whole tokens (fungible: always 1e9)
        uint256 initialSupply; // raw T: always 1e27 (ADR-0009 F10: 1,000,000,000 tokens per launch)
        uint32 templateVersion;
        uint256 startFdvQ; // the template's start FDV (raw Q)
        uint256 minStartUnitValueQ; // the template's NFT unit-value floor (raw Q; collections: N ≤ startFdvQ / this)
        int24 tickSpacing;
        int24 tickLower; // the protocol-owned position
        int24 tickUpper;
        uint128 liquidity;
        uint160 sqrtPriceX96; // initial pool price
        bytes32 metadataManifestHash;
        address creator; // who called createLaunch (receives nothing in v0)
        uint64 createdAtBlock;
    }

    event TemplateAdded(
        uint32 indexed version,
        address indexed quote,
        uint256 startFdvQ,
        uint256 minStartUnitValueQ,
        int24 tickSpacing,
        int24 rangeTicks,
        uint8 shape
    );
    event TemplateRetired(uint32 indexed version, address indexed quote);
    event PairCreated(bytes32 indexed pairId, address indexed token, address indexed quote, PairRecord record);

    error NotAdmin();
    error NotLauncher();
    error ZeroAddress();
    error InvalidTemplate();
    error UnknownTemplate(uint32 version);
    error PairExists(bytes32 pairId);
    error InvalidRecord();

    /// @notice Supply range every template must support (1 whole token … 1e9 whole tokens, 18 decimals). Since F10
    /// every launch has exactly MAX_SUPPLY; the wider check is kept (it only makes templates safer).
    uint256 public constant MIN_SUPPLY = 1e18;
    uint256 public constant MAX_SUPPLY = 1e27;
    /// @notice NFTs a template's reference buy (REFERENCE_BUY_NFTS × minStartUnitValueQ of Q) can deliver at most.
    /// Measured with the hook path: one EOA buy fits about 1,250 NFT mints under EIP-7825's 16,777,216 gas
    /// (evidence SH-B2, `test_nftCap_referenceBuyAndConversionFitEip7825_largestN`).
    uint256 public constant REFERENCE_BUY_NFTS = 1_000;

    address public immutable admin;
    address public immutable launcher;

    uint32 public templateCount;
    mapping(uint32 version => LaunchTemplate) private _templates;
    mapping(address quote => uint32 version) public latestTemplateFor;

    bytes32[] private _pairIds;
    mapping(bytes32 pairId => PairRecord) private _pairs;
    mapping(address token => bytes32 pairId) public pairIdOf;

    constructor(address admin_, address launcher_) {
        if (admin_ == address(0) || launcher_ == address(0)) revert ZeroAddress();
        admin = admin_;
        launcher = launcher_;
    }

    /*//////////////////////////////////////////////////////////////
                             ADMIN (ADD ONLY)
    //////////////////////////////////////////////////////////////*/

    /// @notice Admits `quote` with a new immutable template version. The template must place a valid position for
    /// every supported supply (1e18 … 1e27 raw T) in both token orders, within v4's per-tick liquidity cap, and its
    /// NFT unit-value floor must admit at least a one-NFT collection (0 < minStartUnitValueQ ≤ startFdvQ).
    function addTemplate(
        address quote,
        uint256 startFdvQ,
        uint256 minStartUnitValueQ,
        int24 tickSpacing,
        int24 rangeTicks
    ) external returns (uint32 version) {
        if (msg.sender != admin) revert NotAdmin();
        if (quote == address(0) || quote.code.length == 0) revert InvalidTemplate();
        if (minStartUnitValueQ == 0 || minStartUnitValueQ > startFdvQ) revert InvalidTemplate();
        // Reverts (LaunchMath errors) if any corner of the supported range falls outside the v4 tick range.
        LaunchMath.launchPosition(MIN_SUPPLY, startFdvQ, rangeTicks, tickSpacing, true);
        LaunchMath.launchPosition(MIN_SUPPLY, startFdvQ, rangeTicks, tickSpacing, false);
        uint128 l0 = LaunchMath.launchPosition(MAX_SUPPLY, startFdvQ, rangeTicks, tickSpacing, true).liquidity;
        uint128 l1 = LaunchMath.launchPosition(MAX_SUPPLY, startFdvQ, rangeTicks, tickSpacing, false).liquidity;
        // Liquidity grows like √(supply × startFdvQ) up to the start tick's rounding (at most one spacing, a factor
        // ≤ 1.0001^(spacing/2) on √price), so this bounds every supported supply in both orders: no launch can revert
        // later in Pool.sol with TickLiquidityOverflow (review round A).
        uint256 roundingFactorX96 = TickMath.getSqrtPriceAtTick(tickSpacing);
        uint256 bound = FullMath.mulDiv(l0 > l1 ? l0 : l1, roundingFactorX96, 1 << 96) + 1;
        if (bound > LaunchMath.maxLiquidityPerTick(tickSpacing)) revert InvalidTemplate();

        version = ++templateCount;
        _templates[version] = LaunchTemplate({
            quote: quote,
            startFdvQ: startFdvQ,
            minStartUnitValueQ: minStartUnitValueQ,
            tickSpacing: tickSpacing,
            rangeTicks: rangeTicks,
            shape: SHAPE_SINGLE_RANGE_FULL_SUPPLY,
            active: true,
            // casting to 'uint64' is safe because block numbers stay far below 2^64
            // forge-lint: disable-next-line(unsafe-typecast)
            addedAtBlock: uint64(block.number)
        });
        latestTemplateFor[quote] = version;
        emit TemplateAdded(
            version, quote, startFdvQ, minStartUnitValueQ, tickSpacing, rangeTicks, SHAPE_SINGLE_RANGE_FULL_SUPPLY
        );
    }

    /// @notice Stops new launches on `version` (one-way). Launched pairs are not affected in any way. If it was the
    /// quote's latest template, `latestTemplateFor(quote)` becomes 0 (no active default) until a new one is added.
    function retireTemplate(uint32 version) external {
        if (msg.sender != admin) revert NotAdmin();
        LaunchTemplate storage t = _templates[version];
        address quote = t.quote;
        if (quote == address(0)) revert UnknownTemplate(version);
        t.active = false;
        if (latestTemplateFor[quote] == version) latestTemplateFor[quote] = 0;
        emit TemplateRetired(version, quote);
    }

    /*//////////////////////////////////////////////////////////////
                           LAUNCHER (APPEND ONLY)
    //////////////////////////////////////////////////////////////*/

    /// @notice Appends the record of a new pair and emits every identity. Launcher only; once per pair.
    function recordPair(PairRecord calldata record) external {
        if (msg.sender != launcher) revert NotLauncher();
        bytes32 id = record.pairId;
        if (record.token == address(0) || id != computePairId(record.token) || record.chainId != block.chainid) {
            revert InvalidRecord();
        }
        if (_pairs[id].token != address(0) || pairIdOf[record.token] != bytes32(0)) revert PairExists(id);
        _pairs[id] = record;
        pairIdOf[record.token] = id;
        _pairIds.push(id);
        emit PairCreated(id, record.token, record.quote, record);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Canonical on-chain pair id of `token` on this chain.
    function computePairId(address token) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, token));
    }

    function template(uint32 version) external view returns (LaunchTemplate memory) {
        return _templates[version];
    }

    /// @notice Largest collection size N a template admits (startFdvQ / minStartUnitValueQ); 0 for unknown versions.
    function maxCollectionUnits(uint32 version) external view returns (uint256) {
        LaunchTemplate storage t = _templates[version];
        return t.minStartUnitValueQ == 0 ? 0 : t.startFdvQ / t.minStartUnitValueQ;
    }

    function pair(bytes32 pairId) external view returns (PairRecord memory) {
        return _pairs[pairId];
    }

    function pairOfToken(address token) external view returns (PairRecord memory) {
        return _pairs[pairIdOf[token]];
    }

    function pairCount() external view returns (uint256) {
        return _pairIds.length;
    }

    /// @notice Pair ids in launch order, [begin, end) clamped to the list (bounded pagination for readers).
    function pairIds(uint256 begin, uint256 end) external view returns (bytes32[] memory ids) {
        uint256 n = _pairIds.length;
        if (end > n) end = n;
        if (begin >= end) return ids;
        ids = new bytes32[](end - begin);
        for (uint256 i = begin; i < end; ++i) {
            ids[i - begin] = _pairIds[i];
        }
    }
}
