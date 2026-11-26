// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyWeth} from "../cq11-c/RoyaltyRouter.t.sol";
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";
import {RoyaltyCowConfig} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {SafeProxyFixture} from "../m1-63/offchain/SafeProxyFixture.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {DeployCoreV2} from "../../../script/DeployCoreV2.s.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";

/// Only environment names differ from production; Safe, genesis, size and gas admissions are inherited unchanged.
contract FixtureDeployCoreV2 is DeployCoreV2 {
    string private _prefix;
    constructor(string memory prefix) { _prefix = prefix; }
    function _environmentKey(string memory key) internal view override returns (string memory) {
        return string.concat(_prefix, key);
    }
}

contract WSingleton {
    function VERSION() external pure returns (string memory) {
        return "1.4.1";
    }
}


contract WSingleton15 {
    function VERSION() external pure returns (string memory) {
        return "1.5.0";
    }
}

contract WSafe {
    // Slot zero is the delegate proxy singleton. Other mock state follows it.
    address public masterCopy;
    address public handler;

    function setHandler(address a) external {
        handler = a;
    }
    function setSingleton(address a) external {
        masterCopy = a;
    }

    function setOwners(address[] memory a) external {
        owners = a;
    }
    address[] private owners;
    uint256 private threshold;
    string public VERSION = "1.4.1";

    constructor(address[] memory initial, uint256 t) {
        owners = initial;
        threshold = t;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function setThreshold(uint256 n) external {
        threshold = n;
    }

    function setVersion(string memory s) external {
        VERSION = s;
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory, address) {
        return (new address[](0), address(1));
    }

    function getStorageAt(uint256 slot, uint256) external view returns (bytes memory) {
        return abi.encode(slot == uint256(keccak256("fallback_manager.handler.address")) ? handler : address(0));
    }
    receive() external payable {}
}

contract WBox0Read {
    address public platformSafe;
    address public poolManager;
    address public randomness;
    address public token;
    address public executor;

    constructor(address safe, address pm, address source, address t, address e) {
        platformSafe = safe;
        poolManager = pm;
        randomness = source;
        token = t;
        executor = e;
    }

    function coordinatorOf(uint256 id) external view returns (address) {
        require(id == 0);
        return address(this);
    }

    function coordinator() external view returns (address) {
        return address(this);
    }

    function receiver() external view returns (address) {
        return address(this);
    }

    function boxCount() external pure returns (uint256) {
        return 1;
    }

    function kind() external pure returns (uint8) {
        return 1;
    }

    function boxId() external pure returns (uint256) {
        return 0;
    }

    function q() external pure returns (address) {
        return address(0);
    }
}

/// Shared deployment scenarios, executed by M2DeploymentSeamsTest in m2-02/Box0Seams.t.sol.
/// Each instance saves its own CORE_V2_* pins and reapplies them immediately before the deploy run.
abstract contract CQ11WDeploymentFixture is Test {
    address internal constant DEPLOYER = address(0xD340);
    address internal constant BOT = address(0xB07);
    address internal constant FOUNDER = address(0xF00);
    address internal constant BACKUP = address(0xBAC);
    WSafe internal fit;
    WSafe internal platform;
    WSafe internal conversion;
    DeployCoreV2 internal script;
    WBox0Read internal box0;
    address internal manager;
    address internal weth;
    string private environmentPrefix;
    string[] private fixtureEnvKeys;
    string[] private fixtureEnvValues;

    function setUp() public {
        require(vm.isContext(VmSafe.ForgeContext.TestGroup) || vm.isContext(VmSafe.ForgeContext.ScriptDryRun),
            "offline fixture only");
        // Foundry suites share their host environment even when the EVMs are isolated. Give
        // this fixture its own key space; neither successful peers nor negative mutants can race it.
        environmentPrefix = string.concat(_environmentNamespace(), "_");
        vm.chainId(11_155_111);
        // Detect the configured EVM without an RPC; the chain timestamp must match its state-gas rules.
        bytes memory code = hex"6104006000f3";
        uint256 before_ = gasleft();
        address probe;
        assembly ("memory-safe") { probe := create(0, add(code, 32), mload(code)) }
        bool amsterdam = before_ - gasleft() > 1_000_000;
        assertGt(probe.code.length, 0);
        vm.warp(amsterdam ? 1_800_000_000 : 1_790_000_000);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        vm.deal(DEPLOYER, 100 ether);
        // Each offline wrapper has a separate EVM but shares the host environment. A fixed fixture
        // builder gives both worlds the same dependency addresses even when their setup overlaps.
        // Broadcast cheatcodes model the CREATE sender here; the context guard forbids sending/resume.
        vm.startBroadcast(address(0xF1C7));
        manager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        weth = address(new RoyaltyWeth());
        address[] memory owners = new address[](3);
        owners[0] = BOT;
        owners[1] = FOUNDER;
        owners[2] = BACKUP;
        address singleton = address(new WSafe(new address[](0), 0));
        fit = _proxy(singleton, owners, 2, "1.4.1");
        conversion = _proxy(singleton, owners, 2, "1.4.1");
        address[] memory one = new address[](1);
        one[0] = FOUNDER;
        WSafe platformSingleton = new WSafe(new address[](0), 0);
        platformSingleton.setVersion("1.5.0");
        address previousSingleton = address(platformSingleton);
        platform = _proxy(previousSingleton, one, 1, "1.5.0");
        _fixtureEnv("CORE_V2_SAFE_PROXY_CODEHASH", vm.toString(keccak256(type(SafeProxyFixture).runtimeCode)));
        _fixtureEnv("CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH", vm.toString(keccak256(type(SafeProxyFixture).runtimeCode)));
        platform.setHandler(previousSingleton);
        _fixtureEnv("CORE_V2_PLATFORM_SAFE_HANDLER", previousSingleton);
        _fixtureEnv("CORE_V2_SAFE_HANDLER", address(0));
        _fixtureEnv("CORE_V2_SAFE_GUARD", address(0));
        _fixtureEnv("CORE_V2_PLATFORM_SAFE_GUARD", address(0));
        _fixtureEnv("CORE_V2_SAFE_SINGLETON", singleton);
        _fixtureEnv("CORE_V2_PLATFORM_SAFE_VERSION", "1.5.0");
        _fixtureEnv("CORE_V2_PLATFORM_SAFE_SINGLETON", previousSingleton);
        _fixtureEnv("CORE_V2_PLATFORM_SAFE_SINGLETON_CODEHASH", vm.toString(previousSingleton.codehash));
        _fixtureEnv("CORE_V2_SAFE_SINGLETON_CODEHASH", vm.toString(singleton.codehash));
        (address source,) = DrandSourcePins.pinned(block.chainid);
        vm.etch(source, vm.getDeployedCode("DrandSource.sol:DrandSource"));
        box0 = new WBox0Read(address(platform), manager, source, weth, address(fit));
        script = new FixtureDeployCoreV2(environmentPrefix);
        _fixtureEnv("CORE_V2_DEPLOYER", DEPLOYER);
        _fixtureEnv("CORE_V2_POOL_MANAGER", manager);
        _fixtureEnv("CORE_V2_WETH", weth);
        RoyaltyCowConfig memory cow = RoyaltyRelease.config();
        _fixtureEnv("CORE_V2_COMPOSABLE_COW", cow.composableCow);
        _fixtureEnv("CORE_V2_COW_SETTLEMENT", cow.settlement);
        _fixtureEnv("CORE_V2_ROYALTY_MINIMUM_LOT", "10000000000000000");
        _fixtureEnv("CORE_V2_V1_REGISTRY", address(box0));
        _fixtureEnv("CORE_V2_BOX0", address(box0));
        _fixtureEnv("CORE_V2_FIT_SAFE", address(fit));
        _fixtureEnv("CORE_V2_PLATFORM_SAFE", address(platform));
        _fixtureEnv("CORE_V2_CONVERSION_SAFE", address(conversion));
        _fixtureEnv("CORE_V2_PINNED_FIT_SAFE", address(fit));
        _fixtureEnv("CORE_V2_PINNED_PLATFORM_SAFE", address(platform));
        _fixtureEnv("CORE_V2_PINNED_CONVERSION_SAFE", address(conversion));
        _fixtureEnv("CORE_V2_BOT", BOT);
        _fixtureEnv("CORE_V2_FOUNDER", FOUNDER);
        _fixtureEnv("CORE_V2_BACKUP", BACKUP);
        _fixtureEnv("CORE_V2_SAFE_VERSION", "1.4.1");
        _fixtureEnv("CORE_V2_BROADCAST", "false");
        _fixtureEnv("CORE_V2_WRITE_MANIFEST", "false");
        vm.stopBroadcast();
    }

    function _proxy(address singleton, address[] memory owners, uint256 threshold, string memory version)
        internal returns (WSafe safe)
    {
        safe = WSafe(payable(address(new SafeProxyFixture(singleton))));
        safe.setOwners(owners);
        safe.setThreshold(threshold);
        safe.setVersion(version);
    }

    function _environmentNamespace() internal view virtual returns (string memory) {
        return vm.toString(address(this).codehash);
    }

    function _setEnvironment(string memory key, string memory value) internal {
        vm.setEnv(string.concat(environmentPrefix, key), value);
    }

    function _env(string memory key, address value) internal {
        _setEnvironment(key, vm.toString(value));
    }

    function _fixtureEnv(string memory key, address value) private {
        _fixtureEnv(key, vm.toString(value));
    }

    function _fixtureEnv(string memory key, string memory value) private {
        fixtureEnvKeys.push(key);
        fixtureEnvValues.push(value);
        _setEnvironment(key, value);
    }

    function _run() internal returns (BoxFactoryV2 factory, string memory manifest) {
        // Foundry environment is process-wide; another wrapper's setup can run between ours and this call.
        // Restore saved expected identities, never derive expected pins from mutable Safe state.
        for (uint256 i; i < fixtureEnvKeys.length; ++i) _setEnvironment(fixtureEnvKeys[i], fixtureEnvValues[i]);
        (bool ok, bytes memory ret) = address(script).call(abi.encodeWithSignature("run()"));
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
        (address at, string memory json) = abi.decode(ret, (address, string));
        return (BoxFactoryV2(at), json);
    }

    function _refusedBeforeCreate() internal {
        uint64 nonce = vm.getNonce(DEPLOYER);
        (bool ok,) = address(script).call(abi.encodeWithSignature("run()"));
        assertFalse(ok, "unsafe release accepted");
        assertEq(vm.getNonce(DEPLOYER), nonce);
    }

    // The concrete M2 test runs these scenarios and its genesis seams under the same environment setup.
    function _assertDeploymentPreflightAndRealManifest() internal returns (BoxFactoryV2 f, string memory manifest) {
        _env("CORE_V2_FIT_SAFE", address(conversion));
        _refusedBeforeCreate();
        _env("CORE_V2_FIT_SAFE", address(fit));
        _env("CORE_V2_PLATFORM_SAFE", address(fit));
        _refusedBeforeCreate();
        _env("CORE_V2_PLATFORM_SAFE", address(platform));
        fit.setThreshold(1);
        _refusedBeforeCreate();
        fit.setThreshold(2);
        platform.setThreshold(2);
        _refusedBeforeCreate();
        platform.setThreshold(1);
        address[] memory owners = fit.getOwners();
        owners[2] = address(0xBAD);
        fit.setOwners(owners);
        _refusedBeforeCreate();
        owners[2] = BACKUP;
        fit.setOwners(owners);
        address previousHandler = platform.handler();
        platform.setHandler(address(fit));
        _refusedBeforeCreate();
        platform.setHandler(previousHandler);
        address singleton = fit.masterCopy();
        fit.setSingleton(address(conversion));
        _refusedBeforeCreate();
        vm.store(address(fit), bytes32(0), bytes32(uint256(uint160(singleton))));
        _setEnvironment("CORE_V2_SAFE_SINGLETON_CODEHASH", vm.toString(bytes32(uint256(1))));
        _refusedBeforeCreate();
        _setEnvironment("CORE_V2_SAFE_SINGLETON_CODEHASH", vm.toString(singleton.codehash));
        _env("CORE_V2_BOX0", address(fit));
        _refusedBeforeCreate();
        _env("CORE_V2_BOX0", address(box0));
        _setEnvironment("CORE_V2_SAFE_PROXY_CODEHASH", vm.toString(bytes32(uint256(1))));
        _refusedBeforeCreate();
        _setEnvironment("CORE_V2_SAFE_PROXY_CODEHASH", vm.toString(address(fit).codehash));
        _setEnvironment("CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH", vm.toString(bytes32(uint256(1))));
        _refusedBeforeCreate();
        _setEnvironment("CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH", vm.toString(address(platform).codehash));
        vm.recordLogs();
        (f, manifest) = _run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 steps;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("DeploymentGas(string,uint256,uint256)")) {
                (string memory label, uint256 used, uint256 stateGas) =
                    abi.decode(logs[i].data, (string, uint256, uint256));
                emit log_named_uint(label, used);
                emit log_named_uint("state gas", stateGas);
                ++steps;
            }
        }
        assertEq(steps, 30); // Eight additional shared fee/Parts deployment steps; no per-box modules.
        emit log_named_string("release manifest", manifest);
        assertEq(f.VERSION(), 2);
        BoxReceiverV2 r = BoxReceiverV2(f.implementation(5));
        assertEq(r.coordinatorImplementation(), f.implementation(0));
        assertEq(r.FIT_SAFE(), address(fit));
        assertEq(r.PLATFORM_SAFE(), address(platform));
        assertEq(vm.parseJsonAddress(manifest, ".safes.fit.address"), address(fit));
        assertEq(vm.parseJsonString(manifest, ".safes.fit.threshold"), "2");
        assertEq(vm.parseJsonAddressArray(manifest, ".safes.platform.owners")[0], FOUNDER);
        // SH-188: the custody roles beside the pins (the shared parser requires them on chain 1).
        assertEq(vm.parseJsonAddress(manifest, ".owners.founder"), FOUNDER);
        assertEq(vm.parseJsonAddress(manifest, ".owners.bot"), BOT);
        assertEq(vm.parseJsonAddress(manifest, ".owners.backup"), BACKUP);
        assertEq(vm.parseJsonString(manifest, ".safes.platform.version"), "1.5.0");
        assertEq(vm.parseJsonAddress(manifest, ".safes.platform.handler"), previousHandler);
        assertEq(vm.parseJsonAddress(manifest, ".box0.coordinator"), address(box0));
        assertEq(vm.parseJsonAddress(manifest, ".safes.fit.singleton"), singleton);
        assertEq(vm.parseJsonBytes32(manifest, ".safes.fit.codeHash"), address(fit).codehash);
        assertEq(vm.parseJsonBytes32(manifest, ".safes.platform.codeHash"), address(platform).codehash);
        assertEq(vm.parseJsonString(manifest, ".listings.0.id"), "0");
    }
}

/// Regression: another offline wrapper's setup may replace process-wide environment values.
contract CQ11WGlobalEnvironmentTest is CQ11WDeploymentFixture {
    function test_FM23_otherSuitesGlobalEnvironmentCannotReplaceThisFixturesPins() public {
        vm.setEnv("CORE_V2_POOL_MANAGER", vm.toString(address(0xBAD)));
        vm.setEnv("CORE_V2_PINNED_CONVERSION_SAFE", vm.toString(address(fit)));
        (address factory_,) = script.run();
        assertEq(address(BoxFactoryV2(factory_).poolManager()), manager);
    }

}

contract CQ11WEnvironmentTest is CQ11WDeploymentFixture {
    function test_runRestoresThisFixturesOwnEnvironment() public {
        _env("CORE_V2_POOL_MANAGER", address(0xBAD));
        _env("CORE_V2_FIT_SAFE", address(platform));
        _env("CORE_V2_PINNED_CONVERSION_SAFE", address(fit));
        _setEnvironment("CORE_V2_SAFE_SINGLETON_CODEHASH", vm.toString(bytes32(uint256(1))));
        (BoxFactoryV2 f, string memory manifest) = _run();
        assertEq(vm.parseJsonAddress(manifest, ".safes.fit.address"), address(fit));
        assertEq(address(f.poolManager()), manager);
    }
}
