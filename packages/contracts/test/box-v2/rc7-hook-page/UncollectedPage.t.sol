// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// SH-V21-RC7-INT part 4 review (P4R-1): ValuedPage's 32-source pages, pressed after trades nobody has collected yet.
/// A keeper press normally follows such trades: the press's first poke then realizes their fees, credits the buy batch
/// and pushes a new FIFO source (three fresh slots), and a v4 protocol fee set on the pool adds its first accrual. These
/// presses cost more than ValuedPage's collected pages (4,000,007 / 7,666,580), so the keeper's 8,200,000 and
/// 16,000,000 floors keep less than twice them. Pinned here: each floor still admits the press, with at least 1.9 times
/// its least succeeding transaction limit, and a valued page signed at the zero-P floor reverts whole on either EVM.
contract UncollectedPageTest is M261Harness {
    using StateLibrary for IPoolManager;

    /// packages/keeper/src/gas.ts SELL_FEES_FLOORS.
    uint256 internal constant FLOOR_BEFORE_AMSTERDAM = 8_200_000;
    uint256 internal constant FLOOR_AMSTERDAM = 16_000_000;
    uint256 internal constant ZERO_OUTPUT_FLOOR = 3_500_000;

    function _page(uint256 count, bool medium, bool uncollected, bool protocolFee) private {
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        _trade(true, box.raise() / 2, true); receiver.collect(address(0));
        uint256 minimum = factory.boxQParameters(1, box.raise()).swapStepMinQ;
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        uint256 value = medium ? minimum / 45 : 11;
        uint256 sale = FullMath.mulDiv(100 * value, uint256(spot) * spot, 1 << 192);
        if (!medium) sale += 100;
        for (uint256 i; i < count; ++i) { _trade(false, sale, true); receiver.collect(address(0)); }
        sale = FullMath.mulDiv(100 * 2 * minimum, uint256(spot) * spot, 1 << 192);
        _trade(false, sale, true); receiver.collect(address(0));
        // One buy and one sale after the last collect: their fees wait for the press's own first poke.
        if (uncollected) { _trade(true, box.raise() / 1000, true); _trade(false, sale / 10, true); }
        // The pool's first T protocol fee then accrues in the press's own swap.
        if (protocolFee) { pm.setProtocolFeeController(address(this)); pm.setProtocolFee(hook.poolKey(), 1000 | (1000 << 12)); }
        vm.roll(block.number + 1);
        // The price coin's callback burns whatever it is given: the tip stipend is spent in full.
        vm.etch(address(0xBADD), hex"5b600056");
        HostileToken(box.q()).armReentry(address(0xBADD), "");
    }

    function _amsterdam() private returns (bool) {
        bytes memory init = hex"6104006000f3";
        uint256 probe = gasleft();
        assembly ("memory-safe") { pop(create(0, add(init, 32), mload(init))) }
        return probe - gasleft() > 500_000;
    }

    function _cool() private {
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address implementation = release.implementations[i]; if (implementation != address(0)) vm.cool(implementation);
        }
        vm.cool(box.q()); vm.cool(address(pm));
    }

    /// A cold press sent with transaction limit `limit` (the call gets `limit - intrinsic`, GasBudget's rule).
    function _pressAt(uint256 limit) private returns (bool ok, uint256 used) {
        bytes memory data = abi.encodeWithSignature("sellFees()");
        _cool();
        uint256 g = gasleft();
        bytes memory r;
        (ok, r) = address(hook).call{gas: limit - GasBudget.intrinsic(data)}(data);
        used = GasBudget.transaction(g - gasleft(), data);
        if (ok) {
            (ProtocolSkip skip,, uint256 pOut, uint256 tip) = abi.decode(r, (ProtocolSkip, uint256, uint256, uint256));
            ok = skip == ProtocolSkip.None && pOut > 0 && tip == 0;
        }
    }

    function _least(uint256 floor) private returns (uint256 hi) {
        uint256 lo = 2_000_000; hi = floor;
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = _pressAt(mid);
            vm.revertToState(snap);
            if (ok) hi = mid; else lo = mid;
        }
    }

    function _check(uint256 count, bool medium, bool protocolFee) private {
        _page(count, medium, true, protocolFee);
        uint256 floor = _amsterdam() ? FLOOR_AMSTERDAM : FLOOR_BEFORE_AMSTERDAM;
        uint256 least = _least(floor);
        uint256 snap = vm.snapshotState();
        (bool ok, uint256 used) = _pressAt(floor);
        assertTrue(ok, "the keeper's floor sells the page, tip stipend spent");
        vm.revertToState(snap);
        emit log_named_uint("cold exhausted-tip transaction gas", used);
        emit log_named_uint("least succeeding transaction limit (within 1,000)", least);
        emit log_named_uint("keeper floor", floor);
        assertGt(2 * used, floor, "P4R-1: this press costs more than half the floor");
        assertLe(least * 19, floor * 10, "the floor keeps at least 1.9 times the least succeeding limit");
    }

    function test_mediumPageAfterUncollectedTrades() public { _check(32, true, false); }
    function test_mediumPageAfterUncollectedTradesFirstProtocolFee() public { _check(32, true, true); }
    function test_fortySmallSourcesAfterUncollectedTrades() public { _check(40, false, false); }

    /// gas.ts: a page simulated at zero P is signed at 3.5M. A 32-valued page whose tip spends the stipend cannot run at
    /// that limit on either EVM (out of gas before Amsterdam, GasTooLow on it); the press reverts whole.
    function test_valuedPageAtTheZeroOutputFloorRevertsWhole() public {
        _page(40, false, false, false);
        bytes32 before = keccak256(abi.encode(hook.tFeesPending(), hook.lastProtocolBlock(), hook.tradeBatchTotalP(),
            pm.balanceOf(address(receiver), uint160(box.q()))));
        (bool ok,) = _pressAt(ZERO_OUTPUT_FLOOR);
        assertFalse(ok, "a 32-valued exhausted-tip page does not fit the zero-output floor");
        assertEq(keccak256(abi.encode(hook.tFeesPending(), hook.lastProtocolBlock(), hook.tradeBatchTotalP(),
            pm.balanceOf(address(receiver), uint160(box.q())))), before, "nothing changed");
    }
}
