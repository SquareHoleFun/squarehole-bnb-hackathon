// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {MoneyFixture} from "./MoneyFixture.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @dev Only action selectors below are fuzzed. Ghost input counters are incremented at funding boundaries;
/// they never read a production ledger to decide what the ledger should contain.
contract LifecycleHandler is MoneyFixture {
    uint256 public incomingP;
    uint256 public incomingForeign;
    uint256 public buyerFees;
    uint256 public sellerFees;
    uint256 public lateReceiverP;
    uint256 public claimsPaid;
    uint256 public acceptedT;
    uint256 public initialLeft;
    uint256 public successfulClaims;
    uint256 public successfulClosure;
    /// The conversion Safe's foreign balance when the box failed: F136 lets nothing more reach it afterwards.
    uint256 public foreignAtSafeWhenFailed;
    uint256 internal constant K = 11;

    function setUp() public override {
        super.setUp();
        _give(ALICE, 101);
        _give(BOB, 203);
        _give(CAROL, 307);
        _vaultTokens(K + 37); // frozen surplus plus T backing unreturned placeholders
        vault.configure(0, K, false);
        _give(address(hook), 7);
        _give(address(fees), 13);
        _fundT(address(hook), 5);
        _fundT(address(fees), 2);
        _fundT(address(box), 3);
        _fund(p, address(hook), 1009);
        hook.configure(30, 15, 0); // only 45 P are fees; 964 P are principal
        incomingP = 1009;
    }

    function feed(uint96 buy, uint96 sell) external {
        uint256 b = uint256(buy) % 1e18;
        uint256 s = uint256(sell) % 1e18;
        incomingP += b + s;
        if (box.failed()) {
            lateReceiverP += b + s;
        } else {
            buyerFees += b;
            sellerFees += s;
        }
        _feed(b, s);
    }

    function royalty(uint96 seed) external {
        uint256 amount = uint256(seed) % 1e18;
        incomingP += amount;
        if (box.failed()) lateReceiverP += amount;
        _royaltyP(amount);
    }

    function foreignRoyalty(uint96 seed, bool blocked) external {
        uint256 amount = uint256(seed) % 1e18;
        foreignCoin.setBlocked(CONVERSION, blocked);
        incomingForeign += amount;
        _royaltyForeign(amount);
    }

    function forward(bool blocked) external {
        foreignCoin.setBlocked(CONVERSION, blocked);
        // RC5: there is no forwarding call; foreign money stayed at its sender.
    }

    function gift(uint96 seed, bool receiverGift) external {
        uint256 amount = uint256(seed) % 1e18;
        incomingP += amount;
        _fund(p, receiverGift ? address(fees) : address(box), amount);
        if (receiverGift) {
            if (box.failed()) lateReceiverP += amount;
            else buyerFees += amount;
            fees.collect(address(0));
        }
    }

    function tax(uint96 seed) external {
        uint256 amount = uint256(seed) % 1e18;
        incomingP += amount;
        _tax(amount);
    }

    function close(bool hatch, bool refuseBurn, bool refuseSweep) public {
        if (box.failed()) return;
        vault.configure(refuseBurn ? SUPPLY : 0, K, false);
        router.configure(refuseSweep, false);
        if (hatch) {
            hook.fill();
            vm.warp(hook.closedAt() + 7 days);
        } else {
            _expire();
        }
        box.fail();
        foreignAtSafeWhenFailed = foreignCoin.balanceOf(CONVERSION);
        buyerFees += 45;
        initialLeft = _left();
        assertEq(initialLeft, 648, "system balances and frozen K excluded exactly");
        ++successfulClosure;
        router.configure(false, false);
    }

    function handBack(uint8 actorSeed, uint96 seed) public {
        if (!box.failed()) return;
        uint256 amount = bound(seed, 0, t.balanceOf(address(vault)) - K);
        vm.prank(address(vault));
        t.transfer(_actor(actorSeed), amount); // scripted vault boundary: outstanding E becomes wallet T
    }

    function transferHolder(uint8 fromSeed, uint8 toSeed, uint96 seed) external {
        address from = _actor(fromSeed);
        uint256 amount = bound(seed, 0, t.balanceOf(from));
        vm.prank(from);
        t.transfer(_actor(toSeed), amount);
    }

    function claim(uint8 whoSeed, uint8 toSeed, uint96 seed, bool paused) public {
        if (!box.failed()) return;
        address who = _actor(whoSeed);
        uint256 bal = t.balanceOf(who);
        if (bal == 0) return;
        uint256 amount = bound(seed, 1, bal);
        uint256 pot = _pot();
        uint256 left = _left();
        if (paused) {
            priceToken.setPaused(true);
            vm.prank(who);
            (bool ok,) = address(box).call(abi.encodeCall(box.claim, (amount, _actor(toSeed))));
            // Zero-P claims need no token transfer, so a pause may still allow them.
            if (ok) {
                acceptedT += amount;
                ++successfulClaims;
            } else {
                assertEq(_pot(), pot, "failed payout changed pot");
                assertEq(_left(), left, "failed payout changed denominator");
                assertEq(t.balanceOf(who), bal, "failed payout took holder T");
            }
            priceToken.setPaused(false);
            return;
        }
        uint256 available = pot + _balance(address(router));
        uint256 expected = amount == left ? available : FullMath.mulDiv(available, amount, left);
        uint256 paid = _claim(who, amount, _actor(toSeed));
        assertEq(paid, expected, "claim must include swept tax and round down");
        claimsPaid += paid;
        acceptedT += amount;
        ++successfulClaims;
    }

    function payouts(bool blockedFit, bool blockedPlatform) public {
        priceToken.setBlocked(FIT, blockedFit);
        priceToken.setBlocked(PLATFORM, blockedPlatform);
        fees.payFit();
        fees.payPlatform();
        priceToken.setBlocked(FIT, false);
        priceToken.setBlocked(PLATFORM, false);
    }

    function sweep() public {
        if (!box.failed()) return;
        if (_balance(address(router)) != 0) router.sweep();
        if (_left() == 0) {
            // Exhausted-pot receipts remain locked.
            NoFailureSweep.check(address(box));
        } else {
            uint256 pot = _pot();
            NoFailureSweep.check(address(box));
            assertEq(_pot(), pot, "sweep spent a holder's claim");
        }
    }

    function assertConservation() public view {
        uint256 custody = _claimsP(address(box)) + _claimsP(address(hook)) + _claimsP(address(fees));
        uint256 paid = _balance(ALICE) + _balance(BOB) + _balance(CAROL);
        assertEq(paid, claimsPaid, "only counted claims pay holders");
        assertEq(
            custody + paid + _balance(FIT) + _balance(PLATFORM) + _balance(address(router)),
            incomingP,
            "all incoming P has exactly one owner"
        );
        assertEq(foreignCoin.balanceOf(address(this)), incomingForeign);
        assertEq(foreignCoin.balanceOf(FIT) + foreignCoin.balanceOf(CREATOR), 0);
        if (box.failed()) {
            assertEq(foreignCoin.balanceOf(CONVERSION), foreignAtSafeWhenFailed, "a failed box forwards nothing (F136)");
        }
        _assertBooked();
    }

    function assertFeeOwnership() public view {
        uint256 units = buyerFees / 15 + sellerFees / 15;
        uint256 expectedFit = 2 * units;
        assertEq(fees.fitOwed() + _balance(FIT), expectedFit, "FIT does not consume principal or royalty escrow");
        assertEq(fees.platformOwed() + _balance(PLATFORM), units, "platform split once per side");
        if (!box.failed()) {
            assertEq(fees.creatorP(), 10 * (buyerFees / 15));
            assertEq(fees.buyBackP(), 10 * (sellerFees / 15));
            assertEq(fees.poolHeldP(), 2 * units);
            assertEq(fees.booked(p) - _ledgerSum(), buyerFees % 15 + sellerFees % 15);
        } else {
            assertEq(fees.creatorP() + fees.buyBackP() + fees.poolHeldP() + fees.growHeldP() + fees.royaltyHeldP(), 0);
            assertEq(_claimsP(address(hook)), 0, "depth budget cannot survive failure beside pot");
        }
    }

    function assertOutstanding() public view {
        if (!box.failed()) return;
        assertEq(_left(), t.balanceOf(ALICE) + t.balanceOf(BOB) + t.balanceOf(CAROL) + t.balanceOf(address(vault)) - K);
        assertEq(_left() + acceptedT, initialLeft, "each surrendered coin counted once");
        assertFalse(box.graduated());
        assertEq(successfulClosure, 1);
    }

    function finish() external {
        close(true, true, false);
        fees.collect(address(0));
        uint256 retained = _left() == 0 ? _pot() + _balance(address(router)) : 0;
        handBack(0, type(uint96).max);
        // Drain the actual remaining E, independent of bound()'s modulo mapping.
        uint256 escrow = t.balanceOf(address(vault)) - K;
        vm.prank(address(vault));
        t.transfer(ALICE, escrow);
        for (uint8 i; i < 3; ++i) {
            address who = _actor(i);
            uint256 amount = t.balanceOf(who);
            if (amount == 0) continue;
            uint256 paid = _claim(who, amount, who);
            claimsPaid += paid;
            acceptedT += amount;
            ++successfulClaims;
        }
        sweep();
        payouts(false, false);
        foreignCoin.setBlocked(CONVERSION, false);
        // RC5: there is no forwarding call; foreign money stayed at its sender.
        assertEq(_pot(), retained, "last holder takes the remainder; exhausted-pot receipts stay locked");
        assertEq(_left(), 0);
        assertEq(fees.booked(p), 0, "every P ledger has an exit");
        // F136 (SH-V21-RC5-INT fix round): what the Safe had at the failure is all it gets; the rest stays locked here.
        assertEq(foreignCoin.balanceOf(CONVERSION), foreignAtSafeWhenFailed);
        assertGt(successfulClaims, 0, "campaign must exercise claims");
        assertConservation();
        assertFeeOwnership();
        assertOutstanding();
    }

    function _actor(uint8 seed) internal pure returns (address) {
        return seed % 3 == 0 ? ALICE : seed % 3 == 1 ? BOB : CAROL;
    }
}

contract LifecycleInvariantTest is StdInvariant, Test {
    LifecycleHandler internal handler;

    function setUp() public {
        handler = new LifecycleHandler();
        handler.setUp();
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = handler.feed.selector;
        selectors[1] = handler.royalty.selector;
        selectors[2] = handler.foreignRoyalty.selector;
        selectors[3] = handler.forward.selector;
        selectors[4] = handler.gift.selector;
        selectors[5] = handler.tax.selector;
        selectors[6] = handler.close.selector;
        selectors[7] = handler.handBack.selector;
        selectors[8] = handler.transferHolder.selector;
        selectors[9] = handler.claim.selector;
        selectors[10] = handler.payouts.selector;
        selectors[11] = handler.sweep.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_PAndForeignRoyaltyConservation() public view {
        handler.assertConservation();
    }

    function invariant_feeLedgersStaySeparateFromPrincipal() public view {
        handler.assertFeeOwnership();
    }

    function invariant_tLeftEqualsWalletsAndRedeemableEscrow() public view {
        handler.assertOutstanding();
    }

    function afterInvariant() public {
        handler.finish();
    }
}
