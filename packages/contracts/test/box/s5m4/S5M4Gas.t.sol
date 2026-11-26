// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind, FeeBatch, ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {S5M4Base} from "./S5M4Base.sol";
import {S5M4Kit} from "./S5M4Kit.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice S5.M4's gas table (BC-138, BC-017; docs/evidence/SH-misfits-line.md § S5.M4): every keeper and caller path
/// of **box 0 as factory v1 creates it** (its per-item stream on) and of **Standard boxes built by the S5.M4 kit on the
/// same version** (factory v1 refuses them), today (Osaka) and under Glamsterdam (`vm.setEvmVersion("amsterdam")`),
/// every contract real (S3's token, vault, collection and tickets, S9's drand source with real quicknet rounds, the
/// sampler, the module, the receiver and hook halves, the coordinator). Method as CoreBox0Gas and SH-S0-spikes § 2.4:
/// a `gasleft()` delta in this contract's frame around one call (under `amsterdam` it includes EIP-8037 state gas),
/// every account of the world cooled first (`vm.cool`) so each call starts cold like its own transaction, and the slots
/// written from zero, new accounts and code bytes counted from the state diff. Each line is logged as
/// `M4|<box>|<path>|<today|glamsterdam total> <gas>|new slots <n>|...` and each tip paid as `M4TIP|<path>|<wei>`.
/// The steady module steps write no slot from zero and stay within swap-module § 7's budget (BC-138).
/// forge-config: default.evm_version = "osaka"
contract S5M4GasTest is S5M4Base {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;
    uint256 internal constant Q96 = 1 << 96;
    /// The measured budget of a steady step (BC-138): SH-S5-swap's largest steady step, one whose pull also takes back
    /// returned fees (BuyForCreator 338,044 today, 500,744 under Glamsterdam, on S5's harness), rounded up. swap-module
    /// § 7's estimate (I: ≈ 220,000-320,000 / 260,000-400,000, + 25,000-50,000 for a burn) was below it for such steps.
    uint256 internal constant STEP_BUDGET_TODAY = 340_000;
    uint256 internal constant STEP_BUDGET_GLAMSTERDAM = 510_000;

    address internal erin = makeAddr("s5m4.erin");

    struct Measured {
        uint256 gas;
        uint256 newSlots;
        bytes ret;
    }

    /// deepen() kinds measured per box (the table needs each at least once).
    uint256 internal _converts;
    uint256 internal _convertPairs;
    uint256 internal _pairs;

    function setUp() public {
        _setUpLocal();
        vm.warp(src.roundTime(r0) - 1 days);
        vm.deal(keeper, 1);
    }

    // ============================================================================================================
    // Creation: box 0 by createBox, a Standard box by the kit, the module and sampler clones alone

    function test_gas_creation_today() public {
        _creation(false);
    }

    function test_gas_creation_glamsterdam() public {
        _creation(true);
    }

    function _creation(bool g) internal {
        uint256 snap = vm.snapshotState();
        _begin(g);
        k.create();
        _endWith("box 0", "createBox (factory v1, the fixture, with its per-item stream)", g, k.creationGas());
        vm.revertToState(snap);
        k.create();
        // A Standard box as a later factory would create it, in three calls from this frame: the coordinator clone's
        // CREATE2, `deploy` (every clone at its nonce, the sampler and the module clone included; the hook's CREATE2)
        // and `launch` (initialisations, the curve, the bootstrap); the factory's own frame (validate(), the registry)
        // is not in it.
        (S5M4Kit.StdBox memory x, bytes memory coordInit, bytes32 salt, bytes[] memory codes, bytes memory hookInit) =
            k.planStandard(_defaultParams());
        Measured memory m1 = _call(
            "standard",
            "creation 1/3: the coordinator clone's CREATE2",
            g,
            address(this),
            address(creator),
            0,
            abi.encodeCall(creator.create2, (coordInit, salt))
        );
        // The kit plans the coordinator at its own CREATE2 address; the measured clone is the helper's: move its code.
        vm.etch(x.coordinator, abi.decode(m1.ret, (address)).code);
        vm.setNonce(x.coordinator, 1);
        Measured memory m2 = _call(
            "standard",
            "creation 2/3: deploy (CREATEs: table, T, vault, collection, receiver, router, sampler, tickets, module, royalty router; the hook's CREATE2)",
            g,
            address(k.factory()),
            x.coordinator,
            0,
            abi.encodeCall(BoxCoordinator.deploy, (codes, hookInit, x.hookSalt, 1))
        );
        _moduleInitAlone(g, x);
        Measured memory m3 = _call(
            "standard",
            "creation 3/3: launch (every initialize, the module's from the receiver's; the curve; the bootstrap)",
            g,
            address(k.factory()),
            x.coordinator,
            BoxSpecV1.BOOTSTRAP_ETH,
            abi.encodeCall(BoxCoordinator.launch, ())
        );
        _log(
            "standard",
            "creation: the three together",
            g,
            m1.gas + m2.gas + m3.gas,
            m1.newSlots + m2.newSlots + m3.newSlots
        );
        k.adopt(x);
        _clonesAlone(g, x);
    }

    /// The module's `initialize` alone, as the receiver's initialize calls it inside `launch` (its slots from zero),
    /// in a snapshot.
    function _moduleInitAlone(bool g, S5M4Kit.StdBox memory x) internal {
        uint256 snap = vm.snapshotState();
        _call(
            "standard",
            "of launch: the module's initialize (from the receiver's)",
            g,
            x.receiver,
            x.module,
            0,
            abi.encodeCall(BoxSwapModule.initialize, ())
        );
        vm.revertToState(snap);
    }

    /// One module clone and one sampler clone alone (the per-box contracts a Standard box adds over box 0).
    function _clonesAlone(bool g, S5M4Kit.StdBox memory x) internal {
        bytes memory moduleCode = BoxClones.initCode(
            address(k.moduleImpl()),
            abi.encodePacked(x.receiver, x.hook, x.sampler, address(0), x.token, uint8(1), uint8(1))
        );
        _call(
            "standard",
            "of deploy: one module clone's CREATE (45 + 102 bytes)",
            g,
            address(this),
            address(creator),
            0,
            abi.encodeCall(creator.create, (moduleCode))
        );
        bytes memory samplerCode =
            BoxClones.initCode(address(k.samplerImpl()), abi.encodePacked(x.hook, address(0), x.token));
        _call(
            "standard",
            "of deploy: one sampler clone's CREATE (45 + 60 bytes)",
            g,
            address(this),
            address(creator),
            0,
            abi.encodeCall(creator.create, (samplerCode))
        );
    }

    // ============================================================================================================
    // Box 0: every keeper and holder path through its life (graduation word and a draw on real quicknet rounds)

    function test_gas_box0_today() public {
        _box0(false);
    }

    function test_gas_box0_glamsterdam() public {
        _box0(true);
    }

    function _box0(bool g) internal {
        k.create();
        a = k.addresses();
        _box0Curve(g);
        _box0Graduation(g);
        _box0Draw(g);
        _box0AfterGraduation(g);
        _box0Payouts(g);
        _box0Executor(g);
        _box0Stream(g);
        _depth(g, "box 0", a.hook, a.receiver, a.executor);
    }

    function _box0Curve(bool g) internal {
        k.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        k.buy(alice, 1 ether, 0);
        k.buy(bob, 1 ether, 0);
        _take(alice, 3);
        _take(bob, 2);
        k.roll(12);
        _collect(g, "box 0", "collect: a batch on the curve (D6 reserve topped up)", a.receiver);
        BoxLayoutV1.Curve memory c = k.curve();
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        k.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), c.sqrtPriceLowerX96);
        assertTrue(BoxHook(a.hook).closed(), "closed");
    }

    /// The closing block: graduate(); the word's round posted and accepted (no clock moves past the local rounds
    /// before the draw: they are 3 s apart).
    function _box0Graduation(bool g) internal {
        _call(
            "box 0",
            "graduate (all real pokes: receiver, tickets' word request, FIT's executor, the stream)",
            g,
            keeper,
            a.coordinator,
            0,
            abi.encodeCall(BoxCoordinator.graduate, ())
        );
        vm.warp(src.roundTime(r0));
        vm.roll(block.number + 1);
        _call(
            "box 0",
            "drand postRound (the graduation word's round, no pot)",
            g,
            dave,
            address(src),
            0,
            abi.encodeCall(src.postRound, (r0, _localSig(0)))
        );
        _call(
            "box 0",
            "tickets.acceptGraduationWord",
            g,
            keeper,
            a.tickets,
            0,
            abi.encodeCall(BoxTickets.acceptGraduationWord, ())
        );
    }

    function _box0Draw(bool g) internal {
        k.buy(carol, 0.5 ether, 0);
        vm.prank(carol);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.warp(src.roundTime(r0 + 5) - 12);
        vm.roll(block.number + 1);
        vm.fee(1 gwei);
        uint256 pot = BoxSpecV1.DRAND_BOUNTY_GAS * 1 gwei;
        _call(
            "box 0",
            "tickets.draw (at a 1 gwei base fee: tops the round's pot to 600,000 x base fee)",
            g,
            carol,
            a.tickets,
            pot,
            abi.encodeCall(BoxTickets.draw, (type(uint256).max, block.timestamp))
        );
        vm.warp(src.roundTime(r0 + 5));
        vm.roll(block.number + 1);
        _call(
            "box 0",
            "drand postRound (a draw's round; the poster takes the pot)",
            g,
            dave,
            address(src),
            0,
            abi.encodeCall(src.postRound, (r0 + 5, _localSig(5)))
        );
        vm.fee(0);
        _call("box 0", "tickets.settle(1)", g, keeper, a.tickets, 0, abi.encodeCall(BoxTickets.settle, (1)));
    }

    function _box0AfterGraduation(bool g) internal {
        _trade(k.poolKey(), a.token, 0.3 ether, 3);
        k.roll(1);
        _tipLine(
            "collect, box 0, the first after graduation",
            _collect(
                g, "box 0", "collect: the first after graduation (13/15 of T to the stream, its notice)", a.receiver
            )
        );
        _call(
            "box 0",
            "launchRouter.sweep (the tax into its own pool, F77)",
            g,
            keeper,
            a.launchRouter,
            0,
            abi.encodeWithSignature("sweep()")
        );
        _call(
            "box 0",
            "coordinator.claimReward (D6)",
            g,
            keeper,
            a.coordinator,
            0,
            abi.encodeCall(BoxCoordinator.claimReward, (keeper))
        );
        vm.deal(address(this), address(this).balance + 0.1 ether);
        (bool ok,) = a.royaltyRouter.call{value: 0.1 ether}("");
        assertTrue(ok);
        _call(
            "box 0",
            "royaltyRouter.flush (0.1 ETH into fee handling)",
            g,
            keeper,
            a.royaltyRouter,
            0,
            abi.encodeWithSignature("flush()")
        );
    }

    function _box0Payouts(bool g) internal {
        // FIT's and the platform's shares through the ETH intake (11/15 to FIT, 2/15 to the Safe under its cap).
        _fundFees(a.receiver, 3 ether);
        _call(
            "box 0",
            "receiver.payFit (FIT's share into its executor's budget)",
            g,
            keeper,
            a.receiver,
            0,
            abi.encodeCall(BoxReceiver.payFit, ())
        );
        _call(
            "box 0",
            "receiver.payPlatform (the Safe's capped 2/15)",
            g,
            keeper,
            a.receiver,
            0,
            abi.encodeCall(BoxReceiver.payPlatform, ())
        );
    }

    /// FIT's executor's own average is poked every block for 700 blocks first (as BoxDepthConvertGas's ring fill), so
    /// its reference is box 0's price. (Its seed was the curve's start until the review of the Misfits line, finding
    /// 4; it is P1 now, so the first buy comes after about an hour of samples, 318 in S5M4Findings; 700 keeps the
    /// measured state as it was.)
    function _box0Executor(bool g) internal {
        _hold(a.executor, 700);
        _execute(g, "FIT's executor.execute(1): the first buy-and-burn step (pays no tip)");
        _hold(a.executor, 2);
        _execute(g, "FIT's executor.execute(1): steady");
    }

    /// One chunk of FIT's buy-and-burn (box 0's buy-back; the caller is paid nothing): it must have bought and burned.
    function _execute(bool g, string memory label) internal {
        Measured memory m =
            _call("box 0", label, g, keeper, a.executor, 0, abi.encodeCall(FitBuybackExecutor.execute, (1)));
        (uint256 chunks, uint256 ethSpent, uint256 fitBurned) = abi.decode(m.ret, (uint256, uint256, uint256));
        assertEq(chunks, 1, string.concat(label, ": one chunk"));
        assertGt(ethSpent, 0, string.concat(label, ": it bought"));
        assertGt(fitBurned, 0, string.concat(label, ": it burned"));
    }

    /// A month on (opening without a reveal waits for RETURN_GRACE, as SH-S8's life): the opens, the stream.
    function _box0Stream(bool g) internal {
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        ItemReveal memory none;
        _call(
            "box 0",
            "tickets.openDraw by the drawer (its Misfit's first exit, stream on)",
            g,
            carol,
            a.tickets,
            0,
            abi.encodeCall(BoxTickets.openDraw, (1, address(0), none))
        );
        Measured memory m = _call(
            "box 0",
            "tickets.open (a placeholder to its Misfit, its first exit, stream on)",
            g,
            alice,
            a.tickets,
            0,
            abi.encodeCall(BoxTickets.open, (1, none))
        );
        uint256 itemA = abi.decode(m.ret, (uint256));
        _trade(k.poolKey(), a.token, 0.3 ether, 3);
        k.roll(1);
        _tipLine(
            "collect, box 0, steady",
            _collect(g, "box 0", "collect: steady (13/15 of the T side to the stream, its notice and burn)", a.receiver)
        );
        uint256[] memory ids = new uint256[](1);
        ids[0] = itemA;
        _call(
            "box 0",
            "stream.claim, one Misfit (the owner's first claim)",
            g,
            alice,
            a.itemStream,
            0,
            abi.encodeCall(BoxItemStream.claim, (ids, alice))
        );
        _trade(k.poolKey(), a.token, 0.3 ether, 2);
        k.roll(1);
        _collectQuiet(a.receiver);
        _call(
            "box 0",
            "stream.claim, one Misfit (steady)",
            g,
            alice,
            a.itemStream,
            0,
            abi.encodeCall(BoxItemStream.claim, (ids, alice))
        );
        _call(
            "box 0",
            "Misfit transferFrom: to a new holder (stream on)",
            g,
            alice,
            a.collection,
            0,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, erin, itemA)
        );
        k.roll(1);
        _call(
            "box 0",
            "Misfit transferFrom: back to a known holder (stream on)",
            g,
            erin,
            a.collection,
            0,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", erin, alice, itemA)
        );
        _call(
            "box 0",
            "stream.burn (the items-inside share; anyone)",
            g,
            keeper,
            a.itemStream,
            0,
            abi.encodeCall(BoxItemStream.burn, ())
        );
    }

    function _take(address who, uint256 n) internal {
        vm.startPrank(who);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        BoxTickets(a.tickets).take(n, type(uint256).max, block.timestamp);
        vm.stopPrank();
    }

    // ============================================================================================================
    // Standard box D (BUYBACK_BURN_T, BURN_T): graduation, the sampler, collects, BuyBurn and SellForFit, deepen()

    function test_gas_standard_today() public {
        _standard(false);
    }

    function test_gas_standard_glamsterdam() public {
        _standard(true);
    }

    function _standard(bool g) internal {
        _createAll();
        a = k.addresses();
        _stdWindowBuy(D);
        _box0Graduated();
        S5M4Kit.StdBox memory x = _std(D);
        _stdGraduation(g, x);
        _stdFirstSteps(g, x);
        _stdSteadySteps(g, x);
        _depth(g, "standard", x.hook, x.receiver, x.sampler);
        _call(
            "standard",
            "receiver.payFit (a Standard box's 3/15 to FIT's executor)",
            g,
            keeper,
            x.receiver,
            0,
            abi.encodeCall(BoxReceiver.payFit, ())
        );
        _trade(x.key, x.token, 0.3 ether, 2);
        k.roll(1);
        _tipLine(
            "collect, standard, returning the hook's conversion note",
            _collect(g, "standard", "collect: steady, returning the hook's conversion note to its claims", x.receiver)
        );
    }

    function _stdGraduation(bool g, S5M4Kit.StdBox memory x) internal {
        uint256 end = BoxHook(x.hook).windowEndsAt();
        if (block.timestamp < end) k.roll((end - block.timestamp + 11) / 12);
        uint256 t = k.swapOn(x.key, x.token, alice, true, 0.6 ether, 0);
        k.swapOn(x.key, x.token, bob, true, 0.4 ether, 0);
        k.swapOn(x.key, x.token, alice, false, t / 3, 0);
        k.roll(12);
        _collectQuiet(x.receiver);
        k.roll(12);
        k.swapOn(x.key, x.token, carol, true, 3 * x.raise, BoxLayoutV1.curve(x.raise, false).sqrtPriceLowerX96);
        _call(
            "standard",
            "graduate (pokes: receiver, tickets' word request, FIT's executor)",
            g,
            keeper,
            x.coordinator,
            0,
            abi.encodeCall(BoxCoordinator.graduate, ())
        );
        k.roll(1);
        _call(
            "standard",
            "sampler.poke: the first after graduation (P1 seeded; our keeper's)",
            g,
            keeper,
            x.sampler,
            0,
            abi.encodeCall(IBoxPriceAverage.poke, ())
        );
        k.roll(1);
        _call("standard", "sampler.poke: steady", g, keeper, x.sampler, 0, abi.encodeCall(IBoxPriceAverage.poke, ()));
        _hold(x.sampler, 300);
        _call(
            "standard",
            "launchRouter.sweep (the tax into the hook's claims: Q-only depth)",
            g,
            keeper,
            x.launchRouter,
            0,
            abi.encodeWithSignature("sweep()")
        );
        _call(
            "standard",
            "coordinator.claimReward (D6)",
            g,
            keeper,
            x.coordinator,
            0,
            abi.encodeCall(BoxCoordinator.claimReward, (keeper))
        );
    }

    function _stdFirstSteps(bool g, S5M4Kit.StdBox memory x) internal {
        _trade(x.key, x.token, 2 ether, 3);
        _hold(x.sampler, 300);
        _tipLine(
            "collect, standard, the first after graduation",
            _collect(g, "standard", "collect: the first after graduation (the module's ledgers owed)", x.receiver)
        );
        _step(
            g,
            "standard",
            "step BuyBurn: the first (the pull; its Q claims and T balance from zero)",
            x,
            IBoxSwapModule.Action.BuyBurn,
            false
        );
        _call(
            "standard",
            "step: a skip (BlockLimit: a second step in the block)",
            g,
            keeper,
            x.module,
            0,
            abi.encodeCall(BoxSwapModule.step, (IBoxSwapModule.Action.SellForFit, keeper))
        );
        _hold(x.sampler, 1);
        _step(
            g,
            "standard",
            "step SellForFit: the first (W4; its T claims from zero)",
            x,
            IBoxSwapModule.Action.SellForFit,
            false
        );
    }

    function _stdSteadySteps(bool g, S5M4Kit.StdBox memory x) internal {
        _trade(x.key, x.token, 2 ether, 3);
        _hold(x.sampler, 300);
        _tipLine(
            "collect, standard, steady with the module's notes",
            _collect(g, "standard", "collect: steady, returning the module's Q and T notes (REV-16)", x.receiver)
        );
        _step(
            g,
            "standard",
            "step BuyBurn: steady (its pull hands a batch and returned fees)",
            x,
            IBoxSwapModule.Action.BuyBurn,
            true
        );
        _hold(x.sampler, 1);
        _step(
            g,
            "standard",
            "step SellForFit: steady (its pull hands nothing new)",
            x,
            IBoxSwapModule.Action.SellForFit,
            true
        );
        _hold(x.sampler, 1);
        _step(
            g, "standard", "step BuyBurn: steady (its pull hands nothing new)", x, IBoxSwapModule.Action.BuyBurn, true
        );
        _call(
            "standard", "module.sync (nothing to pull)", g, keeper, x.module, 0, abi.encodeCall(BoxSwapModule.sync, ())
        );
        _call(
            "standard",
            "module.burnPending (nothing waiting)",
            g,
            keeper,
            x.module,
            0,
            abi.encodeCall(BoxSwapModule.burnPending, ())
        );
    }

    // ============================================================================================================
    // Standard box C (CREATOR_IN_T, CREATOR_IN_Q, add-on 5 at 32 ETH with a BURN excess): the creator steps

    function test_gas_creator_today() public {
        _creatorSteps(false);
    }

    function test_gas_creator_glamsterdam() public {
        _creatorSteps(true);
    }

    function _creatorSteps(bool g) internal {
        _createAll();
        a = k.addresses();
        _stdWindowBuy(C);
        _box0Graduated();
        _stdGraduated(C);
        S5M4Kit.StdBox memory x = _std(C);
        _trade(x.key, x.token, 2 ether, 3);
        _hold(x.sampler, 300);
        _tipLine(
            "collect, creator box, the first after graduation",
            _collect(g, "creator", "collect with add-on 5: the first after graduation", x.receiver)
        );
        _step(g, "creator", "step BuyForCreator: the first", x, IBoxSwapModule.Action.BuyForCreator, false);
        _hold(x.sampler, 1);
        _step(
            g,
            "creator",
            "step SellForCreator (the cap counted): the first",
            x,
            IBoxSwapModule.Action.SellForCreator,
            false
        );
        _hold(x.sampler, 1);
        _step(g, "creator", "step SellForFit (W4): the first", x, IBoxSwapModule.Action.SellForFit, false);
        _trade(x.key, x.token, 2 ether, 3);
        _hold(x.sampler, 300);
        _tipLine(
            "collect, creator box, steady",
            _collect(g, "creator", "collect with add-on 5: steady (creator Q at face, notes returned)", x.receiver)
        );
        _step(g, "creator", "step BuyForCreator: steady", x, IBoxSwapModule.Action.BuyForCreator, true);
        _hold(x.sampler, 1);
        _step(
            g, "creator", "step SellForCreator (the cap counted): steady", x, IBoxSwapModule.Action.SellForCreator, true
        );
        _call(
            "creator",
            "receiver.claimCreator (Q and T to the payee)",
            g,
            carol,
            x.receiver,
            0,
            abi.encodeCall(BoxReceiver.claimCreator, (carol))
        );
    }

    // ============================================================================================================
    // deepen(): conversions alone, conversions with a pair, a pair alone; box 0 on FIT's executor's average, a
    // Standard box on its sampler. Each call is labelled by what it did (its kind, a DepthConverted event or not).

    function _depth(bool g, string memory box, address hook, address receiver, address average) internal {
        (_converts, _convertPairs, _pairs) = (0, 0, 0);
        _fillRing(average);
        _fundDepthQ(receiver, 1 ether);
        _deepen(g, box, hook, average);
        _deepen(g, box, hook, average);
        _topUpT(hook, 95);
        _deepen(g, box, hook, average);
        _topUpT(hook, 300);
        _deepen(g, box, hook, average);
        _topUpT(hook, 95);
        _deepen(g, box, hook, average);
        _deepen(g, box, hook, average);
        assertGt(_converts, 0, "a conversion alone measured");
        assertGt(_convertPairs, 0, "a conversion with a pair measured");
        assertGt(_pairs, 0, "a pair alone measured");
    }

    /// One deepen() after its cooldown, the average poked across it; labelled by what it did.
    function _deepen(bool g, string memory box, address hook, address average) internal {
        _settleDeepen(hook, average);
        vm.recordLogs();
        Measured memory m = _measure(g, keeper, hook, 0, abi.encodeCall(IBoxHook.deepen, (keeper)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool converted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == hook && logs[i].topics[0] == IBoxHook.DepthConverted.selector) converted = true;
        }
        (DepthKind kind, DeepenSkip skip,,, uint256 tip) =
            abi.decode(m.ret, (DepthKind, DeepenSkip, uint256, uint256, uint256));
        assertEq(uint256(skip), uint256(DeepenSkip.None), "deepen ran");
        string memory what;
        if (kind == DepthKind.Convert) {
            what = "deepen: a conversion alone";
            ++_converts;
        } else if (converted) {
            what = "deepen: a conversion and a pair";
            ++_convertPairs;
        } else {
            what = "deepen: a pair alone";
            ++_pairs;
        }
        what = string.concat(what, m.newSlots == 0 ? " (no slot from zero)" : " (slots from zero: see the count)");
        _report(box, what, g, m);
        _tipLine(string.concat(box, ", ", what), tip);
    }

    /// The ring filled (8 checkpoints about 515 s apart), so a deepen's or a step's poke writes no new checkpoint.
    function _fillRing(address average) internal {
        for (uint256 i; i < 10; ++i) {
            k.roll(44);
            IBoxPriceAverage(average).poke();
        }
    }

    /// The next deepen's cooldown passed, the average poked across it (it follows the price).
    function _settleDeepen(address hook, address average) internal {
        for (uint256 i; i < 7; ++i) {
            k.roll(44);
            IBoxPriceAverage(average).poke();
        }
        uint256 last = BoxHook(hook).lastDeepenBlock();
        if (block.number < last + 300) k.roll(last + 300 - block.number);
        IBoxPriceAverage(average).poke();
    }

    function _fundDepthQ(address receiver, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        BoxReceiver(payable(receiver)).fundDepth{value: q}();
    }

    /// The hook's T side brought to `pct`% of MIN_ADD at spot, by T claims carol gives it (her T from the close).
    function _topUpT(address hook, uint256 pct) internal {
        BoxHook h = BoxHook(hook);
        PoolKey memory key = h.poolKey();
        uint160 s = _sqrtP(key);
        uint256 want = FullMath.mulDiv(FullMath.mulDiv(h.minAdd() * pct / 100, s, Q96), s, Q96);
        (, uint256 have) = h.depthBudget();
        if (want <= have) return;
        address token = h.token();
        vm.prank(carol);
        BoxToken(token).transfer(bob, want - have);
        funder.deposit(token, bob, want - have, hook);
    }

    // ============================================================================================================
    // Steps, collects

    function _step(
        bool g,
        string memory box,
        string memory label,
        S5M4Kit.StdBox memory x,
        IBoxSwapModule.Action action,
        bool steady
    ) internal {
        Measured memory m = _measure(g, keeper, x.module, 0, abi.encodeCall(BoxSwapModule.step, (action, keeper)));
        (IBoxSwapModule.Stop stop,,, uint256 tip) = abi.decode(m.ret, (IBoxSwapModule.Stop, uint256, uint256, uint256));
        assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.None), string.concat(label, ": it stepped"));
        _report(box, label, g, m);
        _tipLine(string.concat(box, ", ", label), tip);
        if (steady) {
            assertEq(m.newSlots, 0, string.concat(label, ": no slot written from zero (BC-138)"));
            assertLe(
                m.gas,
                g ? STEP_BUDGET_GLAMSTERDAM : STEP_BUDGET_TODAY,
                string.concat(label, ": within the measured budget")
            );
        }
    }

    function _collect(bool g, string memory box, string memory label, address receiver) internal returns (uint256) {
        Measured memory m = _call(box, label, g, keeper, receiver, 0, abi.encodeCall(BoxReceiver.collect, (keeper)));
        return abi.decode(m.ret, (FeeBatch)).tip;
    }

    function _collectQuiet(address receiver) internal {
        try BoxReceiver(payable(receiver)).collect(keeper) {} catch {}
    }

    // ============================================================================================================
    // Measuring and logging

    /// One call as `who` from this frame, every account cooled first, the state diff counted; reverts with its error.
    function _measure(bool g, address who, address target, uint256 value, bytes memory data)
        internal
        returns (Measured memory m)
    {
        if (value != 0) {
            vm.deal(who, who.balance + value);
            vm.deal(address(this), address(this).balance + value);
        }
        _begin(g);
        vm.prank(who);
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        m.gas = g0 - gasleft();
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        m.newSlots = c.newSlots;
        m.ret = ret;
        _lastAccounts = c.accounts;
        _lastCodeBytes = c.codeBytes;
    }

    uint256 internal _lastAccounts;
    uint256 internal _lastCodeBytes;

    function _call(
        string memory box,
        string memory label,
        bool g,
        address who,
        address target,
        uint256 value,
        bytes memory data
    ) internal returns (Measured memory m) {
        m = _measure(g, who, target, value, data);
        _report(box, label, g, m);
    }

    function _report(string memory box, string memory label, bool g, Measured memory m) internal {
        uint256 state = m.newSlots * STATE_GAS_PER_SLOT + _lastAccounts * STATE_GAS_PER_ACCOUNT + _lastCodeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "M4|",
                box,
                "|",
                label,
                g ? "|glamsterdam total " : "|today ",
                vm.toString(m.gas),
                "|new slots ",
                vm.toString(m.newSlots),
                "|accounts ",
                vm.toString(_lastAccounts),
                g ? string.concat("|of which state gas ", vm.toString(state)) : ""
            ));
    }

    function _log(string memory box, string memory label, bool g, uint256 gas, uint256 newSlots) internal {
        emit log_string(string.concat(
                "M4|",
                box,
                "|",
                label,
                g ? "|glamsterdam total " : "|today ",
                vm.toString(gas),
                "|new slots ",
                vm.toString(newSlots)
            ));
    }

    function _tipLine(string memory path, uint256 tip) internal {
        emit log_string(string.concat("M4TIP|", path, "|", vm.toString(tip)));
    }

    function _begin(bool g) internal {
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.startStateDiffRecording();
    }

    /// For a call the kit measured in its own frame (createBox): stop the recording and log.
    function _endWith(string memory box, string memory label, bool g, uint256 gas) internal {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        _lastAccounts = c.accounts;
        _lastCodeBytes = c.codeBytes;
        _report(box, label, g, Measured({gas: gas, newSlots: c.newSlots, ret: ""}));
    }

    function _coolAll() internal {
        a = k.addresses();
        address[16] memory list0 = [
            a.coordinator,
            a.token,
            a.collection,
            a.vault,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.executor,
            a.itemStream,
            a.table,
            a.poolManager,
            a.randomness,
            a.weth,
            address(k.swapper())
        ];
        for (uint256 i; i < list0.length; ++i) {
            vm.cool(list0[i]);
        }
        address[12] memory list1 = [
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.receiverExtension,
            impls.collection,
            impls.vault,
            impls.tickets,
            impls.royaltyRouter,
            impls.itemStream,
            address(k.factory())
        ];
        for (uint256 i; i < list1.length; ++i) {
            vm.cool(list1[i]);
        }
        vm.cool(address(k.samplerImpl()));
        vm.cool(address(k.moduleImpl()));
        vm.cool(address(creator));
        vm.cool(address(funder));
        uint256 n = k.stdCount();
        for (uint256 i; i < n; ++i) {
            _coolStd(k.std(i));
        }
    }

    function _coolStd(S5M4Kit.StdBox memory x) internal {
        address[12] memory list = [
            x.coordinator,
            x.table,
            x.token,
            x.vault,
            x.collection,
            x.receiver,
            x.launchRouter,
            x.sampler,
            x.tickets,
            x.module,
            x.royaltyRouter,
            x.hook
        ];
        for (uint256 i; i < list.length; ++i) {
            vm.cool(list[i]);
        }
    }
}
