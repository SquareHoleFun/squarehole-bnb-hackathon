// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../src/box/BoxHookExtension.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../src/box/BoxReceiverExtension.sol";
import {BoxRegistry} from "../../../src/box/BoxRegistry.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxRegistry} from "../../../src/box/interfaces/IBoxRegistry.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {DeployCoreV1} from "../../../script/DeployCoreV1.s.sol";
import {BoxS7Base} from "./BoxS7Base.sol";

/// @notice TEST ONLY: the deploy script's guards and plan, callable directly.
contract DeployCoreV1Harness is DeployCoreV1 {
    function checkBroadcast(bool approved, address signer, address expected, bool fixture) external pure {
        _checkBroadcast(approved, signer, expected, fixture);
    }

    function checkGlamsterdam(uint256 chainId, uint256 timestamp, bool acknowledged) external view {
        _checkGlamsterdam(chainId, timestamp, acknowledged);
    }

    function checkGlamsterdamWindow(uint256 chainId, uint256 timestamp, bool acknowledged) external view {
        _checkGlamsterdamWindow(chainId, timestamp, acknowledged);
    }

    function checkGlamsterdamSimulated(uint256 chainId, uint256 timestamp)
        external
        returns (bool stateGas, uint256 gasPerCodeByte)
    {
        return _checkGlamsterdamSimulated(chainId, timestamp);
    }

    function checkGlamsterdamRules(
        uint256 chainId,
        uint256 timestamp,
        uint256 gasPerCodeByte,
        uint256 chainGasPerCodeByte
    ) external view {
        _checkGlamsterdamRules(chainId, timestamp, gasPerCodeByte, chainGasPerCodeByte);
    }

    /// @dev A test has no chain to ask: what a code byte costs on "the chain" (the script asks the RPC) is set here.
    uint256 public chainCodeByteGasStub;

    function setChainCodeByteGas(uint256 g) external {
        chainCodeByteGasStub = g;
    }

    function _chainCodeByteGas() internal view override returns (uint256) {
        require(chainCodeByteGasStub != 0, "test: set the chain's gas per code byte first");
        return chainCodeByteGasStub;
    }

    function rpcQuantity(bytes calldata r) external pure returns (uint256) {
        return _rpcQuantity(r);
    }

    function estimateParams(uint16 size) external pure returns (string memory) {
        return _estimateParams(size);
    }

    /// @dev run()'s body from a plan and a block gas limit (run() passes `_plan(msg.sender)` and `block.gaslimit`).
    function runFrom(Plan calldata p, uint256 blockGasLimit) external returns (address factory, address box0) {
        return _run(p, blockGasLimit);
    }

    function stepCount() external view returns (uint256) {
        return _coreV1StepCount();
    }

    function checkStepGas(CoreV1Step[] calldata steps, bool stateGas, uint256 blockGasLimit) external pure {
        _checkStepGas(steps, stateGas, blockGasLimit);
    }

    function executionGas(CoreV1Step calldata s) external pure returns (uint256) {
        return _executionGas(s);
    }

    function plannedLimit(CoreV1Step calldata s) external pure returns (uint256) {
        return _plannedLimit(s);
    }

    function codeByteGas() external returns (uint256) {
        return _codeByteGas();
    }

    function checkSpecForChain(uint256 chainId, BoxSpecV1.BoxSpec calldata spec) external pure {
        _checkSpecForChain(chainId, spec);
    }

    function checkOpenAt(uint256 openAt, uint256 timestamp) external pure {
        _checkOpenAt(openAt, timestamp);
    }

    function plan(address deployer) external view returns (Plan memory) {
        return _plan(deployer);
    }

    function planFor(
        address deployer,
        address platformSafe,
        address box0Creator,
        string calldata specFile,
        bool glamsterdamAck
    ) external view returns (Plan memory) {
        return _planFor(deployer, platformSafe, box0Creator, specFile, glamsterdamAck);
    }
}

/// @notice Factory v1's deployment (slice S7): the constructor's pins (BC-101: only this chain's pinned BoxBackedSource,
/// naming its pinned DrandSource, F143;
/// BC-100: only implementations naming this version, the coordinator implementation naming this factory), its other
/// refusals, the version code hash, BC-010's random callers on the factory and registry, and the deploy script's guards.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1DeployTest is BoxS7Base {
    // ============================================================================================================
    // BC-101: the randomness source pin

    /// BC-101 (F143): box 0's source is the pinned BoxBackedSource. The constructor refuses the DrandSource itself, a
    /// twin of the backed source (the same code at another address), an EIP-7702 delegation at its pinned address, the
    /// pinned address without code and every chain but 1 and 11155111; and it refuses the pinned backed source when the
    /// DrandSource it names is missing or not the pinned code. Only both pinned deployments pass (as in setUp).
    function test_BC101_theConstructorRefusesEverySourceButThePinnedOne() public {
        (address pinned,) = BackedSourcePins.pinned(1);
        (address drandPin,) = DrandSourcePins.pinned(1);
        assertTrue(BackedSourcePins.isPinned(pinned), "setUp's source is pinned");
        assertTrue(DrandSourcePins.isPinned(drandPin), "and the DrandSource it names");
        assertEq(address(BoxBackedSource(pinned).DRAND()), drandPin);
        _expectConstructorRevert(drandPin, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, drandPin));
        address twin = address(new BoxBackedSource());
        assertEq(twin.codehash, pinned.codehash, "a twin has the same code");
        _expectConstructorRevert(twin, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, twin));
        uint256 snap = vm.snapshotState();
        vm.etch(pinned, abi.encodePacked(hex"ef0100", twin));
        _expectConstructorRevert(pinned, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, pinned));
        vm.revertToState(snap);
        vm.etch(pinned, "");
        _expectConstructorRevert(pinned, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, pinned));
        vm.revertToState(snap);
        // The DrandSource the backed source names: absent, or a delegation to a twin.
        vm.etch(drandPin, "");
        _expectConstructorRevert(pinned, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, drandPin));
        vm.revertToState(snap);
        vm.etch(drandPin, abi.encodePacked(hex"ef0100", address(new DrandSource())));
        _expectConstructorRevert(pinned, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, drandPin));
        vm.revertToState(snap);
        vm.chainId(31_337);
        _expectConstructorRevert(pinned, abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, pinned));
        vm.chainId(11_155_111);
        _deployFactory(pinned, 0, false);
    }

    // ============================================================================================================
    // BC-100: the implementations name this version

    /// BC-100 (the factory's side): the constructor refuses a set of implementations in which any one names another
    /// factory, another coordinator implementation or another PoolManager (the per-item stream's included, S7 × S8); so a
    /// factory can only build boxes whose clones accept its own coordinators.
    function test_BC100_theConstructorRefusesImplementationsOfAnotherVersion() public {
        (address pinned,) = BackedSourcePins.pinned(1);
        for (uint256 wrong = 1; wrong <= 8; ++wrong) {
            // Each case deploys a fresh version (~309M under Amsterdam versus ~43M before).
            // Rolling state back does not restore gas. Meter each independent case with a fresh budget.
            vm.resetGasMetering();
            uint256 snap = vm.snapshotState();
            _deployFactory(pinned, wrong, true);
            vm.revertToState(snap);
        }
        vm.resetGasMetering();
        BoxFactoryV1 f = _deployFactory(pinned, 0, false);
        assertEq(BoxCoordinator(f.implementations().coordinator).factory(), address(f));
    }

    function test_theConstructorRefusesZeroValuesAndCodelessInputs() public {
        (address pinned,) = BackedSourcePins.pinned(1);
        IBoxFactoryV1.Implementations memory i = version.impls;
        address p = version.planner;
        bytes32 h = keccak256(type(FitBuybackExecutor).creationCode);
        vm.expectRevert(IBoxFactoryV1.ZeroAddress.selector);
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(p), pinned, address(weth), address(0), address(this), h);
        vm.expectRevert(IBoxFactoryV1.ZeroAddress.selector);
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(p), pinned, address(weth), SAFE, address(0), h);
        vm.expectRevert(IBoxFactoryV1.ZeroAddress.selector);
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(p), pinned, address(weth), SAFE, address(this), bytes32(0));
        vm.expectRevert(IBoxFactoryV1.ZeroAddress.selector);
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(p), address(0), address(weth), SAFE, address(this), h);
        vm.expectRevert(IBoxFactoryV1.ZeroAddress.selector);
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(p), pinned, address(0), SAFE, address(this), h);
        address none = makeAddr("s7.noCode");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NoCode.selector, none));
        new BoxFactoryV1(IPoolManager(none), i, BoxFactoryV1Planner(p), pinned, address(weth), SAFE, address(this), h);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NoCode.selector, none));
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(none), pinned, address(weth), SAFE, address(this), h);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NoCode.selector, none));
        new BoxFactoryV1(pm, i, BoxFactoryV1Planner(p), pinned, none, SAFE, address(this), h);
    }

    /// The deployment's own invariants: the factory at the address the coordinator implementation names, its registry at
    /// the factory's first CREATE and box 0's coordinator to come at its second, the per-item stream's implementation
    /// naming the coordinator implementation and the PoolManager, the version code hash over every implementation's
    /// (the stream's included), both extensions', the planner's and T's creation code, FIT's executor's code hash, and
    /// the version's fixed values passed to the planner.
    function test_theVersionIsWiredAsDeployed() public view {
        assertEq(
            BoxCoordinator(version.impls.coordinator).factory(), address(factory), "the factory the coordinator names"
        );
        assertEq(BoxRegistry(version.registry).factory(), address(factory));
        assertEq(version.registry, vm.computeCreateAddress(address(factory), 1), "registry: the factory's 1st CREATE");
        assertEq(factory.box0Addresses().coordinator, vm.computeCreateAddress(address(factory), 2), "box 0: its 2nd");
        assertEq(address(factory.planner()), version.planner);
        assertEq(factory.executorInitCodeHash(), keccak256(type(FitBuybackExecutor).creationCode));
        assertEq(factory.platformSafe(), SAFE);
        assertEq(factory.box0Creator(), address(this));
        assertEq(factory.poolManager(), address(pm));
        assertEq(factory.weth(), address(weth));
        IBoxFactoryV1.Implementations memory i = version.impls;
        assertEq(factory.implementations().itemStream, i.itemStream, "the stream's implementation");
        assertEq(BoxItemStream(i.itemStream).coordinatorImplementation(), i.coordinator, "names the coordinator's");
        assertEq(BoxItemStream(i.itemStream).poolManager(), address(pm), "and the PoolManager");
        bool streamStep;
        for (uint256 k; k < _coreV1Steps.length; ++k) {
            if (keccak256(bytes(_coreV1Steps[k].label)) != keccak256("implementation: BoxItemStream")) continue;
            streamStep = true;
            assertEq(_coreV1Steps[k].at, i.itemStream, "the script's step deploys the stream's implementation");
        }
        assertTrue(streamStep, "the script's steps include the stream's implementation");
        bytes memory head = abi.encode(
            factory.VERSION(),
            i.coordinator.codehash,
            i.hook.codehash,
            version.hookExtension.codehash,
            i.launchRouter.codehash,
            i.receiver.codehash,
            version.receiverExtension.codehash
        );
        bytes memory tail = abi.encode(
            i.collection.codehash,
            i.vault.codehash,
            i.tickets.codehash,
            i.royaltyRouter.codehash,
            i.itemStream.codehash,
            version.planner.codehash,
            keccak256(type(BoxToken).creationCode)
        );
        assertEq(factory.versionCodeHash(), keccak256(bytes.concat(head, tail)), "the version code hash");
        BoxFactoryV1Planner.Version memory v = factory.version();
        assertEq(v.coordinator, factory.box0Addresses().coordinator);
        assertEq(v.raise, 4_206_980_085_000_000_000, "box 0's raise");
        assertEq(v.tickLower, 177_180, "box 0's curve (FitLaunchShape)");
        assertEq(v.tickUpper, 204_060);
        assertEq(v.liquidity, 40_035_151_265_858_715_901_343);
    }

    // ============================================================================================================
    // BC-010: random callers change nothing

    /// BC-010 (the factory and its registry): their only state-changing entry points refuse every caller but the one
    /// fixed at deployment (createBox: the box-0 creator; record: the factory); the planner holds no state at all.
    function testFuzz_BC010_strangersChangeNothingOnTheFactoryOrRegistry(address caller, bytes32 salt) public {
        vm.assume(caller != address(this) && caller != address(factory));
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        vm.deal(caller, 1 ether);
        vm.startPrank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, caller));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistry.NotFactory.selector, caller));
        registry.record(caller, salt, abi.encode(s));
        vm.stopPrank();
        _assertNothingCreated();
    }

    // ============================================================================================================
    // The deploy script's guards (script/DeployCoreV1.s.sol)

    function test_script_aBroadcastNeedsTheGoAheadTheSignerAndBox0sRealSpec() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        address founder = makeAddr("s7.founder");
        vm.expectRevert(DeployCoreV1.BroadcastNotApproved.selector);
        h.checkBroadcast(false, founder, founder, false);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.WrongDeployer.selector, address(this), founder));
        h.checkBroadcast(true, address(this), founder, false);
        vm.expectRevert(DeployCoreV1.FixtureSpecRefused.selector);
        h.checkBroadcast(true, founder, founder, true);
        h.checkBroadcast(true, founder, founder, false);
    }

    function test_script_afterGlamsterdamOnSepoliaSendingNeedsTheAcknowledgement() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        uint256 g = h.GLAMSTERDAM_SEPOLIA();
        assertEq(g, 1_791_294_816, "2026-10-06 13:53:36 UTC");
        h.checkGlamsterdam(11_155_111, g - 1, false);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotAcknowledged.selector, g));
        h.checkGlamsterdam(11_155_111, g, false);
        h.checkGlamsterdam(11_155_111, g, true);
        h.checkGlamsterdam(1, g + 1 days, false);
    }

    /// F80: a spec's openAt is Now (0), or a time from 15 minutes to 14 days after the planning block (the dry run fails
    /// where the broadcast would, before anything is planned to be sent; a stale example time is never sent); the plan
    /// names the first slot at or after it, the window's first block: Sepolia's slots fall on whole minutes, mainnet's 11
    /// seconds after them (genesis times 1655733600 and 1606824023, read off each chain's latest block mod 12).
    function test_script_theOpeningTimeIsNowOrFifteenMinutesToFourteenDaysAhead() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        uint256 t = 1_791_100_000;
        h.checkOpenAt(0, t);
        h.checkOpenAt(t + 15 minutes, t);
        h.checkOpenAt(t + 14 days, t);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.OpenAtTooSoon.selector, t + 15 minutes - 1, t + 15 minutes));
        h.checkOpenAt(t + 15 minutes - 1, t);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.OpenAtTooSoon.selector, t - 1, t + 15 minutes));
        h.checkOpenAt(t - 1, t);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.OpenAtTooFar.selector, t + 14 days + 1, t + 14 days));
        h.checkOpenAt(t + 14 days + 1, t);
        // 2026-10-06 18:00:00 UTC: Sepolia's slot is that second, mainnet's 11 s later; one second later moves both.
        uint256 six = 1_791_309_600;
        assertEq(h.firstSlotAtOrAfter(11_155_111, six), six);
        assertEq(h.firstSlotAtOrAfter(1, six), six + 11);
        assertEq(h.firstSlotAtOrAfter(11_155_111, six + 1), six + 12);
        assertEq(h.firstSlotAtOrAfter(1, six + 11), six + 11);
        assertEq(h.firstSlotAtOrAfter(1, six + 12), six + 23);
        assertEq(h.firstSlotAtOrAfter(31_337, six), 0, "no beacon chain");
    }

    /// The plan: chains 1 and 11155111 only, each with its canonical PoolManager and WETH; the platform Safe and the
    /// box-0 creator by default; box 0's fixture as it is (with its per-item stream), which the planner accepts.
    function test_script_thePlanAndItsDefaults() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        bytes32 fixtureRoot = _box0Spec().revealRoot;
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, fixtureRoot));
        h.plan(address(this));
        vm.chainId(11_155_111);
        // Every Sepolia run is held to the Glamsterdam guard (dry runs too, sepolia-prep): plan before the fork's hour.
        vm.warp(h.GLAMSTERDAM_SEPOLIA() - 1 days);
        DeployCoreV1.Plan memory p = h.plan(address(this));
        assertEq(address(p.poolManager), h.POOL_MANAGER_SEPOLIA());
        assertEq(p.weth, h.WETH_SEPOLIA());
        assertEq(p.platformSafe, SAFE);
        assertEq(p.box0Creator, address(this));
        assertTrue(p.fixture, "no spec file: the fixture");
        assertFalse(p.sending, "a test run sends nothing");
        assertEq(keccak256(abi.encode(p.spec)), keccak256(abi.encode(_box0Spec())), "the core harness's spec");
        assertEq(planner.refusal(p.spec, SAFE).length, 0, "template 0");
        vm.chainId(31_337);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.UnsupportedChain.selector, 31_337));
        h.plan(address(this));
    }

    // ------------------------------------------------------------------------------------------------------------

    /// @dev A complete version with the factory last; `wrong` (1-8) makes the IMPL_* implementation name another
    /// factory or coordinator implementation, and then the factory's construction is expected to revert with it.
    function _deployFactory(address source, uint256 wrong, bool expectFailure) internal returns (BoxFactoryV1 f) {
        // Twelve CREATEs and the factory: the test contract's nonce rises by one per CREATE.
        address factoryAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 12);
        IBoxFactoryV1.Implementations memory i = _implementations(factoryAt, wrong);
        BoxFactoryV1Planner p = new BoxFactoryV1Planner();
        bytes32 h = keccak256(type(FitBuybackExecutor).creationCode);
        if (expectFailure) {
            vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.ImplementationMiswired.selector, wrong));
        }
        f = new BoxFactoryV1(pm, i, p, source, address(weth), SAFE, address(this), h);
        if (!expectFailure) assertEq(address(f), factoryAt, "the predicted factory");
    }

    /// @dev Eleven CREATEs: the version's implementations, the `wrong` one (IMPL_* id) naming another factory or another
    /// coordinator implementation.
    function _implementations(address factoryAt, uint256 wrong)
        internal
        returns (IBoxFactoryV1.Implementations memory i)
    {
        address other = makeAddr("s7.otherVersion");
        i.coordinator = address(new BoxCoordinator(pm, wrong == 1 ? other : factoryAt));
        address hookExt = address(new BoxHookExtension(pm));
        i.hook = address(new BoxHook(pm, wrong == 2 ? other : i.coordinator, hookExt));
        i.launchRouter = address(new BoxLaunchRouter(pm, wrong == 3 ? other : i.coordinator));
        address receiverExt = address(new BoxReceiverExtension(wrong == 4 ? other : i.coordinator));
        i.receiver = address(new BoxReceiver(pm, wrong == 4 ? other : i.coordinator, receiverExt));
        i.collection = address(new BoxCollection(wrong == 5 ? other : i.coordinator));
        i.vault = address(new BoxVault(wrong == 6 ? other : i.coordinator));
        i.tickets = address(new BoxTickets(wrong == 7 ? other : i.coordinator));
        i.royaltyRouter = address(new BoxRoyaltyRouter());
        i.itemStream = address(new BoxItemStream(pm, wrong == 8 ? other : i.coordinator));
    }

    function _expectConstructorRevert(address source, bytes memory err) internal {
        vm.expectRevert(err);
        new BoxFactoryV1(
            pm,
            version.impls,
            BoxFactoryV1Planner(version.planner),
            source,
            address(weth),
            SAFE,
            address(this),
            keccak256(type(FitBuybackExecutor).creationCode)
        );
    }
}
