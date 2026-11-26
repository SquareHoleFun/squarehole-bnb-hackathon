// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Round2RemainingExitsTest} from "../final/round2/money/RemainingExits.t.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

contract StipendSink {
    fallback() external payable { assembly { invalid() } }
}

/// Real production entry points, submitted gas including intrinsic below EIP-7825 even on exhaustion.
contract StipendEnvelopesTest is Round2RemainingExitsTest {
    uint256 private constant TX_CAP = 16_777_216;

    function _cold(BoxTokenV2 asset) private {
        address p = box.q();
        address[24] memory parts;
        for (uint256 i; i < 24; ++i) parts[i] = box.roleAddress(i);
        for (uint256 i; i < 24; ++i) {
            if (parts[i] != address(0)) vm.cool(parts[i]);
            address impl = release.implementations[i];
            if (impl != address(0)) {
                address helper = vm.computeCreateAddress(impl, 1);
                if (helper.code.length != 0) vm.cool(helper);
                // SH-V21-00-ROOM: the receiver callback is constructor child 2.
                if (i == 5) vm.cool(vm.computeCreateAddress(impl, 2));
                vm.cool(impl);
            }
        }
        vm.cool(address(pm)); vm.cool(address(asset)); vm.cool(conversionSafe);
        if (p != address(0)) vm.cool(p);
    }

    function _call(address target, address caller, bytes memory data, uint256 limit)
        private returns (bytes memory ret, uint256 used)
    {
        assertLe(limit, TX_CAP);
        vm.prank(caller); uint256 start = gasleft();
        bool ok;
        (ok, ret) = target.call{gas: limit - GasBudget.intrinsic(data)}(data);
        used = GasBudget.transaction(start - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        assertLt(used, limit);
        emit log_named_uint("submitted transaction envelope", limit);
        emit log_named_uint("gross transaction gas", used);
    }

    /// Minimum submitted gas, including intrinsic, with cold state restored for every probe.
    function _minimum(address caller, bytes memory data) private returns (uint256 high) {
        uint256 low = GasBudget.intrinsic(data);
        high = TX_CAP - 1;
        uint256 snap = vm.snapshotState();
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            _cold(token); vm.prank(caller);
            (bool ok,) = address(box).call{gas: mid - GasBudget.intrinsic(data)}(data);
            if (ok) high = mid; else low = mid;
            assertTrue(vm.revertToState(snap));
        }
        _cold(token);
        _call(address(box), caller, data, high);
        emit log_named_uint("minimum submitted gas", high);
        assertLt(high, TX_CAP, "minimum includes every reserved allowance and intrinsic gas");
    }

    function test_RC5_foreignIntakeHasNoRetryEnvelope() public {
        _royaltyReady();
        uint256 beforeBalance = address(receiver).balance;
        (bool ok,) = address(receiver).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(0xDEAD), 1));
        assertFalse(ok, "RC5: receiver accepts only P");
        assertEq(address(receiver).balance, beforeBalance);
    }

    function test_buyBackBurnAndRetryEnvelopesDoNotSpendMoreP() public {
        _holdersAndBurn();
        uint256 supply = token.totalSupply();
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), "hold purchased T");
        _cold(token);
        _call(address(receiver), address(this), abi.encodeCall(receiver.buyBack, (address(0xBABE))), 8_000_000);
        uint256 pending = receiver.tBurnPending(); assertGt(pending, 0);
        assertEq(token.totalSupply(), supply);
        uint256 budget = receiver.buyBackP(); uint256 backing = pm.balanceOf(address(receiver), 0);
        vm.clearMockedCalls(); _cold(token);
        (bool ok,) = address(receiver).call{gas: 1_000_000}(abi.encodeCall(receiver.burnPending, ()));
        assertFalse(ok, "burn allowance plus EIP-150 reserve is mandatory");
        assertEq(receiver.tBurnPending(), pending);
        _cold(token);
        _call(address(receiver), address(this), abi.encodeCall(receiver.burnPending, ()), 1_500_000);
        assertEq(receiver.tBurnPending(), 0); assertEq(token.totalSupply(), supply - pending);
        assertEq(token.balanceOf(address(receiver)), 0);
        assertEq(receiver.buyBackP(), budget); assertEq(pm.balanceOf(address(receiver), 0), backing);
    }

    function test_failureCarriesAllExhaustedAllowancesUnderTransactionCap() public {
        BoxSpec memory s = _menu(2, 3);
        s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _buy(box.raise() / 10);
        vm.prank(address(buyer)); token.transfer(address(0xA11CE), 1 ether);
        vm.warp(box.deadline());
        StipendSink sink = new StipendSink();
        vm.mockFunction(address(token), address(sink), abi.encodeWithSignature("burn(uint256)"));
        vm.mockFunction(box.launchRouter(), address(sink), abi.encodeWithSignature("sweep()"));
        vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
        _cold(token);
        (, uint256 used) = _call(address(box), address(sink), abi.encodeCall(box.fail, ()), TX_CAP - 1);
        assertTrue(box.failed());
        assertGt(used, 2 * C.BURN_GAS + C.SWEEP_GAS + C.INBOX_SWEEP_GAS + C.TIP_GAS,
            "all five bounded hostile calls actually spend their allowances");
        (, uint256 left) = box.claimState(); assertGt(left, 0);
        vm.clearMockedCalls();
        uint256 amount = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.approve(address(box), amount);
        _cold(token);
        _minimum(address(buyer), abi.encodeCall(box.claim, (amount, address(buyer))));
        (, uint256 afterLeft) = box.claimState(); assertEq(afterLeft, left - amount);
    }

    function test_RR_claimMinimumGasWithEmptyInbox() public { _claimMinimum(false, false); }
    function test_RR_claimMinimumGasWithSinkingInbox() public { _claimMinimum(false, true); }
    function test_RR_erc20ClaimMinimumGasWithEmptyInbox() public { _claimMinimum(true, false); }
    function test_RR_erc20ClaimMinimumGasWithSinkingInbox() public { _claimMinimum(true, true); }

    function _claimMinimum(bool erc20, bool sinking) private {
        BoxSpec memory s;
        if (erc20) (s,) = _priceSpec(2, 3, 18);
        else s = _menu(2, 3);
        _start(s); _buy(box.raise() / 10);
        vm.warp(box.deadline()); box.fail();
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.approve(address(box), held);
        if (sinking) {
            StipendSink sink = new StipendSink();
            vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
            vm.mockFunction(box.launchRouter(), address(sink), abi.encodeWithSignature("sweep()"));
            vm.mockFunction(box.receiver(), address(sink), abi.encodeWithSignature("collect(address)"));
            vm.mockFunction(address(token), address(sink), abi.encodeWithSignature("burn(uint256)"));
        }
        _minimum(address(buyer), abi.encodeCall(box.claim, (held / 2, address(buyer))));
        _minimum(address(buyer), abi.encodeCall(box.claim, (held - held / 2, address(buyer))));
        (, uint256 left) = box.claimState(); assertEq(left, 0);
    }

    function test_RR_creatorMinimumGasWithEmptyInbox() public { _creatorMinimum(false, false); }
    function test_RR_creatorMinimumGasWithSinkingInbox() public { _creatorMinimum(false, true); }
    function test_RR_erc20CreatorMinimumGasWithEmptyInbox() public { _creatorMinimum(true, false); }
    function test_RR_erc20CreatorMinimumGasWithSinkingInbox() public { _creatorMinimum(true, true); }

    function _creatorMinimum(bool erc20, bool sinking) private {
        BoxSpec memory s;
        if (erc20) (s,) = _priceSpec(2, 3, 18);
        else s = _spec();
        _start(s); vm.warp(box.deadline()); box.fail();
        if (sinking) {
            StipendSink sink = new StipendSink();
            vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
            vm.mockFunction(box.launchRouter(), address(sink), abi.encodeWithSignature("sweep()"));
            vm.mockFunction(box.receiver(), address(sink), abi.encodeWithSignature("collect(address)"));
        }
        uint256 expected = box.quoteClaim(0);
        _minimum(CREATOR, abi.encodeCall(box.claim, (0, CREATOR)));
        assertGt(expected, 0);
        (uint256 pot,) = box.claimState(); assertEq(pot, 0);
    }

    function test_graduationAndDeepenEnvelopes() public {
        BoxSpec memory s = _menu(2, 3);
        s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _fill();
        vm.prank(address(buyer)); token.transfer(address(0xA11CE), 1 ether);
        _cold(token); _call(address(box), address(this), abi.encodeCall(box.graduate, ()), 12_000_000);
        assertTrue(box.graduated());
        vm.roll(block.number + 1); _cold(token);
        _call(address(hook), address(this), abi.encodeCall(hook.deepen, (address(0xBABE))), 8_000_000);
        assertEq(hook.lastProtocolBlock(), block.number);
    }
}
