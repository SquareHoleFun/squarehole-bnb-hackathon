// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {CoreV1Deployment} from "../../../script/lib/CoreV1Deployment.sol";
import {DeployCoreV1} from "../../../script/DeployCoreV1.s.sol";
import {PinnedBackedSource} from "../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../randomness/utils/PinnedDrandSource.sol";
import {MockWETH} from "../s45/BoxS45Mocks.sol";

/// @notice TEST ONLY. The Sepolia runbook's Step 2 and 3, sent from the testnet deployer's account at its nonce as
/// `script/DeployCoreV1.s.sol` sends them (each call to the CREATE2 deployer takes a nonce, which this account adds
/// itself), then box 0 from the spec file.
contract SepoliaStep2Deployer is CoreV1Deployment {
    // Foundry's test marker: this etched harness embeds deployment code for the whole version, never production.
    bool public constant IS_TEST = true;

    function deploy(IPoolManager pm, address weth, address platformSafe) external returns (CoreV1Version memory v) {
        v = _deployCoreV1(
            CoreV1Config({
                deployer: address(this),
                callsTakeNonce: true,
                poolManager: pm,
                weth: weth,
                platformSafe: platformSafe,
                box0Creator: address(this)
            })
        );
    }

    function create(BoxFactoryV1 factory, BoxSpecV1.BoxSpec calldata spec)
        external
        payable
        returns (address coordinator, address hook, bytes32 salt)
    {
        (, coordinator, hook, salt) = _createBox0(factory, spec);
    }

    function _deployDrandSource(address pinned) internal override {
        require(address(PinnedDrandSource.deploy(vm)) == pinned, "the pinned source");
        vm.setNonce(address(this), vm.getNonce(address(this)) + 1);
    }

    function _deployBackedSource(address pinned) internal override {
        require(address(PinnedBackedSource.deploy(vm)) == pinned, "the pinned backed source");
        vm.setNonce(address(this), vm.getNonce(address(this)) + 1);
    }
}

/// @title SepoliaStep2Box0Test (F143: the runbook's Step 2 identities after the backed source)
/// @notice docs/runbooks/sepolia-core-v1.md Step 2's addresses for the Safe file (`box0-spec.11155111.rehearsal.
/// sepolia-safe.json` in the rehearsal build, `box0-spec.11155111.safe.json` in the full-size build) at its example
/// opening time, on a local chain with Sepolia's id: the testnet deployer at nonce 13, Sepolia's PoolManager and WETH
/// addresses (code put there), both sources initially absent (sixteen steps). Since F143 the deployer's second call to
/// the CREATE2 deployer (box 0's BoxBackedSource) moves the factory, and so every box 0 address, by one nonce; the
/// implementations and the DrandSource keep theirs. The values below are the runbook's (the runbook test checks the
/// runbook names them); run under the default profile and FOUNDRY_PROFILE=rehearsal.
contract SepoliaStep2Box0Test is Test {
    address internal constant DEPLOYER = 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE;
    address internal constant PM = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    address internal constant FACTORY = 0x93118f6F6E059B69Cba1Ce3F9ac9Ab8E7B0bc087;
    address internal constant REGISTRY = 0xa94936CD8994FA94FA31bc1fC992586f2468bfcb;
    /// @dev The runbook's example opening time (2026-10-06 11:00 UTC), whose hook, salt and pool id the vector pins. The
    /// committed files hold box 0's deployed time since 2026-10-21 (Step 4's record); everything else in them is the same.
    uint32 internal constant EXAMPLE_OPEN_AT = 1_791_284_400;

    function test_step2_box0IdentitiesAreTheRunbooks() public {
        vm.pauseGasMetering();
        vm.chainId(11_155_111);
        deployCodeTo("PoolManager.sol:PoolManager", abi.encode(makeAddr("step2.pmOwner")), PM);
        vm.etch(WETH, address(new MockWETH()).code);
        vm.etch(DEPLOYER, address(new SepoliaStep2Deployer()).code);
        vm.setNonce(DEPLOYER, 13);
        DeployCoreV1 script = new DeployCoreV1();
        string memory file = BoxBuildV1.REHEARSAL
            ? "script/config/box0-spec.11155111.rehearsal.sepolia-safe.json"
            : "script/config/box0-spec.11155111.safe.json";
        BoxSpecV1.BoxSpec memory spec = script.specFromFile(file);
        spec.openAt = EXAMPLE_OPEN_AT;
        vm.warp(uint256(spec.openAt) - 1 hours);
        CoreV1Deployment.CoreV1Version memory v =
            SepoliaStep2Deployer(DEPLOYER).deploy(IPoolManager(PM), WETH, spec.marketplaceOwner);
        assertEq(v.factory, FACTORY, "Step 2's factory");
        assertEq(v.registry, REGISTRY, "Step 2's registry");
        assertEq(v.drand, DrandSourcePins.ADDRESS_SEPOLIA, "the DrandSource row, unchanged");
        assertEq(v.randomness, BackedSourcePins.ADDRESS_SEPOLIA, "the BoxBackedSource row");
        assertEq(v.impls.coordinator, vm.computeCreateAddress(DEPLOYER, 13), "the first implementation, unchanged");
        assertEq(v.planner, vm.computeCreateAddress(DEPLOYER, 24), "the planner, unchanged");
        vm.deal(DEPLOYER, BoxSpecV1.BOOTSTRAP_ETH);
        (address coordinator, address hook, bytes32 salt) =
            SepoliaStep2Deployer(DEPLOYER).create{value: BoxSpecV1.BOOTSTRAP_ETH}(BoxFactoryV1(v.factory), spec);
        IBoxFactoryV1.Box0Addresses memory b = BoxFactoryV1(v.factory).box0Addresses();
        assertEq(b.coordinator, coordinator);
        PoolKey memory key =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(b.token), BoxSpecV1.LP_FEE, 60, IHooks(hook));
        bytes32 poolId = keccak256(abi.encode(key));
        emit log_named_string("spec file", file);
        emit log_named_bytes32("spec hash", keccak256(abi.encode(spec)));
        emit log_named_bytes32("versionCodeHash", BoxFactoryV1(v.factory).versionCodeHash());
        emit log_named_bytes32("template id", BoxFactoryV1(v.factory).templateIdOf(spec));
        emit log_named_address("factory", v.factory);
        emit log_named_address("registry", v.registry);
        emit log_named_address("coordinator", coordinator);
        emit log_named_address("hook", hook);
        emit log_named_bytes32("hook salt", salt);
        emit log_named_address("token", b.token);
        emit log_named_address("vault", b.vault);
        emit log_named_address("collection", b.collection);
        emit log_named_address("receiver", b.receiver);
        emit log_named_address("launch router", b.launchRouter);
        emit log_named_address("tickets", b.tickets);
        emit log_named_address("royalty router", b.royaltyRouter);
        emit log_named_address("item stream", b.itemStream);
        emit log_named_address("executor", b.executor);
        emit log_named_address("metadata table", b.table);
        emit log_named_bytes32("pool id", poolId);
        string memory pins = vm.readFile("test/vectors/box/sepolia-step2.v1.json");
        string memory k = BoxBuildV1.REHEARSAL ? ".rehearsal" : ".default";
        assertEq(coordinator, vm.parseJsonAddress(pins, ".coordinator"), "coordinator");
        assertEq(b.token, vm.parseJsonAddress(pins, ".t"), "T (box 0's token)");
        assertEq(b.vault, vm.parseJsonAddress(pins, ".vault"), "vault");
        assertEq(b.collection, vm.parseJsonAddress(pins, ".collection"), "collection");
        assertEq(b.receiver, vm.parseJsonAddress(pins, ".receiver"), "receiver");
        assertEq(b.launchRouter, vm.parseJsonAddress(pins, ".launchRouter"), "launch router");
        assertEq(b.tickets, vm.parseJsonAddress(pins, ".tickets"), "tickets");
        assertEq(b.royaltyRouter, vm.parseJsonAddress(pins, ".royaltyRouter"), "royalty router");
        assertEq(b.itemStream, vm.parseJsonAddress(pins, ".itemStream"), "item stream");
        assertEq(b.executor, vm.parseJsonAddress(pins, ".executor"), "executor");
        assertEq(b.table, vm.parseJsonAddress(pins, ".table"), "metadata table");
        assertEq(hook, vm.parseJsonAddress(pins, string.concat(k, ".hook")), "hook");
        assertEq(salt, vm.parseJsonBytes32(pins, string.concat(k, ".hookSalt")), "hook salt");
        assertEq(poolId, vm.parseJsonBytes32(pins, string.concat(k, ".poolId")), "pool id");
    }
}
