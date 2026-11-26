// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditRegressEventChecks, Vm} from "./EventChecks.sol";
import {BoxDepthConvertBase} from "../../../s45/BoxDepthConvertBase.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind} from "../../../../../src/box/interfaces/BoxTypes.sol";

/// Real hook/extension/PoolManager. The existing S45 coordinator and price average supply the phase/oracle inputs.
contract AuditRegressDepthEventsReviewTest is BoxDepthConvertBase, AuditRegressEventChecks {
    function setUp() public {
        _setUpConvertWorld();
    }

    function test_AR21_E11_E12_E13_depthConversionAndSkipEventFields() public {
        Box memory b = _graduated(true, true);
        _fundQ(b, 1 ether);
        _toAddable(b);
        Budget memory before = _budget(b);
        uint160 price = _sqrtP(b);
        int24 ref = _ref(b);
        vm.recordLogs();
        Deep memory d;
        (d.kind, d.skip, d.q, d.t, d.tip) = b.hook.deepen(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(d.kind), uint8(DepthKind.Convert));
        assertEq(uint8(d.skip), uint8(DeepenSkip.None));
        Budget memory afterBudget = _budget(b);
        assertEq(before.q - afterBudget.q, d.q + d.tip);
        assertEq(d.t, 0);
        bytes memory data = abi.encode(d.q, afterBudget.t - before.t, ref, price, _sqrtP(b), _limitOf(price, ref));
        _event(
            logs,
            address(b.hook),
            "DepthConverted(bytes32,uint256,uint256,int24,uint160,uint160,uint160)",
            abi.encode(b.hook.poolId()),
            data
        );
        _deepEvent(logs, b, d, uint128(0));
        vm.recordLogs();
        b.hook.deepen(keeper);
        logs = vm.getRecordedLogs();
        _event(
            logs,
            address(b.hook),
            "DeepenSkipped(bytes32,uint8)",
            abi.encode(b.hook.poolId()),
            abi.encode(DeepenSkip.Cooldown)
        );
        _noEvent(logs, address(b.hook), "DepthConverted(bytes32,uint256,uint256,int24,uint160,uint160,uint160)");
    }

    function test_AR21_E11_pairedDepthEventFields() public {
        Box memory b = _graduated(true, true);
        _fundQ(b, 1 ether);
        _fundT(b, _tFor(1 ether, _sqrtP(b)));
        _toAddable(b);
        uint128 beforeL = b.hook.pairedLiquidity();
        Budget memory before = _budget(b);
        uint256 keeperBefore = keeper.balance;
        vm.recordLogs();
        Deep memory d;
        (d.kind, d.skip, d.q, d.t, d.tip) = b.hook.deepen(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(d.kind), uint8(DepthKind.Pair));
        assertEq(uint8(d.skip), uint8(DeepenSkip.None));
        _deepEvent(logs, b, d, b.hook.pairedLiquidity() - beforeL);
        Budget memory afterBudget = _budget(b);
        assertEq(before.q - afterBudget.q, d.q + d.tip);
        assertEq(before.t - afterBudget.t, d.t);
        assertEq(keeper.balance - keeperBefore, d.tip);
    }

    function _deepEvent(Vm.Log[] memory logs, Box memory b, Deep memory d, uint128 liquidity) internal view {
        bool pair = d.kind == DepthKind.Pair;
        bytes memory data = abi.encode(
            d.kind,
            pair ? BoxSpecV1.MIN_USABLE_TICK : int24(0),
            pair ? BoxSpecV1.MAX_USABLE_TICK : int24(0),
            liquidity,
            d.q,
            d.t,
            d.tip
        );
        _event(
            logs,
            address(b.hook),
            "Deepened(bytes32,uint8,int24,int24,uint128,uint256,uint256,uint256)",
            abi.encode(b.hook.poolId()),
            data
        );
    }
}
