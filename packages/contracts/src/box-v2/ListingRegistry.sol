// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxSpecV1} from "../box/BoxSpecV1.sol";
import {IListingRegistry, ListingRecord, ListingClass, ListingKind, ListingRefusal, QParameters} from "./interfaces/IListingRegistry.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";
import {ListingChecks, IListingChecksHost} from "./libraries/ListingChecks.sol";
import {IListingBurnV21} from "./interfaces/IListingBurnV21.sol";
import {CheckedBurn} from "./libraries/CheckedBurn.sol";
import {BoxTokenProof} from "./libraries/BoxTokenProof.sol";
import {BoxLayoutV2} from "./libraries/BoxLayoutV2.sol";

/// @notice Internal registry/planner arithmetic. Amounts depend only on the box's creation raise; no funds move.
library ListingRaises {
    /// @notice Internal callers derive positive thresholds from an admitted raise, rounding up; no funds move.
    function parameters(uint256 raise) internal pure returns (QParameters memory q) {
        if (raise < 1_000_000 || raise > type(uint128).max) {
            revert IListingRegistry.ListingRefused(ListingRefusal.RAISE_NOT_BUILDABLE);
        }
        q.bootstrapQ = FullMath.mulDivRoundingUp(raise, BoxSpecV1.BOOTSTRAP_ETH, C.RAISE_ETH);
        q.batchMinQ = FullMath.mulDivRoundingUp(raise, BoxSpecV1.FEE_BATCH_MIN_ETH, C.RAISE_ETH);
        q.tipMaxQ = FullMath.mulDivRoundingUp(raise, BoxSpecV1.FEE_BATCH_TIP_MAX_ETH, C.RAISE_ETH);
        q.swapStepMinQ = FullMath.mulDivRoundingUp(raise, BoxSpecV1.SWAP_STEP_MIN_Q, C.RAISE_ETH);
        if (q.bootstrapQ == 0 || q.batchMinQ == 0 || q.tipMaxQ == 0 || q.swapStepMinQ == 0) {
            revert IListingRegistry.ListingRefused(ListingRefusal.BOUND_ZERO);
        }
    }
}

/// @notice One permanent row per coin. Only the lister can admit coins or change future boxes' raises (F123).
/// Admission probes always roll back; this registry retains no funds, routes, approvals spent or rescue power.
contract ListingRegistry is IListingRegistry, IListingBurnV21, IListingChecksHost, TransientReentrancyGuard {
    /// @inheritdoc IListingRegistry
    address public immutable boxRegistry;
    /// @inheritdoc IListingRegistry
    address public immutable poolManager;
    /// @inheritdoc IListingRegistry
    address public immutable weth;
    /// @inheritdoc IListingRegistry
    uint256 public constant RAISE_ETH = C.RAISE_ETH;
    /// @inheritdoc IListingRegistry
    address public lister;
    /// @inheritdoc IListingRegistry
    address public pendingLister;
    /// @inheritdoc IListingRegistry
    bool public renouncePending;
    /// @inheritdoc IListingRegistry
    bool public renounced;
    ListingRecord[] private _rows;
    mapping(address => uint32) private _idPlusOne;

    /// @inheritdoc IListingBurnV21
    mapping(address => bytes4) public checkedBurnSelector;
    error BurnProbePassed();
    struct LotCheckpoint { uint256 version; uint256 lot; }
    mapping(address => LotCheckpoint[]) private _lots;
    address[] private _sellable;
    uint256 public sellableVersion;
    mapping(address => uint256) public royaltyLot;

    /// @notice Lister sets this coin's raw-unit lot for future boxes. Native row 0 names WETH.
    function setRoyaltyLot(uint32 id, uint256 lot) external onlyLister {
        if (id >= _rows.length) revert UnknownListing(id);
        if (_rows[id].kind == ListingKind.BOX_TOKEN) revert ListingRefused(ListingRefusal.BOX_TOKEN_BY_RULE);
        address coin = id == 0 ? weth : _rows[id].token;
        if (lot == 0 || lot > type(uint256).max / 20) revert BadWiring();
        _recordLot(coin, lot);
    }

    /// @notice Immutable history; later listings and lot edits cannot affect an old inbox.
    function sellableLotAt(address coin, uint256 version) external view returns (uint256) {
        if (version > sellableVersion || BoxTokenProof.isBoxToken(boxRegistry, coin)) return 0;
        LotCheckpoint[] storage h = _lots[coin];
        uint256 lo; uint256 hi = h.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (h[mid].version <= version) lo = mid + 1; else hi = mid;
        }
        return lo == 0 ? 0 : h[lo - 1].lot;
    }

    /// @notice Enumerate only the coins present at a captured version, without copying per-box lists.
    function sellableCount(uint256 version) external view returns (uint256) {
        uint256 lo; uint256 hi = _sellable.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_lots[_sellable[mid]][0].version <= version) lo = mid + 1; else hi = mid;
        }
        return lo;
    }
    function sellableToken(uint256 index) external view returns (address) { return _sellable[index]; }

    function _recordLot(address coin, uint256 lot) private {
        if (_lots[coin].length == 0) _sellable.push(coin);
        _lots[coin].push(LotCheckpoint(++sellableVersion, lot));
        royaltyLot[coin] = lot;
        emit RoyaltyLotUpdated(coin, lot);
    }

    /// @notice Deployment refuses invalid release wiring; no funds move.
    error BadWiring();

    /// @notice Deployer fixes the release and initial lister. Native ETH is permanent row 0; no funds move.
    constructor(address lister_, address registry_, address manager_, address weth_) {
        if (lister_ == address(0) || registry_.code.length == 0 || manager_.code.length == 0 || weth_ == address(0)) {
            revert BadWiring();
        }
        lister = lister_;
        boxRegistry = registry_;
        poolManager = manager_;
        weth = weth_;
        _append(address(0), 18, ListingClass.NATIVE, ListingKind.LISTED, RAISE_ETH, ListingRaises.parameters(RAISE_ETH));
    }

    modifier onlyLister() {
        if (renounced || msg.sender != lister) revert NotLister(msg.sender);
        _;
    }

    /// @inheritdoc IListingRegistry
    function add(address token, ListingClass class, uint256 raise) external nonReentrant onlyLister returns (uint32 id) {
        return _add(token, class, raise);
    }

    /// @inheritdoc IListingBurnV21
    function addWithBurn(address token, ListingClass class, uint256 raise, bytes4 selector)
        external nonReentrant onlyLister returns (uint32 id)
    {
        if (selector != CheckedBurn.SELECTOR) revert CheckedBurn.BurnRefused();
        id = _add(token, class, raise);
        (bool ok, bytes memory result) = address(this).call(abi.encodeCall(this.probeBurn, (token, msg.sender)));
        if (ok || result.length != 4 || bytes4(result) != BurnProbePassed.selector) revert CheckedBurn.BurnRefused();
        checkedBurnSelector[token] = selector;
        emit CheckedBurnRecorded(id, token, selector);
    }

    /// @notice Self only during lister admission. Pull and burn exactly 10,000 raw units, then always roll back.
    function probeBurn(address token, address funder) external {
        if (msg.sender != address(this)) revert ListingChecks.NotSelf(msg.sender);
        uint256 supply = CheckedBurn.totalSupply(token);
        uint256 before_ = CheckedBurn.balanceOf(token, address(this));
        uint256 held = CheckedBurn.balanceOf(token, funder);
        (bool ok, bytes memory result) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", funder, address(this), uint256(10_000)));
        if (!ok || (result.length != 0 && (result.length != 32 || abi.decode(result, (uint256)) != 1))
            || held < 10_000
            || CheckedBurn.balanceOf(token, funder) != held - 10_000
            || CheckedBurn.balanceOf(token, address(this)) != before_ + 10_000
            || CheckedBurn.totalSupply(token) != supply) revert CheckedBurn.BurnRefused();
        CheckedBurn.burn(token, 10_000);
        revert BurnProbePassed();
    }

    function _add(address token, ListingClass class, uint256 raise) private returns (uint32 id) {
        uint32 known = _idPlusOne[token];
        if (known != 0) revert AlreadyListed(token, known - 1);
        if (token == weth) revert ListingRefused(ListingRefusal.CLASS_NOT_ALLOWED);
        (bool box, BoxTokenProof.Proof memory proof) = BoxTokenProof.findBox(boxRegistry, token);
        uint8 decimals;
        ListingKind kind;
        if (box) {
            if (class != ListingClass.STANDARD) revert ListingRefused(ListingRefusal.CLASS_NOT_ALLOWED);
            BoxTokenProof.checkState(proof);
            decimals = ListingChecks.checkStatic(token);
            kind = ListingKind.BOX_TOKEN;
        } else {
            if (class != ListingClass.STABLE && class != ListingClass.STOCK && class != ListingClass.OTHER) {
                revert ListingRefused(ListingRefusal.CLASS_NOT_ALLOWED);
            }
            decimals = ListingChecks.checkStatic(token);
            ListingChecks.checkTransfers(token, msg.sender);
            kind = ListingKind.LISTED;
        }
        QParameters memory q = _checkedRaise(raise);
        id = _append(token, decimals, class, kind, raise, q);
    }

    /// @inheritdoc IListingRegistry
    function updateRaise(uint32 id, uint256 raise) external nonReentrant onlyLister {
        if (id >= _rows.length) revert UnknownListing(id);
        QParameters memory q = _checkedRaise(raise);
        uint256 before_ = _rows[id].raise;
        _rows[id].raise = raise;
        _rows[id].q = q;
        emit RaiseUpdated(id, before_, raise);
    }

    /// @inheritdoc IListingRegistry
    function checkLayout(uint256 raise) external pure {
        ListingRaises.parameters(raise);
        BoxLayoutV2.Curve memory c = BoxLayoutV2.curve(raise, false);
        BoxLayoutV2.FullRange memory g = BoxLayoutV2.fullRange(c, raise, c.poolShare);
        if (g.liquidity == 0 || g.qAmount == 0 || g.tAmount == 0) {
            revert ListingRefused(ListingRefusal.RAISE_NOT_BUILDABLE);
        }
    }

    /// @inheritdoc IListingRegistry
    function listing(uint32 id) external view returns (ListingRecord memory) {
        if (id >= _rows.length) revert UnknownListing(id);
        return _rows[id];
    }
    /// @inheritdoc IListingRegistry
    function listingCount() external view returns (uint32) { return uint32(_rows.length); }
    /// @inheritdoc IListingRegistry
    function newestListingOf(address token) external view returns (bool listed, uint32 id) {
        uint32 n = _idPlusOne[token];
        return n == 0 ? (false, 0) : (true, n - 1);
    }
    /// @inheritdoc IListingRegistry
    function proposeLister(address proposed) external nonReentrant onlyLister {
        pendingLister = proposed;
        renouncePending = false;
        emit ListerProposed(lister, proposed);
    }
    /// @inheritdoc IListingRegistry
    function acceptLister() external nonReentrant {
        if (renounced || pendingLister == address(0) || msg.sender != pendingLister) revert NotPendingLister(msg.sender);
        address previous = lister;
        lister = msg.sender;
        pendingLister = address(0);
        renouncePending = false;
        emit ListerChanged(previous, msg.sender);
    }
    /// @inheritdoc IListingRegistry
    function proposeRenounce() external nonReentrant onlyLister {
        pendingLister = address(0);
        renouncePending = true;
        emit RenounceProposed(lister);
    }
    /// @inheritdoc IListingRegistry
    function renounce() external nonReentrant onlyLister {
        if (!renouncePending) revert NoRenouncePending();
        address previous = lister;
        lister = address(0);
        pendingLister = address(0);
        renouncePending = false;
        renounced = true;
        emit Renounced(previous);
    }

    /// @notice Self only, inside admission. All token movements revert, including a successful probe.
    function probeTransfers(address token, address funder) external { ListingChecks.probe(token, funder, poolManager); }
    /// @notice PoolManager only, inside the reverting probe. Settles and takes exactly the probe amount, retaining none.
    function unlockCallback(bytes calldata data) external returns (bytes memory) { return ListingChecks.onUnlock(poolManager, data); }

    function _checkedRaise(uint256 raise) private view returns (QParameters memory q) {
        q = ListingRaises.parameters(raise);
        try this.checkLayout(raise) {} catch { revert ListingRefused(ListingRefusal.RAISE_NOT_BUILDABLE); }
    }
    function _append(address token, uint8 decimals, ListingClass class, ListingKind kind, uint256 raise, QParameters memory q)
        private returns (uint32 id)
    {
        // Leave room for the id+1 sentinel; the counter cannot wrap into native row zero.
        if (_rows.length >= type(uint32).max) revert BadWiring();
        // forge-lint: disable-next-line(unsafe-typecast)
        id = uint32(_rows.length);
        // Timestamp is below uint64 throughout the supported chain lifetime.
        // forge-lint: disable-next-line(unsafe-typecast)
        _rows.push(ListingRecord(id, token, decimals, class, kind, uint64(block.timestamp), raise, q));
        _idPlusOne[token] = id + 1;
        if (kind == ListingKind.LISTED) {
            // WETH starts at 0.05; other coins start at one whole coin. Lister may set a reviewed raw lot.
            _recordLot(token == address(0) ? weth : token, token == address(0) ? 0.05 ether : 10 ** uint256(decimals));
        }
        emit ListingAdded(id, token, class, kind, raise);
    }
}
