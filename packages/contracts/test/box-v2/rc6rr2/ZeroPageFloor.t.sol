// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// RC6RR2-KEEPER-1 (second release review): our keeper signs a simulated zero-P `sellFees` press at its own lower floor,
/// `ZERO_OUTPUT_FLOOR`, instead of the 8M/16M floor that covers a paid or exhausted tip. A zero-P page pays no tip, so no
/// TIP_GAS stipend is needed; a page that turns positive by inclusion needs that stipend: at this limit it either runs
/// exactly as at the positive-P floor (the stipend fit) or reverts whole, never a partial press. The dust head is built as rc6/DustHeadKeeper.t.sol builds it: real
/// tiny sales, each closed by a public collect, with no storage injection.
contract ZeroPageFloorTest is M261Harness {
    using StateLibrary for IPoolManager;

    /// packages/keeper/src/gas.ts SELL_FEES_FLOORS.zeroOutput.
    uint256 internal constant ZERO_OUTPUT_FLOOR = 3_500_000;
    uint256 private firstDust;
    uint256 private realSource;

    function _dustHead(uint256 count, uint256 sale, uint256 realBuyDivisor) private {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0);
        _registerBuyer();
        firstDust = hook.currentTradeBatch(false);
        for (uint256 i; i < count; ++i) {
            _trade(false, sale, true); receiver.collect(address(0));
            (uint160 spot,,,) = pm.getSlot0(hook.poolId());
            assertEq(Bounds.tInQAtSqrt(hook.tradeBatchPendingT(firstDust + 2 * i), spot), 0, "each dust source is worth less than one raw P");
        }
        _trade(true, box.raise() / realBuyDivisor, true);
        realSource = hook.currentTradeBatch(false);
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        receiver.collect(address(0));
        vm.roll(block.number + 1);
    }

    function _coolEverything() private {
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address implementation = release.implementations[i]; if (implementation != address(0)) vm.cool(implementation);
        }
        vm.cool(box.q()); vm.cool(address(pm));
    }

    /// The keeper's transaction gas limit `limit` leaves the call `limit - intrinsic` (GasBudget's conservative rule).
    function _pressAt(uint256 limit) private returns (bool ok, bytes memory returned, uint256 used) {
        bytes memory data = abi.encodeWithSignature("sellFees()");
        uint256 g = gasleft();
        (ok, returned) = address(hook).call{gas: limit - GasBudget.intrinsic(data)}(data);
        used = GasBudget.transaction(g - gasleft(), data);
    }

    function test_cold32DustZeroPPressFitsTheZeroOutputFloorWithTwoTimesMargin() public {
        _dustHead(48, 1000, 20);
        uint256 snap = vm.snapshotState();
        (ProtocolSkip skip, uint256 tIn, uint256 pOut, uint256 tip) = hook.sellFees();
        vm.revertToState(snap);
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertGt(tIn, 0); assertEq(pOut, 0, "a zero-P page"); assertEq(tip, 0);
        _coolEverything();
        (bool ok, bytes memory returned, uint256 used) = _pressAt(ZERO_OUTPUT_FLOOR);
        assertTrue(ok, "the press runs at the zero-output floor");
        (skip, tIn, pOut, tip) = abi.decode(returned, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertEq(pOut, 0); assertEq(tip, 0);
        for (uint256 i; i < 32; ++i) assertEq(hook.tradeBatchPendingT(firstDust + 2 * i), 0, "the full 32-source page cleared");
        emit log_named_uint("cold 32-dust zero-P press transaction gas", used);
        assertLe(used * 2, ZERO_OUTPUT_FLOOR, "the zero-output floor keeps at least 2x the cold measurement");
    }

    /// The state a press changes: pending T, the FIFO's first dust source and the real one, the protocol mark, the
    /// receiver's P and the source journal's total.
    function _state() private view returns (bytes32) {
        return keccak256(abi.encode(hook.tFeesPending(), hook.tradeBatchPendingT(firstDust), hook.tradeBatchPendingT(realSource),
            hook.lastProtocolBlock(), pm.balanceOf(address(receiver), uint160(box.q())), hook.tradeBatchTotalP()));
    }

    function test_aPageThatTurnedPositiveRunsWholeOrRevertsWholeAtTheZeroOutputFloor() public {
        // Nine dust sources, then real fees: the page sells for P and pays a tip, so it needs the TIP_GAS stipend.
        _dustHead(9, 1e9, 20);
        // The price coin's callback burns whatever it is given (the exhausted-tip case of DustHeadKeeper).
        vm.etch(address(0xBADD), hex"5b600056");
        HostileToken(box.q()).armReentry(address(0xBADD), "");
        uint256 snap = vm.snapshotState();
        _coolEverything();
        (bool full, bytes memory expected,) = _pressAt(16_000_000);
        assertTrue(full, "the positive-P floor sells this page");
        (ProtocolSkip skip,, uint256 pOut,) = abi.decode(expected, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint8(skip), uint8(ProtocolSkip.None)); assertGt(pOut, 0, "this page sells for P");
        bytes32 after16 = _state();
        vm.revertToState(snap);
        bytes32 before = _state();
        _coolEverything();
        (bool ok, bytes memory returned,) = _pressAt(ZERO_OUTPUT_FLOOR);
        if (ok) {
            // The tip stipend fit: the press is the positive-P floor's press, result for result and effect for effect.
            assertEq(keccak256(returned), keccak256(expected), "the same result as at the positive-P floor");
            assertEq(_state(), after16, "the same effects as at the positive-P floor");
            emit log_string("at the zero-output floor this page ran whole, as at the positive-P floor");
        } else {
            // Refused at the tip stipend's pre-check, or out of gas after it: either way the whole press reverts.
            assertTrue(returned.length == 0 || bytes4(returned) == bytes4(keccak256("GasTooLow()")), "GasTooLow or out of gas");
            assertEq(_state(), before, "nothing changed");
            emit log_string(returned.length == 0 ? "at the zero-output floor this page ran out of gas whole"
                : "at the zero-output floor this page reverted whole (GasTooLow)");
        }
    }
}
