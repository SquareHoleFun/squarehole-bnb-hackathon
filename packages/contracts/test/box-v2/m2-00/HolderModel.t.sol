// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HolderModel} from "./HolderModel.sol";

contract HolderModelTest is Test {
    HolderModel m;
    address constant A = address(0xA11CE);
    address constant B = address(0xB0B);
    address constant SYSTEM = address(0x99);
    function setUp() public { m = new HolderModel(SYSTEM); m.move(SYSTEM, A, 60, true); m.move(SYSTEM, B, 40, true); }
    function finish(uint256 id, uint256 funding) internal { m.close(id, funding); m.settle(id, 64); }

    function test_F127_removedPushPreservesOwnerCredit() public {
        m.trade(1, 100, false, true); finish(1, 1000);
        (bool ok,) = address(m).call(abi.encodeWithSignature("claimFor(uint256,address)", 1, A));
        assertFalse(ok, "F127 removes pushed payouts");
        assertEq(m.credit(1, A), 600); assertEq(m.credit(1, B), 400);
    }

    function test_contractRegistersBeforeEarningAndCannotClaimPastUnits() public {
        address c = address(0xC0123); vm.etch(c, hex"60006000f3");
        m.move(SYSTEM, c, 100, false); m.trade(1, 100, false, true);
        vm.prank(c); (bool ok,) = address(m).call(abi.encodeWithSignature("register()")); assertTrue(ok);
        m.trade(1, 200, false, true); finish(1, 300);
        assertEq(m.credit(1, c), 100); assertEq(m.credit(1, A), 120); assertEq(m.credit(1, B), 80);
    }
    function test_selfClaimPaysWholeCreditWithoutTip() public {
        m.trade(1, 100, false, true); finish(1, 1000);
        vm.prank(A); assertEq(m.claim(1, A), 600);
        assertEq(m.paidTo(A), 600); assertEq(m.paidTo(address(this)), 0);
        assertEq(m.credit(1, B), 400);
    }
    function test_tradeBeforeTransferAndIndependentSides() public {
        m.trade(1, 100, false, true); m.move(A, B, 30, true);
        m.trade(2, 100, false, true); finish(1, 100); finish(2, 200);
        assertEq(m.credit(1, A), 60); assertEq(m.credit(1, B), 40);
        assertEq(m.credit(2, A), 60); assertEq(m.credit(2, B), 140);
    }
    function test_missedNoticeProtocolAndNoEligibleBalanceBecomeResidue() public {
        m.trade(1, 100, false, false); m.trade(1, 100, false, true); m.trade(1, 100, true, true);
        finish(1, 300);
        assertEq(m.credit(1, A), 60); assertEq(m.credit(1, B), 40); assertEq(m.residue(1), 200);
        m.move(A, SYSTEM, 60, false); m.move(B, SYSTEM, 40, false);
        m.trade(3, 99, false, true); finish(3, 99); assertEq(m.residue(3), 99);
    }
    function test_missedOutAndBackSettlementsUseHistoryNotCurrentBalance() public {
        m.trade(1, 100, false, true); m.move(A, B, 60, false);
        m.trade(1, 100, false, true); m.move(B, A, 60, false);
        m.trade(1, 100, false, true); finish(1, 300);
        assertEq(m.credit(1, A), 120); assertEq(m.credit(1, B), 180);
        assertEq(m.residue(1), 0); assertEq(m.callbackCount(), 2);
    }
    function test_zeroFundingFinalAndNoLaterSubsidy() public {
        m.trade(1, 100, false, true); finish(1, 0);
        m.trade(3, 100, false, true); finish(3, 1000);
        assertTrue(m.finalized(1)); assertEq(m.credit(1, A), 0); assertEq(m.credit(3, A), 600);
        vm.expectRevert(); m.close(1, 100);
    }
    function test_paginationCannotReleaseUnprovedResidue() public {
        m.trade(1, 100, false, true); m.trade(1, 100, false, true); m.close(1, 200);
        m.settle(1, 1); assertFalse(m.finalized(1));
        vm.expectRevert(); m.flush(1);
        m.settle(1, 1); m.settle(1, 1); m.settle(1, 1);
        assertTrue(m.finalized(1)); assertEq(m.credit(1, A), 120); assertEq(m.credit(1, B), 80);
        m.settle(1, 64); assertEq(m.credit(1, A), 120);
    }
    function test_pausedPNoExpiryFailureAndClaimIsolation() public {
        m.trade(1, 100, false, true); finish(1, 1000); m.pause(true);
        vm.prank(A); vm.expectRevert(); m.claim(1, A);
        assertEq(m.credit(1, A), 600); m.fail(); vm.warp(block.timestamp + 3650 days); m.pause(false);
        vm.prank(A); assertEq(m.claim(1, B), 600);
        assertEq(m.paidTo(B), 600); assertEq(m.credit(1, B), 400);
        vm.prank(A); vm.expectRevert(); m.claim(1, A);
    }
    function test_onlyOwnerCanClaimIncludingContracts() public {
        m.trade(1, 100, false, true); finish(1, 1000);
        vm.expectRevert(); m.claim(1, A);
        vm.etch(B, hex"60006000f3"); vm.prank(B); assertEq(m.claim(1, B), 400);
        assertEq(m.credit(1, A), 600);
    }
    function test_7702OwnerClaimsWithoutMinimum() public {
        vm.etch(A, abi.encodePacked(hex"ef0100", address(0x1234)));
        m.trade(1, 100, false, true); finish(1, 1000);
        vm.prank(A); assertEq(m.claim(1, A), 600);
        m.trade(3, 100, false, true); finish(3, 10);
        vm.prank(A); assertEq(m.claim(3, A), 6);
    }
    function test_residueExitPreservesUnclaimedCreditAndUsesFailureDestination() public {
        m.trade(1, 100, false, false); m.trade(1, 100, false, true); finish(1, 200);
        assertEq(m.flush(1), 100); assertEq(m.depth(), 100); assertEq(m.credit(1, A), 60);
        assertEq(m.flush(1), 0);
        m.trade(3, 100, true, true); finish(3, 90); m.fail(); m.flush(3); assertEq(m.fit(), 90);
    }
    function testFuzz_allocationsConserveAndNeverBorrow(uint96 raw, uint16 missed, uint16 protocol) public {
        uint256 u = 100 + uint256(missed); uint256 v = protocol;
        m.trade(1, missed, false, false); m.trade(1, 100, false, true); m.trade(1, v, true, true);
        finish(1, raw);
        assertEq(m.credit(1, A), uint256(raw) * 60 / (u + v));
        assertEq(m.credit(1, B), uint256(raw) * 40 / (u + v));
        assertEq(m.credit(1, A) + m.credit(1, B) + m.residue(1), raw);
    }
    function test_sourceSplitCarriesTipAndD6StayWithTheirSource() public {
        // Source 1: 100 gross - 10 D6 - 5 actual tip = 85; 5 fifteenths, terminal dust 10.
        (uint256 f, uint256 platform, uint256 pool, uint256 holders, uint256 dust) = m.split(100, 10, 5);
        assertEq(f, 10); assertEq(platform, 5); assertEq(pool, 10); assertEq(holders, 50); assertEq(dust, 10);
        // A refused tip stays in this source: 90 splits exactly. A separate 5 cannot use the first dust.
        (f, platform, pool, holders, dust) = m.split(100, 10, 0);
        assertEq(f + platform + pool + holders + dust, 90); assertEq(holders, 60);
        (f, platform, pool, holders, dust) = m.split(5, 0, 0);
        assertEq(f + platform + pool + holders, 0); assertEq(dust, 5);
    }
    function test_roundingAndRawDecimals() public {
        for (uint256 d; d < 3; ++d) {
            uint256 scale = d == 0 ? 1e6 : d == 1 ? 1e8 : 1e18;
            uint256 id = 1 + d * 2; m.trade(id, 101, false, true); finish(id, 15 * scale + 1);
            assertEq(m.credit(id, A), (15 * scale + 1) * 60 / 101);
            assertEq(m.credit(id, B), (15 * scale + 1) * 40 / 101);
            assertEq(m.credit(id, A) + m.credit(id, B) + m.residue(id), 15 * scale + 1);
        }
    }
}
