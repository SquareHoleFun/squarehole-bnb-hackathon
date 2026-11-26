// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Items} from "./Items.sol";
import {ClaimCap} from "./ClaimCap.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxReceiverV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract M360ClaimsTest is M360Items {
    function test_nativeCompleteClaimAndHalfCap() public {
        _claims(0);
    }

    function test_erc20SixDecimalsCompleteClaimAndHalfCap() public {
        _claims(6);
    }

    function test_erc20EightDecimalsCompleteClaimAndHalfCap() public {
        _claims(8);
    }

    function test_erc20EighteenDecimalsCompleteClaimAndHalfCap() public {
        _claims(18);
    }

    function _claims(uint8 decimals) private {
        _itemStart(decimals, true);
        uint256 id = _drawAndOpen();
        _gift(address(receiver), 15000);
        _measure(
            "live item collect",
            address(receiver),
            BOB,
            abi.encodeCall(IBoxReceiverV2.collect, (address(0))),
            12_000_000
        );
        ledger.sync(32);
        (uint256 outside, uint256 stash) = ledger.itemCredit(id);
        uint256 credit = outside + stash;
        assertGt(credit, 0);
        uint256 backing = pm.balanceOf(address(ledger), uint160(box.q()));
        uint256 snap = vm.snapshotState();
        bytes memory data = abi.encodeCall(IItemLedgerV2.claim, (_one(id), BOB));
        (bytes memory ret,) =
            _measure("complete owner claim to fresh recipient", address(ledger), ALICE, data, 3_500_000);
        assertEq(abi.decode(ret, (uint256)), credit);
        assertEq(_balance(BOB), credit);
        assertEq(pm.balanceOf(address(ledger), uint160(box.q())), backing - credit);
        assertTrue(vm.revertToState(snap));
        // FINAL-M03: preserve full/half-cap checks at the measured linked-token release allowance.
        // Run both half and full proposed allowance, preserving the entire real PM payout path.
        uint256 originalCap = ledger.CLAIM_GAS();
        bytes memory original = release.implementations[16].code;
        for (uint256 divisor = 2; divisor != 0; --divisor) {
            assertTrue(vm.revertToState(snap));
            vm.etch(
                release.implementations[16],
                ClaimCap.replace(bytes.concat(original), originalCap, ClaimCap.PROPOSED / divisor, 2)
            );
            _measure(
                divisor == 2 ? "owner claim half proposed allowance" : "owner claim full proposed allowance",
                address(ledger),
                ALICE,
                data,
                3_500_000
            );
            assertEq(_balance(BOB), credit);
            assertEq(pm.balanceOf(address(ledger), uint160(box.q())), backing - credit);
        }
    }

    function test_claimLowGasAndExhaustionPreserveAllCredit() public {
        _exhaustion(false);
    }

    function test_proposedCapExhaustionPreservesAllCredit() public {
        _exhaustion(true);
    }

    function _exhaustion(bool proposed) private {
        _itemStart(0, true);
        uint256 id = _drawAndOpen();
        if (proposed) {
            vm.etch(
                release.implementations[16],
                ClaimCap.replace(release.implementations[16].code, ledger.CLAIM_GAS(), ClaimCap.PROPOSED, 2)
            );
        }
        (uint256 outside, uint256 stash) = ledger.itemCredit(id);
        uint256 credit = outside + stash;
        uint256 backing = pm.balanceOf(address(ledger), 0);
        bytes memory data = abi.encodeCall(IItemLedgerV2.claim, (_one(id), BOB));
        _cold();
        vm.prank(ALICE);
        (bool ok,) = address(ledger).call{gas: 250_000}(data);
        assertFalse(ok);
        vm.etch(BOB, hex"5b600056");
        _cold();
        vm.prank(ALICE);
        (ok,) = address(ledger).call{gas: 3_500_000}(data);
        assertFalse(ok);
        (outside, stash) = ledger.itemCredit(id);
        assertEq(outside + stash, credit);
        assertEq(pm.balanceOf(address(ledger), 0), backing);
        assertEq(BOB.balance, 0);
        _measure(
            "owner retry after recipient exhausts",
            address(ledger),
            ALICE,
            abi.encodeCall(IItemLedgerV2.claim, (_one(id), ALICE)),
            3_500_000
        );
        assertEq(ALICE.balance, credit);
    }
}
