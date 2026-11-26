// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreV1Deployment, IPoolManager, BoxFactoryV1, BoxSpecV1} from "../../script/lib/CoreV1Deployment.sol";
import {DeployCoreV1} from "../../script/DeployCoreV1.s.sol";
import {DrandSourcePins} from "../../src/box/randomness/DrandSourcePins.sol";
import {PinnedDrandSource} from "./randomness/utils/PinnedDrandSource.sol";

/// Local deployment identity rehearsal. No fork, RPC, key or transaction submission.
/// Canonical dependency addresses carry STOP code: this measures identity, not their behavior.
contract DeployCoreV1IdentitiesTest is Test, CoreV1Deployment {
    address internal constant DEPLOYER = 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE;
    address internal constant PM = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    function test_deploymentMatchesRunbookIdentityPins() public {
        vm.pauseGasMetering();
        vm.chainId(11_155_111);
        vm.etch(PM, hex"00");
        vm.etch(WETH, hex"00");
        vm.etch(DrandSourcePins.DEPLOYER, PinnedDrandSource.DEPLOYER_CODE);
        vm.setNonce(DEPLOYER, 13);
        // Foundry only simulates these transactions in the test EVM. Use the script's nonce model unchanged.
        vm.startBroadcast(DEPLOYER);
        CoreV1Version memory v = _deployCoreV1(CoreV1Config({
            deployer: DEPLOYER, callsTakeNonce: true, poolManager: IPoolManager(PM), weth: WETH,
            platformSafe: DEPLOYER, box0Creator: DEPLOYER
        }));
        vm.stopBroadcast();
        emit log_named_address("factory", v.factory);
        emit log_named_address("registry", v.registry);
        // F143: one more CREATE2 call (box 0's BoxBackedSource) before the factory, so the factory is at nonce 27.
        assertEq(v.factory, vm.computeCreateAddress(DEPLOYER, 13 + 12 + 2), "after twelve CREATEs and two calls");
        assertTrue(v.drandDeployed, "the DrandSource was absent");
        assertTrue(v.randomnessDeployed, "the BoxBackedSource was absent");
        assertEq(_coreV1Steps.length, 15, "twelve CREATEs, the two sources, the factory");
        BoxFactoryV1 f = BoxFactoryV1(v.factory);
        DeployCoreV1 script = new DeployCoreV1();
        BoxSpecV1.BoxSpec memory spec = script.specFromFile(BoxBuildV1.REHEARSAL
            ? "script/config/box0-spec.11155111.rehearsal.json" : "script/config/box0-spec.11155111.json");
        bytes32 version = f.versionCodeHash();
        bytes32 template = f.templateIdOf(spec);
        emit log_named_bytes32("versionCodeHash", version);
        emit log_named_bytes32("templateId", template);
        for (uint256 i; i < _coreV1Steps.length; ++i) {
            emit log_named_bytes32(_coreV1Steps[i].label, _coreV1Steps[i].at.codehash);
        }
        emit log_named_bytes32("registry", v.registry.codehash);
        // The default and Safe Sepolia variants share a structural template; data is not a code identity.
        if (!BoxBuildV1.REHEARSAL) {
            assertEq(f.templateIdOf(script.specFromFile("script/config/box0-spec.11155111.safe.json")), template);
        }
        string memory pins = vm.readFile("script/config/core-v1-identity-pins.json");
        assertEq(v.factory, vm.parseJsonAddress(pins, ".factory"), "the factory's address pin");
        assertEq(v.registry, vm.parseJsonAddress(pins, ".registry"), "the registry's address pin");
        string memory key = BoxBuildV1.REHEARSAL ? ".rehearsal" : ".mainnet";
        assertEq(version, vm.parseJsonBytes32(pins, string.concat(key, ".versionCodeHash")), "versionCodeHash pin");
        assertEq(template, vm.parseJsonBytes32(pins, string.concat(key, ".templateId")), "template id pin");
        for (uint256 i; i < _coreV1Steps.length; ++i) {
            string memory entry = string.concat(key, ".runtimeCodeHashes[", vm.toString(i), "]");
            assertEq(vm.parseJsonString(pins, string.concat(entry, ".role")), _coreV1Steps[i].label);
            assertEq(vm.parseJsonBytes32(pins, string.concat(entry, ".codeHash")), _coreV1Steps[i].at.codehash);
        }
        assertEq(vm.parseJsonBytes32(pins, string.concat(key, ".runtimeCodeHashes[15].codeHash")), v.registry.codehash);
    }
}
