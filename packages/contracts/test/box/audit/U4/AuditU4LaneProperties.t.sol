// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {AuditU4LaneBase} from "./AuditU4LaneBase.sol";
import {AuditU4LaneHostile, AuditU4LaneStreamProbe, AuditU4LaneStipendPayer} from "./AuditU4LaneCallees.sol";
import {SupplyFloorStandIn, MockWETH} from "../../s45/BoxS45Mocks.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {FeeBatch, ModuleProceedsTo, RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";

/// forge-config: default.evm_version = "osaka"
contract AuditU4LaneProperties is AuditU4LaneBase {
    /// @notice Ticket 16 / BC-114; BoxRoyaltyRouter.sol:52 and IBoxRoyaltyRouter.sol:10-11,25.
    /// Expected: receipt of 1 wei with arbitrary calldata succeeds. Observed: unknown selector reverts.
    /// Steps/amounts: factory creates box 0; pay 1 wei with deadbeef. Router and sender balances stay unchanged.
    function test_AUDIT_U4_51_royaltyNonemptyCalldataRefused() public {
        uint256 before = a.royaltyRouter.balance;
        (bool ok, bytes memory data) = a.royaltyRouter.call{value: 1}(hex"deadbeef");
        assertFalse(ok);
        assertEq(data.length, 0);
        assertEq(a.royaltyRouter.balance, before);
        // The exact same value without calldata is accepted.
        (ok,) = a.royaltyRouter.call{value: 1}("");
        assertTrue(ok);
        assertEq(a.royaltyRouter.balance, before + 1);
    }

    /// @notice BC-100, BC-109, F64/F65/F77: factory initialization gives box 0 no creator or swap module.
    function testProperty_AUDIT_U4_initialWiringAndEmptyLedgers() public view {
        assertEq(r.swapModule(), address(0));
        assertEq(r.creatorPayee(), address(0));
        assertEq(r.pendingCreatorPayee(), address(0));
        assertEq(r.coordinator(), a.coordinator);
        assertEq(r.platformSafe(), BoxSpecV1.PLATFORM_SAFE_MAINNET);
        assertEq(royalty.receiver(), a.receiver);
        assertEq(royalty.coordinator(), a.coordinator);
        assertEq(royalty.weth(), a.weth);
        assertEq(uint256(royalty.destination()), uint256(RoyaltyDestination.FeeHandling));
        (uint256 q, uint256 t) = r.booked();
        assertEq(q | t, 0);
        _noModule();
        _balanced();
    }

    /// @notice F77, BC-015/020/106/118: exact pregraduation Q fifteenths, carry and held depth.
    function testFuzz_AUDIT_U4_manyBatchesCarry(uint256 seed) public {
        uint256 sum;
        for (uint256 i; i < 48; ++i) {
            uint256 amount = uint256(keccak256(abi.encode(seed, i))) % 4 ether + 1;
            r.fundFees{value: amount}();
            sum += amount;
            (uint256 carry,) = r.carried();
            (uint256 dq,) = r.depthHeld();
            assertEq(r.fitOwed() + r.platformHeld() + dq + carry, sum, "conservation after each batch");
            assertEq(r.fitOwed(), sum / 15 * 11);
            assertEq(dq, sum / 15 * 2);
            assertEq(r.platformHeld(), dq);
            // Compare rational exact shares without rounding the reference down first.
            assertLe(sum * 11 - r.fitOwed() * 15, 14 * 15);
            assertLe(sum * 2 - dq * 15, 14 * 15);
            _balanced();
        }
        assertEq(a.executor.balance, 0);
        assertEq(a.platform.balance, 0);
    }

    /// @notice BC-017, F77, interface conservation including both carried remainders and the actual tip.
    function testFuzz_AUDIT_U4_collectBothAssets(uint96 qSeed, uint96 tSeed) public {
        _closed();
        uint256 q = bound(qSeed, 0.005 ether, 200 ether);
        uint256 t = bound(tSeed, 0, 1e22);
        _assertBatch(q, t, false);
        _assertBatch(q + 14, t + 14, false);
    }

    struct BatchStart {
        Totals totals;
        uint256 qc;
        uint256 tc;
        uint256 held;
        uint256 pending;
        uint256 supply;
        uint256 stream;
        uint256 tip;
    }

    function _assertBatch(uint256 q, uint256 t, bool graduated) internal {
        BatchStart memory x;
        x.totals = _totals();
        (x.qc, x.tc) = r.carried();
        x.held = r.platformHeld();
        x.pending = r.tBurnPending();
        x.supply = token.totalSupply();
        x.stream = token.balanceOf(a.itemStream);
        x.tip = tipper.balance;
        _q(q);
        _t(t);
        FeeBatch memory b = r.collect(tipper);
        Totals memory after_ = _totals();
        (uint256 qc1, uint256 tc1) = r.carried();
        assertEq(b.q, q);
        assertEq(b.t, t);
        assertEq(b.qToReserve, 0, "closed fixture already filled the reserve");
        assertEq(b.tip, q / 10 < 0.0005 ether ? q / 10 : 0.0005 ether);
        assertEq(tipper.balance - x.tip, b.tip);
        assertEq(after_.fit - x.totals.fit, (q - b.tip + x.qc) / 15 * 11);
        uint256 dq = after_.depthQ - x.totals.depthQ;
        uint256 p = after_.platform - x.totals.platform + r.platformHeld() - x.held;
        assertEq(after_.fit - x.totals.fit + dq + p + b.tip + qc1, q + x.qc);
        assertEq(after_.depthT - x.totals.depthT, (t + x.tc) / 15 * 2);
        uint256 burn = after_.burned - x.totals.burned + r.tBurnPending() - x.pending;
        if (!graduated) {
            assertEq(burn, (t + x.tc) / 15 * 13);
            assertEq(x.supply - token.totalSupply(), after_.burned - x.totals.burned);
        } else {
            // The real stream may burn its zero-outside portion; include that supply reduction.
            burn += token.balanceOf(a.itemStream) - x.stream + x.supply - token.totalSupply();
        }
        assertEq(after_.depthT - x.totals.depthT + burn + tc1, t + x.tc);
        _balanced();
        (uint256 qb, uint256 tb) = r.booked();
        assertEq(pm.balanceOf(a.receiver, 0), qb, "no Q next batch left");
        assertEq(pm.balanceOf(a.receiver, uint256(uint160(a.token))), tb, "no T next batch left");
    }

    /// @notice F77 / BC-139: graduated T reaches the actual stream and Q remains in claims until payout.
    function testProperty_AUDIT_U4_postGraduationBatch() public {
        _graduate();
        _assertBatch(0.015 ether + 7, 1e20 + 11, true);
    }

    /// @notice BC-017, D6: a real curve buy and sale fill the reserve before tip and split, all to the wei.
    function testProperty_AUDIT_U4_realCurveReserveAndBatch() public {
        // toBonding includes real buys, a sale and a receiver collect; inspect its emitted accounting.
        vm.recordLogs();
        kit.toBonding();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 gross;
        uint256 reserve;
        uint256 tip;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.Collected.selector) {
                (, gross,, reserve, tip) = abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256));
            }
        }
        assertGt(reserve, 0);
        assertEq(pm.balanceOf(a.coordinator, 0), reserve);
        Totals memory t = _totals();
        (uint256 carry,) = r.carried();
        assertEq(t.fit + t.depthQ + r.platformHeld() + carry + tip + reserve, gross);
        assertEq(tip, (gross - reserve) / 10 < r.tipMax() ? (gross - reserve) / 10 : r.tipMax());
        _balanced();
    }

    /// @notice BC-016/139. Stand-in only for a vault refusing a burn: debt stays in real T, then burns once.
    function testProperty_AUDIT_U4_refusedBurnWaitsAndRetries() public {
        _closed();
        SupplyFloorStandIn floor = new SupplyFloorStandIn();
        vm.etch(a.vault, address(floor).code);
        SupplyFloorStandIn(a.vault).setFloor(type(uint256).max);
        (, uint256 carry) = r.carried();
        uint256 t = 150 - carry;
        _q(0.01 ether);
        _t(t);
        uint256 supply = token.totalSupply();
        r.collect(tipper);
        assertEq(r.tBurnPending(), 130);
        assertEq(token.balanceOf(a.receiver), 130);
        assertEq(token.totalSupply(), supply);
        _balanced();
        SupplyFloorStandIn(a.vault).setFloor(0);
        _q(0.01 ether);
        r.collect(tipper);
        assertEq(r.tBurnPending(), 0);
        assertEq(supply - token.totalSupply(), 130);
        _balanced();
    }

    /// @notice BC-017: minimum minus one reverts atomically, exact minimum and minimum plus one pay capped tip.
    function testProperty_AUDIT_U4_minimumBoundary() public {
        _closed();
        _q(r.batchMin() - 1);
        (uint256 qb,) = r.booked();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.BatchTooSmall.selector, r.batchMin() - 1, r.batchMin()));
        r.collect(tipper);
        assertEq(pm.balanceOf(a.receiver, 0), qb + r.batchMin() - 1);
        _q(1);
        assertEq(r.collect(tipper).tip, 0.0005 ether);
        _q(r.batchMin() + 1);
        assertEq(r.collect(tipper).tip, 0.0005 ether);
        _balanced();
    }

    /// @notice BC-020/021/108: before settlement no FIT/platform payout; after, exact owed -> fixed sinks.
    function testProperty_AUDIT_U4_payoutsExactAndOnce() public {
        _closed();
        r.fundFees{value: 15 ether}();
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        r.payFit();
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        r.payPlatform();
        assertEq(a.executor.balance, 0);
        assertEq(a.platform.balance, 0);
        coordinator.graduate();
        uint256 fit = r.fitOwed();
        uint256 owed = r.platformOwed();
        uint256 budget = FitBuybackExecutor(payable(a.executor)).budget();
        uint256 safe = a.platform.balance;
        vm.prank(address(0x1234));
        assertEq(r.payFit(), fit);
        vm.prank(address(0x5678));
        assertEq(r.payPlatform(), owed);
        assertEq(FitBuybackExecutor(payable(a.executor)).budget() - budget, fit);
        assertEq(a.platform.balance - safe, owed);
        assertEq(r.fitOwed() | r.platformOwed(), 0);
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        r.payFit();
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        r.payPlatform();
        _balanced();
    }

    /// @notice BC-107: unsolicited ETH cannot contaminate fee ledgers; fundDepth consumes only ETH, all else claims.
    function testFuzz_AUDIT_U4_forcedEthSeparated(uint96 seed, bool graduated) public {
        if (graduated) _graduate();
        else _closed();
        uint256 forced = bound(seed, 1, 10 ether);
        uint256 fit = r.fitOwed();
        uint256 p = r.platformOwed() + r.platformHeld();
        vm.deal(a.receiver, forced);
        r.fundFees{value: 15}();
        assertEq(a.receiver.balance, forced);
        assertEq(r.fitOwed(), fit + 11);
        assertEq(r.platformOwed() + r.platformHeld(), p + 2);
        uint256 depth = _totals().depthQ;
        r.fundDepth{value: 7}();
        assertEq(a.receiver.balance, 0);
        assertEq(_totals().depthQ - depth, forced + 7);
        assertEq(r.fitOwed(), fit + 11);
        assertEq(r.platformOwed() + r.platformHeld(), p + 2);
        _balanced();
    }

    /// @notice BC-114/115/107, F65. WETH is CoreBox0Kit's stand-in; receiver and coordinator are factory contracts.
    function testProperty_AUDIT_U4_royaltyStipendFlushSweepAndGate() public {
        AuditU4LaneStipendPayer payer = new AuditU4LaneStipendPayer();
        vm.deal(address(payer), 1 ether);
        vm.record();
        payer.pay(payable(a.royaltyRouter), 1 ether);
        payer.pay(payable(a.royaltyRouter), 0);
        (, bytes32[] memory writes) = vm.accesses(a.royaltyRouter);
        assertEq(writes.length, 0);
        MockWETH weth = MockWETH(a.weth);
        weth.deposit{value: 2 ether}();
        weth.transfer(a.royaltyRouter, 2 ether);
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royalty.flush();
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royalty.sweep(a.weth);
        assertEq(a.royaltyRouter.balance, 1 ether);
        assertEq(weth.balanceOf(a.royaltyRouter), 2 ether);
        _graduate();
        uint256 fit = r.fitOwed();
        uint256 safe = a.platform.balance;
        vm.expectCall(a.receiver, 3 ether, abi.encodeCall(IBoxReceiver.fundFees, ()), 1);
        assertEq(royalty.flush(), 3 ether);
        assertEq(r.fitOwed() - fit, 2.2 ether);
        assertEq(a.platform.balance, safe, "never pays Safe directly");
        assertEq(a.royaltyRouter.balance | weth.balanceOf(a.royaltyRouter), 0);
        weth.deposit{value: 15}();
        weth.transfer(a.royaltyRouter, 15);
        // The preceding flush already pins the sole selector; this sweep pins amount and books.
        assertEq(royalty.sweep(a.weth), 15);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, a.token));
        royalty.sweep(a.token);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, address(0)));
        royalty.sweep(address(0));
        _balanced();
    }

    /// @notice BC-100/130: none of the special callers (including zero) can activate box 0's absent module/payee.
    function testFuzz_AUDIT_U4_dormantCreatorAndModule(address arbitrary, bool graduated) public {
        if (graduated) _graduate();
        address[7] memory callers = [arbitrary, a.hook, a.executor, a.coordinator, a.itemStream, address(0), a.platform];
        for (uint256 i; i < callers.length; ++i) {
            address who = callers[i];
            vm.startPrank(who);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, who));
            r.pullForModule();
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, who));
            r.moduleProceeds(ModuleProceedsTo.FitQ, 0);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, who));
            r.claimCreator(who);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, who));
            r.proposeCreatorPayee(who);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPendingPayee.selector, who));
            r.acceptCreatorPayee();
            vm.expectRevert(IBoxReceiver.NotCreatorRoyalties.selector);
            r.fundCreator();
            vm.stopPrank();
        }
        _noModule();
        _balanced();
    }

    function _noModule() internal view {
        (uint256 q, uint256 c, uint256 t, uint256 tc, uint256 qb, uint256 tb,) = r.moduleOwed();
        assertEq(q | c | t | tc | qb | tb, 0);
        (q, t) = r.moduleFeeAllowance();
        assertEq(q | t, 0);
        (q, t) = r.creatorOwed();
        assertEq(q | t, 0);
        (q, t) = r.creatorHeld();
        assertEq(q | t, 0);
    }

    /// @notice BC-019/133, accepted access review: box0 executor notes are unbounded; hook Q-only, no allowance.
    function testProperty_AUDIT_U4_notesAuthorityAndReturnFirst() public {
        _closed();
        vm.prank(a.executor);
        r.noteModuleFees(31, 11);
        vm.prank(a.hook);
        r.noteModuleFees(100, 7);
        assertEq(r.hookFeesPending(), 100);
        (uint256 q, uint256 t) = r.moduleFeesPending();
        assertEq(q, 31);
        assertEq(t, 11);
        vm.prank(tipper);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, tipper));
        r.noteModuleFees(1, 1);
        uint256 fit = r.fitOwed();
        uint256 hookQ = pm.balanceOf(a.hook, 0);
        (uint256 carry,) = r.carried();
        _q(0.015 ether + 131);
        FeeBatch memory b = r.collect(tipper);
        assertEq(r.fitOwed() - fit, 31 + (b.q - 131 - b.tip + carry) / 15 * 11);
        assertEq(pm.balanceOf(a.hook, 0) - hookQ, 100);
        (q, t) = r.moduleFeesPending();
        assertEq(q, 0);
        assertEq(t, 11, "executor T notes are not returned on box0; production executor notes Q only");
        assertEq(r.hookFeesPending(), 0);
        _noModule();
        _balanced();
    }

    /// @notice BC-106, F62: withheld payouts preserve old credits; cap applies to allocation, not withdrawal time.
    function testProperty_AUDIT_U4_epochEdgesAndAccumulatedPayouts() public {
        _graduate();
        uint256 g = coordinator.graduatedAt();
        uint256 cap = r.PLATFORM_CAP_WEI();
        r.fundFees{value: 300 ether}();
        uint256 owed = r.platformOwed();
        assertEq(owed, cap);
        vm.warp(g + 30 days - 1);
        r.fundFees{value: 300 ether}();
        assertEq(r.platformOwed(), owed);
        vm.warp(g + 30 days);
        r.fundFees{value: 300 ether}();
        assertEq(r.platformOwed(), 2 * cap);
        vm.warp(g + 30 days + 1);
        r.fundFees{value: 300 ether}();
        assertEq(r.platformOwed(), 2 * cap);
        assertEq(r.payPlatform(), 2 * cap, "two epochs' credits withdrawn together");
        (uint256 e, uint256 kept, uint256 room) = r.platformEpoch();
        assertEq(e, 1);
        assertEq(kept, cap);
        assertEq(room, 0);
        _balanced();
    }

    /// @notice BC-106/107: actual coordinator forwards gifted claims; failed poke simulated, later settlement epoch 0.
    function testProperty_AUDIT_U4_lateSettlementAndForwardedClaims() public {
        _closed();
        r.fundFees{value: 300 ether}();
        minter.mintTo{value: 300 ether}(a.coordinator);
        vm.mockCallRevert(a.receiver, abi.encodeCall(IBoxReceiver.onGraduation, ()), hex"01");
        coordinator.graduate();
        vm.clearMockedCalls();
        assertFalse(r.graduationSettled());
        vm.warp(coordinator.graduatedAt() + 60 days + 1);
        vm.recordLogs();
        r.onGraduation();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 credited;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.PlatformCredited.selector) {
                assertEq(uint256(logs[i].topics[1]), 0, "late settlement charged to epoch zero");
                (uint256 credit,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                credited += credit;
            }
        }
        assertEq(credited, 32 ether);
        (uint256 e, uint256 kept, uint256 room) = r.platformEpoch();
        assertEq(e, 2);
        assertEq(kept, 0);
        assertEq(room, 32 ether);
        r.fundFees{value: 300 ether}();
        assertEq(r.platformOwed(), 64 ether);
        vm.expectRevert(IBoxReceiver.AlreadySettled.selector);
        r.onGraduation();
        _balanced();
    }

    /// @notice BC-100/020: premature graduation and plain ETH (even from PM outside unlock) refuse atomically.
    function testProperty_AUDIT_U4_graduationAndReceiveGuards() public {
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        r.onGraduation();
        address[5] memory who = [address(this), a.poolManager, a.executor, a.coordinator, a.hook];
        for (uint256 i; i < who.length; ++i) {
            vm.prank(who[i]);
            (bool ok, bytes memory data) = a.receiver.call("");
            assertFalse(ok);
            assertEq(data, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, who[i]));
            vm.prank(who[i]);
            vm.expectRevert(IBoxReceiver.NotPoolManager.selector);
            r.unlockCallback("");
        }
        _balanced();
    }

    /// @notice One real hot-half collect invokes a hostile stream probing both halves. Cold guarded functions
    /// make no external call, hence have no reachable reverse-direction callback. No receiver code is replaced.
    function testProperty_AUDIT_U4_sharedLockBothHalves() public {
        _graduate();
        AuditU4LaneStreamProbe probe = new AuditU4LaneStreamProbe(a.receiver);
        vm.etch(a.itemStream, address(probe).code);
        _q(0.01 ether);
        _t(150);
        vm.recordLogs();
        r.collect(tipper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.itemStream) continue;
            (uint256 gasIn, uint256 amount, bytes memory hot, bytes memory cold, bytes memory note) =
                abi.decode(logs[i].data, (uint256, uint256, bytes, bytes, bytes));
            assertLe(gasIn, 200_000);
            assertGt(gasIn, 190_000);
            assertEq(amount, 130);
            assertEq(hot, abi.encodeWithSelector(bytes4(0xab143c06)));
            assertEq(cold, hot);
            assertEq(note, hot);
            seen = true;
        }
        assertTrue(seen, "callee executed and tested both halves");
        _balanced();
    }

    /// @notice BC-059: triggering custody work from executor and stranger gives byte-identical books/balances.
    function testProperty_AUDIT_U4_permissionlessProgressMatchesExecutor() public {
        _graduate();
        _q(0.01 ether);
        uint256 snap = vm.snapshotState();
        bytes32 executorState = _progress(a.executor);
        assertTrue(vm.revertToState(snap));
        assertEq(_progress(address(0xabcde)), executorState);
    }

    function _progress(address caller) internal returns (bytes32) {
        vm.deal(caller, caller.balance + 30);
        vm.startPrank(caller);
        r.collect(tipper);
        r.fundFees{value: 15}();
        r.fundDepth{value: 15}();
        r.payFit();
        r.payPlatform();
        vm.stopPrank();
        _balanced();
        (uint256 q, uint256 t) = r.booked();
        return keccak256(
            abi.encode(
                _totals(),
                q,
                t,
                a.platform.balance,
                FitBuybackExecutor(payable(a.executor)).budget(),
                pm.balanceOf(a.hook, 0)
            )
        );
    }

    /// @notice Ticket 18: each uint128 ledger and cumulative total must stay <= 2^128-1 for the lifetime.
    /// Synthetic edge state only (vm.store backed by real Q claims), no changed production code or token supply.
    /// At max-11, a 15-wei batch reaches max; another 15-wei batch panics and rolls back every credit/deposit.
    function testProperty_AUDIT_U4_uint128LedgerEdgeIsAtomic() public {
        uint256 near = uint256(type(uint128).max) - 11;
        vm.deal(address(this), near + 100);
        _q(near / 2);
        _q(near - near / 2);
        vm.store(a.receiver, bytes32(uint256(1)), bytes32(near)); // _l.fitOwed, platformOwed=0
        vm.store(a.receiver, bytes32(uint256(9)), bytes32(near)); // _t.toFit, toPlatform=0
        r.fundFees{value: 15}();
        assertEq(r.fitOwed(), type(uint128).max);
        uint256 claims = pm.balanceOf(a.receiver, 0);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        r.fundFees{value: 15}();
        assertEq(pm.balanceOf(a.receiver, 0), claims);
        assertEq(r.fitOwed(), type(uint128).max);
        _balanced();
    }

    // W1-U4-1, accepted as built (FQ-07, F147): the cap is exact for 2^32 epochs, now stated in the NatSpec.
    /// @notice Ticket 18 / BC-106, F62; BoxReceiverBase.sol:40-47 and BoxReceiver.sol:755-766.
    /// Expected: at most 32 ETH credited in any epoch. Observed: epoch 2^32 is not retained in 32 bits;
    /// the next batch resets the cap again. Steps: graduate; warp to g + 2^32 * 30 days; fundFees twice,
    /// 300 ETH each. Amounts: 64 ETH newly owed in the same epoch (32 ETH each time), not 32 ETH.
    function testAccepted_AUDIT_U4_52_epochCounterWrapResetsCapPerBatch() public {
        _graduate();
        vm.warp(coordinator.graduatedAt() + (uint256(1) << 32) * 30 days);
        uint256 before = r.platformOwed();
        r.fundFees{value: 300 ether}();
        r.fundFees{value: 300 ether}();
        assertEq(r.platformOwed() - before, 64 ether);
        (uint256 epoch, uint256 kept, uint256 room) = r.platformEpoch();
        assertEq(epoch, uint256(1) << 32);
        assertEq(kept, 0);
        assertEq(room, 32 ether);
        _balanced();
    }

    /// @notice Ticket 12/13, IBoxReceiver.sol:31-34,56-57 (BC-017/021), BoxReceiver.sol:938-955.
    /// Expected: only the hostile tip payout fails and a >=0.005 ETH batch still completes.
    /// Observed: PoolManager.take to the refusing tipper reverts the whole collect. Steps/amounts:
    /// closed factory box; add 0.01 ETH Q claims; collect to a rejecting stand-in with 1,000,000 gas.
    /// All claims stay and a retry to an EOA succeeds. This is caller-local liveness, not loss of funds.
    function test_AUDIT_U4_53_hostileTipRevertsWholeCollect() public {
        _closed();
        AuditU4LaneHostile hostile = new AuditU4LaneHostile(false);
        _q(0.01 ether);
        uint256 claims = pm.balanceOf(a.receiver, 0);
        bytes32 totals = keccak256(abi.encode(_totals()));
        (bool ok,) = a.receiver.call{gas: 1_000_000}(abi.encodeCall(IBoxReceiver.collect, (address(hostile))));
        assertFalse(ok);
        assertEq(pm.balanceOf(a.receiver, 0), claims);
        assertEq(keccak256(abi.encode(_totals())), totals);
        assertEq(r.collect(tipper).q, 0.01 ether);
        _balanced();
    }

    /// @notice F77 / interface invariant: T fifteenths carry over 32 independently sized batches, <=14 wei error.
    function testFuzz_AUDIT_U4_manyTBatchRemainders(uint256 seed) public {
        _closed();
        (, uint256 sum) = r.carried();
        Totals memory before = _totals();
        for (uint256 i; i < 32; ++i) {
            uint256 t = uint256(keccak256(abi.encode(seed, i))) % 1e20;
            sum += t;
            _assertBatch(0.01 ether, t, false);
        }
        Totals memory after_ = _totals();
        uint256 burned = after_.burned - before.burned;
        uint256 depth = after_.depthT - before.depthT;
        assertEq(burned, sum / 15 * 13);
        assertEq(depth, sum / 15 * 2);
        assertLe(sum * 13 - burned * 15, 14 * 15);
        assertLe(sum * 2 - depth * 15, 14 * 15);
    }

    /// @notice Ticket 18: epoch 2^32-1 still retains its cap; proof 52 pins the first unsupported epoch.
    function testProperty_AUDIT_U4_lastRepresentableEpoch() public {
        _graduate();
        vm.warp(coordinator.graduatedAt() + uint256(type(uint32).max) * 30 days);
        uint256 before = r.platformOwed();
        r.fundFees{value: 300 ether}();
        r.fundFees{value: 300 ether}();
        assertEq(r.platformOwed() - before, 32 ether);
        (uint256 epoch, uint256 kept, uint256 room) = r.platformEpoch();
        assertEq(epoch, type(uint32).max);
        assertEq(kept, 32 ether);
        assertEq(room, 0);
        _balanced();
    }

    /// @notice BC-059/106: a stranger's payout retries the same delayed settlement as the executor's payout.
    function testProperty_AUDIT_U4_anyoneRetriesSettlement() public {
        _closed();
        r.fundFees{value: 15 ether}();
        vm.mockCallRevert(a.receiver, abi.encodeCall(IBoxReceiver.onGraduation, ()), hex"01");
        coordinator.graduate();
        vm.clearMockedCalls();
        assertFalse(r.graduationSettled());
        vm.warp(coordinator.graduatedAt() + 30 days + 1);
        uint256 snap = vm.snapshotState();
        vm.prank(a.executor);
        uint256 fromExecutor = r.payFit();
        assertTrue(r.graduationSettled());
        bytes32 state = keccak256(abi.encode(_totals(), r.fitOwed(), r.platformOwed(), pm.balanceOf(a.receiver, 0)));
        assertTrue(vm.revertToState(snap));
        vm.prank(address(0xabcde));
        assertEq(r.payFit(), fromExecutor);
        assertTrue(r.graduationSettled());
        assertEq(keccak256(abi.encode(_totals(), r.fitOwed(), r.platformOwed(), pm.balanceOf(a.receiver, 0))), state);
        _balanced();
    }
}
