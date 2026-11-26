// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types, libraries; DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxCoordinator} from "./BoxCoordinator.sol";
import {BoxFactoryV1Planner} from "./BoxFactoryV1Planner.sol";
import {BoxLayoutV1} from "./BoxLayoutV1.sol";
import {BoxRegistry} from "./BoxRegistry.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {BoxToken} from "./BoxToken.sol";
import {IBoxCollection} from "./interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "./interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "./interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "./interfaces/IBoxHook.sol";
import {IBoxItemStream} from "./interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "./interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxToken} from "./interfaces/IBoxToken.sol";
import {IBoxRoyaltyRouter} from "./interfaces/IBoxRoyaltyRouter.sol";
import {IBoxTickets} from "./interfaces/IBoxTickets.sol";
import {IBoxVault} from "./interfaces/IBoxVault.sol";
import {BoxKind, BoxPhase} from "./interfaces/BoxTypes.sol";
import {BoxClones} from "./libraries/BoxClones.sol";
import {BackedSourcePins} from "./randomness/BackedSourcePins.sol";
import {DrandSourcePins} from "./randomness/DrandSourcePins.sol";
import {BoxBuildGuard} from "sh-box-build/BoxBuildV1.sol";

/// @notice The wiring getters the factory's constructor reads from the version's implementations.
interface IBoxImplementationWiring {
    function coordinatorImplementation() external view returns (address);
    function extension() external view returns (address);
    function poolManager() external view returns (address);
    function factory() external view returns (address);
}

/// @notice What the re-reads read from FIT's executor (FitBuybackExecutor's immutables and its first sample).
interface IFitExecutorWiring {
    function poolManager() external view returns (address);
    function token() external view returns (address);
    function launchPhase() external view returns (address);
    function hooks() external view returns (address);
    function receiver() external view returns (address);
    function latestSampleTick() external view returns (int24);
}

/// @title BoxFactoryV1 (slice S7: factory v1, box 0 only)
/// @notice See `IBoxFactoryV1`. The trust-bearing half of factory v1: who may create (`box0Creator`, once), the pins
/// fixed at deployment (box 0's source, the chain's BoxBackedSource by `BackedSourcePins.isPinned`, and the DrandSource
/// it names by `DrandSourcePins.isPinned`, BC-101 and F143; every implementation naming
/// this version, BC-100; FIT's executor's creation code by hash), the creation itself, the re-reads and the registry.
/// The pure half (validate(), the template-0 rules, every argument encoding, T's creation code) is
/// `BoxFactoryV1Planner`, called with this factory's fixed values. This contract does not take the planner's word for
/// what it created (review of the Misfits line, finding 1): after the launch it checks that every contract is the
/// version's code (each clone's proxy names the version's implementation, the royalty router's the receiving variant;
/// T's creation code is this contract's own, FIT's executor's the hashed one) and re-reads what bears trust: who names
/// whom, the pinned drand source where the tickets read it, the open time, the pool, T's issue, name and symbol, the
/// coordinator's raise and creator, the vault's fee rates, the Safe, FIT's executor's phase, pool, hook, receiver and
/// first sample (P1). What the planner encodes and no re-read covers (the collection's and the tickets' texts, the art
/// commitments other than the reveal root and the table, the royalty rate and the curve's arguments behind the pool's
/// re-read) follows from the planner's code, whose hash is in `versionCodeHash` and so in every template id.
///
/// Replaces `CoreBox0Builder` (SH-core-wave-2's test stand-in) on chain: the same argument layouts and, for nonces 1-8,
/// the same nonce plan (`BoxFactoryV1Planner`); since the S7 × S8 integration box 0 is created with its per-item stream
/// (add-on 2, S8: F61 X1, F77) at nonce 9, wired into its collection, vault and receiver. Generalises MisfitsGenesis's constructor (src/v2/genesis/MisfitsGenesis.sol:218-233: the
/// bootstrap value, reveal on exit only, the randomness pin, now at deployment) and its re-checks (`_verifyNftSide`,
/// `:387-417`; FitPoolGenesis.verify, src/v2/genesis/FitPoolGenesis.sol:123-199), adapted to D1 and D2 (no latch and
/// no FitFeeCollector: the receiver, the hook's phase and the closed pool instead) and F77 (the launch router names no
/// Safe; FitPoolGenesis's router-treasury check is dropped by design, BC-063).
///
/// **Box 0's curve** is a version constant (one Q, native ETH, and one raise, R F74 U5): computed once in the
/// constructor from `BoxLayoutV1` (its bisection runs there only) and proved again by the hook at launch.
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2). Holds no money: the bootstrap passes through in
/// the same call (`MW_ETH`). BoxBuildGuard (F78): empty in the mainnet build; the rehearsal build's constructor refuses
/// chain id 1. Written for Square Hole (MIT).
contract BoxFactoryV1 is BoxBuildGuard, IBoxFactoryV1 {
    // ------------------------------------------------------------------ version constants

    /// @inheritdoc IBoxFactoryV1
    uint16 public constant VERSION = 1;
    /// @notice This factory's CREATE nonces: the registry (constructor), then box 0's coordinator (createBox).
    uint8 public constant FACTORY_NONCE_REGISTRY = 1;
    uint8 public constant FACTORY_NONCE_BOX0 = 2;
    /// @dev The low 14 bits of a v4 hook address are its permission flags (Hooks.sol).
    uint160 internal constant _FLAG_MASK = 0x3FFF;
    /// @dev Pool.State in the PoolManager at 46c68346, read by value (StateLibrary imports BUSL code, so src/ does not):
    /// the pools mapping's slot and the active liquidity's offset in a pool's state (as BoxHookBase reads them).
    bytes32 internal constant _POOLS_SLOT = bytes32(uint256(6));
    uint256 internal constant _LIQUIDITY_OFFSET = 3;
    /// @dev The planner's NONCE_TOKEN - 1 and NONCE_EXECUTOR - 1: T's and FIT's executor's slots in the codes.
    uint256 internal constant _TOKEN_CODE = 1;
    uint256 internal constant _EXECUTOR_CODE = 6;
    /// @dev BoxCollection's reveal trigger for hidden art (the planner's REVEAL_ON_EXIT): reveal on exit only.
    uint8 internal constant _REVEAL_ON_EXIT = 1;

    /// @notice `Miswired` ids (the re-reads of step 3).
    uint256 public constant MW_COORDINATOR = 1;
    uint256 public constant MW_HOOK = 2;
    uint256 public constant MW_EXECUTOR = 3;
    uint256 public constant MW_POOL = 4;
    uint256 public constant MW_SUPPLY = 5;
    uint256 public constant MW_VAULT = 6;
    uint256 public constant MW_COLLECTION = 7;
    uint256 public constant MW_ROUTER = 8;
    uint256 public constant MW_RECEIVER = 9;
    uint256 public constant MW_ETH = 10;
    /// @notice The per-item stream (S8): a clone of the version's stream naming box 0, not started.
    uint256 public constant MW_STREAM = 11;
    /// @notice The tickets add-on: a clone of the version's tickets reading the pinned source, open with the hook.
    uint256 public constant MW_TICKETS = 12;
    /// @notice The royalty router: a receiving clone of the version's router naming box 0's receiver.
    uint256 public constant MW_ROYALTY = 13;

    /// @notice `ImplementationMiswired` ids.
    uint256 public constant IMPL_COORDINATOR = 1;
    uint256 public constant IMPL_HOOK = 2;
    uint256 public constant IMPL_LAUNCH_ROUTER = 3;
    uint256 public constant IMPL_RECEIVER = 4;
    uint256 public constant IMPL_COLLECTION = 5;
    uint256 public constant IMPL_VAULT = 6;
    uint256 public constant IMPL_TICKETS = 7;
    uint256 public constant IMPL_ITEM_STREAM = 8;

    // ------------------------------------------------------------------ immutables

    IPoolManager internal immutable _pm;
    /// @notice The pure half (validate(), the template-0 rules, the codes).
    BoxFactoryV1Planner public immutable planner;
    /// @inheritdoc IBoxFactoryV1
    address public immutable registry;
    /// @inheritdoc IBoxFactoryV1
    address public immutable randomness;
    /// @inheritdoc IBoxFactoryV1
    address public immutable weth;
    /// @inheritdoc IBoxFactoryV1
    address public immutable platformSafe;
    /// @inheritdoc IBoxFactoryV1
    address public immutable box0Creator;
    /// @inheritdoc IBoxFactoryV1
    bytes32 public immutable executorInitCodeHash;
    /// @inheritdoc IBoxFactoryV1
    bytes32 public immutable versionCodeHash;
    /// @inheritdoc IBoxFactoryV1
    address public immutable hookExtension;
    /// @inheritdoc IBoxFactoryV1
    address public immutable receiverExtension;

    address internal immutable _iCoordinator;
    address internal immutable _iHook;
    address internal immutable _iRouter;
    address internal immutable _iReceiver;
    address internal immutable _iCollection;
    address internal immutable _iVault;
    address internal immutable _iTickets;
    address internal immutable _iRoyalty;
    address internal immutable _iStream;

    /// @dev Box 0's coordinator: CREATE(this, FACTORY_NONCE_BOX0).
    address internal immutable _box0;

    /// @dev Box 0's curve (BoxLayoutV1.curve(R, Q as currency0)).
    int24 internal immutable _tickLower;
    int24 internal immutable _tickUpper;
    uint160 internal immutable _sqrtLower;
    uint160 internal immutable _sqrtUpper;
    uint128 internal immutable _liquidity;
    uint256 internal immutable _poolShare;
    uint256 internal immutable _raise;

    /// @param poolManager_ the chain's Uniswap v4 PoolManager
    /// @param impls the version's implementations; `impls.coordinator`'s `factory` must be this contract
    /// @param planner_ the version's planner
    /// @param randomness_ the chain's pinned BoxBackedSource (BackedSourcePins.isPinned; BC-101, F143), whose pinned code
    /// names the chain's pinned DrandSource (DrandSourcePins.isPinned; the same address on chains 1 and 11155111)
    /// @param weth_ the chain's WETH (the royalty router unwraps marketplaces' WETH)
    /// @param platformSafe_ the platform Safe (box 0's capped 2/15 and its marketplaceOwner)
    /// @param box0Creator_ the only caller of `createBox`
    /// @param executorInitCodeHash_ keccak256 of FIT's executor's creation code
    constructor(
        IPoolManager poolManager_,
        Implementations memory impls,
        BoxFactoryV1Planner planner_,
        address randomness_,
        address weth_,
        address platformSafe_,
        address box0Creator_,
        bytes32 executorInitCodeHash_
    ) {
        if (
            platformSafe_ == address(0) || box0Creator_ == address(0) || executorInitCodeHash_ == bytes32(0)
                || randomness_ == address(0) || weth_ == address(0)
        ) revert ZeroAddress();
        _hasCode(address(poolManager_));
        _hasCode(address(planner_));
        _hasCode(weth_);
        if (!BackedSourcePins.isPinned(randomness_)) revert SourceNotPinned(randomness_);
        if (!DrandSourcePins.isPinned(DrandSourcePins.ADDRESS_MAINNET)) {
            revert SourceNotPinned(DrandSourcePins.ADDRESS_MAINNET);
        }
        (address hookExt, address receiverExt) = _wired(impls, address(poolManager_));
        _pm = poolManager_;
        planner = planner_;
        randomness = randomness_;
        weth = weth_;
        platformSafe = platformSafe_;
        box0Creator = box0Creator_;
        executorInitCodeHash = executorInitCodeHash_;
        hookExtension = hookExt;
        receiverExtension = receiverExt;
        (_iCoordinator, _iHook, _iRouter, _iReceiver) =
        (impls.coordinator, impls.hook, impls.launchRouter, impls.receiver);
        (_iCollection, _iVault, _iTickets, _iRoyalty, _iStream) =
        (impls.collection, impls.vault, impls.tickets, impls.royaltyRouter, impls.itemStream);
        versionCodeHash = _versionCodeHash(impls, hookExt, receiverExt, address(planner_));
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(BoxSpecV1.qListV1()[0].raisePresets[0], false);
        (_tickLower, _tickUpper, _sqrtLower, _sqrtUpper) =
        (c.tickLower, c.tickUpper, c.sqrtPriceLowerX96, c.sqrtPriceUpperX96);
        (_liquidity, _poolShare, _raise) = (c.liquidity, c.poolShare, c.raise);
        registry = address(new BoxRegistry());
        _box0 = _createAddress(address(this), FACTORY_NONCE_BOX0);
    }

    // ================================================================== createBox

    /// @inheritdoc IBoxFactoryV1
    function createBox(BoxSpecV1.BoxSpec memory spec, bytes32 hookSalt, bytes calldata executorCode)
        external
        payable
        returns (uint256 boxId, address coordinator, address hook)
    {
        _revertWith(_refusal(spec, msg.sender));
        if (msg.value != BoxSpecV1.BOOTSTRAP_ETH) revert WrongValue(msg.value, BoxSpecV1.BOOTSTRAP_ETH);
        bytes32 codeHash = keccak256(executorCode);
        if (codeHash != executorInitCodeHash) revert ExecutorCodeMismatch(codeHash);
        bytes memory encoded = abi.encode(spec);
        BoxFactoryV1Planner.Plan memory p = planner.plan(spec, _version(), msg.sender, hookSalt, keccak256(encoded));
        if (!_flagsMined(p.hook)) revert HookSaltNotMined(p.hook);
        // ETH is compared with what this contract held before the call, never with zero (FitPoolGenesis's dust rule:
        // ETH anyone sent to a predicted address must not block the creation). The calls below are to this version's
        // own contracts and the PoolManager; the balance is read again after all of them on purpose (MW_ETH).
        // forge-lint: disable-start(reentrancy-balance)
        uint256 ethBefore = address(this).balance - msg.value;
        boxId = BoxRegistry(registry).boxCount();

        coordinator = BoxClones.create(p.coordinatorInit);
        // A CREATE address says nothing about the code: the coordinator must also be a clone of this version's.
        if (coordinator != _box0 || p.a.coordinator != _box0 || !BoxClones.isCloneOf(coordinator, _iCoordinator)) {
            revert Miswired(MW_COORDINATOR);
        }
        p.codes[_TOKEN_CODE] = bytes.concat(type(BoxToken).creationCode, p.codes[_TOKEN_CODE]);
        p.codes[_EXECUTOR_CODE] = bytes.concat(executorCode, p.codes[_EXECUTOR_CODE]);
        hook = BoxCoordinator(coordinator).deploy(p.codes, p.hookInit, hookSalt, boxId);
        if (hook != p.hook) revert Miswired(MW_HOOK);
        BoxCoordinator(coordinator).launch{value: BoxSpecV1.BOOTSTRAP_ETH}();

        _verify(spec, p);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (address(this).balance != ethBefore) revert Miswired(MW_ETH);
        // forge-lint: disable-end(reentrancy-balance)
        if (BoxRegistry(registry).record(coordinator, p.templateId, encoded) != boxId) revert Miswired(MW_COORDINATOR);
    }

    // ================================================================== views

    /// @inheritdoc IBoxFactoryV1
    function refusal(BoxSpecV1.BoxSpec memory spec, address caller) external view returns (bytes memory) {
        return _refusal(spec, caller);
    }

    /// @inheritdoc IBoxFactoryV1
    function templateIdOf(BoxSpecV1.BoxSpec memory spec) external view returns (bytes32) {
        return planner.templateIdOf(spec, versionCodeHash, executorInitCodeHash);
    }

    /// @inheritdoc IBoxFactoryV1
    function box0Addresses() external view returns (Box0Addresses memory) {
        return planner.addresses(_box0, true);
    }

    /// @inheritdoc IBoxFactoryV1
    function hookInitCodeHash(uint32 openAt) public view returns (bytes32) {
        return keccak256(planner.hookInitCode(_version(), planner.addresses(_box0, true), openAt));
    }

    /// @inheritdoc IBoxFactoryV1
    function predictHook(uint32 openAt, bytes32 hookSalt) external view returns (address) {
        return BoxClones.predict(_box0, hookSalt, hookInitCodeHash(openAt));
    }

    /// @inheritdoc IBoxFactoryV1
    function poolManager() external view returns (address) {
        return address(_pm);
    }

    /// @inheritdoc IBoxFactoryV1
    function implementations() external view returns (Implementations memory) {
        return Implementations({
            coordinator: _iCoordinator,
            hook: _iHook,
            launchRouter: _iRouter,
            receiver: _iReceiver,
            collection: _iCollection,
            vault: _iVault,
            tickets: _iTickets,
            royaltyRouter: _iRoyalty,
            itemStream: _iStream
        });
    }

    /// @notice What this factory passes the planner: the version's fixed values and box 0's coordinator address.
    function version() external view returns (BoxFactoryV1Planner.Version memory) {
        return _version();
    }

    // ================================================================== internals

    /// @dev Step 1's caller, registry and spec checks, as the revert data `createBox` gives (empty: accepted).
    function _refusal(BoxSpecV1.BoxSpec memory s, address caller) internal view returns (bytes memory) {
        if (caller != box0Creator) return abi.encodeWithSelector(NotBox0Creator.selector, caller);
        if (BoxRegistry(registry).boxCount() != 0) return abi.encodeWithSelector(Box0Exists.selector);
        // openAt's horizon (F80) needs the block's time, so it is checked here and not in the pure validate().
        uint256 latest = block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS;
        if (s.openAt > latest) return abi.encodeWithSelector(OpenAtTooFar.selector, s.openAt, latest);
        return planner.refusal(s, platformSafe);
    }

    function _revertWith(bytes memory err) internal pure {
        if (err.length == 0) return;
        assembly ("memory-safe") {
            revert(add(err, 0x20), mload(err))
        }
    }

    function _version() internal view returns (BoxFactoryV1Planner.Version memory v) {
        v.poolManager = address(_pm);
        v.randomness = randomness;
        v.weth = weth;
        v.platformSafe = platformSafe;
        v.coordinatorImpl = _iCoordinator;
        v.hookImpl = _iHook;
        v.launchRouterImpl = _iRouter;
        v.receiverImpl = _iReceiver;
        v.collectionImpl = _iCollection;
        v.vaultImpl = _iVault;
        v.ticketsImpl = _iTickets;
        v.royaltyRouterImpl = _iRoyalty;
        v.itemStreamImpl = _iStream;
        v.versionCodeHash = versionCodeHash;
        v.executorInitCodeHash = executorInitCodeHash;
        v.coordinator = _box0;
        v.tickLower = _tickLower;
        v.tickUpper = _tickUpper;
        v.sqrtLower = _sqrtLower;
        v.sqrtUpper = _sqrtUpper;
        v.liquidity = _liquidity;
        v.raise = _raise;
    }

    /// @dev A hook address carries exactly the flags 0x2AE0 and does not start with 0x91 (BoxSpecV1 HOOK_FLAGS,
    /// HOOK_FORBIDDEN_ADDRESS_PREFIX).
    function _flagsMined(address hook) internal pure returns (bool) {
        uint160 h = uint160(hook);
        return h & _FLAG_MASK == BoxSpecV1.HOOK_FLAGS && h >> 152 != BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX;
    }

    // ================================================================== re-reads after the launch (BC-063)

    /// @dev MisfitsGenesis's and FitPoolGenesis's re-checks with the spec's values, adapted to D1/D2 and core v1, after
    /// the code (`_verifyCode`): the coordinator's wiring, the hook on the curve, FIT's executor born here and wired to
    /// box 0, the pool, T's issue and the pool share, the vault and collection holding all N with the stream as their
    /// observer, the tickets on the pinned source, the launch router bootstrapped and empty, the receiver wired to FIT's
    /// executor, the Safe and the stream with no module, the stream itself (S8), the royalty router. Getters without
    /// arguments are read through `_reads` (one word, a failed call a refusal; since the review of the Misfits line,
    /// which made room for the code checks under EIP-170).
    function _verify(BoxSpecV1.BoxSpec memory s, BoxFactoryV1Planner.Plan memory p) internal view {
        Box0Addresses memory a = p.a;
        _verifyCode(p);
        address c = a.coordinator;
        if (
            !_names(c, IBoxCoordinator.token.selector, a.token) || !_names(c, IBoxCoordinator.vault.selector, a.vault)
                || !_names(c, IBoxCoordinator.collection.selector, a.collection)
                || !_names(c, IBoxCoordinator.receiver.selector, a.receiver)
                || !_names(c, IBoxCoordinator.launchRouter.selector, a.launchRouter)
                || !_names(c, IBoxCoordinator.tickets.selector, a.tickets)
                || !_names(c, IBoxCoordinator.royaltyRouter.selector, a.royaltyRouter)
                || !_names(c, IBoxCoordinator.randomness.selector, randomness)
                || !_reads(c, IBoxCoordinator.specHash.selector, uint256(p.specHash))
                || !_reads(c, IBoxCoordinator.kind.selector, uint8(BoxKind.Box0))
                || !_names(c, IBoxCoordinator.hook.selector, p.hook)
                || !_names(c, IBoxCoordinator.itemStream.selector, a.itemStream)
                || !_reads(c, IBoxCoordinator.raise.selector, _raise)
                || !_names(c, IBoxCoordinator.creator.selector, box0Creator)
        ) revert Miswired(MW_COORDINATOR);
        address h = p.hook;
        // The open every initialize derives from the spec's openAt (BoxHook.initialize: Now or a time reached opens in
        // the next block); the hook, the launch router and the tickets must all hold it.
        uint256 open = s.openAt <= block.timestamp ? block.timestamp + 1 : s.openAt;
        if (
            !_names(h, IBoxHook.coordinator.selector, c) || !_names(h, IBoxHook.token.selector, a.token)
                || !_reads(h, IBoxHook.deployBlock.selector, block.number) || !_reads(h, IBoxHook.openAt.selector, open)
                || !_reads(h, IBoxHook.phase.selector, uint8(BoxPhase.Upcoming))
                || !_names(h, IBoxHook.receiver.selector, a.receiver)
                || !_names(h, IBoxHook.priceAverage.selector, a.executor)
        ) revert Miswired(MW_HOOK);
        _verifyExecutor(a, h);
        _verifyPool(s, a, IBoxHook(h).poolId());
        _verifyItems(s, a, open);
        address r = a.launchRouter;
        if (
            !_reads(r, IBoxLaunchRouter.bootstrapped.selector, 1)
                || !_reads(r, IBoxLaunchRouter.totalTaxCollected.selector, 0)
                || !_reads(r, IBoxLaunchRouter.openAt.selector, open) || !_names(r, IBoxLaunchRouter.hook.selector, h)
                || !_names(r, IBoxLaunchRouter.token.selector, a.token)
        ) revert Miswired(MW_ROUTER);
        r = a.receiver;
        if (
            !_reads(r, IBoxReceiver.kind.selector, uint8(BoxKind.Box0))
                || !_names(r, IBoxReceiver.platformSafe.selector, platformSafe)
                || !_names(r, IBoxReceiver.executor.selector, a.executor)
                || !_names(r, IBoxReceiver.swapModule.selector, address(0)) || !_names(r, IBoxReceiver.hook.selector, h)
                || !_names(r, IBoxReceiver.itemStream.selector, a.itemStream)
                || !_names(r, IBoxReceiver.token.selector, a.token)
        ) revert Miswired(MW_RECEIVER);
        _verifyStream(a, h);
        _verifyRoyalty(a);
    }

    /// @dev Before any getter is trusted, the code (review of the Misfits line, finding 1): a CREATE address says
    /// nothing about the code behind it, and a getter of other code can answer anything. Every clone the coordinator
    /// created from the planner's codes is a clone of this version's implementation (the coordinator's own was checked
    /// at its creation); the royalty router, when the spec has it, the receiving variant (BC-114). T's creation code is
    /// this contract's own and FIT's executor's was checked by hash before the creation; the table's bytes were checked
    /// against its hash by the collection's `initialize`.
    function _verifyCode(BoxFactoryV1Planner.Plan memory p) internal view {
        Box0Addresses memory a = p.a;
        address[7] memory at = [p.hook, a.launchRouter, a.receiver, a.collection, a.vault, a.tickets, a.itemStream];
        address[7] memory impl = [_iHook, _iRouter, _iReceiver, _iCollection, _iVault, _iTickets, _iStream];
        uint256[7] memory check = [MW_HOOK, MW_ROUTER, MW_RECEIVER, MW_COLLECTION, MW_VAULT, MW_TICKETS, MW_STREAM];
        for (uint256 i; i < 7; ++i) {
            // The refusal ends the whole creation, which is the point of the check.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!BoxClones.isCloneOf(at[i], impl[i])) revert Miswired(check[i]);
        }
        if (a.royaltyRouter != address(0) && !BoxClones.isReceivingCloneOf(a.royaltyRouter, _iRoyalty)) {
            revert Miswired(MW_ROYALTY);
        }
    }

    /// @dev FIT's executor: born here (its creation code checked by hash before the creation, and code left), and its
    /// arguments, which its address cannot tell: the PoolManager, box 0's T, coordinator (the phase it trusts), hook and
    /// receiver, and its first sample at P1, where graduate() leaves the price (review of the Misfits line, finding 4).
    function _verifyExecutor(Box0Addresses memory a, address hook) internal view {
        address x = a.executor;
        // casting to 'uint256' is safe because it is the ABI word of the signed tick P1 (two's complement)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 p1 = uint256(int256(_tickLower));
        if (
            !_names(a.coordinator, IBoxCoordinator.executor.selector, x) || x.code.length == 0
                || !_names(x, IFitExecutorWiring.poolManager.selector, address(_pm))
                || !_names(x, IFitExecutorWiring.token.selector, a.token)
                || !_names(x, IFitExecutorWiring.launchPhase.selector, a.coordinator)
                || !_names(x, IFitExecutorWiring.hooks.selector, hook)
                || !_names(x, IFitExecutorWiring.receiver.selector, a.receiver)
                || !_reads(x, IFitExecutorWiring.latestSampleTick.selector, p1)
        ) revert Miswired(MW_EXECUTOR);
    }

    /// @dev The royalty router (with the royalties add-on; its code checked in `_verifyCode`) names box 0's coordinator
    /// and receiver and the chain's WETH.
    function _verifyRoyalty(Box0Addresses memory a) internal view {
        address rr = a.royaltyRouter;
        if (
            rr != address(0)
                && (!_names(rr, IBoxRoyaltyRouter.coordinator.selector, a.coordinator)
                    || !_names(rr, IBoxRoyaltyRouter.receiver.selector, a.receiver)
                    || !_names(rr, IBoxRoyaltyRouter.weth.selector, weth))
        ) revert Miswired(MW_ROYALTY);
    }

    /// @dev The per-item stream (S8; its code checked in `_verifyCode`): its arguments name box 0's coordinator,
    /// receiver, vault, collection and hook, not started (it starts at graduation). The coordinator initialised it at
    /// the launch, and the stream's `initialize` (BoxItemStream `_checkWiring`) refused unless the receiver, vault and
    /// collection name it and its T, tickets, N, firstId and curve ticks are the vault's and the hook's, which the
    /// re-reads above fix to box 0's.
    function _verifyStream(Box0Addresses memory a, address hook) internal view {
        address st = a.itemStream;
        if (
            !_names(st, IBoxItemStream.coordinator.selector, a.coordinator)
                || !_names(st, IBoxItemStream.receiver.selector, a.receiver)
                || !_names(st, IBoxItemStream.vault.selector, a.vault)
                || !_names(st, IBoxItemStream.collection.selector, a.collection)
                || !_names(st, IBoxItemStream.hook.selector, hook) || !_reads(st, IBoxItemStream.started.selector, 0)
        ) revert Miswired(MW_STREAM);
    }

    /// @dev The pool: the static 1% fee, the price inside the curve after the bootstrap buy, the curve's liquidity
    /// active; T: one issue, the bootstrap's T burned, the coordinator holding exactly the pool share, no T in the
    /// launch router, the spec's name and symbol.
    /// The exact balances are sound: T did not exist before this transaction, so nobody else can have sent any.
    // forge-lint: disable-start(incorrect-strict-equality)
    function _verifyPool(BoxSpecV1.BoxSpec memory s, Box0Addresses memory a, PoolId id) internal view {
        bytes32 stateSlot = keccak256(abi.encodePacked(PoolId.unwrap(id), _POOLS_SLOT));
        Slot0 slot0 = Slot0.wrap(_pm.extsload(stateSlot));
        // casting to 'uint128' is safe because the word holds Pool.State's uint128 liquidity alone
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 liquidity = uint128(uint256(_pm.extsload(bytes32(uint256(stateSlot) + _LIQUIDITY_OFFSET))));
        int24 tick = slot0.tick();
        if (slot0.lpFee() != BoxSpecV1.LP_FEE || tick < _tickLower || tick >= _tickUpper || liquidity != _liquidity) {
            revert Miswired(MW_POOL);
        }
        BoxToken t = BoxToken(a.token);
        uint256 burned = t.totalBurned();
        if (
            burned == 0 || t.totalSupply() + burned != BoxSpecV1.ISSUANCE || t.balanceOf(a.coordinator) != _poolShare
                || t.balanceOf(a.launchRouter) != 0 || !_names(a.token, IBoxToken.vault.selector, a.vault)
                || !_names(a.token, IBoxToken.initialHolder.selector, a.coordinator)
                || keccak256(bytes(t.name())) != keccak256(bytes(s.tokenName))
                || keccak256(bytes(t.symbol())) != keccak256(bytes(s.tokenSymbol))
        ) revert Miswired(MW_SUPPLY);
    }

    /// @dev The vault holds all N, hidden, gate closed, no ticket, no escrow, the stream its observer, the version's fee
    /// rates, box 0's T and collection; the collection's N are the vault's, its owner() is the Safe, its table the one
    /// created at nonce 1 (the collection's `initialize` checked its bytes against the hash), the stream its transfer
    /// observer, reveal on exit only with no unlocker, box 0's royalty router, vault, T and receiver; the tickets read
    /// the pinned source (BC-101), open with the hook and name box 0's vault, collection, T, N and first id.
    function _verifyItems(BoxSpecV1.BoxSpec memory s, Box0Addresses memory a, uint256 open) internal view {
        address v = a.vault;
        if (
            !_reads(v, IBoxVault.inside.selector, s.n) || !_reads(v, IBoxVault.hiddenCount.selector, s.n)
                || !_reads(v, IBoxVault.pendingTickets.selector, 0) || !_reads(v, IBoxVault.gateOpen.selector, 0)
                || !_reads(v, IBoxVault.escrowPrincipal.selector, 0)
                || !_names(v, IBoxVault.ticketAdapter.selector, a.tickets)
                || !_names(v, IBoxVault.observer.selector, a.itemStream)
                || !_names(v, IBoxVault.token.selector, a.token)
                || !_names(v, IBoxVault.collection.selector, a.collection)
                || !_reads(v, IBoxVault.drawFeeBps.selector, BoxSpecV1.DRAW_FEE_BPS)
                || !_reads(v, IBoxVault.pickFeeBps.selector, BoxSpecV1.PICK_FEE_BPS)
                || !_reads(v, IBoxVault.returnFeeBps.selector, BoxSpecV1.RETURN_FEE_BPS)
        ) revert Miswired(MW_VAULT);
        address col = a.collection;
        if (
            IBoxCollection(col).balanceOf(v) != s.n || !_names(col, IBoxCollection.owner.selector, platformSafe)
                || !_names(col, IBoxCollection.metadataTable.selector, a.table)
                || !_reads(col, IBoxCollection.metadataTableHash.selector, uint256(keccak256(s.metadataTable)))
                || !_reads(col, IBoxCollection.revealRoot.selector, uint256(s.revealRoot))
                || !_names(col, IBoxCollection.transferObserver.selector, a.itemStream)
                || !_names(col, IBoxCollection.revealUnlocker.selector, address(0))
                || !_reads(col, IBoxCollection.revealTriggers.selector, _REVEAL_ON_EXIT)
                || !_names(col, IBoxCollection.royaltyRouter.selector, a.royaltyRouter)
                || !_names(col, IBoxCollection.vault.selector, v)
                || !_names(col, IBoxCollection.token.selector, a.token)
                || !_names(col, IBoxCollection.receiver.selector, a.receiver)
        ) revert Miswired(MW_COLLECTION);
        address tk = a.tickets;
        if (
            !_names(tk, IBoxTickets.source.selector, randomness) || !_reads(tk, IBoxTickets.openAt.selector, open)
                || !_names(tk, IBoxTickets.vault.selector, v) || !_names(tk, IBoxTickets.collection.selector, col)
                || !_names(tk, IBoxTickets.token.selector, a.token)
                || !_reads(tk, IBoxTickets.collectionSize.selector, s.n)
                || !_reads(tk, IBoxTickets.firstId.selector, s.firstId)
        ) revert Miswired(MW_TICKETS);
    }

    /// @dev Whether `target.selector()` answers exactly the word `expected` (a failed call, or an answer shorter than a
    /// word or with other bits, reads as no).
    function _reads(address target, bytes4 selector, uint256 expected) internal view returns (bool yes) {
        assembly ("memory-safe") {
            mstore(0x00, selector)
            let ok := staticcall(gas(), target, 0x00, 0x04, 0x00, 0x20)
            yes := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), expected)))
        }
    }

    /// @dev Whether `target.selector()` answers the address `expected`.
    function _names(address target, bytes4 selector, address expected) internal view returns (bool) {
        return _reads(target, selector, uint160(expected));
    }

    // forge-lint: disable-end(incorrect-strict-equality)

    // ================================================================== construction helpers

    /// @dev Every implementation names this version: the coordinator implementation's factory is this contract and its
    /// PoolManager the chain's; the others name it as their coordinator implementation (and the PoolManager where they
    /// hold one). Returns the hook's and the receiver's extensions (each must have code).
    function _wired(Implementations memory i, address pm) internal view returns (address hookExt, address receiverExt) {
        IBoxImplementationWiring c = IBoxImplementationWiring(i.coordinator);
        if (c.factory() != address(this) || c.poolManager() != pm) revert ImplementationMiswired(IMPL_COORDINATOR);
        if (!_namesVersion(i.hook, i.coordinator, pm)) revert ImplementationMiswired(IMPL_HOOK);
        if (!_namesVersion(i.launchRouter, i.coordinator, pm)) revert ImplementationMiswired(IMPL_LAUNCH_ROUTER);
        if (!_namesVersion(i.receiver, i.coordinator, pm)) revert ImplementationMiswired(IMPL_RECEIVER);
        if (!_namesVersion(i.collection, i.coordinator, address(0))) revert ImplementationMiswired(IMPL_COLLECTION);
        if (!_namesVersion(i.vault, i.coordinator, address(0))) revert ImplementationMiswired(IMPL_VAULT);
        if (!_namesVersion(i.tickets, i.coordinator, address(0))) revert ImplementationMiswired(IMPL_TICKETS);
        if (!_namesVersion(i.itemStream, i.coordinator, pm)) revert ImplementationMiswired(IMPL_ITEM_STREAM);
        _hasCode(i.royaltyRouter);
        hookExt = IBoxImplementationWiring(i.hook).extension();
        receiverExt = IBoxImplementationWiring(i.receiver).extension();
        _hasCode(hookExt);
        _hasCode(receiverExt);
    }

    /// @dev `impl` names `coordinatorImpl` and, when `pm` is not zero, the PoolManager `pm`.
    function _namesVersion(address impl, address coordinatorImpl, address pm) internal view returns (bool) {
        IBoxImplementationWiring w = IBoxImplementationWiring(impl);
        return w.coordinatorImplementation() == coordinatorImpl && (pm == address(0) || w.poolManager() == pm);
    }

    /// @dev keccak256 of: VERSION, the code hashes of the coordinator, hook, hook extension, launch router, receiver,
    /// receiver extension, collection, vault, tickets, royalty router and per-item stream implementations and of the
    /// planner, and keccak256 of T's creation code (in two halves: the same bytes as one abi.encode of the fourteen
    /// words).
    function _versionCodeHash(Implementations memory i, address hookExt, address receiverExt, address planner_)
        internal
        view
        returns (bytes32)
    {
        bytes memory head = abi.encode(
            VERSION,
            i.coordinator.codehash,
            i.hook.codehash,
            hookExt.codehash,
            i.launchRouter.codehash,
            i.receiver.codehash,
            receiverExt.codehash
        );
        bytes memory tail = abi.encode(
            i.collection.codehash,
            i.vault.codehash,
            i.tickets.codehash,
            i.royaltyRouter.codehash,
            i.itemStream.codehash,
            planner_.codehash,
            keccak256(type(BoxToken).creationCode)
        );
        return keccak256(bytes.concat(head, tail));
    }

    function _hasCode(address account) internal view {
        if (account.code.length == 0) revert NoCode(account);
    }

    /// @dev keccak256(rlp([deployer, nonce]))[12:] for 1 ≤ nonce ≤ 127.
    function _createAddress(address deployer, uint256 nonce) internal pure returns (address a) {
        assembly ("memory-safe") {
            mstore(0x00, or(shl(248, 0xd6), or(shl(240, 0x94), shl(80, deployer))))
            mstore8(0x16, nonce)
            a := and(keccak256(0x00, 0x17), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
