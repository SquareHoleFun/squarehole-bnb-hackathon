// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types, FullMath; DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "./BoxCloneBase.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {BoxKind, VaultAction} from "./interfaces/BoxTypes.sol";
import {IBoxCollection} from "./interfaces/IBoxCollection.sol";
import {IBoxCoordinator, IBoxStreamBaseline} from "./interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "./interfaces/IBoxHook.sol";
import {IBoxItemStream, IBoxTransferObserver, IBoxVaultObserver} from "./interfaces/IBoxItemStream.sol";
import {IBoxReceiver, IBoxStreamSettlement} from "./interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "./interfaces/IBoxTickets.sol";
import {IBoxTicketsInFlight} from "./interfaces/IBoxTicketsInFlight.sol";
import {IBoxToken} from "./interfaces/IBoxToken.sol";
import {IBoxVault} from "./interfaces/IBoxVault.sol";
import {BoxCloneArgs as A} from "./libraries/BoxCloneArgs.sol";
import {BoxClones} from "./libraries/BoxClones.sol";
import {BoxShuffle} from "./libraries/BoxShuffle.sol";

/// @title BoxItemStream (slice S8, add-on 2 `per-item-stream`; the implementation behind every stream clone)
/// @notice See `IBoxItemStream` for the behaviour. The production form of SH-S0-spikes § 3's lean checkpoint
/// (test/spikes/SpikeItemStream.sol `SpikeItemStreamLean`) under D2, F72 (B), F77 and G07 point 4:
///
/// - **The value X and the index J.** X = F + 13·⌊(U + R)/15⌋ (BoxSpecV1 BOX0_FEE_SHARE_T_BURN over
///   FEE_SHARE_DENOMINATOR): F = this contract's T balance + what it paid out + what it burned; U = the T fees box 0's
///   four positions earned and nobody collected (each L·(feeGrowthInside − feeGrowthInsideLast)/2^128, v4's own
///   formula, from one `extsload` of the pool: slot0, the T fee growth, four ticks, four positions); R = the
///   receiver's T claims (after the settlement, box 0's receiver books no T ledger, so these are its next batch plus
///   its carry). A swap raises U; `harvest()` and `deepen()`'s poke move U into R exactly; `collect()` turns R into
///   13·⌊R/15⌋ T sent here plus a carry < 15 and the 2/15 for depth: X never falls and never jumps except by a swap
///   (by 13/15 of its fee, to one fifteenth) or a gift. J = ⌊(X − X₀)/N⌋, X₀ recorded at graduation independently of the stream's call (F126).
///   Before settlement, R excludes the receiver's held curve-depth claims; those move away at settlement. Liquidity changes need no hook point: v4 settles a position's fees before its liquidity
///   changes, and the pair's add (`deepen`) pokes it first.
/// - **Records.** Per item: its owner as last checkpointed and J then (`_items`: owner ≪ 96 | J; zero while inside).
///   Per account: T booked and not paid (`_owed`). Per draw ticket: J at its request (`_drawJ`). Global, each written
///   non-zero at `initialize`: m and the J at its last change with Σ m·ΔJ (`_book`), the open tickets (`_tix`), lifetime
///   claimed and burned (`_out`).
/// - **Checkpoints.** A transfer between holders books J − J_since to the recorded owner (`CheckpointRepaired` when the
///   collection names another, a missed call) and records the new holder at J. A vault action rebooks m before n
///   changes (STREAM HOOK) and sets m = N − n afterwards from the vault's own count. An item leaving the vault starts at
///   the J of its exit: a named pick's or a take-by-number's (marked in transient storage by the vault call of the same
///   transaction), a placeholder's from the start (J 0: its share since graduation passes to the Misfit, G07 point 4),
///   a draw's from its own request (its ticket's J at request, `_drawJ`, found by the ticket the tickets add-on names
///   in flight, `IBoxTicketsInFlight`; R1 of the architecture review of 2026-10-07: exact for any number of open
///   draws, in any order). A draw's cancel in terminal mode books its accrual since its own request the same way. An
///   item coming back books its holder and clears its record.
/// - **Burns and claims.** The T held beyond the owners' accrual not yet paid (Σ m·ΔJ to now, less what was claimed,
///   plus one raw unit per outside slot once started) is the items-inside share (and whatever arrived before the start:
///   the curve's T side, burned as G07 point 4 says) and is burned in `onStreamFunds`, `burn` and the start; a burn the
///   vault's floor refuses waits. Under D2 the amount is exact and the timing follows the batches. A claim pays what
///   the owner was booked, up to the T held, keeping 1 raw unit booked so an owner's slot never returns to zero
///   (box-factory § 2.2).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2). Box 0 only (its receiver's kind, native-ETH Q, T as
/// currency1, as the core v1 hook assumes). Observers take no lock and make only view calls; `onGraduation` calls the
/// receiver's settlement before it takes the lock (the settlement's notice re-enters `onStreamFunds`).
contract BoxItemStream is IBoxItemStream, BoxCloneBase, TransientReentrancyGuard {
    /// @notice T's `transfer` answered false (BoxToken never does: it reverts or returns true).
    error TransferFailed();

    uint256 private constant _Q128 = 1 << 128;
    uint256 private constant _M32 = (1 << 32) - 1;
    uint256 private constant _M96 = (1 << 96) - 1;
    uint256 private constant _M120 = (1 << 120) - 1;
    uint256 private constant _M127 = (1 << 127) - 1;
    uint256 private constant _M128 = (1 << 128) - 1;
    uint256 private constant _MARK = 1 << 255;
    uint256 private constant _B_INIT = 1;
    uint256 private constant _B_STARTED = 2;
    uint256 private constant _B_BASELINE = 4;

    /// @dev PoolManager storage (v4-core @ 46c68346; `forge inspect PoolManager storageLayout`: `balanceOf` slot 4,
    /// `_pools` slot 6; StateLibrary's offsets inside Pool.State, Tick.Info and Position.State).
    uint256 private constant _PM_BALANCES_SLOT = 4;
    uint256 private constant _PM_POOLS_SLOT = 6;
    uint256 private constant _FEE_GROWTH_GLOBAL1_OFFSET = 2;
    uint256 private constant _TICKS_OFFSET = 4;
    uint256 private constant _POSITIONS_OFFSET = 6;
    uint256 private constant _OUTSIDE1_OFFSET = 2;
    uint256 private constant _INSIDE1_LAST_OFFSET = 2;
    /// @dev The hook's salts (BoxHookBase `_SALT_L7`, `_SALT_PAIR`).
    bytes32 private constant _SALT_L7 = bytes32(uint256(1));
    bytes32 private constant _SALT_PAIR = bytes32(uint256(3));

    /// @dev Transient: the J and count of items a vault call of this transaction lets out at once (a named pick or a
    /// take by number): (J ≪ 32) | count. `uint256(keccak256("squarehole.stream.exits")) - 1`.
    uint256 private constant _EXITS = 0x9ef113852a8e14cfd94eaa0511bb2c8b5ad7e42339ec2988c1197580b6d3dead;

    IPoolManager internal immutable _pm;
    /// @inheritdoc IBoxItemStream
    address public immutable coordinatorImplementation;

    /// @dev Bit 0 initialised, bit 1 started, bit 2 baseline cached; bits 128-255 hold pre-graduation burns, then X₀.
    uint256 private _s;
    /// @dev Bits 0-31 m, 32-127 J at m's last change, 128-254 Σ m·ΔJ, bit 255 set.
    uint256 private _book;
    /// @dev Bits 0-31 open placeholders, 32-63 open draws, 64-191 Σ J at the open draws' requests, bit 255 set.
    uint256 private _tix;
    /// @dev Bits 0-119 claimed, 120-239 burned, bit 255 set.
    uint256 private _out;
    /// @dev Item id → (owner ≪ 96) | J at its last checkpoint; zero while inside or never seen.
    mapping(uint256 => uint256) private _items;
    mapping(address => uint256) private _owed;
    /// @dev Draw ticket id → _MARK | J at its request (R1): written when the vault reports the request, read at the
    /// ticket's opening or cancel. Never cleared: BoxTickets puts each ticket in flight at most once (an opening and a
    /// cancel are both final), and a delete would cost the observer paths their 2x headroom.
    mapping(uint256 => uint256) private _drawJ;

    constructor(IPoolManager poolManager_, address coordinatorImplementation_) {
        _pm = poolManager_;
        coordinatorImplementation = coordinatorImplementation_;
    }

    // ================================================================== lifecycle

    /// @inheritdoc IBoxItemStream
    function initialize() external {
        address c = _argAddress(A.S_COORDINATOR);
        if (msg.sender != c || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (_s != 0) revert AlreadyInitialised();
        _checkWiring(c);
        _s = _B_INIT;
        _book = _MARK;
        _tix = _MARK;
        _out = _MARK;
    }

    /// @inheritdoc IBoxItemStream
    function onGraduation() external {
        uint256 s = _s;
        if (s & _B_INIT == 0) revert NotInitialised();
        if (s & _B_STARTED != 0) revert AlreadyStarted();
        if (!IBoxCoordinator(_argAddress(A.S_COORDINATOR)).graduated()) revert NotGraduated();
        IBoxReceiver r = IBoxReceiver(_argAddress(A.S_RECEIVER));
        // The settlement splits the curve's last fees: its notice re-enters onStreamFunds (no lock is held yet), which
        // reserves earnings using the recorded graduation baseline even before startup succeeds.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        if (!r.graduationSettled()) r.onGraduation();
        _start();
    }

    /// @inheritdoc IBoxItemStream
    function onStreamFunds(uint256 amount) external nonReentrant {
        if (msg.sender != _argAddress(A.S_RECEIVER)) revert NotReceiver(msg.sender);
        uint256 s = _s;
        if (s & (_B_INIT | _B_BASELINE) != (_B_INIT | _B_BASELINE)) {
            if (s & _B_INIT == 0) revert NotInitialised();
            _cacheBaseline();
        }
        emit Funded(amount);
        _burnSurplus(_index(), s & _B_BASELINE != 0 || _graduated());
    }

    /// @inheritdoc IBoxItemStream
    function burn() external nonReentrant returns (uint256) {
        if (_s & _B_INIT == 0) revert NotInitialised();
        return _burnSurplus(_index(), _s & _B_BASELINE != 0 || _graduated());
    }

    // ================================================================== observers (capped, fail-safe callers)

    /// @inheritdoc IBoxTransferObserver
    function onItemTransfer(address from, address to, uint256 id) external {
        if (msg.sender != _argAddress(A.S_COLLECTION)) revert NotCollection(msg.sender);
        if (_s & _B_INIT == 0) revert NotInitialised();
        address v = _argAddress(A.S_VAULT);
        if (from == v) {
            // A delivery or a named pick: n changed already (its vault call), so only the record starts here.
            _items[id] = _record(to, _exitSince(id));
            return;
        }
        uint256 j = _index();
        uint256 rec = _items[id];
        if (rec == 0) emit CheckpointRepaired(id, address(0), from);
        else _credit(rec, from, id, j);
        if (to == v) delete _items[id]; // a return: inside again, from the n change its vault call booked
        else _items[id] = _record(to, j);
    }

    /// @inheritdoc IBoxVaultObserver
    function onVaultAction(VaultAction action, address account, uint256 count, uint256 insideBefore) external {
        address v = _argAddress(A.S_VAULT);
        if (msg.sender != v) revert NotVault(msg.sender);
        if (_s & _B_INIT == 0) revert NotInitialised();
        uint256 j = _index();
        bool leaves = action == VaultAction.TicketsOpened || action == VaultAction.Withdrawn;
        uint256 insideAfter = leaves ? insideBefore - count : insideBefore + count;
        _rebook(j, _n() - insideAfter);
        if (action == VaultAction.Withdrawn) {
            _markExits(count, j);
        } else if (action == VaultAction.TicketsOpened) {
            _ticketsOpened(v, count, j);
        } else if (action == VaultAction.TicketsReleased) {
            _ticketsReleased(v, account, count, j);
        }
        // Returned: each item books its holder when it comes back (onItemTransfer to the vault), in this transaction.
    }

    // ================================================================== claims

    /// @inheritdoc IBoxItemStream
    function claim(uint256[] calldata ids, address to) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return _claim(msg.sender, ids, to);
    }

    /// @inheritdoc IBoxItemStream
    function claimFor(address account, uint256[] calldata ids) external nonReentrant returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _claim(account, ids, account);
    }

    // ================================================================== views

    /// @inheritdoc IBoxItemStream
    function index() external view returns (uint256) {
        return _index();
    }

    /// @inheritdoc IBoxItemStream
    function streamValue() external view returns (uint256) {
        return _value(_s);
    }

    /// @inheritdoc IBoxItemStream
    function pendingOf(uint256 id) external view returns (address owner, uint256 amount) {
        uint256 rec = _items[id];
        if (rec == 0) return (address(0), 0);
        // casting to 'uint160' is safe because a record keeps the owner in its top 160 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        owner = address(uint160(rec >> 96));
        uint256 j = _index();
        uint256 since = rec & _M96;
        amount = j > since ? j - since : 0;
    }

    /// @inheritdoc IBoxItemStream
    function owedOf(address account) external view returns (uint256) {
        return _owed[account];
    }

    /// @inheritdoc IBoxItemStream
    function liabilities() public view returns (uint256) {
        uint256 accrued = _accrued(_index());
        uint256 claimed = _out & _M120;
        return accrued > claimed ? accrued - claimed : 0;
    }

    /// @inheritdoc IBoxItemStream
    function outsideCount() external view returns (uint256) {
        return _book & _M32;
    }

    /// @inheritdoc IBoxItemStream
    function openTickets() external view returns (uint256 placeholders, uint256 draws, uint256 drawIndexSum) {
        uint256 t = _tix;
        return (t & _M32, (t >> 32) & _M32, (t >> 64) & _M128);
    }

    /// @inheritdoc IBoxItemStream
    function started() external view returns (bool) {
        return _s & _B_STARTED != 0;
    }

    /// @inheritdoc IBoxItemStream
    function startValue() external view returns (uint256) {
        return _s & _B_STARTED != 0 ? _s >> 128 : 0;
    }

    /// @inheritdoc IBoxItemStream
    function totals() external view returns (uint256 claimed, uint256 burned) {
        uint256 o = _out;
        return (o & _M120, (o >> 120) & _M120);
    }

    /// @inheritdoc IBoxItemStream
    function coordinator() external view returns (address) {
        return _argAddress(A.S_COORDINATOR);
    }

    /// @inheritdoc IBoxItemStream
    function poolManager() external view returns (address) {
        return address(_pm);
    }

    /// @inheritdoc IBoxItemStream
    function token() external view returns (address) {
        return _argAddress(A.S_TOKEN);
    }

    /// @inheritdoc IBoxItemStream
    function collection() external view returns (address) {
        return _argAddress(A.S_COLLECTION);
    }

    /// @inheritdoc IBoxItemStream
    function vault() external view returns (address) {
        return _argAddress(A.S_VAULT);
    }

    /// @inheritdoc IBoxItemStream
    function tickets() external view returns (address) {
        return _argAddress(A.S_TICKETS);
    }

    /// @inheritdoc IBoxItemStream
    function receiver() external view returns (address) {
        return _argAddress(A.S_RECEIVER);
    }

    /// @inheritdoc IBoxItemStream
    function hook() external view returns (address) {
        return _argAddress(A.S_HOOK);
    }

    /// @inheritdoc IBoxItemStream
    function collectionSize() external view returns (uint256) {
        return _n();
    }

    /// @inheritdoc IBoxItemStream
    function firstId() external view returns (uint256) {
        return uint256(_argWord(A.S_FIRST_ID));
    }

    // ================================================================== internals: the index

    /// @dev Accrual begins at graduation even if startup failed. Observers and burns must use that same J meanwhile.
    function _index() internal view returns (uint256) {
        uint256 s = _s;
        uint256 x0;
        if (s & _B_BASELINE != 0) x0 = s >> 128;
        else {
            if (s & _B_INIT == 0) return 0;
            if (!IBoxCoordinator(_argAddress(A.S_COORDINATOR)).graduated()) return 0;
            x0 = _graduationValue();
        }
        uint256 x = _value(s);
        return x > x0 ? (x - x0) / _n() : 0;
    }

    function _graduated() private view returns (bool) {
        return IBoxCoordinator(_argAddress(A.S_COORDINATOR)).graduated();
    }

    /// @dev The receiver's notice runs after settlement, even if the later startup poke fails. Cache X₀ in the
    /// existing non-zero word so delayed-start callbacks retain their normal headroom. This does not mark started.
    function _cacheBaseline() private {
        if (!IBoxCoordinator(_argAddress(A.S_COORDINATOR)).graduated()) return;
        if (!IBoxReceiver(_argAddress(A.S_RECEIVER)).graduationSettled()) return;
        _s = _B_INIT | _B_BASELINE | (_graduationValue() << 128);
    }

    /// @dev Migration harvested all positions. The coordinator independently saved held T and gross receiver claims;
    /// curve-depth claims never belonged to this stream. Pre-graduation burns complete F in the recorded X₀.
    function _graduationValue() private view returns (uint256) {
        IBoxStreamBaseline c = IBoxStreamBaseline(_argAddress(A.S_COORDINATOR));
        uint256 claims = c.streamStartClaims() - IBoxStreamSettlement(_argAddress(A.S_RECEIVER)).streamCurveDepthT();
        // forge-lint: disable-next-line(divide-before-multiply)
        return (_s >> 128) + c.streamStartBalance()
            + BoxSpecV1.BOX0_FEE_SHARE_T_BURN * (claims / BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// @dev X = F + 13·⌊(U + R)/15⌋.
    function _value(uint256 s) internal view returns (uint256) {
        uint256 o = _out;
        uint256 f = IBoxToken(_argAddress(A.S_TOKEN)).balanceOf(address(this)) + (o & _M120) + ((o >> 120) & _M120);
        uint256 pending = _pendingT();
        if (s & _B_BASELINE == 0) {
            IBoxReceiver r = IBoxReceiver(_argAddress(A.S_RECEIVER));
            if (!r.graduationSettled()) pending -= IBoxStreamSettlement(address(r)).streamCurveDepthT();
        }
        // forge-lint: disable-next-line(divide-before-multiply)
        return f + BoxSpecV1.BOX0_FEE_SHARE_T_BURN * (pending / BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// @dev U + R: the T fees box 0's positions hold uncollected plus the receiver's T claims, from one `extsload`.
    /// Slots: slot0, the T fee growth, the T fee growth outside the ticks MIN, P1, P0 and MAX, then (liquidity,
    /// feeGrowthInside1Last) of the ask [MIN, P1], the bid [P1, MAX], the sentinel [P0, MAX] and the pair [MIN, MAX],
    /// then the receiver's T claims. A position that does not exist reads liquidity 0 and adds nothing.
    function _pendingT() internal view virtual returns (uint256 pending) {
        bytes32 state = keccak256(abi.encodePacked(_poolId(), bytes32(_PM_POOLS_SLOT)));
        int24[4] memory t = [BoxSpecV1.MIN_USABLE_TICK, _tickLower(), _tickUpper(), BoxSpecV1.MAX_USABLE_TICK];
        bytes32[] memory slots = new bytes32[](15);
        slots[0] = state;
        slots[1] = bytes32(uint256(state) + _FEE_GROWTH_GLOBAL1_OFFSET);
        bytes32 ticks = bytes32(uint256(state) + _TICKS_OFFSET);
        for (uint256 i; i < 4; ++i) {
            slots[2 + i] = bytes32(uint256(keccak256(abi.encodePacked(int256(t[i]), ticks))) + _OUTSIDE1_OFFSET);
        }
        bytes32 positions = bytes32(uint256(state) + _POSITIONS_OFFSET);
        address h = _argAddress(A.S_HOOK);
        _positionSlots(slots, 6, positions, h, t[0], t[1], _SALT_L7); // ask
        _positionSlots(slots, 8, positions, h, t[1], t[3], _SALT_L7); // bid
        _positionSlots(slots, 10, positions, h, t[2], t[3], _SALT_L7); // sentinel
        _positionSlots(slots, 12, positions, h, t[0], t[3], _SALT_PAIR); // pair
        slots[14] = keccak256(
            abi.encode(
                uint256(uint160(_argAddress(A.S_TOKEN))),
                keccak256(abi.encode(_argAddress(A.S_RECEIVER), uint256(_PM_BALANCES_SLOT)))
            )
        );
        bytes32[] memory v = _pm.extsload(slots);
        int24 tick = Slot0.wrap(v[0]).tick();
        uint256 g = uint256(v[1]);
        pending = uint256(v[14]);
        pending += _owedFees(tick, g, [t[0], t[1]], v[2], v[3], v[6], v[7]);
        pending += _owedFees(tick, g, [t[1], t[3]], v[3], v[5], v[8], v[9]);
        pending += _owedFees(tick, g, [t[2], t[3]], v[4], v[5], v[10], v[11]);
        pending += _owedFees(tick, g, [t[0], t[3]], v[2], v[5], v[12], v[13]);
    }

    /// @dev The two slots (liquidity, feeGrowthInside1LastX128) of the hook's position (lower, upper, salt) at `i`.
    function _positionSlots(
        bytes32[] memory slots,
        uint256 i,
        bytes32 positions,
        address owner,
        int24 lower,
        int24 upper,
        bytes32 salt
    ) private pure {
        bytes32 key = keccak256(abi.encodePacked(owner, lower, upper, salt));
        bytes32 p = keccak256(abi.encodePacked(key, positions));
        slots[i] = p;
        slots[i + 1] = bytes32(uint256(p) + _INSIDE1_LAST_OFFSET);
    }

    /// @dev One position's uncollected T fees: v4's Pool.getFeeGrowthInside and Position.update, unchecked as there.
    function _owedFees(
        int24 tick,
        uint256 g,
        int24[2] memory range,
        bytes32 outLower,
        bytes32 outUpper,
        bytes32 liquidityWord,
        bytes32 lastWord
    ) private pure returns (uint256) {
        uint256 l = uint256(liquidityWord) & _M128;
        if (l == 0) return 0;
        uint256 inside;
        unchecked {
            if (tick < range[0]) inside = uint256(outLower) - uint256(outUpper);
            else if (tick >= range[1]) inside = uint256(outUpper) - uint256(outLower);
            else inside = g - uint256(outLower) - uint256(outUpper);
            return FullMath.mulDiv(inside - uint256(lastWord), l, _Q128);
        }
    }

    /// @dev Box 0's pool id: (native ETH, T, LP_FEE, TICK_SPACING, the hook).
    function _poolId() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(0), _argAddress(A.S_TOKEN), BoxSpecV1.LP_FEE, BoxSpecV1.TICK_SPACING, _argAddress(A.S_HOOK)
            )
        );
    }

    // ================================================================== internals: books

    /// @dev Σ m·ΔJ to `j`: every slot's accrual, booked or not.
    function _accrued(uint256 j) private view returns (uint256) {
        uint256 b = _book;
        uint256 jm = (b >> 32) & _M96;
        return ((b >> 128) & _M127) + (j > jm ? (b & _M32) * (j - jm) : 0);
    }

    /// @dev Before n changes: books Σ m·ΔJ to `j`, then m = `outsideAfter`.
    function _rebook(uint256 j, uint256 outsideAfter) private {
        uint256 b = _book;
        uint256 jm = (b >> 32) & _M96;
        uint256 booked = ((b >> 128) & _M127) + (j > jm ? (b & _M32) * (j - jm) : 0);
        if (j < jm) j = jm;
        _book = _MARK | (booked << 128) | (j << 32) | outsideAfter;
    }

    /// @dev Books `rec`'s accrual since its checkpoint to the owner it records (a missed call when `actual` differs).
    function _credit(uint256 rec, address actual, uint256 id, uint256 j) private {
        // casting to 'uint160' is safe because a record keeps the owner in its top 160 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        address owner = address(uint160(rec >> 96));
        if (owner != actual) emit CheckpointRepaired(id, owner, actual);
        uint256 since = rec & _M96;
        if (j <= since) return;
        uint256 amount = j - since;
        _owed[owner] += amount;
        emit Credited(owner, id, amount);
    }

    function _record(address owner, uint256 j) private pure returns (uint256) {
        // J < 2^96: X − X₀ would need N·2^96 raw T (1.56·10^14 FIT, 156,000 issuances, at N 1,969; 3.38·10^14 FIT
        // at N 4,269; box 0's own review W2-U5-2).
        return (uint256(uint160(owner)) << 96) | (j & _M96);
    }

    // ================================================================== internals: exits and tickets

    function _markExits(uint256 count, uint256 j) private {
        uint256 mark = (j << 32) | count;
        assembly ("memory-safe") {
            tstore(_EXITS, mark)
        }
    }

    /// @dev Where an item leaving the vault starts: a marked exit's J, else its ticket's (placeholder or draw).
    function _exitSince(uint256 id) private returns (uint256) {
        uint256 mark;
        assembly ("memory-safe") {
            mark := tload(_EXITS)
        }
        uint256 count = mark & _M32;
        if (count != 0) {
            uint256 next = count == 1 ? 0 : mark - 1;
            assembly ("memory-safe") {
                tstore(_EXITS, next)
            }
            return mark >> 32;
        }
        return _ticketSince(id);
    }

    /// @dev A ticket's item: a draw's starts at the J of its own request (the ticket the tickets add-on names in flight;
    /// R1), a placeholder's at the start (J 0, G07 point 4). An item no open ticket explains, or a draw whose request this
    /// stream did not see, starts now.
    function _ticketSince(uint256 id) private returns (uint256 since) {
        uint256 ticket = _ticketInFlight();
        if (ticket != 0) {
            uint256 r = _takeDraw(ticket);
            return r != 0 ? r ^ _MARK : _index();
        }
        if (!_isPlaceholderItem(id)) return _index();
        uint256 t = _tix;
        if (t & _M32 != 0) _tix = t - 1; // one open placeholder fewer
    }

    /// @dev The draw ticket the tickets add-on is opening or cancelling in this call (`IBoxTicketsInFlight`), 0 if none.
    function _ticketInFlight() private view returns (uint256) {
        address tk = _argAddress(A.S_TICKETS);
        return tk == address(0) ? 0 : IBoxTicketsInFlight(tk).ticketInFlight();
    }

    /// @dev Takes draw `ticket` off the open draws and returns its record, `_MARK | J` at its request; 0 when this stream
    /// never saw its request (the vault's capped call failed), which the open draws' count and J sum never held.
    function _takeDraw(uint256 ticket) private returns (uint256 r) {
        r = _drawJ[ticket];
        if (r == 0) return 0;
        uint256 t = _tix;
        uint256 d = (t >> 32) & _M32;
        uint256 sum = (t >> 64) & _M128;
        _tix = _MARK | ((sum - (r ^ _MARK)) << 64) | ((d - 1) << 32) | (t & _M32);
    }

    /// @dev Whether `id` is a placeholder's item: its position in the graduation word's shuffle is below q
    /// (BoxTickets `_numberPosition`). No word, no placeholders or no tickets add-on: not one.
    function _isPlaceholderItem(uint256 id) private view returns (bool) {
        address tk = _argAddress(A.S_TICKETS);
        if (tk == address(0)) return false;
        uint256 q = IBoxTickets(tk).status().slots;
        if (q == 0) return false;
        bytes32 w = IBoxTickets(tk).graduationWord();
        if (w == bytes32(0)) return false;
        uint256 n = _n();
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return BoxShuffle.invert(w, id - uint256(_argWord(A.S_FIRST_ID)), n, u, v) < q;
    }

    /// @dev Tickets taken: placeholders on the curve (gate closed); after graduation a draw request (its J kept for its
    /// ticket), or in terminal mode a take by number, delivered in this same transaction (marked as an exit at J).
    function _ticketsOpened(address v, uint256 count, uint256 j) private {
        uint256 t = _tix;
        if (IBoxVault(v).gateOpenedAt() == 0) {
            _tix = t + count;
            return;
        }
        IBoxTickets.TicketState memory s = IBoxTickets(_argAddress(A.S_TICKETS)).status();
        if (s.terminalAt != 0) {
            _markExits(count, j);
        } else {
            // A draw (one ticket): BoxTickets numbers it before its call to the vault (`++drawsRequested`, then
            // `_lock`), so `drawsRequested` is its id here.
            _tix = t + (count << 32) + ((count * j) << 64);
            _drawJ[s.drawsRequested] = _MARK | j;
        }
    }

    /// @dev Tickets released: hand-backs on the curve (nothing accrued yet); after graduation (terminal mode only) a
    /// draw's cancel, the ticket the tickets add-on names in flight (its accrual since its own request; nothing for a
    /// request this stream did not see), or else placeholders handed back (accrual since the start), booked to the
    /// account the vault pays.
    function _ticketsReleased(address v, address account, uint256 count, uint256 j) private {
        uint256 t = _tix;
        uint256 p = t & _M32;
        if (IBoxVault(v).gateOpenedAt() == 0) {
            _tix = t - (p > count ? count : p);
            return;
        }
        uint256 amount = count * j;
        uint256 ticket = _ticketInFlight();
        if (ticket != 0) {
            // A draw's cancel, from its own request. One whose request this stream did not see has no record: `since`
            // is then _MARK, above any J, so it books nothing.
            uint256 since = _takeDraw(ticket) ^ _MARK;
            amount = j > since ? j - since : 0;
        } else {
            _tix = t - (p > count ? count : p);
        }
        if (amount != 0) {
            _owed[account] += amount;
            emit TicketsCredited(account, count, amount);
        }
    }

    // ================================================================== internals: payouts

    function _start() private nonReentrant {
        uint256 x0 = _s & _B_BASELINE != 0 ? _s >> 128 : _graduationValue();
        _s = _B_INIT | _B_STARTED | _B_BASELINE | (x0 << 128);
        emit Started(x0);
        // A delayed start burns only surplus: every owner's accrual since graduation remains reserved.
        _burnSurplus(_index(), true);
    }

    /// @dev Burns the T held beyond the owners' accrual not yet claimed, less one raw unit per slot outside once started
    /// (J is floored, so each outside slot may be owed up to one more raw unit than J books yet). Keeping m back (m the
    /// outside count at the burn) covers the slots outside then; a slot that leaves the vault later has no margin
    /// behind it, so a later full collect may leave owners short by up to N − 1 − m raw units, which the next batch
    /// covers (box 0's own review W2-U5-1, F147). A burn must lower supply, else the T waits.
    function _burnSurplus(uint256 j, bool graduated) private returns (uint256 amount) {
        uint256 o = _out;
        uint256 accrued = _accrued(j);
        uint256 claimed = o & _M120;
        uint256 margin = graduated ? _book & _M32 : 0;
        uint256 owners = (accrued > claimed ? accrued - claimed : 0) + margin;
        IBoxToken t = IBoxToken(_argAddress(A.S_TOKEN));
        uint256 held = t.balanceOf(address(this));
        if (held <= owners) return 0;
        amount = held - owners;
        uint256 supply = t.totalSupply();
        // T is the box's own token (its burn only asks the vault's floor, a view): `_out` follows the burn it records.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        try t.burn(amount) {
            if (t.totalSupply() + amount != supply) revert BurnDidNotReduceSupply();
            _out = o + (amount << 120);
            if (!graduated) _s += amount << 128;
            emit Burned(amount);
        } catch {
            emit BurnRefused(amount);
            amount = 0;
        }
    }

    function _claim(address account, uint256[] calldata ids, address to) private returns (uint256 paid) {
        if (_s & _B_INIT == 0) revert NotInitialised();
        if (account == address(this) || to == address(this)) revert SelfClaim();
        if (ids.length != 0) {
            address v = _argAddress(A.S_VAULT);
            if (account == v) revert NotOwner(ids[0], account);
            IBoxCollection col = IBoxCollection(_argAddress(A.S_COLLECTION));
            uint256 j = _index();
            for (uint256 i; i < ids.length; ++i) {
                uint256 id = ids[i];
                if (col.ownerOf(id) != account) revert NotOwner(id, account);
                uint256 rec = _items[id];
                if (rec == 0) emit CheckpointRepaired(id, address(0), account);
                else _credit(rec, account, id, j);
                _items[id] = _record(account, j);
            }
        }
        uint256 owed = _owed[account];
        if (owed < 2) return 0;
        IBoxToken t = IBoxToken(_argAddress(A.S_TOKEN));
        uint256 held = t.balanceOf(address(this));
        paid = owed - 1 < held ? owed - 1 : held;
        if (paid == 0) return 0;
        _owed[account] = owed - paid;
        _out += paid;
        if (!t.transfer(to, paid)) revert TransferFailed();
        emit Claimed(account, to, paid);
    }

    // ================================================================== internals: wiring

    function _n() private view returns (uint256) {
        return _argUint(A.S_COLLECTION_SIZE, 4);
    }

    function _tickLower() private view returns (int24) {
        // casting to 'int24' is safe because the argument is three bytes, two's complement
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(uint24(_argUint(A.S_TICK_LOWER, 3)));
    }

    function _tickUpper() private view returns (int24) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(uint24(_argUint(A.S_TICK_UPPER, 3)));
    }

    /// @dev Every contract it reads names this stream, box 0 and the arguments' values (the factory's wiring, checked
    /// once at creation; a mismatch names its check).
    function _checkWiring(address c) private view {
        address t = _argAddress(A.S_TOKEN);
        address col = _argAddress(A.S_COLLECTION);
        address v = _argAddress(A.S_VAULT);
        address h = _argAddress(A.S_HOOK);
        IBoxReceiver r = IBoxReceiver(_argAddress(A.S_RECEIVER));
        if (r.itemStream() != address(this) || r.kind() != BoxKind.Box0) revert WiringMismatch(1);
        if (r.token() != t || r.hook() != h || r.coordinator() != c || r.q() != address(0)) revert WiringMismatch(2);
        if (IBoxCollection(col).transferObserver() != address(this) || IBoxCollection(col).vault() != v) {
            revert WiringMismatch(3);
        }
        IBoxVault vt = IBoxVault(v);
        if (vt.observer() != address(this) || vt.collection() != col || vt.token() != t) revert WiringMismatch(4);
        if (vt.ticketAdapter() != _argAddress(A.S_TICKETS)) revert WiringMismatch(5);
        if (vt.collectionSize() != _n() || vt.firstId() != uint256(_argWord(A.S_FIRST_ID))) revert WiringMismatch(6);
        // forge-lint: disable-next-line(unused-return)
        (int24 lower, int24 upper,) = IBoxHook(h).curve();
        if (lower != _tickLower() || upper != _tickUpper() || address(IBoxHook(h).poolManager()) != address(_pm)) {
            revert WiringMismatch(7);
        }
    }
}
