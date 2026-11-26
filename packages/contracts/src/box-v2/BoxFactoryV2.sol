// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxFactoryV2, IBoxCoordinatorV2, IBoxFactoryPileV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {BoxSpec} from "./interfaces/SpecTypes.sol";
import {IListingRegistry, QParameters} from "./interfaces/IListingRegistry.sol";
import {BoxFactoryV2Checks} from "./libraries/BoxFactoryV2Checks.sol";
import {BoxFactoryV2Planner} from "./BoxFactoryV2Planner.sol";

import {IBoxRegistryV2, BoxRolesV2 as R} from "./interfaces/IBoxRegistryV2.sol";
import {IBoxHookV2} from "./interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "./interfaces/IBoxReceiverV2.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";
import {IBoxCoordinator} from "../box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../box/interfaces/IBoxLaunchRouter.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxSpecV1} from "../box/BoxSpecV1.sol";
import {DrandSourcePins} from "../box/randomness/DrandSourcePins.sol";

interface IBoxFactoryV2Wiring {
    function factory() external view returns (address);
    function poolManager() external view returns (address);
    function coordinatorImplementation() external view returns (address);
    function extension() external view returns (address);
}

interface IBoxCoordinatorV2Deploy {
    function deploy(
        bytes[] calldata codes,
        bytes calldata hookCode,
        bytes32 hookSalt,
        uint256 boxId,
        bytes32[2] calldata roots,
        uint256[2] calldata lengths
    ) external returns (address);
}

/// @notice Anyone creates a box using this release's fixed implementations and its current listing raise.
/// Payment is exactly bootstrap plus creator buy; creation, launch, verification and registration are atomic.
/// No admin, setter or rescue. Unsolicited pre-existing balances are excluded from the payment checks.
contract BoxFactoryV2 is IBoxFactoryV2, IBoxFactoryPileV2 {
    error BadPreviewRelease();
    error ReleaseMiswired(uint256 check);
    error ImplementationMiswired(uint256 role);
    error Reentrant();
    uint256 public constant MW_COORDINATOR = 1;
    uint256 public constant MW_HOOK = 2;
    uint256 public constant MW_TOKEN = 3;
    uint256 public constant MW_ETH = 4;
    uint256 public constant MW_P = 5;
    uint256 public constant MW_RECORD = 6;
    uint256 public constant MW_PART = 100;
    uint160 internal constant _FLAG_MASK = 0x3fff;
    bytes32 internal constant _LOCK = keccak256("squarehole.v2.BoxFactoryV2.lock");
    /// @inheritdoc IBoxFactoryV2
    uint16 public constant VERSION = 2;
    /// @notice Anyone may read the fixed planner; it holds no funds.
    BoxFactoryV2Planner public immutable planner;
    BoxFactoryV2Planner.Release private _release;
    /// @notice Anyone reads the fixed stateless verifier; its runtime is in the release commitment.
    BoxFactoryV2Checks public immutable checks;

    /// @notice Deployer fixes all release parts. Cross-check their immutable wiring and two distinct Safe addresses.
    /// Unused implementation slots must be zero. Safe owners/version are verified by the deployment script.
    constructor(BoxFactoryV2Planner.Release memory r, address planner_, address checks_) {
        if (
            planner_.code.length == 0 || r.registry.code.length == 0 || r.listingRegistry.code.length == 0
                || r.poolManager.code.length == 0
        ) revert BadPreviewRelease();
        bytes32[24] memory hashes;
        for (uint256 i; i < 24; ++i) {
            if (i < 9) {
                if (r.implementations[i].code.length == 0) revert BadPreviewRelease();
            } else if (i == 16 || i == 17 || i == 19 || i == 20 || i == 21 || i == 22) {
                if (r.implementations[i] != address(0) && r.implementations[i].code.length == 0) {
                    revert BadPreviewRelease();
                }
            } else if (r.implementations[i] != address(0)) {
                revert BadPreviewRelease();
            }
            if (r.implementations[i] != address(0)) hashes[i] = r.implementations[i].codehash;
        }
        // A legacy release may omit M2. Holder accounting and its history token are admitted together;
        // a loader requires shop custody. The planner refuses any implementation missing for a selected box.
        if (
            (r.implementations[17] == address(0)) != (r.implementations[20] == address(0))
                || (r.implementations[19] != address(0) && r.implementations[21] == address(0))
        ) revert BadPreviewRelease();
        _checkRelease(r);
        if (checks_.codehash != keccak256(type(BoxFactoryV2Checks).runtimeCode)) revert BadPreviewRelease();
        checks = BoxFactoryV2Checks(checks_);
        planner = BoxFactoryV2Planner(planner_);
        r.factory = address(this);
        r.versionCodeHash = keccak256(
            abi.encode(
                VERSION,
                hashes,
                address(checks).codehash,
                IBoxFactoryV2Wiring(r.implementations[2]).extension().codehash,
                planner_.codehash,
                address(planner.parts()).codehash,
                address(planner.validator()).codehash
            )
        );
        _release = r;
    }

    /// @inheritdoc IBoxFactoryV2
    function createBox(BoxSpec calldata spec, bytes32 coordinatorSalt, bytes32 hookSalt)
        external
        payable
        returns (uint256 boxId, address coordinator, address hook)
    {
        _lock();
        BoxFactoryV2Planner.Release memory r = _release;
        _revertWith(planner.refusal(r, spec));
        BoxFactoryV2Planner.Plan memory p = planner.plan(r, msg.sender, spec, coordinatorSalt, hookSalt);
        // The balances are compared with what this contract held before the call, never with zero, so ETH or P anyone
        // sent here cannot block a creation; they are read again after every call below on purpose (MW_ETH, MW_P).
        // forge-lint: disable-start(reentrancy-balance)
        uint256 ethBefore = address(this).balance - msg.value;
        uint256 pBefore = _pay(spec.pricing.token, p.payment);
        _checkPlace(p.roles[R.ROLE_TOKEN], spec.pricing.token, p.roles[R.ROLE_HOOK]);

        boxId = p.boxId;
        coordinator = BoxClones.create2(p.coordinatorInit, p.salt);
        if (
            coordinator != p.roles[R.ROLE_COORDINATOR] || !BoxClones.isCloneOf(coordinator, _release.implementations[0])
        ) {
            revert Miswired(MW_COORDINATOR);
        }
        hook = IBoxCoordinatorV2Deploy(coordinator)
            .deploy(p.codes, p.hookInit, hookSalt, boxId, p.chunkRoots, p.chunkLengths);
        if (hook != p.roles[R.ROLE_HOOK]) revert Miswired(MW_HOOK);
        _launch(coordinator, spec.pricing.token, p.payment);

        checks.verify(r, msg.sender, spec, p, boxId);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (address(this).balance != ethBefore) revert Miswired(MW_ETH);
        if (spec.pricing.token != address(0) && _balanceOf(spec.pricing.token) != pBefore) revert Miswired(MW_P);
        // forge-lint: disable-end(reentrancy-balance)
        if (IBoxRegistryV2(_release.registry).record(coordinator, p.templateId, abi.encode(spec)) != boxId) {
            revert Miswired(MW_RECORD);
        }
        _unlock();
    }

    /// @inheritdoc IBoxFactoryV2
    function predictBox(address creator, BoxSpec calldata spec, bytes32 coordinatorSalt)
        external
        view
        returns (address coordinator, address token, bytes32 hookInitCodeHash)
    {
        return planner.predictBox(_release, creator, spec, coordinatorSalt);
    }

    /// @inheritdoc IBoxFactoryV2
    function predictHook(address creator, BoxSpec calldata spec, bytes32 coordinatorSalt, bytes32 hookSalt)
        external
        view
        returns (address)
    {
        return planner.predictHook(_release, creator, spec, coordinatorSalt, hookSalt);
    }

    /// @inheritdoc IBoxFactoryV2
    function tokenAddressLimit(address q) external pure returns (address) {
        uint256 limit = uint160(q) + ((uint256(1) << 160) - uint160(q)) / 2;
        // The midpoint of q and 2^160 is strictly below 2^160.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(limit));
    }

    /// @inheritdoc IBoxFactoryV2
    function refusal(BoxSpec calldata spec, address) external view returns (bytes memory) {
        return planner.refusal(_release, spec);
    }

    /// @inheritdoc IBoxFactoryV2
    function templateIdOf(BoxSpec calldata spec) external view returns (bytes32) {
        return planner.templateIdOf(_release, spec);
    }

    /// @inheritdoc IBoxFactoryV2
    function boxQParameters(uint32 id, uint256 raise) external view returns (QParameters memory) {
        return planner.boxQParameters(_release, id, raise);
    }

    /// @inheritdoc IBoxFactoryV2
    function registry() external view returns (address) {
        return _release.registry;
    }

    /// @inheritdoc IBoxFactoryV2
    function listingRegistry() external view returns (address) {
        return _release.listingRegistry;
    }

    /// @inheritdoc IBoxFactoryV2
    function poolManager() external view returns (address) {
        return _release.poolManager;
    }

    /// @inheritdoc IBoxFactoryV2
    function weth() external view returns (address) {
        return _release.weth;
    }

    /// @inheritdoc IBoxFactoryV2
    function randomness() external view returns (address) {
        return _release.randomness;
    }

    /// @inheritdoc IBoxFactoryV2
    function versionCodeHash() external view returns (bytes32) {
        return _release.versionCodeHash;
    }

    /// @inheritdoc IBoxFactoryV2
    function implementation(uint256 role) external view returns (address) {
        return role < 24 ? _release.implementations[role] : address(0);
    }

    /// @inheritdoc IBoxFactoryPileV2
    function isPileVault(address candidate) external view returns (bool) {
        address impl = _release.implementations[22];
        return impl != address(0) && (candidate.code.length == BoxClones.ARGS_OFFSET + 112
            || candidate.code.length == BoxClones.ARGS_OFFSET + 114)
            && BoxClones.isCloneOf(candidate, impl);
    }

    /// @dev Constructor only. No Safe calls here: the deployment script certifies custody separately.
    function _checkRelease(BoxFactoryV2Planner.Release memory r) private view {
        address ci = r.implementations[0];
        if (
            !_names(ci, IBoxFactoryV2Wiring.factory.selector, address(this))
                || !_names(ci, IBoxFactoryV2Wiring.poolManager.selector, r.poolManager)
        ) revert ReleaseMiswired(1);
        if (!_names(r.registry, IBoxRegistryV2.factory.selector, address(this))) revert ReleaseMiswired(2);
        IListingRegistry l = IListingRegistry(r.listingRegistry);
        if (l.boxRegistry() != r.registry || l.poolManager() != r.poolManager || l.weth() != r.weth) {
            revert ReleaseMiswired(3);
        }
        (address pinned,) = DrandSourcePins.pinned(block.chainid);
        if (pinned != address(0) ? !DrandSourcePins.isPinned(r.randomness) : r.randomness.code.length == 0) {
            revert ReleaseMiswired(4);
        }
        if (r.weth.code.length == 0) revert ReleaseMiswired(5);
        for (uint256 role = 1; role <= 7; ++role) {
            if (!_names(r.implementations[role], IBoxFactoryV2Wiring.coordinatorImplementation.selector, ci)) {
                revert ImplementationMiswired(role);
            }
        }
        for (uint256 role = 2; role <= 6; ++role) {
            if (role == 3 || role == 4) continue;
            if (!_names(r.implementations[role], IBoxFactoryV2Wiring.poolManager.selector, r.poolManager)) {
                revert ImplementationMiswired(role);
            }
        }
        for (uint256 slot = 16; slot <= 22; ++slot) {
            if (slot == 17 || slot == 18) continue;
            address impl = r.implementations[slot];
            if (impl == address(0)) continue;
            if (!_names(impl, IBoxFactoryV2Wiring.coordinatorImplementation.selector, ci)) {
                revert ImplementationMiswired(slot);
            }
            if (slot == 21 && !_names(impl, IBoxFactoryV2Wiring.poolManager.selector, r.poolManager)) {
                revert ImplementationMiswired(slot);
            }
            // The plain token has the same coordinator getter but no mandatory history API.
            if (slot == 20 && !_reads(impl, bytes4(keccak256("holderCheckpoint()")), 0)) {
                revert ImplementationMiswired(slot);
            }
        }
        address extension = IBoxFactoryV2Wiring(r.implementations[2]).extension();
        if (extension.code.length == 0) revert ImplementationMiswired(2);
        IBoxReceiverV2 receiver = IBoxReceiverV2(r.implementations[5]);
        address fit = receiver.FIT_SAFE();
        address platform = receiver.PLATFORM_SAFE();
        if (
            fit.code.length == 0 || platform.code.length == 0 || fit == platform
                || l.lister() != platform
        ) {
            revert ReleaseMiswired(6);
        }
    }

    /// @dev Creation only: take exactly the caller payment; previous donations do not count.
    function _pay(address p, uint256 amount) internal returns (uint256 before) {
        if (p == address(0)) {
            if (msg.value != amount) revert WrongValue(msg.value, amount);
            return 0;
        }
        if (msg.value != 0) revert WrongValue(msg.value, 0);
        before = _balanceOf(p);
        bool ok = _call(p, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
        uint256 received = ok ? _balanceOf(p) - before : 0;
        if (received != amount) revert ShortTransfer(p, amount, received);
    }

    /// The launch, paid as `IBoxCoordinatorV2` says: ETH as its value; an ERC-20 P on this contract's approval for
    /// exactly the payment, which the coordinator's `launch()` pulls whole (the allowance is read back as zero).
    function _launch(address coordinator, address p, uint256 amount) internal {
        // The coordinator was just created here, at its predicted address, as a clone of this release's coordinator
        // implementation (checked before this call); it is the only payee, and `createBox` re-reads both balances after.
        // forge-lint: disable-start(arbitrary-send-eth, reentrancy-balance)
        if (p == address(0)) {
            IBoxCoordinator(coordinator).launch{value: amount}();
            return;
        }
        if (!_call(p, abi.encodeWithSelector(0x095ea7b3, coordinator, amount))) revert Miswired(MW_P); // approve
        IBoxCoordinator(coordinator).launch();
        // forge-lint: disable-end(arbitrary-send-eth, reentrancy-balance)
        (bool ok, bytes memory ret) = p.staticcall(abi.encodeWithSelector(0xdd62ed3e, address(this), coordinator));
        if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 0) revert Miswired(MW_P);
    }

    /// A token call: its revert bubbles; true when it answers nothing or true (tokens without a return value).
    function _call(address token, bytes memory data) internal returns (bool) {
        // P is a listed token; `createBox` holds its lock and reads its balance after every such call on purpose.
        // forge-lint: disable-next-line(reentrancy-balance)
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret.length == 0 || (ret.length > 31 && abi.decode(ret, (uint256)) == 1);
    }

    function _balanceOf(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert Miswired(MW_P);
        return abi.decode(ret, (uint256));
    }

    // ================================================================== internals: checks and re-reads

    /// T above P and below the midpoint (ADR-0017 § 4), then the hook's flags: CQ11's 0x2AE0, not starting 0x91
    /// (BoxSpecV1 `HOOK_FLAGS`, `HOOK_FORBIDDEN_ADDRESS_PREFIX`).
    function _checkPlace(address t, address q, address hook) internal pure {
        if (uint160(t) <= uint160(q)) revert TokenNotAboveQ(t, q);
        address limit = _limit(q);
        if (uint160(t) >= uint160(limit)) revert T_TOO_HIGH(t, limit);
        uint160 h = uint160(hook);
        if (h & _FLAG_MASK != C.V2_HOOK_FLAGS || h >> 152 == BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX) {
            revert HookSaltNotMined(hook);
        }
    }

    function _reads(address target, bytes4 selector, uint256 expected) internal view returns (bool yes) {
        assembly ("memory-safe") {
            mstore(0x00, selector)
            let ok := staticcall(gas(), target, 0x00, 0x04, 0x00, 0x20)
            yes := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), expected)))
        }
    }

    function _names(address target, bytes4 selector, address expected) internal view returns (bool) {
        return _reads(target, selector, uint160(expected));
    }

    /// Whether `target` answers `call_` with exactly the word `expected`.
    function _readsCall(address target, bytes memory call_, uint256 expected) internal view returns (bool yes) {
        assembly ("memory-safe") {
            let ok := staticcall(gas(), target, add(call_, 0x20), mload(call_), 0x00, 0x20)
            yes := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), expected)))
        }
    }

    function _limit(address q) internal pure returns (address) {
        uint256 p = uint160(q);
        // casting to 'uint160' is safe because q + (2^160 - q) / 2 <= (2^160 + q) / 2 < 2^160
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(p + ((uint256(1) << 160) - p) / 2));
    }

    function _revertWith(bytes memory err) internal pure {
        if (err.length == 0) return;
        assembly ("memory-safe") {
            revert(add(err, 0x20), mload(err))
        }
    }

    function _lock() internal {
        bytes32 slot = _LOCK;
        uint256 held;
        assembly ("memory-safe") {
            held := tload(slot)
        }
        if (held != 0) revert Reentrant();
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    function _unlock() internal {
        bytes32 slot = _LOCK;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }
}
