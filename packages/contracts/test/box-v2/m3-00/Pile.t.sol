// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {PileModel, HostileToken} from "./PileModel.sol";
import {FreezeRules, FailureModel} from "./FreezeRules.sol";
import {BoxType} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract M300PileTest is Test {
    HostileToken a;
    HostileToken t;
    PileModel p;
    function setUp() public {
        a = new HostileToken("Seed", "P", 6); t = new HostileToken("Box", "T", 18);
        a.mint(address(this), 1001); t.mint(address(this), 100);
        p = new PileModel(a, t, 1001); a.approve(address(p), 1001); t.approve(address(p), 100);
    }
    receive() external payable {}
    function test_S5_nativeSeederExactValueAndSurplusDefault() public {
        p = new PileModel(HostileToken(address(0)), t, 1001);
        vm.deal(address(this),2000); vm.deal(address(0xB0B),1001);
        vm.prank(address(0xB0B)); (bool wrong,) = address(p).call{value:1001}(abi.encodeWithSignature("load()"));
        assertFalse(wrong); assertFalse(p.loaded());
        (bool shortValue,) = address(p).call{value:1000}(abi.encodeWithSignature("load()")); assertFalse(shortValue);
        (bool ok,) = address(p).call{value:1001}(abi.encodeWithSignature("load()"));
        assertTrue(ok,"native seed must load"); assertEq(p.notifications(),1);
        vm.deal(address(p),1010); p.fail(); p.returnSeed(); assertEq(address(p).balance,9);
        assertEq(address(this).balance,2000); assertEq(p.excludedT(),0);
    }
    function test_S5_unloadedFailureReturnsZeroAndNeverOpens() public {
        p.fail(); p.returnSeed(); assertTrue(p.returned()); assertEq(a.balanceOf(address(this)),1001);
        vm.expectRevert(); p.load(); vm.expectRevert(); p.graduate();
    }
    function test_S5_liveGiftsRedeemButFailedSurplusHasNoExit() public {
        p.load(); a.mint(address(p),9); p.graduate(); t.approve(address(p),100);
        assertEq(p.redeem(100,1010,address(this)),1010);
        a.mint(address(this),1001); p = new PileModel(a,t,1001); a.approve(address(p),1001);
        p.load(); a.mint(address(p),9); p.fail(); p.returnSeed(); assertEq(a.balanceOf(address(p)),9);
    }
    function test_S5_seedPOrOtherNeverChangesFrozenClaimableT() public {
        // Claims custody stands for backed PM T claims; unrelated PM inventory is not supplied to H.
        address pmCustody = address(0x6909); FreezeRules rules = new FreezeRules();
        p.load(); t.transfer(address(p),20); t.transfer(pmCustody,5); p.fail();
        uint256 left = rules.outstanding(BoxType.PILE,t.totalSupply(),0,p.excludedT(),5,0,0,0);
        assertEq(left,t.balanceOf(address(this))); assertEq(left,75);
        FailureModel sameP = new FailureModel(1000,0,0,left,1);
        FailureModel otherP = new FailureModel(700,0,0,left,1);
        a.setPaused(true); vm.expectRevert(); p.returnSeed();
        assertEq(sameP.claim(25),333); assertEq(otherP.claim(25),233);
        a.setPaused(false); p.returnSeed(); assertEq(t.balanceOf(address(p)),20);
        assertEq(t.balanceOf(pmCustody),5); assertEq(sameP.tLeft(),50); assertEq(otherP.tLeft(),50);
        assertEq(sameP.claim(50),667); assertEq(otherP.claim(50),467);
        assertEq(a.balanceOf(address(this)),1001); // Real seed P never entered either modeled pot.
    }
    function test_R10_exactSeedGateAndLastRedemptionNoLeaveBehind() public {
        vm.expectRevert(); p.redeem(1, 0, address(this));
        p.load(); assertEq(p.notifications(), 1); vm.expectRevert(); p.load();
        p.graduate(); assertEq(p.redeem(30, 300, address(this)), 300);
        assertEq(p.redeem(70, 701, address(this)), 701);
        assertEq(t.totalSupply(), 0); assertEq(a.balanceOf(address(p)), 0);
    }
    function test_R10_wrongTransferMinRecipientAndPauseRollback() public {
        a.setFeeBps(100); vm.expectRevert(); p.load(); assertFalse(p.loaded());
        a.setFeeBps(0); p.load(); p.graduate();
        vm.expectRevert(); p.redeem(1, 11, address(this));
        vm.expectRevert(); p.redeem(1, 0, address(0));
        a.setPaused(true); vm.expectRevert(); p.redeem(10, 0, address(this));
        assertEq(t.totalSupply(), 100); assertEq(t.balanceOf(address(this)), 100);
        a.setPaused(false); a.setFeeBps(100); vm.expectRevert(); p.redeem(10, 0, address(this));
        assertEq(t.totalSupply(), 100);
        a.setFeeBps(0); assertEq(p.redeem(10, 100, address(this)), 100);
    }
    function test_R11_pausedSeedDoesNotBlockFailureAndExcludedTStays() public {
        p.load(); t.transfer(address(p), 20); a.setPaused(true); p.fail();
        assertEq(p.excludedT(), 20); assertEq(t.totalSupply() - p.excludedT(), 80);
        vm.expectRevert(); p.returnSeed(); assertFalse(p.returned());
        a.setPaused(false); vm.prank(address(0xB0B)); p.returnSeed();
        assertEq(a.balanceOf(address(this)), 1001); assertEq(t.balanceOf(address(p)), 20);
        vm.expectRevert(); p.returnSeed(); vm.expectRevert(); p.redeem(20, 0, address(this));
    }
    function test_R10_zeroSeedAndOwnTRefusal() public {
        PileModel empty = new PileModel(a, t, 0); assertTrue(empty.loaded());
        assertEq(empty.notifications(), 0); vm.expectRevert(); empty.load();
        vm.expectRevert(); new PileModel(t, t, 1);
    }
    function test_R10_reentryRollsBackBurnAndPayout() public {
        p.load(); p.graduate();
        a.armReentry(address(p), abi.encodeCall(p.redeem, (1, 0, address(this))));
        vm.expectRevert(); p.redeem(10, 0, address(this));
        assertEq(t.totalSupply(), 100); assertEq(a.balanceOf(address(p)), 1001);
    }
    function test_R10_changedBalanceCannotFakeExactSeed() public {
        a.armReentry(address(a), abi.encodeCall(a.mint, (address(p), 1)));
        vm.expectRevert(); p.load(); assertFalse(p.loaded());
        assertEq(a.balanceOf(address(this)), 1001); assertEq(a.balanceOf(address(p)), 0);
    }
    function testFuzz_R10_twoHoldersBothOrders(bool reverse) public {
        address bob = address(0xB0B); t.transfer(bob, 30);
        vm.prank(bob); t.approve(address(p), 30);
        vm.prank(bob); p.load(); p.graduate(); // Pull comes from recorded seeder, never the trigger.
        if (reverse) {
            p.redeem(70, 700, address(this)); vm.prank(bob); p.redeem(30, 301, bob);
        } else {
            vm.prank(bob); p.redeem(30, 300, bob); p.redeem(70, 701, address(this));
        }
        assertEq(a.balanceOf(bob) + a.balanceOf(address(this)), 1001);
        assertEq(t.totalSupply(), 0); assertEq(a.balanceOf(address(p)), 0);
    }
    function test_R10_productBeyond256Bits() public {
        t = new HostileToken("Box", "T", 18); t.mint(address(this), 1 << 100);
        p = new PileModel(a, t, 1 << 200); a.mint(address(this), 1 << 200);
        a.approve(address(p), 1 << 200); t.approve(address(p), 1 << 100); p.load(); p.graduate();
        assertEq(p.redeem(1 << 99, 0, address(this)), 1 << 199);
    }
    function testFuzz_R10_fullPrecisionAndDecimals(uint128 raw, uint8 decimals_, uint8 part) public {
        uint256 amount = uint256(raw) + 1;
        a = new HostileToken("Seed", "P", decimals_ % 3 == 0 ? 6 : decimals_ % 3 == 1 ? 8 : 18);
        p = new PileModel(a, t, amount); a.mint(address(this), amount);
        a.approve(address(p), amount); t.approve(address(p), 100); p.load(); p.graduate();
        uint256 first = uint256(part) % 99 + 1;
        uint256 paid = p.redeem(first, 0, address(this)); assertEq(paid, amount * first / 100);
        paid += p.redeem(100 - first, 0, address(this)); assertEq(paid, amount);
    }
}
