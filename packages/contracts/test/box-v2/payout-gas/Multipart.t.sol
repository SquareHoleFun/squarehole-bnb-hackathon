// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {PayoutProbe} from "./Probe.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// Real production receiver and PM; scripted lifecycle and arbitrary-supply ERC20 price coin.
/// A ledger token's fixed issuance cannot reach int128.max; this fixture covers valid larger ERC20 debts.
contract MultipartPayoutGasTest is ReceiverFixture {
    uint256 private constant PART = uint256(uint128(type(int128).max));
    uint256 private constant OUTER = 12_000_000;
    uint256 private cap;

    function setUp() public override {
        super.setUp();
        cap = (new PayoutProbe(pm, coordinatorCode, FIT, PLATFORM, CONVERSION)).allowance();
        uint256 funding = PART * 30 + 105;
        p.mint(address(driver), funding);
        while (funding != 0) {
            uint256 part = funding > PART ? PART : funding;
            driver.mintClaims(Currency.wrap(address(p)), address(r), part);
            funding -= part;
        }
        r.collect(address(0));
        assertEq(r.fitOwed(), PART * 4 + 14);
    }

    function _cold() private {
        vm.cool(address(r)); vm.cool(address(implementation));
        vm.cool(vm.computeCreateAddress(address(implementation), 1));
        vm.cool(vm.computeCreateAddress(address(implementation), 2));
        vm.cool(address(coord)); vm.cool(coordinatorCode);
        vm.cool(address(pm)); vm.cool(address(p)); vm.cool(FIT); vm.cool(PLATFORM);
    }

    function test_fourPartTransactionAndTailKeepLimitsAndConservation() public {
        uint256 backing = _balance(address(r));
        uint256 platform = r.platformOwed();
        vm.expectCall(address(pm), abi.encodeCall(pm.take, (Currency.wrap(address(p)), FIT, PART)), 4);
        _cold(); vm.prank(FIT);
        uint256 beforeGas = gasleft();
        uint256 paid = r.payFit{gas: OUTER}();
        uint256 used = GasBudget.transaction(beforeGas - gasleft(), abi.encodeCall(r.payFit, ()));
        emit log_named_uint("four-part production transaction", used);
        assertEq(paid, PART * 4);
        assertEq(r.fitOwed(), 14);
        assertEq(p.balanceOf(FIT), paid);
        assertEq(_balance(address(r)), backing - paid);
        assertEq(r.platformOwed(), platform);
        _limits(used);
        _cold(); vm.prank(FIT);
        assertEq(r.payFit{gas: OUTER}(), 14);
        assertEq(r.fitOwed(), 0);
        assertEq(p.balanceOf(FIT), paid + 14);
        assertEq(_balance(address(r)), backing - paid - 14);
    }

    function test_fourPartExhaustionAtOneGasEntryBoundaryRestoresDebt() public { _boundary(4); }

    function test_singlePartExhaustionAtOneGasEntryBoundaryRestoresDebt() public {
        vm.prank(FIT);
        assertEq(r.payFit{gas: OUTER}(), PART * 4);
        _boundary(1);
    }

    function _boundary(uint256 parts) private {
        bytes memory code = address(p).code;
        uint256 backing = _balance(address(r));
        uint256 owed = r.fitOwed();
        uint256 beforeFit = p.balanceOf(FIT);
        // Exhaust the nested balance-read path. Source/PM bookkeeping remains production code.
        vm.etch(address(p), hex"fe");
        uint256 low = 100_000;
        uint256 high = OUTER;
        while (high - low > 1) {
            uint256 snap = vm.snapshotState();
            uint256 mid = (low + high) / 2;
            (bool ok, bool entered,) = this.attempt(mid);
            assertEq(ok, entered, "entering the named cap must preserve continuation");
            assertEq(r.fitOwed(), owed);
            assertEq(_balance(address(r)), backing);
            if (entered) high = mid; else low = mid;
            assertTrue(vm.revertToState(snap));
        }
        emit log_named_uint("payout parts", parts);
        emit log_named_uint("one-gas payout activation", high);
        (bool lowOk, bool lowEntered,) = this.attempt(low);
        assertFalse(lowOk || lowEntered);
        vm.expectCall(address(pm), 0, uint64(cap * parts), abi.encodeWithSelector(IPoolManager.unlock.selector), 2);
        (bool ok, bool entered, uint256 used) = this.attempt(high);
        assertTrue(ok && entered);
        emit log_named_uint("exhaustion transaction", used);
        assertEq(r.fitOwed(), owed);
        assertEq(_balance(address(r)), backing);
        _limits(used);
        vm.etch(address(p), code);
        uint256 platform = r.platformOwed();
        _cold(); vm.prank(PLATFORM);
        assertEq(r.payPlatform{gas: OUTER}(), platform, "independent Safe still pays");
        _cold(); vm.prank(FIT);
        uint256 batch = owed > PART * 4 ? PART * 4 : owed;
        assertEq(r.payFit{gas: OUTER}(), batch, "same debt remains retryable");
        assertEq(r.fitOwed(), owed - batch);
        assertEq(p.balanceOf(FIT), beforeFit + batch);
    }

    /// Self-only test driver, isolating each cold attempt and observing actual PM unlock admission.
    function attempt(uint256 limit) external returns (bool ok, bool entered, uint256 used) {
        require(msg.sender == address(this));
        bytes memory data = abi.encodeCall(r.payFit, ());
        _cold();
        vm.startStateDiffRecording();
        vm.prank(FIT);
        uint256 beforeGas = gasleft();
        bytes memory ret;
        (ok, ret) = address(r).call{gas: limit}(data);
        used = GasBudget.transaction(beforeGas - gasleft(), data);
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Call && accesses[i].account == address(pm)
                && accesses[i].accessor == address(r)) entered = true;
        }
        if (ok) assertEq(abi.decode(ret, (uint256)), 0, "exhaustion cannot report a payment");
    }

    function _limits(uint256 used) private view {
        assertLt(used * 130 / 100 + 500_000, 16_777_216, "execution plus estimation margin");
        uint256 supplied = OUTER + GasBudget.intrinsic(abi.encodeCall(r.payFit, ()));
        assertLt(supplied, 16_777_216);
        assertLt(supplied * 115 / 100 * 110 / 100 + 5_000_000, 30_000_000, "block room");
        assertLe(cap * 4 + cap * 4 / 63 + 20_000, OUTER, "four named allowances fit caller");
    }
}
