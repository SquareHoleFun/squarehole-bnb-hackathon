// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {MoneyFixture, FeeBatchV2, BoxClones} from "./MoneyFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract RoyaltyGasSink {
    receive() external payable {
        assembly { invalid() }
    }
}

contract RoyaltySafe {
    receive() external payable {}
}

contract MoneyPropertiesTest is MoneyFixture {
    function testFuzz_allNineMenusConserveEachSideAcrossBatches(uint96 a, uint96 b, uint96 c) public {
        uint256 buyers = uint256(a) + c;
        uint256 sellers = uint256(b) + c;
        for (uint8 buy = 1; buy <= 3; ++buy) {
            for (uint8 sell = 1; sell <= 3; ++sell) {
                _realBox(buy, sell, 1, false, address(priceToken));
                _feed(a, b);
                _assertBooked();
                _feed(c, c);
                uint256 bu = buyers / 15;
                uint256 su = sellers / 15;
                assertEq(fees.fitOwed(), 2 * (bu + su));
                assertEq(fees.platformOwed(), bu + su);
                assertEq(fees.poolHeldP(), 2 * (bu + su));
                assertEq(fees.creatorP(), _choice(buy, sell, 1, bu, su));
                assertEq(fees.buyBackP(), _choice(buy, sell, 2, bu, su));
                assertEq(fees.growHeldP(), _choice(buy, sell, 3, bu, su));
                assertEq(fees.booked(p), buyers + sellers);
                assertEq(fees.booked(p) - _ledgerSum(), buyers % 15 + sellers % 15);
                _assertBooked();
            }
        }
    }

    /// @dev SH-V21-FUZZ-AMS: the first input reported on Amsterdam, where every input ran out of the default 2^30
    /// test gas while building the ninth box. The bound holds on every EVM and profile, so a rehearsal budget cannot
    /// hide it.
    function test_nineMenusFitHalfTheDefaultTestBudget() public {
        uint256 start = gasleft();
        testFuzz_allNineMenusConserveEachSideAcrossBatches(1298, type(uint96).max, type(uint96).max);
        assertLt(start - gasleft(), 1 << 29, "nine boxes stay under half the default test gas");
    }

    /// @dev SH-V21-FUZZ-AMS: as in production, every box is a clone of one release. The coordinator, T and receiver
    /// code, with the receiver's shared parts, are deployed once per fixture and never again per box.
    function test_boxesShareOneRelease() public {
        address coordinatorCode = _cloneTarget(address(box));
        address tokenCode = _cloneTarget(address(t));
        address receiverCode = _cloneTarget(address(fees));
        address firstBox = address(box);
        _realBox(3, 3, 1, false, address(priceToken));
        assertNotEq(address(box), firstBox, "a new box");
        assertTrue(BoxClones.isCloneOf(address(box), coordinatorCode), "same coordinator code");
        assertTrue(BoxClones.isCloneOf(address(t), tokenCode), "same T code");
        assertTrue(BoxClones.isCloneOf(address(fees), receiverCode), "same receiver code");
    }

    function testFuzz_graduationKeepsDepthBudgetOutOfPot(uint96 a, uint96 b, uint96 royalty, uint8 menu) public {
        uint8 buy = 1 + menu % 3;
        uint8 sell = 1 + (menu / 3) % 3;
        uint8 route = 1 + (menu / 9) % 3;
        _realBox(buy, sell, route, false, address(priceToken));
        _feed(a, b);
        _royaltyP(royalty);
        assertEq(fees.royaltyHeldP(), royalty, "royalties held whole before graduation");
        vm.expectRevert(IBoxReceiverV2.NotGraduated.selector);
        vm.prank(CREATOR);
        fees.claimCreator(p, CREATOR);
        hook.fill();
        box.graduate();
        uint256 bu = (uint256(a) + royalty) / 15;
        uint256 su = uint256(b) / 15;
        uint256 depth = 2 * (bu + su) + _choice(buy, sell, 3, bu, su);
        assertEq(_claimsP(address(hook)), depth);
        assertEq(_pot(), 0, "graduation depth never becomes failure pot");
        assertEq(fees.poolHeldP() + fees.growHeldP() + fees.royaltyHeldP(), 0);
        assertEq(fees.buyBackP(), _choice(buy, sell, 2, bu, su));
        uint256 creator = _choice(buy, sell, 1, bu, su);
        vm.prank(CREATOR);
        assertEq(fees.claimCreator(p, CREATOR), creator);
        assertEq(fees.fitOwed(), 2 * (bu + su));
        assertEq(fees.platformOwed(), bu + su);
        assertEq(_claimsP(address(fees)) + depth + creator, uint256(a) + b + royalty);
        vm.expectRevert();
        box.fail();
        _assertBooked();
    }

    function testFuzz_failurePrincipalReserveAndAllMenus(uint96 principalSeed, uint96 feeSeed, uint8 menu, bool nativeP)
        public
    {
        uint8 buy = 1 + menu % 3;
        uint8 sell = 1 + (menu / 3) % 3;
        _realBox(buy, sell, 1, false, nativeP ? address(0) : address(priceToken));
        uint256 principal = uint256(principalSeed);
        uint256 amount = uint256(feeSeed);
        _give(ALICE, 37);
        _give(BOB, 63);
        _feed(amount, amount + 7);
        _royaltyP(23);
        _fund(p, address(hook), principal + 31);
        hook.configure(16, 15, 0);
        _expire();
        box.fail();
        uint256 bu = (amount + 31) / 15;
        uint256 su = (amount + 7) / 15;
        uint256 dust = (amount + 31) % 15 + (amount + 7) % 15;
        uint256 fit = 2 * (bu + su);
        assertEq(fees.fitOwed(), fit);
        assertEq(fees.platformOwed(), bu + su);
        uint256 expectedPot = principal + 23 + 12 * (bu + su) + dust;
        assertEq(_pot(), expectedPot, "only reserve and fees enter the split");
        assertEq(_left(), 100);
        assertEq(_claimsP(address(hook)), 0);
        uint256 paid = _claim(ALICE, 19, ALICE);
        paid += _claim(BOB, 63, BOB);
        paid += _claim(ALICE, 18, ALICE);
        assertEq(paid, expectedPot, "arbitrary claim partition includes last raw unit");
        assertEq(_pot(), 0);
        _fund(p, address(box), 29);
        _tax(11);
        router.sweep();
        NoFailureSweep.check(address(box));
        NoFailureSweep.check(address(box));
        assertEq(fees.fitOwed(), fit);
        assertEq(fees.payFit(), fit);
        assertEq(fees.payPlatform(), bu + su);
        assertEq(fees.booked(p), 0);
    }

    function testFuzz_noBuyerReturnIsFixedAndLateMoneyCannotReopenIt(uint96 initial, uint96 late, bool sweepFirst)
        public
    {
        _realBox(1, 1, 1, false, address(priceToken));
        _fund(p, address(hook), initial);
        _expire();
        box.fail();
        _fund(p, address(box), late);
        _tax(7);
        router.sweep();
        assertEq(box.quoteClaim(0), initial);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(ALICE);
        box.claim(0, ALICE);
        if (sweepFirst) NoFailureSweep.check(address(box));
        assertEq(_claim(CREATOR, 0, ALICE), initial);
        if (!sweepFirst) NoFailureSweep.check(address(box));
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
        assertEq(fees.fitOwed(), 0);
        assertEq(_pot(), uint256(late) + 7);
    }

    function testFuzz_refusedCollectTipStaysUnbookedThenRejoinsBuyers(uint96 seed, uint96 sellers) public {
        uint256 buyers = bound(seed, 1000, 1e24);
        _fund(p, address(fees), buyers + sellers);
        moneyHook.sales(sellers);
        priceToken.setPaused(true);
        FeeBatchV2 memory batch = fees.collect(ALICE);
        uint256 reserved = buyers / 20;
        if (reserved > 100) reserved = 100;
        assertEq(batch.tip, 0);
        assertEq(batch.buyersP, buyers - reserved);
        assertEq(batch.sellersP, sellers);
        assertEq(_claimsP(address(fees)) - fees.booked(p), reserved);
        assertEq(_claimsP(ALICE), 0, "no unusable tip claims fallback");
        fees.collect(address(0));
        assertEq(fees.booked(p), buyers + sellers);
        assertEq(fees.creatorP(), 10 * (buyers / 15));
        assertEq(fees.buyBackP(), 10 * (uint256(sellers) / 15));
        _assertBooked();
    }

    function test_RC5_rejectedForeignIntakeCannotBlockClosureOrLateP() public {
        vm.deal(address(this), 42);
        vm.expectRevert(); fees.fundRoyalty{value: 42}(address(0), 42);
        _give(ALICE, 1); _fund(p, address(hook), 71); _expire(); box.fail();
        assertEq(_claim(ALICE, 1, ALICE), 71);
        _royaltyP(47);
        assertEq(fees.fitOwed(), 0); assertEq(_pot(), 47);
        assertEq(address(fees).balance, 0); assertEq(CONVERSION.balance, 0);
    }

    function _choice(uint8 buy, uint8 sell, uint8 choice, uint256 bu, uint256 su) internal pure returns (uint256) {
        return 10 * ((buy == choice ? bu : 0) + (sell == choice ? su : 0));
    }

    /// @dev The implementation inside a standard clone's runtime: bytes 10 to 29 of its 45-byte proxy.
    function _cloneTarget(address clone) private view returns (address target) {
        bytes memory code = clone.code;
        assembly ("memory-safe") {
            target := shr(96, mload(add(code, 42)))
        }
        assertTrue(BoxClones.isCloneOf(clone, target), "a standard clone");
    }
}
