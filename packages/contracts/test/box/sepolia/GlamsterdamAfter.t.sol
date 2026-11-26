// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxRegistry} from "../../../src/box/BoxRegistry.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {DeployCoreV1} from "../../../script/DeployCoreV1.s.sol";
import {DeployCoreV1Devnet} from "../../../script/rehearsal/DeployCoreV1Devnet.s.sol";
import {BoxS7Base} from "../s7/BoxS7Base.sol";
import {DeployCoreV1Harness} from "../s7/BoxFactoryV1Deploy.t.sol";
import {MainnetSpecFixture} from "./MainnetSpecFixture.sol";

/// @notice TEST ONLY: the devnet rehearsal's script (Sepolia's fork time 0, refused past block 1,000,000).
contract DeployCoreV1DevnetHarness is DeployCoreV1Devnet {
    function checkGlamsterdamWindow(uint256 chainId, uint256 timestamp, bool acknowledged) external view {
        _checkGlamsterdamWindow(chainId, timestamp, acknowledged);
    }

    function checkGlamsterdamRules(uint256 chainId, uint256 timestamp, uint256 gasPerCodeByte) external view {
        _checkGlamsterdamRules(chainId, timestamp, gasPerCodeByte, 0);
    }
}

/// @notice The runbook's Z1 = after (docs/runbooks/sepolia-core-v1.md; docs/evidence/SH-glamsterdam-after.md): core v1
/// deployed on Sepolia after its Glamsterdam fork (2026-10-06 13:53:36 UTC) with forge simulating EIP-8037
/// (`forge script --hardfork amsterdam --gas-estimate-multiplier 110`). The deploy script's rules:
/// - forge's EVM charges EIP-8037 after the fork (measured: 1,530 gas per code byte), and does not before it (its limits
///   would pass EIP-7825's cap, which Sepolia enforces until the fork); on mainnet (no Glamsterdam time in the script)
///   it charges a code byte what the chain itself charges, read through the RPC (review of d091e6bd, finding 2);
/// - EIP-7825's cap binds each step's execution gas only (EIP-8037: state gas comes from the reservoir above the cap),
///   with the margin of Z1 = before; before the fork all gas is execution gas, so Z1 = before's rule is unchanged;
/// - under EIP-8037 each step's planned limit (Z1 = after's 110%, forge's search above a call's use) leaves 5,000,000
///   of the block gas limit, since a transaction is included only while its whole limit fits its block's state gas.
/// forge-config: default.evm_version = "osaka"
contract GlamsterdamAfterTest is BoxS7Base {
    // Load script harness artifacts instead of embedding them: the old suite's 822,836 bytes cost
    // 164,567,200 gas at 200/byte, 1,258,939,080 at Amsterdam's 1,530/byte, above Forge's constructor budget.
    uint256 internal constant SEPOLIA = 11_155_111;
    uint256 internal constant SEPOLIA_GAS_LIMIT = 60_000_000;

    function _step(string memory label, uint256 gas, uint256 stateGas, bool viaCall)
        internal
        pure
        returns (CoreV1Step memory)
    {
        return CoreV1Step({
            label: label, gas: gas, initCodeBytes: 0, at: address(0), stateGas: stateGas, viaCall: viaCall
        });
    }

    function _one(CoreV1Step memory s) internal pure returns (CoreV1Step[] memory a) {
        a = new CoreV1Step[](1);
        a[0] = s;
    }

    // ============================================================================================================
    // The step rules on chosen figures

    /// Before EIP-8037 a step's gas is all execution gas: the cap with forge's default 130% and 500,000 to spare
    /// (12,405,550), exactly Z1 = before's rule; the block plays no part.
    function test_stepGas_withoutEip8037_allGasIsExecutionGas() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        uint256 max = h.TX_GAS_CAP() * 100 / h.GAS_ESTIMATE_MULTIPLIER() - 500_000;
        assertEq(max, 12_405_550);
        h.checkStepGas(_one(_step("at the line", max, 0, false)), false, SEPOLIA_GAS_LIMIT);
        h.checkStepGas(_one(_step("a call at the line", max, 0, true)), false, SEPOLIA_GAS_LIMIT);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.StepGasTooHigh.selector, "over", max + 1, max));
        h.checkStepGas(_one(_step("over", max + 1, 0, false)), false, SEPOLIA_GAS_LIMIT);
        // Without EIP-8037 nothing is held to the block: a 30M-gas block takes a 12.4M step whatever its limit.
        h.checkStepGas(_one(_step("small block", max, 0, false)), false, 1);
    }

    /// Under EIP-8037: execution gas (gas less state gas) to the same cap, and each planned limit (a CREATE's gas, a
    /// call's with 115%, times 110%) to the block gas limit less 5,000,000.
    function test_stepGas_underEip8037_executionToTheCapAndTheLimitToTheBlock() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        assertEq(h.GAS_ESTIMATE_MULTIPLIER_AFTER(), 110);
        assertEq(h.CALL_LIMIT_ALLOWANCE(), 115);
        assertEq(h.BLOCK_STATE_GAS_ROOM(), 5_000_000);
        uint256 maxExec = 12_405_550;
        // A 45M creation of which 44M is state gas: 1M of execution gas, a 49.5M limit in a 60M block.
        CoreV1Step memory create = _step("create", 45_000_000, 44_000_000, false);
        assertEq(h.executionGas(create), 1_000_000);
        assertEq(h.plannedLimit(create), 49_500_000);
        h.checkStepGas(_one(create), true, SEPOLIA_GAS_LIMIT);
        h.checkStepGas(_one(create), true, 54_500_000);
        vm.expectRevert(
            abi.encodeWithSelector(DeployCoreV1.StepTooBigForBlock.selector, "create", 49_500_000, 49_499_999)
        );
        h.checkStepGas(_one(create), true, 54_499_999);
        // A call is planned 15% above its gas before the multiplier: 40M -> 50.6M.
        CoreV1Step memory call = _step("call", 40_000_000, 37_600_000, true);
        assertEq(h.plannedLimit(call), 50_600_000);
        h.checkStepGas(_one(call), true, SEPOLIA_GAS_LIMIT);
        vm.expectRevert(
            abi.encodeWithSelector(DeployCoreV1.StepTooBigForBlock.selector, "call", 50_600_000, 50_000_000)
        );
        h.checkStepGas(_one(call), true, 55_000_000);
        // State gas does not excuse execution gas: 30M of which 15M state leaves 15M of execution, over the cap.
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.StepGasTooHigh.selector, "exec", 15_000_000, maxExec));
        h.checkStepGas(_one(_step("exec", 30_000_000, 15_000_000, false)), true, 200_000_000);
        // A frame that undid more state than it made counts as no state gas (all execution).
        assertEq(h.executionGas(_step("undo", 1_000_000, 0, false)), 1_000_000);
        assertEq(h.executionGas(_step("odd", 1_000_000, 2_000_000, false)), 0);
        // The block rule binds only under EIP-8037.
        h.checkStepGas(_one(create), false, 1);
    }

    // ============================================================================================================
    // Which EVM each chain and time takes

    /// Sepolia after the fork: forge's EVM must charge EIP-8037 (1,530 a byte; 200 is refused). Before it: it must not
    /// (the limits would pass EIP-7825's cap, which Sepolia enforces until the fork). Sepolia's rules follow its time
    /// alone (the chain's figure plays no part there). Mainnet: below.
    function test_glamsterdamRules_eachChainAndTime() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        uint256 g = h.GLAMSTERDAM_SEPOLIA();
        uint256 min = h.STATE_GAS_PER_CODE_BYTE_MIN();
        h.checkGlamsterdamRules(SEPOLIA, g, 1_530, 0);
        h.checkGlamsterdamRules(SEPOLIA, g + 1 days, min, 200);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotSimulated.selector, 200, min));
        h.checkGlamsterdamRules(SEPOLIA, g, 200, 1_530);
        h.checkGlamsterdamRules(SEPOLIA, g - 1, 200, 0);
        h.checkGlamsterdamRules(SEPOLIA, g - 2 hours, 200, 1_530);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamSimulatedBeforeFork.selector, g - 1, g));
        h.checkGlamsterdamRules(SEPOLIA, g - 1, 1_530, 1_530);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamSimulatedBeforeFork.selector, g - 2 hours, g));
        h.checkGlamsterdamRules(SEPOLIA, g - 2 hours, min, 0);
    }

    /// Mainnet has no Glamsterdam time in the script (EIP-7773's Mainnet row is empty): the chain itself decides. Its
    /// RPC's estimate of the script's two measuring creations gives what a code byte costs there (201 on publicnode and
    /// Tenderly today: an estimate is up to about 1.6% above the gas used), and forge's EVM must charge the same: both
    /// with EIP-8037 or both without, the chain's figure at most 5% above forge's. Review of d091e6bd, finding 2: before,
    /// a mainnet run without `--hardfork amsterdam` passed every check after mainnet's fork, its limits about a seventh
    /// of the gas (BoxCoordinator about 3.0M for 16.5M), and the first creation would run out of gas on chain.
    function test_mainnet_forgeChargesACodeByteWhatTheChainCharges() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        assertEq(h.CHAIN_CODE_BYTE_GAS_MAX_PERCENT(), 105);
        for (uint256 t = 1_700_000_000; t <= 1_900_000_000; t += 100_000_000) {
            // Before mainnet's fork (today): neither charges EIP-8037.
            h.checkGlamsterdamRules(1, t, 200, 201);
            h.checkGlamsterdamRules(1, t, 200, 210);
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 200, 211));
            h.checkGlamsterdamRules(1, t, 200, 211);
            // forge charges EIP-8037, the chain does not (yet): the limits would pass EIP-7825's cap.
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 1_530, 201));
            h.checkGlamsterdamRules(1, t, 1_530, 201);
            // After mainnet's fork: forge must charge it too (the finding).
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 200, 1_530));
            h.checkGlamsterdamRules(1, t, 200, 1_530);
            h.checkGlamsterdamRules(1, t, 1_530, 1_530);
            h.checkGlamsterdamRules(1, t, 1_530, 1_606);
            // A mainnet whose price per byte is above Foundry's (EIP-8038's values are not final): refused.
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 1_530, 1_607));
            h.checkGlamsterdamRules(1, t, 1_530, 1_607);
            // Below it: forge's limits are only higher (the block check holds them).
            h.checkGlamsterdamRules(1, t, 1_530, 1_200);
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 1_530, 999));
            h.checkGlamsterdamRules(1, t, 1_530, 999);
        }
    }

    /// The chain's figure: the RPC's `eth_estimateGas` of the same two creations (`vm.rpc` hands back the quantity's
    /// bytes, e.g. 0x03efba for anvil's 257,978), read as a number; anything else is refused.
    function test_chainMeasurement_asksTheRpcForTheTwoCreations() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        assertEq(h.estimateParams(1_024), '[{"data":"0x6104006000f3"},"latest"]');
        assertEq(h.estimateParams(2_048), '[{"data":"0x6108006000f3"},"latest"]');
        assertEq(h.rpcQuantity(hex"03efba"), 257_978);
        assertEq(h.rpcQuantity(hex"32fd88"), 3_341_704);
        assertEq(h.rpcQuantity(hex"01"), 1);
        assertEq(h.rpcQuantity(abi.encodePacked(type(uint256).max)), type(uint256).max);
        vm.expectRevert(bytes("not an RPC quantity"));
        h.rpcQuantity("");
        vm.expectRevert(bytes("not an RPC quantity"));
        h.rpcQuantity(new bytes(33));
    }

    /// The whole run's measurement (the script's own): osaka 200 a byte, amsterdam 1,530; with each, the rules above
    /// (mainnet's with the chain's figure, which a test sets: there is no RPC here).
    function test_glamsterdamSimulated_measuresTheEvmForgeRunsIn() public {
        vm.setEvmVersion("osaka"); // The pre-fork half must not inherit the CLI hardfork.
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        uint256 g = h.GLAMSTERDAM_SEPOLIA();
        (bool stateGas, uint256 perByte) = h.checkGlamsterdamSimulated(SEPOLIA, g - 2 hours);
        assertFalse(stateGas);
        assertEq(perByte, 200, "osaka: the code deposit");
        h.setChainCodeByteGas(201);
        (stateGas, perByte) = h.checkGlamsterdamSimulated(1, g);
        assertFalse(stateGas);
        vm.setEvmVersion("amsterdam");
        (stateGas, perByte) = h.checkGlamsterdamSimulated(SEPOLIA, g);
        assertTrue(stateGas);
        assertEq(perByte, 1_530, "EIP-8037: 1,530 a code byte");
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamSimulatedBeforeFork.selector, g - 2 hours, g));
        h.checkGlamsterdamSimulated(SEPOLIA, g - 2 hours);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 1_530, 201));
        h.checkGlamsterdamSimulated(1, g);
        h.setChainCodeByteGas(1_545);
        (stateGas, perByte) = h.checkGlamsterdamSimulated(1, g);
        assertTrue(stateGas);
        vm.setEvmVersion("osaka");
    }

    // ============================================================================================================
    // run(), the founder's entry point: its guards where it calls them (review of d091e6bd, finding 1: a run() that
    // measured but never checked, or held no step to the block, passed every test that called the guards directly)

    uint256 internal constant FORK = 1_791_294_816;

    /// @dev The script's harness on `chainId` at time `t`: the chain's PoolManager built in place (its immutables name
    /// its own address), WETH's code, the CREATE2 deployer (setUp put it there), the pinned DrandSource removed when
    /// `sourceMissing` (as on Sepolia today: the run deploys both sources, sixteen steps), a funded deployer that is box 0's
    /// creator, and the plan for box 0's fixture opening Now, with Z1 = after's acknowledgement.
    /// Mainnet gas tests use a synthetic commitment, checked by the unchanged mainnet guard before runFrom.
    function _runner(uint256 chainId, uint256 t, bool sourceMissing)
        internal
        returns (DeployCoreV1Harness h, DeployCoreV1.Plan memory p)
    {
        h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        vm.chainId(chainId);
        vm.warp(t);
        bool sepolia = chainId == SEPOLIA;
        deployCodeTo(
            "PoolManager.sol:PoolManager",
            abi.encode(makeAddr("glam.pmOwner")),
            sepolia ? h.POOL_MANAGER_SEPOLIA() : h.POOL_MANAGER_MAINNET()
        );
        vm.etch(sepolia ? h.WETH_SEPOLIA() : h.WETH_MAINNET(), address(weth).code);
        assertGt(DrandSourcePins.DEPLOYER.code.length, 0, "the CREATE2 deployer (setUp)");
        if (sourceMissing) {
            (address pinned,) = DrandSourcePins.pinned(chainId);
            vm.etch(pinned, "");
            vm.resetNonce(pinned);
            (address backed,) = BackedSourcePins.pinned(chainId);
            vm.etch(backed, "");
            vm.resetNonce(backed);
        }
        address deployer = makeAddr("glam.deployer");
        vm.deal(deployer, 1 ether);
        if (chainId == 1) {
            // planFor with an empty spec path rightly refuses the repository fixture on mainnet. Build this
            // test-only plan in memory; the callers check its synthetic spec before exercising the run's gas rules.
            p = DeployCoreV1.Plan({
                deployer: deployer,
                sending: false,
                poolManager: IPoolManager(h.POOL_MANAGER_MAINNET()),
                weth: h.WETH_MAINNET(),
                platformSafe: SAFE,
                box0Creator: deployer,
                fixture: true,
                specFile: "",
                spec: MainnetSpecFixture.withCommitment(h.fixtureSpec())
            });
        } else {
            p = h.planFor(deployer, SAFE, deployer, "", true);
        }
        p.spec.openAt = 0;
    }

    /// (a) Sepolia an hour after the fork, forge without EIP-8037 (no `--hardfork amsterdam`): run() refuses before
    /// anything is planned to be sent.
    function test_run_afterTheFork_withoutEip8037_refuses() public {
        vm.setEvmVersion("osaka"); // The pre-fork half must not inherit the CLI hardfork.
        (DeployCoreV1Harness h, DeployCoreV1.Plan memory p) = _runner(SEPOLIA, FORK + 1 hours, true);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotSimulated.selector, 200, 1_000));
        h.runFrom(p, SEPOLIA_GAS_LIMIT);
    }

    /// (b) Sepolia two hours before the fork, forge with EIP-8037: refused (its limits would pass EIP-7825's cap).
    function test_run_beforeTheFork_withEip8037_refuses() public {
        (DeployCoreV1Harness h, DeployCoreV1.Plan memory p) = _runner(SEPOLIA, FORK - 2 hours, true);
        vm.setEvmVersion("amsterdam");
        vm.expectRevert(
            abi.encodeWithSelector(DeployCoreV1.GlamsterdamSimulatedBeforeFork.selector, FORK - 2 hours, FORK)
        );
        h.runFrom(p, SEPOLIA_GAS_LIMIT);
        vm.setEvmVersion("osaka");
    }

    /// (c) Mainnet: forge without EIP-8037 while the chain charges it (finding 2), and with it while the chain does not.
    function test_run_onMainnet_forgeMustChargeWhatTheChainCharges() public {
        vm.setEvmVersion("osaka"); // The pre-fork half must not inherit the CLI hardfork.
        (DeployCoreV1Harness h, DeployCoreV1.Plan memory p) = _runner(1, 1_800_000_000, false);
        h.checkSpecForChain(1, p.spec);
        h.setChainCodeByteGas(1_545);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 200, 1_545));
        h.runFrom(p, SEPOLIA_GAS_LIMIT);
        h.setChainCodeByteGas(201);
        vm.setEvmVersion("amsterdam");
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.ChainRulesNotSimulated.selector, 1, 1_530, 201));
        h.runFrom(p, SEPOLIA_GAS_LIMIT);
        vm.setEvmVersion("osaka");
    }

    /// (d) Sepolia after the fork under EIP-8037 with a 50M block: everything is simulated, then refused at the factory
    /// (its planned limit, about 48M, passes 50M less 5M) before anything would be sent.
    function test_run_afterTheFork_underEip8037_refusesA50MBlock() public {
        (DeployCoreV1Harness h, DeployCoreV1.Plan memory p) = _runner(SEPOLIA, FORK + 1 hours, true);
        vm.setEvmVersion("amsterdam");
        vm.expectPartialRevert(DeployCoreV1.StepTooBigForBlock.selector);
        h.runFrom(p, 50_000_000);
        vm.setEvmVersion("osaka");
    }

    /// (e) The same in Sepolia's 60M block: the whole run, sixteen steps (both sources deployed as on Sepolia today), box
    /// 0 created and recorded.
    function test_run_afterTheFork_underEip8037_completesIn60M() public {
        (DeployCoreV1Harness h, DeployCoreV1.Plan memory p) = _runner(SEPOLIA, FORK + 1 hours, true);
        vm.setEvmVersion("amsterdam");
        (address factory, address box0) = h.runFrom(p, SEPOLIA_GAS_LIMIT);
        vm.setEvmVersion("osaka");
        assertEq(h.stepCount(), 16, "twelve CREATEs, the two sources' calls, the factory, createBox");
        assertEq(BoxRegistry(BoxFactoryV1(factory).registry()).coordinatorOf(0), box0, "box 0 recorded");
        assertGt(box0.code.length, 0);
    }

    /// (f) Mainnet once the chain charges EIP-8037 and forge does too: the whole run (60M block).
    function test_run_onMainnet_afterItsFork_withEip8037_completes() public {
        (DeployCoreV1Harness h, DeployCoreV1.Plan memory p) = _runner(1, 1_800_000_000, false);
        h.checkSpecForChain(1, p.spec);
        h.setChainCodeByteGas(1_545);
        vm.setEvmVersion("amsterdam");
        (address factory, address box0) = h.runFrom(p, SEPOLIA_GAS_LIMIT);
        vm.setEvmVersion("osaka");
        assertEq(h.stepCount(), 14, "both sources were there");
        assertEq(BoxRegistry(BoxFactoryV1(factory).registry()).coordinatorOf(0), box0, "box 0 recorded");
    }

    /// The unmodified box 0 test spec must still be refused before a mainnet run reaches its gas checks.
    function test_plan_onMainnet_unmodifiedTestSpec_refuses() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        vm.chainId(1);
        BoxSpecV1.BoxSpec memory spec = h.fixtureSpec();
        address deployer = makeAddr("glam.deployer");
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, spec.revealRoot));
        h.planFor(deployer, SAFE, deployer, "", true);
    }

    // ============================================================================================================
    // The version and box 0 as the script deploys them, under each schedule

    /// A fresh deployment of the version and box 0 (both sources removed first, so their deterministic deployments are
    /// steps too), every step recorded by the script's own code (`CoreV1Deployment`), under `evm`.
    function _freshSteps(string memory evm) internal returns (CoreV1Step[] memory steps) {
        (address pinned,) = DrandSourcePins.pinned(1);
        vm.etch(pinned, "");
        vm.resetNonce(pinned);
        (address backed,) = BackedSourcePins.pinned(1);
        vm.etch(backed, "");
        vm.resetNonce(backed);
        uint256 first = _coreV1Steps.length;
        vm.setEvmVersion(evm);
        CoreV1Version memory v = _deployCoreV1(_config());
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH);
        _createBox0(BoxFactoryV1(v.factory), _box0Spec());
        vm.setEvmVersion("osaka");
        steps = new CoreV1Step[](_coreV1Steps.length - first);
        for (uint256 i; i < steps.length; ++i) {
            steps[i] = _coreV1Steps[first + i];
        }
        assertEq(steps.length, 16, "twelve CREATEs, the two sources' calls, the factory, createBox");
    }

    /// Z1 = after: under Foundry's `amsterdam`, every one of the sixteen steps is mostly state gas, its execution gas
    /// far under EIP-7825's cap (createBox's is the largest, about 2.4M), and its planned limit inside a 60M block with
    /// 5M to spare; a 50M block is refused at the factory (its 45.5M step plans a 50M limit).
    function test_theDeployment_underAmsterdam_fitsZ1After() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        CoreV1Step[] memory steps = _freshSteps("amsterdam");
        uint256 maxExecution;
        uint256 maxLimit;
        for (uint256 i; i < steps.length; ++i) {
            uint256 e = h.executionGas(steps[i]);
            uint256 l = h.plannedLimit(steps[i]);
            assertGt(steps[i].stateGas, steps[i].gas / 2, string.concat(steps[i].label, ": mostly state gas"));
            if (e > maxExecution) maxExecution = e;
            if (l > maxLimit) maxLimit = l;
            emit log_string(string.concat(
                    "GLAM|",
                    steps[i].label,
                    "|gas ",
                    vm.toString(steps[i].gas),
                    "|state ",
                    vm.toString(steps[i].stateGas),
                    "|execution ",
                    vm.toString(e),
                    "|planned limit ",
                    vm.toString(l)
                ));
        }
        assertTrue(
            steps[15].viaCall && steps[12].viaCall && steps[13].viaCall,
            "createBox and the sources' deployments are calls"
        );
        assertLt(maxExecution, 3_000_000, "execution gas far under EIP-7825's cap");
        assertLe(maxLimit, SEPOLIA_GAS_LIMIT - 5_000_000, "every planned limit inside a 60M block with 5M to spare");
        h.checkStepGas(steps, true, SEPOLIA_GAS_LIMIT);
        vm.expectPartialRevert(DeployCoreV1.StepTooBigForBlock.selector);
        h.checkStepGas(steps, true, 50_000_000);
    }

    /// Z1 = before: under osaka no step has state gas, its gas is its execution gas, and Z1 = before's rule passes as it
    /// did (the largest step about 9.8M at 130%, under the cap).
    function test_theDeployment_underOsaka_fitsZ1BeforeAsItDid() public {
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        CoreV1Step[] memory steps = _freshSteps("osaka");
        for (uint256 i; i < steps.length; ++i) {
            assertEq(steps[i].stateGas, 0, steps[i].label);
            assertEq(h.executionGas(steps[i]), steps[i].gas, steps[i].label);
        }
        h.checkStepGas(steps, false, SEPOLIA_GAS_LIMIT);
    }

    // ============================================================================================================
    // The devnet rehearsal's script

    /// script/rehearsal/DeployCoreV1Devnet.s.sol: Sepolia's fork time 0 (a devnet whose genesis runs Amsterdam), so the
    /// post-fork rules hold at today's clock; refused past block 1,000,000 (Sepolia is past 11.8 million).
    function test_devnetScript_appliesThePostForkRulesAndRefusesSepolia() public {
        DeployCoreV1DevnetHarness d =
            DeployCoreV1DevnetHarness(deployCode("GlamsterdamAfter.t.sol:DeployCoreV1DevnetHarness"));
        DeployCoreV1Harness h = DeployCoreV1Harness(deployCode("BoxFactoryV1Deploy.t.sol:DeployCoreV1Harness"));
        uint256 today = h.GLAMSTERDAM_SEPOLIA() - 2 days;
        vm.roll(100);
        d.checkGlamsterdamRules(SEPOLIA, today, 1_530);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotSimulated.selector, 200, 1_000));
        d.checkGlamsterdamRules(SEPOLIA, today, 200);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotAcknowledged.selector, today));
        d.checkGlamsterdamWindow(SEPOLIA, today, false);
        d.checkGlamsterdamWindow(SEPOLIA, today, true);
        // The script itself at the same time: before the fork, amsterdam refused.
        vm.expectRevert(
            abi.encodeWithSelector(DeployCoreV1.GlamsterdamSimulatedBeforeFork.selector, today, h.GLAMSTERDAM_SEPOLIA())
        );
        h.checkGlamsterdamRules(SEPOLIA, today, 1_530, 0);
        vm.roll(999_999);
        d.checkGlamsterdamRules(SEPOLIA, today, 1_530);
        vm.roll(1_000_000);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1Devnet.NotADevnet.selector, 1_000_000));
        d.checkGlamsterdamRules(SEPOLIA, today, 1_530);
        vm.roll(11_845_252);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1Devnet.NotADevnet.selector, 11_845_252));
        d.checkGlamsterdamWindow(SEPOLIA, today, true);
    }
}
