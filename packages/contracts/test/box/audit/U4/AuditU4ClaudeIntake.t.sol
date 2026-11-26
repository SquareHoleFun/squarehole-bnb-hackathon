// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU4ClaudeBase, U4Books} from "./AuditU4ClaudeBase.sol";
import {AuditU4ClaudeEthPusher, AuditU4ClaudeStipendPayer, AuditU4ClaudeWeth9} from "./AuditU4ClaudeHelpers.sol";

/// @title AuditU4ClaudeIntakeTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). P4.5 (forced ETH never fees; `fundDepth` takes the whole balance and no
/// other ledger's ETH is ever in it), P4.6 (the royalty router: ETH and unwrapped WETH only to `fundFees`, only after
/// graduation; other tokens refused), P4.7 (payouts move exactly the owed amounts, never before the settlement), P4.15
/// (no PoolManager delta left open; WETH9's stipend unwrap), P4.16 (the router accepts a 2,300-gas stipend and 0 wei).
/// Sources: BoxReceiver.sol:276-305, :325-355, :386-408; IBoxReceiver.sol:52-58; BoxRoyaltyRouter.sol:25-34, :54-78;
/// IBoxRoyaltyRouter.sol:12-22, :31; BoxClones.sol:16-21 (the receiving clone); BC-020, BC-107, BC-112, BC-114,
/// BC-115, BC-118. Stand-ins: WETH9's `withdraw` (AuditU4ClaudeWeth9, etched over the world's MockWETH, which pays
/// with all gas); a stipend payer contract (marketplaces' `transfer` / `send`).
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeIntakeTest is AuditU4ClaudeBase {
    // ================================================================================================ P4.5

    /// Forced ETH (SELFDESTRUCT, a coinbase reward or a pre-funded address all look like this) sits in the receiver's
    /// balance as nobody's: no batch, no fundFees, no payout counts it or pays it to the Safe; `fundDepth` adds it
    /// to depth (held before graduation, the hook's claims after) with its own value, and nothing else.
    function testFuzz_AUDIT_U4_forcedEthNeverFees(uint96 forcedRaw, uint96 feesRaw, bool graduated) public {
        if (graduated) _toGraduated();
        else _toBonding();
        uint256 forced = bound(forcedRaw, 1, 50 ether);
        uint256 fees = bound(feesRaw, 1, 200 ether);
        _forceEth(a.receiver, forced);
        U4Books memory b0 = _books();
        _fundFees(eoa[1], fees);
        _batchOf(0.5 ether);
        _collect(keeper, eoa[5]);
        if (graduated) _payPlatform(eoa[7]);
        U4Books memory b1 = _books();
        assertEq(b1.receiverEth, forced, "the forced ETH is untouched by intake, batches and payouts");
        uint256 credited = (b1.platformOwed + (b1.safeEth - b0.safeEth)) - b0.platformOwed;
        uint256 heldP = b1.platformHeld - b0.platformHeld;
        // The platform's part came from the 2/15 of fees and the batch only, never from the forced ETH.
        assertLe((credited + heldP) * 15, 2 * (fees + 0.5 ether) + 15 * 30, "P <= 2/15 of what was paid in");
        uint256 v = bound(feesRaw, 0, 3 ether);
        _fundDepth(eoa[2], v);
        U4Books memory b2 = _books();
        assertEq(b2.receiverEth, 0, "fundDepth takes the whole balance");
        if (graduated) assertEq(b2.hookClaimsQ - b1.hookClaimsQ, forced + v, "all of it to the hook's claims");
        else assertEq(b2.depthHeldQ - b1.depthHeldQ, forced + v, "all of it held for depth");
        assertEq(b2.platformOwed, b1.platformOwed, "fundDepth never credits the Safe");
        assertEq(b2.platformHeld, b1.platformHeld);
        assertEq(b2.fitOwed, b1.fitOwed, "fundDepth never credits FIT");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// P4.5's question ("prove that no ETH of another ledger is in the balance when fundDepth runs"): every ledger is
    /// held as claims (BoxReceiver.sol:28-30; BoxReceiverBase.sol:58); the only plain ETH a call takes in is
    /// `payFit`'s redemption, forwarded in the same call (BoxReceiver.sol:336-340), and a tip a collect's caller
    /// chose to send to the receiver itself. After every entry point the balance is exactly the forced ETH plus such
    /// tips; `fundDepth` then takes that and nothing booked.
    function testProperty_AUDIT_U4_noLedgerEthInTheBalance() public {
        _toGraduated();
        _forceEth(a.receiver, 0.3 ether);
        uint256 expected = 0.3 ether;
        _fundFees(eoa[1], 40 ether);
        assertEq(a.receiver.balance, expected, "fundFees settles exactly msg.value");
        _payFit(keeper);
        assertEq(a.receiver.balance, expected, "payFit forwards all it redeemed");
        _payPlatform(keeper);
        assertEq(a.receiver.balance, expected, "payPlatform redeems to the Safe directly");
        _payRoyalty(eoa[0], 2 ether);
        royaltyRouter.flush();
        assertEq(a.receiver.balance, expected, "the router's flush is fundFees");
        // A caller that names the receiver as its tip recipient: the tip becomes plain ETH there.
        _batchOf(0.02 ether);
        uint256 tipBefore = a.receiver.balance;
        _collect(keeper, a.receiver);
        uint256 selfTip = a.receiver.balance - tipBefore;
        assertEq(selfTip, TIP_MAX, "min(10% of the batch, 0.0005 ETH), tipped to the receiver itself");
        expected += selfTip;
        assertEq(a.receiver.balance, expected);
        U4Books memory b0 = _books();
        _fundDepth(eoa[2], 0);
        U4Books memory b1 = _books();
        assertEq(b1.hookClaimsQ - b0.hookClaimsQ, expected, "fundDepth: forced ETH and the self-tip, to depth");
        assertEq(b1.bookedQ, b0.bookedQ, "no booked claim moved");
        assertEq(b1.claimsQ, b0.claimsQ, "the receiver's claims unchanged");
        _assertGhostLedger();
    }

    /// P4.5, P4.9: the third way plain ETH reaches the receiver. `receive()` takes ETH "only from the PoolManager,
    /// inside this contract's own guarded calls" (BoxReceiver.sol:405-408), and that includes ETH that someone with
    /// control flow inside the receiver's unlock (here the tip recipient, `AuditU4ClaudeEthPusher`) settles itself and
    /// has the PoolManager take to the receiver. It is the pusher's own ETH, booked by no ledger: it joins the forced ETH,
    /// the next batch and every ledger stay as the batch left them, and only fundDepth moves it, all to depth.
    function testProperty_AUDIT_U4_ethPushedInsideOwnUnlockOnlyReachesDepth() public {
        _toGraduated();
        AuditU4ClaudeEthPusher pusher = new AuditU4ClaudeEthPusher(pm, a.receiver, 0.4 ether);
        _ghostAddOutside(address(pusher));
        vm.deal(address(pusher), 0.4 ether);
        _batchOf(0.02 ether);
        U4Books memory b0 = _books();
        _collect(keeper, address(pusher));
        U4Books memory b1 = _books();
        assertTrue(pusher.pushed(), "the pusher ran inside the receiver's unlock");
        assertEq(b1.receiverEth, 0.4 ether, "accepted: msg.sender is the PoolManager and the lock is held");
        (uint256 uq, uint256 ut) = _unbooked();
        assertEq(uq + ut, 0, "the batch completed; the pushed ETH is no claim");
        assertEq(b1.claimsQ, b1.bookedQ, "every claim booked");
        uint256 u = (0.02 ether - TIP_MAX + b0.qCarry) / FIFTEEN;
        assertEq(b1.platformOwed - b0.platformOwed, 2 * u, "the Safe's credit is the batch's P only");
        _fundDepth(eoa[2], 0);
        U4Books memory b2 = _books();
        assertEq(b2.receiverEth, 0, "fundDepth takes it");
        assertEq(b2.hookClaimsQ - b1.hookClaimsQ, 0.4 ether, "all of it to depth");
        assertEq(b2.platformOwed, b1.platformOwed, "never to the Safe");
        assertEq(b2.fitOwed, b1.fitOwed, "never to FIT");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// M01 (accepted, F126; DECISION-LOG.md:141): raw T (FIT) sent to the receiver has no exit. Pinned as accepted:
    /// through a life of batches, a late burn retry, payouts and fundDepth, nothing moves it; the receiver burns only
    /// `tBurnPending` (BoxReceiver.sol:965-975), never its balance.
    function testProperty_AUDIT_U4_acceptedM01RawTAtTheReceiverStays() public {
        _toBonding();
        uint256 stray = token.balanceOf(eoa[0]) / 10;
        _transferT(eoa[0], a.receiver, stray);
        uint256 tOut = _buy(eoa[3], 1 ether);
        _advance(1);
        _sell(eoa[3], tOut / 2);
        _collect(keeper, keeper);
        assertEq(token.balanceOf(a.receiver), stray, "before graduation: not burned with the batch");
        _toGraduated();
        tOut = _buy(eoa[3], 1 ether);
        _advance(1);
        _sell(eoa[3], tOut / 2);
        _collect(keeper, keeper);
        _fundFees(eoa[1], 3 ether);
        _fundDepth(eoa[1], 1 ether);
        _payFit(keeper);
        _payPlatform(keeper);
        assertEq(token.balanceOf(a.receiver), stray, "accepted M01: the stray T stays at the receiver");
        assertEq(receiver.tBurnPending(), 0, "it is not a pending burn");
        _assertGhostLedger();
    }

    /// M02 (accepted, F126 under F83 C5): royalties paid to the router in a token other than ETH or WETH (here FIT,
    /// box 0's T) have no exit: `sweep` refuses it (TokenNotTaken), `flush` moves ETH and WETH only.
    function testProperty_AUDIT_U4_acceptedM02TokenRoyaltiesStayAtTheRouter() public {
        _toGraduated();
        uint256 amount = token.balanceOf(eoa[0]) / 10;
        _transferT(eoa[0], a.royaltyRouter, amount);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, a.token));
        royaltyRouter.sweep(a.token);
        _payRoyalty(eoa[0], 1 ether);
        assertEq(royaltyRouter.flush(), 1 ether, "the flush moves the ETH");
        assertEq(token.balanceOf(a.royaltyRouter), amount, "accepted M02: the token stays at the router");
        _assertGhostLedger();
    }

    // ================================================================================================ P4.7

    /// P4.7, BC-020: before graduation `payFit` refuses (NotGraduated) and `payPlatform` has nothing owed (the P is
    /// held); after it `payFit` moves exactly `fitOwed` into the executor's budget through `fundBudget` and
    /// `payPlatform` exactly `platformOwed` to the fixed Safe; a second call has nothing owed.
    function testProperty_AUDIT_U4_payoutsMoveExactlyTheOwed() public {
        _toBonding();
        _fundFees(eoa[1], 3 ether);
        uint256 exec0 = a.executor.balance;
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        vm.prank(keeper);
        receiver.payFit();
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        vm.prank(keeper);
        receiver.payPlatform();
        assertEq(a.executor.balance, exec0, "nothing reaches the executor before graduation");
        assertGt(receiver.fitOwed(), 0, "FIT's share is held");
        _toGraduated();
        _fundFees(eoa[1], 15 ether);
        uint256 fitOwed = receiver.fitOwed();
        uint256 budget0 = executor.budget();
        vm.expectCall(a.executor, fitOwed, abi.encodeWithSignature("fundBudget()"));
        uint256 paidFit = _payFit(keeper);
        assertEq(paidFit, fitOwed);
        assertEq(executor.budget() - budget0, fitOwed, "exactly fitOwed into the budget");
        assertEq(receiver.fitOwed(), 0);
        uint256 owed = receiver.platformOwed();
        uint256 s0 = safe.balance;
        uint256 paid = _payPlatform(eoa[3]);
        assertEq(paid, owed);
        assertEq(safe.balance - s0, owed, "exactly platformOwed to the fixed Safe");
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        receiver.payFit();
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        receiver.payPlatform();
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    // ================================================================================================ P4.6

    /// P4.6, BC-114, BC-115: the router holds every payment before graduation (flush and sweep(WETH) refuse); after
    /// it, flush unwraps all its WETH and sends all its ETH in one `fundFees` call to box 0's receiver and nowhere else;
    /// sweep refuses every other token and address(0); the router keeps nothing and pays nobody else.
    function testFuzz_AUDIT_U4_routerFlushesOnlyToFundFees(uint96 ethRaw, uint96 wethRaw, address otherToken) public {
        _toBonding();
        uint256 eth = bound(ethRaw, 0, 40 ether);
        uint256 weth = bound(wethRaw, 0, 40 ether);
        if (eth + weth == 0) eth = 1;
        if (eth != 0) _payRoyalty(eoa[0], eth);
        if (weth != 0) _payRoyaltyWeth(eoa[0], weth);
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.flush();
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.sweep(a.weth);
        _toGraduated();
        vm.assume(otherToken != a.weth);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, otherToken));
        royaltyRouter.sweep(otherToken);
        U4Books memory b0 = _books();
        vm.expectCall(a.receiver, eth + weth, abi.encodeCall(IBoxReceiver.fundFees, ()));
        vm.recordLogs();
        uint256 sent = royaltyRouter.flush();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        U4Books memory b1 = _books();
        assertEq(sent, eth + weth, "everything");
        assertEq(a.royaltyRouter.balance, 0, "no ETH left");
        assertEq(_wethOf(a.royaltyRouter), 0, "no WETH left");
        assertEq(_feesFundedBy(logs, a.royaltyRouter), eth + weth, "one fundFees from the router, all of it");
        assertEq(b1.safeEth, b0.safeEth, "the router never pays the Safe");
        assertEq(b1.executorEth, b0.executorEth, "nor the executor");
        vm.expectRevert(IBoxRoyaltyRouter.NothingToFlush.selector);
        royaltyRouter.flush();
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, address(0)));
        royaltyRouter.sweep(address(0));
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// P4.6: sweep(WETH) is flush (WETH only, after graduation).
    function testProperty_AUDIT_U4_sweepWethIsFlush() public {
        _toGraduated();
        _payRoyaltyWeth(eoa[0], 3 ether);
        vm.expectCall(a.receiver, 3 ether, abi.encodeCall(IBoxReceiver.fundFees, ()));
        assertEq(royaltyRouter.sweep(a.weth), 3 ether);
        assertEq(_wethOf(a.royaltyRouter), 0);
        _assertGhostLedger();
    }

    // ================================================================================================ P4.15, P4.16

    /// P4.16, BC-114: the router accepts a marketplace's 2,300-gas stipend (`transfer`, `send`, a call with 2,300 gas),
    /// 0 wei, and a plain call with all gas, in every phase; receiving writes no storage and logs nothing.
    function testProperty_AUDIT_U4_routerAcceptsStipendAndZeroWei() public {
        _routerAcceptsEveryPayment(); // created
        _toBonding();
        _routerAcceptsEveryPayment();
        _toGraduated();
        _routerAcceptsEveryPayment();
    }

    function _routerAcceptsEveryPayment() internal {
        AuditU4ClaudeStipendPayer payer = new AuditU4ClaudeStipendPayer();
        vm.deal(address(payer), 0);
        uint256 r0 = a.royaltyRouter.balance;
        vm.record();
        vm.recordLogs();
        vm.deal(address(this), address(this).balance + 4 ether);
        payer.payTransfer{value: 1 ether}(payable(a.royaltyRouter));
        assertTrue(payer.paySend{value: 1 ether}(payable(a.royaltyRouter)), "send (2,300 gas)");
        assertTrue(payer.payCall{value: 1 ether}(a.royaltyRouter, 2_300, ""), "a call with 2,300 gas");
        assertTrue(payer.payCall{value: 0}(a.royaltyRouter, 2_300, ""), "0 wei");
        (bool ok,) = a.royaltyRouter.call{value: 1 ether}("");
        assertTrue(ok, "a call with all gas");
        (, bytes32[] memory writes) = vm.accesses(a.royaltyRouter);
        assertEq(writes.length, 0, "receiving writes nothing");
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != a.royaltyRouter, "receiving logs nothing");
        }
        assertEq(a.royaltyRouter.balance - r0, 4 ether);
        _noteEthIn(EthIn.Royalty, 4 ether);
    }

    /// P4.15: WETH9's `withdraw` pays with `transfer` (2,300 gas); the router's flush unwraps through it and delivers
    /// everything to the receiver (the receiving clone stops on empty calldata within the stipend).
    function testProperty_AUDIT_U4_weth9StipendUnwrapReachesTheReceiver() public {
        _etchWeth9();
        _toGraduated();
        _payRoyaltyWeth(eoa[0], 7 ether);
        _payRoyalty(eoa[0], 1 ether);
        vm.expectCall(a.receiver, 8 ether, abi.encodeCall(IBoxReceiver.fundFees, ()));
        assertEq(royaltyRouter.flush(), 8 ether, "7 WETH unwrapped by a 2,300-gas transfer, and 1 ETH");
        assertEq(_wethOf(a.royaltyRouter), 0);
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// P4.16's "any calldata" (unit brief): the receiving clone accepts only empty calldata (BoxClones.sol:16-21:
    /// "every call with calldata delegates exactly as EIP-1167 does"); the implementation has `receive()` and no
    /// `fallback`, so a value call with calldata is refused and the payer keeps its ETH (with all gas: an unknown
    /// selector reverts; `flush()` is not payable; with a 2,300-gas stipend the cold DELEGATECALL alone runs out).
    /// Pinned as built; the founder question in the evidence asks whether any marketplace pays this way.
    function testProperty_AUDIT_U4_routerPaymentWithCalldataIsRefused() public {
        _toGraduated();
        AuditU4ClaudeStipendPayer payer = new AuditU4ClaudeStipendPayer();
        vm.deal(address(this), address(this).balance + 3 ether);
        uint256 r0 = a.royaltyRouter.balance;
        assertFalse(payer.payCall{value: 1 ether}(a.royaltyRouter, 1_000_000, hex"deadbeef"), "unknown selector");
        assertFalse(
            payer.payCall{value: 1 ether}(a.royaltyRouter, 1_000_000, abi.encodeCall(IBoxRoyaltyRouter.flush, ())),
            "flush() is not payable"
        );
        assertFalse(payer.payCall{value: 1 ether}(a.royaltyRouter, 2_300, hex"00"), "1 byte of calldata, a stipend");
        assertEq(a.royaltyRouter.balance, r0, "nothing received");
        assertEq(address(payer).balance, 3 ether, "the payer keeps its ETH");
    }

    /// P4.15 (L6): after every receiver entry point that unlocks the PoolManager (collect, fundFees, fundDepth,
    /// payFit, payPlatform, the router's flush, the late settlement) the PoolManager is locked with no delta open.
    function testProperty_AUDIT_U4_noOpenDeltaAfterEveryReceiverCall() public {
        _toBonding();
        _fundFees(eoa[1], 1 ether);
        _assertNoOpenDelta();
        _fundDepth(eoa[1], 1 ether);
        _assertNoOpenDelta();
        _batchOf(0.01 ether);
        _collect(keeper, keeper);
        _assertNoOpenDelta();
        _toGraduatedLate();
        _payRoyalty(eoa[0], 2 ether);
        royaltyRouter.flush(); // settles late, then splits
        _assertNoOpenDelta();
        _batchOf(0.01 ether);
        _collect(keeper, eoa[4]);
        _assertNoOpenDelta();
        _fundDepth(eoa[1], 1 ether);
        _assertNoOpenDelta();
        _payFit(keeper);
        _assertNoOpenDelta();
        _payPlatform(keeper);
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    // ================================================================================================ helpers

    function _etchWeth9() internal {
        vm.etch(a.weth, address(new AuditU4ClaudeWeth9()).code);
    }

    function _wethOf(address who) internal view returns (uint256) {
        return AuditU4ClaudeWeth9(a.weth).balanceOf(who);
    }

    function _feesFundedBy(VmSafe.Log[] memory logs, address from) internal view returns (uint256 amount) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver || logs[i].topics[0] != IBoxReceiver.FeesFunded.selector) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != from) continue;
            amount += abi.decode(logs[i].data, (uint256));
        }
    }
}
