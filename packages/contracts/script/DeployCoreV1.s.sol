// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV1} from "../src/box/BoxFactoryV1.sol";
import {BoxRegistry} from "../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../src/box/BoxSpecV1.sol";
import {IBoxFactoryV1} from "../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxRegistry} from "../src/box/interfaces/IBoxRegistry.sol";
import {DrandSourcePins} from "../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../src/box/randomness/BackedSourcePins.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreV1Deployment} from "./lib/CoreV1Deployment.sol";
import {BoxMetadataTable} from "../src/box/libraries/BoxMetadataTable.sol";

/// @title DeployCoreV1
/// @notice Core v1 on mainnet or Sepolia (slice S7): the implementations (the coordinator's first, then every other
/// naming it, the per-item stream's included since the S7 × S8 integration), the planner, the pinned DrandSource and box
/// 0's pinned BoxBackedSource if the chain has none, factory v1 (with its registry) and box 0 with its per-item stream, in that order
/// (`CoreV1Deployment`, the steps the tests run). Sixteen transactions from one wallet (one fewer for each pinned source
/// the chain already has: the DrandSource, then box 0's BoxBackedSource, F143); nothing in them has an owner, admin,
/// pause, upgrade, mint or rescue path (F23 C2).
///
/// **Safety** (the pattern of `script/v2/DeploySepoliaFull.s.sol`):
/// - Chains 1 and 11155111 only (the DrandSource pin, `DrandSourcePins`), each with its canonical PoolManager and WETH
///   (a chain without code there is refused; a local anvil gets their runtime code placed by `scripts/core-v1-
///   simulate.sh`).
/// - A plain run is a **dry run**: forge simulates, prints the plan, the addresses and the gas; nothing is sent
///   without `--broadcast`, and with it the script refuses unless `SH_CORE_V1_BROADCAST_APPROVED=true` (the founder's
///   go-ahead), the signer is `SH_CORE_V1_DEPLOYER` (forge broadcasts from the key's own address whatever `--sender`
///   says) and the spec is not the repository's fixture (its reveal root, table and generator are stand-ins).
/// - **A spec file names its chain** (`.chainId`) and only a run on that chain reads it (`SpecFileWithoutChainId`,
///   `SpecFileForAnotherChain`); on mainnet a spec carrying the Sepolia rehearsal's public test commitment is refused
///   too (`TestCommitmentRefused`), as are every known test root, the fixture/test generators and tables, and a zero
///   root or Safe, even in a dry run. A wrong path can never make a rehearsal file (neutral names, a short open delay,
///   reveals anyone can rebuild) mainnet's box 0, which factory v1 creates once and nobody can change.
/// - **The build profile (F78).** `FOUNDRY_PROFILE=rehearsal` builds the rehearsal (BoxBuildV1: the raise 0.4206980085
///   ETH and the fixed ETH amounts at 1/10). This script refuses that build on mainnet (`RehearsalBuildOnMainnet`; its
///   constructors would revert there too: BoxBuildGuard), and a spec file runs only under the build its `.build` names
///   (none: `mainnet`; `SpecFileForAnotherBuild`), so the rehearsal file (box0-spec.11155111.rehearsal.json) needs the
///   rehearsal build and the full-size files the mainnet build. The mainnet build may still be deployed on Sepolia.
/// - **Glamsterdam:** on Sepolia from 2026-10-06 13:53:36 UTC (EIP-7773) contract creation costs state gas (EIP-8037:
///   1,530 per code byte), about seven times today's. forge sets each transaction's gas limit from its own simulation,
///   so after the fork that simulation must charge it: Foundry 1.8.3's runtime `--hardfork amsterdam` does (it changes
///   no compiled byte; docs/evidence/SH-glamsterdam-after.md), forge's default (foundry.toml's cancun) does not. Every
///   run measures what a deployed code byte costs in the EVM forge simulates with (`_codeByteGas`): at least
///   `STATE_GAS_PER_CODE_BYTE_MIN` means EIP-8037 is charged. After the fork every Sepolia run (the dry run too, so it
///   fails as the broadcast would) needs `SH_CORE_V1_GLAMSTERDAM_ACK=true` (the runbook's Z1 = after) and an EVM that
///   charges it (`GlamsterdamNotSimulated`); before the fork an EVM that charges it is refused
///   (`GlamsterdamSimulatedBeforeFork`: its limits would pass EIP-7825's cap, which Sepolia enforces on every
///   transaction until the fork). Whatever the acknowledgement, no Sepolia run starts in the last hour before the fork
///   (`GLAMSTERDAM_MARGIN`), so sixteen transactions sent one by one cannot straddle it. Mainnet's Glamsterdam time is
///   not set yet (EIP-7773), so there the chain decides: the RPC's estimate of the same two measuring creations
///   (`_chainCodeByteGas`, read-only) must show what forge's EVM charges a code byte, both with EIP-8037 or both
///   without, the chain's figure at most 5% above forge's (`ChainRulesNotSimulated`; review of d091e6bd, finding 2:
///   after mainnet's fork a run without `--hardfork amsterdam` would set every limit at about a seventh of the gas).
///   Mainnet has no last-hour guard yet: add its time with `GLAMSTERDAM_MARGIN` before a mainnet run near its fork.
///   `--resume` does not run the script again, so none of this guards a resume (the runbook says when not to resume).
/// - **The opening time** (F80; docs/design/open-at-clock-time.md): a spec file's openAt, unless 0 (Now), must lie at
///   least `OPEN_AT_MIN_LEAD` (15 minutes) after the planning block, so the sixteen transactions and the post-deploy
///   verifier come before the open and a stale example time is never sent (`OpenAtTooSoon`), and at most 14 days after
///   it (`OpenAtTooFar`, the factory's own refusal, checked here before anything is deployed). The plan prints the
///   time and the first slot at or after it: the block that opens the window (Sepolia's slots fall on whole minutes,
///   mainnet's 11 seconds after them).
/// - **EIP-7825** (16,777,216 gas per transaction, active since Osaka; under EIP-8037 it binds execution gas only): the
///   script refuses a plan whose largest step's execution gas, with forge's default 130% estimate multiplier, would
///   pass it (`StepGasTooHigh`; before the fork all gas is execution gas). Under EIP-8037 a transaction is also included
///   only while its whole gas limit fits the state gas its block has left, so each step's limit as Z1 = after sets it
///   (`GAS_ESTIMATE_MULTIPLIER_AFTER`, forge's search above a call's use included) must leave `BLOCK_STATE_GAS_ROOM`
///   of the block gas limit (`StepTooBigForBlock`).
/// - No key is read here: the signer comes from forge's wallet options in the founder's own command.
///
/// **Inputs** (environment; every default is printed):
/// - `SH_CORE_V1_SPEC_FILE`: a JSON file (under a path forge may read, e.g. `script/config/`) whose `.encoded` is the
///   ABI-encoded `BoxSpecV1.BoxSpec` of box 0 as it will be created (the sealed reveal root, the full table, the
///   launch-day openAt) and whose `.chainId` is the chain it is for (`box0-spec.<chainId>.json`). Default: the
///   repository's fixture (vector 0 of test/vectors/box-spec/box-spec-v1.json)
///   as it is (tStream PER_ITEM_STREAM with add-on 2; its reveal root, table and generator are stand-ins): simulation
///   only on Sepolia; mainnet requires a non-fixture spec file even for simulation.
/// - `SH_CORE_V1_PLATFORM_SAFE` (default: the platform Safe, `BoxSpecV1.PLATFORM_SAFE_MAINNET`; the spec's
///   marketplaceOwner must be the same address, checked before anything else: `PlatformSafeMismatch`). On Sepolia the
///   rehearsal names the testnet deployer (docs/runbooks/sepolia-core-v1.md, desk question Z3).
/// - `SH_CORE_V1_BOX0_CREATOR` (default: the sending wallet): the only caller of createBox.
///
/// Dry run against Sepolia (read-only, keyless public RPC; from packages/contracts):
///   forge script script/DeployCoreV1.s.sol --rpc-url https://ethereum-sepolia-rpc.publicnode.com \
///     --sender <the founder's wallet>
/// The rehearsal build (F78; docs/runbooks/sepolia-core-v1.md):
///   FOUNDRY_PROFILE=rehearsal SH_CORE_V1_SPEC_FILE=script/config/box0-spec.11155111.rehearsal.json \
///   SH_CORE_V1_PLATFORM_SAFE=<the file's platform> forge script script/DeployCoreV1.s.sol --rpc-url <Sepolia> \
///     --sender <the founder's wallet>
contract DeployCoreV1 is Script, CoreV1Deployment {
    uint256 public constant MAINNET = 1;
    uint256 public constant SEPOLIA = 11_155_111;
    /// @notice Canonical Uniswap v4 PoolManagers (test/v2/fork/NativeEthForkBase.sol:35; packages/chain networks.ts).
    address public constant POOL_MANAGER_MAINNET = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address public constant POOL_MANAGER_SEPOLIA = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    /// @notice Canonical WETH9 (test/v2/fork/NativeEthForkBase.sol:37; packages/chain networks.ts SEPOLIA_CANONICAL_QUOTES).
    address public constant WETH_MAINNET = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant WETH_SEPOLIA = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    /// @notice Glamsterdam on Sepolia: 2026-10-06 13:53:36 UTC (EIP-7773; script/v2/DeploySepoliaFull.s.sol).
    uint256 public constant GLAMSTERDAM_SEPOLIA = 1_791_294_816;
    /// @notice No Sepolia run starts in the last hour before the fork, acknowledged or not: sixteen transactions sent one
    /// by one (`--slow`, about 15 to 30 blocks) must all land under one set of rules.
    uint256 public constant GLAMSTERDAM_MARGIN = 1 hours;
    /// @notice The least gas a deployed code byte costs in forge's simulating EVM when it charges EIP-8037's state gas:
    /// 200 (the code deposit) without it, 1,530 with it (measured: `_codeByteGas`). After the fork anything below means
    /// forge's limits would be too low; before it anything at or above means they would be too high for EIP-7825.
    uint256 public constant STATE_GAS_PER_CODE_BYTE_MIN = 1_000;
    /// @notice Mainnet: the chain may charge a code byte at most this percent of what forge's EVM charges. The chain's
    /// figure is its RPC's estimate, which stops up to about 1.6% above the gas a creation uses (201 against 200 on
    /// publicnode and Tenderly, 2026-10-05), so equal rules read a few percent apart; a chain charging more than 5%
    /// above forge would make forge's limits too low.
    uint256 public constant CHAIN_CODE_BYTE_GAS_MAX_PERCENT = 105;
    /// @notice A spec file's openAt (not Now) lies at least this long after the planning block (F80).
    uint256 public constant OPEN_AT_MIN_LEAD = 15 minutes;
    /// @notice The beacon chains' genesis times: every slot (and block) timestamp is genesis + 12 k (consensus specs).
    uint256 public constant GENESIS_TIME_MAINNET = 1_606_824_023;
    uint256 public constant GENESIS_TIME_SEPOLIA = 1_655_733_600;
    /// @notice EIP-7825's per-transaction gas cap (execution gas only under EIP-8037) and forge's default
    /// `--gas-estimate-multiplier` (percent), the one Z1 = before sends with.
    uint256 public constant TX_GAS_CAP = 16_777_216;
    uint256 public constant GAS_ESTIMATE_MULTIPLIER = 130;
    /// @notice Z1 = after: the `--gas-estimate-multiplier` the runbook sends with (docs/runbooks/sepolia-core-v1.md).
    /// forge's amsterdam simulation equals the gas geth v1.17.7 uses for every CREATE (to 24 gas) and is above it for
    /// the two calls, so 110% leaves at least 10% over the gas each transaction uses (all fifteen succeeded on geth with
    /// it) and the largest limits about 49.4M in Sepolia's 60M block (docs/evidence/SH-glamsterdam-after.md).
    uint256 public constant GAS_ESTIMATE_MULTIPLIER_AFTER = 110;
    /// @notice forge sets a call's limit from its own search for the least gas that succeeds, above the gas the call
    /// uses in the script (measured under amsterdam: createBox +12.3%, the DrandSource's call +8.8%): a call's
    /// planned limit is its gas times this percent, then the multiplier. A CREATE's is its gas (forge's is 3% below it).
    uint256 public constant CALL_LIMIT_ALLOWANCE = 115;
    /// @notice Z1 = after: every transaction's planned limit leaves this much of the block gas limit for the state gas
    /// other transactions put before it in its block (EIP-8037 includes a transaction only while its whole limit fits).
    uint256 public constant BLOCK_STATE_GAS_ROOM = 5_000_000;
    string internal constant FIXTURE_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    error UnsupportedChain(uint256 chainId);
    error BroadcastNotApproved();
    error WrongDeployer(address signer, address expected);
    error FixtureSpecRefused();
    error GlamsterdamNotAcknowledged(uint256 timestamp);
    error GlamsterdamTooClose(uint256 timestamp, uint256 fork);
    error GlamsterdamNotSimulated(uint256 gasPerCodeByte, uint256 min);
    error SpecFileWithoutChainId(string specFile);
    error SpecFileForAnotherChain(uint256 specFileChainId, uint256 chainId);
    error TestCommitmentRefused(bytes32 revealRoot);
    error TestGeneratorRefused(bytes32 generatorHash);
    error TestMetadataTableRefused();
    error ZeroPlatformSafe();
    error PlatformSafeMismatch(address specMarketplaceOwner, address platformSafe);
    /// @notice A step's execution gas (all its gas before EIP-8037) is above EIP-7825's cap with the margin.
    error StepGasTooHigh(string label, uint256 executionGas, uint256 max);
    /// @notice Under EIP-8037 a step's planned gas limit leaves less than BLOCK_STATE_GAS_ROOM of the block gas limit.
    error StepTooBigForBlock(string label, uint256 plannedLimit, uint256 max);
    /// @notice Before Sepolia's fork forge's EVM charges EIP-8037 (`--hardfork amsterdam`): its limits would pass
    /// EIP-7825's cap, which Sepolia enforces until the fork. Z1 = before runs without it; Z1 = after waits for the fork.
    error GlamsterdamSimulatedBeforeFork(uint256 timestamp, uint256 fork);
    /// @notice Mainnet (no Glamsterdam time in this script): forge's EVM does not charge a code byte what the chain
    /// charges (its RPC's estimate): with EIP-8037 on one and not the other, or the chain above forge by more than
    /// CHAIN_CODE_BYTE_GAS_MAX_PERCENT. forge's limits would be too low (every creation out of gas on chain) or pass
    /// EIP-7825's cap. Run forge with the chain's rules (`--hardfork amsterdam` once mainnet charges EIP-8037).
    error ChainRulesNotSimulated(uint256 chainId, uint256 forgeGasPerCodeByte, uint256 chainGasPerCodeByte);
    /// @notice The spec's openAt is before `earliest` (the planning block + OPEN_AT_MIN_LEAD): pick a later time.
    error OpenAtTooSoon(uint256 openAt, uint256 earliest);
    /// @notice The spec's openAt is after `latest` (the planning block + 14 days): the factory would refuse box 0.
    error OpenAtTooFar(uint256 openAt, uint256 latest);
    error SpecRefused(bytes reason);
    error RehearsalBuildOnMainnet(string build);
    error SpecFileForAnotherBuild(string specFileBuild, string build);

    struct Plan {
        address deployer;
        bool sending;
        IPoolManager poolManager;
        address weth;
        address platformSafe;
        address box0Creator;
        bool fixture;
        string specFile;
        BoxSpecV1.BoxSpec spec;
    }

    function run() external returns (address factory, address box0) {
        return _run(_plan(msg.sender), block.gaslimit);
    }

    /// @dev run()'s body, from the plan and the block gas limit each step's planned limit is held to (internal so the
    /// tests run the founder's path itself, its guards where it calls them: review of d091e6bd, finding 1).
    function _run(Plan memory p, uint256 blockGasLimit) internal returns (address factory, address box0) {
        // The dry run too: it fails where the broadcast would, before anything is planned to be sent.
        _checkOpenAt(p.spec.openAt, block.timestamp);
        (bool stateGas, uint256 codeByteGas) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        _logPlan(p, stateGas, codeByteGas);

        vm.startBroadcast(p.deployer);
        CoreV1Version memory v = _deployCoreV1(
            CoreV1Config({
                deployer: p.deployer,
                callsTakeNonce: true,
                poolManager: p.poolManager,
                weth: p.weth,
                platformSafe: p.platformSafe,
                box0Creator: p.box0Creator
            })
        );
        BoxFactoryV1 f = BoxFactoryV1(v.factory);
        bytes memory refused = f.refusal(p.spec, p.box0Creator);
        if (refused.length != 0) revert SpecRefused(refused);
        (, address coordinator, address hook, bytes32 salt) = _createBox0(f, p.spec);
        vm.stopBroadcast();

        _checkStepGas(_coreV1Steps, stateGas, blockGasLimit);
        _logResult(v, coordinator, hook, salt, stateGas);
        return (v.factory, coordinator);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The plan and its guards (internal so the tests can call them directly)

    function _plan(address deployer) internal view returns (Plan memory) {
        return _planFor(
            deployer,
            vm.envOr("SH_CORE_V1_PLATFORM_SAFE", BoxSpecV1.PLATFORM_SAFE_MAINNET),
            vm.envOr("SH_CORE_V1_BOX0_CREATOR", deployer),
            vm.envOr("SH_CORE_V1_SPEC_FILE", string("")),
            vm.envOr("SH_CORE_V1_GLAMSTERDAM_ACK", false)
        );
    }

    /// @dev The plan from explicit inputs: `_plan` reads them from the environment (tests pass them, since the process
    /// environment is shared by tests running in parallel).
    function _planFor(
        address deployer,
        address platformSafe,
        address box0Creator,
        string memory specFile,
        bool glamsterdamAck
    ) internal view returns (Plan memory p) {
        p.deployer = deployer;
        if (block.chainid == MAINNET) {
            (p.poolManager, p.weth) = (IPoolManager(POOL_MANAGER_MAINNET), WETH_MAINNET);
        } else if (block.chainid == SEPOLIA) {
            (p.poolManager, p.weth) = (IPoolManager(POOL_MANAGER_SEPOLIA), WETH_SEPOLIA);
        } else {
            revert UnsupportedChain(block.chainid);
        }
        _checkBuildForChain(block.chainid);
        p.platformSafe = platformSafe;
        p.box0Creator = box0Creator;
        p.specFile = specFile;
        p.fixture = bytes(specFile).length == 0;
        if (!p.fixture) _checkSpecFileChain(specFile, block.chainid);
        p.spec = p.fixture ? fixtureSpec() : specFromFile(specFile);
        _checkSpecForChain(block.chainid, p.spec);
        if (p.spec.marketplaceOwner != p.platformSafe) {
            revert PlatformSafeMismatch(p.spec.marketplaceOwner, p.platformSafe);
        }
        p.sending = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (p.sending) {
            _checkBroadcast(
                vm.envOr("SH_CORE_V1_BROADCAST_APPROVED", false),
                deployer,
                vm.envOr("SH_CORE_V1_DEPLOYER", address(0)),
                p.fixture
            );
        }
        // Dry runs too: a dry run fails exactly where the broadcast would.
        _checkGlamsterdamWindow(block.chainid, block.timestamp, glamsterdamAck);
    }

    /// @dev A broadcast needs the founder's go-ahead, the planned signer and box 0's real spec.
    function _checkBroadcast(bool approved, address signer, address expected, bool fixture) internal pure {
        if (!approved) revert BroadcastNotApproved();
        if (signer != expected) revert WrongDeployer(signer, expected);
        if (fixture) revert FixtureSpecRefused();
    }

    /// @dev Sepolia's Glamsterdam time (`GLAMSTERDAM_SEPOLIA`); a devnet rehearsal whose genesis runs Amsterdam may
    /// override it (script/rehearsal/DeployCoreV1Devnet.s.sol, which refuses Sepolia's own chain).
    function _glamsterdamSepolia() internal view virtual returns (uint256) {
        return GLAMSTERDAM_SEPOLIA;
    }

    /// @dev After Glamsterdam on Sepolia, every run needs the founder's Z1 = after (SH_CORE_V1_GLAMSTERDAM_ACK=true).
    function _checkGlamsterdam(uint256 chainId, uint256 timestamp, bool acknowledged) internal view {
        if (chainId == SEPOLIA && timestamp >= _glamsterdamSepolia() && !acknowledged) {
            revert GlamsterdamNotAcknowledged(timestamp);
        }
    }

    /// @dev `_checkGlamsterdam`, and no Sepolia run in the last `GLAMSTERDAM_MARGIN` before the fork, acknowledged or not
    /// (the run would straddle it).
    function _checkGlamsterdamWindow(uint256 chainId, uint256 timestamp, bool acknowledged) internal view {
        _checkGlamsterdam(chainId, timestamp, acknowledged);
        uint256 fork = _glamsterdamSepolia();
        if (chainId == SEPOLIA && timestamp < fork && timestamp + GLAMSTERDAM_MARGIN >= fork) {
            revert GlamsterdamTooClose(timestamp, fork);
        }
    }

    /// @dev The acknowledgement is checked, not trusted: forge sets each transaction's gas limit from its own simulation
    /// (`--slow` does not re-estimate through the RPC), so after the fork that simulation must charge EIP-8037's state
    /// gas, or every creation would run out of gas on chain; before it, it must not, or the limits would pass EIP-7825's
    /// cap. Measured here, outside any broadcast (the two measuring CREATEs exist only in forge's local simulation and
    /// are never sent). Mainnet's chain is asked too (`_chainCodeByteGas`). Returns whether forge's EVM charges
    /// EIP-8037, and the gas a code byte costs in it.
    function _checkGlamsterdamSimulated(uint256 chainId, uint256 timestamp)
        internal
        returns (bool stateGas, uint256 gasPerCodeByte)
    {
        gasPerCodeByte = _codeByteGas();
        uint256 chainGasPerCodeByte;
        if (chainId != SEPOLIA) {
            chainGasPerCodeByte = _chainCodeByteGas();
            console.log("gas per deployed code byte on the chain (its RPC's estimate):", chainGasPerCodeByte);
        }
        _checkGlamsterdamRules(chainId, timestamp, gasPerCodeByte, chainGasPerCodeByte);
        stateGas = gasPerCodeByte >= STATE_GAS_PER_CODE_BYTE_MIN;
    }

    /// @dev Sepolia (its rules follow its fork time): after the fork forge's EVM must charge EIP-8037, before it it must
    /// not. Mainnet (no Glamsterdam time here): forge's EVM must charge a code byte what the chain does
    /// (`chainGasPerCodeByte`, its RPC's estimate): both with EIP-8037 or both without, and the chain at most
    /// CHAIN_CODE_BYTE_GAS_MAX_PERCENT of forge.
    function _checkGlamsterdamRules(
        uint256 chainId,
        uint256 timestamp,
        uint256 gasPerCodeByte,
        uint256 chainGasPerCodeByte
    ) internal view {
        bool charged = gasPerCodeByte >= STATE_GAS_PER_CODE_BYTE_MIN;
        if (chainId == SEPOLIA) {
            uint256 fork = _glamsterdamSepolia();
            if (timestamp >= fork && !charged) {
                revert GlamsterdamNotSimulated(gasPerCodeByte, STATE_GAS_PER_CODE_BYTE_MIN);
            }
            if (timestamp < fork && charged) revert GlamsterdamSimulatedBeforeFork(timestamp, fork);
        } else if (
            charged != (chainGasPerCodeByte >= STATE_GAS_PER_CODE_BYTE_MIN)
                || chainGasPerCodeByte * 100 > gasPerCodeByte * CHAIN_CODE_BYTE_GAS_MAX_PERCENT
        ) {
            revert ChainRulesNotSimulated(chainId, gasPerCodeByte, chainGasPerCodeByte);
        }
    }

    /// @dev Gas per deployed code byte in the EVM running this script: two CREATEs whose init code returns 1,024 and
    /// 2,048 zero bytes, their cost difference over 1,024 (the fixed and init-code costs cancel; memory adds < 1 a byte).
    function _codeByteGas() internal returns (uint256) {
        return (_createCost(2_048) - _createCost(1_024)) / 1_024;
    }

    /// @dev Gas per deployed code byte on the chain itself: its RPC's `eth_estimateGas` for the same two creations
    /// (read-only: nothing is signed or sent), their difference over 1,024. Works on any RPC (publicnode, Tenderly,
    /// anvil); `eth_config` (EIP-7910) would not: the Tenderly gateway answers it `method not found` (2026-10-05).
    function _chainCodeByteGas() internal virtual returns (uint256) {
        uint256 small = _estimateCreate(1_024);
        uint256 large = _estimateCreate(2_048);
        require(large > small, "the chain's estimates are not a creation's");
        return (large - small) / 1_024;
    }

    function _estimateCreate(uint16 size) internal returns (uint256) {
        return _rpcQuantity(vm.rpc("eth_estimateGas", _estimateParams(size)));
    }

    /// @dev The estimate's parameters: a creation with the measuring init code, at the latest block.
    function _estimateParams(uint16 size) internal pure returns (string memory) {
        return string.concat('[{"data":"', vm.toString(_measuringInitCode(size)), '"},"latest"]');
    }

    /// @dev An RPC quantity as `vm.rpc` returns it (its big-endian bytes, e.g. 0x03efba for 257,978).
    function _rpcQuantity(bytes memory r) internal pure returns (uint256) {
        require(r.length != 0 && r.length <= 32, "not an RPC quantity");
        return uint256(bytes32(r)) >> (256 - 8 * r.length);
    }

    /// @dev PUSH2 size, PUSH1 0, RETURN: the runtime code is `size` zero bytes.
    function _measuringInitCode(uint16 size) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"61", size, hex"6000f3");
    }

    function _createCost(uint16 size) internal returns (uint256 g) {
        bytes memory init = _measuringInitCode(size);
        address created;
        uint256 g0 = gasleft();
        assembly ("memory-safe") {
            created := create(0, add(init, 0x20), mload(init))
        }
        g = g0 - gasleft();
        require(created != address(0) && created.code.length == size, "the measuring CREATE failed");
    }

    /// @dev A spec file is for the chain its `.chainId` names, and no other (a Sepolia file on mainnet is refused); and
    /// for the build its `.build` names (none: `mainnet`), and no other (F78).
    function _checkSpecFileChain(string memory specFile, uint256 chainId) internal view {
        string memory json = vm.readFile(specFile);
        if (!vm.keyExistsJson(json, ".chainId")) revert SpecFileWithoutChainId(specFile);
        uint256 fileChainId = vm.parseJsonUint(json, ".chainId");
        if (fileChainId != chainId) revert SpecFileForAnotherChain(fileChainId, chainId);
        string memory fileBuild = vm.keyExistsJson(json, ".build") ? vm.parseJsonString(json, ".build") : "mainnet";
        if (keccak256(bytes(fileBuild)) != keccak256(bytes(BoxBuildV1.PROFILE))) {
            revert SpecFileForAnotherBuild(fileBuild, BoxBuildV1.PROFILE);
        }
    }

    /// @dev F78: a build that refuses this chain (the rehearsal build on mainnet) is refused before anything is planned.
    function _checkBuildForChain(uint256 chainId) internal pure {
        if (
            (BoxBuildV1.REHEARSAL && chainId == MAINNET)
                || (BoxBuildV1.REFUSED_CHAIN_ID != 0 && chainId == BoxBuildV1.REFUSED_CHAIN_ID)
        ) revert RehearsalBuildOnMainnet(BoxBuildV1.PROFILE);
    }

    /// @dev F80: Now (0), or a time at least OPEN_AT_MIN_LEAD and at most 14 days after the planning block's time.
    function _checkOpenAt(uint256 openAt, uint256 timestamp) internal pure {
        if (openAt == 0) return;
        if (openAt < timestamp + OPEN_AT_MIN_LEAD) revert OpenAtTooSoon(openAt, timestamp + OPEN_AT_MIN_LEAD);
        uint256 latest = timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS;
        if (openAt > latest) revert OpenAtTooFar(openAt, latest);
    }

    /// @notice The first slot time at or after `t` on `chainId`'s beacon chain (`t` itself on Sepolia for a time on a
    /// whole minute; 11 s later on mainnet): the block that opens a window whose openAt is `t`, if that slot is not
    /// missed. 0 for another chain.
    function firstSlotAtOrAfter(uint256 chainId, uint256 t) public pure returns (uint256) {
        uint256 genesis = chainId == MAINNET ? GENESIS_TIME_MAINNET : chainId == SEPOLIA ? GENESIS_TIME_SEPOLIA : 0;
        if (genesis == 0 || t <= genesis) return genesis;
        return genesis + (t - genesis + 11) / 12 * 12;
    }

    /// @dev Mainnet refuses all KNOWN_TEST_ROOTS and generators from the commitment exporter's placeholders.ts.
    /// Pinned through exporter fix1 c81400c8; source vectors are checked in DeployCoreV1MainnetSpec.t.sol.
    /// No test-vector file read can weaken this gate. The table comparison ignores its description, so new copy
    /// cannot disguise test traits.
    function _checkSpecForChain(uint256 chainId, BoxSpecV1.BoxSpec memory spec) internal pure {
        if (chainId != MAINNET) return;
        bytes32 root = spec.revealRoot;
        if (
            root == bytes32(0)
                || root == 0xf983840bf08a7deb54c03a65382418390b9cdc259e2152a01d56d340ca3679ec
                || root == 0x3d88f4cc193a1debaa14062d0866edba43dd836564dcb36f2234517b98fa922d
                || root == 0x96ab1aa34dca451e37eb23c6f4010ae2c3d8546868120b79abbee6913654614a
                || root == 0xfe3ba00e7949b9bed0fb17f7af5e0e101b581ec6d328bf0dec0330bba08842fc
                || root == 0xdfc000d2ce029fc889fb15f05384153d543afc63a3a60a22e302ee11bcb0979f
                || root == 0xfdbae7713f2c54f1f75970cddee81cf4fb1ef9d17c69255b85b90fe34e6c26fc
        ) {
            revert TestCommitmentRefused(spec.revealRoot);
        }
        bytes32 generator = spec.generatorHash;
        if (
            generator == 0xe95521689a770d6d7b423c18b6d84d6556192211000000000000000000000000
                || generator == 0x328f60269102b38166998b931526ce934f7876ee07c549e2949bf59278db9a2b
                || generator == 0xb2bef4c106e7a62014645962d428e333da58b8eff38557696e8190a29b88950a
                || generator == 0x31349e9b3d9338f711f34c6a3acebc4b758707c5000000000000000000000000
        ) revert TestGeneratorRefused(generator);
        if (spec.marketplaceOwner == address(0)) revert ZeroPlatformSafe();
        BoxMetadataTable.validate(spec.metadataTable);
        uint256 start = 3 + BoxMetadataTable.descriptionLength(spec.metadataTable);
        bytes32 valueOrder = keccak256(
            bytes.concat(hex"010000", BoxMetadataTable.slice(spec.metadataTable, start, spec.metadataTable.length - start))
        );
        // The four known test tables with empty descriptions (exporter's valueOrderHash convention).
        if (
            valueOrder == 0x74133bce98ccde702e998fb1f169d7cca4e5e45b7ec6b8c6f3f8266eaae15bd5
                || valueOrder == 0x4e532a53109b18ee626a991269ee539eea286ac5d7d09df98260e7791c560351
                || valueOrder == 0xce04267df9ec0981d300bad3bb068c6a3e5c40b608f5d8093d3550cef27c1279
                || valueOrder == 0xb2df09c48efaf1631201bc525910538158eb497b795a366cae434c45ac2ec2e6
        ) revert TestMetadataTableRefused();
    }

    /// @dev Every step's execution gas (its gas less its EIP-8037 state gas; all of it before EIP-8037), at forge's
    /// default multiplier, stays under EIP-7825's cap (the intrinsic cost is small beside the margin: 53,000 plus 16 gas
    /// per init-code byte, at most ≈ 0.45M for the largest; under EIP-8037 a transaction above the cap gets the rest as
    /// its state-gas reservoir). When forge's EVM charges EIP-8037 (`stateGas`), each step's planned limit (Z1 = after's
    /// multiplier, a call's search allowance) also leaves BLOCK_STATE_GAS_ROOM of the block gas limit.
    function _checkStepGas(CoreV1Step[] memory steps, bool stateGas, uint256 blockGasLimit) internal pure {
        uint256 maxExecution = TX_GAS_CAP * 100 / GAS_ESTIMATE_MULTIPLIER - 500_000;
        uint256 maxLimit = blockGasLimit > BLOCK_STATE_GAS_ROOM ? blockGasLimit - BLOCK_STATE_GAS_ROOM : 0;
        for (uint256 i; i < steps.length; ++i) {
            uint256 execution = _executionGas(steps[i]);
            if (execution > maxExecution) revert StepGasTooHigh(steps[i].label, execution, maxExecution);
            if (!stateGas) continue;
            uint256 limit = _plannedLimit(steps[i]);
            if (limit > maxLimit) revert StepTooBigForBlock(steps[i].label, limit, maxLimit);
        }
    }

    /// @dev A step's execution gas: its gas less the state gas of its frame (an upper bound: a CREATE's new-account
    /// charge is outside its frame).
    function _executionGas(CoreV1Step memory s) internal pure returns (uint256) {
        return s.gas - (s.stateGas < s.gas ? s.stateGas : s.gas);
    }

    /// @dev The gas limit forge sets for a step under Z1 = after, from above: a CREATE's gas (forge's simulation of the
    /// transaction is about 3% below the script's frame), a call's with CALL_LIMIT_ALLOWANCE, times the multiplier.
    function _plannedLimit(CoreV1Step memory s) internal pure returns (uint256) {
        uint256 g = s.viaCall ? s.gas * CALL_LIMIT_ALLOWANCE / 100 : s.gas;
        return g * GAS_ESTIMATE_MULTIPLIER_AFTER / 100;
    }

    /// @notice Box 0's fixture as it is (with its per-item stream since the S7 × S8 integration), as the core harness
    /// checks it, with this build's raise (F78: the rehearsal build's is 1/10; the mainnet build's is the fixture's).
    function fixtureSpec() public view returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(vm.parseJsonBytes(vm.readFile(FIXTURE_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
    }

    /// @notice A spec file's BoxSpec: its `.encoded` (e.g. script/config/box0-spec.11155111.json).
    function specFromFile(string memory specFile) public view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(vm.parseJsonBytes(vm.readFile(specFile), ".encoded"), (BoxSpecV1.BoxSpec));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Logs

    function _logPlan(Plan memory p, bool stateGas, uint256 codeByteGas) internal view {
        console.log("== DeployCoreV1 plan (chain id, deployer, nonce) ==");
        console.log(block.chainid, p.deployer, vm.getNonce(p.deployer));
        console.log("sending:", p.sending);
        console.log("build profile:", BoxBuildV1.PROFILE, BoxBuildV1.REHEARSAL ? "(F78: testnets only)" : "");
        console.log("raise, bootstrap (wei):", BoxBuildV1.RAISE, BoxBuildV1.BOOTSTRAP_ETH);
        console.log("PoolManager:", address(p.poolManager));
        console.log("WETH:", p.weth);
        (address pinned,) = DrandSourcePins.pinned(block.chainid);
        console.log(
            "DrandSource (pinned):", pinned, pinned.code.length == 0 ? "absent: this run deploys it" : "present"
        );
        (address backed,) = BackedSourcePins.pinned(block.chainid);
        console.log(
            "BoxBackedSource (pinned, box 0's source; F143):",
            backed,
            backed.code.length == 0 ? "absent: this run deploys it" : "present"
        );
        console.log("platform Safe:", p.platformSafe);
        console.log("box 0 creator:", p.box0Creator);
        console.log("spec:", p.fixture ? "the repository fixture (simulation only)" : p.specFile);
        console.log("spec hash:", vm.toString(keccak256(abi.encode(p.spec))));
        if (block.chainid == SEPOLIA) {
            uint256 fork = _glamsterdamSepolia();
            if (block.timestamp < fork) {
                console.log("Glamsterdam on Sepolia in (minutes):", (fork - block.timestamp) / 60);
            } else {
                console.log("Glamsterdam on Sepolia: ACTIVE (SH_CORE_V1_GLAMSTERDAM_ACK=true given)");
            }
        }
        console.log(
            "gas per deployed code byte in forge's EVM:",
            codeByteGas,
            stateGas ? "(EIP-8037 charged: Z1 = after)" : "(no EIP-8037: Z1 = before)"
        );
        console.log("block gas limit:", block.gaslimit);
        if (p.spec.openAt == 0) {
            console.log("openAt: 0 (Now: the block after box 0's creation)");
        } else {
            console.log("openAt (Unix seconds, UTC):", p.spec.openAt);
            console.log("  minutes after this block:", (p.spec.openAt - block.timestamp) / 60);
            console.log(
                "  first slot at or after it (the window's first block):",
                firstSlotAtOrAfter(block.chainid, p.spec.openAt)
            );
        }
        console.log("metadata table bytes:", p.spec.metadataTable.length);
    }

    function _logResult(CoreV1Version memory v, address coordinator, address hook, bytes32 salt, bool stateGas)
        internal
        view
    {
        console.log(
            stateGas
                ? "== steps: gas (no intrinsic cost), init code bytes, execution gas, state gas, planned limit, address =="
                : "== steps: gas (no intrinsic cost), init code bytes, execution gas, state gas, address =="
        );
        uint256 total;
        uint256 totalState;
        for (uint256 i; i < _coreV1Steps.length; ++i) {
            CoreV1Step memory s = _coreV1Steps[i];
            string memory line = string.concat(
                "STEP|",
                s.label,
                "|",
                vm.toString(s.gas),
                "|",
                vm.toString(s.initCodeBytes),
                "|",
                vm.toString(_executionGas(s)),
                "|",
                vm.toString(s.stateGas)
            );
            if (stateGas) line = string.concat(line, "|", vm.toString(_plannedLimit(s)));
            console.log(line, s.at);
            total += s.gas;
            totalState += s.stateGas;
        }
        console.log("STEPS-TOTAL|gas", total);
        console.log("STEPS-TOTAL|state gas", totalState);
        console.log("== the version ==");
        console.log("factory:", v.factory);
        console.log("registry:", v.registry);
        console.log("planner:", v.planner);
        console.log("DrandSource:", v.drand, v.drandDeployed ? "(deployed here)" : "(was there)");
        console.log("BoxBackedSource:", v.randomness, v.randomnessDeployed ? "(deployed here)" : "(was there)");
        IBoxFactoryV1.Implementations memory i = v.impls;
        console.log("impl coordinator:", i.coordinator);
        console.log("impl hook:", i.hook, "extension:", v.hookExtension);
        console.log("impl launch router:", i.launchRouter);
        console.log("impl receiver:", i.receiver, "extension:", v.receiverExtension);
        console.log("impl collection:", i.collection);
        console.log("impl vault:", i.vault);
        console.log("impl tickets:", i.tickets);
        console.log("impl royalty router:", i.royaltyRouter);
        console.log("impl item stream:", i.itemStream);
        console.log("versionCodeHash:", vm.toString(BoxFactoryV1(v.factory).versionCodeHash()));
        console.log("== box 0 ==");
        IBoxRegistry.BoxRecord memory r = BoxRegistry(v.registry).recordOf(0);
        console.log("coordinator:", coordinator);
        console.log("hook:", hook, "salt:", vm.toString(salt));
        console.log("token (FIT):", r.contracts[1]);
        console.log("vault:", r.contracts[3], "collection:", r.contracts[4]);
        console.log("receiver:", r.contracts[5], "launch router:", r.contracts[6]);
        console.log("tickets:", r.contracts[7], "royalty router:", r.contracts[8]);
        console.log("item stream:", r.contracts[10]);
        console.log("FIT's executor:", r.contracts[9], "metadata table:", r.contracts[12]);
        console.log("pool id:", vm.toString(r.poolId));
        console.log("template id:", vm.toString(r.templateId));
        console.log("creation block, open time:", r.creationBlock, r.openAt);
    }
}
