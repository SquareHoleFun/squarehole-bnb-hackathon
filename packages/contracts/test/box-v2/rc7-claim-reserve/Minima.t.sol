// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ClaimReserveFixture} from "./ClaimReserve.t.sol";

/// Reporting controls stay green before and after RC7; every row measures both backgrounds.
contract ClaimReserveMinimaTest is ClaimReserveFixture {
    function _report(uint256 pKind, bool items, Action action) private {
        for (uint256 background; background < 2; ++background) {
            uint256 snap = vm.snapshotState();
            _prepare(pKind, items, action, background != 0);
            uint256 minimum = _minimum();
            (bool ok, bytes memory ret, uint256 used) = _send(minimum);
            if (!ok) _rethrow(ret);
            emit log_named_uint("router and receiver funded before estimate", background);
            emit log_named_uint("minimum submitted gas", minimum);
            emit log_named_uint("gross used gas", used);
            assertLt(minimum, TX_CAP);
            assertTrue(vm.revertToState(snap));
        }
    }
    function test_NativeMenuPartial() public { _report(0, false, Action.Partial); }
    function test_NativeMenuFinal() public { _report(0, false, Action.Final); }
    function test_NativeMenuCreator() public { _report(0, false, Action.Creator); }
    function test_NativeMenuFail() public { _report(0, false, Action.Fail); }
    function test_NativeMenuFailClosed() public { _report(0, false, Action.FailClosed); }
    function test_NativeMenuEmptyFail() public { _report(0, false, Action.EmptyFail); }
    function test_NativeMenuEmptyFailClosed() public { _report(0, false, Action.EmptyFailClosed); }
    function test_NativeItemsPartial() public { _report(0, true, Action.Partial); }
    function test_NativeItemsFinal() public { _report(0, true, Action.Final); }
    function test_NativeItemsCreator() public { _report(0, true, Action.Creator); }
    function test_NativeItemsFail() public { _report(0, true, Action.Fail); }
    function test_NativeItemsFailClosed() public { _report(0, true, Action.FailClosed); }
    function test_NativeItemsEmptyFail() public { _report(0, true, Action.EmptyFail); }
    function test_NativeItemsEmptyFailClosed() public { _report(0, true, Action.EmptyFailClosed); }
    function test_ERC20MenuPartial() public { _report(1, false, Action.Partial); }
    function test_ERC20MenuFinal() public { _report(1, false, Action.Final); }
    function test_ERC20MenuCreator() public { _report(1, false, Action.Creator); }
    function test_ERC20MenuFail() public { _report(1, false, Action.Fail); }
    function test_ERC20MenuFailClosed() public { _report(1, false, Action.FailClosed); }
    function test_ERC20MenuEmptyFail() public { _report(1, false, Action.EmptyFail); }
    function test_ERC20MenuEmptyFailClosed() public { _report(1, false, Action.EmptyFailClosed); }
    function test_ERC20ItemsPartial() public { _report(1, true, Action.Partial); }
    function test_ERC20ItemsFinal() public { _report(1, true, Action.Final); }
    function test_ERC20ItemsCreator() public { _report(1, true, Action.Creator); }
    function test_ERC20ItemsFail() public { _report(1, true, Action.Fail); }
    function test_ERC20ItemsFailClosed() public { _report(1, true, Action.FailClosed); }
    function test_ERC20ItemsEmptyFail() public { _report(1, true, Action.EmptyFail); }
    function test_ERC20ItemsEmptyFailClosed() public { _report(1, true, Action.EmptyFailClosed); }
    function test_LinkedMenuPartial() public { _report(2, false, Action.Partial); }
    function test_LinkedMenuFinal() public { _report(2, false, Action.Final); }
    function test_LinkedMenuCreator() public { _report(2, false, Action.Creator); }
    function test_LinkedMenuFail() public { _report(2, false, Action.Fail); }
    function test_LinkedMenuFailClosed() public { _report(2, false, Action.FailClosed); }
    function test_LinkedMenuEmptyFail() public { _report(2, false, Action.EmptyFail); }
    function test_LinkedMenuEmptyFailClosed() public { _report(2, false, Action.EmptyFailClosed); }
    function test_LinkedItemsPartial() public { _report(2, true, Action.Partial); }
    function test_LinkedItemsFinal() public { _report(2, true, Action.Final); }
    function test_LinkedItemsCreator() public { _report(2, true, Action.Creator); }
    function test_LinkedItemsFail() public { _report(2, true, Action.Fail); }
    function test_LinkedItemsFailClosed() public { _report(2, true, Action.FailClosed); }
    function test_LinkedItemsEmptyFail() public { _report(2, true, Action.EmptyFail); }
    function test_LinkedItemsEmptyFailClosed() public { _report(2, true, Action.EmptyFailClosed); }
}
