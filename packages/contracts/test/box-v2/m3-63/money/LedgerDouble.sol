// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BoxCloneBase} from "../../../../src/box/BoxCloneBase.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverItemsV2, ItemFundingV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2, ItemLifecycleV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {BoxRolesV2} from "../../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {PricingToken} from "../../../../src/box-v2/libraries/PricingToken.sol";

interface MoneyItemOwnerDouble {
    /// @notice Anyone reads the current owner from the fixed own collection; no funds move.
    function ownerOf(uint256 id) external view returns (address);
}

/// @notice TEST ONLY: proposed MONEY01/02 corrections to the pinned ledger, never release code.
/// @dev Snapshot of the supplied ItemLedgerV2; only initial-shelf and late-base handling differ.
/// @dev Only current owners claim, without a minimum, tip, wallet-code restriction or expiry (F127).
/// S1's 206 packed bytes: coordinator/vault/collection/tickets/receiver/hook/P at 0/20/40/60/80/100/120;
/// buyer/seller policies at 140/141; legacy slots at 142/174 are unused. No administrator or funding callback.
/// The authenticated receiver MUST transfer each receipt's backing atomically before publishing it. PM balance
/// is only a solvency check; neither gifts nor future receipts are inferred as funding. Unknown items have no
/// assigned credit. No operation enumerates the collection or outstanding tickets.
contract MoneyLedgerDouble is IItemLedgerV2, IUnlockCallback, BoxCloneBase, TransientReentrancyGuard {
    using TransientStateLibrary for IPoolManager;

    error InvalidWiring();
    error Unauthorized();
    error NotInitialized();
    error InvalidPage();
    error InvalidRecord();
    error InvalidItem();
    error UnbackedReceipt();
    error ForeignUnlock();
    error InvalidClaim();
    error PayoutFailed();
    error GasTooLow();
    error TransferFailed();

    /// @notice Permissionless flush paid these resolved P claims to the immutable hook, never the receiver.
    event ResidueFlushed(uint256 p);
    /// @notice An owner claim paid gross P from this item's credit; the legacy tipP field is always zero.
    event ItemPaid(uint256 indexed id, address indexed owner, address indexed to, uint256 grossP, uint256 tipP);

    IPoolManager internal immutable _pm;
    address private immutable _implementation;
    /// @notice Anyone reads the release's fixed coordinator implementation; no funds move.
    address public immutable coordinatorImplementation;
    /// @notice Anyone reads the cap for one complete PM owner payout; no funds move.
    uint256 public constant CLAIM_GAS = 250_000;
    uint256 private constant PAYOUT_RESERVE_GAS = 100_000;
    // One signed v4 burn/take pair per payout, irrespective of accumulated uint256 credit.
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));
    bytes32 private constant PAYOUT = keccak256("squarehole.item.v2.payout");

    struct Item {
        uint256 outsideP;
        uint256 stash;
        uint256 checkpoint;
        uint256 baseCheckpoint;
        bool known;
        bool outside;
    }

    struct Ticket {
        uint256 start;
        uint256 stash;
        bool used;
        bool open;
    }
    mapping(uint256 => Item) internal _items;
    mapping(bytes32 => Ticket) internal _tickets;
    uint256 internal _hidden;
    uint256 internal _hiddenStash;
    uint256 internal _baseUnassigned;
    uint256 internal _basePerItem;
    uint256 internal _residue;
    uint256 internal _liability;
    uint256 private _n;
    uint256 private _firstId;
    uint256 private _inside;
    uint256 private _outsideIndex;
    uint256 private _keepIndex;
    uint256 private _fundingCursor;
    uint256 private _lifecycleCursor;
    uint8 private _released;
    bool private _initialShelf;

    /// @notice Release deployer fixes the PM and coordinator implementation; no funds move.
    constructor(IPoolManager pm, address coordinatorImplementation_) {
        if (address(pm).code.length == 0 || coordinatorImplementation_.code.length == 0) revert InvalidWiring();
        _pm = pm;
        coordinatorImplementation = coordinatorImplementation_;
        _implementation = address(this);
    }

    /// @inheritdoc IItemLedgerV2
    function initialize() external nonReentrant {
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(_argAddress(0));
        if (msg.sender != address(c) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert Unauthorized();
        }
        if (
            _n != 0 || !BoxClones.isCloneOf(address(this), _implementation)
                || address(this).code.length != BoxClones.ARGS_OFFSET + 206
        ) revert InvalidWiring();
        (uint8 b, uint8 s) = insidePolicies();
        IBoxVaultV2 v = IBoxVaultV2(_argAddress(20));
        if (
            b > 2 || s > 2 || b + s == 0 || c.roleAddress(BoxRolesV2.ROLE_ITEM_LEDGER) != address(this)
                || c.poolManager() != address(_pm) || c.vault() != address(v) || c.collection() != _argAddress(40)
                || c.tickets() != _argAddress(60) || c.receiver() != _argAddress(80) || c.hook() != _argAddress(100)
                || c.q() != _argAddress(120) || v.coordinator() != address(c) || v.collection() != _argAddress(40)
                || _argAddress(40).code.length == 0 || _argAddress(80).code.length == 0
                || _argAddress(100).code.length == 0 || c.graduated() || c.failed()
        ) revert InvalidWiring();
        _n = v.collectionSize();
        _firstId = v.firstId();
        if (_n == 0 || _n > type(uint32).max || _firstId > type(uint256).max - (_n - 1)) revert InvalidWiring();
        _hidden = v.hiddenCount();
        if (_hidden != 0 && _hidden != _n) revert InvalidWiring();
        _initialShelf = _hidden == 0;
        _inside = _n;
    }

    /// @inheritdoc IItemLedgerV2
    function insidePolicies() public view returns (uint8 buyers, uint8 sellers) {
        return (uint8(_argUint(140, 1)), uint8(_argUint(141, 1)));
    }

    /// @inheritdoc IItemLedgerV2
    function fundingCursor() external view returns (uint256) {
        return _fundingCursor;
    }

    /// @inheritdoc IItemLedgerV2
    function lifecycleCursor() external view returns (uint256) {
        return _lifecycleCursor;
    }

    /// @inheritdoc IItemLedgerV2
    /// @dev Snapshots both targets at entry. Each loop consumes one record, at most k from each journal.
    /// Callback hints defer all replay, so even an unbounded backlog never makes custody depend on sync.
    function sync(uint256 k) external nonReentrant {
        _initialized();
        _outsideUnlock();
        if (k == 0 || k > 32) revert InvalidPage();
        IBoxReceiverItemsV2 r = IBoxReceiverItemsV2(_argAddress(80));
        IBoxVaultItemsV2 v = IBoxVaultItemsV2(_argAddress(20));
        uint256 fEnd = r.itemFundingCount();
        uint256 lEnd = v.itemLifecycleCount();
        if (fEnd < _fundingCursor || lEnd < _lifecycleCursor) revert InvalidRecord();
        if (fEnd > _fundingCursor) {
            IBoxCoordinatorV2 c = IBoxCoordinatorV2(_argAddress(0));
            if (!c.graduated() || c.failed()) revert InvalidRecord();
        }
        uint256 f;
        uint256 l;
        while (true) {
            if (l < k && _lifecycleCursor < lEnd) {
                ItemLifecycleV2 memory op = v.itemLifecycle(_lifecycleCursor + 1);
                if (op.fundingCursor < _fundingCursor || op.fundingCursor > fEnd) revert InvalidRecord();
                if (op.fundingCursor == _fundingCursor) {
                    _operation(op);
                    ++_lifecycleCursor;
                    ++l;
                    continue;
                }
            }
            if (f < k && _fundingCursor < fEnd) {
                ItemFundingV2 memory receipt = r.itemFunding(_fundingCursor + 1);
                if (receipt.lifecycleCursor < _lifecycleCursor || receipt.lifecycleCursor > lEnd) {
                    revert InvalidRecord();
                }
                if (receipt.lifecycleCursor == _lifecycleCursor) {
                    _receipt(receipt);
                    ++_fundingCursor;
                    ++f;
                    continue;
                }
            }
            break;
        }
        _solvent();
    }

    function _receipt(ItemFundingV2 memory r) private {
        if (r.side != 1 && r.side != 2) revert InvalidRecord();
        (uint8 b, uint8 s) = insidePolicies();
        uint8 policy = r.side == 1 ? b : s;
        if (policy == 0 || r.insideCount != _inside || r.hiddenCount != _hidden) revert InvalidRecord();
        if (
            r.source < 1 || r.source > 3
                || (r.source == 1 ? r.batchId == 0 || r.batchId % 2 != r.side % 2 : r.batchId != 0)
        ) revert InvalidRecord();
        uint8 bit = r.side == 1 ? 1 : 2;
        if (r.source == 3) {
            if (_released & bit != 0) revert InvalidRecord();
            _released |= bit;
        } else if (_released != (b == 0 ? 0 : 1) + (s == 0 ? 0 : 2)) {
            revert InvalidRecord();
        }
        uint256 u = r.choiceP / _n;
        uint256 expected = policy == 1 ? r.choiceP : r.source == 3 ? 0 : r.choiceP - _inside * u;
        if (r.ledgerP != expected) revert UnbackedReceipt();
        _liability += r.ledgerP;
        if (r.source == 3) {
            if (policy == 1) {
                _basePerItem += u;
                _baseUnassigned += _n * u;
                _residue += r.choiceP % _n;
            }
        } else {
            _outsideIndex += u;
            _residue += r.choiceP % _n;
            if (policy == 1) {
                _keepIndex += u;
                _hiddenStash += _hidden * u;
            }
        }
    }

    function _slot() private returns (uint256 stash) {
        if (_hidden == 0) revert InvalidRecord();
        stash = _hiddenStash / _hidden;
        _hiddenStash -= stash;
        --_hidden;
    }

    function _assign(Item storage a) private {
        if (a.known) revert InvalidRecord();
        a.known = true;
        if (_initialShelf) a.stash += _keepIndex;
        _settleBase(a);
    }

    function _settleBase(Item storage a) private {
        uint256 pending = _basePerItem - a.baseCheckpoint;
        a.stash += pending;
        _baseUnassigned -= pending;
        a.baseCheckpoint = _basePerItem;
    }

    function _settle(Item storage a) internal {
        _settleBase(a);
        if (a.outside) a.outsideP += _outsideIndex - a.checkpoint;
        else a.stash += _keepIndex - a.checkpoint;
    }

    function _operation(ItemLifecycleV2 memory op) private {
        if (op.kind == 1 || op.kind == 3) {
            if (op.itemId != 0 || op.ticketKey == bytes32(0)) revert InvalidRecord();
            Ticket storage t = _tickets[op.ticketKey];
            if (op.kind == 1) {
                if (t.used || _inside == 0) revert InvalidRecord();
                t.used = true;
                t.open = true;
                t.start = _outsideIndex;
                t.stash = _slot();
                --_inside;
            } else {
                if (!t.open) revert InvalidRecord();
                _residue += _outsideIndex - t.start;
                _hiddenStash += t.stash;
                ++_hidden;
                ++_inside;
                t.stash = 0;
                t.open = false;
            }
            return;
        }
        _validId(op.itemId);
        Item storage a = _items[op.itemId];
        if (op.kind == 2) {
            Ticket storage t = _tickets[op.ticketKey];
            if (!t.open) revert InvalidRecord();
            _assign(a);
            a.stash += t.stash;
            a.outsideP += _outsideIndex - t.start;
            a.outside = true;
            a.checkpoint = _outsideIndex;
            t.stash = 0;
            t.open = false;
        } else {
            if (op.ticketKey != bytes32(0)) revert InvalidRecord();
            if (op.kind == 4) {
                if (a.outside || _inside == 0) revert InvalidRecord();
                if (a.known) {
                    _settle(a);
                } else {
                    if (!_initialShelf) a.stash += _slot();
                    _assign(a);
                }
                a.outside = true;
                a.checkpoint = _outsideIndex;
                --_inside;
            } else if (op.kind == 5) {
                if (!a.outside) revert InvalidRecord();
                _settle(a);
                a.outside = false;
                a.checkpoint = _keepIndex;
                ++_inside;
            } else if (op.kind != 6 || _released != 0 || !IBoxCoordinatorV2(_argAddress(0)).failed()) {
                revert InvalidRecord();
            }
            // FailureRelease has no funded entitlement; the failed-box custody journal remains authoritative.
        }
    }

    /// @inheritdoc IItemLedgerV2
    function itemCredit(uint256 id) external view returns (uint256 outsideP, uint256 stashP) {
        _initialized();
        _validId(id);
        Item storage a = _items[id];
        if (!a.known) return (0, 0);
        outsideP = a.outsideP;
        stashP = a.stash + _basePerItem - a.baseCheckpoint;
        if (a.outside) outsideP += _outsideIndex - a.checkpoint;
        else stashP += _keepIndex - a.checkpoint;
    }

    /// @inheritdoc IItemLedgerV2
    function ticketCredit(bytes32 key) external view returns (uint256 start, uint256 p, bool open) {
        _initialized();
        Ticket storage t = _tickets[key];
        return (t.start, t.open ? _outsideIndex - t.start : 0, t.open);
    }

    /// @inheritdoc IItemLedgerV2
    function flushResidue() external nonReentrant returns (uint256 p) {
        _initialized();
        _outsideUnlock();
        _solvent();
        p = _residue;
        _residue = 0;
        _liability -= p;
        if (p != 0) {
            if (!_pm.transfer(_argAddress(100), uint160(_argAddress(120)), p)) revert TransferFailed();
            emit ResidueFlushed(p);
        }
    }

    /// @inheritdoc IItemLedgerV2
    /// @dev Exactly one id. Prior sync must reach both entry cursors; no minimum, tip or expiry.
    /// Pays at most int128.max raw P per call; repeat to redeem the remainder that stays with the NFT.
    function claim(uint256[] calldata ids, address to) external nonReentrant returns (uint256 p) {
        address owner = _owner(ids);
        if (owner != msg.sender) revert Unauthorized();
        if (to == address(0) || to == _argAddress(20)) revert InvalidClaim();
        p = _take(ids[0]);
        if (!_pay(to, p, CLAIM_GAS, PAYOUT_RESERVE_GAS)) revert PayoutFailed();
        emit ItemPaid(ids[0], owner, to, p, 0);
    }

    function _owner(uint256[] calldata ids) private view returns (address owner) {
        _ready();
        if (ids.length != 1) revert InvalidClaim();
        _validId(ids[0]);
        owner = MoneyItemOwnerDouble(_argAddress(40)).ownerOf(ids[0]);
        if (owner == address(0) || owner == _argAddress(20)) revert InvalidClaim();
    }

    function _take(uint256 id) private returns (uint256 gross) {
        _solvent();
        Item storage a = _items[id];
        if (!a.known || !a.outside) revert InvalidClaim();
        _settle(a);
        a.checkpoint = _outsideIndex;
        gross = a.outsideP + a.stash;
        if (gross == 0) revert InvalidClaim();
        if (gross > MAX_PART) gross = MAX_PART;
        // Consume outside earnings first, then only the needed stash. All unpaid P follows the NFT.
        if (a.outsideP >= gross) {
            a.outsideP -= gross;
        } else {
            a.stash -= gross - a.outsideP;
            a.outsideP = 0;
        }
        _liability -= gross;
    }

    function _pay(address to, uint256 amount, uint256 cap, uint256 reserve) private returns (bool ok) {
        if (gasleft() < cap + cap / 63 + C.POKE_OVERHEAD_GAS + reserve) revert GasTooLow();
        bytes memory data = abi.encodeCall(IPoolManager.unlock, (abi.encode(to, amount)));
        address pm = address(_pm);
        bytes32 slot = PAYOUT;
        // The trusted PM alone consumes the arm. Do not copy arbitrary token/recipient revert data.
        assembly ("memory-safe") {
            tstore(slot, 1)
            ok := call(cap, pm, 0, add(data, 32), mload(data), 0, 0)
            tstore(slot, 0)
        }
    }

    /// @notice Only the fixed PM during this ledger's once-armed guarded payout may redeem P claims.
    /// @dev The bounded debit needs one burn/take pair; exact ERC-20 debit AND receipt reject tax/rebase loss.
    /// Every external balance read and token/recipient call runs inside CLAIM_GAS. No wallet fallback.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_pm)) revert Unauthorized();
        bytes32 slot = PAYOUT;
        uint256 armed;
        assembly ("memory-safe") {
            armed := tload(slot)
            tstore(slot, 0)
        }
        if (armed == 0 || !_insideGuardedCall()) revert InvalidClaim();
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        address p = _argAddress(120);
        uint256 beforePM = PricingToken.balanceOf(p, address(_pm));
        uint256 beforeTo = PricingToken.balanceOf(p, to);
        _pm.burn(address(this), uint160(p), amount);
        _pm.take(Currency.wrap(p), to, amount);
        if (beforePM - PricingToken.balanceOf(p, address(_pm)) != amount) revert PayoutFailed();
        // Native CALL transfers exact value; its recipient may legitimately spend it in receive().
        if (p != address(0) && PricingToken.balanceOf(p, to) - beforeTo != amount) revert PayoutFailed();
        return "";
    }

    function _ready() internal view {
        _initialized();
        _outsideUnlock();
        if (
            _fundingCursor != IBoxReceiverItemsV2(_argAddress(80)).itemFundingCount()
                || _lifecycleCursor != IBoxVaultItemsV2(_argAddress(20)).itemLifecycleCount()
        ) {
            revert ItemSyncPending(_fundingCursor, _lifecycleCursor);
        }
    }

    function _initialized() private view {
        if (_n == 0) revert NotInitialized();
    }

    function _validId(uint256 id) private view {
        if (id < _firstId || id - _firstId >= _n) revert InvalidItem();
    }

    function _outsideUnlock() private view {
        if (_pm.isUnlocked()) revert ForeignUnlock();
    }

    function _solvent() private view {
        if (_pm.balanceOf(address(this), uint160(_argAddress(120))) < _liability) revert UnbackedReceipt();
    }

    function _notice() private view {
        _initialized();
        if (msg.sender != _argAddress(20)) revert Unauthorized();
    }

    /// @notice Fixed vault only; accounting hint is deliberately deferred to permissionless sync, no external calls.
    function onTicketsOpened(uint256, uint256) external view {
        _notice();
    }

    /// @notice Fixed vault only; exact keys come from the durable journal, never from these legacy arguments.
    function onTicketsReleased(address, uint256, uint256, uint256) external view {
        _notice();
    }

    /// @notice Fixed vault only; no payout or replay on the custody path.
    function onWithdrawn(address, uint256[] calldata) external view {
        _notice();
    }

    /// @notice Fixed vault only; no payout or replay on the custody path.
    function onReturned(address, uint256[] calldata) external view {
        _notice();
    }

    /// @notice Fixed vault only; timestamps are metadata, never identities or accounting indexes.
    function onDelivered(uint256, address, uint64) external view {
        _notice();
    }
}
