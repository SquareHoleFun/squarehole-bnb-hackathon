// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DepthKind, FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";
import {AuditU3ClaudeDeepenWatch, AuditU3DeepenRec} from "./AuditU3ClaudeDeepenWatch.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lens L6 (P3.13, BC-017, BC-133): box 0 when Uniswap's governance switches on the
/// v4 protocol fee for its pool (the PoolManager's owner names a fee controller, which sets up to 1,000 pips, 0.1%,
/// per direction; `ProtocolFees.sol`). Box 0's code reads the fee from Slot0 (`BoxSwapBounds.fees`); BC-017 says the
/// box's fees are "the 1% LP fee of every input net of any Uniswap protocol fee". Measured here: the pool keeps its
/// static 1% LP fee and its key; the swap fee becomes 10,990 pips, the LPs' part 9,990; `harvest` mints exactly the
/// fees v4 credits the hook's positions; the curve still closes at P1 and keeps its floor; `deepen()` keeps every
/// rule of the watch, and its conversion's fee note stays at or below what the box's positions earned from it.
/// The PoolManager here is the local one (`CoreBox0Kit`, owner `makeAddr("core.pmOwner")`); on mainnet the switch is
/// Uniswap governance's, not the box's.
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeProtocolFeeTest is AuditU3ClaudeBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint24 internal constant PROTOCOL_MAX = 1_000;
    address internal controller = makeAddr("audit.u3.protocolFeeController");

    /// @dev The switch: the owner names a controller, which sets `zeroForOne | oneForZero << 12` on box 0's pool.
    function _switchOn(uint24 zeroForOne, uint24 oneForZero) internal {
        address owner = makeAddr("core.pmOwner");
        (bool ok, bytes memory ret) = address(pm).staticcall(abi.encodeWithSignature("owner()"));
        require(ok && abi.decode(ret, (address)) == owner, "the local PoolManager's owner");
        vm.prank(owner);
        pm.setProtocolFeeController(controller);
        vm.prank(controller);
        pm.setProtocolFee(poolKey, (oneForZero << 12) | zeroForOne);
    }

    /// On the curve with the fee switched on at its maximum both ways: Slot0 keeps lpFee 10,000 and the key its static
    /// 1%; BoxSwapBounds reads swap fee 10,990 and LP share 9,990 per direction; a batch's harvest mints exactly what
    /// v4 owes the curve position (StateLibrary) while the PoolManager accrues the protocol's part; the closing buy
    /// still closes at exactly P1 and graduation seeds exactly BoxLayoutV1's layout.
    function testProperty_AUDIT_U3_protocolFeeOnTheCurve() public {
        _toBonding();
        _switchOn(PROTOCOL_MAX, PROTOCOL_MAX);
        (,, uint24 protocolFee, uint24 lpFee) = pm.getSlot0(poolKey.toId());
        assertEq(lpFee, 10_000, "the LP fee stays the static 1%");
        assertEq(protocolFee, (uint24(PROTOCOL_MAX) << 12) | PROTOCOL_MAX);
        for (uint256 dir; dir < 2; ++dir) {
            (uint24 swapFee, uint24 lpShare) = bounds.fees(pm, _stateSlot(), dir == 0);
            assertEq(swapFee, 10_990, "1% + 0.1% - 1% x 0.1%");
            assertEq(lpShare, 9_990, "the LPs' part");
        }
        uint256 pq0 = pm.protocolFeesAccrued(Currency.wrap(address(0)));
        uint256 pt0 = pm.protocolFeesAccrued(Currency.wrap(a.token));
        uint256 t = _buy(eoa[3], 0.4 ether);
        _sell(eoa[3], t / 2);
        _buy(eoa[4], 0.3 ether);
        _advance(2);
        (uint256 oq, uint256 ot) = _owedAll();
        vm.recordLogs();
        _collect(keeper, keeper);
        (uint256 hq, uint256 ht) = _harvested(vm.getRecordedLogs());
        assertEq(hq, oq, "harvest mints exactly the Q v4 owes the curve");
        assertEq(ht, ot, "and exactly the T");
        uint256 pq = pm.protocolFeesAccrued(Currency.wrap(address(0))) - pq0;
        uint256 pt = pm.protocolFeesAccrued(Currency.wrap(a.token)) - pt0;
        emit log_named_uint("protocol's Q part of 0.7 ETH of buys (wei)", pq);
        emit log_named_uint("box's Q fees of the same buys (wei)", hq);
        emit log_named_uint("protocol's T part of the sale (raw)", pt);
        assertGt(pq, 0);
        assertGt(pt, 0);
        assertApproxEqRel(hq, pq * 9_990 / 1_000, 0.01e18, "the box keeps ~9.99x the protocol's part");
        // The close and the graduation are unchanged by the switch.
        _buyTo(eoa[2], 3 * raise, curve.sqrtPriceLowerX96);
        assertTrue(hook.closed());
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96, "closed at exactly P1");
        uint256 share = token.balanceOf(a.coordinator);
        _warpTo(_requestTimeFor(r0));
        _graduate(keeper);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        uint256 qCurve = raise;
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, qCurve, share);
        assertEq(ask, g.ask.liquidity, "the ask");
        assertEq(bid, g.bid.liquidity, "the bid");
        assertEq(sentinel, g.sentinel.liquidity, "the sentinel");
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96);
        _assertGhostLedger();
    }

    /// After graduation with the fee on, with the fee off as the control (the same world, reverted between): the first
    /// deepen converts and the second pairs, each keeping every rule of the watch (minimum output at the 10,990-pip
    /// swap fee, the fee note `feeNote(qIn, 9,990)`, the cap, the tip); the conversion's note is at most the Q v4
    /// credited the box's positions for that swap (BC-133 "never more than the box's positions earned"), and the next
    /// batch returns it whole to the hook's claims.
    function testProperty_AUDIT_U3_protocolFeeOnTheDepth() public {
        _toBonding();
        _buy(whale, 0.5 ether);
        _toGraduated();
        vm.prank(keeper);
        launchRouter.sweep();
        _advance(300);
        AuditU3ClaudeDeepenWatch watch = new AuditU3ClaudeDeepenWatch(pm, hook, executor, receiver);
        uint256 snap = vm.snapshotState();
        for (uint256 on; on < 2; ++on) {
            vm.revertToState(snap);
            if (on == 1) _switchOn(PROTOCOL_MAX, PROTOCOL_MAX);
            (uint256 oq0,) = _owedAll();
            AuditU3DeepenRec memory r = _watched(watch);
            assertEq(r.kind, uint8(DepthKind.Convert));
            (uint256 oq1,) = _owedAll();
            uint256 earned = oq1 - oq0;
            uint256 note = r.note1 - r.note0;
            emit log_named_string("protocol fee", on == 1 ? "on (0.1% each way)" : "off");
            emit log_named_uint("  conversion Q in (wei)", r.qIn);
            emit log_named_uint("  Q the positions earned from it (wei)", earned);
            emit log_named_uint("  fee note (wei)", note);
            emit log_named_uint("  earned - note (wei)", earned - note);
            assertLe(note, earned, "the note never above what the positions earned");
            assertLe(earned - note, 2 * 4 + 2, "below it by the note's slack (2 x SLACK) and flooring only");
            _advance(300);
            r = _watched(watch);
            assertEq(r.kind, uint8(DepthKind.Pair), "the pair follows");
            _buy(eoa[3], 0.6 ether);
            _advance(2);
            uint256 pending = receiver.hookFeesPending();
            assertGt(pending, 0);
            (uint256 q0,) = _hookClaims();
            vm.recordLogs();
            FeeBatch memory b = _collect(keeper, keeper);
            (uint256 hookBack, uint256 qDepth) = _returned(vm.getRecordedLogs());
            (uint256 q1,) = _hookClaims();
            assertEq(hookBack, pending, "the notes come back whole");
            assertEq(q1 - q0, hookBack + qDepth, "and only they and the depth parts reach the hook");
            assertGt(b.q, hookBack);
        }
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _watched(AuditU3ClaudeDeepenWatch watch) internal returns (AuditU3DeepenRec memory r) {
        uint256 e0 = keeper.balance;
        r = watch.deepenAs(keeper, keeper);
        _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
        (uint8 code, string memory why) = watch.violation(r);
        assertEq(code, 0, why);
    }

    /// @dev The `Harvested` event's (qFees, tFees).
    function _harvested(VmSafe.Log[] memory logs) internal view returns (uint256 q, uint256 t) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.Harvested.selector) {
                (q, t,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return (q, t);
            }
        }
        revert("no Harvested event");
    }

    /// @dev The receiver's hook note returned and the Q depth parts moved to the hook in `logs`.
    function _returned(VmSafe.Log[] memory logs) internal view returns (uint256 hookBack, uint256 qDepth) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver) continue;
            if (logs[i].topics[0] == IBoxReceiver.ModuleFeesReturned.selector) {
                (,, hookBack) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            } else if (logs[i].topics[0] == IBoxReceiver.DepthFunded.selector) {
                (uint256 dq,) = abi.decode(logs[i].data, (uint256, uint256));
                qDepth += dq;
            }
        }
    }
}
