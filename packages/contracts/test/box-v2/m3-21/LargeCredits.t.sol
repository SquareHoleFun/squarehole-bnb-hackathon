// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {ItemCoordinatorDouble, JournalDouble} from "../m3-20/Fixture.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {ClaimActor} from "./HostileClaims.t.sol";

/// @dev AF1: default-profile production ledger, upstream-profile real PM, individually backed receipts.
/// No storage injection or enlarged stipend. Setup aggregates separate funding/sync transactions for convenience.
contract LargeItemCreditsTest is Test {
    uint256 private constant TRANCHE = uint256(uint128(type(int128).max));
    uint256 private constant RECEIPT = uint256(1) << 126;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant KEEPER = address(0xCA11);
    address private constant DEPTH = address(0xD3);
    IPoolManager private pm;
    ItemLedgerV2 private ledger;
    JournalDouble private j;
    HostileToken private token;
    address private price;
    uint256 private paid;

    event ItemPaid(uint256 indexed id, address indexed owner, address indexed to, uint256 grossP, uint256 tipP);

    function setUp() public {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        token = new HostileToken("Price", "P", 18);
        _deploy(address(token), 1, type(uint256).max);
    }

    function _deploy(address p, uint256 legacyMinimum, uint256 legacyTipCap) private {
        price = p;
        address ci = address(new ItemCoordinatorDouble());
        ItemCoordinatorDouble c = ItemCoordinatorDouble(BoxClones.create(BoxClones.initCode(ci, "")));
        j = new JournalDouble(pm, 16, 1, 2);
        address implementation = deployCode("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(pm, ci));
        bytes memory args = abi.encodePacked(
            address(c),
            address(j),
            address(j),
            address(j),
            address(j),
            DEPTH,
            p,
            uint8(1),
            uint8(2),
            legacyMinimum,
            legacyTipCap
        );
        ledger = ItemLedgerV2(BoxClones.create(BoxClones.initCode(implementation, args)));
        c.configure(address(pm), address(j), DEPTH, address(ledger));
        c.setPrice(p);
        j.wire(address(c), address(ledger), 1);
        j.setPrice(p);
        vm.etch(DEPTH, hex"00");
        c.initializeLedger();
    }

    function _ids() private pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = 1;
    }

    function _balance(address who) private view returns (uint256) {
        return price == address(0) ? who.balance : token.balanceOf(who);
    }

    function _fund(uint256 amount) private {
        if (price == address(0)) vm.deal(address(j), amount);
        else token.mint(address(j), amount);
        j.fund(1, 2, 0, amount);
    }

    function _accrue(uint256 receipts, bool outside) private returns (uint256 credit) {
        j.graduate();
        if (outside) j.pick(1, ALICE);
        for (uint256 i; i < receipts; ++i) {
            _fund(RECEIPT); // Each settle/mint is below int128.max.
            if (i % 32 == 31) ledger.sync(32);
        }
        if (!outside) j.pick(1, ALICE);
        while (ledger.fundingCursor() != j.itemFundingCount() || ledger.lifecycleCursor() != j.itemLifecycleCount()) {
            ledger.sync(32);
        }
        credit = receipts * (RECEIPT / 16);
        _check(credit);
    }

    function _cool() private {
        vm.cool(address(pm));
        vm.cool(address(ledger));
        vm.cool(address(j));
        vm.cool(address(j.history()));
        vm.cool(ALICE);
        vm.cool(BOB);
        vm.cool(KEEPER);
        if (price != address(0)) vm.cool(price);
    }

    function _check(uint256 credit) private view {
        (uint256 outside, uint256 stash) = ledger.itemCredit(1);
        assertEq(outside + stash, credit, "unpaid credit stays with item");
        uint256 backing = pm.balanceOf(address(ledger), uint160(price));
        assertEq(backing + paid, j.history().ledgerTransferred(), "every debit has a real payout");
        assertEq(_balance(address(pm)), backing, "real P backs remaining claims");
        assertEq(_balance(ALICE) + _balance(BOB) + _balance(KEEPER), paid, "recipient conservation");
        assertEq(pm.balanceOf(DEPTH, uint160(price)), 0, "no credit becomes residue");
    }

    function _ownerClaim(address owner, address to, uint256 expected) private {
        _cool();
        vm.expectEmit(true, true, true, true, address(ledger));
        emit ItemPaid(1, owner, to, expected, 0);
        vm.prank(owner);
        assertEq(ledger.claim{gas: 5_000_000}(_ids(), to), expected);
        paid += expected;
    }

    function _drainOwner(uint256 remaining, address owner) private {
        while (remaining != 0) {
            uint256 tranche = remaining > TRANCHE ? TRANCHE : remaining;
            _ownerClaim(owner, owner, tranche);
            remaining -= tranche;
            _check(remaining);
        }
        vm.prank(owner);
        vm.expectRevert(ItemLedgerV2.InvalidClaim.selector);
        ledger.claim(_ids(), owner);
    }

    function test_ownerFullyWithdrawsReportedTwoTo132Credit() public {
        uint256 gross = _accrue(1024, true);
        assertEq(gross, uint256(1) << 132);
        _drainOwner(gross, ALICE); // 33 cold payouts; the former single capped call always reverted.
        assertEq(token.balanceOf(ALICE), gross);
        assertEq(pm.balanceOf(address(ledger), uint160(price)), gross * 15);
    }

    function test_ownerFullyWithdrawsLargeCreditToChosenRecipientWithoutTip() public {
        uint256 remaining = _accrue(1024, true);
        while (remaining != 0) {
            uint256 tranche = remaining > TRANCHE ? TRANCHE : remaining;
            _ownerClaim(ALICE, BOB, tranche);
            remaining -= tranche;
            _check(remaining);
        }
        assertEq(token.balanceOf(KEEPER), 0);
        assertEq(token.balanceOf(BOB), uint256(1) << 132);
    }

    function test_nativeStashRemainderFollowsTransferAndReturnWithNewFunding() public {
        _deploy(address(0), 100, 30);
        uint256 gross = _accrue(128, false); // Keep stash only; needs five signed parts.
        _ownerClaim(ALICE, ALICE, TRANCHE);
        _check(gross - paid);
        j.move(1, BOB);
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        ledger.claim(_ids(), ALICE);
        j.back(1);
        _fund(16 * 41); // New inside stash remains separate from the already paid tranche.
        ledger.sync(32);
        vm.expectRevert(ItemLedgerV2.InvalidClaim.selector);
        ledger.claim(_ids(), ALICE);
        j.pick(1, BOB);
        _fund(16 * 59); // Outside-first debit then crosses into the retained stash.
        ledger.sync(32);
        _check(gross + 100 - paid);
        _drainOwner(gross + 100 - paid, BOB);
    }

    function test_legacyThresholdAboveTrancheCannotBlockOwner() public {
        _deploy(address(token), type(uint256).max, type(uint256).max);
        uint256 gross = _accrue(128, true);
        _drainOwner(gross, ALICE);
    }

    function test_smallTailRemainsClaimableByOwner() public {
        _deploy(address(token), 100, 30);
        uint256 remaining = _accrue(128, true);
        while (remaining >= TRANCHE) {
            _ownerClaim(ALICE, ALICE, TRANCHE);
            remaining -= TRANCHE;
            _check(remaining);
        }
        assertEq(remaining, 4);
        _drainOwner(remaining, ALICE);
    }

    function test_pausedPPreservesLargeRemainderThenOwnerRetries() public {
        uint256 gross = _accrue(128, true);
        token.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.PayoutFailed.selector);
        ledger.claim{gas: 5_000_000}(_ids(), BOB);
        _check(gross);
        token.setPaused(false);
        _ownerClaim(ALICE, BOB, TRANCHE);
        _check(gross - paid);
        _drainOwner(gross - paid, ALICE);
    }

    function test_refused7702OwnerRollsBackTrancheThenRetries() public {
        _deploy(address(0), 1, type(uint256).max);
        uint256 gross = _accrue(128, true);
        ClaimActor delegate = new ClaimActor();
        vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(delegate)));
        ClaimActor(payable(ALICE)).configure(TRANCHE, false, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.PayoutFailed.selector);
        ledger.claim{gas: 5_000_000}(_ids(), ALICE);
        _check(gross);
        ClaimActor(payable(ALICE)).configure(0, false, address(0), "");
        _ownerClaim(ALICE, ALICE, TRANCHE);
        _check(gross - paid);
        _drainOwner(gross - paid, ALICE);
    }
}
