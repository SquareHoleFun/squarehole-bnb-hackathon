// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234Base} from "../m2-34/Fixture.sol";
import {ReferenceChecks} from "./ReferenceChecks.sol";
import {BoxFactoryV2Checks} from "../../../src/box-v2/libraries/BoxFactoryV2Checks.sol";
import {FactoryChecksCurve} from "../../../src/box-v2/libraries/FactoryChecksCurve.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice SIZE-C3: real factory plans keep the complete original readback result and refusal order.
contract FactoryReadbacksTest is M234Base {
    address internal original;

    function setUp() public override {
        super.setUp();
        original = deployCode("ReferenceChecks.sol:ReferenceChecks");
    }

    function test_validPlainHolderAndChunkGatedPlans() public {
        _valid(_spec());
        _valid(_holders());
        _valid(_collectionSpec());
    }

    function test_validStarterGatedShopPlan() public {
        _valid(_shop(address(new HostileCollection()), bytes32(uint256(42)), 10, 100 ether));
    }

    function test_poolReadbackRefusalsMatchOriginal() public {
        BoxSpec memory s = _holders();
        (BoxFactoryV2Planner.Plan memory p, uint256 id) = _prepare(s);
        BoxLayoutV2.Curve memory curve = BoxLayoutV2.curve(s.raise, false);
        _refused(s, p, id, 2, "poolId()", abi.encode(bytes32(0)), 202);
        PoolKey memory key = IBoxHookV2(p.roles[2]).poolKey();
        key.tickSpacing += 1;
        _refused(s, p, id, 2, "poolKey()", abi.encode(key), 202);
        _refused(s, p, id, 2, "curve()", abi.encode(curve.tickLower + 1, curve.tickUpper, curve.liquidity), 202);
        _refused(s, p, id, 2, "curve()", abi.encode(curve.tickLower, curve.tickUpper - 1, curve.liquidity), 202);
        _refused(s, p, id, 2, "curve()", abi.encode(curve.tickLower, curve.tickUpper, curve.liquidity + 1), 202);
        _refused(s, p, id, 2, "raise()", abi.encode(s.raise + 1), 202);
        _refused(s, p, id, 2, "deployBlock()", abi.encode(block.number - 1), 202);
        _refused(s, p, id, 2, "openAt()", abi.encode(uint256(0)), 202);
        _refused(s, p, id, 2, "migratedAtBlock()", abi.encode(uint256(1)), 202);
        _refused(s, p, id, 2, "failed()", abi.encode(true), 202);
        _same(s, p, id, true, "");
    }

    function test_gateReadbackRefusalsMatchOriginal() public {
        BoxSpec memory s = _holders();
        (BoxFactoryV2Planner.Plan memory p, uint256 id) = _prepare(s);
        _refused(s, p, id, 0, "starterSetPending()", abi.encode(true), 1);
        _refused(s, p, id, 0, "gateOpen()", abi.encode(false), 1);
        _refused(s, p, id, 0, "effectiveOpenAt()", abi.encode(uint256(0)), 1);
        _refused(s, p, id, 0, "deadline()", abi.encode(uint256(0)), 1);
        _refused(s, p, id, 0, "graduated()", abi.encode(true), 1);
        _refused(s, p, id, 0, "failed()", abi.encode(true), 1);
    }

    function test_poolReadFailuresAndEarlierRefusalsKeepPrecedence() public {
        BoxSpec memory s = _spec();
        (BoxFactoryV2Planner.Plan memory p, uint256 id) = _prepare(s);
        bytes memory query = abi.encodeWithSignature("curve()");
        vm.mockCallRevert(p.roles[2], query, hex"12345678");
        _same(s, p, id, false, hex"12345678");
        vm.mockCall(p.roles[2], abi.encodeWithSignature("poolId()"), abi.encode(bytes32(0)));
        _same(s, p, id, false, abi.encodeWithSelector(BoxFactoryV2Checks.Miswired.selector, 202));
        vm.clearMockedCalls();
        vm.mockCall(p.roles[2], query, hex"01");
        _same(s, p, id, false, "");
    }

    function test_curveLibraryIsCalledStaticallyWithoutStorageOrFunds() public {
        BoxSpec memory s = _spec();
        (BoxFactoryV2Planner.Plan memory p, uint256 id) = _prepare(s);
        address helper = address(FactoryChecksCurve);
        vm.record();
        vm.startStateDiffRecording();
        factory.checks().verify(release, CREATOR, s, p, id);
        VmSafe.AccountAccess[] memory calls = vm.stopAndReturnStateDiff();
        uint256 found;
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].account != helper) continue;
            // Foundry includes its synthetic link deployment in the recording. Inspect every actual call.
            VmSafe.AccountAccessKind kind = calls[i].kind;
            if (kind != VmSafe.AccountAccessKind.Call && kind != VmSafe.AccountAccessKind.StaticCall
                && kind != VmSafe.AccountAccessKind.DelegateCall && kind != VmSafe.AccountAccessKind.CallCode) continue;
            assertEq(uint256(calls[i].kind), uint256(VmSafe.AccountAccessKind.StaticCall));
            assertEq(calls[i].accessor, address(factory.checks()));
            assertEq(calls[i].data, abi.encodeWithSignature("curve(uint256)", s.raise));
            assertEq(calls[i].value, 0);
            ++found;
        }
        assertEq(found, 1);
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(helper);
        assertEq(reads.length, 0);
        assertEq(writes.length, 0);
        assertEq(helper.balance, 0);
    }

    function _valid(BoxSpec memory s) private {
        (BoxFactoryV2Planner.Plan memory p, uint256 id) = _prepare(s);
        _same(s, p, id, true, "");
    }

    function _prepare(BoxSpec memory s) private returns (BoxFactoryV2Planner.Plan memory p, uint256 id) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        p = planner.plan(release, CREATOR, s, cs, hs);
        vm.prank(CREATOR);
        (id,,) = factory.createBox{value: p.payment}(s, cs, hs);
    }

    function _refused(
        BoxSpec memory s, BoxFactoryV2Planner.Plan memory p, uint256 id,
        uint256 role, string memory signature, bytes memory result, uint256 check
    ) private {
        vm.mockCall(p.roles[role], abi.encodeWithSignature(signature), result);
        _same(s, p, id, false, abi.encodeWithSelector(BoxFactoryV2Checks.Miswired.selector, check));
        vm.clearMockedCalls();
    }

    function _same(BoxSpec memory s, BoxFactoryV2Planner.Plan memory p, uint256 id, bool expected, bytes memory reason)
        private view
    {
        bytes memory input = abi.encodeCall(BoxFactoryV2Checks.verify, (release, CREATOR, s, p, id));
        (bool oldOK, bytes memory oldResult) = original.staticcall(input);
        (bool newOK, bytes memory newResult) = address(factory.checks()).staticcall(input);
        assertEq(oldOK, expected, "reference fixture reached wrong check");
        assertEq(oldResult, reason, "reference refusal changed");
        assertEq(newOK, oldOK, "check result changed");
        assertEq(newResult, oldResult, "readback revert bytes changed");
    }
}
