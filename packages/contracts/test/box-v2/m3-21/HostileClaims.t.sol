// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemClaimFixture} from "./Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";

/// @dev A caller/recipient, also used as the target of an exact 7702 designation.
contract ClaimActor {
    uint256 public refuseAmount;
    bool public exhaust;
    address public reenter;
    bytes public reentryData;

    function configure(uint256 refuse, bool sink, address target, bytes calldata data) external {
        refuseAmount = refuse;
        exhaust = sink;
        reenter = target;
        reentryData = data;
    }

    function claim(IItemLedgerV2 ledger, uint256 id, address to) external returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return ledger.claim(ids, to);
    }

    receive() external payable {
        if (exhaust) {
            assembly ("memory-safe") { for {} 1 {} {} }
        }
        require(msg.value != refuseAmount, "refused");
        if (reenter != address(0)) {
            (bool ok,) = reenter.call(reentryData);
            require(ok, "reentry refused");
        }
    }
}

/// @dev Exact receipt to the owner can conceal an extra PM debit; a successful payout must reject both.
contract SenderTaxPrice {
    mapping(address => uint256) public balanceOf;
    bool public taxed;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTax(bool value) external {
        taxed = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount + (taxed ? 1 : 0);
        balanceOf[to] += amount;
        return true;
    }
}

contract BalanceGasPrice {
    mapping(address => uint256) private balances;
    bool public exhaust;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function setExhaust(bool value) external {
        exhaust = value;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (exhaust) {
            assembly ("memory-safe") { for {} 1 {} {} }
        }
        return balances[who];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }
}

contract RevertDataRecipient {
    receive() external payable {
        assembly ("memory-safe") { revert(0, 65536) }
    }
}

contract HostileItemClaimsTest is ItemClaimFixture, IUnlockCallback {
    function test_gasBurningBalanceReadIsInsidePayoutCapAndRetryable() public {
        BalanceGasPrice gasToken = new BalanceGasPrice();
        _setup(address(gasToken), 100, 30);
        _funded(100);
        gasToken.setExhaust(true);
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim{gas: 3_500_000}(_ids(1), BOB);
        assertEq(_credit(1), 100);
        _conserved();
        gasToken.setExhaust(false);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        assertEq(gasToken.balanceOf(BOB), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_largeRecipientRevertDataCannotEscapePayoutCap() public {
        _funded(100);
        RevertDataRecipient recipient = new RevertDataRecipient();
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim{gas: 3_500_000}(_ids(1), address(recipient));
        assertEq(_credit(1), 100);
        _conserved();
    }

    function test_blockedOwnerCanChooseAnotherRecipient() public {
        _erc20(6);
        _funded(100);
        token.setBlocked(ALICE, true);
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), ALICE);
        assertEq(token.balanceOf(ALICE), 0);
        assertEq(_credit(1), 100);
        _conserved();
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_pausedPricePreservesWholeCreditAndRetries() public {
        _erc20(6);
        _funded(100);
        token.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), BOB);
        assertEq(_credit(1), 100);
        _conserved();
        token.setPaused(false);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        assertEq(token.balanceOf(BOB), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_gasExhaustingRecipientPreservesCreditAndRetries() public {
        _funded(100);
        ClaimActor actor = new ClaimActor();
        actor.configure(0, true, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim{gas: 3_500_000}(_ids(1), address(actor));
        assertEq(address(actor).balance, 0);
        assertEq(_credit(1), 100);
        _conserved();
        actor.configure(0, false, address(0), "");
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), address(actor)), 100);
        assertEq(address(actor).balance, 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_refused7702OwnerPaymentRollsBackAndRetries() public {
        _funded(100);
        ClaimActor delegate = new ClaimActor();
        vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(delegate)));
        ClaimActor(payable(ALICE)).configure(100, false, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), ALICE);
        assertEq(ALICE.balance, 0);
        assertEq(_credit(1), 100);
        _conserved();
        ClaimActor(payable(ALICE)).configure(0, false, address(0), "");
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_refusedRecipientPreservesCreditAndOwnerCanChooseAnother() public {
        _funded(100);
        ClaimActor actor = new ClaimActor();
        actor.configure(100, false, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), address(actor));
        assertEq(_credit(1), 100);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_tokenReentryCannotClaimSyncOrFlushDuringPayout() public {
        _erc20(18);
        _funded(100);
        bytes[3] memory attacks = [
            abi.encodeCall(IItemLedgerV2.claim, (_ids(1), BOB)),
            abi.encodeCall(IItemLedgerV2.sync, (32)),
            abi.encodeCall(IItemLedgerV2.flushResidue, ())
        ];
        for (uint256 i; i < attacks.length; ++i) {
            token.armReentry(address(ledger), attacks[i]);
            vm.prank(ALICE);
            vm.expectRevert(PAYOUT_FAILED);
            ledger.claim(_ids(1), BOB);
            assertEq(token.balanceOf(BOB), 0);
            assertEq(_credit(1), 100);
            _conserved();
        }
        token.armReentry(address(0), "");
        vm.prank(ALICE);
        ledger.claim(_ids(1), BOB);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_nativeRecipientReentryPreservesCredit() public {
        _funded(100);
        ClaimActor actor = new ClaimActor();
        actor.configure(0, false, address(ledger), abi.encodeCall(IItemLedgerV2.claim, (_ids(1), BOB)));
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), address(actor));
        assertEq(address(actor).balance, 0);
        _conserved();
    }

    function test_shortReceiptAndExtraSenderDebitAreBothAtomic() public {
        _erc20(6);
        _funded(100);
        token.setFeeBps(1000);
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), BOB);
        assertEq(token.balanceOf(BOB), 0);
        _conserved();
        SenderTaxPrice taxed = new SenderTaxPrice();
        _setup(address(taxed), 100, 30);
        _funded(100);
        taxed.setTax(true);
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        ledger.claim(_ids(1), BOB);
        assertEq(taxed.balanceOf(BOB), 0);
        assertEq(taxed.balanceOf(address(pm)), 400);
        _conserved();
    }

    function test_foreignUnlockAndUnarmedCallbacksCannotSpend() public {
        _funded(100);
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        IUnlockCallback(address(ledger)).unlockCallback(abi.encode(BOB, 100));
        vm.prank(address(pm));
        vm.expectRevert(INVALID_CLAIM);
        IUnlockCallback(address(ledger)).unlockCallback(abi.encode(BOB, 100));
        pm.unlock("");
        _conserved();
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm));
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.ForeignUnlock.selector);
        ledger.claim(_ids(1), BOB);
        return "";
    }
}
