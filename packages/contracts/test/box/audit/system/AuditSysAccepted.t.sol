// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {AuditSysChecks} from "./AuditSysChecks.sol";
import {AuditSysHandler} from "./AuditSysHandler.sol";
import {Act, Exc} from "./AuditSysWorld.sol";

/// @title AuditSysAcceptedTest
/// @notice TEST ONLY (SH-AUDIT-B0 round 2). The accepted findings the system campaign meets, pinned on its own world as
/// accepted behaviour (`box0-audit/findings.md`; plan § 4.3's `testAccepted_`), each with the campaign's named
/// exception or X21 class it lands in; and two controls that show the campaign's checks are live (an undocumented write
/// and an unbooked wei are each caught). Start: shard S2's (graduated on r0, word accepted, five Misfits outside).
/// forge-config: default.evm_version = "osaka"
contract AuditSysAcceptedTest is AuditSysChecks {
    AuditSysHandler internal h;
    uint256[] internal items;

    function setUp() public override {
        super.setUp();
        _toGraduated();
        _advance(1);
        _post(r0);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        h = new AuditSysHandler(this);
        _setUpSys("ACC", address(h));
        gRewardHolder = keeper;
        gReward = graduationReward;
        for (uint256 id = 1; id <= 5; ++id) {
            address owner = tickets.ownerOf(id);
            ItemReveal memory r = tree.itemReveal(tickets.numberOf(id));
            vm.prank(owner);
            uint256 item = tickets.open(id, r);
            ++gBurnedPlaceholders;
            _noteDelivered(item);
            items.push(item);
        }
        _syncGhosts();
        safe0 = safe.balance;
    }

    /// W1-U4-2 (note; FQ-09 default: text only): credits per epoch stay at most 32 ETH, but one `payPlatform` in epoch 1
    /// pays epoch 0's credit and epoch 1's together: 64 ETH reach the Safe inside epoch 1. The campaign's X07 checks the
    /// accepted reading (credits ≤ (k + 1) × 32 ETH by the end of epoch k) and counts the late payout as Exc.W1_U4_2.
    function testAccepted_AUDIT_SYS_W1_U4_2_latePayoutCarriesEarlierCredits() public {
        uint256 cap = BoxSpecV1.PLATFORM_CAP_WEI;
        _fundFees(eoa[4], 300 ether);
        (, uint256 kept0,) = receiver.platformEpoch();
        assertEq(kept0, cap, "epoch 0: the cap is credited");
        _warpTo(coordinator.graduatedAt() + 30 days + 1);
        _fundFees(eoa[4], 300 ether);
        (uint256 epoch, uint256 kept1,) = receiver.platformEpoch();
        assertEq(epoch, 1, "epoch 1");
        assertEq(kept1, cap, "epoch 1: the cap is credited again (no carry-over)");
        uint256 owed = receiver.platformOwed();
        uint256 s0 = safe.balance;
        uint256 paid = _payPlatform(keeper);
        _notePlatformPaid(paid);
        assertEq(paid, owed, "one payout pays every unpaid credit");
        assertEq(safe.balance - s0, 2 * cap, "W1-U4-2: 64 ETH reach the Safe inside epoch 1");
        assertEq(excCount[uint256(Exc.W1_U4_2)], 1, "the campaign's named exception counts it");
        assertEq(excMax[uint256(Exc.W1_U4_2)], cap, "by 32 ETH above the cap in that epoch");
        _checkX07_platformCap();
        _checkX01_ethConservation();
    }

    /// W1-U4-3 (note; text): a stranger's 1-wei ERC-6909 gift leaves the receiver's claims above Σ ledgers by the next
    /// batch; X09 checks claims ≥ ledgers and counts the next batch as Exc.W1_U4_3.
    function testAccepted_AUDIT_SYS_W1_U4_3_claimsAboveLedgersByTheNextBatch() public {
        (uint256 qb0,) = receiver.booked();
        uint256 qc0 = pm.balanceOf(a.receiver, 0);
        h.giftClaims(0, 0); // a 1-wei ETH claims gift to the receiver, through the handler's action frame
        (uint256 qb1,) = receiver.booked();
        assertEq(qb1, qb0, "the gift is in no ledger");
        assertEq(pm.balanceOf(a.receiver, 0), qc0 + 1, "the receiver's claims rose by the gift");
        _checkX09_claimsMatchLedgers();
        assertGe(excCount[uint256(Exc.W1_U4_3)], 1, "the campaign's named exception counts the next batch");
        _checkX01_ethConservation();
    }

    /// W3-U7-1 (low; FQ-41 default: accept and list): an item sent with `transferFrom` to the stream stays there for
    /// good (no box contract can move it; `returnItem` needs the owner; the stream refuses to claim for itself), its
    /// return principal stays reserved in E and its stream share is never paid; `safeTransferFrom` to a box contract is
    /// refused. The campaign counts it (Exc.W3_U7_1) and X21 reports its size.
    function testAccepted_AUDIT_SYS_W3_U7_1_itemSentToTheStreamHasNoExit() public {
        uint256 item = items[0];
        address owner = collection.ownerOf(item);
        vm.prank(owner);
        vm.expectRevert();
        collection.safeTransferFrom(owner, a.itemStream, item);
        uint256 m0 = vault.outside();
        vm.prank(owner);
        collection.transferFrom(owner, a.itemStream, item);
        gStuck.push(item);
        gStuckAt[item] = a.itemStream;
        assertEq(collection.ownerOf(item), a.itemStream, "the stream holds the item");
        assertEq(vault.outside(), m0, "the vault still counts it outside (its principal stays in E)");
        uint256[] memory one = new uint256[](1);
        one[0] = item;
        vm.expectRevert();
        stream.claimFor(a.itemStream, one);
        vm.prank(owner);
        vm.expectRevert();
        vault.returnItem(item, 0, vm.getBlockTimestamp());
        _checkX03_items();
        _closing();
        assertEq(gEnd[12], 1, "X21: one item in the W3-U7-1 class");
    }

    /// M01, M02, M25 (accepted, F126): raw T sent to the receiver, the royalty router and the hook stays there through
    /// collects, flushes and deepens; X02 holds each balance to exactly what was sent (Exc.M01/M02/M25).
    function testAccepted_AUDIT_SYS_M01_M02_M25_rawTAtBoxAddressesStays() public {
        address holder = eoa[0];
        uint256 amount = token.balanceOf(holder) / 10;
        address[3] memory to = [a.receiver, a.royaltyRouter, a.hook];
        for (uint256 i; i < 3; ++i) {
            this.x_transferT(holder, to[i], amount);
            _noteDirectT(to[i], amount, true);
        }
        _fundFees(eoa[4], 1 ether);
        _payRoyalty(eoa[4], 0.1 ether);
        vm.prank(keeper);
        royaltyRouter.flush();
        assertEq(token.balanceOf(a.receiver) - receiver.tBurnPending(), amount, "M01: the receiver keeps the raw T");
        assertEq(token.balanceOf(a.royaltyRouter), amount, "M02: the royalty router keeps the raw T");
        assertEq(token.balanceOf(a.hook), amount, "M25: the hook keeps the raw T");
        vm.prank(keeper);
        vm.expectRevert();
        royaltyRouter.sweep(a.token);
        _checkX02_tSupply();
        assertEq(excCount[uint256(Exc.M01)], 1, "Exc.M01");
        assertEq(excCount[uint256(Exc.M02)], 1, "Exc.M02");
        assertEq(excCount[uint256(Exc.M25)], 1, "Exc.M25");
    }

    /// M27 (accepted, F126 with F83 C5): ETH forced onto the DrandSource stays beside its pots and credits; the
    /// poster's withdrawal pays only its credits. X01's DrandSource identity carries it, X21 reports it.
    function testAccepted_AUDIT_SYS_M27_forcedEthAtTheSourceStays() public {
        uint256 b0 = address(drand).balance;
        _forceEth(address(drand), 1 ether);
        gForced[address(drand)] += 1 ether;
        gForcedTotal[address(drand)] += 1 ether;
        assertEq(address(drand).balance, b0 + 1 ether, "the forced ETH is held");
        _checkX01_ethConservation();
        _closing();
        assertGe(gEnd[5], 1 ether, "X21: the forced ETH is in the no-exit class");
        assertEq(address(drand).balance, gEnd[4] + 1 ether, "only pots and the forced ETH stay at the source");
    }

    /// Control: an action that writes a contract outside its allow-list is caught by X17.
    function testControl_AUDIT_SYS_x17FlagsAnUndocumentedWrite() public {
        _fundFees(eoa[4], 1 ether);
        allowedWrites[uint256(Act.PayPlatform)] = 0;
        h.payPlatform(1);
        assertEq(violations, 1, "X17 flagged the write");
        assertEq(bytes(lastViolation)[0], bytes1("X"), "named X17");
        vm.expectRevert();
        this.xc_actions();
    }

    /// Control: the cross-call checks run in the action frame and their ghosts persist between calls (forge keeps no
    /// write an invariant makes): a ghost set past the state is caught by the next action.
    function testControl_AUDIT_SYS_crossCallChecksRunInTheActionFrame() public {
        gSupply = token.totalSupply() - 1;
        h.poke(0);
        assertEq(violations, 1, "X02's never-rises check ran after the action");
        assertEq(gSupply, token.totalSupply(), "and its ghost persisted");
        gWord[0] = bytes32(uint256(1));
        h.addBounty(1, 0);
        assertEq(violations, 2, "X11's never-changes check ran after an action that wrote a source");
        assertEq(keccak256(bytes(lastViolation)), keccak256("X11: a word changed once non-zero"), "named X11");
    }

    /// Control: a wei moved into box 0 without booking breaks X01.
    function testControl_AUDIT_SYS_x01FlagsAnUnbookedWei() public {
        vm.deal(a.hook, a.hook.balance + 1);
        vm.expectRevert();
        this.xc_x01();
    }
}

/// @title AuditSysAcceptedCurveTest
/// @notice W2-U2-2 (low; FQ-17 default: accept as built and amend BC-029/BC-067/BC-027) on the system world: T sent to
/// the coordinator before graduation joins the ask (BC-043) and can leave the bid sentinel empty (two positions). The
/// campaign's X16 accepts an empty sentinel only after such a gift and counts it (Exc.W2_U2_2).
/// forge-config: default.evm_version = "osaka"
contract AuditSysAcceptedCurveTest is AuditSysChecks {
    AuditSysHandler internal h;

    function setUp() public override {
        super.setUp();
        _toClosed();
        h = new AuditSysHandler(this);
        _setUpSys("ACC1", address(h));
        safe0 = safe.balance;
    }

    function testAccepted_AUDIT_SYS_W2_U2_2_tGiftToTheCoordinatorCanEmptyTheSentinel() public {
        uint256 share = coordinator.poolShare();
        uint256 gift = token.balanceOf(eoa[2]) / 2;
        assertGt(gift, share / 10, "fixture: a gift of a tenth of the pool share or more");
        this.x_transferT(eoa[2], a.coordinator, gift);
        _noteDirectT(a.coordinator, gift, false);
        assertEq(coordinator.poolShare(), share + gift, "BC-043: the gift joins the ask's T");
        h.graduate(0, 5);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertGt(ask, 0, "the ask");
        assertGt(bid, 0, "the bid");
        assertEq(sentinel, 0, "W2-U2-2: no sentinel (two positions)");
        assertEq(excCount[uint256(Exc.W2_U2_2)], 1, "the campaign's named exception counts it");
        _checkX16_pool();
        _checkX06_graduationOnce();
        assertEq(violations, 0, lastViolation);
    }
}
