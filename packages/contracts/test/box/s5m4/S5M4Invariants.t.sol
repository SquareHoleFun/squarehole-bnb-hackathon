// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {DeepenSkip, DepthKind, ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {EthClaimsMinter} from "../s45/BoxS45Mocks.sol";
import {S5M4Base} from "./S5M4Base.sol";
import {S5M4Handler} from "./S5M4Handler.sol";
import {S5M4Kit} from "./S5M4Kit.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice S5.M4's invariant suite across the receiver, the swap module, the hook and the per-item stream (BC-129's
/// campaign, BC-132, BC-139, BC-141; docs/evidence/SH-misfits-line.md § S5.M4), on box 0 as factory v1 creates it
/// (its stream started, five Misfits outside) and the kit's Standard boxes D (on its curve at the start: its
/// graduation happens inside the campaign) and C (graduated; creator conversions and add-on 5), every contract real.
/// Under random operations (`S5M4Handler`), always:
/// - **no value created or lost beyond the stated rounding:** each module's ledgers are exactly its claims and its T
///   to burn exactly its T (each ledger keeps its 1 raw unit, § 6); each hook's depth budget is exactly its claims and
///   it holds no ETH or T; each receiver's claims cover its ledgers (the rest is the next batch) with a carry below one
///   fifteenth, and the T it holds covers its pending burn; the stream holds at least what owners have accrued; every
///   T's supply plus its burns is its issuance;
/// - **the module takes nothing else:** its booked fee notes never exceed Σ handed × LP_FEE / 10^6 per side, and the
///   receiver's allowance is exactly that less the notes (BC-132);
/// - **the platform never above its cap:** box 0's credits are at most 32 ETH in every epoch, the Safe's ETH moves only
///   in `payPlatform()` and by what it paid, and no other box ever credits a platform (BC-106, BC-141);
/// - **nothing blocks collect or graduate:** no `collect()` is refused for anything but a batch below the minimum, no
///   `graduate()` once the curve closed, and no step, `sync`, `burnPending`, deepen(), FIT execute() or owner's stream
///   claim reverts (each failure is a skip) (BC-060, BC-098, BC-132).
/// The campaign runs the repository's settings (256 runs of 128 calls; `FOUNDRY_PROFILE=deep` for 1,024 of 256). Three
/// scripted runs on the same world close what the cases left to S5.M4: BC-141's life with the module's steps and the
/// conversions over three epochs, BC-132's real step beside a hook pair's poke, and BC-130 on the real module.
/// forge-config: default.evm_version = "osaka"
contract S5M4InvariantTest is S5M4Base {
    S5M4Handler internal h;
    EthClaimsMinter internal minter;
    uint256[] internal items;
    address internal erin = makeAddr("s5m4.erin");

    function setUp() public {
        _setUpLocal();
        vm.warp(src.roundTime(r0) - 1 days);
        _createAll();
        a = k.addresses();
        _stdWindowBuy(D);
        _stdWindowBuy(C);
        _box0WithMisfitsOutside();
        _stdGraduated(C);
        _hold(a.executor, 700);
        minter = new EthClaimsMinter(pm);
        h = new S5M4Handler(k, carol, [alice, bob, erin], items);
        targetContract(address(h));
    }

    /// Box 0 through its curve (placeholders taken), graduation in the block before the first local drand round, the
    /// word accepted, a month on (opening without a reveal), five Misfits opened: the stream has owners.
    function _box0WithMisfitsOutside() internal {
        k.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        k.buy(alice, 1 ether, 0);
        k.buy(bob, 1 ether, 0);
        _takeTickets(alice, 3);
        _takeTickets(bob, 2);
        k.roll(12);
        BoxReceiver(payable(a.receiver)).collect(keeper);
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        k.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), k.curve().sqrtPriceLowerX96);
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        vm.warp(src.roundTime(r0));
        vm.roll(block.number + 1);
        src.postRound(r0, _localSig(0));
        BoxTickets(a.tickets).acceptGraduationWord();
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        ItemReveal memory none;
        for (uint256 t = 1; t <= 5; ++t) {
            vm.prank(t <= 3 ? alice : bob);
            items.push(BoxTickets(a.tickets).open(t, none));
        }
    }

    function _takeTickets(address who, uint256 n) internal {
        vm.startPrank(who);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        BoxTickets(a.tickets).take(n, type(uint256).max, block.timestamp);
        vm.stopPrank();
    }

    // ============================================================================================================
    // Invariants

    function invariant_moduleLedgersAreExactlyItsClaims() public view {
        _moduleLedgers();
    }

    function invariant_moduleFeeNotesWithinTheAllowance() public view {
        _moduleNotes();
    }

    function invariant_receiverClaimsCoverItsLedgers() public view {
        _receivers();
    }

    function invariant_hookDepthBudgetIsExactlyItsClaims() public view {
        _hooks();
    }

    function invariant_streamCoversWhatOwnersAccrued() public {
        _stream();
    }

    function invariant_tokenSupplyPlusBurnsIsTheIssuance() public view {
        _supplies();
    }

    function invariant_platformNeverAboveItsCap() public view {
        _platform();
    }

    function invariant_nothingBlocksCollectGraduateOrASkip() public view {
        _nothingBlocked();
    }

    function afterInvariant() external view {
        console.log("calls", h.calls(), "collects", h.collects());
        console.log("steps", h.steps(), "skips", h.stepSkips());
        console.log("deepen pairs", h.pairs(), "conversions alone", h.converts());
        console.log("executes", h.executes(), "payouts", h.payouts());
        console.log("stream claims", h.claims(), "Misfit transfers", h.transfers());
        console.log("graduations of D", h.graduations());
    }

    // ============================================================================================================
    // Scripted runs

    /// BC-141 (the run the case left to S5.M4): every box's full life, D's graduation included, with the module's four
    /// steps, deepen()'s conversions and pairs, FIT's executor, 300 ETH of box 0 fees an epoch (its cap reached, the
    /// excess into its pool), every payout, stream claims and Misfit transfers, over three 30-day epochs; every check
    /// above after each epoch, and the Safe's ETH rising only in payPlatform, by at most 32 ETH an epoch.
    function test_BC141_everyBoxsLifeWithModuleStepsAndConversionsOverThreeEpochs() public {
        uint256 safe0 = k.factory().platformSafe().balance;
        for (uint256 e; e < 3; ++e) {
            _epoch(e);
            _checkAll();
            h.jump(30 days);
        }
        assertGe(h.steps(), 8, "the module stepped (every action, every epoch)");
        assertGt(h.converts() + h.pairs(), 0, "deepen converted or paired");
        assertGt(h.executes(), 0, "FIT's executor bought");
        assertEq(h.graduations(), 1, "D graduated inside the run");
        assertGe(h.maxEpoch(), 2, "three epochs");
        // Box 0 graduated a month before the run (setUp), so the run's payments span epochs 0 (its settlement's credit)
        // to maxEpoch: at most 32 ETH each.
        uint256 paid = k.factory().platformSafe().balance - safe0;
        assertLe(paid, (h.maxEpoch() + 1) * BoxSpecV1.PLATFORM_CAP_WEI, "the Safe: at most 32 ETH an epoch");
        assertGt(paid, 2 * BoxSpecV1.PLATFORM_CAP_WEI, "the cap reached in the run's epochs");
    }

    function _epoch(uint256 e) internal {
        if (e == 0) {
            h.graduateD();
            h.hold(400);
        }
        for (uint256 r; r < 3; ++r) {
            h.buy(r, 0.3 ether);
            h.sell(r, 100);
        }
        h.hold(400);
        for (uint256 r; r < 3; ++r) {
            h.collect(r);
        }
        h.step(0, 1);
        h.hold(10);
        h.step(0, 3);
        h.step(1, 2);
        h.hold(10);
        h.step(1, 4);
        for (uint256 r; r < 3; ++r) {
            h.deepen(r);
        }
        h.execute(1);
        h.fundFees(0, 300 ether);
        h.pay(0, 1);
        h.pay(0, 0);
        h.pay(1, 0);
        h.pay(2, 2);
        h.claimStream(0);
        h.transferMisfit(e, 2);
        h.royalty(e, 0.5 ether);
    }

    /// BC-132 with the real module beside a converting hook (the check the case left to S5.M4): a deepen() that pairs
    /// mints the pair's fees to the receiver (the next batch), and a SellForFit step in the same block books FIT's Q
    /// for exactly what its own sale paid (its output less the tip): the hook-minted fees stay unbooked.
    function test_BC132_aRealStepBesideAPairsPokeBooksOnlyItsOwnProceeds() public {
        h.graduateD();
        h.hold(400);
        S5M4Kit.StdBox memory x = _std(D);
        _trade(x.key, x.token, 2 ether, 3);
        _hold(x.sampler, 300);
        BoxReceiver r = BoxReceiver(payable(x.receiver));
        r.collect(keeper);
        _fundDepthQ(x.receiver, 1 ether);
        _depthT(x.hook, x.token, 3 * BoxHook(x.hook).minAdd());
        _hold(x.sampler, 300);
        // A pair first, so the next deepen's poke has fees to mint.
        (DepthKind k1,,,,) = BoxHook(x.hook).deepen(keeper);
        assertEq(uint256(k1), uint256(DepthKind.Pair), "fixture: a pair");
        _trade(x.key, x.token, 0.5 ether, 2);
        _hold(x.sampler, 301);
        _depthT(x.hook, x.token, 3 * BoxHook(x.hook).minAdd());
        (uint256 fit0, uint256 unbooked0) = (r.fitOwed(), _unbookedQ(r));
        (DepthKind k2, DeepenSkip skip,,,) = BoxHook(x.hook).deepen(keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.None), "fixture: deepen ran");
        assertEq(uint256(k2), uint256(DepthKind.Pair), "fixture: a pair");
        uint256 minted = _unbookedQ(r) - unbooked0;
        assertGt(minted, 0, "fixture: the pair's poke minted fees to the receiver");
        (IBoxSwapModule.Stop stop,, uint256 out, uint256 tip) =
            BoxSwapModule(x.module).step(IBoxSwapModule.Action.SellForFit, keeper);
        assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.None), "fixture: the sale ran in the same block");
        assertEq(r.fitOwed() - fit0, out - tip, "FIT's Q: exactly what the sale paid, less the tip");
        assertEq(_unbookedQ(r), unbooked0 + minted, "the pair's fees stay the next batch's");
        // Every check but the handler's note ghost (this step was called directly, not through the handler).
        _moduleLedgers();
        _receivers();
        _hooks();
        _supplies();
        _nothingBlocked();
    }

    /// BC-130 on the real module (S5.M2's module; the case's own checks used the mock): before D's settlement the
    /// receiver holds the module's ledgers, `sync` hands nothing and a step stops NotGraduated; at the settlement
    /// nothing moves; the first pull after it hands each held ledger less its 1 raw unit.
    function test_BC130_theRealModuleTakesNothingBeforeTheSettlement() public {
        S5M4Kit.StdBox memory x = _std(D);
        BoxReceiver r = BoxReceiver(payable(x.receiver));
        BoxSwapModule m = BoxSwapModule(x.module);
        _fundFees(x.receiver, 1 ether);
        (uint256 qBurn,,,,,, bool held) = r.moduleOwed();
        assertTrue(held, "held before the settlement");
        assertEq(qBurn, (uint256(1 ether) / 15) * 10, "10/15 of the Q to the burn-buy ledger");
        h.sync(0);
        (uint256 mq,,,,) = m.budgets();
        assertEq(mq, 0, "nothing handed before the settlement");
        uint256 skips = h.stepSkips();
        h.step(0, 1);
        assertEq(h.stepSkips(), skips + 1, "a step stops (NotGraduated)");
        assertEq(h.steps(), 0, "no step ran");
        h.graduateD();
        assertTrue(r.graduationSettled(), "the graduation poke settled the receiver");
        assertEq(_claims(x.module, address(0)), 0, "the settlement moved nothing to the module");
        (uint256 owedQ,,,,,,) = r.moduleOwed();
        h.sync(0);
        (mq,,,,) = m.budgets();
        assertEq(mq, owedQ - 1, "the first pull: the held ledger less its 1 raw unit");
        assertEq(_claims(x.module, address(0)), mq, "as claims");
        _checkAll();
    }

    function _unbookedQ(BoxReceiver r) internal view returns (uint256) {
        (uint256 qb,) = r.booked();
        return _claims(address(r), address(0)) - qb;
    }

    function _fundDepthQ(address receiver, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        BoxReceiver(payable(receiver)).fundDepth{value: q}();
    }

    /// The hook's T side raised to at least `qValueWei` worth at 10^8 T per Q (above the price here: about 5 × 10^7 T
    /// per ETH at P1), from the T the handler bought when it closed D's curve.
    function _depthT(address hook, address token, uint256 qValueWei) internal {
        (, uint256 have) = BoxHook(hook).depthBudget();
        uint256 want = qValueWei * 100_000_000;
        if (have >= want) return;
        uint256 give = want - have;
        uint256 bal = BoxToken(token).balanceOf(address(h));
        if (give > bal / 4) give = bal / 4;
        vm.prank(address(h));
        BoxToken(token).transfer(bob, give);
        funder.deposit(token, bob, give, hook);
    }

    // ============================================================================================================
    // The checks (shared with the scripted runs)

    function _moduleLedgers() internal view {
        for (uint256 i; i < 2; ++i) {
            S5M4Kit.StdBox memory x = _std(i);
            (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 tBurn) =
                BoxSwapModule(x.module).budgets();
            assertEq(qBurn + qCreator, _claims(x.module, address(0)), "module: Q ledgers == its Q claims");
            assertEq(tForFit + tForCreator, _claims(x.module, x.token), "module: T ledgers == its T claims");
            assertEq(tBurn, BoxToken(x.token).balanceOf(x.module), "module: T to burn == its T balance");
            assertEq(x.module.balance, 0, "module: no ETH");
        }
    }

    function _moduleNotes() internal view {
        for (uint256 i; i < 2; ++i) {
            S5M4Kit.StdBox memory x = _std(i);
            assertLe(h.notedQ(i), h.handedQ(i) * BoxSpecV1.LP_FEE / 1_000_000, "notes <= 1% of the Q handed");
            assertLe(h.notedT(i), h.handedT(i) * BoxSpecV1.LP_FEE / 1_000_000, "notes <= 1% of the T handed");
            (uint256 aq, uint256 at) = BoxReceiver(payable(x.receiver)).moduleFeeAllowance();
            assertEq(aq, h.allowanceQ(i), "allowance Q == handed x 1% - notes");
            assertEq(at, h.allowanceT(i), "allowance T == handed x 1% - notes");
        }
    }

    function _receivers() internal view {
        address[3] memory rs = [a.receiver, _std(D).receiver, _std(C).receiver];
        address[3] memory ts = [a.token, _std(D).token, _std(C).token];
        for (uint256 i; i < 3; ++i) {
            BoxReceiver r = BoxReceiver(payable(rs[i]));
            (uint256 qb, uint256 tb) = r.booked();
            assertGe(_claims(rs[i], address(0)), qb, "receiver: Q claims >= Q ledgers");
            assertGe(_claims(rs[i], ts[i]), tb, "receiver: T claims >= T ledgers");
            assertGe(BoxToken(ts[i]).balanceOf(rs[i]), r.tBurnPending(), "receiver: the T to burn is held");
            (uint256 qc, uint256 tc) = r.carried();
            assertLt(qc, 15, "receiver: Q carry below one fifteenth");
            assertLt(tc, 15, "receiver: T carry below one fifteenth");
            assertEq(rs[i].balance, 0, "receiver: no ETH between calls");
        }
    }

    function _hooks() internal view {
        address[3] memory hs = [a.hook, _std(D).hook, _std(C).hook];
        address[3] memory ts = [a.token, _std(D).token, _std(C).token];
        for (uint256 i; i < 3; ++i) {
            BoxHook hk = BoxHook(hs[i]);
            (uint256 q, uint256 t) = hk.depthBudget();
            assertEq(q, _claims(hs[i], address(0)), "hook: Q depth == its Q claims");
            assertEq(t, _claims(hs[i], ts[i]), "hook: T depth == its T claims");
            assertEq(hs[i].balance, 0, "hook: no ETH");
            assertEq(BoxToken(ts[i]).balanceOf(hs[i]), 0, "hook: no T");
            assertLe(hk.reserveMinted(), hk.reserveCap(), "hook: the reserve within its cap");
        }
    }

    /// The stream's value counts 13/15 of the T fees still in box 0's positions (SH-S8-stream), so what owners accrued is
    /// held once the next batch arrives: in a snapshot, a valid `collect()` (0.01 ETH of Q claims added so it meets the
    /// minimum), then the stream's T covers every owner's accrual not yet paid (BC-065, BC-139).
    function _stream() internal {
        uint256 snap = vm.snapshotState();
        vm.deal(address(this), address(this).balance + 0.01 ether);
        minter.mintTo{value: 0.01 ether}(a.receiver);
        BoxReceiver(payable(a.receiver)).collect(keeper);
        BoxItemStream st = BoxItemStream(a.itemStream);
        uint256 held = BoxToken(a.token).balanceOf(a.itemStream);
        uint256 owed = st.liabilities();
        vm.revertToState(snap);
        assertGe(held, owed, "stream: owners' accrual is held once the batch arrives");
    }

    function _supplies() internal view {
        address[3] memory ts = [a.token, _std(D).token, _std(C).token];
        for (uint256 i; i < 3; ++i) {
            BoxToken t = BoxToken(ts[i]);
            assertEq(t.totalSupply() + t.totalBurned(), BoxSpecV1.ISSUANCE, "T: supply + burns == issuance");
        }
    }

    function _platform() internal view {
        for (uint256 e; e <= h.maxEpoch(); ++e) {
            assertLe(h.keptInEpoch(e), BoxSpecV1.PLATFORM_CAP_WEI, "<= 32 ETH credited per epoch");
        }
        (,, uint256 rem) = BoxReceiver(payable(a.receiver)).platformEpoch();
        assertLe(rem, BoxSpecV1.PLATFORM_CAP_WEI);
        assertEq(h.safeMovedElsewhere(), 0, "the Safe's ETH moves only in payPlatform, by what it paid");
        for (uint256 i; i < 2; ++i) {
            assertEq(BoxReceiver(payable(_std(i).receiver)).platformOwed(), 0, "no other box credits a platform");
        }
    }

    function _nothingBlocked() internal view {
        assertEq(h.collectBlocked(), 0, "collect refused only below the minimum");
        assertEq(h.graduateBlocked(), 0, "graduate never refused once closed");
        assertEq(h.stepReverted(), 0, "steps, sync and burnPending skip, never revert");
        assertEq(h.deepenReverted(), 0, "deepen skips, never reverts");
        assertEq(h.executeReverted(), 0, "FIT's execute skips, never reverts");
        assertEq(h.claimReverted(), 0, "an owner's stream claim never reverts");
    }

    function _checkAll() internal {
        _moduleLedgers();
        _moduleNotes();
        _receivers();
        _hooks();
        _stream();
        _supplies();
        _platform();
        _nothingBlocked();
    }
}
