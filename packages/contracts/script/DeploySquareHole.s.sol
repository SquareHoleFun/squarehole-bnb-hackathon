// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SquareHoleClaimConverter} from "../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../src/SquareHoleRegistry.sol";
import {CollectionTokenDeployer, CoreDeployer, FungibleTokenDeployer} from "../src/deployers/LaunchDeployers.sol";

/// @title SquareHoleSystemDeployer
/// @notice Shared by `DeploySquareHole` (system only) and `Deploy` (per-chain configuration, quotes, templates and the
/// The Misfits / ORCHARD launches, JSON manifest). Deploys the Square Hole system against an existing Uniswap v4
/// PoolManager: registry, claim converter, the hook through the canonical CREATE2 deployer (`0x4e59…956C`) at a salt
/// mined for its permission bits, the three per-launch deployers and the launcher. Every address the hook and
/// launcher depend on is predicted from the broadcaster's nonce: registry (n), converter (n+1), hook via the CREATE2
/// deployer (n+2, one transaction), core/collection/fungible deployers (n+3…n+5), launcher (n+6).
/// Hook squatting (review round B): the hook's init code and salt follow from public data (the broadcaster's address
/// and nonce), so anyone can deploy the byte-identical hook at the planned address first through the public CREATE2
/// deployer. The step is therefore idempotent: code already at the planned address is adopted when its code hash equals
/// the hook's (CREATE2 binds the init code; the hash is re-derived on a scratch copy of the state), and the hook's
/// nonce is consumed by a 0-value no-op call instead (`registry.templateCount()` sent as a transaction), so the launcher
/// still lands at n+6 where the hook expects it.
abstract contract SquareHoleSystemDeployer is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant HOOK_FLAGS = 0x2A60;

    struct Params {
        IPoolManager poolManager;
        address admin; // registry admin (add/retire templates only)
        address treasury; // protocol treasury of every launch
        bool withConverter; // deploy the R = T claim converter
    }

    struct Deployment {
        SquareHoleRegistry registry;
        SquareHoleClaimConverter converter;
        SquareHoleHook hook;
        CoreDeployer coreDeployer;
        CollectionTokenDeployer collectionDeployer;
        FungibleTokenDeployer fungibleDeployer;
        SquareHoleLauncher launcher;
        bytes32 hookSalt;
        uint256 hookMiningIterations;
        bool hookAdopted; // identical hook already at the planned address (squatted): adopted, nonce used by a no-op
    }

    /// @notice Deploys the system from `broadcaster` (a real broadcast in a script, a recorded one in tests).
    function deploy(Params memory p, address broadcaster) public returns (Deployment memory d) {
        require(address(p.poolManager).code.length != 0, "PoolManager has no code");
        require(CREATE2_DEPLOYER.code.length != 0, "CREATE2 deployer missing");
        uint256 nonce = vm.getNonce(broadcaster);
        address predictedLauncher = vm.computeCreateAddress(broadcaster, nonce + 6);
        bytes memory hookInit =
            abi.encodePacked(type(SquareHoleHook).creationCode, abi.encode(p.poolManager, predictedLauncher));
        (d.hookSalt, d.hookMiningIterations) = mineHookSalt(keccak256(hookInit));
        address plannedHook = hookAddress(d.hookSalt, keccak256(hookInit));
        if (plannedHook.code.length != 0) {
            require(
                plannedHook.codehash == referenceHookCodehash(plannedHook, d.hookSalt, hookInit),
                "hook: foreign code at the planned address"
            );
            d.hookAdopted = true;
        }

        vm.startBroadcast(broadcaster);
        d.registry = new SquareHoleRegistry(p.admin, predictedLauncher);
        // The converter's slot is always used so the nonce plan holds; without it the launcher gets address(0).
        SquareHoleClaimConverter converter = new SquareHoleClaimConverter(p.poolManager, d.registry);
        if (d.hookAdopted) {
            // Nonce n+2 without a CREATE2: a 0-value, state-free call to the registry just deployed (`templateCount()`
            // as a transaction). A call into our own code cannot be blocked by a third party, and unlike a call to an
            // account without code it does not stop `forge script --broadcast` at an interactive prompt.
            (bool sent,) = address(d.registry).call(abi.encodeWithSelector(d.registry.templateCount.selector));
            require(sent, "hook: nonce-consuming no-op failed");
        } else {
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(d.hookSalt, hookInit));
            require(ok && ret.length == 20 && address(bytes20(ret)) == plannedHook, "hook CREATE2 failed");
        }
        d.hook = SquareHoleHook(plannedHook);
        d.coreDeployer = new CoreDeployer(predictedLauncher);
        d.collectionDeployer = new CollectionTokenDeployer(predictedLauncher);
        d.fungibleDeployer = new FungibleTokenDeployer(predictedLauncher);
        d.launcher = new SquareHoleLauncher(
            p.poolManager,
            d.hook,
            d.registry,
            p.treasury,
            p.withConverter ? address(converter) : address(0),
            d.coreDeployer,
            d.collectionDeployer,
            d.fungibleDeployer
        );
        vm.stopBroadcast();
        if (p.withConverter) d.converter = converter;
        require(address(d.launcher) == predictedLauncher, "launcher address drifted from the nonce plan");
        require(uint160(address(d.hook)) & 0x3FFF == HOOK_FLAGS, "hook flags");
        require(
            d.hook.launcher() == predictedLauncher && address(d.hook.poolManager()) == address(p.poolManager),
            "hook wiring"
        );
    }

    /// @notice CREATE2 address of the hook through the canonical deployer.
    function hookAddress(bytes32 salt, bytes32 initCodeHash) public pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)))));
    }

    /// @notice Runtime code hash the hook's init code produces at `planned`: re-derived by running the same CREATE2 on
    /// a scratch copy of the state (the existing code cleared locally), then discarded. Nothing here is broadcast.
    function referenceHookCodehash(address planned, bytes32 salt, bytes memory hookInit) public returns (bytes32 h) {
        uint256 snapshot = vm.snapshotState();
        vm.etch(planned, "");
        vm.setNonceUnsafe(planned, 0);
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, hookInit));
        require(ok && ret.length == 20 && address(bytes20(ret)) == planned, "hook: reference CREATE2 failed");
        h = planned.codehash;
        require(vm.revertToStateAndDelete(snapshot), "hook: state not restored");
    }

    /// @notice First salt whose CREATE2 address (through the canonical deployer) has exactly the hook's permission
    /// bits and no 0x91 prefix.
    function mineHookSalt(bytes32 initCodeHash) public pure returns (bytes32 salt, uint256 iterations) {
        for (uint256 i; i < 5_000_000; ++i) {
            salt = bytes32(i);
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash))))
            );
            if (uint160(a) & 0x3FFF == HOOK_FLAGS && uint160(a) >> 152 != 0x91) return (salt, i + 1);
        }
        revert("no hook salt found");
    }

    function _printManifest(Params memory p, Deployment memory d) internal view {
        console.log("SQUAREHOLE_MANIFEST chainId", block.chainid);
        _entry("poolManager", address(p.poolManager));
        _entry("registry", address(d.registry));
        _entry("claimConverter", address(d.converter));
        _entry("hook", address(d.hook));
        _entry("coreDeployer", address(d.coreDeployer));
        _entry("collectionTokenDeployer", address(d.collectionDeployer));
        _entry("fungibleTokenDeployer", address(d.fungibleDeployer));
        _entry("launcher", address(d.launcher));
        console.log("SQUAREHOLE_MANIFEST registryAdmin", p.admin);
        console.log("SQUAREHOLE_MANIFEST treasury", p.treasury);
        console.log("SQUAREHOLE_MANIFEST hookSalt");
        console.logBytes32(d.hookSalt);
        console.log("SQUAREHOLE_MANIFEST hookMiningIterations", d.hookMiningIterations);
        console.log("SQUAREHOLE_MANIFEST hookAdopted", d.hookAdopted);
    }

    function _entry(string memory name, address a) internal view {
        console.log(string.concat("SQUAREHOLE_MANIFEST ", name), a);
        console.logBytes32(a.codehash);
    }
}

/// @title DeploySquareHole (Stage C groundwork; ADR-0011)
/// @notice System only: prints manifest lines (`SQUAREHOLE_MANIFEST …`: chain id, each address with its code hash,
/// registry admin, treasury, hook salt and mining iterations) and adds no template. The full per-chain deployment
/// (quotes, mock USDT, templates, The Misfits (FIT) and ORCHARD, deployments/<chainId>.json) is `script/Deploy.s.sol`.
/// @dev Not run with --broadcast by any agent outside local anvil. Local use, e.g. with a default anvil key:
///   SH_ADMIN=… SH_TREASURY=… forge script script/DeploySquareHole.s.sol --rpc-url http://127.0.0.1:8546 --broadcast
/// Without SH_POOL_MANAGER on chain 31337 it first deploys a PoolManager from the pinned source (local only; BUSL
/// non-production use). Outside chain 31337, SH_POOL_MANAGER, SH_ADMIN and SH_TREASURY are required explicitly (no
/// fallback to the broadcaster). SH_WITH_CONVERTER (default true) wires the R = T converter.
contract DeploySquareHole is SquareHoleSystemDeployer {
    function run() external returns (Deployment memory d) {
        address broadcaster = msg.sender;
        address pmAddr = vm.envOr("SH_POOL_MANAGER", address(0));
        if (pmAddr == address(0)) {
            require(block.chainid == 31_337, "SH_POOL_MANAGER is required outside the local chain");
            vm.broadcast(broadcaster);
            pmAddr = deployCode("PoolManager.sol:PoolManager", abi.encode(broadcaster));
        }
        // Only the local chain may fall back to the broadcaster for the registry admin and the treasury.
        bool local = block.chainid == 31_337;
        Params memory p = Params({
            poolManager: IPoolManager(pmAddr),
            admin: local ? vm.envOr("SH_ADMIN", broadcaster) : vm.envAddress("SH_ADMIN"),
            treasury: local ? vm.envOr("SH_TREASURY", broadcaster) : vm.envAddress("SH_TREASURY"),
            withConverter: vm.envOr("SH_WITH_CONVERTER", true)
        });
        require(p.admin != address(0) && p.treasury != address(0), "SH_ADMIN and SH_TREASURY must be non-zero");
        d = deploy(p, broadcaster);
        _printManifest(p, d);
    }
}
