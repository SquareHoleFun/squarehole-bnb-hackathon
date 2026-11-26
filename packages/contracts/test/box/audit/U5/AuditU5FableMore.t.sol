// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {AuditU5FableBase, AuditU5FableExecLogs} from "./AuditU5FableBase.sol";

/// @title AuditU5FableStipendPins
/// @notice SH-AUDIT-B0-U5-F, the ETH-send check of wave 1's measured fact (under Amsterdam a value call to an
/// EIP-7702-delegated EOA leaves about 3,000 gas less than a direct call, so a payment with only the 2,300-gas stipend
/// to such an account fails). Unit U5's ETH sends, enumerated from the code: the executor pays the PoolManager alone
/// (`settle{value}` inside its own unlock, all gas; `FitBuybackExecutor.sol:308-311`), and the stream has no payable
/// function and never holds ETH. No send goes to an address a user chooses or controls, with or without a stipend.
/// The unit's own intake needs more than a stipend: `receive()` takes the transient lock and books the amount
/// (`:208-215`, `:359-363`), so `transfer`/`send` cannot fund the budget; the receiver's `payFit` forwards all gas
/// (`BoxReceiver.sol:325-341`). Run once under Osaka and once under Amsterdam by the two contracts below.
abstract contract AuditU5FableStipendPins is AuditU5FableBase {
    function _stipendPins() internal {
        _toGraduated();
        // (1) Intake: the receiver's full-gas call, a 7702 EOA and a contract (every amount credited whole).
        uint256 fit = _payFit(keeper);
        assertGt(fit, 0, "the FIT share arrived by payFit");
        uint256 credited = executor.totalToBudget();
        _fundBudget(eoa7702, 0.001 ether);
        _fundBudget(address(contractDrawer), 0.001 ether);
        assertEq(executor.totalToBudget(), credited + 0.002 ether);
        // (2) The only outbound ETH: swap input to the PoolManager, from a 7702 caller too; nobody else moves.
        uint256 p0 = address(pm).balance;
        uint256 x0 = a.executor.balance;
        uint256 c0 = eoa7702.balance;
        uint256 r0_ = a.receiver.balance;
        uint256 s0 = a.itemStream.balance;
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa7702, 1);
        assertEq(e.chunks, 1, "a buy by the 7702 EOA");
        assertEq(address(pm).balance - p0, e.ethSpent, "only the PoolManager received ETH");
        assertEq(x0 - a.executor.balance, e.ethSpent, "the executor paid exactly that");
        assertEq(eoa7702.balance, c0, "the caller was not paid");
        assertEq(a.receiver.balance, r0_, "the receiver holds no plain ETH");
        assertEq(a.itemStream.balance, s0, "the stream holds no ETH");
        // (3) A stipend-only payment to the executor fails on this EVM; the least gas that funds it is measured.
        _fund(eoa[1], 100);
        vm.prank(eoa[1]);
        (bool ok,) = a.executor.call{value: 1, gas: 2_300}("");
        assertFalse(ok, "2,300 gas cannot fund the budget (the lock and the booking need more)");
        uint256 least = _leastGasToFund();
        emit log_named_uint("least gas for a value call to the executor's receive()", least);
        assertGt(least, 2_300, "more than a stipend");
        assertLt(least, 60_000, "a plain call funds it");
        // (4) The stream takes no ETH at all, with any gas.
        vm.prank(eoa[1]);
        (ok,) = a.itemStream.call{value: 1}("");
        assertFalse(ok, "the stream has no payable function");
        assertEq(a.itemStream.balance, 0);
        _assertGhostLedger();
    }

    /// @dev Binary search for the least gas a value call to the executor's `receive()` needs here (each attempt from
    /// the same state).
    function _leastGasToFund() internal returns (uint256) {
        uint256 lo = 2_300;
        uint256 hi = 60_000;
        uint256 snap = vm.snapshotState();
        vm.prank(eoa[1]);
        (bool okHi,) = a.executor.call{value: 1, gas: hi}("");
        vm.revertToState(snap);
        require(okHi, "60,000 gas funds the budget");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            snap = vm.snapshotState();
            vm.prank(eoa[1]);
            (bool ok,) = a.executor.call{value: 1, gas: mid}("");
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }
}

/// @title AuditU5FableMoreTest
/// @notice SH-AUDIT-B0-U5-F, the second round of pins on the factory's box 0 (mainnet build, Osaka): the stipend
/// enumeration, the executor's fee report over random budgets, the stream under a protocol fee and at the graduation
/// boundary tick, a terminal-mode hand-back, a self-transfer, the margin after slots leave between a burn and a
/// collect, and an item sent to the stream itself.
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableMoreTest is AuditU5FableStipendPins {
    function _assertXMatches(string memory where) internal view {
        assertEq(_streamXIndependent(), stream.streamValue(), where);
    }

    function _accounts() internal view returns (address[] memory accounts) {
        accounts = new address[](10);
        for (uint256 i; i < 8; ++i) {
            accounts[i] = eoa[i];
        }
        accounts[8] = address(contractDrawer);
        accounts[9] = eoa7702;
    }

    // ================================================================================================ L6, Amsterdam twin below

    function testProperty_AUDIT_U5_noStipendOnlyEthSendInTheUnit() public {
        _stipendPins();
    }

    // ================================================================================================ L1 / L7 executor

    /// REV-16 (BC-019; `FitBuybackExecutor.sol:36-39`, `:262-272`): over random budgets and prices the fee an execution
    /// reports is never above the LP fee its chunk paid the four positions (currency0, by StateLibrary) and stays
    /// within 16 raw units of it; the figure is exactly ethSpent × LP_FEE / 10^6 less the 8-unit slack (fuzz).
    function testFuzz_AUDIT_U5_feeReportLowerBoundOverBudgets(uint256 budget, uint256 push, bool sellSide) public {
        _toGraduated();
        budget = bound(budget, 0.01 ether, 20 ether);
        push = bound(push, 0, 2 ether);
        _fundBudget(eoa[3], budget);
        if (push != 0) {
            if (sellSide) _sell(eoa[2], bound(push, 1, token.balanceOf(eoa[2])));
            else _buy(eoa[2], push);
        }
        _advance(1);
        (uint256 owed0Before,) = _uncollected();
        AuditU5FableExecLogs.ExecLog memory e = _execute(eoa[4], 1);
        (uint256 owed0After,) = _uncollected();
        uint256 earned = owed0After - owed0Before;
        if (e.chunks == 0) {
            assertEq(e.feeReported, 0, "no chunk, no report");
            assertEq(earned, 0, "nothing paid");
            return;
        }
        assertLe(e.feeReported, earned, "reported <= the positions' LP fee");
        assertLe(earned - e.feeReported, 16, "within 16 raw units of it");
        uint256 slack =
            2 * (uint256(uint24(BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS)) / uint256(uint24(BoxSpecV1.TICK_SPACING)) + 4);
        uint256 fee = e.ethSpent * BoxSpecV1.LP_FEE / 1_000_000;
        assertEq(e.feeReported, fee > slack ? fee - slack : 0, "ethSpent x LP_FEE / 1e6 - slack");
        _assertGhostLedger();
    }

    // ================================================================================================ L6 / L1 stream

    /// L6: with a protocol fee on box 0's pool (Uniswap governance may set up to 0.1%, both directions), a sell's T
    /// fee is split by v4 first; the stream's X reads the LP part only (the fee growth), equals the StateLibrary read,
    /// and rises by 13/15 of that part; it stays continuous across the collect.
    function testProperty_AUDIT_U5_streamXUnderAProtocolFeeOnTheTSide() public {
        _toDrawing();
        _setProtocolFee(1_000, 1_000);
        _assertXMatches("after the fee is set");
        uint256 x0 = stream.streamValue();
        (, uint256 u1Before) = _uncollected();
        uint256 sold = token.balanceOf(eoa[3]) / 2;
        _sell(eoa[3], sold);
        (, uint256 u1After) = _uncollected();
        uint256 lpFee = u1After - u1Before;
        _assertXMatches("after a sell under a protocol fee");
        uint256 x1 = stream.streamValue();
        assertGe(x1, x0, "never falls");
        assertApproxEqAbs(x1 - x0, lpFee * 13 / 15, 13, "X rises by 13/15 of the LP part of the T fee");
        // The combined fee is 1% + 0.1% - 0.001% of the input; the protocol takes 0.1% of it, the LPs 0.999%.
        assertLt(lpFee, sold * BoxSpecV1.LP_FEE / 1_000_000, "the LPs got less than 1% of the input");
        assertApproxEqAbs(lpFee, sold * (BoxSpecV1.LP_FEE - 10) / 1_000_000, 40, "about 0.999% of the input");
        _collectWithQ(keeper);
        _assertXMatches("after the collect");
        assertEq(stream.streamValue(), x1, "continuous across the hand-off");
        _assertGhostLedger();
    }

    /// P5.13 at the edge: right after graduation the price sits on sqrt(P1) and v4 reports tick P1 − 1 (the ask in
    /// range, the bid not); a sell crosses P1 upwards (the bid in range, the ask not); a buy comes back. The stream's
    /// `extsload` read equals StateLibrary's on both sides of the boundary.
    function testProperty_AUDIT_U5_streamXMatchesAtTheGraduationBoundaryTick() public {
        _toGraduated();
        assertEq(_poolSqrt(), curve.sqrtPriceLowerX96, "the price sits on sqrt(P1)");
        assertEq(_poolTick(), curve.tickLower - 1, "v4 reports the tick below the boundary");
        _assertXMatches("at tick P1 - 1");
        uint256 x0 = stream.streamValue();
        _sell(eoa[0], token.balanceOf(eoa[0]) / 10);
        assertGe(_poolTick(), curve.tickLower, "at or above P1");
        _assertXMatches("after crossing P1 upwards");
        assertGe(stream.streamValue(), x0);
        _buy(eoa[1], 0.2 ether);
        _assertXMatches("after a buy back");
        _advance(1);
        _collectWithQ(keeper);
        _assertXMatches("after a collect");
        _assertGhostLedger();
    }

    /// G07 point 4, `BoxItemStream.sol:591-616`: in terminal mode entered without a graduation word (the only time
    /// `handBack` runs after graduation, `BoxTickets.sol:165-178`), placeholders handed back book their accrual since
    /// the start (count × J) to the holder, the open placeholders fall by the count, m falls by it, the aggregate is
    /// unchanged (moved, not created) and a claim pays it less the unit kept.
    function testProperty_AUDIT_U5_terminalHandBackCreditsTheHolderFromTheStart() public {
        _toSilentFromGraduation();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectWithQ(keeper);
        uint256 j = stream.index();
        assertGt(j, 0, "earnings since graduation");
        _toTerminal();
        assertEq(uint256(tickets.status().wordAcceptedAt), 0, "no word: the placeholders can only be handed back");
        (uint256 p,,) = stream.openTickets();
        assertEq(p, 5, "placeholders 1-5 open");
        uint256 m0 = stream.outsideCount();
        uint256 owed0 = stream.owedOf(eoa[0]);
        uint256 liabilities0 = stream.liabilities();
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (1, 2, 3);
        vm.expectEmit(true, false, false, true, a.itemStream);
        emit IBoxItemStream.TicketsCredited(eoa[0], 3, 3 * j);
        (uint256 principal,) = _handBack(eoa[0], ids);
        assertGt(principal, 0, "the principal came back");
        assertEq(stream.owedOf(eoa[0]) - owed0, 3 * j, "three slots' accrual since the start, booked");
        (p,,) = stream.openTickets();
        assertEq(p, 2, "two placeholders left");
        assertEq(stream.outsideCount(), m0 - 3, "m fell by three");
        assertEq(stream.liabilities(), liabilities0, "moved from the aggregate to the account, nothing created");
        assertEq(_ledgerFromRecords(_accounts(), new uint256[](0)), stream.liabilities(), "the ledgers agree");
        uint256 paid = _claimStream(eoa[0], new uint256[](0));
        assertEq(paid, owed0 + 3 * j - 1, "paid less the unit kept");
        _assertGhostLedger();
    }

    /// A self-transfer (ERC-721 allows `from == to`; `BoxCollection.sol:684-710` has no guard) is one checkpoint:
    /// the accrual is booked once, the record restarts at J, and a second one books nothing more.
    function testProperty_AUDIT_U5_selfTransferBooksOnce() public {
        _toDrawing();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectWithQ(keeper);
        uint256 j = stream.index();
        (, uint256 pending0) = stream.pendingOf(itemA);
        assertEq(pending0, j);
        uint256 owed0 = stream.owedOf(eoa[3]);
        uint256 liabilities0 = stream.liabilities();
        _transferItem(eoa[3], eoa[3], itemA);
        assertEq(collection.ownerOf(itemA), eoa[3]);
        assertEq(stream.owedOf(eoa[3]), owed0 + j, "booked once");
        (address o, uint256 pending1) = stream.pendingOf(itemA);
        assertEq(o, eoa[3]);
        assertEq(pending1, 0, "checkpointed at J");
        assertEq(stream.liabilities(), liabilities0, "nothing created");
        _transferItem(eoa[3], eoa[3], itemA);
        assertEq(stream.owedOf(eoa[3]), owed0 + j, "a second self-transfer books nothing more");
        _assertGhostLedger();
    }

    /// The item twin of the accepted M25 class (F126: FIT sent to a system address has no exit; no rescue, F23 C2): an
    /// item moved to the stream's own address by a plain `transferFrom` (the collection refuses only itself, T and the
    /// vault; `safeTransferFrom` is refused, the stream has no receiver hook) keeps accruing to the stream, which can
    /// neither claim (`SelfClaim`) nor move it; its accrual stays in the stream unburned for good.
    function testProperty_AUDIT_U5_itemSentToTheStreamHasNoExit() public {
        _toDrawing();
        vm.prank(eoa[0]);
        vm.expectRevert();
        collection.safeTransferFrom(eoa[0], a.itemStream, itemP1);
        _transferItem(eoa[3], a.itemStream, itemA);
        assertEq(collection.ownerOf(itemA), a.itemStream);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectWithQ(keeper);
        (address o, uint256 pending) = stream.pendingOf(itemA);
        assertEq(o, a.itemStream);
        assertGt(pending, 0, "the slot accrues to the stream's own address");
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        stream.claimFor(a.itemStream, _ids(itemA));
        vm.prank(a.itemStream);
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        stream.claim(_ids(itemA), eoa[3]);
        // Kept, not burned: the aggregate counts the slot, so the burn leaves its accrual in place.
        vm.prank(eoa[5]);
        stream.burn();
        assertGe(_streamT(), stream.liabilities(), "the stuck slot's accrual is held back from burning");
        _assertGhostLedger();
    }
}

/// @title AuditU5FableMoreAmsterdamTest
/// @notice The stipend enumeration under Amsterdam (Foundry 1.8.3's), the fork where wave 1 measured the 7702 gap.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU5FableMoreAmsterdamTest is AuditU5FableStipendPins {
    function testProperty_AUDIT_U5_noStipendOnlyEthSendInTheUnitAmsterdam() public {
        _stipendPins();
    }
}

/// @title AuditU5FableEarlyGraduationTest
/// @notice L5 bound: a box 0 created with mainnet's shortest lead (`openAt` 45 minutes ahead) whose curve closes in
/// the first hour after creation graduates before the executor's hour-long average can be ready (the only checkpoint
/// is the seed at creation, `FitBuybackExecutor.sol:200-202`, `:389-411`): `execute` answers `TwapNotReady` and buys
/// nothing until creation + 1 h, then buys. The wait is bounded by the hour, not by any party.
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableEarlyGraduationTest is AuditU5FableBase {
    uint256 internal constant LEAD = 45 minutes;

    function _auditSpec() internal view override returns (BoxSpecV1.BoxSpec memory s) {
        s = super._auditSpec();
        // casting to 'uint32' is safe until 2106
        // forge-lint: disable-next-line(unsafe-typecast)
        s.openAt = uint32(vm.getBlockTimestamp() + LEAD);
    }

    function testProperty_AUDIT_U5_graduationInTheFirstHourWaitsForTheAverage() public {
        _toClosed();
        uint256 closedAt = vm.getBlockTimestamp();
        uint256 window = executor.TWAP_WINDOW();
        assertLt(closedAt, createdAt + window, "closed within the first hour after creation");
        (, uint256 failures) = _graduate(keeper);
        assertEq(failures, 0, "every poke ran");
        uint256 fit = _payFit(keeper);
        assertGt(fit, 0);
        (bool ready,,) = executor.twap();
        assertFalse(ready, "no checkpoint an hour old yet");
        assertEq(executor.batchThreshold(), 0, "the threshold reads 0 while the average is not ready");
        AuditU5FableExecLogs.ExecLog memory e = _execute(keeper, 1);
        assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.TwapNotReady), "waits for the average");
        assertEq(e.ethSpent, 0);
        _warpTo(createdAt + window - 1);
        e = _execute(keeper, 1);
        assertEq(uint256(e.reason), uint256(FitBuybackExecutor.Stop.TwapNotReady), "one second short");
        _warpTo(createdAt + window);
        (ready,,) = executor.twap();
        assertTrue(ready, "the seed checkpoint is an hour old");
        e = _execute(keeper, 1);
        assertEq(e.chunks, 1, "bought at creation + 1 h");
        emit log_named_uint("seconds from the close to the first possible buy", createdAt + window - closedAt);
        assertLe(createdAt + window - closedAt, window, "the wait is at most the hour");
        _assertGhostLedger();
    }
}
