// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditPhases} from "../common/AuditPhases.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";

/// @notice Adversarial payout recipient only: replaces the Safe's receive behaviour to attempt reentry through
/// both production receiver halves during the real PoolManager's payment. The receiver and extension stay unmodified.
contract AuditU9LaneReenteringSafe {
    BoxReceiver internal immutable target;
    uint256 public received;
    bool public unexpectedlySucceeded;
    bytes4 public mainError;
    bytes4 public extensionError;
    bytes4 public payeeError;
    bytes4 public callbackError;
    bytes4 public receiveError;

    constructor(BoxReceiver r) {
        target = r;
    }

    function _attempt(bytes memory data) internal returns (bytes4) {
        (bool ok, bytes memory result) = address(target).call(data);
        if (ok) unexpectedlySucceeded = true;
        return bytes4(result);
    }

    receive() external payable {
        received += msg.value;
        mainError = _attempt(abi.encodeCall(target.fundFees, ()));
        extensionError = _attempt(abi.encodeCall(target.noteModuleFees, (uint256(0), uint256(0))));
        payeeError = _attempt(abi.encodeCall(target.proposeCreatorPayee, (address(this))));
        callbackError = _attempt(abi.encodeCall(target.unlockCallback, (bytes(""))));
        receiveError = _attempt("");
    }
}

/// @notice BC-001/012/064/107/109 and IBoxReceiver's callback boundary; real factory/registry/receiver/PoolManager.
/// forge-config: default.evm_version = "osaka"
contract AuditU9LaneWorld is AuditPhases {
    function testProperty_AUDIT_U9_factoryRecordsExactBoxZeroSpecHash() public view {
        BoxSpecV1.BoxSpec memory s = kit.spec();
        bytes memory encoded = abi.encode(s);
        bytes32 h = BoxSpecV1.specHash(s);
        assertEq(h, keccak256(encoded));
        assertEq(BoxSpecV1.specHash(abi.decode(encoded, (BoxSpecV1.BoxSpec))), h);
        assertEq(coordinator.boxId(), 0);
        assertEq(coordinator.specHash(), h);
        (address registered,,, bytes32 registryHash,) = BoxRegistry(factory.registry()).entry(0);
        assertEq(registered, a.coordinator);
        assertEq(registryHash, h);
        assertEq(BoxRegistry(factory.registry()).recordOf(0).specHash, h);
    }

    function testProperty_AUDIT_U9_receiverRejectsCallbacksOutsideGuard() public {
        vm.expectRevert(IBoxReceiver.NotPoolManager.selector);
        receiver.unlockCallback("");
        vm.prank(address(pm));
        vm.expectRevert(IBoxReceiver.NotPoolManager.selector);
        receiver.unlockCallback("");
        vm.prank(address(pm));
        (bool ok, bytes memory data) = address(receiver).call("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, address(pm)));
        (ok, data) = address(receiver).call("");
        assertFalse(ok);
        assertEq(data, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, address(this)));
    }

    function testProperty_AUDIT_U9_receiverSequentialCallsAndCaughtRevert() public {
        // A caught outer revert must roll back its TSTORE; the following deposits exercise legitimate unlock callbacks.
        (bool ok, bytes memory result) = a.receiver.call(abi.encodeCall(receiver.payFit, ()));
        assertFalse(ok);
        assertEq(bytes4(result), IBoxReceiver.NotGraduated.selector);
        _fundFees(eoa[0], 15 wei);
        _fundFees(eoa[0], 15 wei);
        _fundDepth(eoa[0], 10 wei);
        // Successful DELEGATECALL guard also releases the exact same transient slot before the next main-half call.
        vm.prank(a.hook);
        receiver.noteModuleFees(0, 0);
        _fundFees(eoa[0], 15 wei);
        vm.prank(a.hook);
        receiver.noteModuleFees(0, 0);
        _assertGhostLedger();
    }

    function testProperty_AUDIT_U9_realPayoutReceiveAndDelegatecallShareLock() public {
        _toGraduated();
        uint256 fit = receiver.fitOwed();
        assertGt(fit, 0);
        uint256 before = a.executor.balance;
        // payFit redeems Q to the receiver itself: real PoolManager -> receive -> executor, while guarded.
        assertEq(receiver.payFit(), fit);
        assertEq(a.executor.balance, before + fit);
        assertEq(a.receiver.balance, 0);

        AuditU9LaneReenteringSafe standIn = new AuditU9LaneReenteringSafe(receiver);
        vm.etch(safe, address(standIn).code);
        uint256 owed = receiver.platformOwed();
        assertGt(owed, 0);
        assertEq(_payPlatform(keeper), owed);
        AuditU9LaneReenteringSafe payee = AuditU9LaneReenteringSafe(payable(safe));
        assertEq(payee.received(), owed);
        assertFalse(payee.unexpectedlySucceeded());
        assertEq(payee.mainError(), TransientReentrancyGuard.Reentrancy.selector);
        assertEq(payee.extensionError(), TransientReentrancyGuard.Reentrancy.selector);
        assertEq(payee.payeeError(), TransientReentrancyGuard.Reentrancy.selector);
        assertEq(payee.callbackError(), IBoxReceiver.NotPoolManager.selector);
        assertEq(payee.receiveError(), IBoxReceiver.EthRefused.selector);
        _fundFees(eoa[0], 15 wei);
        _assertGhostLedger();
    }
}
