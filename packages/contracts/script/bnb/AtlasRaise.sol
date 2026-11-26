// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingRegistry, ListingRecord} from "../../src/box-v2/interfaces/IListingRegistry.sol";

/// @notice Atlas's push-mode interfaces as published (github.com/oracle-atlas/push-oracle-interfaces): a SingleFeed
/// answers `latestRoundData`, the MultiFeed registry answers `fetch(bytes4)`. Every price has 18 decimals.
interface IAtlasSingleFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

struct AtlasPriceSnapshot {
    uint80 price;
    uint48 aggregatedTs;
    uint48 onchainTs;
}

interface IAtlasMultiFeed {
    function decimals() external view returns (uint8);
    function fetch(bytes4 feedId) external view returns (AtlasPriceSnapshot memory);
}

/// @title AtlasPriceRead
/// @notice One read of an Atlas price through Atlas's own interface, and its freshness rule: written (onchainTs != 0),
/// positive, not in the future (60 s of clock skew), at most MAX_AGE old (three heartbeats of a 60 s feed).
library AtlasPriceRead {
    uint8 internal constant SINGLE = 1;
    uint8 internal constant MULTI = 2;
    /// @notice Our AtlasSource: Atlas's own feed on chain 97 when it answers us, else the relayed copy.
    uint8 internal constant SOURCE = 3;
    uint256 internal constant MAX_AGE = 180;

    error NoPrice();
    error FuturePrice(uint256 onchainTs);
    error StalePrice(uint256 onchainTs);
    error PriceTooWide(uint256 price);
    error BadSource();

    function read(uint8 kind, address source, bytes4 feedId)
        internal
        view
        returns (uint256 price, uint256 aggregatedTs, uint256 onchainTs)
    {
        (price, aggregatedTs, onchainTs,) = readWithOrigin(kind, source, feedId);
    }

    /// @notice As `read`, plus `direct`: true when the price came from Atlas's own contract (a feed, the registry, or
    /// the feed behind an AtlasSource), false when an AtlasSource answered from the relayed copy. Every kind passes the
    /// same rule: a positive price that fits uint80 (the registry's own type), written at a time `0 < t <= now` and at
    /// most MAX_AGE before now.
    function readWithOrigin(uint8 kind, address source, bytes4 feedId)
        internal
        view
        returns (uint256 price, uint256 aggregatedTs, uint256 onchainTs, bool direct)
    {
        direct = true;
        if (kind == SOURCE) {
            (price, aggregatedTs, onchainTs, direct) = AtlasSource(source).fetchWithOrigin(feedId);
        } else if (kind == SINGLE) {
            (, int256 answer, uint256 startedAt, uint256 updatedAt,) = IAtlasSingleFeed(source).latestRoundData();
            if (answer <= 0) revert NoPrice();
            (price, aggregatedTs, onchainTs) = (uint256(answer), startedAt, updatedAt);
        } else if (kind == MULTI) {
            AtlasPriceSnapshot memory s = IAtlasMultiFeed(source).fetch(feedId);
            (price, aggregatedTs, onchainTs) = (s.price, s.aggregatedTs, s.onchainTs);
        } else {
            revert BadSource();
        }
        if (onchainTs == 0 || price == 0) revert NoPrice();
        if (price > type(uint80).max) revert PriceTooWide(price);
        if (onchainTs > block.timestamp) revert FuturePrice(onchainTs);
        // A source applies each feed's own age limit (fixed when the feed was admitted); the other kinds use MAX_AGE.
        if (kind != SOURCE && block.timestamp - onchainTs > MAX_AGE) revert StalePrice(onchainTs);
    }

    /// @notice The same rule as a yes or no, for a source choosing between two answers.
    function fresh(uint256 price, uint256 onchainTs, uint256 maxAge) internal view returns (bool) {
        return price != 0 && price <= type(uint80).max && onchainTs != 0 && onchainTs <= block.timestamp
            && block.timestamp - onchainTs <= maxAge;
    }
}

/// @title AtlasSource
/// @notice BNB Chain testnet (97): one price per Atlas feed id, from Atlas's OWN feed contract on this chain when it
/// answers this contract with a fresh, well-formed price, otherwise from the relayed copy (AtlasMirror) when that is
/// fresh, otherwise refused; every answer says which. Atlas's feeds here answer authorised callers only: the day Atlas
/// authorises THIS address on a feed (`setAuthorizedCallers([source], [true])` on that feed's contract), the direct
/// branch of that feed starts working with no transaction of ours; until then the relay carries it.
///
/// The table of direct feeds: BNB/USD (633) is fixed at construction. Further ids are ADD-ONLY: the deployer (fixed at
/// construction, not transferable) may set the direct feed of an id that has none, once; a set feed can never be
/// changed or removed; each addition emits DirectFeedAdded. Nothing else is settable. On addition the feed must have
/// code, and if it answers this contract's `decimals()` call (it will not before Atlas authorises the source), the
/// answer must be 18; every read checks its decimals again.
///
/// The direct read cannot break the source: both calls to the feed (`decimals()`, then `latestRoundData()`) are
/// gas-capped static calls that copy at most their expected words; the answer is used only when each call succeeded,
/// returned exactly the expected length, the feed's decimals are 18, the price is positive and fits uint80, and its
/// times are `startedAt <= updatedAt`, `0 < updatedAt <= now` and at most `maxAge` old. Anything else (a revert with any
/// reason, a short or long answer, a call that burns its gas cap) falls back to the copy exactly like a plain revert.
/// A read of an id with a direct feed starts only with enough gas for both capped calls and the fallback
/// (DIRECT_RESERVE), so a caller cannot choose the branch by sending too little gas: such a call reverts instead.
contract AtlasSource {
    /// @notice Gas caps of the two direct calls (the real feed, a proxy, uses about 10,000 for latestRoundData) and the
    /// gas a read must have when it starts: both caps at 64/63 plus the copy's read and the checks.
    uint256 public constant DECIMALS_GAS = 30_000;
    uint256 public constant ROUND_GAS = 60_000;
    uint256 public constant DIRECT_RESERVE = 120_000;
    /// @notice The only address that may add a direct feed (the deployer). Not transferable.
    address public immutable admin;
    AtlasMirror public immutable mirror;
    /// @notice The age limit of an id without a direct feed (and of the constructor's feed).
    uint256 public immutable maxAge;
    uint256 public constant MAX_AGE_LIMIT = 3600;
    /// @notice Atlas's own feed contract on this chain per feed id; zero: none (the copy only).
    mapping(bytes4 => address) public directFeedOf;
    /// @notice Each direct feed's own age limit, fixed at its admission; the same limit holds for that id's copy.
    mapping(bytes4 => uint256) public maxAgeOf;

    event DirectFeedAdded(bytes4 indexed feedId, address feed, uint256 maxAge);

    error NoFreshPrice(bytes4 feedId);
    error LowGas(uint256 left);
    error NotAdmin(address caller);
    error FeedAlreadySet(bytes4 feedId, address feed);
    error BadFeed(address feed);

    constructor(address directFeed_, bytes4 directFeedId_, AtlasMirror mirror_, uint256 maxAge_) {
        require(address(mirror_) != address(0) && maxAge_ != 0 && maxAge_ <= MAX_AGE_LIMIT, "source");
        require(mirror_.decimals() == 18, "mirror decimals");
        admin = msg.sender;
        mirror = mirror_;
        maxAge = maxAge_;
        if (directFeed_ != address(0)) _add(directFeedId_, directFeed_, maxAge_);
    }

    /// @notice The age limit that applies to an id, direct or copied.
    function ageLimitOf(bytes4 feedId) public view returns (uint256) {
        uint256 a = maxAgeOf[feedId];
        return a == 0 ? maxAge : a;
    }

    function decimals() external pure returns (uint8) { return 18; }

    /// @notice Deployer only, once per id: the id's direct feed and its age limit (1 s to an hour, from the feed's
    /// measured update rhythm). Never changed or removed afterwards.
    function addDirectFeed(bytes4 feedId, address feed, uint256 feedMaxAge) external {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _add(feedId, feed, feedMaxAge);
    }

    function _add(bytes4 feedId, address feed, uint256 feedMaxAge) private {
        if (feedMaxAge == 0 || feedMaxAge > MAX_AGE_LIMIT) revert BadFeed(feed);
        address old = directFeedOf[feedId];
        if (old != address(0)) revert FeedAlreadySet(feedId, old);
        if (feed.code.length == 0) revert BadFeed(feed);
        // A refusal of this caller (their access check) is allowed: decimals are checked on every read. A call that
        // succeeds must answer exactly one word equal to 18.
        (bool called, uint256 size, uint256 d) = _decimalsCall(feed);
        if (called && (size != 32 || d != 18)) revert BadFeed(feed);
        directFeedOf[feedId] = feed;
        maxAgeOf[feedId] = feedMaxAge;
        emit DirectFeedAdded(feedId, feed, feedMaxAge);
    }

    function fetchWithOrigin(bytes4 feedId)
        external
        view
        returns (uint256 price, uint256 aggregatedTs, uint256 onchainTs, bool direct)
    {
        address feed = directFeedOf[feedId];
        uint256 limit = ageLimitOf(feedId);
        if (feed != address(0)) {
            if (gasleft() < DIRECT_RESERVE) revert LowGas(gasleft());
            bool ok;
            (ok, price, aggregatedTs, onchainTs) = _direct(feed, limit);
            if (ok) return (price, aggregatedTs, onchainTs, true);
        }
        AtlasPriceSnapshot memory s = mirror.fetch(feedId);
        if (!AtlasPriceRead.fresh(s.price, s.onchainTs, limit) || s.aggregatedTs > s.onchainTs) revert NoFreshPrice(feedId);
        return (s.price, s.aggregatedTs, s.onchainTs, false);
    }

    /// @notice The feed's answer when every check holds; ok = false otherwise.
    function _direct(address feed, uint256 limit) private view returns (bool ok, uint256 price, uint256 startedAt, uint256 updatedAt) {
        (bool dok, uint256 d) = _decimals(feed);
        if (!dok || d != 18) return (false, 0, 0, 0);
        uint256 answer;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0xfeaf968c)) // latestRoundData()
            ok := staticcall(ROUND_GAS, feed, p, 4, p, 160)
            // Exactly five words, and the two round words (first and fifth) within their declared uint80.
            ok := and(ok, eq(returndatasize(), 160))
            ok := and(ok, iszero(or(shr(80, mload(p)), shr(80, mload(add(p, 128))))))
            answer := mload(add(p, 32))
            startedAt := mload(add(p, 64))
            updatedAt := mload(add(p, 96))
        }
        // Validated before use: a positive price within uint80 (an int256 word read as unsigned: a negative answer is
        // far above the bound), and the times in order and fresh.
        if (!ok || answer == 0 || answer > type(uint80).max || startedAt > updatedAt
            || !AtlasPriceRead.fresh(answer, updatedAt, limit)) return (false, 0, 0, 0);
        return (true, answer, startedAt, updatedAt);
    }

    function _decimals(address feed) private view returns (bool ok, uint256 d) {
        bool called;
        uint256 size;
        (called, size, d) = _decimalsCall(feed);
        ok = called && size == 32;
    }

    /// @return called the call itself succeeded; size and d: its answer's length and first word.
    function _decimalsCall(address feed) private view returns (bool called, uint256 size, uint256 d) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0x313ce567)) // decimals()
            called := staticcall(DECIMALS_GAS, feed, p, 4, p, 32)
            size := returndatasize()
            d := mload(p)
        }
    }
}

/// @title AtlasMirror
/// @notice BNB Chain TESTNET (97) only: a copy of Atlas prices with Atlas's own MultiFeed shape (`fetch(bytes4)`,
/// `fetchBatch`, 18 decimals), written by ONE trusted relayer (the keeper's wallet, fixed here). It exists because
/// Atlas's feeds on the test network answer plain accounts but may refuse a contract (OnlyAuthorizedCallerAllowed)
/// until Atlas authorises the reader: the relayer copies, per feed id, the answer of Atlas's own feed contract for that
/// id (AtlasSource.directFeedOf names it). Each entry keeps Atlas's own two times, so a relay delay counts against the
/// reader's freshness rule. A write never goes back in time and never lands in the future.
contract AtlasMirror {
    address public immutable writer;
    mapping(bytes4 => AtlasPriceSnapshot) private _snaps;

    event Mirrored(bytes4 indexed feedId, uint256 price, uint256 aggregatedTs, uint256 onchainTs);

    error NotWriter(address caller);
    error LengthMismatch();

    constructor(address writer_) {
        require(writer_ != address(0), "writer");
        writer = writer_;
    }

    function decimals() external pure returns (uint8) { return 18; }
    function isOpenRead() external pure returns (bool) { return true; }
    /// @notice Where each copied feed comes from: one trusted relayer (the keeper's wallet) copies Atlas's own answers.
    function description() external pure returns (string memory) {
        return "Copy of Atlas prices by one trusted relayer (the keeper's wallet): per feed id, the answer of Atlas's own feed contract for that id";
    }

    function fetch(bytes4 feedId) external view returns (AtlasPriceSnapshot memory) { return _snaps[feedId]; }

    function fetchBatch(bytes4[] calldata feedIds) external view returns (AtlasPriceSnapshot[] memory out) {
        out = new AtlasPriceSnapshot[](feedIds.length);
        for (uint256 i; i < feedIds.length; ++i) out[i] = _snaps[feedIds[i]];
    }

    /// @notice The writer copies Atlas answers. An entry is skipped (not reverted: one bad row does not block the others)
    /// when its price is zero, its aggregation time is after its on-chain time, its on-chain time is not newer than the
    /// stored one, its aggregation time is older than the stored one, or its on-chain time is after this block's time:
    /// a future write never displaces a usable price (the keeper relays only answers already stamped in the past).
    /// What a wrong writer can still do: write false or old-but-fresh values within these rules, or stop writing (then
    /// the copy goes stale and every read refuses). The setter's 2% step, one-hour interval and bounds limit the damage.
    /// The writer is fixed for good: no rotation (a new writer means a new mirror and a new source).
    function push(bytes4[] calldata feedIds, AtlasPriceSnapshot[] calldata snaps) external returns (uint256 written) {
        if (msg.sender != writer) revert NotWriter(msg.sender);
        if (feedIds.length != snaps.length) revert LengthMismatch();
        for (uint256 i; i < feedIds.length; ++i) {
            AtlasPriceSnapshot calldata s = snaps[i];
            AtlasPriceSnapshot storage old = _snaps[feedIds[i]];
            if (
                s.price == 0 || s.aggregatedTs > s.onchainTs || s.onchainTs <= old.onchainTs
                    || s.aggregatedTs < old.aggregatedTs || s.onchainTs > block.timestamp
            ) continue;
            _snaps[feedIds[i]] = s;
            ++written;
            emit Mirrored(feedIds[i], s.price, s.aggregatedTs, s.onchainTs);
        }
    }
}

/// @title AtlasRaiseSetter
/// @notice Sets a listed coin's raise (the amount a NEW box raises in that coin) to a fixed dollar value divided by
/// the coin's Atlas price. Holds the listing registry's lister role while it runs; anyone may `poke`.
/// A poke changes a raise only when the fresh price moves it by at least 2% and at most once an hour per listing, so a
/// visitor's create is not refused by a raise that changes under it. The result stays within fixed bounds: at least
/// the registry's own floor (`checkLayout`), at most ten times the raise the listing had when this was deployed.
/// After each acceptance of the lister role no poke changes anything for ACCEPT_COOLDOWN (10 minutes), so a raise the
/// holding contract set just before the handover is not moved again at once; the first poke after a handover can change
/// a raise ten minutes after the acceptance, later ones an hour after the row's last change.
/// The managed rows are fixed at construction: a further coin gets a new setter. The deployer keeps exactly two things:
/// a pass-through for the registry's other lister acts, and `handBack`.
/// ADMITTING A NEW COIN needs the hand-back first: admission makes the lister fund a burn probe from its own balance and
/// allowance, and this contract approves nothing (by design: no approve path).
contract AtlasRaiseSetter {
    uint256 public constant MIN_STEP_BPS = 200;
    uint256 public constant MIN_INTERVAL = 3600;
    uint256 public constant ACCEPT_COOLDOWN = 600;
    uint256 public constant MAX_MULTIPLE = 10;

    struct Row {
        bool managed;
        uint8 kind;
        uint8 decimals;
        address source;
        bytes4 feedId;
        uint256 startRaise;
        uint64 lastChange;
    }

    IListingRegistry public immutable listings;
    address public immutable owner;
    /// @notice Where `handBack` proposes the lister role: the lister at deployment (the platform's holding contract).
    address public immutable returnTo;
    /// @notice The dollar value of every managed raise, 18 decimals.
    uint256 public immutable targetUsdX18;
    mapping(uint32 => Row) public rows;
    /// @notice When this contract last accepted the lister role (0: never).
    uint256 public acceptedAt;
    uint32[] public managedIds;

    /// @param direct true: the price came from Atlas's own contract; false: from the relayed copy.
    event RaiseSet(
        uint32 indexed listingId,
        uint256 price,
        uint256 aggregatedTs,
        uint256 onchainTs,
        bool direct,
        uint256 oldRaise,
        uint256 newRaise
    );
    event RaiseKept(uint32 indexed listingId, uint256 price, uint256 onchainTs, bool direct, uint256 raise, bool tooSoon);

    event RowAdded(uint32 indexed listingId, uint8 kind, address source, bytes4 feedId, uint256 startRaise);

    error NotOwner(address caller);
    error NotManaged(uint32 listingId);
    error BelowFloor(uint256 raise);
    error AboveCeiling(uint256 raise, uint256 ceiling);
    error RefusedSelector(bytes4 selector);
    error CallFailed(bytes reason);
    error BadRows();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(
        IListingRegistry listings_,
        address owner_,
        uint256 targetUsdX18_,
        uint32[] memory ids,
        uint8[] memory kinds,
        address[] memory sources,
        bytes4[] memory feedIds
    ) {
        if (
            owner_ == address(0) || targetUsdX18_ == 0 || ids.length == 0 || ids.length != kinds.length
                || ids.length != sources.length || ids.length != feedIds.length
        ) revert BadRows();
        listings = listings_;
        owner = owner_;
        returnTo = listings_.lister();
        targetUsdX18 = targetUsdX18_;
        for (uint256 i; i < ids.length; ++i) _addRow(ids[i], kinds[i], sources[i], feedIds[i]);
    }

    function _addRow(uint32 id, uint8 kind, address source, bytes4 feedId) private {
        // Only rows read through an AtlasSource (its per-read checks, its mirror for the handover's check).
        if (rows[id].managed || kind != AtlasPriceRead.SOURCE) revert BadRows();
        if (AtlasSource(source).decimals() != 18 || address(AtlasSource(source).mirror()) == address(0)) revert BadRows();
        ListingRecord memory l = listings.listing(id);
        if (l.raise == 0) revert BadRows();
        // A row that can never quote is refused: the smallest raise any valid price gives (the widest uint80 price) above
        // the ceiling, or the largest (a price of one unit) under the registry's floor.
        uint256 scaled = targetUsdX18 * (10 ** uint256(l.decimals));
        if (scaled / type(uint80).max > l.raise * MAX_MULTIPLE || scaled < 1_000_000) revert BadRows();
        rows[id] = Row(true, kind, l.decimals, source, feedId, l.raise, 0);
        managedIds.push(id);
        emit RowAdded(id, kind, source, feedId, l.raise);
    }

    /// @notice The raise this listing would get now, from a fresh price; reverts on a refused price or bound.
    function quote(uint32 listingId)
        public
        view
        returns (uint256 raise, uint256 price, uint256 aggregatedTs, uint256 onchainTs, bool direct)
    {
        Row memory r = rows[listingId];
        if (!r.managed) revert NotManaged(listingId);
        (price, aggregatedTs, onchainTs, direct) = AtlasPriceRead.readWithOrigin(r.kind, r.source, r.feedId);
        raise = targetUsdX18 * (10 ** uint256(r.decimals)) / price;
        if (raise < 1_000_000) revert BelowFloor(raise);
        try listings.checkLayout(raise) {} catch { revert BelowFloor(raise); }
        if (raise > r.startRaise * MAX_MULTIPLE) revert AboveCeiling(raise, r.startRaise * MAX_MULTIPLE);
    }

    /// @notice Anyone (the keeper) may call. Returns true when the raise changed.
    function poke(uint32 listingId) external returns (bool changed) {
        (uint256 raise, uint256 price, uint256 aggregatedTs, uint256 onchainTs, bool direct) = quote(listingId);
        Row storage r = rows[listingId];
        uint256 current = listings.listing(listingId).raise;
        bool tooSoon = (r.lastChange != 0 && block.timestamp < uint256(r.lastChange) + MIN_INTERVAL)
            || block.timestamp < acceptedAt + ACCEPT_COOLDOWN;
        uint256 step = raise > current ? raise - current : current - raise;
        if (tooSoon || step * 10_000 < MIN_STEP_BPS * current) {
            emit RaiseKept(listingId, price, onchainTs, direct, current, tooSoon);
            return false;
        }
        r.lastChange = uint64(block.timestamp);
        listings.updateRaise(listingId, raise);
        emit RaiseSet(listingId, price, aggregatedTs, onchainTs, direct, current, raise);
        return true;
    }

    /// @notice Takes the lister role once the holding contract proposed this contract; starts the cooldown.
    function accept() external {
        listings.acceptLister();
        acceptedAt = block.timestamp;
    }

    /// @notice Owner only: the registry's other lister acts (add a listing, set a royalty lot). Raise changes, lister
    /// changes and renouncing are refused here: raises move only by `poke`, the role leaves only by `handBack`.
    function listerCall(bytes calldata data) external onlyOwner returns (bytes memory result) {
        bytes4 selector = bytes4(data[:4]);
        if (
            selector == IListingRegistry.updateRaise.selector || selector == IListingRegistry.proposeLister.selector
                || selector == IListingRegistry.acceptLister.selector
                || selector == IListingRegistry.proposeRenounce.selector || selector == IListingRegistry.renounce.selector
        ) revert RefusedSelector(selector);
        bool ok;
        (ok, result) = address(listings).call(data);
        if (!ok) revert CallFailed(result);
    }

    /// @notice Owner only: propose the lister role back to the holding contract; it accepts with its own call.
    function handBack() external onlyOwner {
        listings.proposeLister(returnTo);
    }

    function managedCount() external view returns (uint256) { return managedIds.length; }
}
