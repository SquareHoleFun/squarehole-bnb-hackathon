// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {EthIn} from "../common/AuditGhostLedger.sol";
import {AuditU4FableBase, AuditU4FableStipendPayer, AuditU4FableWeth9Like} from "./AuditU4FableBase.sol";

/// @notice SH-AUDIT-B0 U4 (Fable), lens L6 external protocol assumptions on box 0's royalty router, run under Osaka
/// and under Amsterdam (the R0-A observation: Amsterdam prices a stipend call to a delegated EOA short): the receiving
/// clone accepts a marketplace's 2,300-gas `transfer`, WETH9's `withdraw` (which pays by `transfer`) reaches it, the
/// graduation read is gas-capped and fail-safe, a reverting sink keeps the ETH, and no U4 path pays an EOA with a
/// stipend. Proof test 25 pins a payment carrying calldata.
abstract contract AuditU4FableRouterBase is AuditU4FableBase {
    AuditU4FableStipendPayer internal payer;

    function setUp() public virtual override {
        super.setUp();
        _toBonding();
        payer = new AuditU4FableStipendPayer();
        vm.deal(address(payer), 10 ether);
    }

    /// P4.16, BC-114: `transfer`, `send`, a call with 2,300 gas, 0 wei, a plain EOA, a delegated EOA: every payment
    /// without calldata is accepted and writes nothing.
    function testProperty_AUDIT_U4_routerAcceptsStipendPayments() public {
        vm.record();
        payer.payByTransfer(payable(a.royaltyRouter), 1 ether);
        assertTrue(payer.payBySend(payable(a.royaltyRouter), 0.5 ether), "send");
        assertTrue(payer.payByCall(a.royaltyRouter, 0, 2_300), "0 wei with a stipend's gas");
        assertTrue(payer.payByCall(a.royaltyRouter, 0.25 ether, 2_300), "a stipend's gas");
        assertTrue(payer.payByCall(a.royaltyRouter, 0.25 ether, gasleft()), "all gas");
        _fund(eoa[0], 0.1 ether);
        vm.prank(eoa[0]);
        (bool ok,) = a.royaltyRouter.call{value: 0.1 ether}("");
        assertTrue(ok, "an EOA");
        _fund(eoa7702, 0.1 ether);
        vm.prank(eoa7702);
        (ok,) = a.royaltyRouter.call{value: 0.1 ether, gas: 2_300}("");
        assertTrue(ok, "a delegated EOA paying with a stipend");
        (, bytes32[] memory writes) = vm.accesses(a.royaltyRouter);
        assertEq(writes.length, 0, "no storage written");
        assertEq(a.royaltyRouter.balance, 2.2 ether);
        _noteEthIn(EthIn.Royalty, 2.2 ether);
        emit log_named_string("evm", vm.getEvmVersion());
        _assertGhostLedger();
    }

    /// P4.15, BC-114: WETH9's `withdraw` pays with `transfer` (a 2,300-gas stipend); a WETH9-shaped stand-in doing
    /// exactly that is etched over the kit's MockWETH (which pays with a call and all gas), and the flush unwraps and
    /// delivers everything to `fundFees`.
    function testProperty_AUDIT_U4_weth9TransferWithdrawReachesTheRouter() public {
        vm.etch(a.weth, address(new AuditU4FableWeth9Like()).code);
        _payRoyaltyWeth(eoa[2], 2 ether);
        _payRoyalty(eoa[2], 0.5 ether);
        _toGraduated();
        uint256 fit0 = receiver.fitOwed();
        (uint256 carry,) = receiver.carried();
        vm.expectEmit(true, false, false, true, a.royaltyRouter);
        emit IBoxRoyaltyRouter.Flushed(a.receiver, 2.5 ether, 2 ether);
        vm.prank(eoa[5]);
        assertEq(royaltyRouter.flush(), 2.5 ether);
        assertEq(a.royaltyRouter.balance, 0);
        assertEq(receiver.fitOwed() - fit0, 11 * ((2.5 ether + carry) / DENOM), "11/15 of the flush to FIT");
        _assertGhostLedger();
    }

    /// @notice Property it breaks: "the royalty router never refuses a payment" (BC-114's title; its text: `receive()`
    /// accepts every ETH payment, 0 wei and a 2,300-gas stipend included; `IBoxRoyaltyRouter.sol:12-13`;
    /// `BoxRoyaltyRouter.sol:25-28`), as the unit brief reads it: "with any calldata" (P4.16).
    /// Expected: a payment that carries calldata is accepted like one without.
    /// Observed: the receiving clone answers only empty calldata in its own code (`BoxClones.sol:15-21`); any call
    /// with calldata is delegated to the implementation, which has `receive()` but no `fallback()`
    /// (`BoxRoyaltyRouter.sol:54`), so a payment carrying calldata reverts and the ETH stays with the payer.
    /// Steps: a payer contract calls the router with 1 ETH and one byte of calldata, then with 1 ETH and a 4-byte
    /// selector the router does not have (`onRoyaltyReceived(uint256)`); both fail; the router's balance is unchanged.
    /// Amounts: 1 ETH each. Also: `flush()` sent with value reverts (not payable).
    /// Severity: Note. ERC-2981 marketplaces pay by `transfer`, `send` or an empty call, which succeed (the test above);
    /// a marketplace or splitter that pays with calldata would see its royalty payment refused, a documentation
    /// precision ("never refuses a payment" means a payment without calldata), with no value effect on box 0.
    function test_AUDIT_U4_25_routerRefusesPaymentCarryingCalldata() public {
        uint256 before = address(payer).balance;
        (bool ok, bytes memory ret) = payer.payWithData(a.royaltyRouter, 1 ether, hex"01");
        assertFalse(ok, "one byte of calldata: refused");
        assertEq(ret.length, 0, "the implementation's dispatcher reverts without data");
        (ok,) = payer.payWithData(a.royaltyRouter, 1 ether, abi.encodeWithSignature("onRoyaltyReceived(uint256)", 1));
        assertFalse(ok, "an unknown selector: refused");
        (ok,) = payer.payWithData(a.royaltyRouter, 1 ether, abi.encodeCall(IBoxRoyaltyRouter.flush, ()));
        assertFalse(ok, "flush() with value: not payable");
        assertEq(address(payer).balance, before, "the ETH stayed with the payer");
        assertEq(a.royaltyRouter.balance, 0);
        // The same payments without calldata are accepted.
        assertTrue(payer.payByCall(a.royaltyRouter, 1 ether, 2_300));
        _noteEthIn(EthIn.Royalty, 1 ether);
        _assertGhostLedger();
    }

    /// P4.6, BC-114, BC-115: `flush` reads `coordinator.graduated()` with a gas cap and reads any failure or short
    /// answer as "not graduated": nothing leaves before graduation, nor when the read fails.
    function testProperty_AUDIT_U4_flushGraduationReadIsGasCappedAndFailSafe() public {
        _payRoyalty(eoa[2], 1 ether);
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.flush();
        _toGraduated();
        vm.mockCallRevert(a.coordinator, IBoxCoordinator.graduated.selector, "coordinator: down");
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.flush();
        vm.clearMockedCalls();
        vm.mockCall(a.coordinator, IBoxCoordinator.graduated.selector, hex"01");
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.flush();
        vm.clearMockedCalls();
        assertEq(a.royaltyRouter.balance, 1 ether, "nothing left");
        assertEq(royaltyRouter.flush(), 1 ether, "the real read: graduated");
        _assertGhostLedger();
    }

    /// BC-114: a reverting intake reverts the flush (`SinkFailed`) and leaves the ETH and WETH for the next one.
    function testProperty_AUDIT_U4_sinkRevertKeepsEthForTheNextFlush() public {
        _toGraduated();
        _payRoyalty(eoa[2], 1 ether);
        _payRoyaltyWeth(eoa[2], 0.5 ether);
        vm.mockCallRevert(a.receiver, IBoxReceiver.fundFees.selector, "receiver: no");
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        royaltyRouter.flush();
        vm.clearMockedCalls();
        assertEq(a.royaltyRouter.balance, 1 ether, "the ETH stays (the WETH unwrap reverted with the flush)");
        assertEq(royaltyRouter.flush(), 1.5 ether);
        _assertGhostLedger();
    }

    /// The R0-A note: no U4 path pays an EOA with a stipend. The receiver's payouts go through the PoolManager's `take`
    /// (a call with all gas), `payFit` and `flush` forward all gas; only WETH9 pays with a stipend, to the router
    /// clone's own code. Pinned: a tip to a delegated EOA and a platform payout to a Safe that is a delegated EOA (the
    /// designator etched at the Safe's address as a stand-in) both succeed under this EVM.
    function testProperty_AUDIT_U4_noStipendPaymentToAnEoaOnAnyPath() public {
        _toGraduated();
        _trade(eoa[3], 0.8 ether, 2_000);
        _advance(1);
        uint256 e0 = eoa7702.balance;
        uint256 tip = _collect(keeper, eoa7702).tip;
        assertEq(eoa7702.balance - e0, tip, "the tip reached the delegated EOA");
        vm.etch(safe, eoa7702.code);
        uint256 owed = receiver.platformOwed();
        assertGt(owed, 0);
        assertEq(_payPlatform(eoa[1]), owed);
        assertEq(safe.balance, owed, "a delegated Safe got its payout: the PoolManager's call carries all gas");
        emit log_named_string("evm", vm.getEvmVersion());
        _assertGhostLedger();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU4FableRouterTest is AuditU4FableRouterBase {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU4FableRouterAmsterdamTest is AuditU4FableRouterBase {}
