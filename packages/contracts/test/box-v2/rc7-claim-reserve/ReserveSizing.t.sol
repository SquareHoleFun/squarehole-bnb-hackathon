// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ClaimReserveFixture} from "./ClaimReserve.t.sol";
import {StipendSink} from "../stipends/Envelopes.t.sol";
import {ClaimCap} from "../gas/m3/ClaimCap.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// Measure a conservative post-sweep requirement without copying production source.
/// Only this measurement disables the new admission reserve, then finds the cold minimum
/// with an exhausted 3.2M inbox. At that minimum, an otherwise identical bytecode copy
/// with a 12M inbox stipend refuses at the inbox guard and exposes its gasleft in GasTooLow.
/// Subtract only the exhausted 3.2M: keeping the guard and CALL overhead overstates the tail.
/// ClaimCap replaces exactly one PUSH3 per literal and preserves all other instructions/immutables.
/// Production success/race assertions live in ClaimReserve.t.sol and never patch the coordinator.
contract ClaimReserveSizingTest is ClaimReserveFixture {
    function test_reservePinsAtLeastTenPercentAboveMeasuredAmsterdamTail() public pure {
        assertEq(C.INBOX_SWEEP_RESERVE_GAS, EXPECTED_RESERVE);
        assertGe(C.INBOX_SWEEP_RESERVE_GAS * 10, 3_508_198 * 11, "measured cold linked-P tail including guard/CALL overhead");
    }

    function _measureTail(uint256 pKind, bool items, Action action) private {
        for (uint256 background; background < 2; ++background) {
            uint256 initial = vm.snapshotState();
            _prepare(pKind, items, action, background != 0);
            address impl = release.implementations[0];
            bytes memory withoutReserve = ClaimCap.replace(impl.code, C.INBOX_SWEEP_RESERVE_GAS, 0, 1);
            vm.etch(impl, withoutReserve);
            StipendSink sink = new StipendSink();
            vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
            uint256 minimum = _minimum();
            uint256 probe = vm.snapshotState();
            (bool ok, bytes memory ret, uint256 used) = _send(minimum);
            if (!ok) _rethrow(ret);
            assertGt(used, C.INBOX_SWEEP_GAS, "the inbox spends its entire allowance");
            assertTrue(vm.revertToState(probe));
            (ok,,) = _send(minimum - 1); assertFalse(ok, "tail minimum is exact");
            assertTrue(vm.revertToState(probe));
            vm.etch(impl, ClaimCap.replace(withoutReserve, C.INBOX_SWEEP_GAS, 12_000_000, 1));
            (ok, ret,) = _send(minimum);
            assertFalse(ok);
            assertEq(bytes4(ret), bytes4(keccak256("GasTooLow(uint256,uint256)")));
            uint256 left; uint256 required;
            assembly ("memory-safe") { left := mload(add(ret, 36)) required := mload(add(ret, 68)) }
            assertEq(required, uint256(12_000_000) + uint256(12_000_000) / 63 + C.POKE_OVERHEAD_GAS);
            uint256 tail = left - C.INBOX_SWEEP_GAS;
            emit log_named_uint("router and receiver funded before estimate", background);
            emit log_named_uint("post-sweep gas needed, conservative upper bound", tail);
            assertLe(tail, 3_636_363, "STOP: measured tail needs more than the authorized 4M reserve");
            assertGe(C.INBOX_SWEEP_RESERVE_GAS * 10, tail * 11, "at least a tenth above measured need");
            vm.mockFunction(box.royaltyRouter(), box.royaltyRouter(), abi.encodeWithSignature("sweepPriceCoin()"));
            assertTrue(vm.revertToState(initial));
        }
    }
    function test_NativeMenuPartialTail() public { _measureTail(0, false, Action.Partial); }
    function test_NativeMenuFinalTail() public { _measureTail(0, false, Action.Final); }
    function test_NativeMenuCreatorTail() public { _measureTail(0, false, Action.Creator); }
    function test_NativeMenuFailTail() public { _measureTail(0, false, Action.Fail); }
    function test_NativeMenuFailClosedTail() public { _measureTail(0, false, Action.FailClosed); }
    function test_NativeMenuEmptyFailTail() public { _measureTail(0, false, Action.EmptyFail); }
    function test_NativeMenuEmptyFailClosedTail() public { _measureTail(0, false, Action.EmptyFailClosed); }
    function test_NativeItemsPartialTail() public { _measureTail(0, true, Action.Partial); }
    function test_NativeItemsFinalTail() public { _measureTail(0, true, Action.Final); }
    function test_NativeItemsCreatorTail() public { _measureTail(0, true, Action.Creator); }
    function test_NativeItemsFailTail() public { _measureTail(0, true, Action.Fail); }
    function test_NativeItemsFailClosedTail() public { _measureTail(0, true, Action.FailClosed); }
    function test_NativeItemsEmptyFailTail() public { _measureTail(0, true, Action.EmptyFail); }
    function test_NativeItemsEmptyFailClosedTail() public { _measureTail(0, true, Action.EmptyFailClosed); }
    function test_ERC20MenuPartialTail() public { _measureTail(1, false, Action.Partial); }
    function test_ERC20MenuFinalTail() public { _measureTail(1, false, Action.Final); }
    function test_ERC20MenuCreatorTail() public { _measureTail(1, false, Action.Creator); }
    function test_ERC20MenuFailTail() public { _measureTail(1, false, Action.Fail); }
    function test_ERC20MenuFailClosedTail() public { _measureTail(1, false, Action.FailClosed); }
    function test_ERC20MenuEmptyFailTail() public { _measureTail(1, false, Action.EmptyFail); }
    function test_ERC20MenuEmptyFailClosedTail() public { _measureTail(1, false, Action.EmptyFailClosed); }
    function test_ERC20ItemsPartialTail() public { _measureTail(1, true, Action.Partial); }
    function test_ERC20ItemsFinalTail() public { _measureTail(1, true, Action.Final); }
    function test_ERC20ItemsCreatorTail() public { _measureTail(1, true, Action.Creator); }
    function test_ERC20ItemsFailTail() public { _measureTail(1, true, Action.Fail); }
    function test_ERC20ItemsFailClosedTail() public { _measureTail(1, true, Action.FailClosed); }
    function test_ERC20ItemsEmptyFailTail() public { _measureTail(1, true, Action.EmptyFail); }
    function test_ERC20ItemsEmptyFailClosedTail() public { _measureTail(1, true, Action.EmptyFailClosed); }
    function test_LinkedMenuPartialTail() public { _measureTail(2, false, Action.Partial); }
    function test_LinkedMenuFinalTail() public { _measureTail(2, false, Action.Final); }
    function test_LinkedMenuCreatorTail() public { _measureTail(2, false, Action.Creator); }
    function test_LinkedMenuFailTail() public { _measureTail(2, false, Action.Fail); }
    function test_LinkedMenuFailClosedTail() public { _measureTail(2, false, Action.FailClosed); }
    function test_LinkedMenuEmptyFailTail() public { _measureTail(2, false, Action.EmptyFail); }
    function test_LinkedMenuEmptyFailClosedTail() public { _measureTail(2, false, Action.EmptyFailClosed); }
    function test_LinkedItemsPartialTail() public { _measureTail(2, true, Action.Partial); }
    function test_LinkedItemsFinalTail() public { _measureTail(2, true, Action.Final); }
    function test_LinkedItemsCreatorTail() public { _measureTail(2, true, Action.Creator); }
    function test_LinkedItemsFailTail() public { _measureTail(2, true, Action.Fail); }
    function test_LinkedItemsFailClosedTail() public { _measureTail(2, true, Action.FailClosed); }
    function test_LinkedItemsEmptyFailTail() public { _measureTail(2, true, Action.EmptyFail); }
    function test_LinkedItemsEmptyFailClosedTail() public { _measureTail(2, true, Action.EmptyFailClosed); }
}
