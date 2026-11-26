// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopFeesTest} from "../shop-fees/ShopFees.t.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ReceiverShopV21} from "../../../src/box-v2/libraries/ReceiverShopV21.sol";
import {GasBudget} from "../gas/GasBudget.sol";

contract FailFloorSink {
    fallback() external payable { assembly { invalid() } }
}

/// SH-V21-RC7-INT release review GK-1: the keeper's 15M `fail` floor against the least SUBMITTED gas of a failure
/// (intrinsic included, cold state before every try), not the gross gas used at a 16,777,215 submission.
/// Reachable: a hostile P can exhaust the router sweep, the inbox sweep and the closer tip; both burns are BURN_GAS
/// calls into our own BoxTokenV2 and run for real. The all-five case (burns mocked into a sink too) is measured as a
/// bound only: on Amsterdam its least is above 15M, so the floor does not claim it.
contract RC7RRFailFloorTest is ShopFeesTest {
    uint256 private constant TX_CAP = 16_777_216;
    uint256 private constant FAIL_FLOOR = 15_000_000; // packages/keeper/src/gas.ts V2_GAS_FLOORS.fail and failClosed

    function _amsterdam() private returns (bool) {
        bytes memory init = hex"6104006000f3";
        uint256 beforeGas = gasleft();
        assembly ("memory-safe") { pop(create(0, add(init, 32), mload(init))) }
        return beforeGas - gasleft() > 500_000;
    }

    function _cold() private {
        address[24] memory parts;
        for (uint256 i; i < 24; ++i) parts[i] = box.roleAddress(i);
        for (uint256 i; i < 24; ++i) {
            if (parts[i] != address(0)) vm.cool(parts[i]);
            address impl = release.implementations[i];
            if (impl != address(0)) {
                address helper = vm.computeCreateAddress(impl, 1);
                if (helper.code.length != 0) vm.cool(helper);
                if (i == 5) vm.cool(vm.computeCreateAddress(impl, 2));
                vm.cool(impl);
            }
        }
        vm.cool(address(ReceiverShopV21)); vm.cool(address(pm)); vm.cool(address(token));
        if (box.q() != address(0)) vm.cool(box.q());
    }

    /// kind 0: SH-RC7-CLAIM-RESERVE's menu (buy-back buyers, holders-P sellers); 1: items burn both sides;
    /// 2: items-burn buyers, holders-T sellers; 3: Shop; 4: items keep both sides.
    function _setup(uint8 kind, bool burnsExhausted) private returns (address caller) {
        if (kind == 0) { BoxSpec memory s = _menu(2, 3); s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1))); _start(s); }
        else if (kind == 1) _start(_items(2, 2));
        else if (kind == 2) { BoxSpec memory s = _items(2, 0); s.sellers.a = Branch(2, 6, "", abi.encode(uint8(2))); _start(s); }
        else if (kind == 3) _startShop(_shopSpec(2));
        else _start(_items(1, 1));
        _buy(box.raise() / 10);
        vm.prank(address(buyer)); token.transfer(address(0xA11CE), 1 ether);
        vm.warp(box.deadline());
        FailFloorSink sink = new FailFloorSink();
        if (burnsExhausted) vm.mockFunction(address(token), address(sink), abi.encodeWithSignature("burn(uint256)"));
        vm.mockFunction(box.launchRouter(), address(sink), abi.encodeWithSignature("sweep()"));
        vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
        caller = address(sink); // the closer tip is exhausted too
    }

    function _try(address caller, bytes memory data, uint256 submitted) private returns (bool ok, bytes memory ret) {
        _cold(); vm.prank(caller);
        (ok, ret) = address(box).call{gas: submitted - GasBudget.intrinsic(data)}(data);
    }

    function _least(uint8 kind, bool burnsExhausted) private returns (uint256 high, bool okAtFloor, bytes memory atFloor) {
        address caller = _setup(kind, burnsExhausted);
        bytes memory data = abi.encodeWithSignature("fail()");
        uint256 snap = vm.snapshotState();
        uint256 low = GasBudget.intrinsic(data); high = TX_CAP - 1;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            (bool ok,) = _try(caller, data, mid);
            if (ok) high = mid; else low = mid;
            assertTrue(vm.revertToState(snap));
        }
        (bool okLow,) = _try(caller, data, high - 1);
        assertFalse(okLow, "least minus one reverts");
        assertTrue(vm.revertToState(snap));
        (okAtFloor, atFloor) = _try(caller, data, FAIL_FLOOR);
        assertTrue(vm.revertToState(snap));
        (bool okLeast,) = _try(caller, data, high);
        assertTrue(okLeast); assertTrue(box.failed());
        emit log_named_uint("fail() least submitted gas", high);
        emit log_named_int("15M floor minus least", int256(FAIL_FLOOR) - int256(high));
    }

    function _reachable(uint8 kind) private {
        (uint256 least, bool okAtFloor,) = _least(kind, false);
        assertLe(least, FAIL_FLOOR, "the 15M floor admits a failure whose P-driven calls spend their allowances");
        assertTrue(okAtFloor, "a failure sent at exactly the floor succeeds");
    }

    function test_RC7RR_failFloorReachableMenu() public { _reachable(0); }
    function test_RC7RR_failFloorReachableItemsBurnBoth() public { _reachable(1); }
    function test_RC7RR_failFloorReachableItemsBurnHoldersT() public { _reachable(2); }
    function test_RC7RR_failFloorReachableShop() public { _reachable(3); }
    function test_RC7RR_failFloorReachableItemsKeepBoth() public { _reachable(4); }

    /// The bound the record no longer claims: all five allowances spent. Below the cap on both EVMs; on Amsterdam above
    /// 15M, and a 15M send reverts whole at the tip's admission (GasTooLow), so nothing is half done.
    function _allFive(uint8 kind) private {
        (uint256 least, bool okAtFloor, bytes memory atFloor) = _least(kind, true);
        assertLt(least, TX_CAP);
        // The red: rc7's record claimed "15M admits" a failure with all five spent. RC7RR_OLD_CLAIM=true asserts it.
        if (vm.envOr("RC7RR_OLD_CLAIM", false)) assertTrue(okAtFloor, "old claim: 15M admits all five spent");
        if (_amsterdam()) {
            assertGt(least, FAIL_FLOOR, "Amsterdam: all five spent needs more than 15M submitted");
            assertFalse(okAtFloor);
            assertEq(bytes4(atFloor), bytes4(keccak256("GasTooLow(uint256,uint256)")));
        } else {
            assertLe(least, FAIL_FLOOR); assertTrue(okAtFloor);
        }
    }

    function test_RC7RR_failAllFiveBoundMenu() public { _allFive(0); }
    function test_RC7RR_failAllFiveBoundItemsBurnBoth() public { _allFive(1); }
    function test_RC7RR_failAllFiveBoundItemsBurnHoldersT() public { _allFive(2); }
    function test_RC7RR_failAllFiveBoundShop() public { _allFive(3); }
    function test_RC7RR_failAllFiveBoundItemsKeepBoth() public { _allFive(4); }
}
