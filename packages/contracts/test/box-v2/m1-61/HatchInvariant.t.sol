// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {MoneyFixture} from "./MoneyFixture.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract HatchHandler is MoneyFixture {
    uint256 public firstFill;
    uint256 public failureTime;
    uint256 public outcomes;

    function setUp() public override {
        super.setUp();
        _give(ALICE, 100);
        _fund(p, address(hook), 1031);
        hook.configure(16, 15, 0);
        _royaltyP(23);
        foreignCoin.setBlocked(CONVERSION, true);
        _royaltyForeign(41);
    }

    function advance(uint32 seed) public {
        vm.warp(block.timestamp + uint256(seed) % (2 days));
    }

    function fill() public {
        if (box.failed() || box.graduated()) return;
        hook.fill();
        if (firstFill == 0) firstFill = block.timestamp;
        assertEq(hook.closedAt(), firstFill);
    }

    function attemptGraduation(bool reject) public {
        hook.setReject(false, reject);
        bool shouldSucceed = firstFill != 0 && !box.failed() && !box.graduated() && !reject;
        bytes32 beforeState = _fingerprint();
        (bool ok,) = address(box).call(abi.encodeCall(box.graduate, ()));
        assertEq(ok, shouldSucceed, "graduation eligibility");
        if (ok) ++outcomes;
        else assertEq(_fingerprint(), beforeState, "rejected graduation changed money/state");
    }

    function attemptFailure(bool rejectClose, bool lowGas) public {
        hook.setReject(rejectClose, false);
        uint256 end = firstFill == 0 ? box.deadline() : firstFill + 7 days;
        bool shouldSucceed = !box.failed() && !box.graduated() && block.timestamp >= end && !rejectClose && !lowGas;
        bytes32 beforeState = _fingerprint();
        (bool ok,) = address(box).call{gas: lowGas ? 150_000 : 8_000_000}(abi.encodeCall(box.fail, ()));
        assertEq(ok, shouldSucceed, "hatch/deadline eligibility");
        if (ok) {
            ++outcomes;
            failureTime = block.timestamp;
        } else {
            assertEq(_fingerprint(), beforeState, "rejected failure changed money/state");
        }
    }

    function assertExclusiveOutcome() public view {
        assertFalse(box.failed() && box.graduated());
        assertLe(outcomes, 1);
        assertEq(outcomes, box.failed() || box.graduated() ? 1 : 0);
        assertEq(hook.closedAt(), firstFill, "attempt never resets fill clock");
        if (box.failed()) {
            assertGe(failureTime, firstFill == 0 ? box.deadline() : firstFill + 7 days);
            assertEq(vault.windowEnds(), failureTime + 14 days);
            assertEq(_left(), 100);
            assertEq(_pot(), 1048); // 1000 principal + 24 fees + 1 carry + 23 royalty
            assertEq(fees.fitOwed(), 4); // earned fee share only
            assertEq(fees.platformOwed(), 2);
            assertEq(_claimsP(address(hook)), 0);
        }
        assertEq(foreignCoin.balanceOf(address(this)), 41, "rejected foreign intake stays with sender");
        _assertBooked();
    }

    function finish() external {
        if (outcomes == 0) {
            fill();
            uint256 end = firstFill + 7 days;
            if (block.timestamp < end) vm.warp(end);
            attemptFailure(false, false);
        }
        assertEq(outcomes, 1, "each campaign must reach an outcome");
        attemptGraduation(false);
        attemptFailure(false, false);
        assertExclusiveOutcome();
    }

    function _fingerprint() internal view returns (bytes32) {
        bytes32 state = keccak256(
            abi.encode(
                box.failed(),
                box.graduated(),
                box.failedAt(),
                hook.failed(),
                hook.reserveMinted(),
                _left(),
                t.totalSupply(),
                t.balanceOf(address(box)),
                vault.windowEnds()
            )
        );
        return keccak256(
            abi.encode(
                state,
                _pot(),
                _claimsP(address(hook)),
                _claimsP(address(fees)),
                fees.booked(p),
                fees.fitOwed(),
                fees.platformOwed(),
                fees.royaltyHeldP()
            )
        );
    }
}

contract HatchInvariantTest is StdInvariant, Test {
    HatchHandler internal handler;

    function setUp() public {
        handler = new HatchHandler();
        handler.setUp();
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.advance.selector;
        selectors[1] = handler.fill.selector;
        selectors[2] = handler.attemptGraduation.selector;
        selectors[3] = handler.attemptFailure.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_firstFillClockAndExactlyOneOutcome() public view {
        handler.assertExclusiveOutcome();
    }

    function afterInvariant() public {
        handler.finish();
    }
}

contract HatchPropertiesTest is MoneyFixture {
    function testFuzz_exactHatchBoundaryRollbackAndBothRaceOrders(uint32 start, uint8 attempts, bool graduateFirst)
        public
    {
        vm.warp(uint256(start) + 1_000_000);
        _realBox(1, 2, 1, true, address(priceToken));
        _give(ALICE, 100);
        _fund(p, address(hook), 1031);
        hook.configure(16, 15, 0);
        hook.fill();
        uint256 first = hook.closedAt();
        uint256 end = first + 7 days;
        hook.setReject(false, true);
        for (uint256 i; i < uint256(attempts) % 8; ++i) {
            vm.warp(first + i * 1 days);
            vm.expectRevert();
            box.graduate();
            hook.fill();
            assertEq(hook.closedAt(), first);
        }
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, end));
        box.fail();
        assertFalse(box.failed());
        assertEq(_claimsP(address(hook)), 1031);
        vm.warp(end);
        foreignCall = abi.encodeCall(box.fail, ());
        pm.unlock("");
        assertFalse(foreignOk);
        assertEq(foreignResult, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
        (bool ok,) = address(box).call{gas: 150_000}(abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertFalse(box.failed());
        assertFalse(hook.failed());
        assertEq(_claimsP(address(hook)), 1031);
        assertEq(fees.booked(p), 0);
        assertEq(vault.windowEnds(), 0);
        hook.setReject(false, false);
        vm.prank(BOB); // unrelated caller; before the original 30-day deadline
        if (graduateFirst) box.graduate();
        else box.fail();
        assertLt(block.timestamp, box.deadline());
        vm.expectRevert();
        if (graduateFirst) box.fail();
        else box.graduate();
        assertEq(box.graduated(), graduateFirst);
        assertEq(box.failed(), !graduateFirst);
        if (!graduateFirst) {
            assertEq(_pot(), 1025);
            assertEq(_claim(ALICE, 100, ALICE), 1025);
        }
    }
}
