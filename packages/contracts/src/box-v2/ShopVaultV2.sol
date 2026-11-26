// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {IBoxToken} from "../box/interfaces/IBoxToken.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {IShopVaultV2, ShopConfigV2, ShopLimitsV2 as L} from "./interfaces/IShopVaultV2.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {PricingToken} from "./libraries/PricingToken.sol";

interface ShopERC721 {
    function supportsInterface(bytes4 id) external view returns (bool);
    function ownerOf(uint256 id) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 id) external;
}

/// @notice Shared burn-only sink: T refuses PM.take directly to its vault (only vault pulls are allowed).
/// @dev No approvals or transfers. A shop's capped unlock takes claims here and burns atomically; any refusal
/// rolls both steps back. Unsolicited T here can only burn too. No per-box role or new clone arguments.
contract ShopTBurnerV2 {
    /// @notice Anyone may burn this sink's T, never anyone else's; no recipient or withdrawal is available.
    function burn(address token, uint256 amount) external { IBoxToken(token).burn(amount); }
}

/// @notice M2 shop: immutable tier prices, seed/pick budget, delayed append-only collections and weekly limits.
/// @dev M2SeamArgs.shop = coordinator/T/loader followed by abi.encode(ShopConfigV2). An optional preset byte follows the canonical config; only receiver fee intake, no escrow.
/// Count views track distinct accepted NFTs; seizures stay counted and cannot be paid for again (BC-186/190).
/// Initial entries do not start the curator's seven-day cooldown. Weeks start at graduation/openGate.
contract ShopVaultV2 is IShopVaultV2, BoxCloneBase, TransientReentrancyGuard {
    // FINAL2-GAS: independently measured shop frames. Preserve their 2x headroom when the
    // shared hook BURN_GAS changes; these are not multiples of a plain-token allowance.
    uint256 private constant LIQUID_BURN_GAS = 1_250_000;
    uint256 private constant CLAIMS_BURN_GAS = 2_500_000;
    struct Entry { uint256 activeAt; uint8 tier; bool initial; uint256 week; uint256 spent; }
    struct Item { address collection; uint256 id; }
    /// @notice Anyone reads the authenticated release coordinator implementation; no money moves.
    address public immutable coordinatorImplementation;
    /// @notice Anyone reads the release PoolManager and burn-only sink; no money moves.
    IPoolManager public immutable poolManager;
    ShopTBurnerV2 public immutable burnSink;
    address private immutable _implementation;
    bool private _initialized;
    bool private _seedReady;
    bool private _failed;
    bool private _armed;
    uint256 private _openedAt;
    uint256 private _budget;
    uint16 private _pickBps;
    uint16 private _weeklyBps;
    uint16 private _collectionBps;
    uint32 private _delay;
    /// @notice Anyone reads current/pending curator and next addition time; these confer no custody authority.
    address public curator;
    address public pendingCurator;
    uint256 public nextAdditionAt;
    mapping(address => Entry) private _entries;
    mapping(bytes32 => bool) private _held;
    mapping(bytes32 => bool) private _seen;
    Item[] private _starters;
    uint256 private _size;
    uint256 private _inside;
    uint256 private _integral;
    uint256 private _countAt;
    uint256 private _week;
    uint256 private _snapshot;

    uint256 private _spent;
    bytes32 private _expected;
    // Earliest activation per immutable price tier; bounded lookup even after unlimited curator additions.
    uint256[4] private _tierActiveAt;

    event CuratorProposed(address indexed next);
    event CuratorChanged(address indexed curator);
    event GateOpened(uint256 timestamp);
    event FailureEntered();
    event StarterLoaded(uint256 indexed index, address indexed collection, uint256 id);
    event StarterReturned(uint256 indexed index, address indexed collection, uint256 id);
    event FailedTBurned(uint256 amount);

    /// @notice Release deployer fixes PM and coordinator authentication, and deploys one shared burn-only sink.
    constructor(IPoolManager pm, address coordinatorImpl) {
        if (address(pm).code.length == 0 || coordinatorImpl.code.length == 0) revert InvalidRequest();
        poolManager = pm; coordinatorImplementation = coordinatorImpl;
        burnSink = new ShopTBurnerV2(); _implementation = address(this);
    }
    /// @notice Fixed coordinator only, once: validates the committed config without moving money or NFTs.
    /// @dev A usable initial collection and two cheapest gives of seed keep even an empty shop live (F132).
    function initialize() external nonReentrant {
        IBoxCoordinatorV2 c = _coordinator();
        if (msg.sender != address(c) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert Unauthorized(msg.sender);
        }
        if (_initialized || !BoxClones.isCloneOf(address(this), _implementation)
            || address(this).code.length <= BoxClones.ARGS_OFFSET + 60) revert InvalidRequest();
        if (_token().code.length == 0 || c.token() != _token() || c.roleAddress(3) != address(this)
            || c.poolManager() != address(poolManager) || c.starterSetLoader() != _argAddress(40)
            || c.creator() == address(0) || c.creator() == address(this) || c.failed() || c.graduated()) {
            revert InvalidRequest();
        }
        ShopConfigV2 memory cfg = abi.decode(
            _argBytes(60, address(this).code.length - BoxClones.ARGS_OFFSET - 60), (ShopConfigV2));
        if (cfg.collections.length == 0 || cfg.collections.length > 64 || cfg.collections.length != cfg.tiers.length
            || (cfg.seedT != 0 && _argAddress(40) == address(0))
            || (cfg.pickBps != 12500 && cfg.pickBps != 15000 && cfg.pickBps != 20000 && cfg.pickBps != 30000)
            || (cfg.weeklyBps != 500 && cfg.weeklyBps != 1000)
            || (cfg.collectionBps != 100 && cfg.collectionBps != 250 && cfg.collectionBps != 500)
            || cfg.collectionBps > cfg.weeklyBps
            || (cfg.listDelay != 7 days && cfg.listDelay != 14 days && cfg.listDelay != 30 days)) revert InvalidRequest();
        for (uint256 i; i < 4; ++i) {
            if (cfg.givePricesT[i] == 0 || (i != 0 && cfg.givePricesT[i] <= cfg.givePricesT[i-1])) revert InvalidRequest();
            // Refuse a menu whose rounded pick price is not representable.
            FullMath.mulDivRoundingUp(cfg.givePricesT[i], cfg.pickBps, 10000);
        }
        _initialized = true; _seedReady = cfg.seedT == 0;
        _pickBps = cfg.pickBps; _weeklyBps = cfg.weeklyBps; _collectionBps = cfg.collectionBps;
        _delay = cfg.listDelay; curator = cfg.curator; _countAt = block.timestamp;
        uint256 minInitialGiveT = cfg.givePricesT[3];
        for (uint256 i; i < cfg.collections.length; ++i) {
            _add(cfg.collections[i], cfg.tiers[i], true);
            uint256 price = cfg.givePricesT[cfg.tiers[i]];
            if (price < minInitialGiveT) minInitialGiveT = price;
        }
        // The allowance floor replaces percentage-based seed admission. Two gives are still required:
        // an empty shop funded for only one would spend everything and then be unable to pick its last item.
        // Division also refuses an unrepresentable two-give seed without overflowing.
        if (cfg.seedT / 2 < minInitialGiveT) revert InvalidRequest();
    }
    /// @inheritdoc IShopVaultV2
    function fundSeed() external nonReentrant {
        _beforeOpen(); if (_seedReady) revert InvalidRequest();
        uint256 seed = _configWord(0);
        _seedReady = true; _budget = seed;
        _pullT(_coordinator().creator(), seed); emit SeedFunded(seed);
    }
    /// @notice Fixed coordinator only after graduation: opens gives and picks once, never after failure.
    function openGate() external nonReentrant {
        _onlyCoordinator();
        if (_failed || _openedAt != 0 || !_seedReady || !_coordinator().graduated()) revert InvalidRequest();
        _openedAt = block.timestamp; emit GateOpened(block.timestamp);
    }
    /// @notice Fixed coordinator only, once before graduation: freezes custody without external calls.
    function enterFailure() external nonReentrant {
        _onlyCoordinator(); if (_failed || _openedAt != 0) revert InvalidRequest();
        _failed = true; emit FailureEntered(); // No token, NFT, PM or ledger call on failure's atomic path.
    }
    /// @inheritdoc IShopVaultV2
    function give(address collection, uint256 id, uint256 minT) external nonReentrant returns (uint256 paidT) {
        _live(); Entry storage e = _entries[collection];
        if (e.activeAt == 0 || block.timestamp < e.activeAt) revert InvalidRequest();
        paidT = _price(e.tier); uint256 budget = budgetT();
        if (paidT < minT || paidT > budget) revert InvalidRequest();
        _startWeek(budget);
        if (e.week != _week) { e.week = _week; e.spent = 0; }
        uint256 floorT = _giveFloor();
        uint256 weeklyLimit = _giveLimit(_weeklyBps, floorT);
        uint256 collectionLimit = _giveLimit(_collectionBps, floorT);
        if (paidT > weeklyLimit || _spent > weeklyLimit - paidT
            || paidT > collectionLimit || e.spent > collectionLimit - paidT) revert InvalidRequest();
        _spent += paidT; e.spent += paidT; _budget -= paidT;
        _receiveItem(collection, id, msg.sender);
        uint256 beforeT = IBoxToken(_token()).balanceOf(address(this));
        PricingToken.sendExact(_token(), msg.sender, paidT);
        if (IBoxToken(_token()).balanceOf(address(this)) != beforeT - paidT) revert InvalidRequest();
        emit Given(collection, id, msg.sender, paidT);
    }
    /// @inheritdoc IShopVaultV2
    function pick(address collection, uint256 id, uint256 maxT, address to)
        external nonReentrant returns (uint256 paidT)
    {
        _live(); bytes32 key = _key(collection, id);
        if (!_held[key] || _inside <= 1 || to == address(0) || to == address(this)) revert InvalidRequest();
        (, paidT,) = collectionTerms(collection); if (paidT > maxT) revert InvalidRequest();
        _startWeek(budgetT()); // This receipt never enlarges this week's fixed snapshot.
        _held[key] = false; _changeCount(false); _budget += paidT;
        _pullT(msg.sender, paidT); _sendItem(collection, id, to);
        emit Picked(collection, id, to, paidT);
    }
    /// @inheritdoc IShopVaultV2
    function addCollection(address collection, uint8 tier) external nonReentrant {
        _onlyCurator(); if (block.timestamp < nextAdditionAt) revert InvalidRequest();
        nextAdditionAt = block.timestamp + 7 days; _add(collection, tier, false);
    }
    /// @inheritdoc IShopVaultV2
    function proposeCurator(address next) external nonReentrant {
        _onlyCurator(); if (next == address(0)) revert InvalidRequest();
        pendingCurator = next; emit CuratorProposed(next);
    }
    /// @inheritdoc IShopVaultV2
    function acceptCurator() external nonReentrant {
        _ready(); if (_failed || msg.sender != pendingCurator || pendingCurator == address(0)) revert Unauthorized(msg.sender);
        curator = msg.sender; pendingCurator = address(0); emit CuratorChanged(msg.sender);
    }
    /// @inheritdoc IShopVaultV2
    function renounceCurator() external nonReentrant {
        _onlyCurator(); curator = address(0); pendingCurator = address(0); emit CuratorChanged(address(0));
    }
    /// @inheritdoc IShopVaultV2
    /// @dev StarterSetLoaderV2 checks the whole page's ordered commitment/count/duplicates before this pull.
    /// This vault independently enforces the fixed creator, initial tier and exact custody; it never notifies open.
    function loadStarter(address collection, uint256 id, uint8 tier) external nonReentrant {
        _beforeOpen(); if (msg.sender != _argAddress(40)) revert Unauthorized(msg.sender);
        Entry storage e = _entries[collection];
        if (!e.initial || e.tier != tier || _seen[_key(collection, id)]) revert InvalidRequest();
        _receiveItem(collection, id, _coordinator().creator());
        emit StarterLoaded(_starters.length, collection, id); _starters.push(Item(collection, id));
    }
    /// @notice Only the expected NFT contract during a locked vault pull can acknowledge receipt; no money moves.
    function onERC721Received(address operator, address from, uint256 id, bytes calldata) external returns (bytes4) {
        if (!_insideGuardedCall() || operator != address(this)
            || _expected != keccak256(abi.encode(msg.sender, from, id))) revert InvalidRequest();
        _expected = 0; return this.onERC721Received.selector;
    }
    /// @inheritdoc IShopVaultV2
    function returnStarter(uint256[] calldata indexes) external nonReentrant returns (uint256 returned) {
        _ready(); if (!_failed || indexes.length == 0 || indexes.length > L.MAX_STARTER_BATCH) revert InvalidRequest();
        for (uint256 i; i < indexes.length; ++i) if (indexes[i] >= _starters.length) revert InvalidRequest();
        for (uint256 i; i < indexes.length; ++i) {
            if (_optional(address(this), abi.encodeCall(this.returnOne, (indexes[i])), L.NFT_RETURN_GAS)) ++returned;
        }
    }
    /// @notice Vault self-call only, while locked: isolate one creator-only NFT return and its accounting.
    function returnOne(uint256 index) external {
        _onlySelf(); Item memory item = _starters[index]; bytes32 key = _key(item.collection, item.id);
        if (!_failed || !_held[key]) revert InvalidRequest();
        _held[key] = false; _changeCount(false);
        _sendItem(item.collection, item.id, _coordinator().creator());
        emit StarterReturned(index, item.collection, item.id);
    }
    /// @notice Anyone after failure retries bounded liquid and claims burns; refusals preserve custody.
    function burnFailedT() external nonReentrant returns (uint256 burned) {
        _ready(); if (!_failed) revert InvalidRequest();
        // Amount reads and postconditions are inside each gas cap too. No hostile view can defeat isolation.
        uint256 beforeBurned = _burned;
        _optional(address(this), abi.encodeCall(this.burnLiquid, ()), LIQUID_BURN_GAS);
        _optional(address(this), abi.encodeCall(this.burnClaims, ()), CLAIMS_BURN_GAS);
        burned = _burned - beforeBurned; emit FailedTBurned(burned);
    }
    uint256 private _burned;
    /// @inheritdoc IShopVaultV2
    uint256 public feesT;
    /// @notice Vault self-call only, while locked: burn its liquid T with exact balance and supply checks.
    function burnLiquid() external {
        _onlySelf(); IBoxToken t = IBoxToken(_token()); uint256 amount = t.balanceOf(address(this));
        if (amount == 0) return; uint256 supply = t.totalSupply(); t.burn(amount);
        if (t.balanceOf(address(this)) != 0 || t.totalSupply() != supply - amount) revert InvalidRequest();
        _burned += amount;
    }
    /// @notice Vault self-call only, while locked: redeem at most int128.max claims and burn in one isolated unlock.
    function burnClaims() external {
        _onlySelf(); _armed = true; poolManager.unlock(""); _armed = false;
    }
    /// @notice PM only during the vault's armed failed-T unlock. Refusal rolls back redemption and sink custody.
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall() || !_armed || !_failed) revert Unauthorized(msg.sender);
        _armed = false; address t = _token();
        uint256 amount = poolManager.balanceOf(address(this), uint160(t));
        uint256 maxPart = uint256(uint128(type(int128).max)); if (amount > maxPart) amount = maxPart;
        if (amount == 0) return "";
        uint256 supply = IBoxToken(t).totalSupply(); uint256 sinkBefore = IBoxToken(t).balanceOf(address(burnSink));
        poolManager.burn(address(this), uint160(t), amount);
        poolManager.take(Currency.wrap(t), address(burnSink), amount); burnSink.burn(t, amount);
        if (IBoxToken(t).totalSupply() != supply - amount || IBoxToken(t).balanceOf(address(burnSink)) != sinkBefore) {
            revert InvalidRequest();
        }
        _burned += amount; return "";
    }
    /// @inheritdoc IShopVaultV2
    function seedReady() external view returns (bool) { return _initialized && _seedReady; }
    /// @inheritdoc IShopVaultV2
    function budgetT() public view returns (uint256) {
        if (!_initialized || _failed) return 0;
        uint256 liquid = IBoxToken(_token()).balanceOf(address(this)); return liquid < _budget ? liquid : _budget;
    }
    /// @inheritdoc IShopVaultV2
    function ceilingT() public view returns (uint256) {
        uint256 length = address(this).code.length - BoxClones.ARGS_OFFSET - 60;
        if (length % 32 != 1) return 0;
        uint256 preset = uint8(_argBytes(60 + length - 1, 1)[0]);
        if (preset != 2 && preset != 4 && preset != 8) return 0;
        uint256 seed = _initialized ? _configWord(0) : 0;
        return seed > type(uint256).max / preset ? type(uint256).max : seed * preset;
    }
    /// @inheritdoc IShopVaultV2
    function feesWanted() external view returns (bool) {
        if (!_initialized || _failed) return false;
        uint256 budget = _openedAt == 0 || _week != (block.timestamp - _openedAt) / 7 days + 1
            ? budgetT() : _snapshot;
        return budget < ceilingT();
    }
    /// @inheritdoc IShopVaultV2
    function fundFromFees(uint256 amountT) external nonReentrant {
        _live();
        if (msg.sender != _coordinator().receiver()) revert Unauthorized(msg.sender);
        uint256 budget = budgetT(); uint256 ceiling = ceilingT();
        if (budget > ceiling || amountT > ceiling - budget || ceiling == 0) revert InvalidRequest();
        _startWeek(budget);
        _budget += amountT; feesT += amountT;
        _pullT(msg.sender, amountT); emit FeesFunded(amountT, feesT);
    }
    /// @inheritdoc IShopVaultV2
    function failedT() external view returns (uint256) {
        if (!_failed) return 0;
        return IBoxToken(_token()).balanceOf(address(this)) + poolManager.balanceOf(address(this), uint160(_token()));
    }
    /// @inheritdoc IShopVaultV2
    function collectionTerms(address collection) public view returns (uint256 giveT, uint256 pickT, uint256 activeAt) {
        Entry storage e = _entries[collection]; activeAt = e.activeAt;
        if (activeAt != 0) { giveT = _price(e.tier); pickT = FullMath.mulDivRoundingUp(giveT, _pickBps, 10000); }
    }
    /// @notice Anyone reads zero: shop T is budget, never share-vault escrow; no funds move.
    function supplyFloor() external pure returns (uint256) { return 0; }
    /// @notice Anyone reads the cumulative number of distinct accepted NFTs; no funds move.
    function collectionSize() external view returns (uint256) { return _size; }
    /// @notice Anyone reads recorded custody, including seized NFTs until an actual exit; no funds move.
    function inside() external view returns (uint256) { return _inside; }
    /// @notice Anyone reads the exact recorded-custody time integral since initialization; no funds move.
    function insideIntegral() external view returns (uint256 integral, uint256 timestamp) {
        return (_integral + _inside * (block.timestamp - _countAt), block.timestamp);
    }
    function _add(address collection, uint8 tier, bool initial) private {
        if (collection.code.length == 0 || tier > 3 || _entries[collection].activeAt != 0
            || !ShopERC721(collection).supportsInterface(0x80ac58cd)) revert InvalidRequest();
        uint256 at = block.timestamp + _delay;
        if (_tierActiveAt[tier] == 0) _tierActiveAt[tier] = at;
        _entries[collection] = Entry(at, tier, initial, 0, 0); emit CollectionAdded(collection, tier, at);
    }
    function _receiveItem(address collection, uint256 id, address from) private {
        bytes32 key = _key(collection, id);
        if (_held[key] || ShopERC721(collection).ownerOf(id) != from) revert InvalidRequest();
        _held[key] = true; if (!_seen[key]) { _seen[key] = true; ++_size; } _changeCount(true);
        _expected = keccak256(abi.encode(collection, from, id));
        ShopERC721(collection).safeTransferFrom(from, address(this), id);
        if (_expected != 0 || ShopERC721(collection).ownerOf(id) != address(this)) revert InvalidRequest();
    }
    function _sendItem(address collection, uint256 id, address to) private {
        if (ShopERC721(collection).ownerOf(id) != address(this)) revert InvalidRequest();
        ShopERC721(collection).safeTransferFrom(address(this), to, id);
        if (ShopERC721(collection).ownerOf(id) != to) revert InvalidRequest();
    }
    function _changeCount(bool adding) private {
        _integral += _inside * (block.timestamp - _countAt); _countAt = block.timestamp;
        if (adding) ++_inside; else --_inside;
    }
    function _startWeek(uint256 budget) private {
        uint256 week = (block.timestamp - _openedAt) / 7 days + 1;
        if (_week != week) { _week = week; _snapshot = budget; _spent = 0; }
    }
    function _giveFloor() private view returns (uint256) {
        // Unlisted and not-yet-active cheaper tiers must not strand the active collections' budget.
        // Pick receipts still wait for the next snapshot; the floor never exceeds that snapshot.
        for (uint256 i; i < 4; ++i) {
            if (_tierActiveAt[i] != 0 && block.timestamp >= _tierActiveAt[i]) {
                uint256 price = _price(i);
                return price < _snapshot ? price : _snapshot;
            }
        }
        return 0;
    }
    /// @dev Seed and four prices already live in the immutable ShopConfigV2 clone arguments. Read the
    /// same full-width words validated by initialize, rather than copying five words to storage at creation.
    /// Follow the ABI tuple offset to preserve abi.decode's meaning for direct, noncanonical clones too.
    function _configWord(uint256 offset) private view returns (uint256) {
        return uint256(_argWord(60 + uint256(_argWord(60)) + offset));
    }
    /// @dev Only admitted entry tiers and the bounded four-tier floor loop reach this helper.
    function _price(uint256 tier) private view returns (uint256) {
        return _configWord(32 + tier * 32);
    }
    function _giveLimit(uint16 bps, uint256 floorT) private view returns (uint256) {
        uint256 limit = FullMath.mulDiv(_snapshot, bps, 10000);
        return limit < floorT ? floorT : limit;
    }
    function _pullT(address from, uint256 amount) private {
        uint256 beforeT = IBoxToken(_token()).balanceOf(from); PricingToken.pullExact(_token(), from, amount);
        if (IBoxToken(_token()).balanceOf(from) != beforeT - amount) revert InvalidRequest();
    }
    function _optional(address target, bytes memory data, uint256 cap) private returns (bool ok) {
        if (gasleft() < cap + cap / 63 + L.NFT_RETURN_RESERVE_GAS + 20000) return false;
        assembly ("memory-safe") { ok := call(cap, target, 0, add(data, 32), mload(data), 0, 0) }
    }
    function _key(address collection, uint256 id) private pure returns (bytes32) { return keccak256(abi.encode(collection, id)); }
    function _coordinator() private view returns (IBoxCoordinatorV2) { return IBoxCoordinatorV2(_argAddress(0)); }
    function _token() private view returns (address) { return _argAddress(20); }
    function _ready() private view { if (!_initialized) revert InvalidRequest(); }
    function _live() private view { _ready(); if (_failed || _openedAt == 0) revert InvalidRequest(); }
    function _beforeOpen() private view {
        _ready(); IBoxCoordinatorV2 c = _coordinator();
        if (_failed || _openedAt != 0 || c.gateOpen() || c.failed() || c.graduated()) revert InvalidRequest();
    }
    function _onlyCoordinator() private view { _ready(); if (msg.sender != _argAddress(0)) revert Unauthorized(msg.sender); }
    function _onlyCurator() private view {
        _ready(); if (_failed || msg.sender != curator || curator == address(0)) revert Unauthorized(msg.sender);
    }
    function _onlySelf() private view {
        if (msg.sender != address(this) || !_insideGuardedCall() || !_failed) revert Unauthorized(msg.sender);
    }
}
