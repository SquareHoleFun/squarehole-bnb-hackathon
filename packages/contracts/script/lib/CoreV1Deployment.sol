// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxCollection} from "../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../src/box/BoxHookExtension.sol";
import {BoxItemStream} from "../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../src/box/BoxReceiverExtension.sol";
import {BoxRoyaltyRouter} from "../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../src/box/BoxTickets.sol";
import {BoxVault} from "../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../src/box/interfaces/IBoxFactoryV1.sol";
import {DrandSource} from "../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../src/box/randomness/BoxBackedSource.sol";

/// @notice Foundry 1.8.3's `lastFrameGas` cheatcode with the field forge-std 1.16.2's `Vm.Gas` lacks (`gasStateUsed`,
/// crates/cheatcodes/spec/src/vm.rs at v1.8.3): the gas of the last call or create frame, EIP-8037's state gas apart
/// from the rest. Without EIP-8037 `gasStateUsed` is 0.
interface IVmFrameGas {
    struct Gas {
        uint64 gasLimit;
        uint64 gasTotalUsed;
        uint64 gasMemoryUsed;
        int64 gasRefunded;
        uint64 gasRemaining;
        int64 gasStateUsed;
    }

    function lastFrameGas() external view returns (Gas memory gas);
}

/// @title CoreV1Deployment
/// @notice The core v1 deployment (slice S7), shared by `script/DeployCoreV1.s.sol` (the founder's broadcast, later)
/// and the tests (`test/box/s7`, the core harness's `CoreBox0Kit`), so the tests run exactly the steps the script
/// sends. In order (SH-core-wave-2 § Spec changes, "For S7"):
/// 1. the implementations: the coordinator's first, naming the factory at its predicted CREATE address; then the
///    hook extension, hook, launch router, receiver extension, receiver, collection, vault, tickets, royalty router and
///    per-item stream (S8), every one but the extensions and the router naming the coordinator implementation; then
///    the planner;
/// 2. the pinned DrandSource through the canonical CREATE2 deployer, if this chain has none yet (anyone may send it;
///    its address and code are always the same, `DrandSourcePins`), then box 0's pinned BoxBackedSource the same way
///    (F143: drand first, the RANDAO backup by an on-chain rule; `BackedSourcePins`), if absent;
/// 3. the factory (its constructor checks every pin and wiring and creates the registry; box 0's source is the
///    BoxBackedSource);
/// 4. box 0: the hook salt mined over its final init code, then `createBox` with the bootstrap and FIT's executor's
///    creation code.
/// Every address is fixed by the deployer's account and nonce before the first step: twelve CREATEs (eleven
/// implementations and the planner), then (when a source is missing and the deployer is a plain account) one call to
/// the CREATE2 deployer per missing source (the DrandSource, the BoxBackedSource), then the factory's CREATE.
/// @dev No key, no RPC, no broadcast here: the caller decides (the script inside `vm.startBroadcast`, a test as
/// itself). Written for Square Hole (MIT).
abstract contract CoreV1Deployment is CommonBase {
    /// @notice CREATEs of step 1 (eleven implementations and the planner), before the factory.
    uint256 internal constant CORE_V1_CREATES_BEFORE_FACTORY = 12;

    struct CoreV1Config {
        /// The account whose nonces the CREATEs use (the broadcasting wallet in the script, the test contract in tests).
        address deployer;
        /// Whether a call from `deployer` uses a nonce: true for a wallet sending transactions (and for a Foundry test
        /// contract calling at the top level, which Foundry counts as a transaction), false for a contract calling inside
        /// a transaction.
        bool callsTakeNonce;
        IPoolManager poolManager;
        address weth;
        /// The platform Safe (box 0's capped 2/15; box 0's spec must name it as marketplaceOwner).
        address platformSafe;
        /// The only caller of createBox.
        address box0Creator;
    }

    struct CoreV1Version {
        IBoxFactoryV1.Implementations impls;
        address hookExtension;
        address receiverExtension;
        address planner;
        /// Box 0's source: the pinned BoxBackedSource (F143).
        address randomness;
        /// This run sent the BoxBackedSource's deterministic deployment.
        bool randomnessDeployed;
        /// The pinned DrandSource the BoxBackedSource names (rounds are posted there).
        address drand;
        /// This run sent the DrandSource's deterministic deployment.
        bool drandDeployed;
        address factory;
        address registry;
    }

    /// @notice One step's gas (`gasleft()` delta in the caller's frame; no intrinsic transaction cost).
    struct CoreV1Step {
        string label;
        /// All the step's gas: before EIP-8037 its execution gas; under EIP-8037 its state gas too.
        uint256 gas;
        /// The init code's length (0 for a call), for the intrinsic cost and EIP-3860.
        uint256 initCodeBytes;
        address at;
        /// EIP-8037's state gas in the step's frame (`lastFrameGas().gasStateUsed`; 0 without EIP-8037). A CREATE's
        /// new-account charge is the caller's, outside the frame, so `gas - stateGas` is never below the execution gas.
        uint256 stateGas;
        /// A call (a source's deployment through the CREATE2 deployer, createBox), not a CREATE.
        bool viaCall;
    }

    CoreV1Step[] internal _coreV1Steps;

    /// @notice Steps 1-3: the version (implementations, planner, the sources if absent, the factory and its registry).
    function _deployCoreV1(CoreV1Config memory c) internal returns (CoreV1Version memory v) {
        address factoryAt = _factoryAt(c);
        require(address(c.poolManager).code.length != 0, "core v1: no PoolManager code");
        require(c.weth.code.length != 0, "core v1: no WETH code");
        v.impls.coordinator = _step(
            "implementation: BoxCoordinator (names the factory)",
            abi.encodePacked(type(BoxCoordinator).creationCode, abi.encode(c.poolManager, factoryAt))
        );
        address coord = v.impls.coordinator;
        v.hookExtension = _step(
            "implementation: BoxHookExtension",
            abi.encodePacked(type(BoxHookExtension).creationCode, abi.encode(c.poolManager))
        );
        v.impls.hook = _step(
            "implementation: BoxHook",
            abi.encodePacked(type(BoxHook).creationCode, abi.encode(c.poolManager, coord, v.hookExtension))
        );
        v.impls.launchRouter = _step(
            "implementation: BoxLaunchRouter",
            abi.encodePacked(type(BoxLaunchRouter).creationCode, abi.encode(c.poolManager, coord))
        );
        v.receiverExtension = _step(
            "implementation: BoxReceiverExtension",
            abi.encodePacked(type(BoxReceiverExtension).creationCode, abi.encode(coord))
        );
        v.impls.receiver = _step(
            "implementation: BoxReceiver",
            abi.encodePacked(type(BoxReceiver).creationCode, abi.encode(c.poolManager, coord, v.receiverExtension))
        );
        v.impls.collection = _step(
            "implementation: BoxCollection", abi.encodePacked(type(BoxCollection).creationCode, abi.encode(coord))
        );
        v.impls.vault =
            _step("implementation: BoxVault", abi.encodePacked(type(BoxVault).creationCode, abi.encode(coord)));
        v.impls.tickets =
            _step("implementation: BoxTickets", abi.encodePacked(type(BoxTickets).creationCode, abi.encode(coord)));
        v.impls.royaltyRouter = _step("implementation: BoxRoyaltyRouter", type(BoxRoyaltyRouter).creationCode);
        v.impls.itemStream = _step(
            "implementation: BoxItemStream",
            abi.encodePacked(type(BoxItemStream).creationCode, abi.encode(c.poolManager, coord))
        );
        v.planner = _step("BoxFactoryV1Planner", _plannerCreationCode());
        _deploySources(v);
        v.factory = _step(
            "BoxFactoryV1 (and its BoxRegistry)",
            abi.encodePacked(
                _factoryCreationCode(),
                abi.encode(
                    c.poolManager,
                    v.impls,
                    v.planner,
                    v.randomness,
                    c.weth,
                    c.platformSafe,
                    c.box0Creator,
                    keccak256(type(FitBuybackExecutor).creationCode)
                )
            )
        );
        require(v.factory == factoryAt, "core v1: the factory is not where the coordinator implementation names it");
        v.registry = BoxFactoryV1(v.factory).registry();
    }

    /// @dev The factory's CREATE address: after step 1's CREATEs and, for a plain account, one nonce per source the
    /// chain lacks (each is a call to the CREATE2 deployer). Both sources are pinned on chains 1 and 11155111 only.
    function _factoryAt(CoreV1Config memory c) private view returns (address) {
        (address pinned,) = DrandSourcePins.pinned(block.chainid);
        require(pinned != address(0), "core v1: the DrandSource is pinned on chains 1 and 11155111 only");
        (address backed,) = BackedSourcePins.pinned(block.chainid);
        require(backed != address(0), "core v1: the BoxBackedSource is pinned on chains 1 and 11155111 only");
        uint256 calls = (pinned.code.length == 0 ? 1 : 0) + (backed.code.length == 0 ? 1 : 0);
        return vm.computeCreateAddress(
            c.deployer, vm.getNonce(c.deployer) + CORE_V1_CREATES_BEFORE_FACTORY + (c.callsTakeNonce ? calls : 0)
        );
    }

    /// @dev Step 2: the pinned DrandSource, then box 0's pinned BoxBackedSource, each through the CREATE2 deployer
    /// when the chain lacks it.
    function _deploySources(CoreV1Version memory v) private {
        (address pinned,) = DrandSourcePins.pinned(block.chainid);
        (address backed,) = BackedSourcePins.pinned(block.chainid);
        if (pinned.code.length == 0) {
            uint256 g0 = gasleft();
            _deployDrandSource(pinned);
            uint256 g = g0 - gasleft();
            _coreV1Steps.push(
                CoreV1Step({
                    label: "DrandSource through the CREATE2 deployer (absent on this chain)",
                    gas: g,
                    initCodeBytes: 32 + type(DrandSource).creationCode.length,
                    at: pinned,
                    stateGas: _lastFrameStateGas(),
                    viaCall: true
                })
            );
            v.drandDeployed = true;
        }
        v.drand = pinned;
        if (backed.code.length == 0) {
            uint256 g0 = gasleft();
            _deployBackedSource(backed);
            uint256 g = g0 - gasleft();
            _coreV1Steps.push(
                CoreV1Step({
                    label: "BoxBackedSource through the CREATE2 deployer (absent on this chain)",
                    gas: g,
                    initCodeBytes: 32 + type(BoxBackedSource).creationCode.length,
                    at: backed,
                    stateGas: _lastFrameStateGas(),
                    viaCall: true
                })
            );
            v.randomnessDeployed = true;
        }
        v.randomness = backed;
    }

    /// @notice Step 4: box 0 from `spec` (the hook salt mined here, over the factory's hook init code hash).
    function _createBox0(BoxFactoryV1 factory, BoxSpecV1.BoxSpec memory spec)
        internal
        returns (uint256 boxId, address coordinator, address hook, bytes32 salt)
    {
        salt = _mineHookSalt(factory.box0Addresses().coordinator, factory.hookInitCodeHash(spec.openAt));
        uint256 g0 = gasleft();
        (boxId, coordinator, hook) =
            factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(spec, salt, type(FitBuybackExecutor).creationCode);
        uint256 g = g0 - gasleft();
        _coreV1Steps.push(
            CoreV1Step({
                label: "createBox (box 0)",
                gas: g,
                initCodeBytes: 0,
                at: coordinator,
                stateGas: _lastFrameStateGas(),
                viaCall: true
            })
        );
    }

    /// @notice The planner's creation code (tests may deploy a stand-in to show the factory checks its results).
    function _plannerCreationCode() internal view virtual returns (bytes memory) {
        return type(BoxFactoryV1Planner).creationCode;
    }

    /// @notice The factory's creation code (tests may deploy a subclass that exposes its internals).
    function _factoryCreationCode() internal view virtual returns (bytes memory) {
        return type(BoxFactoryV1).creationCode;
    }

    /// @notice The canonical deterministic deployer's call: calldata = salt ‖ init code (DrandSourcePins).
    function _deployDrandSource(address pinned) internal virtual {
        require(DrandSourcePins.DEPLOYER.code.length != 0, "core v1: no CREATE2 deployer on this chain");
        (bool ok, bytes memory ret) =
            DrandSourcePins.DEPLOYER.call(bytes.concat(DrandSourcePins.SALT, type(DrandSource).creationCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == pinned, "core v1: the pinned DrandSource");
    }

    /// @notice The canonical deterministic deployer's call for box 0's source: calldata = salt ‖ init code
    /// (BackedSourcePins).
    function _deployBackedSource(address pinned) internal virtual {
        require(BackedSourcePins.DEPLOYER.code.length != 0, "core v1: no CREATE2 deployer on this chain");
        (bool ok, bytes memory ret) =
            BackedSourcePins.DEPLOYER.call(bytes.concat(BackedSourcePins.SALT, type(BoxBackedSource).creationCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == pinned, "core v1: the pinned BoxBackedSource");
    }

    /// @notice A CREATE2 salt putting the hook clone at an address with exactly the flags 0x2AE0 in its low 14 bits and
    /// no 0x91 prefix (about 16,384 tries; CoreBox0Builder's miner of SH-core-wave-2).
    function _mineHookSalt(address deployer, bytes32 initHash) internal pure returns (bytes32 salt) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore8(p, 0xff)
            mstore(add(p, 0x01), shl(96, deployer))
            mstore(add(p, 0x35), initHash)
            for { let s := 0 } 1 { s := add(s, 1) } {
                mstore(add(p, 0x15), s)
                let a := and(keccak256(p, 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
                if and(eq(and(a, 0x3fff), 0x2ae0), iszero(eq(shr(152, a), 0x91))) {
                    salt := s
                    break
                }
            }
        }
    }

    function _coreV1StepCount() internal view returns (uint256) {
        return _coreV1Steps.length;
    }

    /// @dev One CREATE of `initCode`, its execution gas recorded.
    function _step(string memory label, bytes memory initCode) private returns (address at) {
        uint256 g0 = gasleft();
        assembly ("memory-safe") {
            at := create(0, add(initCode, 0x20), mload(initCode))
        }
        uint256 g = g0 - gasleft();
        require(at != address(0) && at.code.length != 0, string.concat("core v1: CREATE failed: ", label));
        _coreV1Steps.push(
            CoreV1Step({
                label: label,
                gas: g,
                initCodeBytes: initCode.length,
                at: at,
                stateGas: _lastFrameStateGas(),
                viaCall: false
            })
        );
    }

    /// @dev EIP-8037's state gas of the frame that just ended (a step's CREATE or call; cheatcode calls are not frames),
    /// 0 without EIP-8037 or when the frame undid more state than it made.
    function _lastFrameStateGas() internal view returns (uint256) {
        int64 s = IVmFrameGas(address(vm)).lastFrameGas().gasStateUsed;
        return s > 0 ? uint256(uint64(s)) : 0;
    }
}
