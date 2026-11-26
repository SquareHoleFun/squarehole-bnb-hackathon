// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {S8World, BoxItemStreamHarness} from "../../../s8/BoxS8World.sol";
import {BoxItemStreamGasBase} from "../../../s8/BoxItemStreamGasBase.sol";
import {BoxCollection} from "../../../../../src/box/BoxCollection.sol";
import {BoxToken} from "../../../../../src/box/BoxToken.sol";
import {BoxReceiver} from "../../../../../src/box/BoxReceiver.sol";
import {AuditRegressMoneyGasSink} from "./MoneyFixture.sol";

contract AuditRegressMoneyStreamModelTest is Test {
    S8World internal w;
    BoxItemStreamHarness internal s;

    function setUp() public {
        w = new S8World(20, 1);
        w.boot();
        s = w.stream();
        w.graduate(keccak256("money stream"));
    }

    /// Exact external model: fees -> 13/15 -> index, with a different request checkpoint per draw.
    /// Reverse delivery order, alternate terminal cancellation, transfer and old-owner claims.
    function testFuzz_M12_perRequestAccrualAndAggregateConservation(uint64 seed, bool cancel) public {
        uint256[6] memory start;
        uint256 fees;
        for (uint256 i; i < 6; ++i) {
            uint256 fee = uint256(keccak256(abi.encode(seed, i))) % 1e18 + 15_000;
            fees += fee;
            w.fee(fee);
            start[i] = (13 * (fees / 15)) / 20;
            assertEq(s.index(), start[i]);
            assertEq(w.draw(), i + 1);
        }
        w.fee(30_000);
        fees += 30_000;
        uint256 end = (13 * (fees / 15)) / 20;
        uint256 owed;
        if (cancel) w.enterTerminal(true);
        for (uint256 i = 6; i != 0; --i) {
            address owner = address(uint160(100 + i));
            uint256 earned = end - start[i - 1];
            owed += earned;
            if (cancel && i % 2 == 0) {
                w.cancelDraw(i, owner);
            } else {
                uint256 id = w.openDrawTicket(i, owner);
                (, uint256 pending) = s.pendingOf(id);
                assertEq(pending, earned);
                w.transfer(owner, address(uint160(200 + i)), id);
            }
            assertEq(s.owedOf(owner), earned, "earnings stay with the old owner");
        }
        assertEq(s.liabilities(), owed);
        (, uint256 draws, uint256 sum) = s.openTickets();
        assertEq(draws + sum, 0);
        uint256 value = s.streamValue();
        uint256 received = w.collect();
        assertEq(received, 13 * (fees / 15));
        assertEq(s.streamValue(), value, "collect and burn do not change index");
        uint256[] memory none = new uint256[](0);
        uint256 paid;
        for (uint256 i = 1; i <= 6; ++i) {
            uint256 expected = end - start[i - 1] - 1;
            uint256 amount = s.claimFor(address(uint160(100 + i)), none);
            assertEq(amount, expected, "all but the documented one raw unit is paid");
            paid += amount;
        }
        (uint256 claimed, uint256 burned) = s.totals();
        assertEq(claimed, paid);
        assertEq(w.token().balanceOf(address(s)) + claimed + burned, received);
        assertEq(s.liabilities(), 6, "one retained raw unit per earner");
        assertGe(w.token().balanceOf(address(s)), s.liabilities());
    }

    function test_M13_unfundedClaimsAndRefusedBurnKeepLiabilities() public {
        uint256 ticket = w.draw();
        w.fee(30_000);
        uint256 id = w.openDrawTicket(ticket, address(this));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(s.claim(ids, address(this)), 0, "fees still in pool cannot be paid yet");
        uint256 owed = s.owedOf(address(this));
        assertEq(owed, 1300);
        w.token().setRefuseBurns(true);
        uint256 received = w.collect();
        (, uint256 burned) = s.totals();
        assertEq(burned, 0);
        assertEq(s.claim(ids, address(this)), owed - 1);
        assertEq(s.owedOf(address(this)), 1);
        w.token().setRefuseBurns(false);
        s.burn();
        (uint256 claimed, uint256 finalBurned) = s.totals();
        assertEq(w.token().balanceOf(address(s)) + claimed + finalBurned, received);
    }
}

/// Whole real-contract calls, with fee growth from the local pool. Setup only is outside gas metering.
abstract contract AuditRegressMoneyStreamBase is BoxItemStreamGasBase {
    function setUp() public override {
        vm.pauseGasMetering();
        super.setUp();
        _life();
        vm.resumeGasMetering();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditRegressMoneyStreamCallbacksTest is AuditRegressMoneyStreamBase {
    function test_M14_failedFundingNoticeLeavesRecoverableTokensAndLiabilities() public {
        _trade(2);
        uint256 value = st.streamValue();
        uint256 liabilities = st.liabilities();
        uint256 held = BoxToken(a.token).balanceOf(a.itemStream);
        bytes memory code = a.itemStream.code;
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.etch(a.itemStream, address(sink).code);
        BoxReceiver(payable(a.receiver)).collect{gas: 3_000_000}(keeper);
        vm.etch(a.itemStream, code);
        assertGt(BoxToken(a.token).balanceOf(a.itemStream), held);
        assertEq(st.streamValue(), value);
        assertEq(st.liabilities(), liabilities);
        st.burn();
        assertEq(st.streamValue(), value);
        assertEq(st.liabilities(), liabilities);
        assertGe(BoxToken(a.token).balanceOf(a.itemStream), liabilities);
    }

    function test_M15_insufficientObserverGasRevertsTransferAtomically() public {
        uint256 value = st.streamValue();
        vm.prank(alice);
        (bool ok,) = a.collection.call{gas: 150_000}(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, aliceItem)
        );
        assertFalse(ok);
        assertEq(BoxCollection(a.collection).ownerOf(aliceItem), alice);
        assertEq(st.streamValue(), value);
    }
}
