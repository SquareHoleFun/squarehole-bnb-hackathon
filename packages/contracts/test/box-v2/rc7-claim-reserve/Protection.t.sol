// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ClaimReserveFixture} from "./ClaimReserve.t.sol";
import {StipendSink} from "../stipends/Envelopes.t.sol";

contract ClaimReserveProtectionTest is ClaimReserveFixture {
    function test_nativeMenuFinalShareWaits() public { _waits(0, false); }
    function test_nativeItemsFinalShareWaits() public { _waits(0, true); }
    function test_erc20MenuFinalShareWaits() public { _waits(1, false); }
    function test_erc20ItemsFinalShareWaits() public { _waits(1, true); }
    function test_linkedMenuFinalShareWaits() public { _waits(2, false); }
    function test_linkedItemsFinalShareWaits() public { _waits(2, true); }

    function _waits(uint256 pKind, bool items) private {
        _prepare(pKind, items, Action.Final, true);
        _fund(box.royaltyRouter(), 1);
        StipendSink sink = new StipendSink();
        vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
        bytes32 beforeState = _state();
        (uint256 pot, uint256 left) = box.claimState();
        (bool ok, bytes memory ret,) = _send(TX_CAP - 1);
        assertFalse(ok);
        assertEq(bytes4(ret), bytes4(keccak256("ClaimFailed()")));
        assertEq(_state(), beforeState);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot); assertEq(afterLeft, left);
        assertEq(_inboxBalance(), 1, "blocked P and the final holder's T stay put");
        vm.mockFunction(box.royaltyRouter(), box.royaltyRouter(), abi.encodeWithSignature("sweepPriceCoin()"));
        (ok, ret,) = _send(TX_CAP - 1);
        if (!ok) _rethrow(ret);
        assertEq(_inboxBalance(), 0);
        (, afterLeft) = box.claimState(); assertEq(afterLeft, 0);
    }
}
