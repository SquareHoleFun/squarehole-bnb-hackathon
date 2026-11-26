// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// HP-1/HP-2: real trades/collects, cold accounts and storage, no injected fee sources.
contract ValuedPageTest is M261Harness {
    using StateLibrary for IPoolManager;
    uint256 private first;
    uint256 private realSource;
    uint256 private minimum;

    function _page(uint256 count, bool medium) private {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        _trade(true, box.raise() / 2, true); receiver.collect(address(0));
        first = hook.currentTradeBatch(false);
        minimum = factory.boxQParameters(1, box.raise()).swapStepMinQ;
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        uint256 value = medium ? minimum / 45 : 11;
        uint256 sale = FullMath.mulDiv(100 * value, uint256(spot) * spot, 1 << 192);
        if (!medium) sale += 100;
        for (uint256 i; i < count; ++i) {
            _trade(false, sale, true); receiver.collect(address(0));
        }
        realSource = hook.currentTradeBatch(false);
        sale = FullMath.mulDiv(100 * 2 * minimum, uint256(spot) * spot, 1 << 192);
        _trade(false, sale, true); receiver.collect(address(0));
        vm.roll(block.number + 1);
        (spot,,,) = pm.getSlot0(hook.poolId());
        uint256 queued;
        for (uint256 i; i < count; ++i) {
            uint256 pending = hook.tradeBatchPendingT(first + 2 * i);
            uint256 worth = Bounds.tInQAtSqrt(pending, spot);
            assertGe(worth, 1, "each small source is individually valued at the sale spot");
            if (!medium) assertLe(worth, 13, "a few raw P per source");
            queued += pending;
        }
        assertLt(Bounds.tInQAtSqrt(queued, spot), minimum, "small sources together remain below STEP_MIN_Q");
        emit log_named_uint("first small source value", Bounds.tInQAtSqrt(hook.tradeBatchPendingT(first), spot));
        emit log_named_uint("STEP_MIN_Q", minimum);
    }

    function _amsterdam() private returns (bool) {
        bytes memory init = hex"6104006000f3";
        uint256 probe = gasleft();
        assembly ("memory-safe") { pop(create(0, add(init, 32), mload(init))) }
        return probe - gasleft() > 500_000;
    }

    function _press(bool exhaustTip) private returns (uint256 used, uint256 out) {
        if (exhaustTip) {
            vm.etch(address(0xBADD), hex"5b600056");
            HostileToken(box.q()).armReentry(address(0xBADD), "");
        }
        address target = address(hook);
        bytes memory data = abi.encodeWithSignature("sellFees()");
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address implementation = release.implementations[i]; if (implementation != address(0)) vm.cool(implementation);
        }
        vm.cool(box.q()); vm.cool(address(pm));
        uint256 g = gasleft();
        (bool ok, bytes memory returned) = target.call{gas: 16_000_000}(data);
        used = GasBudget.transaction(g - gasleft(), data);
        assertTrue(ok);
        (ProtocolSkip skip,, uint256 pOut, uint256 tip) = abi.decode(returned, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertGt(pOut, 0);
        if (exhaustTip) assertEq(tip, 0); else assertGt(tip, 0);
        emit log_named_uint(exhaustTip ? "cold exhausted-tip transaction gas" : "cold paid-tip transaction gas", used);
        emit log_named_uint("P out", pOut);
        return (used, pOut);
    }

    function _check(uint256 count, bool medium, bool exhaustTip) private {
        _page(count, medium);
        bool amsterdam = _amsterdam();
        uint256 next = hook.tradeBatchPendingT(first + 64);
        uint256 realBefore = hook.tradeBatchPendingT(realSource);
        (uint256 used, uint256 out) = _press(exhaustTip);
        uint256 cleared = count < 32 ? count : 32;
        for (uint256 i; i < cleared; ++i) {
            assertEq(hook.tradeBatchPendingT(first + 2 * i), 0, "every selected small source clears");
            assertGt(hook.tradeBatch(first + 2 * i).netP, 0, "each consumed source receives P");
        }
        if (count < 32) assertEq(hook.tradeBatchPendingT(realSource), 0, "real source behind the small sources clears");
        else {
            assertEq(hook.tradeBatchPendingT(first + 64), next, "the 33rd source is untouched");
            assertEq(hook.tradeBatchPendingT(realSource), realBefore, "value beyond 32 sources waits");
            if (!medium) assertLt(out, minimum / 100, "keeper still classifies the bounded page as unblocking");
        }
        if (count == 40) {
            uint256 expected = exhaustTip ? (amsterdam ? 7_666_387 : 3_999_814) : (amsterdam ? 5_173_855 : 1_489_595);
            assertEq(used, expected, "cold 32-valued-source transaction gas pin");
        }
        if (exhaustTip) assertLe(2 * used, amsterdam ? 16_000_000 : 8_200_000, "fork's keeper floor retains 2x margin");
    }

    function test_sixteenValuedSourcesPaidTip() public { _check(16, false, false); }
    function test_sixteenValuedSourcesExhaustedTip() public { _check(16, false, true); }
    function test_thirtyOneValuedSourcesPaidTip() public { _check(31, false, false); }
    function test_thirtyOneValuedSourcesExhaustedTip() public { _check(31, false, true); }
    function test_fortyValuedSourcesPaidTip() public { _check(40, false, false); }
    function test_fortyValuedSourcesExhaustedTip() public { _check(40, false, true); }
    function test_mediumPagePaidTip() public { _check(32, true, false); }
    function test_mediumPageExhaustedTip() public { _check(32, true, true); }
}
