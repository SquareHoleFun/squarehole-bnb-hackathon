// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../src/box/BoxFactoryV1Planner.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreV1Deployment} from "../../../script/lib/CoreV1Deployment.sol";
import {PinnedBackedSource} from "../../box/randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../box/randomness/utils/PinnedDrandSource.sol";
import {MockWETH} from "../../box/s45/BoxS45Mocks.sol";

/// @notice TEST ONLY. The Sepolia runbook's Step 2 (docs/runbooks/sepolia-core-v1.md:241-245): the version's steps
/// from the testnet deployer's account at its nonce, as `script/DeployCoreV1.s.sol` sends them from the founder's wallet
/// (`callsTakeNonce`). Its code is put at the deployer's address, so every CREATE is the wallet's; the wallet's one call
/// to the CREATE2 deployer (the pinned DrandSource, absent on Sepolia) takes a nonce, which this account adds itself.
contract Box0Step2Deployer is CoreV1Deployment {
    // Foundry's test marker: this etched harness embeds deployment code for the whole version, never production.
    bool public constant IS_TEST = true;

    function deploy(IPoolManager pm, address weth, address platformSafe) external returns (BoxFactoryV1) {
        CoreV1Version memory v = _deployCoreV1(
            CoreV1Config({
                deployer: address(this),
                callsTakeNonce: true,
                poolManager: pm,
                weth: weth,
                platformSafe: platformSafe,
                box0Creator: address(this)
            })
        );
        return BoxFactoryV1(v.factory);
    }

    function _deployDrandSource(address pinned) internal override {
        require(address(PinnedDrandSource.deploy(vm)) == pinned, "the pinned source");
        vm.setNonce(address(this), vm.getNonce(address(this)) + 1);
    }

    /// @dev Box 0's source (F143, absent on Sepolia too): the wallet's second call to the CREATE2 deployer.
    function _deployBackedSource(address pinned) internal override {
        require(address(PinnedBackedSource.deploy(vm)) == pinned, "the pinned backed source");
        vm.setNonce(address(this), vm.getNonce(address(this)) + 1);
    }
}

/// @title Box0CodePinTest (ticket M1-02; ADR-0017 § 10; BC-222, plan N16)
/// @notice The build half of box 0's pin: the code of every src/box/ contract in the build under test, and the factory's
/// `versionCodeHash`, equal the manifest `test/vectors/box0-pin/box0-pin.v1.json` (F126: graduation never blocks,
/// lossless stream retry, uninitialised clones refused; SH-V2-INT-FIX4 integration pin at 85675164).
/// `scripts/box0-pin.mjs --check` checks the rest without a build (sources, build profiles,
/// compiler settings; `pnpm test`, BC-222). So a changed source, build profile or compiler setting fails here too
/// whenever it changes box 0's bytecode, an environment override (FOUNDRY_* variables, a local .env) included.
/// - **Code:** sha256 of the lower-case hex text of each artifact's creation and runtime code (immutables as zeros),
///   scripts/bytecode-hashes.py's format, from clean default/rehearsal builds of the F126 integration reference
///   (docs/evidence/SH-V2-INT-FIX4.md; the companion vitest test pins the complete code tables' digests).
/// - **versionCodeHash:** the hash of the deployed implementations' code with their immutables, so it is a deployment's:
///   the one the Sepolia runbook's Step 2 prints (chain 11155111, the testnet deployer at nonce 13, Sepolia's PoolManager)
///   for each build, as recorded in docs/evidence/SH-box0-f126.md, "Final deployment identities". A local copy of that
///   deployment (no fork) must land the factory at Step 2's address and give that hash.
/// The build is the one `sh-box-build/` names (BoxBuildV1.REFUSED_CHAIN_ID: 1 in the rehearsal build): run under the
/// default profile and under FOUNDRY_PROFILE=rehearsal.
contract Box0CodePinTest is Test {
    struct CodePin {
        string artifact;
        string creation;
        string runtime;
        uint256 runtimeBytes;
    }

    string internal constant MANIFEST = "/test/vectors/box0-pin/box0-pin.v1.json";

    string internal _json;
    string internal _build;

    function setUp() public {
        _json = vm.readFile(string.concat(vm.projectRoot(), MANIFEST));
        _build = BoxBuildV1.REFUSED_CHAIN_ID == 1 ? "rehearsal" : "default";
    }

    /// Every src/box/ contract with code in this build has the pinned creation and runtime code, byte length included.
    function test_freeze_box0CodeIsThePinnedCandidate() public view {
        CodePin[] memory pins = abi.decode(vm.parseJson(_json, string.concat(".code.", _build)), (CodePin[]));
        assertGt(pins.length, 30, "the pin lists box 0's contracts");
        for (uint256 i; i < pins.length; ++i) {
            CodePin memory p = pins[i];
            bytes memory runtime = vm.getDeployedCode(p.artifact);
            assertEq(runtime.length, p.runtimeBytes, string.concat(p.artifact, ": runtime bytes"));
            assertEq(_hexHash(runtime), p.runtime, string.concat(p.artifact, ": runtime code"));
            assertEq(_hexHash(vm.getCode(p.artifact)), p.creation, string.concat(p.artifact, ": creation code"));
        }
    }

    /// The code hash is the manifest's format (box0-pin.mjs `codeHash`, scripts/bytecode-hashes.py): sha256 of the hex
    /// text, here of the vitest's one-contract build, `0x60016002`; one changed byte changes it, so a changed runtime
    /// code fails the pin above.
    function test_freeze_theCodeHashFormat() public view {
        assertEq(_hexHash(hex"60016002"), "c0d05cd35d488052ded41e76cb98a7190d5330cc4fcdb4803f8edbba6dbbd8cd");
        assertEq(_hexHash(hex"60016003"), "bb54bd95c382721e3b1e0097c0c3ca49da4b9002ae8e808d6a5b3ad8764fc0b8");
    }

    /// The factory of a local copy of the Sepolia runbook's Step 2 lands at Step 2's address with Step 2's
    /// versionCodeHash (the runbook's row for this build), so every implementation's code, immutables included, and
    /// the planner's are the candidate's.
    function test_freeze_versionCodeHashIsSepoliaStep2s() public {
        BoxFactoryV1 f = _step2();
        assertEq(address(f), vm.parseJsonAddress(_json, ".versionCodeHash.factory"), "Step 2's factory address");
        bytes32 want = vm.parseJsonBytes32(_json, string.concat(".versionCodeHash.", _build));
        assertEq(f.versionCodeHash(), want, string.concat("Step 2's versionCodeHash, ", _build, " build"));
    }

    /// The candidate's ceilings (F97: F87, F90 R16H, F95 R19M), not an earlier box 0's, read from Step 2's
    /// implementations: the observer cap 460,000 in the collection and the vault and POKE_GAS 2,600,000 (their 10,000
    /// floor margins are private constants; the code pin covers them).
    function test_freeze_theCandidatesCeilings() public {
        BoxFactoryV1Planner.Version memory v = _step2().version();
        assertEq(BoxCoordinator(v.coordinatorImpl).POKE_GAS(), 2_600_000, "POKE_GAS (F95 R19M)");
        assertEq(BoxCollection(v.collectionImpl).OBSERVER_GAS(), 460_000, "the collection's observer cap (F90 R16H)");
        assertEq(BoxVault(v.vaultImpl).OBSERVER_GAS(), 460_000, "the vault's observer cap (F90 R16H)");
    }

    /// @dev Step 2 on a local chain with Sepolia's id: Sepolia's PoolManager and WETH addresses (code put there), the
    /// testnet deployer at its nonce, the pinned DrandSource absent until the deployer sends it.
    function _step2() internal returns (BoxFactoryV1) {
        vm.chainId(vm.parseJsonUint(_json, ".versionCodeHash.chainId"));
        IPoolManager pm = IPoolManager(vm.parseJsonAddress(_json, ".versionCodeHash.poolManager"));
        address weth = vm.parseJsonAddress(_json, ".versionCodeHash.weth");
        deployCodeTo("PoolManager.sol:PoolManager", abi.encode(makeAddr("v1pin.pmOwner")), address(pm));
        vm.etch(weth, address(new MockWETH()).code);
        address deployer = vm.parseJsonAddress(_json, ".versionCodeHash.deployer");
        vm.etch(deployer, address(new Box0Step2Deployer()).code);
        vm.setNonce(deployer, uint64(vm.parseJsonUint(_json, ".versionCodeHash.nonce")));
        return Box0Step2Deployer(deployer).deploy(pm, weth, makeAddr("v1pin.platformSafe"));
    }

    /// @dev sha256 of the lower-case hex text without "0x" (vm.toString writes lower case; no other "0x" in hex).
    function _hexHash(bytes memory code) internal view returns (string memory) {
        return vm.replace(vm.toString(sha256(bytes(vm.replace(vm.toString(code), "0x", "")))), "0x", "");
    }
}
