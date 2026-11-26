// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV1} from "../../src/box/BoxFactoryV1.sol";
import {BoxRegistry} from "../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {IBoxRegistry} from "../../src/box/interfaces/IBoxRegistry.sol";
import {CoreV1Deployment} from "../lib/CoreV1Deployment.sol";
import {BoxBackedSource} from "../../src/box/randomness/BoxBackedSource.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {MockWETH} from "../../test/box/s45/BoxS45Mocks.sol";
import {LocalTwin} from "./LocalTwin.sol";

/// @title DeployCoreV1Local
/// @notice LOCAL ONLY (S10a, docs/design/s10a-core-v1-site.md § 7.1): core v1 and box 0 on a local anvil that uses
/// Sepolia's chain id (a "local twin": factory v1 refuses a drand source that is not pinned for `block.chainid`, and pins
/// exist for chains 1 and 11155111 only, so a 31337 anvil cannot hold core v1 without a contract change). It runs the
/// steps of the founder's `script/DeployCoreV1.s.sol` through the same library (`CoreV1Deployment`), with what a fresh
/// anvil lacks put in first: a PoolManager compiled from the pinned source and a local WETH (as the core test kit does,
/// `CoreBox0Kit.setUpWorld`), then the pinned DrandSource through the deterministic deployer, the factory, and box 0
/// from the repository's fixture spec with a short open delay. Test tooling beside the app: a swap router the life run
/// (`CoreV1LocalLife.s.sol`) trades through. The founder's script is not touched and never runs here.
///
/// **Refuses** any chain id but 11155111 and any node that is not anvil (`web3_clientVersion`), so it can never send to
/// Sepolia itself. Signed by anvil's own unlocked account (`--unlocked --sender <anvil account 0>`): no key anywhere.
///
/// Inputs (environment): `SH_CORE_LOCAL_OPEN_DELAY`, in **seconds** since F80 (openAt is a clock time): box 0 opens at
/// the planning block's time + this delay (default 240, the old 20 blocks of 12 s; 0 = Now, the block after creation);
/// `SH_CORE_LOCAL_SPEC` (optional): an ABI-encoded BoxSpec (hex) to create box 0 from instead of the fixture, for the
/// builder kit's stand-in (scripts/builder-kit/box0-standin.mjs: template 0 without box 0's texts, pictures or table;
/// its openAt is replaced by the local open time, as the fixture's is).
/// Output: `LOCAL|<name>|<address>` lines on stdout for packages/chain/scripts/local-core-chain.mjs (addresses only: the
/// simulation runs every transaction in one block, so the caller reads the creation block and the hook's openAt() from
/// the chain).
contract DeployCoreV1Local is Script, CoreV1Deployment {
    uint256 public constant SEPOLIA_TWIN = 11_155_111;
    string internal constant FIXTURE_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    error SpecRefused(bytes reason);

    function run() external returns (address factory, address registry, address swapper) {
        _checkLocal();
        address deployer = msg.sender;
        BoxSpecV1.BoxSpec memory spec = localSpec(_localOpenAt());

        vm.startBroadcast(deployer);
        IPoolManager pm = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(deployer)));
        address weth = address(new MockWETH());
        CoreV1Version memory v = _deployCoreV1(
            CoreV1Config({
                deployer: deployer,
                callsTakeNonce: true,
                poolManager: pm,
                weth: weth,
                platformSafe: BoxSpecV1.PLATFORM_SAFE_MAINNET,
                box0Creator: deployer
            })
        );
        BoxFactoryV1 f = BoxFactoryV1(v.factory);
        bytes memory refused = f.refusal(spec, deployer);
        if (refused.length != 0) revert SpecRefused(refused);
        (, address coordinator, address hook,) = _createBox0(f, spec);
        swapper = address(new PriceLimitSwapper(pm));
        vm.stopBroadcast();

        factory = v.factory;
        registry = v.registry;
        IBoxRegistry.BoxRecord memory r = BoxRegistry(registry).recordOf(0);
        console.log(string.concat("LOCAL|factory|", vm.toString(factory)));
        console.log(string.concat("LOCAL|registry|", vm.toString(registry)));
        console.log(string.concat("LOCAL|poolManager|", vm.toString(address(pm))));
        console.log(string.concat("LOCAL|weth|", vm.toString(weth)));
        console.log(string.concat("LOCAL|swapper|", vm.toString(swapper)));
        console.log(string.concat("LOCAL|coordinator|", vm.toString(coordinator)));
        console.log(string.concat("LOCAL|hook|", vm.toString(hook)));
        string[13] memory roles = [
            "coordinator",
            "token",
            "hook",
            "vault",
            "collection",
            "receiver",
            "launchRouter",
            "tickets",
            "royaltyRouter",
            "executor",
            "itemStream",
            "swapModule",
            "metadataTable"
        ];
        for (uint256 i = 1; i < 13; ++i) {
            if (i != 2) console.log(string.concat("LOCAL|", roles[i], "|", vm.toString(r.contracts[i])));
        }
        console.log(string.concat("LOCAL|randomness|", vm.toString(r.randomness)));
        // F143: box 0's source is the BoxBackedSource; rounds are posted on the DrandSource it names.
        console.log(string.concat("LOCAL|drand|", vm.toString(address(BoxBackedSource(r.randomness).DRAND()))));
    }

    /// @dev Chain id 11155111 on an anvil node only (never Sepolia itself): LocalTwin.check.
    function _checkLocal() internal {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
    }

    /// @dev A local clock time: now + SH_CORE_LOCAL_OPEN_DELAY seconds (default 240 = the old 20 blocks); 0 = Now.
    function _localOpenAt() internal view returns (uint32) {
        uint256 delay = vm.envOr("SH_CORE_LOCAL_OPEN_DELAY", uint256(240));
        return delay == 0 ? 0 : uint32(block.timestamp + delay);
    }

    /// @notice Box 0's fixture (vector 0 of the shared BoxSpec vectors), or the spec in `SH_CORE_LOCAL_SPEC` when it is
    /// set, with a local open time (0 = Now).
    function localSpec(uint32 openAt) public view returns (BoxSpecV1.BoxSpec memory s) {
        bytes memory given = vm.envOr("SH_CORE_LOCAL_SPEC", bytes(""));
        bytes memory encoded =
            given.length != 0 ? given : vm.parseJsonBytes(vm.readFile(FIXTURE_VECTORS), ".columns.encoded[0]");
        s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        s.openAt = openAt;
    }
}
