// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT interfaces and types only (DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxCollection} from "./interfaces/IBoxCollection.sol";
import {IBoxCoordinator, IBoxStreamBaseline} from "./interfaces/IBoxCoordinator.sol";
import {IBoxHook, IBoxPriceAverage} from "./interfaces/IBoxHook.sol";
import {IBoxItemStream} from "./interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "./interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "./interfaces/IBoxTickets.sol";
import {IBoxToken} from "./interfaces/IBoxToken.sol";
import {IBoxVault} from "./interfaces/IBoxVault.sol";
import {BoxKind, BoxPhase} from "./interfaces/BoxTypes.sol";
import {BoxCloneReader} from "./BoxCloneReader.sol";

/// @title BoxCoordinator (slice S6; the implementation behind every box's coordinator clone)
/// @notice See `IBoxCoordinator` for the behaviour. One box's deployer, launcher and graduation. Generalises
/// MisfitsGenesis (src/v2/genesis/MisfitsGenesis.sol at 46a030f6): `graduate()` (`:315-334`: hand the whole pool share
/// to the hook's migration, burn the T the ask cannot take, open the vault gate, poke the executor) and `poolShare()`
/// (`:337-339`), and FitPoolGenesis.launch (src/v2/genesis/FitPoolGenesis.sol:71-102, the bootstrap `:104-`) as calls
/// into clones, under D1 (no latch: the closing swap closes the curve, `graduate()` follows at once, also in the
/// closing transaction), D6 (the caller's reward from the curve's fees, a claim it pulls) and BC-098 (capped pokes).
/// The genesis re-checks and the randomness pin move into the factory (S7; BC-063, BC-101).
///
/// - **The box's deployer** (SH-S0-spikes § 2.2, kept for S7 [P]): the factory CREATE2s this clone, salted with the
///   creator and the spec hash (box 0: the template-0 tag), then calls `deploy` once: it CREATEs every other contract
///   of the box from the factory's codes, in order (nonce 1, 2, ...), and CREATE2s the hook clone at the creator's
///   mined salt. So every address follows from this clone's address and a nonce, known before the transaction and
///   independent of any code, and no clone needs a back-reference in storage. The clone arguments name, per role, the
///   nonce it was created at (`nonceOf`); the hook (a CREATE2 address mined over its final init code, which names this
///   clone) and the box id (the registry's count) are the only wiring in storage, one slot.
/// - **`launch()`** (the factory, once; MisfitsGenesis's constructor and FitPoolGenesis.launch, now clones): the
///   pinned initialise order (collection, vault, tickets if any, hook, launch router, receiver, then the per-item
///   stream if any, S8), the hook approved for
///   this contract's T, the curve seeded, the bootstrap buy run and its T burned (BC-004), the creator buy if the spec
///   has one (T to the creator, BC-116).
/// - **`graduate()`** (anyone, once, from the closing swap on): marks graduated; the hook's `migrate` with this
///   contract's whole T (its last curve poke tops up the D6 reserve here first); the T the ask could not take burned;
///   the vault gate opened; the caller credited `min(reserve minted here, 0.1% of R, Q claims held)`, from the curve's
///   fees only; Q claims beyond it (a gift) forwarded to the receiver as fees; then the pokes (the receiver, the
///   tickets, FIT's executor, and since S8 the per-item stream, after the receiver's settlement).
/// - **Capped follow-ups** (BC-098): before the pokes `graduate()` calls only the box's own hook, T, vault and the
///   PoolManager. Each poke (the receiver's `onGraduation`, the tickets' `requestGraduationWord`, the executor's
///   `poke`, the stream's `onGraduation`) is a low-level CALL with exactly `POKE_GAS` (a caller sending less gas than the floor is refused
///   `GasTooLow`, so no caller can starve a poke into failing), no value and no return data copied (no return bomb); a
///   failure is logged (`PokeFailed`) and anyone repeats the poke later. The stream's baseline is recorded before
///   any poke using only T and the PoolManager, so even a permanently failing stream cannot stop graduation (F126). The reward is a claim: graduation calls no
///   recipient. `graduate`, `launch` and `claimReward` share one transient lock, so a poked contract cannot re-enter.
/// - **The reward** (D6; BC-027): the hook mints the reserve here from the curve's Q fees before every split
///   (`IBoxHook.harvest`, `migrate`), so a `collect()` before `graduate()` cannot empty it and nothing comes from the
///   raise. One caller is credited once; `claimReward` redeems the claims from the PoolManager to any address in Q.
///
/// **Clone arguments** (`abi.encodePacked`, 154 bytes; none depends on this clone's own address, so its CREATE2
/// address is known before the transaction):
///
/// | Offset | Bytes | Argument |
/// |---:|---:|---|
/// | 0 | 1 | `kind` (`BoxKind`) |
/// | 1 | 20 | `q` (address(0) = native ETH) |
/// | 21 | 16 | `raise` (Q raw units) |
/// | 37 | 16 | `creatorBuyAmount` (Q raw units; 0 for none and for box 0) |
/// | 53 | 20 | `creator` (receives the creator buy's T) |
/// | 73 | 32 | `specHash` |
/// | 105 | 20 | `executor`: FIT's buy-and-burn executor, when it is not created here (zero when it is) |
/// | 125 | 20 | `randomness`: the chain's pinned drand source |
/// | 145 | 9 | CREATE nonces (1-127, 0 = none): token, vault, collection, receiver, launch router, tickets, royalty router, item stream, executor |
///
/// **Storage** (one word each): `_w` = hook (bits 0-159) · box id (160-207) · launched (208) · graduatedAt (209-248, a
/// timestamp); `_r` = the reward's holder (0-159) · its amount (160-255). `graduatedAtBlock` is the hook's
/// `migratedAtBlock` (both written by the one `graduate()` call).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2). `deploy` and `launch` are the factory's, once
/// each, before anything trades; every other entry point is anyone's. Holds, before graduation, the pool share and the
/// D6 reserve only (as T and ERC-6909 Q claims), and after it only the unclaimed reward; never ETH (no `receive`).
contract BoxCoordinator is IBoxCoordinator, IBoxStreamBaseline, TransientReentrancyGuard, BoxCloneReader {
    // ------------------------------------------------------------------ errors beyond IBoxCoordinator

    /// @notice `deploy` ran already (or this is the implementation, which is never a box).
    error AlreadyDeployed();
    /// @notice `launch` before `deploy`.
    error NotDeployed();
    /// @notice CREATE or CREATE2 of the code at `index` (the hook: `type(uint256).max`) failed or left no code.
    error DeployFailed(uint256 index);
    /// @notice The nonce arguments do not fit the codes `deploy` was given (a required role missing, a nonce beyond
    /// the last code or used twice, more than 127 codes, or the executor named twice or not at all).
    error InvalidNonces();
    error UnknownKind(uint8 kind);
    error BoxIdTooLarge(uint256 boxId);
    error TokenApproveFailed();

    /// @notice Q claims beyond the reserve (a gift to this contract) became the receiver's fees at graduation.
    event ClaimsForwarded(address indexed receiver, uint256 amount);

    // ------------------------------------------------------------------ constants

    /// @inheritdoc IBoxCoordinator
    /// @dev F95 R19M ("Raise to 2,600,000 (2x)"; F90's 1,600,000, S6's 1,000,000 before): box 0's pokes from cold after
    /// Glamsterdam need at most 1,288,181 (2.02x), the settlement of the box's first batch run by the stream's poke
    /// (SH-box0-stream-gas § POKE_GAS); each poke gets exactly this much, and the caller must leave it,
    /// POKE_GAS + POKE_GAS / 63 + 10,000 = 2,651,269 (`GasTooLow`).
    uint256 public constant POKE_GAS = 2_600_000;
    /// @notice Length of the clone arguments.
    uint256 public constant ARGS_LENGTH = 154;
    /// @notice The roles of `nonceOf`, in argument order.
    uint8 public constant ROLE_TOKEN = 0;
    uint8 public constant ROLE_VAULT = 1;
    uint8 public constant ROLE_COLLECTION = 2;
    uint8 public constant ROLE_RECEIVER = 3;
    uint8 public constant ROLE_LAUNCH_ROUTER = 4;
    uint8 public constant ROLE_TICKETS = 5;
    uint8 public constant ROLE_ROYALTY_ROUTER = 6;
    uint8 public constant ROLE_ITEM_STREAM = 7;
    uint8 public constant ROLE_EXECUTOR = 8;

    /// @dev The gas a poke needs left in this frame: POKE_GAS itself, the 1/64 EIP-150 keeps back, and the call's own
    /// costs (cold account, memory) with a margin.
    uint256 private constant _POKE_GAS_REQUIRED = POKE_GAS + POKE_GAS / 63 + 10_000;
    /// @dev Nonces 1-127 have the one-byte RLP form `_createdAt` hashes.
    uint256 private constant _MAX_CODES = 127;
    uint256 private constant _ROLES = 9;

    uint256 private constant _A_KIND = 0;
    uint256 private constant _A_Q = 1;
    uint256 private constant _A_RAISE = 21;
    uint256 private constant _A_CREATOR_BUY = 37;
    uint256 private constant _A_CREATOR = 53;
    uint256 private constant _A_SPEC_HASH = 73;
    uint256 private constant _A_EXECUTOR = 105;
    uint256 private constant _A_RANDOMNESS = 125;
    uint256 private constant _A_NONCES = 145;

    uint256 private constant _M40 = (1 << 40) - 1;
    uint256 private constant _M48 = (1 << 48) - 1;
    uint256 private constant _O_BOX_ID = 160;
    uint256 private constant _B_LAUNCHED = 1 << 208;
    uint256 private constant _O_GRADUATED_AT = 209;

    // ------------------------------------------------------------------ immutables and storage

    /// @inheritdoc IBoxCoordinator
    /// @dev Typed as an address for the interface; the same contract as `_pm`.
    address public immutable poolManager;
    /// @inheritdoc IBoxCoordinator
    address public immutable factory;

    IPoolManager internal immutable _pm;

    uint256 internal _w;
    uint256 internal _r;

    /// @inheritdoc IBoxStreamBaseline
    uint256 public streamStartBalance;
    /// @inheritdoc IBoxStreamBaseline
    uint256 public streamStartClaims;

    constructor(IPoolManager poolManager_, address factory_) {
        if (address(poolManager_) == address(0) || factory_ == address(0)) revert ZeroAddress();
        poolManager = address(poolManager_);
        _pm = poolManager_;
        factory = factory_;
        // The implementation itself is never a box: deployed and launched, so `deploy` and `launch` refuse it.
        _w = _B_LAUNCHED | 1;
    }

    // ================================================================== creation (the factory, once each)

    /// @notice The factory only, once, right after it CREATE2'd this clone: CREATEs `codes` in order (code i at this
    /// contract's nonce i + 1), then CREATE2s `hookCode` at `hookSalt` (the hook clone at its mined address), and
    /// records the hook and the registry's `boxId_`. The nonce arguments must name a created code for every required
    /// role (token, vault, collection, receiver, launch router), each at most once; the executor either here or as the
    /// `executor` argument, never both.
    /// @return hook_ the hook clone's address
    function deploy(bytes[] calldata codes, bytes calldata hookCode, bytes32 hookSalt, uint256 boxId_)
        external
        returns (address hook_)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        if (_w != 0) revert AlreadyDeployed();
        uint8 k = _argUint8(_A_KIND);
        if (k != uint8(BoxKind.Box0) && k != uint8(BoxKind.Standard)) revert UnknownKind(k);
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
    }

    /// @inheritdoc IBoxCoordinator
    /// @dev MisfitsGenesis's constructor and FitPoolGenesis.launch as calls into clones: the pinned order
    /// (core-v1-interfaces § 2), then the curve, the bootstrap buy (its T burned here, BC-004) and the creator buy.
    function launch() external payable nonReentrant {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        uint256 w = _w;
        if (w == 0) revert NotDeployed();
        if (w & _B_LAUNCHED != 0) revert AlreadyLaunched();
        uint256 buyQ = _argUint(_A_CREATOR_BUY, 16);
        uint256 required = BoxSpecV1.BOOTSTRAP_ETH + buyQ;
        if (msg.value != required) revert WrongValue(msg.value, required);
        _w = w | _B_LAUNCHED;
        IBoxHook hook_ = IBoxHook(_low160(w));
        IBoxLaunchRouter router = IBoxLaunchRouter(launchRouter());
        IBoxToken t = IBoxToken(token());

        IBoxCollection(collection()).initialize();
        IBoxVault(vault()).initialize();
        address tickets_ = tickets();
        if (tickets_ != address(0)) IBoxTickets(tickets_).initialize();
        hook_.initialize();
        router.initialize();
        IBoxReceiver(receiver()).initialize();
        // S8: the per-item stream (add-on 2) last: it checks that the receiver, collection and vault name it.
        address stream = _role(ROLE_ITEM_STREAM);
        if (stream != address(0)) IBoxItemStream(stream).initialize();

        // The hook pulls the curve's T now and the ask's T at graduation (FitPoolHook.sol:378-380); T never
        // decrements a max allowance, so neither pull writes it again.
        if (!t.approve(address(hook_), type(uint256).max)) revert TokenApproveFailed();
        hook_.launch();
        uint256 before = t.balanceOf(address(this));
        // The T is counted from this contract's balance, not from the router's figure.
        // forge-lint: disable-next-line(unused-return)
        router.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        uint256 bootstrapTokens = t.balanceOf(address(this)) - before;
        t.burn(bootstrapTokens);
        uint256 creatorTokens = buyQ == 0 ? 0 : router.creatorBuy{value: buyQ}(_argAddress(_A_CREATOR), buyQ);
        emit BoxLaunched(boxId(), hook_.openAt(), bootstrapTokens, buyQ, creatorTokens);
    }

    // ================================================================== graduation (anyone, once)

    /// @inheritdoc IBoxCoordinator
    function graduate() external nonReentrant returns (uint256 reward) {
        uint256 w = _w;
        if (w & _B_LAUNCHED == 0) revert NotLaunched();
        if ((w >> _O_GRADUATED_AT) & _M40 != 0) revert AlreadyGraduated();
        IBoxHook hook_ = IBoxHook(_low160(w));
        if (!hook_.closed()) revert NotClosed();
        // Written before any call: the receiver, the executor and the royalty router read it.
        _w = w | (block.timestamp << _O_GRADUATED_AT);

        // The box's own contracts and the PoolManager only, until the pokes (BC-098).
        IBoxToken t = IBoxToken(token());
        uint256 share = t.balanceOf(address(this));
        // The hook's `Migrated` event carries what it returns; the coordinator needs only the T left with it.
        // forge-lint: disable-next-line(unused-return)
        hook_.migrate(share);
        uint256 dust = t.balanceOf(address(this));
        if (dust != 0) t.burn(dust);
        // M28: migration harvested every position. Snapshot using only T and the PoolManager, never the stream
        // or receiver's code. Settlement later excludes the receiver's held curve-depth claims from this gross R.
        address stream_ = _role(ROLE_ITEM_STREAM);
        if (stream_ != address(0)) {
            streamStartBalance = t.balanceOf(stream_);
            streamStartClaims = _pm.balanceOf(receiver(), uint256(uint160(address(t))));
        }
        IBoxVault(vault()).openGate();

        // D6: the reserve the hook minted here, from the curve's Q fees only, never above 0.1% of R (BC-027).
        uint256 id = uint256(uint160(_argAddress(_A_Q)));
        uint256 held = _pm.balanceOf(address(this), id);
        reward = hook_.reserveMinted();
        uint256 cap = rewardCap();
        if (reward > cap) reward = cap;
        if (reward > held) reward = held;
        if (reward != 0) _r = uint256(uint160(msg.sender)) | (reward << 160);
        address receiver_ = receiver();
        if (held > reward) {
            // Claims nobody minted as the reserve: a gift, which the receiver counts as the next batch's fees.
            // ERC-6909 `transfer` of this contract's own claims: returns true or reverts (v4-core ERC6909.sol).
            // forge-lint: disable-next-line(unused-return)
            _pm.transfer(receiver_, id, held - reward);
            emit ClaimsForwarded(receiver_, held - reward);
        }
        emit Graduated(msg.sender, block.number, share, dust, reward);

        // The pokes: fail-safe, each with exactly POKE_GAS; anyone repeats a failed one later.
        _poke(receiver_, IBoxReceiver.onGraduation.selector);
        address tickets_ = tickets();
        if (tickets_ != address(0)) _poke(tickets_, IBoxTickets.requestGraduationWord.selector);
        _poke(executor(), IBoxPriceAverage.poke.selector);
        _poke(stream_, IBoxItemStream.onGraduation.selector);
    }

    /// @inheritdoc IBoxCoordinator
    function claimReward(address to) external nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        uint256 r = _r;
        amount = r >> 160;
        if (amount == 0 || _low160(r) != msg.sender) revert NothingToClaim();
        _r = 0;
        emit RewardClaimed(msg.sender, to, amount);
        // A recipient that refuses Q reverts all of this: the claim stays for another `to`.
        try _pm.unlock(abi.encode(to, amount)) {}
        catch {
            revert ClaimFailed();
        }
    }

    /// @notice PoolManager callback of this contract's own unlock (inside `claimReward` only): burns the claims and
    /// takes the Q to the recipient.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_pm) || !_insideGuardedCall()) revert NotPoolManager();
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        address q_ = _argAddress(_A_Q);
        _pm.burn(address(this), uint256(uint160(q_)), amount);
        _pm.take(Currency.wrap(q_), to, amount);
        return "";
    }

    // ================================================================== views: state

    /// @inheritdoc IBoxCoordinator
    function phase() external view returns (BoxPhase) {
        uint256 w = _w;
        if (w & _B_LAUNCHED == 0) return BoxPhase.None;
        if ((w >> _O_GRADUATED_AT) & _M40 != 0) return BoxPhase.Graduated;
        return IBoxHook(_low160(w)).phase();
    }

    /// @inheritdoc IBoxCoordinator
    function graduated() public view returns (bool) {
        return (_w >> _O_GRADUATED_AT) & _M40 != 0;
    }

    /// @inheritdoc IBoxCoordinator
    function graduatedAt() external view returns (uint256) {
        return (_w >> _O_GRADUATED_AT) & _M40;
    }

    /// @inheritdoc IBoxCoordinator
    function graduatedAtBlock() external view returns (uint256) {
        uint256 w = _w;
        if ((w >> _O_GRADUATED_AT) & _M40 == 0) return 0;
        return IBoxHook(_low160(w)).migratedAtBlock();
    }

    /// @inheritdoc IBoxCoordinator
    function rewardOf(address account) external view returns (uint256) {
        uint256 r = _r;
        return _low160(r) == account ? r >> 160 : 0;
    }

    /// @inheritdoc IBoxCoordinator
    /// @dev Before graduation min(the reserve the hook minted here, the Q claims held); 0 once it was credited.
    function reserve() external view returns (uint256) {
        uint256 w = _w;
        address hook_ = _low160(w);
        if (w & _B_LAUNCHED == 0 || (w >> _O_GRADUATED_AT) & _M40 != 0) return 0;
        uint256 held = _pm.balanceOf(address(this), uint256(uint160(_argAddress(_A_Q))));
        uint256 minted = IBoxHook(hook_).reserveMinted();
        return minted < held ? minted : held;
    }

    /// @notice D6's cap: 0.1% of R (BoxSpecV1.GRADUATION_REWARD_CAP_BPS), the hook's `reserveCap()` for the same raise.
    function rewardCap() public view returns (uint256) {
        return _argUint(_A_RAISE, 16) * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000;
    }

    /// @inheritdoc IBoxCoordinator
    function poolShare() external view returns (uint256) {
        uint256 w = _w;
        if (w & _B_LAUNCHED == 0 || (w >> _O_GRADUATED_AT) & _M40 != 0) return 0;
        return IBoxToken(token()).balanceOf(address(this));
    }

    // ================================================================== views: wiring

    /// @inheritdoc IBoxCoordinator
    function boxId() public view returns (uint256) {
        return (_w >> _O_BOX_ID) & _M48;
    }

    /// @inheritdoc IBoxCoordinator
    function kind() external view returns (BoxKind) {
        return BoxKind(_argUint8(_A_KIND));
    }

    /// @inheritdoc IBoxCoordinator
    function specHash() external view returns (bytes32) {
        return bytes32(_argUint(_A_SPEC_HASH, 32));
    }

    /// @inheritdoc IBoxCoordinator
    function creator() external view returns (address) {
        return _argAddress(_A_CREATOR);
    }

    /// @inheritdoc IBoxCoordinator
    function q() external view returns (address) {
        return _argAddress(_A_Q);
    }

    /// @inheritdoc IBoxCoordinator
    function raise() external view returns (uint256) {
        return _argUint(_A_RAISE, 16);
    }

    /// @inheritdoc IBoxCoordinator
    function creatorBuyAmount() external view returns (uint256) {
        return _argUint(_A_CREATOR_BUY, 16);
    }

    /// @inheritdoc IBoxCoordinator
    function hook() external view returns (address) {
        return _low160(_w);
    }

    /// @inheritdoc IBoxCoordinator
    function token() public view returns (address) {
        return _role(ROLE_TOKEN);
    }

    /// @inheritdoc IBoxCoordinator
    function vault() public view returns (address) {
        return _role(ROLE_VAULT);
    }

    /// @inheritdoc IBoxCoordinator
    function collection() public view returns (address) {
        return _role(ROLE_COLLECTION);
    }

    /// @inheritdoc IBoxCoordinator
    function receiver() public view returns (address) {
        return _role(ROLE_RECEIVER);
    }

    /// @inheritdoc IBoxCoordinator
    function launchRouter() public view returns (address) {
        return _role(ROLE_LAUNCH_ROUTER);
    }

    /// @inheritdoc IBoxCoordinator
    function tickets() public view returns (address) {
        return _role(ROLE_TICKETS);
    }

    /// @inheritdoc IBoxCoordinator
    function royaltyRouter() external view returns (address) {
        return _role(ROLE_ROYALTY_ROUTER);
    }

    /// @inheritdoc IBoxCoordinator
    function itemStream() external view returns (address) {
        return _role(ROLE_ITEM_STREAM);
    }

    /// @inheritdoc IBoxCoordinator
    /// @dev Created here (box 0: FIT's executor is born with box 0, BC-064) or the `executor` argument.
    function executor() public view returns (address) {
        address created = _role(ROLE_EXECUTOR);
        return created != address(0) ? created : _argAddress(_A_EXECUTOR);
    }

    /// @inheritdoc IBoxCoordinator
    function randomness() external view returns (address) {
        return _argAddress(_A_RANDOMNESS);
    }

    /// @notice The CREATE nonce a role's contract was created at by `deploy` (0: the box has none).
    function nonceOf(uint8 role) external view returns (uint256) {
        if (role >= _ROLES) return 0;
        return _argUint8(_A_NONCES + role);
    }

    // ================================================================== internals

    /// @dev The address in the low 160 bits of a storage word (`_w`: the hook; `_r`: the reward's holder).
    function _low160(uint256 word) private pure returns (address) {
        // casting to 'uint160' is safe because these words store an address in exactly their low 160 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(word));
    }

    /// @dev The address `deploy` created a role's contract at (`_createdAt` of its nonce), or zero for a nonce of 0.
    function _role(uint256 role) private view returns (address) {
        uint256 nonce = _argUint8(_A_NONCES + role);
        return nonce == 0 ? address(0) : _createdAt(nonce);
    }

    /// @dev keccak256(rlp([this, nonce]))[12:] for 1 ≤ nonce ≤ 127 (rlp: 0xd6 0x94 ‖ address ‖ nonce), as
    /// CreateAddress.compute (src/libraries/CreateAddress.sol) in scratch memory.
    function _createdAt(uint256 nonce) private view returns (address a) {
        assembly ("memory-safe") {
            mstore(0x00, or(shl(248, 0xd6), or(shl(240, 0x94), shl(80, address()))))
            mstore8(0x16, nonce)
            a := and(keccak256(0x00, 0x17), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    /// @dev The nonce arguments against `n` codes: every required role at a nonce in [1, n], the optional ones at 0 or
    /// in [1, n], no nonce twice, and the executor created here exactly when the `executor` argument is zero.
    function _checkNonces(uint256 n) private view {
        if (n == 0 || n > _MAX_CODES) revert InvalidNonces();
        uint256 seen = 0;
        for (uint256 role; role < _ROLES; ++role) {
            uint256 nonce = _argUint8(_A_NONCES + role);
            if (nonce == 0) {
                if (role <= ROLE_LAUNCH_ROUTER) revert InvalidNonces();
                continue;
            }
            if (nonce > n || seen & (1 << nonce) != 0) revert InvalidNonces();
            seen |= 1 << nonce;
        }
        bool createdHere = _argUint8(_A_NONCES + ROLE_EXECUTOR) != 0;
        if (createdHere == (_argAddress(_A_EXECUTOR) != address(0))) revert InvalidNonces();
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

    /// @dev One fail-safe poke: `selector` with no arguments, exactly POKE_GAS, no value, no return data copied. The
    /// caller must leave enough gas for the whole budget (else `GasTooLow`); a revert or an exhausted budget is logged.
    function _poke(address target, bytes4 selector) private {
        if (target == address(0)) return;
        bool ok;
        uint256 left = gasleft();
        if (left < _POKE_GAS_REQUIRED) revert GasTooLow(left, _POKE_GAS_REQUIRED);
        assembly ("memory-safe") {
            mstore(0x00, selector)
            ok := call(POKE_GAS, target, 0, 0x00, 0x04, 0x00, 0x00)
        }
        if (!ok) emit PokeFailed(target, selector);
    }
}
