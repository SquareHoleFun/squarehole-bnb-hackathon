// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LinkedPriceFixture} from "../final/money/LinkedPriceFixture.sol";
import {LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {PayoutProbe} from "./Probe.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {GasBudget} from "../gas/GasBudget.sol";

/// FINAL-M02: real factory-created/listed ledger P, cold account/storage, gross gas without refunds.
contract LinkedPayoutGasTest is LinkedPriceFixture {
    uint256 internal constant CALL_GAS = 12_000_000;
    uint256 internal constant TX_CAP = 16_777_216;

    function _cold(address to) internal {
        address[48] memory parts;
        for (uint256 i; i < 24; ++i) {
            parts[i] = box.roleAddress(i);
            parts[i + 24] = origin.roleAddress(i);
        }
        for (uint256 i; i < 24; ++i) {
            address impl = release.implementations[i];
            if (impl == address(0)) continue;
            address helper = vm.computeCreateAddress(impl, 1);
            if (helper.code.length != 0) vm.cool(helper);
            // SH-V21-00-ROOM: the receiver callback is constructor child 2.
            if (i == 5) vm.cool(vm.computeCreateAddress(impl, 2));
            vm.cool(impl);
        }
        for (uint256 i; i < 48; ++i) if (parts[i] != address(0)) vm.cool(parts[i]);
        vm.cool(to);
        vm.cool(address(pm));
    }

    function test_coldProductionFitExit() public {
        _linked(false);
        _production(false);
    }

    function test_coldProductionPlatformExit() public {
        _linked(false);
        _production(true);
    }

    function _production(bool platform) internal {
        address to = platform ? address(this) : fitSafe;
        uint256 owed = platform ? receiver.platformOwed() : receiver.fitOwed();
        uint256 beforeP = price.balanceOf(to);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(price)));
        bytes memory data = platform ? abi.encodeCall(receiver.payPlatform, ()) : abi.encodeCall(receiver.payFit, ());
        _cold(to);
        vm.prank(to);
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = address(receiver).call{gas: CALL_GAS}(data);
        uint256 used = GasBudget.transaction(beforeGas - gasleft(), data);
        assertTrue(ok, "production call succeeds");
        assertEq(abi.decode(ret, (uint256)), owed, "admitted price coin pays its debt");
        emit log_named_uint(platform ? "cold platform transaction" : "cold FIT transaction", used);
        assertEq(price.balanceOf(to), beforeP + owed);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing - owed);
        assertEq(platform ? receiver.platformOwed() : receiver.fitOwed(), 0);
        _limits(used, data);
    }

    function test_strictFreshWalletTwiceColdHeadroom() public { _headroom(0); }
    function test_strictFreshContractTwiceColdHeadroom() public { _headroom(1); }
    function test_strictRegisteredContractTwiceColdHeadroom() public { _headroom(2); }
    function test_firstEligibleWalletTwiceColdHeadroom() public { _headroom(5); }
    function test_firstEligible7702TwiceColdHeadroom() public { _headroom(6); }
    function test_strictFresh7702TwiceColdHeadroom() public { _headroom(4); }
    function test_strictExistingHolderLongHistoryTwiceColdHeadroom() public { _headroom(3); }

    function _headroom(uint256 kind) internal {
        // A can graduate while every holder is an unregistered contract. Its first eligible
        // recipient also changes the holder-count slot from zero; this is the strict storage case.
        if (kind >= 5) vm.etch(CREATOR, address(new LifeCustody()).code);
        _linked(false);
        if (kind >= 5) assertEq(BoxTokenV2Ledger(address(price)).holderCount(), 0);
        address to = kind == 0 || kind >= 4 ? ALICE : address(new LifeCustody());
        if (kind == 4 || kind == 6) vm.etch(to, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        if (kind == 2 || kind == 3) {
            vm.prank(to);
            HolderLedgerV2(origin.roleAddress(17)).register();
        }
        if (kind == 3) {
            // Append real history, including out-and-back transfers; no synthetic history storage.
            vm.prank(address(buyer)); price.transfer(to, 1 ether);
            for (uint256 i; i < 512; ++i) {
                vm.prank(to); price.transfer(ALICE, 1);
                vm.prank(ALICE); price.transfer(to, 1);
            }
        }
        uint256 owed = receiver.fitOwed();
        uint256 beforeP = price.balanceOf(to);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(price)));
        uint256 originBacking = address(pm).balance;
        uint256 supply = price.totalSupply();
        PayoutProbe probe = new PayoutProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        uint256 cap = probe.allowance();
        // Keep custody/storage at the real box address, but delegate to the measurement implementation.
        // Its constructor-created callback authenticates that exact implementation's direct clones.
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(probe))[i];
        vm.etch(address(receiver), runtime);
        release.implementations[5] = address(probe);
        uint256 snap = vm.snapshotState();
        // Large enough to activate the real optional history notice too. Measure the complete unlock,
        // not only ERC20 transfer, with no refund discount. All production callback code is inherited.
        _cold(to);
        vm.prank(fitSafe);
        (uint256 paid, uint256 used) = PayoutProbe(address(receiver)).measured(to, 4_000_000);
        assertEq(paid, owed);
        emit log_named_uint("recipient kind", kind);
        emit log_named_uint("cold complete unlock upper bound", used);
        assertEq(price.balanceOf(to), beforeP + owed);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing - owed);
        assertEq(address(pm).balance, originBacking);
        assertEq(price.totalSupply(), supply);
        assertLe(used * 2, cap, "two times cold admitted-token payout must fit named cap");
        assertTrue(vm.revertToState(snap));
        _cold(to);
        vm.prank(fitSafe);
        (paid,) = PayoutProbe(address(receiver)).measured(to, cap / 2);
        assertEq(paid, owed, "same complete path succeeds at half the release allowance");
        assertEq(price.balanceOf(to), beforeP + owed);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing - owed);
    }

    function test_optionalHintFailuresPreserveExactPayoutAndHistory() public {
        vm.etch(CREATOR, address(new LifeCustody()).code);
        _linked(false);
        assertEq(BoxTokenV2Ledger(address(price)).holderCount(), 0);
        PayoutProbe probe = new PayoutProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        uint256 cap = probe.allowance();
        // Keep custody/storage at the real box address, but delegate to the measurement implementation.
        // Its constructor-created callback authenticates that exact implementation's direct clones.
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(probe))[i];
        vm.etch(address(receiver), runtime);
        release.implementations[5] = address(probe);
        address ledger = origin.roleAddress(17);
        uint256 owed = receiver.fitOwed();
        uint256 checkpoint = BoxTokenV2Ledger(address(price)).holderCheckpoint();
        bytes32 expected;
        vm.expectCall(ledger, 0, uint64(C.TOKEN_SETTLEMENT_GAS),
            abi.encodeCall(IHolderLedgerV2.onTokenCheckpoint, (checkpoint + 1, address(pm), ALICE)), 4);
        for (uint256 mode; mode < 4; ++mode) {
            uint256 snap = vm.snapshotState();
            if (mode == 1) vm.etch(ledger, hex"60006000fd");
            if (mode == 2) vm.etch(ledger, hex"fe");
            if (mode == 3) vm.etch(ledger, hex"620100006000fd");
            _cold(ALICE);
            // Force even Amsterdam's optional hint to activate. The complete measured path,
            // including the full 600k sink, must still cost less than the release payout cap.
            vm.prank(fitSafe);
            (uint256 paid, uint256 used) = PayoutProbe(address(receiver)).measured(ALICE, 4_000_000);
            assertEq(paid, owed);
            assertLe(used, cap, "even an exhausted optional hint fits the release cap");
            emit log_named_uint("hint fault mode", mode);
            emit log_named_uint("cold unlock with forced hint", used);
            bytes32 state = keccak256(abi.encode(price.balanceOf(ALICE), price.balanceOf(address(pm)),
                pm.balanceOf(address(receiver), uint160(address(price))), receiver.fitOwed(),
                BoxTokenV2Ledger(address(price)).holderCheckpoint(),
                BoxTokenV2Ledger(address(price)).eligibleBalanceAt(ALICE, checkpoint + 1)));
            if (mode == 0) expected = state; else assertEq(state, expected, "notice cannot change money/history");
            assertTrue(vm.revertToState(snap));
        }
    }

    function _limits(uint256 used, bytes memory data) internal pure {
        require(used * 130 / 100 + 500_000 < TX_CAP, "execution plus estimate margin");
        uint256 submitted = CALL_GAS + GasBudget.intrinsic(data);
        require(submitted < TX_CAP, "transaction gas cap");
        require(submitted * 115 / 100 * 110 / 100 + 5_000_000 < 30_000_000, "block envelope");
    }
}
