// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {BoxKind, DeepenSkip, DepthKind, RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {HookGasFit} from "../../research/hookgas/HookGasKit.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {OpenTime} from "../utils/OpenTime.sol";
import {
    EthClaimsMinter,
    MockBoxCoordinator,
    MockWETH,
    RefusingRecipient,
    SettablePriceAverage
} from "./BoxS45Mocks.sol";

/// @notice The review of sh-core-v1 (SH-core-wave-2 § Review): each finding reproduced first, then held fixed.
/// - Stranger clones (security, medium): a box runs only behind a clone of the version's coordinator implementation.
/// - Harvest bound (security, low): moot since F77 removed the rungs; `collect()` pokes at most four positions
///   (BC-122, BoxHookDepth.t.sol).
/// - Pre-graduation depth (code, low; BC-109): every box's 2/15 is held in the receiver until graduation (box 0's too
///   since F77).
/// - Epoch 0 (code, low; BC-106): the graduation settlement counts in epoch 0, however late it runs.
/// - Q-only depth (code, medium; F68 (2a) against F72 (B)): where a Standard box's swept tax ends up.
/// - Creator royalties (security, low): through the receiving router to `fundCreator()`, never to the payee itself.
contract BoxReviewFixesTest is BoxS45Base {
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    function setUp() public {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    function _fees(Box memory b, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        minter.mintTo{value: q}(address(b.receiver));
    }

    // ============================================================================================================
    // Stranger clones: S0 decision 7 ("a stranger's clone of our implementation is inert"), BC-100

    MockBoxCoordinator internal mallorysCoord;
    HookGasFit internal mallorysT;
    BoxLayoutV1.Curve internal mallorysCurve;
    address internal mallorysRouter = makeAddr("review.router");
    address internal mallorysReceiver = makeAddr("review.receiver");

    /// The reviewer's proof of concept (scratch `ReviewStrangerClone.t.sol`), turned into the regression test: Mallory
    /// deploys her own coordinator and T, mines a CREATE2 salt for the hook clone's flags from her own deployer and
    /// clones the launch router and receiver naming her coordinator. Her launch must stop at the first `initialize`.
    function test_review_strangerCannotRunABoxOnTheVersionsImplementations() public {
        _mallorysBox(false);
    }

    /// The same with Mallory's coordinator a clone, of her own implementation: a clone of any code but the version's
    /// coordinator implementation is refused alike.
    function test_review_strangersCloneOfAnotherImplementationIsRefused() public {
        _mallorysBox(true);
    }

    function _mallorysBox(bool asClone) internal {
        address mallory = makeAddr("review.mallory");
        vm.startPrank(mallory);
        mallorysCoord = new MockBoxCoordinator(pm);
        if (asClone) {
            mallorysCoord =
                MockBoxCoordinator(payable(BoxClones.create(BoxClones.initCode(address(mallorysCoord), ""))));
        }
        assertTrue(BoxClones.isCloneOf(address(mallorysCoord), address(coordImpl)) == false, "not the version's");
        mallorysT = new HookGasFit(BoxSpecV1.ISSUANCE, address(mallorysCoord), makeAddr("review.vault"));
        vm.stopPrank();
        mallorysCurve = BoxLayoutV1.curve(BOX0_RAISE, false);
        address hook_ = _mineAndCreateMallorysHook();
        _etchMallorysRouterAndReceiver(hook_);
        mallorysCoord.wire(address(mallorysT), hook_, mallorysRouter, mallorysReceiver, address(0));
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, address(mallorysCoord)));
        mallorysCoord.launch{value: BoxSpecV1.BOOTSTRAP_ETH}(address(0), 0);
        assertEq(uint8(BoxHook(hook_).phase()), 0, "the stranger's hook clone stays uninitialised: inert");
        // Swapping on it is impossible: no pool was ever initialised with this hook.
        PoolKey memory key =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(mallorysT)), 10_000, 60, IHooks(hook_));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: 0.5 ether}(key, true, -int256(0.5 ether), 0);
        // Each other clone refuses her coordinator too (each checks its caller, not its siblings).
        vm.startPrank(address(mallorysCoord));
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, address(mallorysCoord)));
        IBoxLaunchRouter(mallorysRouter).initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotCoordinator.selector, address(mallorysCoord)));
        IBoxReceiver(mallorysReceiver).initialize();
        vm.stopPrank();
    }

    /// The version's implementations name the coordinator implementation they accept; the builder's clones pass.
    function test_review_implementationsNameTheCoordinatorImplementation() public {
        assertEq(hookImpl.coordinatorImplementation(), address(coordImpl));
        assertEq(routerImpl.coordinatorImplementation(), address(coordImpl));
        assertEq(receiverImpl.coordinatorImplementation(), address(coordImpl));
        assertEq(receiverExt.coordinatorImplementation(), address(coordImpl), "S5.M1: the receiver's cold half too");
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        assertTrue(BoxClones.isCloneOf(address(b.coord), address(coordImpl)), "a clone of the version's coordinator");
        assertEq(uint8(b.hook.phase()), 1, "launched: Upcoming");
        // isCloneOf: an EOA, a contract still in its constructor (no code yet) and a longer clone of another code fail.
        assertFalse(BoxClones.isCloneOf(alice, address(coordImpl)));
        assertFalse(BoxClones.isCloneOf(address(b.hook), address(coordImpl)), "a clone of the hook implementation");
        assertTrue(BoxClones.isCloneOf(address(b.hook), address(hookImpl)), "with its arguments behind the proxy");
    }

    function _mallorysHookInit() internal returns (bytes memory) {
        BoxLayoutV1.Curve memory c = mallorysCurve;
        bytes memory head = abi.encodePacked(
            address(0),
            address(mallorysT),
            c.sqrtPriceLowerX96,
            c.sqrtPriceUpperX96,
            mallorysRouter,
            uint8(BoxKind.Standard)
        );
        bytes memory mid = abi.encodePacked(c.tickLower, c.tickUpper, uint32(1), c.liquidity, uint128(BOX0_RAISE));
        bytes memory args =
            abi.encodePacked(head, mid, address(mallorysCoord), mallorysReceiver, makeAddr("review.average"));
        return BoxClones.initCode(address(hookImpl), args);
    }

    function _mineAndCreateMallorysHook() internal returns (address hook_) {
        bytes memory init = _mallorysHookInit();
        bytes32 initHash = keccak256(init);
        bytes32 salt;
        address predicted;
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            predicted = BoxClones.predict(address(this), salt, initHash);
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == 0x2AE0 && uint160(predicted) >> 152 != 0x91) break;
        }
        hook_ = BoxClones.create2(init, salt);
        assertEq(hook_, predicted, "mined address");
    }

    function _etchMallorysRouterAndReceiver(address hook_) internal {
        vm.etch(
            mallorysRouter,
            BoxClones.runtime(
                address(routerImpl),
                abi.encodePacked(
                    uint8(BoxKind.Standard),
                    address(0),
                    address(mallorysT),
                    hook_,
                    address(mallorysCoord),
                    address(0),
                    mallorysCurve.sqrtPriceLowerX96,
                    uint32(1)
                )
            )
        );
        bytes memory head = abi.encodePacked(
            uint8(BoxKind.Standard),
            address(0),
            address(mallorysT),
            address(mallorysCoord),
            hook_,
            makeAddr("review.executor"),
            address(0),
            address(0)
        );
        vm.etch(
            mallorysReceiver,
            BoxClones.runtime(
                address(receiverImpl),
                abi.encodePacked(head, BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_BURN_T, uint8(1), address(0))
            )
        );
    }

    // ============================================================================================================
    // BC-109: other boxes' 2/15 is held in the receiver before graduation (the refund range's at a failure, S11)

    function test_review_standardDepthHeldUntilGraduation() public {
        Params memory p = _standardParams(address(0));
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        (uint256 tOut,) = _buy(b, alice, 0.8 ether, 0);
        _sell(b, alice, tOut / 2);
        (uint256 hq0, uint256 ht0) = b.hook.depthBudget();
        vm.recordLogs();
        b.receiver.collect(keeper);
        {
            (uint256 hq1, uint256 ht1) = b.hook.depthBudget();
            assertEq(hq1, hq0, "no Q moved to the hook before graduation");
            assertEq(ht1, ht0, "no T moved to the hook before graduation");
        }
        (uint256 qDepth, uint256 tDepth) = _splitDepth(vm.getRecordedLogs(), address(b.receiver));
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertEq(dq, qDepth, "the batch's Q 2/15, held");
        assertEq(dt, tDepth, "the batch's T 2/15, held");
        assertGt(dq, 0);
        assertGt(dt, 0);
        // A gift to depth before graduation waits with them.
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        b.receiver.fundDepth{value: 1 ether}();
        (dq,) = b.receiver.depthHeld();
        assertEq(dq, qDepth + 1 ether, "fundDepth() held too");
        {
            (uint256 hq2,) = b.hook.depthBudget();
            assertEq(hq2, hq0);
        }
        // Graduation: all of it moves to the hook in the settlement, and the receiver's books still balance.
        _closeAndGraduate(b);
        _assertHeldMoved(b, hq0 + dq, ht0 + dt);
    }

    function _assertHeldMoved(Box memory b, uint256 qAtLeast, uint256 tAtLeast) internal view {
        (uint256 hq, uint256 ht) = b.hook.depthBudget();
        assertGe(hq, qAtLeast, "the held Q in the hook's depth budget");
        assertGe(ht, tAtLeast, "the held T in the hook's depth budget");
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertEq(dq | dt, 0);
        (uint256 qb, uint256 tb) = b.receiver.booked();
        assertEq(_claims(address(b.receiver), address(0)), qb, "every Q claim booked");
        assertEq(_claims(address(b.receiver), address(b.t)), tb, "every T claim booked");
    }

    /// @dev The BatchSplit events' depth parts (Q, T) emitted by `emitter`.
    function _splitDepth(Vm.Log[] memory logs, address emitter) internal pure returns (uint256 q, uint256 t) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != emitter || logs[i].topics[0] != IBoxReceiver.BatchSplit.selector) continue;
            (,, uint256 qd,,,, uint256 td,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            (q, t) = (q + qd, t + td);
        }
    }

    /// F77: one hold rule for every box. Box 0 has no failure path, so holding changes no money (deepen() skips
    /// NotGraduated before graduation anyway): its 2/15 and its gifts wait in the receiver, then move whole.
    function test_review_box0DepthHeldUntilGraduation() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 tOut,) = _buy(b, alice, 0.8 ether, 0);
        _sell(b, alice, tOut / 2);
        vm.recordLogs();
        b.receiver.collect(keeper);
        (uint256 qDepth, uint256 tDepth) = _splitDepth(vm.getRecordedLogs(), address(b.receiver));
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        b.receiver.fundDepth{value: 1 ether}();
        (uint256 hq0, uint256 ht0) = b.hook.depthBudget();
        assertEq(hq0 | ht0, 0, "box 0: nothing reaches the hook before graduation");
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertEq(dq, qDepth + 1 ether, "the batch's Q 2/15 and the gift, held");
        assertEq(dt, tDepth, "the batch's T 2/15, held");
        assertGt(tDepth, 0);
        _closeAndGraduate(b);
        _assertHeldMoved(b, dq, dt);
    }

    // ============================================================================================================
    // BC-106: the graduation settlement counts in epoch 0, even when it runs in a later epoch

    function test_review_lateSettlementCountsInEpochZero() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, carol);
        b.receiver.collect(keeper); // the curve's fees, before graduation: P held
        uint256 held = b.receiver.platformHeld();
        assertGt(held, 0, "fixture: a held share");
        b.coord.setSkipPokes(true); // the receiver's graduation poke did not run
        b.coord.graduate();
        assertFalse(b.receiver.graduationSettled(), "fixture: not settled at graduation");
        vm.warp(block.timestamp + 31 days); // the first receiver call comes in epoch 1
        vm.deal(address(this), 1.5 ether);
        b.receiver.fundFees{value: 1.5 ether}();
        (uint256 epoch, uint256 kept, uint256 remaining) = b.receiver.platformEpoch();
        assertEq(epoch, 1, "epoch 1");
        assertEq(kept, 0.2 ether, "epoch 1 keeps only its own 2/15 of 1.5 ETH; the held share counted in epoch 0");
        assertEq(remaining, 31.8 ether);
        assertGe(b.receiver.platformOwed(), held + 0.2 ether, "the held share was still kept (in epoch 0)");
        // F77: box 0's held depth part moved with the settlement; it never counts against the cap.
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertEq(dq | dt, 0, "the held depth moved");
        (uint256 hq,) = b.hook.depthBudget();
        assertGe(hq, held + 0.2 ether, "the held 2/15 and epoch 1's 2/15 (1.5 ETH) are depth, beside the platform's");
    }

    /// The settlement charges epoch 0 even 31 days late: its PlatformCredited events carry epoch 0.
    function test_review_lateSettlementEmitsEpochZero() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, carol);
        b.receiver.collect(keeper);
        b.coord.setSkipPokes(true);
        b.coord.graduate();
        vm.warp(block.timestamp + 61 days);
        vm.recordLogs();
        b.receiver.onGraduation();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 credited;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b.receiver)) continue;
            if (logs[i].topics[0] != IBoxReceiver.PlatformCredited.selector) continue;
            assertEq(uint256(logs[i].topics[1]), 0, "epoch 0");
            ++credited;
        }
        assertGt(credited, 0, "the held share was credited");
        (uint256 epoch, uint256 kept,) = b.receiver.platformEpoch();
        assertEq(epoch, 2);
        assertEq(kept, 0, "nothing kept in epoch 2 yet");
    }

    // ============================================================================================================
    // F68 (2a) against F72 (B): a Standard box's swept launch tax is Q only; pair and lock needs T to match it, and
    // S5.M5's conversions (F76) buy that T in small capped steps

    /// BC-110's numbers (window buys of 0.1 ETH at window block 0 and 1 ETH at block 31): the swept tax becomes the
    /// hook's Q claims (every box, box 0's too since F77); one `deepen()` places at most one capped step: a conversion
    /// (the T side below MIN_ADD) or a pair as large as the T side's 2/15 of sellers' fees and the add cap allow. Most
    /// of the tax stays as Q claims that nothing can remove, placed by later calls (founder question 11; F76).
    function test_review_standardTaxIsQOnlyAndIsPlacedInSmallSteps() public {
        Params memory p = _standardParams(address(0));
        p.averageKind = 1;
        _taxIsQOnlyAndIsPlacedInSmallSteps(p);
    }

    /// F77: box 0's tax follows the same rule (into its own hook's Q claims after graduation) and is placed the same way.
    function test_review_box0TaxIsQOnlyAndIsPlacedInSmallSteps() public {
        Params memory p = _box0Params();
        p.averageKind = 1;
        _taxIsQOnlyAndIsPlacedInSmallSteps(p);
    }

    function _taxIsQOnlyAndIsPlacedInSmallSteps(Params memory p) internal {
        Box memory b = _buildAndLaunch(p);
        OpenTime.toStep(b.hook.openAt(), 0);
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        b.router.buy{value: 0.1 ether}(0.1 ether, 0, alice, block.timestamp);
        OpenTime.toStep(b.hook.openAt(), 31);
        vm.prank(alice);
        b.router.buy{value: 1 ether}(1 ether, 0, alice, block.timestamp);
        uint256 tax = address(b.router).balance;
        assertEq(tax, 0.1737624 ether, "BC-110's tax");
        _skipWindow(b);
        _closeAndGraduate(b);
        (uint256 q0, uint256 t0) = b.hook.depthBudget();
        b.router.sweep();
        (uint256 q1,) = b.hook.depthBudget();
        assertEq(q1 - q0, tax, "the tax is Q claims of the hook only");
        // Ordinary trading after graduation: a sell pays T fees, 2/15 of which become the T side.
        deal(address(b.t), bob, 1e26);
        _sell(b, bob, 2e25);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        (uint256 q2, uint256 t2) = b.hook.depthBudget();
        assertGt(t2, t0, "a T side from sellers' fees");
        // Make deepen() addable (cooldown passed, the average at spot).
        vm.roll(b.hook.migratedAtBlock() + 300);
        SettablePriceAverage(b.average).set(true, _tick(b), _tick(b));
        (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) = b.hook.deepen(keeper);
        (uint256 q3, uint256 t3) = b.hook.depthBudget();
        emit log_named_uint("REVIEW|Q-only|tax swept into the hook's Q claims", tax);
        emit log_named_uint("REVIEW|Q-only|Q budget before deepen", q2);
        emit log_named_uint("REVIEW|Q-only|T budget before deepen", t2);
        emit log_named_uint("REVIEW|Q-only|deepen kind (1 pair, 2 conversion alone)", uint256(kind));
        emit log_named_uint("REVIEW|Q-only|Q spent (converted and paired)", qUsed);
        emit log_named_uint("REVIEW|Q-only|T paired", tUsed);
        emit log_named_uint("REVIEW|Q-only|Q left as claims", q3);
        assertEq(uint256(skip), uint256(DeepenSkip.None), "S5.M5: it converts, or pairs");
        assertTrue(kind == DepthKind.Pair || kind == DepthKind.Convert);
        assertEq(q2 - q3, qUsed + tip, "the Q budget fell by what the call spent and its tip");
        if (kind == DepthKind.Convert) assertGt(t3, t2, "the T bought waits as depth");
        assertLt(qUsed, tax / 2, "one call places less than half the tax");
        assertGt(q3, tax / 2, "most of the tax waits as Q claims, placed by later calls");
    }

    // ============================================================================================================
    // Creator royalties: through the receiving router to fundCreator(), credited to the one payee (F72 (3))

    function _creatorRoyaltyBox(address payee) internal returns (Box memory b, BoxRoyaltyRouter r, MockWETH weth) {
        Params memory p = _creatorParams(address(0), payee);
        p.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        p.tStream = BoxSpecV1.T_STREAM_BURN_T;
        p.royalty = RoyaltyDestination.Creator;
        b = _buildAndLaunch(p);
        weth = new MockWETH();
        r = _royaltyRouter(b, address(weth), RoyaltyDestination.Creator);
    }

    /// A payee that refuses ETH (from the start or after a hand-over) no longer blocks royalty-paying sales: the
    /// marketplace pays the router; the flush credits the payee, who pulls to any address it names.
    function test_review_creatorRoyaltiesReachTheOnePayeeThroughTheRouter() public {
        RefusingRecipient refusing = new RefusingRecipient();
        (Box memory b, BoxRoyaltyRouter r, MockWETH weth) = _creatorRoyaltyBox(address(refusing));
        assertEq(uint8(r.destination()), uint8(RoyaltyDestination.Creator));
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(r).call{value: 1 ether}("");
        assertTrue(ok, "the marketplace's push always lands");
        weth.deposit{value: 0.5 ether}();
        weth.transfer(address(r), 0.5 ether);
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        r.flush();
        _skipWindow(b);
        _closeAndGraduate(b);
        (uint256 q0,) = b.receiver.creatorOwed();
        assertEq(r.flush(), 1.5 ether, "ETH and unwrapped WETH");
        (uint256 q1,) = b.receiver.creatorOwed();
        assertEq(q1 - q0, 1.5 ether, "all of it to the creator, no split");
        // The refusing payee claims to an address that accepts ETH.
        uint256 before = carol.balance;
        vm.prank(address(refusing));
        b.receiver.claimCreator(carol);
        assertEq(carol.balance - before, q1, "pulled whole");
    }

    /// fundCreator() is the Creator destination's only: other boxes refuse it; before graduation it is held (F69 C1).
    function test_review_fundCreatorOnlyForCreatorRoyaltiesAndHeldBeforeGraduation() public {
        (Box memory b,,) = _creatorRoyaltyBox(carol);
        vm.deal(bob, 2 ether);
        vm.prank(bob);
        b.receiver.fundCreator{value: 1 ether}();
        (uint256 hq,) = b.receiver.creatorHeld();
        assertEq(hq, 1 ether, "held before graduation");
        Box memory other = _buildAndLaunch(_standardParams(address(0)));
        vm.prank(bob);
        vm.expectRevert(IBoxReceiver.NotCreatorRoyalties.selector);
        other.receiver.fundCreator{value: 1 ether}();
        Box memory zero = _buildAndLaunch(_box0Params());
        vm.prank(bob);
        vm.expectRevert(IBoxReceiver.NotCreatorRoyalties.selector);
        zero.receiver.fundCreator{value: 1 ether}();
    }
}
