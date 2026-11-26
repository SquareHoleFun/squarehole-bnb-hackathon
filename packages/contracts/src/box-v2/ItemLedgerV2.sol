// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {IItemLedgerV2} from "./interfaces/IItemLedgerV2.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverItemsV2, ItemFundingV2} from "./interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2, ItemLifecycleV2} from "./interfaces/IBoxVaultV2.sol";
import {BoxRolesV2} from "./interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";
import {CheckedBurn} from "./libraries/CheckedBurn.sol";
import {PricingToken} from "./libraries/PricingToken.sol";

interface IItemOwnerV2 {
    /// @notice Anyone reads the current owner from the fixed own collection; no funds move.
    function ownerOf(uint256 id) external view returns (address);
}

/// @notice Role 16 accounting: equal per-currency shares, anonymous reservations and bounded durable-history replay.
/// @dev Only current owners claim, without a minimum, tip, wallet-code restriction or expiry (F127).
/// S1's 206 packed bytes: coordinator/vault/collection/tickets/receiver/hook/P at 0/20/40/60/80/100/120;
/// buyer/seller policies at 140/141; legacy slots at 142/174 are unused. T appends mask/T at 206/207. No administrator or funding callback.
/// The authenticated receiver MUST transfer each receipt's backing atomically before publishing it. PM balance
/// is only a solvency check; neither gifts nor future receipts are inferred as funding. Unknown items have no
/// assigned credit; open-art shelf items are known from initialization. No operation enumerates items or tickets.
contract ItemLedgerV2 is IItemLedgerV2, IUnlockCallback, BoxCloneBase, TransientReentrancyGuard {
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

    /// @notice Owner-only T claim paid this amount; separate from the legacy P event in mixed boxes.
    event ItemPaidT(uint256 indexed id, address indexed owner, address indexed to, uint256 amountT);
    /// @notice Permissionless residue flush burned T, never paid a wallet.
    event ResidueTFlushed(uint256 amountT);

    IPoolManager internal immutable _pm;
    address private immutable _implementation;
    /// @notice Anyone reads the release's fixed coordinator implementation; no funds move.
    address public immutable coordinatorImplementation;
    /// @notice Anyone reads the cap for one complete PM owner payout; no funds move.
    /// @dev Twice the 1.3M cold linked-token allowance, including first eligible holder history.
    /// Strict Amsterdam T need is 1,291,832 gas including nested EIP-150; see SH-V21-02-PAY-IN-T.
    uint256 public constant CLAIM_GAS = 2_600_000;
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
    struct LedgerState {
        mapping(uint256 => Item) _items;
        mapping(bytes32 => Ticket) _tickets;
        uint256 _hidden;
        uint256 _hiddenStash;
        uint256 _baseUnassigned;
        uint256 _basePerItem;
        uint256 _residue;
        uint256 _liability;
        uint256 _n;
        uint256 _firstId;
        uint256 _inside;
        uint256 _outsideIndex;
        uint256 _keepIndex;
        uint256 _fundingCursor;
        uint256 _lifecycleCursor;
        uint8 _released;
        bool _initialShelf;
    }

    /// @notice Release deployer fixes the PM and coordinator implementation; no funds move.
    constructor(IPoolManager pm, address coordinatorImplementation_) {
        if (address(pm).code.length == 0 || coordinatorImplementation_.code.length == 0) revert InvalidWiring();
        _pm = pm;
        coordinatorImplementation = coordinatorImplementation_;
        _implementation = address(this);
    }

    /// @inheritdoc IItemLedgerV2
    function initialize() external nonReentrant {
        _initialize();
        if (_mask() != 0) { _mode(true); _initialize(); _clearMode(); }
    }
    function _initialize() private {
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(_argAddress(0));
        if (msg.sender != address(c) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert Unauthorized();
        }
        if (
            _s()._n != 0 || !BoxClones.isCloneOf(address(this), _implementation)
                || address(this).code.length != BoxClones.ARGS_OFFSET + (_mask() == 0 ? 206 : 227)
        ) revert InvalidWiring();
        (uint8 b, uint8 s) = insidePolicies();
        if (_mask() > 3 || (_mask() & 1 != 0 && b == 0) || (_mask() & 2 != 0 && s == 0)
            || (_mask() != 0 && _argAddress(207) != c.token())) revert InvalidWiring();
        IBoxVaultV2 v = IBoxVaultV2(_argAddress(20));
        if (
            b > 3 || s > 3 || b + s == 0 || c.roleAddress(BoxRolesV2.ROLE_ITEM_LEDGER) != address(this)
                || c.poolManager() != address(_pm) || c.vault() != address(v) || c.collection() != _argAddress(40)
                || c.tickets() != _argAddress(60) || c.receiver() != _argAddress(80) || c.hook() != _argAddress(100)
                || c.q() != _argAddress(120) || v.coordinator() != address(c) || v.collection() != _argAddress(40)
                || _argAddress(40).code.length == 0 || _argAddress(80).code.length == 0
                || _argAddress(100).code.length == 0 || c.graduated() || c.failed()
        ) revert InvalidWiring();
        _s()._n = v.collectionSize();
        _s()._firstId = v.firstId();
        if (_s()._n == 0 || _s()._n > type(uint32).max || _s()._firstId > type(uint256).max - (_s()._n - 1)) revert InvalidWiring();
        _s()._hidden = v.hiddenCount();
        _s()._inside = v.inside();
        // Initialization precedes custody. Open art starts entirely on the known shelf; hidden art has N slots.
        if (_s()._inside != _s()._n || (_s()._hidden != 0 && _s()._hidden != _s()._n)) revert InvalidWiring();
        _s()._initialShelf = _s()._hidden == 0;
    }

    /// @inheritdoc IItemLedgerV2
    function insidePolicies() public view returns (uint8 buyers, uint8 sellers) {
        return (uint8(_argUint(140, 1)), uint8(_argUint(141, 1)));
    }

    /// @inheritdoc IItemLedgerV2
    function fundingCursor() external view returns (uint256) {
        return _s()._fundingCursor;
    }

    /// @inheritdoc IItemLedgerV2
    function lifecycleCursor() external view returns (uint256) {
        return _s()._lifecycleCursor;
    }

    /// @inheritdoc IItemLedgerV2
    /// @dev Snapshots both targets at entry. Each loop consumes one record, at most k from each journal.
    /// Callback hints defer all replay, so even an unbounded backlog never makes custody depend on sync.
    function sync(uint256 k) external nonReentrant {
        _sync(k);
        if (_mask() != 0) { _mode(true); _sync(k); _clearMode(); }
    }
    function _sync(uint256 k) private {
        _initialized();
        _outsideUnlock();
        if (k == 0 || k > 32) revert InvalidPage();
        IBoxReceiverItemsV2 r = IBoxReceiverItemsV2(_argAddress(80));
        IBoxVaultItemsV2 v = IBoxVaultItemsV2(_argAddress(20));
        uint256 fEnd = r.itemFundingCount();
        uint256 lEnd = v.itemLifecycleCount();
        if (fEnd < _s()._fundingCursor || lEnd < _s()._lifecycleCursor) revert InvalidRecord();
        if (fEnd > _s()._fundingCursor) {
            IBoxCoordinatorV2 c = IBoxCoordinatorV2(_argAddress(0));
            if (!c.graduated() || c.failed()) revert InvalidRecord();
        }
        uint256 f;
        uint256 l;
        while (true) {
            if (l < k && _s()._lifecycleCursor < lEnd) {
                ItemLifecycleV2 memory op = v.itemLifecycle(_s()._lifecycleCursor + 1);
                if (op.fundingCursor < _s()._fundingCursor || op.fundingCursor > fEnd) revert InvalidRecord();
                if (op.fundingCursor == _s()._fundingCursor) {
                    _operation(op);
                    ++_s()._lifecycleCursor;
                    ++l;
                    continue;
                }
            }
            if (f < k && _s()._fundingCursor < fEnd) {
                ItemFundingV2 memory receipt = r.itemFunding(_s()._fundingCursor + 1);
                if (receipt.lifecycleCursor < _s()._lifecycleCursor || receipt.lifecycleCursor > lEnd) {
                    revert InvalidRecord();
                }
                if (receipt.lifecycleCursor == _s()._lifecycleCursor) {
                    _receipt(receipt);
                    ++_s()._fundingCursor;
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
        if (policy == 0 || r.insideCount != _s()._inside || r.hiddenCount != _s()._hidden) revert InvalidRecord();
        if (
            r.source < 1 || r.source > 3
                || (r.source == 1 ? r.batchId == 0 || r.batchId % 2 != r.side % 2 : r.batchId != 0)
        ) revert InvalidRecord();
        uint8 bit = r.side == 1 ? 1 : 2;
        if (r.source == 3) {
            if (_s()._released & bit != 0) revert InvalidRecord();
            _s()._released |= bit;
        } else if (_s()._released != (b == 0 ? 0 : 1) + (s == 0 ? 0 : 2)) {
            revert InvalidRecord();
        }
        if ((_mask() & (r.side == 1 ? 1 : 2) != 0) != _inT()) return;
        uint256 u = r.choiceP / _s()._n;
        uint256 expected = policy == 1 ? r.choiceP : r.source == 3 ? 0 : r.choiceP - _s()._inside * u;
        if (r.ledgerP != expected) revert UnbackedReceipt();
        _s()._liability += r.ledgerP;
        if (r.source == 3) {
            if (policy == 1) {
                _s()._basePerItem += u;
                _s()._baseUnassigned += _s()._n * u;
                _s()._residue += r.choiceP % _s()._n;
            }
        } else {
            _s()._outsideIndex += u;
            _s()._residue += r.choiceP % _s()._n;
            if (policy == 1) {
                _s()._keepIndex += u;
                _s()._hiddenStash += _s()._hidden * u;
            }
        }
    }

    function _slot() private returns (uint256 stash) {
        if (_s()._hidden == 0) revert InvalidRecord();
        stash = _s()._hiddenStash / _s()._hidden;
        _s()._hiddenStash -= stash;
        --_s()._hidden;
    }

    function _assign(Item storage a) private {
        if (a.known) revert InvalidRecord();
        a.known = true;
        _settleBase(a);
    }

    function _settleBase(Item storage a) private {
        // A fail-safe graduation poke may publish either side's base after custody assigned this item.
        // Materialize only the new base, independently of its inside/outside checkpoint and ownership.
        uint256 base = _s()._basePerItem - a.baseCheckpoint;
        if (base == 0) return;
        a.stash += base;
        _s()._baseUnassigned -= base;
        a.baseCheckpoint = _s()._basePerItem;
    }

    function _settle(Item storage a) internal {
        _settleBase(a);
        if (a.outside) a.outsideP += _s()._outsideIndex - a.checkpoint;
        else a.stash += _s()._keepIndex - a.checkpoint;
    }

    function _operation(ItemLifecycleV2 memory op) private {
        if (op.kind == 1 || op.kind == 3) {
            if (op.itemId != 0 || op.ticketKey == bytes32(0)) revert InvalidRecord();
            Ticket storage t = _s()._tickets[op.ticketKey];
            if (op.kind == 1) {
                if (t.used || _s()._inside == 0) revert InvalidRecord();
                t.used = true;
                t.open = true;
                t.start = _s()._outsideIndex;
                t.stash = _slot();
                --_s()._inside;
            } else {
                if (!t.open) revert InvalidRecord();
                _s()._residue += _s()._outsideIndex - t.start;
                _s()._hiddenStash += t.stash;
                ++_s()._hidden;
                ++_s()._inside;
                t.stash = 0;
                t.open = false;
            }
            return;
        }
        _validId(op.itemId);
        if (op.kind == 2 || op.kind == 4) {
            (uint8 b, uint8 s) = insidePolicies();
            if (_s()._released != (b == 0 ? 0 : 1) + (s == 0 ? 0 : 2)) {
                IBoxCoordinatorV2 c = IBoxCoordinatorV2(_argAddress(0));
                if (!c.graduated() && !c.failed()) revert InvalidRecord();
            }
        }
        Item storage a = _s()._items[op.itemId];
        if (op.kind == 2) {
            Ticket storage t = _s()._tickets[op.ticketKey];
            if (!t.open) revert InvalidRecord();
            _assign(a);
            a.stash += t.stash;
            a.outsideP += _s()._outsideIndex - t.start;
            a.outside = true;
            a.checkpoint = _s()._outsideIndex;
            t.stash = 0;
            t.open = false;
        } else {
            if (op.ticketKey != bytes32(0)) revert InvalidRecord();
            if (op.kind == 4) {
                if (a.outside || _s()._inside == 0) revert InvalidRecord();
                if (a.known) {
                    _settle(a);
                } else {
                    // An untouched open-art id has earned Keep since initialization, outside the hidden pool.
                    a.stash += _s()._initialShelf ? _s()._keepIndex : _slot();
                    _assign(a);
                }
                a.outside = true;
                a.checkpoint = _s()._outsideIndex;
                --_s()._inside;
            } else if (op.kind == 5) {
                if (!a.outside) revert InvalidRecord();
                _settle(a);
                a.outside = false;
                a.checkpoint = _s()._keepIndex;
                ++_s()._inside;
            } else if (op.kind != 6 || _s()._released != 0 || !IBoxCoordinatorV2(_argAddress(0)).failed()) {
                revert InvalidRecord();
            }
            // FailureRelease has no funded entitlement; the failed-box custody journal remains authoritative.
        }
    }

    /// @inheritdoc IItemLedgerV2
    function itemCredit(uint256 id) external view returns (uint256 outsideP, uint256 stashP) {
        return _credit(id, _state(false));
    }
    /// @notice Anyone reads this item's T credit; no money moves. Sync replays both journals first.
    function itemCreditT(uint256 id) external view returns (uint256 outsideT, uint256 stashT) {
        return _credit(id, _state(true));
    }
    function _credit(uint256 id, LedgerState storage state) private view returns (uint256 outsideP, uint256 stashP) {
        if (state._n == 0) revert NotInitialized();
        _validId(id);
        Item storage a = state._items[id];
        if (!a.known) return state._initialShelf ? (0, state._basePerItem + state._keepIndex) : (0, 0);
        outsideP = a.outsideP;
        stashP = a.stash + (state._basePerItem - a.baseCheckpoint);
        if (a.outside) outsideP += state._outsideIndex - a.checkpoint;
        else stashP += state._keepIndex - a.checkpoint;
    }

    /// @inheritdoc IItemLedgerV2
    function ticketCredit(bytes32 key) external view returns (uint256 start, uint256 p, bool open) {
        _initialized();
        Ticket storage t = _s()._tickets[key];
        return (t.start, t.open ? _s()._outsideIndex - t.start : 0, t.open);
    }

    /// @inheritdoc IItemLedgerV2
    function flushResidue() external nonReentrant returns (uint256 p) { return _flush(); }
    /// @notice Anyone burns resolved T residue; a refusal leaves it for retry.
    function flushResidueT() external nonReentrant returns (uint256 t) {
        _mode(true); t = _flush(); _clearMode();
    }
    function _flush() private returns (uint256 p) {
        _initialized();
        _outsideUnlock();
        _solvent();
        p = _s()._residue;
        if (_inT() && p > MAX_PART) p = MAX_PART;
        _s()._residue -= p;
        _s()._liability -= p;
        if (p != 0) {
            if (_inT()) {
                if (!_pay(address(this), p, C.BURN_GAS, PAYOUT_RESERVE_GAS, true)) revert PayoutFailed();
            } else if (!_pm.transfer(_argAddress(100), uint160(_asset()), p)) revert TransferFailed();
            if (_inT()) emit ResidueTFlushed(p); else emit ResidueFlushed(p);
        }
    }

    /// @inheritdoc IItemLedgerV2
    /// @dev Exactly one id. Prior sync must reach both entry cursors; no minimum, tip or expiry.
    /// Pays at most int128.max raw P per call; repeat to redeem the remainder that stays with the NFT.
    function claim(uint256[] calldata ids, address to) external nonReentrant returns (uint256 p) {
        return _claim(ids, to);
    }
    /// @notice Current NFT owner only claims T; a refusal restores all credit. No minimum, tip or expiry.
    function claimT(uint256[] calldata ids, address to) external nonReentrant returns (uint256 t) {
        _mode(true); t = _claim(ids, to); _clearMode();
    }
    function _claim(uint256[] calldata ids, address to) private returns (uint256 p) {
        address owner = _owner(ids);
        if (owner != msg.sender) revert Unauthorized();
        if (to == address(0) || to == _argAddress(20)) revert InvalidClaim();
        p = _take(ids[0]);
        if (!_pay(to, p, CLAIM_GAS, PAYOUT_RESERVE_GAS, false)) revert PayoutFailed();
        if (_inT()) emit ItemPaidT(ids[0], owner, to, p); else emit ItemPaid(ids[0], owner, to, p, 0);
    }

    function _owner(uint256[] calldata ids) private view returns (address owner) {
        _ready();
        if (ids.length != 1) revert InvalidClaim();
        _validId(ids[0]);
        owner = IItemOwnerV2(_argAddress(40)).ownerOf(ids[0]);
        if (owner == address(0) || owner == _argAddress(20)) revert InvalidClaim();
    }

    function _take(uint256 id) private returns (uint256 gross) {
        _solvent();
        Item storage a = _s()._items[id];
        if (!a.known || !a.outside) revert InvalidClaim();
        _settle(a);
        a.checkpoint = _s()._outsideIndex;
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
        _s()._liability -= gross;
    }

    function _pay(address to, uint256 amount, uint256 cap, uint256 reserve, bool burn) private returns (bool ok) {
        if (gasleft() < cap + cap / 63 + C.POKE_OVERHEAD_GAS + reserve) revert GasTooLow();
        bytes memory data = abi.encodeCall(IPoolManager.unlock, (abi.encode(to, amount, burn)));
        address pm = address(_pm);
        bytes32 slot = PAYOUT;
        // The trusted PM alone consumes the arm. Do not copy arbitrary token/recipient revert data.
        assembly ("memory-safe") {
            tstore(slot, 1)
            ok := call(cap, pm, 0, add(data, 32), mload(data), 0, 0)
            tstore(slot, 0)
        }
    }

    /// @notice Only the fixed PM during this ledger's once-armed guarded payout may redeem the selected P/T claims.
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
        (address to, uint256 amount, bool burn) = abi.decode(data, (address, uint256, bool));
        address p = _asset();
        uint256 beforePM = PricingToken.balanceOf(p, address(_pm));
        uint256 beforeTo = PricingToken.balanceOf(p, to);
        _pm.burn(address(this), uint160(p), amount);
        _pm.take(Currency.wrap(p), to, amount);
        if (beforePM - PricingToken.balanceOf(p, address(_pm)) != amount) revert PayoutFailed();
        // Native CALL transfers exact value; its recipient may legitimately spend it in receive().
        if (p != address(0) && PricingToken.balanceOf(p, to) - beforeTo != amount) revert PayoutFailed();
        if (burn) CheckedBurn.burn(p, amount);
        return "";
    }

    function _ready() internal view {
        _initialized();
        _outsideUnlock();
        if (
            _s()._fundingCursor != IBoxReceiverItemsV2(_argAddress(80)).itemFundingCount()
                || _s()._lifecycleCursor != IBoxVaultItemsV2(_argAddress(20)).itemLifecycleCount()
        ) {
            revert ItemSyncPending(_s()._fundingCursor, _s()._lifecycleCursor);
        }
    }

    function _initialized() private view {
        if (_s()._n == 0) revert NotInitialized();
    }

    function _validId(uint256 id) private view {
        if (id < _s()._firstId || id - _s()._firstId >= _s()._n) revert InvalidItem();
    }

    function _outsideUnlock() private view {
        if (_pm.isUnlocked()) revert ForeignUnlock();
    }

    function _solvent() private view {
        if (_pm.balanceOf(address(this), uint160(_asset())) < _s()._liability) revert UnbackedReceipt();
    }

    bytes32 private constant T_STATE = keccak256("squarehole.item.v21.token-state");
    bytes32 private constant MODE = keccak256("squarehole.item.v21.active-mode");
    function _mask() private view returns (uint256) { return _argUint(206, 1); }
    function _inT() private view returns (bool) {
        bytes32 slot = MODE; uint256 mode;
        assembly ("memory-safe") { mode := tload(slot) }
        return mode == 2;
    }
    function _mode(bool t) private { bytes32 slot = MODE; uint256 mode = t ? 2 : 1; assembly ("memory-safe") { tstore(slot, mode) } }
    function _clearMode() private { bytes32 slot = MODE; assembly ("memory-safe") { tstore(slot, 0) } }
    function _state(bool t) private pure returns (LedgerState storage state) {
        bytes32 slot = t ? T_STATE : bytes32(0);
        assembly ("memory-safe") { state.slot := slot }
    }
    function _s() private view returns (LedgerState storage) { return _state(_inT()); }
    function _asset() private view returns (address) { return _inT() ? _argAddress(207) : _argAddress(120); }
    /// @notice Anyone reads immutable side currency bits: bit 0 buyers T, bit 1 sellers T; no funds move.
    function tokenSides() external view returns (uint8) { return uint8(_mask()); }
    /// @notice Anyone reads the legacy claim entry's coin; P remains unchanged; claimT redeems T.
    function payoutAsset() external view returns (address) { return _argAddress(120); }

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
