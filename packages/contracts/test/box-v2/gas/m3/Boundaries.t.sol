// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Items, MockDrandSource, IBoxVaultV2, IBoxVaultItemsV2} from "./Items.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";

/// Find the exact first attempted notice with a sink consuming the full production allowance.
/// Below the floor custody must roll back; at the floor the retained reserve must finish real custody.
contract M360BoundariesTest is M360Items {
    function test_placeholderRequestExhaustionBoundary() public {
        _boundary(0);
    }

    function test_placeholderReleaseExhaustionBoundary() public {
        _boundary(1);
    }

    function test_placeholderDeliveryExhaustionBoundary() public {
        _boundary(2);
    }

    function test_namedWithdrawExhaustionBoundary() public {
        _boundary(3);
    }

    function test_namedReturnExhaustionBoundary() public {
        _boundary(4);
    }

    function test_drawRequestExhaustionBoundary() public {
        _boundary(5);
    }

    function _boundary(uint256 op) private {
        (address target, bytes memory data) = _prepare(op);
        vm.etch(address(ledger), hex"5b600056");
        uint256 beforeCount = IBoxVaultItemsV2(address(vault)).itemLifecycleCount();
        uint256 beforeT = token.balanceOf(ALICE);
        uint256 low = 100_000;
        uint256 high = CUSTODY_LIMIT;
        while (high - low > 1) {
            uint256 snap = vm.snapshotState();
            uint256 mid = (low + high) / 2;
            (, bool attempted) = this.attempt(target, data, mid);
            if (attempted) high = mid;
            else low = mid;
            assertTrue(vm.revertToState(snap));
        }
        uint256 snapshot = vm.snapshotState();
        (bool ok, bool called) = this.attempt(target, data, low);
        assertFalse(called, "one gas below activation");
        assertFalse(ok, "low gas rolls back custody");
        assertEq(IBoxVaultItemsV2(address(vault)).itemLifecycleCount(), beforeCount);
        assertEq(token.balanceOf(ALICE), beforeT);
        assertTrue(vm.revertToState(snapshot));
        (ok, called) = this.attempt(target, data, high);
        assertTrue(called, "full stipend attempted");
        assertTrue(ok, "reserve finishes custody despite exhaustion");
        assertEq(IBoxVaultItemsV2(address(vault)).itemLifecycleCount(), beforeCount + 1);
        emit log_named_uint(string.concat("activation boundary ", vm.toString(op)), high);
        assertLt(high + 21_000, CUSTODY_LIMIT);
    }

    function _prepare(uint256 op) private returns (address target, bytes memory data) {
        _itemStart(0, op >= 3);
        target = address(tickets);
        if (op == 0) return (target, abi.encodeCall(IBoxTickets.take, (1, type(uint256).max, block.timestamp)));
        if (op < 3) {
            vm.prank(ALICE);
            uint256 placeholder = tickets.take(1, type(uint256).max, block.timestamp);
            if (op == 1) {
                return (target, abi.encodeCall(IBoxTickets.handBack, (_one(placeholder), 0, block.timestamp)));
            }
            box.graduate();
            receiver.collect(address(0));
            MockDrandSource(release.randomness).post(target, 0, keccak256("M360 boundary"));
            tickets.acceptGraduationWord();
            return (target, abi.encodeCall(IBoxTickets.open, (placeholder, _proof(tickets.numberOf(placeholder)))));
        }
        if (op == 5) return (target, abi.encodeCall(IBoxTickets.draw, (type(uint256).max, block.timestamp)));
        uint256 id = _drawAndOpen();
        target = address(vault);
        if (op == 4) return (target, abi.encodeCall(IBoxVaultV2.returnItem, (id, 0, block.timestamp)));
        vm.prank(ALICE);
        vault.returnItem(id, 0, block.timestamp);
        return (target, abi.encodeCall(IBoxVaultV2.withdraw, (id, type(uint256).max, block.timestamp)));
    }

    /// Test-only trace wrapper. All producer/consumer accounts and their storage are cold each attempt.
    function attempt(address target, bytes calldata data, uint256 limit) external returns (bool ok, bool called) {
        _cold();
        vm.cool(target);
        vm.cool(address(ledger));
        vm.startStateDiffRecording();
        vm.prank(ALICE);
        (ok,) = target.call{gas: limit}(data);
        VmSafe.AccountAccess[] memory trace = vm.stopAndReturnStateDiff();
        for (uint256 i; i < trace.length; ++i) {
            if (trace[i].account == address(ledger) && trace[i].kind == VmSafe.AccountAccessKind.Call) called = true;
        }
    }
}
