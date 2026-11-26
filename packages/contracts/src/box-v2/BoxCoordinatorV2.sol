// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT interfaces and types only (DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CoordinatorViews} from "./libraries/CoordinatorViews.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IBoxVaultV2} from "./interfaces/IBoxVaultV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneReader} from "../box/BoxCloneReader.sol";
import {BoxSpecV1} from "../box/BoxSpecV1.sol";
import {IBoxHookV2} from "./interfaces/IBoxHookV2.sol";
import {IBoxLaunchRouter} from "../box/interfaces/IBoxLaunchRouter.sol";
import {IBoxRoyaltyRouterV2} from "./interfaces/IBoxPeripheryV2.sol";
import {IBoxReceiverV2, IBoxReceiverFailedV21} from "./interfaces/IBoxReceiverV2.sol";
import {IBoxTickets} from "../box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../box/interfaces/IBoxToken.sol";
import {BoxKind, BoxPhase} from "../box/interfaces/BoxTypes.sol";
import {ChunkPart, FailCause, GATE_CAP_SECONDS, IBoxOpenGateV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {BoxRolesV2} from "./interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2} from "./interfaces/ReleaseConstantsV2.sol";
import {BoxCoordinatorV2Args as A} from "./libraries/BoxCoordinatorV2Args.sol";
import {CoordinatorFailure} from "./libraries/CoordinatorFailure.sol";
import {ChunkLoader} from "./libraries/ChunkLoader.sol";
import {BoxSpecV2} from "./BoxSpecV2.sol";

import {PricingToken} from "./libraries/PricingToken.sol";
import {BoxCoordinatorV2M2Stubs} from "./stubs/BoxCoordinatorV2M2Stubs.sol";

/// @notice A box part's one-time `initialize()` (v1's and v2's parts alike).
interface IBoxPartInit {
    function initialize() external;
}

/// @title BoxCoordinatorV2 (core v2 M1, ticket M1-30-a; the shell behind every v2 box's coordinator clone)
/// @notice See `IBoxCoordinatorV2`. v1's `BoxCoordinator` (the box's deployer, `launch()`, `graduate()` with the D6
/// reward and the fail-safe pokes, `claimReward`) with:
/// - **Any pricing token P** (ADR-0017 § 4). `launch()`'s payment is exactly `bootstrapQ` plus the creator buy: as
///   `msg.value` for ETH (v1's `WrongValue`), or, for an ERC-20 P with `msg.value` 0, pulled from the factory by
///   `transferFrom` with this contract's balance change checked (`ShortTransfer`, the factory's selector), so P sent
///   here before creation is never counted; then the launch router is approved for each amount exactly and pulls it.
/// - **T as a clone** (F102, CQ9-1): `deploy` CREATEs T's clone first, at `TOKEN_CREATE_NONCE` (1), from the
///   factory's init code, then calls its `initialize()` once, as its `initialHolder()`.
/// - **The open gate** (ADR-0017 § 6, F96 R20C). `openAt()` is the spec's open, or the creation block's time + 1 for
///   Now or a time reached (F80), fixed at `deploy`. A box with no chunks or starter loader is open there:
///   `effectiveOpenAt()` = `openAt()` and `BoxOpenSet` is emitted once. Otherwise the gate waits for every chunk
///   AND role 19's starter completion (including seed-only shops). Whichever condition completes last opens it at
///   max(`openAt()`, that block's time + 1), calls `setOpen` on the hook, the launch router and the tickets, and emits
///   `BoxOpenSet`. The hook, router and tickets read the gate at `initialize` (inside `launch()`).
/// - **Failure (C11, F122):** close first, sweep tax fail-safe, freeze the vault, split only the recorded D6
/// reserve through the receiver, burn pool-share T fail-safe, then fix the exact claim denominator and tip last.
/// Claims use the live P balance, without expiry. The failure count decreases only with claims.
/// The fixed no-buyer creator remainder never grows; unpresented shares and post-final receipts stay locked.
/// **Clone arguments**: `BoxCoordinatorV2Args` (234 M1 bytes; optional shop-kind tail). `_w` holds hook, box id, launched and graduatedAt;
/// `_r`/`_ra` hold the graduation reward; `_g` holds the open gate. Failure and chunks use namespaced storage.
/// @dev No owner, admin, pause, upgrade, setter or rescue. Only the factory deploys and launches. Failure holds
/// P claims indefinitely; no sweep can move the unpresented share or exhausted-claim surplus.
contract BoxCoordinatorV2 is BoxCoordinatorV2M2Stubs, TransientReentrancyGuard, BoxCloneReader {
    error AlreadyDeployed();
    error NotDeployed();
    /// @notice CREATE or CREATE2 of the code at `index` (the hook: `type(uint256).max`) failed or left no code.
    error DeployFailed(uint256 index);
    /// @notice The nonce table does not fit the codes `deploy` was given (a required role missing, a nonce beyond the
    /// last code or used twice, T not at nonce 1, a role this contract never creates or a v2 box never has, or more
    /// than 127 codes).
    error InvalidNonces();
    error BoxIdTooLarge(uint256 boxId);
    error TokenApproveFailed();

    /// @notice P claims forwarded as fees: only the recorded reserve on failure, only gifts on graduation.
    event ClaimsForwarded(address indexed to, uint256 amount);

    /// @notice v1's (F95 R19M); each poke gets exactly this much.
    uint256 public constant POKE_GAS = 2_600_000;
    uint256 public constant ARGS_LENGTH = A.LENGTH;
    /// @notice The chunk size of the hash rule: M1-10's generated `BoxSpecV2.CHUNK_MAX` (8,192; M1-60 sets it), which
    /// the factory's planner cuts the roots at (M1-32's wiring; was the provisional 24,575 until the library carried it).
    uint256 public constant CHUNK_MAX = BoxSpecV2.CHUNK_MAX;

    uint8 private constant _ACT_CLAIM = 1;

    uint256 private constant _M40 = (1 << 40) - 1;
    uint256 private constant _M48 = (1 << 48) - 1;
    uint256 private constant _O_BOX_ID = 160;
    uint256 private constant _B_LAUNCHED = 1 << 208;
    uint256 private constant _O_GRADUATED_AT = 209;
    uint256 private constant _O_EFFECTIVE_OPEN = 40;
    uint256 private constant _B_CHUNKS = 1 << 80;
    // Previously unused gate bit; all existing gate fields keep their meaning.
    uint256 private constant _B_STARTER_DONE = 1 << 81;
    // S5: authenticated once at deploy. Bit 249 follows the 40-bit graduation timestamp in _w.
    uint256 private constant _B_PILE = 1 << 249;

    /// @notice Typed as an address for the interface; the same contract as `_pm`.
    address public immutable poolManager;
    address public immutable factory;

    IPoolManager internal immutable _pm;
    CoordinatorViews private immutable _views;

    uint256 internal _w;
    uint256 internal _r;
    uint256 internal _ra;
    uint256 internal _g;

    constructor(IPoolManager poolManager_, address factory_) {
        if (address(poolManager_) == address(0) || factory_ == address(0)) revert ZeroAddress();
        poolManager = address(poolManager_);
        _pm = poolManager_;
        factory = factory_;
        _views = new CoordinatorViews();
        // The implementation itself is never a box: deployed and launched, so `deploy` and `launch` refuse it.
        _w = _B_LAUNCHED | 1;
    }

    // ================================================================== creation (the factory, once each)

    /// @notice The factory only, once, right after it CREATE2'd this clone: CREATEs `codes` in order (code i at this
    /// contract's nonce i + 1, T first at nonce 1), CREATE2s `hookCode` at `hookSalt`, records the hook and `boxId_`, initialises T, fixes
    /// the open and hands the chunk roots (index 0 the table, 1 the texts; bytes32(0): no such part) to the loader.
    /// @return hook_ the hook clone's address
    function deploy(
        bytes[] calldata codes,
        bytes calldata hookCode,
        bytes32 hookSalt,
        uint256 boxId_,
        bytes32[2] calldata chunkRoots,
        uint256[2] calldata chunkLengths
    ) external returns (address hook_) {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (_w != 0) revert AlreadyDeployed();
        if (boxId_ > _M48) revert BoxIdTooLarge(boxId_);
        _checkNonces(codes.length);
        for (uint256 i; i < codes.length; ++i) {
            _create(codes[i], i);
        }
        bytes memory code = hookCode;
        assembly ("memory-safe") {
            hook_ := create2(0, add(code, 0x20), mload(code), hookSalt)
        }
        if (hook_ == address(0) || hook_.code.length == 0) revert DeployFailed(type(uint256).max);
        _w = uint256(uint160(hook_)) | (boxId_ << _O_BOX_ID);
        _init(token());
        if (_view(CoordinatorViews.isPile.selector, uint160(factory), uint160(vault()), uint160(starterSetLoader())) != 0) {
            _w |= _B_PILE;
        }
        _initGate(chunkRoots, chunkLengths);
    }

    /// @notice The factory only, once: the payment (see the contract notes), the parts initialised in v1's order
    /// (collection, vault, tickets, item ledger, hook, launch router, receiver; absent parts are skipped), the
    /// curve seeded, the bootstrap buy run and its T burned (BC-004), the creator buy if any (BC-116).
    function launch() external payable nonReentrant {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        uint256 w = _w;
        if (w == 0) revert NotDeployed();
        if (w & _B_LAUNCHED != 0) revert AlreadyLaunched();
        address p = _argAddress(A.P);
        uint256 bq = _argUint(A.BOOTSTRAP_Q, 16);
        uint256 buyQ = _argUint(A.CREATOR_BUY, 16);
        uint256 value = p == address(0) ? bq + buyQ : 0;
        if (msg.value != value) revert WrongValue(msg.value, value);
        _w = w | _B_LAUNCHED;
        if (p != address(0)) PricingToken.pullExact(p, msg.sender, bq + buyQ);
        IBoxHookV2 hook_ = IBoxHookV2(_low160(w));
        IBoxLaunchRouter router = IBoxLaunchRouter(launchRouter());
        _initialiseParts(hook_, router);

        IBoxToken t = IBoxToken(token());
        if (!t.approve(address(hook_), type(uint256).max)) revert TokenApproveFailed();
        _callPart(address(hook_), abi.encodeCall(IBoxHookV2.launch, ()));
        uint256 before = t.balanceOf(address(this));
        PricingToken.approveExact(p, address(router), bq);
        // The T is counted from this contract's balance, not from the router's figure.
        // forge-lint: disable-next-line(unused-return)
        router.bootstrap{value: p == address(0) ? bq : 0}();
        uint256 bootstrapTokens = t.balanceOf(address(this)) - before;
        _callPart(address(t), abi.encodeCall(IBoxToken.burn, (bootstrapTokens)));
        uint256 creatorTokens;
        if (buyQ != 0) {
            PricingToken.approveExact(p, address(router), buyQ);
            creatorTokens = router.creatorBuy{value: p == address(0) ? buyQ : 0}(_argAddress(A.CREATOR), buyQ);
        }
        emit BoxLaunched(boxId(), hook_.openAt(), bootstrapTokens, buyQ, creatorTokens);
    }

    // ================================================================== open gate and chunks

    function loadChunk(ChunkPart part, bytes calldata data, bytes32 nextHash)
        external
        nonReentrant
        returns (uint256 index, bool partDone)
    {
        if (_w & _B_LAUNCHED == 0) revert NotLaunched();
        uint256 g = _g;
        if (g & _B_CHUNKS == 0) {
            if (part == ChunkPart.None) revert UnknownPart(part);
            revert PartComplete(part);
        }
        address chunk;
        (index, partDone, chunk) = ChunkLoader.load(part, data, nextHash);
        emit ChunkLoaded(part, index, chunk, data.length, partDone);
        // The last missing piece opens the gate, unless the box failed while it held (`failClosed`; `_openGate`).
        if (partDone && (g >> _O_EFFECTIVE_OPEN) & _M40 == 0 && ChunkLoader.complete() && !starterSetPending()) _openGate(g);
    }

    // ================================================================== failure (M1-31's library)

    /// @notice Anyone: fail an expired unfilled box, or a filled box seven days after closedAt (F122).
    function fail() external nonReentrant {
        _checkFailureEntry();
        IBoxHookV2 h = IBoxHookV2(hook());
        if (h.closed()) {
            uint256 end = h.closedAt() + ReleaseConstantsV2.GRADUATION_ESCAPE_DELAY;
            if (block.timestamp < end) revert GraduationEscapeNotReached(end);
            _fail(FailCause.GraduationTimedOut);
        } else {
            uint256 end = deadline();
            if (end == 0 || block.timestamp < end) revert DeadlineNotReached(end);
            _fail(FailCause.Deadline);
        }
    }

    /// @notice Anyone: fail a gate still holding at openAt + 14 days; same atomic claim path.
    function failClosed() external nonReentrant {
        _checkFailureEntry();
        if (gateOpen()) revert GateNotHolding();
        uint256 end = openAt() + GATE_CAP_SECONDS;
        if (block.timestamp < end) revert GateCapNotReached(end);
        _fail(FailCause.ClosedPastCap);
    }

    // ================================================================== graduation (anyone, once)

    /// @notice Anyone after fill, once: migrate, burn dust fail-safe, open the vault, credit D6 and poke add-ons.
    /// A failed box can never graduate; refused add-on pokes can be retried independently.
    function graduate() external nonReentrant returns (uint256 reward) {
        _checkFailureEntry();
        IBoxHookV2 h = IBoxHookV2(hook());
        if (!h.closed()) revert NotClosed();
        _w |= block.timestamp << _O_GRADUATED_AT;
        address token_ = token();
        uint256 share = IBoxToken(token_).balanceOf(address(this));
        // forge-lint: disable-next-line(unused-return)
        h.migrate(share);
        uint256 dust = IBoxToken(token_).balanceOf(address(this));
        uint256 burned = _tryBurn(token_, dust) ? dust : 0;
        address vault_ = vault();
        if (vault_ != address(0)) _callPart(vault_, abi.encodeCall(IBoxVaultV2.openGate, ()));
        uint256 held = _potBalance();
        reward = h.reserveMinted();
        uint256 cap = rewardCap();
        if (reward > cap) reward = cap;
        if (reward > held) reward = held;
        if (reward != 0) {
            _r = uint256(uint160(msg.sender));
            _ra = reward;
        }
        address receiver_ = receiver();
        if (held > reward) _forwardFees(receiver_, held - reward);
        emit Graduated(msg.sender, block.number, share, burned, reward);
        _poke(receiver_, IBoxReceiverV2.onGraduation.selector);
        _poke(tickets(), IBoxTickets.requestGraduationWord.selector);
    }

    /// @notice The recorded graduator only: redeem its D6 reward to a nonzero recipient, or revert for retry.
    function claimReward(address to) external nonReentrant returns (uint256 amount) {
        _noForeignUnlock();
        if (to == address(0)) revert ZeroAddress();
        amount = _ra;
        if (amount == 0 || _low160(_r) != msg.sender) revert NothingToClaim();
        (_r, _ra) = (0, 0);
        emit RewardClaimed(msg.sender, to, amount);
        _pay(to, amount);
    }

    /// @notice PoolManager only during a guarded entry: redeem this coordinator's P claims for a reward, claim or tip.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_pm) || !_insideGuardedCall()) revert NotPoolManager();
        (uint8 action, address to, uint256 amount) = abi.decode(data, (uint8, address, uint256));
        if (action != _ACT_CLAIM) revert NotPoolManager();
        address p = _argAddress(A.P);
        // ERC-6909 balances can accumulate beyond int128 across unlocks. Each PoolManager currency delta
        // is int128, so settle each chunk before starting the next; even a last one-token claim has an exit.
        uint256 maxDelta = uint256(uint128(type(int128).max));
        while (amount != 0) {
            uint256 part = amount > maxDelta ? maxDelta : amount;
            _pm.burn(address(this), PricingToken.claimId(p), part);
            _pm.take(Currency.wrap(p), to, part);
            amount -= part;
        }
        return "";
    }

    // ================================================================== views: the gate, chunks, failure

    function openAt() public view returns (uint256) {
        return _g & _M40;
    }

    function gateOpen() public view returns (bool) {
        return (_g >> _O_EFFECTIVE_OPEN) & _M40 != 0;
    }

    function effectiveOpenAt() public view returns (uint256) {
        return (_g >> _O_EFFECTIVE_OPEN) & _M40;
    }

    function deadline() public view returns (uint256) {
        uint256 eff = effectiveOpenAt();
        return eff == 0 ? 0 : eff + deadlineDays() * 1 days;
    }

    function deadlineDays() public view returns (uint256) {
        return _argUint(A.DEADLINE_DAYS, 2);
    }

    function GATE_CAP() external pure returns (uint256) {
        return GATE_CAP_SECONDS;
    }

    function chunkRoot(ChunkPart part) external view returns (bytes32 root, uint256 length) {
        if (_g & _B_CHUNKS != 0) return ChunkLoader.rootFor(part);
    }

    function chunkState(ChunkPart part) external view returns (bytes32 nextHash, uint256 loaded, uint256 total) {
        if (_g & _B_CHUNKS != 0) return ChunkLoader.state(part);
    }

    function chunkPointer(ChunkPart part, uint256 index) external view returns (address) {
        if (_g & _B_CHUNKS == 0) return address(0);
        return ChunkLoader.pointer(part, index);
    }

    /// @notice Anyone reads whether the committed starter set still holds the gate; no funds move.
    function starterSetPending() public view override returns (bool) {
        return _g & _B_STARTER_DONE == 0 && starterSetLoader() != address(0);
    }

    function starterSetLoader() public view override returns (address) {
        return _role(BoxRolesV2.ROLE_STARTER_SET_LOADER);
    }

    function failed() external view returns (bool) {
        return CoordinatorFailure.failed();
    }

    function failedAt() external view returns (uint256) {
        return CoordinatorFailure.failedAt();
    }

    function failCause() external view returns (FailCause) {
        return CoordinatorFailure.failCause();
    }

    // ================================================================== views: state

    function phase() external view returns (BoxPhase) {
        uint256 w = _w;
        if (w & _B_LAUNCHED == 0) return BoxPhase.None;
        if ((w >> _O_GRADUATED_AT) & _M40 != 0) return BoxPhase.Graduated;
        if (CoordinatorFailure.failed()) return BoxPhase.Failed;
        return IBoxHookV2(_low160(w)).phase();
    }

    function graduated() public view returns (bool) {
        return (_w >> _O_GRADUATED_AT) & _M40 != 0;
    }

    function graduatedAt() external view returns (uint256) {
        return (_w >> _O_GRADUATED_AT) & _M40;
    }

    function graduatedAtBlock() external view returns (uint256) {
        uint256 w = _w;
        if ((w >> _O_GRADUATED_AT) & _M40 == 0) return 0;
        return IBoxHookV2(_low160(w)).migratedAtBlock();
    }

    function rewardOf(address account) external view returns (uint256) {
        return _low160(_r) == account ? _ra : 0;
    }

    /// @dev Before graduation min(the reserve the hook minted here, the P claims held); 0 once it was credited.
    function reserve() external view returns (uint256) {
        uint256 w = _w;
        if (!_beforeOutcome(w)) return 0;
        uint256 held = _potBalance();
        uint256 minted = IBoxHookV2(_low160(w)).reserveMinted();
        return minted < held ? minted : held;
    }

    /// @notice D6's cap: 0.1% of R (BoxSpecV1.GRADUATION_REWARD_CAP_BPS), in P.
    function rewardCap() public view returns (uint256) {
        return _argUint(A.RAISE, 16) * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000;
    }

    function poolShare() external view returns (uint256) {
        uint256 w = _w;
        if (!_beforeOutcome(w)) return 0;
        return IBoxToken(token()).balanceOf(address(this));
    }

    // ================================================================== views: wiring

    function boxId() public view returns (uint256) {
        return (_w >> _O_BOX_ID) & _M48;
    }

    /// @notice Every v2 box is `Standard` (box 0 is v1's).
    function kind() external pure returns (BoxKind) {
        return BoxKind.Standard;
    }

    function specHash() external view returns (bytes32) {
        return bytes32(_argUint(A.SPEC_HASH, 32));
    }

    function creator() external view returns (address) {
        return _argAddress(A.CREATOR);
    }

    function q() external view returns (address) {
        return _argAddress(A.P);
    }

    function raise() external view returns (uint256) {
        return _argUint(A.RAISE, 16);
    }

    function creatorBuyAmount() external view returns (uint256) {
        return _argUint(A.CREATOR_BUY, 16);
    }

    /// @notice The box's untaxed bootstrap buy in P (`QParameters.bootstrapQ`).
    function bootstrapQ() external view returns (uint256) {
        return _argUint(A.BOOTSTRAP_Q, 16);
    }

    function hook() public view returns (address) {
        return _low160(_w);
    }

    function token() public view returns (address) {
        return _role(BoxRolesV2.ROLE_TOKEN);
    }

    function vault() public view returns (address) {
        return _role(BoxRolesV2.ROLE_VAULT);
    }

    function collection() public view returns (address) {
        return _role(BoxRolesV2.ROLE_COLLECTION);
    }

    function receiver() public view returns (address) {
        return _role(BoxRolesV2.ROLE_RECEIVER);
    }

    function launchRouter() public view returns (address) {
        return _role(BoxRolesV2.ROLE_LAUNCH_ROUTER);
    }

    function tickets() public view returns (address) {
        return _role(BoxRolesV2.ROLE_TICKETS);
    }

    function royaltyRouter() external view returns (address) {
        return _role(BoxRolesV2.ROLE_ROYALTY_ROUTER);
    }

    /// @notice v1's per-item stream: not in format 2, so address(0) for every v2 box.
    function itemStream() external pure returns (address) {
        return address(0);
    }

    function executor() public view returns (address) {
        return _argAddress(A.EXECUTOR);
    }

    function randomness() external view returns (address) {
        return _argAddress(A.RANDOMNESS);
    }

    function pricingListingId() external view returns (uint32) {
        // casting to 'uint32' is safe because the argument is 4 bytes
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(_argUint(A.PRICING_LISTING_ID, 4));
    }

    function registry() external view returns (address) {
        return _argAddress(A.REGISTRY);
    }

    function listingRegistry() external view returns (address) {
        return _argAddress(A.LISTING_REGISTRY);
    }

    function roleAddress(uint256 role) public view returns (address) {
        if (role == BoxRolesV2.ROLE_COORDINATOR) return address(this);
        if (role == BoxRolesV2.ROLE_HOOK) return _low160(_w);
        if (role == BoxRolesV2.ROLE_EXECUTOR) return _argAddress(A.EXECUTOR);
        if (role >= BoxRolesV2.ROLE_COUNT) return address(0);
        return _role(role);
    }

    /// @notice The CREATE nonce `deploy` created a role's part at (0: none, or a role this contract does not create).
    function nonceOf(uint256 role) external view returns (uint256) {
        if (role >= BoxRolesV2.ROLE_COUNT) return 0;
        return _argUint8(A.NONCES + role);
    }

    // ================================================================== internals

    /// @dev The open (F80: Now or a time reached opens in the next block) and the gate, at `deploy`.
    function _initGate(bytes32[2] calldata roots, uint256[2] calldata lengths) private {
        uint256 open = _argUint(A.OPEN_AT, 4);
        if (open <= block.timestamp) open = block.timestamp + 1;
        bool chunks;
        for (uint256 i; i < 2; ++i) {
            if (roots[i] == bytes32(0)) continue;
            // casting to 'uint8' is safe because i < 2
            // forge-lint: disable-next-line(unsafe-typecast)
            ChunkLoader.init(ChunkPart(uint8(i + 1)), roots[i], lengths[i], CHUNK_MAX);
            chunks = true;
        }
        if (chunks || starterSetPending()) {
            _g = open | (chunks ? _B_CHUNKS : 0);
        } else {
            _g = open | (open << _O_EFFECTIVE_OPEN);
            emit BoxOpenSet(open, open + deadlineDays() * 1 days);
        }
    }

    /// @dev The gate opens at max(openAt, this block's time + 1); the parts that read it take it once. A failed box
    /// (`failClosed` while it held) opens nothing. Internal, so M2's starter-set entry (`BoxCoordinatorV2M2Stubs`) can
    /// open it the same way, the failure check included.
    function _openGate(uint256 g) internal {
        if (CoordinatorFailure.failed()) return;
        uint256 eff = block.timestamp + 1;
        uint256 open = g & _M40;
        if (open > eff) eff = open;
        _g = g | (eff << _O_EFFECTIVE_OPEN);
        _setPartOpen(_low160(_w), eff);
        _setPartOpen(launchRouter(), eff);
        address tickets_ = tickets();
        if (tickets_ != address(0)) _setPartOpen(tickets_, eff);
        emit BoxOpenSet(eff, eff + deadlineDays() * 1 days);
    }

    /// @dev StarterSetLoaderV2 alone reaches this seam after exact set and seed readiness. Chunks may finish
    /// before or after this notice; a failed setOpen rolls back the done bit and the loader's notified flag.
    function _completeStarterGate() internal override nonReentrant {
        if (CoordinatorFailure.failed()) revert AlreadyFailed();
        if (_w & _B_LAUNCHED == 0) revert NotLaunched();
        if (_g & _B_STARTER_DONE != 0) revert NOT_OFFERED();
        _g |= _B_STARTER_DONE;
        if (_g & _B_CHUNKS == 0 || ChunkLoader.complete()) _openGate(_g);
    }

    function _initialiseParts(IBoxHookV2 hook_, IBoxLaunchRouter router) private {
        _init(collection());
        _init(vault());
        _init(tickets());
        _init(_role(BoxRolesV2.ROLE_ITEM_LEDGER));
        _init(address(hook_));
        _init(address(router));
        _init(receiver());
    }

    function _init(address part) private {
        if (part != address(0)) _callPart(part, abi.encodeCall(IBoxPartInit.initialize, ()));
    }

    /// @dev Shared encoding avoids three copies of the gate-call machinery. Trusted parts return no value.
    function _setPartOpen(address part, uint256 eff) private {
        _callPart(part, abi.encodeCall(IBoxOpenGateV2.setOpen, (eff)));
    }

    /// @dev Direct call to a fixed part with code; preserve its revert bytes and discard unused return data.
    function _callPart(address part, bytes memory data) private {
        assembly ("memory-safe") {
            if iszero(extcodesize(part)) { revert(0, 0) }
            if iszero(call(gas(), part, 0, add(data, 32), mload(data), 0, 0)) {
                let p := mload(0x40)
                returndatacopy(p, 0, returndatasize())
                revert(p, returndatasize())
            }
        }
    }

    /// @dev All failure entries refuse foreign unlocks before any write; a direct step's refusal rolls back all steps.
    function _checkFailureEntry() private view {
        _noForeignUnlock();
        if (CoordinatorFailure.failed()) revert AlreadyFailed();
        if (graduated()) revert AlreadyGraduated();
        if (_w & _B_LAUNCHED == 0) revert NotLaunched();
    }

    function _noForeignUnlock() private view {
        if (TransientStateLibrary.isUnlocked(_pm)) revert ForeignUnlock();
    }

    /// @dev C11: principal stays here. Only the hook's recorded reserve crosses to the receiver as fee money.
    function _fail(FailCause cause) private {
        CoordinatorFailure.record(cause);
        IBoxHookV2 h = IBoxHookV2(hook());
        _collectPot();
        address vault_ = vault();
        if (vault_ != address(0)) _callPart(vault_, abi.encodeCall(IBoxVaultV2.enterFailure, ()));
        address receiver_ = receiver();
        uint256 reserve_ = h.reserveMinted();
        uint256 balance = _potBalance();
        if (reserve_ > balance) reserve_ = balance;
        _forwardFees(receiver_, reserve_);
        _callPart(receiver_, abi.encodeCall(IBoxReceiverV2.enterFailure, ()));
        _sweepInbox();
        address token_ = token();
        _tryBurn(token_, IBoxToken(token_).balanceOf(address(this)));
        uint256 left = CoordinatorFailure.fixOutstanding(
            _pm, token_, address(h), receiver_, vault_, h.closedTResidue(),
            _w & _B_PILE != 0 ? A.PILE_KIND : (_argUint8(A.VAULT_KIND) == A.SHOP_KIND ? A.SHOP_KIND : 0)
        );
        uint256 pot = _potBalance();
        uint256 tip = h.deepenTipCap();
        if (tip > pot) tip = pot;
        CoordinatorFailure.Layout storage s = CoordinatorFailure._layout();
        if (left == 0) {
            s.creatorOnly = true;
            s.creatorClaimPending = true;
            s.creatorRemainder = pot - tip;
        }
        // All claim state is fixed before token code runs. A refused tip keeps its money in the pot.
        if (
            tip != 0
                && !_cappedCall(
                    address(_pm),
                    abi.encodeCall(IPoolManager.unlock, (abi.encode(_ACT_CLAIM, msg.sender, tip))),
                    ReleaseConstantsV2.TIP_GAS, 0
                )
        ) {
            if (left == 0) s.creatorRemainder += tip;
            tip = 0;
        }
        emit PotFixed(pot - tip, left, tip, msg.sender);
    }

    /// @dev Shared direct call to the box's fixed deployed hook; close's return amounts are not needed here.
    /// Bubble failure atomically, without allocating or decoding the unused tuple on successful calls.
    function _closeHook() private {
        _callPart(hook(), abi.encodeCall(IBoxHookV2.close, ()));
    }

    function _forwardFees(address to, uint256 amount) private {
        if (amount == 0) return;
        // The pinned PoolManager transfer returns true or reverts; no outside token code runs.
        // forge-lint: disable-next-line(unused-return)
        _pm.transfer(to, PricingToken.claimId(_argAddress(A.P)), amount);
        emit ClaimsForwarded(to, amount);
    }

    function _potBalance() private view returns (uint256) {
        return _pm.balanceOf(address(this), PricingToken.claimId(_argAddress(A.P)));
    }

    /// @dev Preview only: a failed receiver's unbooked P joins on claim. A refused/malformed view adds zero.
    /// Cap execution and copy one word only, so a broken receiver cannot consume all view gas or return-data memory.
    function _claimPotBalance() private view returns (uint256 pot) {
        pot = _potBalance();
        if (!CoordinatorFailure.failed()) return pot;
        address target = receiver();
        bytes4 selector = IBoxReceiverFailedV21.failedCollectableP.selector;
        uint256 stipend = ReleaseConstantsV2.FAILED_COLLECT_GAS;
        uint256 collectable;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            let ok := staticcall(stipend, target, ptr, 4, ptr, 32)
            if and(ok, eq(returndatasize(), 32)) { collectable := mload(ptr) }
        }
        return pot + collectable;
    }

    /// @dev Direct hook settlement precedes the fail-safe tax sweep, both at failure and before holder claims.
    function _collectPot() private {
        _closeHook();
        address router = launchRouter();
        if (!_cappedCall(router, abi.encodeCall(IBoxLaunchRouter.sweep, ()), ReleaseConstantsV2.SWEEP_GAS, 0)) {
            emit PokeFailed(router, IBoxLaunchRouter.sweep.selector);
        }
    }

    /// @dev Intake is optional work: an issuer must not veto failure or a partial claim of the available pot.
    function _sweepInbox() private {
        address inbox = _role(BoxRolesV2.ROLE_ROYALTY_ROUTER);
        if (inbox != address(0)
            && !_cappedCall(inbox, abi.encodeCall(IBoxRoyaltyRouterV2.sweepPriceCoin, ()), ReleaseConstantsV2.INBOX_SWEEP_GAS,
                ReleaseConstantsV2.INBOX_SWEEP_RESERVE_GAS)) {
            emit PokeFailed(inbox, IBoxRoyaltyRouterV2.sweepPriceCoin.selector);
        }
    }

    /// @notice Fixed inbox only: credit completed P intake to a no-buyer creator remainder; no funds move.
    /// @dev May run inside failure/claim's optional sweep. Only the fixed inbox calls after exact delivery;
    /// no external calls or payments here. Before the failure snapshot, its delivery is already part of the pot.
    function creditInbox(uint256 amount) external {
        if (msg.sender != _role(BoxRolesV2.ROLE_ROYALTY_ROUTER)) revert InvalidClaim();
        CoordinatorFailure.Layout storage s = CoordinatorFailure._layout();
        if (s.creatorOnly && amount != 0) {
            s.creatorRemainder += amount;
            s.creatorClaimPending = true;
        }
    }

    /// @dev Failed reads remain unknown, never zero. No issuer return/revert payload is copied without a bound.
    function _pendingInbox() private view returns (bool known, uint256 amount) {
        address inbox = _role(BoxRolesV2.ROLE_ROYALTY_ROUTER);
        if (inbox == address(0)) return (true, 0);
        bytes memory data = abi.encodeCall(IBoxRoyaltyRouterV2.pendingPriceCoin, ());
        assembly ("memory-safe") {
            known := staticcall(200000, inbox, add(data, 32), mload(data), 0, 32)
            known := and(known, eq(returndatasize(), 32))
            amount := mload(0)
        }
    }

    function _requireInboxEmpty() private view {
        (bool known, uint256 pending) = _pendingInbox();
        if (!known || pending != 0) revert ClaimFailed();
    }

    function _tryBurn(address token_, uint256 amount) private returns (bool ok) {
        if (amount == 0) return true;
        ok = _cappedCall(token_, abi.encodeCall(IBoxToken.burn, (amount)), ReleaseConstantsV2.BURN_GAS, 0);
        if (!ok) emit PokeFailed(token_, IBoxToken.burn.selector);
    }

    /// @dev No returndata copied (including a hostile revert payload). Starving a stipend reverts the whole entry.
    function _cappedCall(address target, bytes memory data, uint256 stipend, uint256 reserve) private returns (bool ok) {
        uint256 required = stipend + stipend / 63 + ReleaseConstantsV2.POKE_OVERHEAD_GAS + reserve;
        uint256 left = gasleft();
        if (left < required) revert GasTooLow(left, required);
        assembly ("memory-safe") { ok := call(stipend, target, 0, add(data, 32), mload(data), 0, 0) }
    }

    /// @dev The address in the low 160 bits of a storage word.
    function _low160(uint256 word) private pure returns (address) {
        // casting to 'uint160' is safe because these words store an address in exactly their low 160 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(word));
    }

    /// @dev The address `deploy` created a role's part at, or zero for a nonce of 0.
    function _role(uint256 role) private view returns (address) {
        uint256 nonce = _argUint8(A.NONCES + role);
        return nonce == 0 ? address(0) : _createdAt(nonce);
    }

    /// @dev keccak256(rlp([this, nonce]))[12:] for 1 ≤ nonce ≤ 127 (v1's `_createdAt`).
    function _createdAt(uint256 nonce) private view returns (address a) {
        assembly ("memory-safe") {
            mstore(0x00, or(shl(248, 0xd6), or(shl(240, 0x94), shl(80, address()))))
            mstore8(0x16, nonce)
            a := and(keccak256(0x00, 0x17), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    /// @dev The nonce table against `n` codes: T at nonce 1, the receiver and the launch router in [1, n]; any other
    /// role this contract creates at 0 or in [1, n]; the coordinator, the hook and the executor never, nor the item
    /// stream and the metadata table (zero for every v2 box, `BoxRolesV2`); only authenticated PILE may alias 3/19.
    function _checkNonces(uint256 n) private view {
        // The fixed helper accepts the exact 24-byte packed table, including the unused zero roles.
        _view(CoordinatorViews.checkNonces.selector, n, _argUint(A.NONCES, 24) << 64, 0);
    }

    /// @dev CREATE of one code from calldata (at this contract's next nonce).
    function _create(bytes calldata code, uint256 index) private {
        address a;
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, code.offset, code.length)
            a := create(0, p, code.length)
        }
        if (a == address(0) || a.code.length == 0) revert DeployFailed(index);
    }

    /// @dev One fail-safe poke (v1's `_poke`): `selector` with no arguments, exactly POKE_GAS, no value, no return
    /// data copied; a box without the part skips it.
    function _poke(address target, bytes4 selector) private {
        if (target == address(0)) return;
        if (!_cappedCall(target, abi.encodeWithSelector(selector), POKE_GAS, 0)) emit PokeFailed(target, selector);
    }

    /// @dev A blocked payout restores all state and transferred T, permitting a retry to another recipient.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        try _pm.unlock(abi.encode(_ACT_CLAIM, to, amount)) {}
        catch {
            revert ClaimFailed();
        }
    }

    /// @notice Anyone after failure, without expiry: forward late hook P, sweep tax and collect receiver P fail-safe, surrender caller T
    /// and receive live-pot P. Unpresented shares and receipts after the last claim remain locked forever.
    /// With no buyers, only the creator claims the known remainder plus later inbox intake with t = 0.
    /// Refused payouts revert for retry; future inbox intake can reopen that creator claim.
    function claim(uint256 t, address to) external nonReentrant returns (uint256 p) {
        _noForeignUnlock();
        CoordinatorFailure.Layout storage s = _claims();
        if (to == address(0)) revert InvalidClaim();
        _sweepInbox();
        _collectPot();
        address receiver_ = receiver();
        if (!_cappedCall(receiver_, abi.encodeCall(IBoxReceiverV2.collect, (address(0))), ReleaseConstantsV2.FAILED_COLLECT_GAS, 0)) {
            emit PokeFailed(receiver_, IBoxReceiverV2.collect.selector);
        }
        if (s.tLeft == 0) {
            if (t != 0 || !s.creatorClaimPending || msg.sender != _argAddress(A.CREATOR)) revert InvalidClaim();
            // Unreadable or blocked inbox money cannot veto an established, funded remainder.
            p = s.creatorRemainder;
            s.creatorRemainder = 0;
            s.creatorClaimPending = false;
        } else {
            if (t == s.tLeft) _requireInboxEmpty();
            p = _quote(t, s.tLeft, _potBalance());
            s.tLeft -= t;
            address token_ = token();
            if (!IBoxToken(token_).transferFrom(msg.sender, address(this), t)) revert InvalidClaim();
            _tryBurn(token_, t);
        }
        _pay(to, p);
        emit Claimed(msg.sender, to, t, p);
    }

    /// @notice Anyone previews the failed pot including collectable receiver P; unswept launch tax is excluded.
    /// The creator and final holder quote include readable inbox P, conditional on successful intake at claim.
    /// Partial holder quotes use available pot only. An unreadable inbox refuses only the final holder quote.
    function quoteClaim(uint256 t) external view returns (uint256) {
        CoordinatorFailure.Layout storage s = _claims();
        if (s.tLeft == 0) {
            uint256 remainder = s.creatorRemainder + _readableInboxBalance();
            if (t != 0 || !s.creatorOnly || (!s.creatorClaimPending && remainder == 0)) revert InvalidClaim();
            return remainder;
        }
        uint256 pot = _claimPotBalance();
        if (t == s.tLeft) {
            (bool known, uint256 pending) = _pendingInbox();
            if (!known) revert ClaimFailed();
            pot += pending;
        }
        return _quote(t, s.tLeft, pot);
    }

    /// @dev Preview only; a refused inbox read cannot hide the creator's established funded remainder.
    function _readableInboxBalance() private view returns (uint256) {
        (bool known, uint256 pending) = _pendingInbox();
        return known ? pending : 0;
    }

    function _claims() private view returns (CoordinatorFailure.Layout storage s) {
        s = CoordinatorFailure._layout();
        if (s.cause == FailCause.None) revert NotFailed();
    }

    function _quote(uint256 t, uint256 left, uint256 pot) private view returns (uint256) {
        if (t == 0 || t > left) revert InvalidClaim();
        return _view(CoordinatorViews.quoteClaim.selector, pot, t, left);
    }

    /// @notice Anyone reads available pot and remaining T; no-buyer boxes also preview readable pending inbox P.
    /// Includes locked receipts: only quoteClaim(0) determines the creator entitlement. No funds move.
    function claimState() external view returns (uint256 pot, uint256 tLeft) {
        CoordinatorFailure.Layout storage s = CoordinatorFailure._layout();
        return (_claimPotBalance() + (s.creatorOnly ? _readableInboxBalance() : 0), s.tLeft);
    }

    /// @dev Static call to constructor-created pure code. Extra trailing calldata is ignored by checkNonces.
    /// Revert bytes are bubbled unchanged; only quoteClaim consumes the single-word result.
    function _view(bytes4 selector, uint256 a, uint256 b, uint256 c) private view returns (uint256 result) {
        address target = address(_views);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), a)
            mstore(add(ptr, 36), b)
            mstore(add(ptr, 68), c)
            if iszero(staticcall(gas(), target, ptr, 100, ptr, 32)) {
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
            result := mload(ptr)
        }
    }

    /// @dev Shared gate for the reserve and pool-share views; the short-circuit order is unchanged.
    function _beforeOutcome(uint256 w) private view returns (bool) {
        return w & _B_LAUNCHED != 0 && (w >> _O_GRADUATED_AT) & _M40 == 0 && !CoordinatorFailure.failed();
    }
}
