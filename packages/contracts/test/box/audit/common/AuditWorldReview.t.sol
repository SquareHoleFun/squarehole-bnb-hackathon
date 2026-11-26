// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {EthIn, EthOut, TIn, TOut} from "./AuditGhostLedger.sol";
import {AuditPhases} from "./AuditPhases.sol";

/// @notice The R0-A world's review (integrator, 2026-10-21): the ghost ledger books every ETH and T path the units and
/// the R2 handler drive (plan § 3.2's action list), a payout to one of box 0's own addresses stays inside the ledger,
/// and `_toGraduated` refuses a clock that would make its graduation word another round than r0.
/// forge-config: default.evm_version = "osaka"
contract AuditWorldReviewTest is AuditPhases {
    /// External entry so a test can expect `_toGraduated`'s revert.
    function toGraduatedExternal() external {
        _toGraduated();
    }

    /// The keeper's reward claimed to one of box 0's own addresses (the royalty router accepts ETH) never left the
    /// system: nothing is booked as an exit and the ledger still balances.
    function test_review_rewardToABoxAddressStaysInside() public {
        _toGraduated();
        uint256 r0Before = a.royaltyRouter.balance;
        uint256 amount = _claimReward(keeper, a.royaltyRouter);
        assertEq(amount, graduationReward);
        assertEq(a.royaltyRouter.balance, r0Before + amount, "the reward reached the royalty router");
        assertEq(ghostEthOut(EthOut.Reward), 0, "not an exit");
        _assertGhostLedger();
    }

    /// The same for a poster's credit withdrawn to FIT's executor (which takes ETH from anyone).
    function test_review_bountyToABoxAddressStaysInside() public {
        _toDrawing();
        uint256 owed = drand.owedTo(poster);
        assertGt(owed, 0);
        assertEq(_withdrawBounty(poster, payable(a.executor)), owed);
        assertEq(ghostEthOut(EthOut.BountyWithdraw), 0, "not an exit");
        _assertGhostLedger();
    }

    /// A clock already past r0's request time when `_toGraduated` runs would fix a later round for the graduation word
    /// while the drivers and `silentRound` assume r0: the driver refuses instead of leaving a wrong state.
    function test_review_lateGraduationRefused() public {
        _toClosed();
        _warpTo(src.roundTime(r0) + 1 hours);
        vm.expectRevert(bytes("AuditPhases: the graduation word is round r0"));
        this.toGraduatedExternal();
    }

    /// Every ETH and T path the units drive that crosses box 0's boundary has a booked helper: picks and returns by
    /// batch, a stream claim for another account, a holder's own burn, a direct transfer to a box address (and one
    /// between outside holders, which books nothing), bounties on both sources, direct requests on both sources.
    function test_review_unitPathsBooked() public {
        _toDrawing();
        _buy(eoa[4], 1 ether);
        _sell(eoa[4], token.balanceOf(eoa[4]) / 4);
        _advance(1);
        _collect(keeper, keeper);
        _advance(1);

        uint256[] memory ids = new uint256[](1);
        ids[0] = itemA;
        (uint256 retPrincipal, uint256 retFee) = _returnItems(eoa[3], ids);
        assertGt(retPrincipal, 0);
        assertEq(ghostTOut(TOut.Return), retPrincipal - retFee, "the returner's T, net of the fee");
        assertTrue(vault.isOnShelf(itemA), "a returned item waits on the shelf");
        (uint256 pickPrincipal, uint256 pickFee) = _pickBatch(eoa[4], ids);
        assertEq(collection.ownerOf(itemA), eoa[4]);
        assertEq(ghostTIn(TIn.Pick), pickPrincipal + pickFee, "principal and fee");

        ids[0] = itemP1;
        uint256 paid = _claimStreamFor(keeper, eoa[0], ids);
        assertGt(paid, 0, "placeholder 1's item earned since graduation");
        assertEq(ghostTOut(TOut.StreamClaim), paid, "paid to the account, not the caller");

        _burnT(eoa[1], 1e18);
        assertEq(ghostTIn(TIn.OwnBurn), 1e18);
        _transferT(eoa[1], a.royaltyRouter, 2e18);
        assertEq(ghostTIn(TIn.Direct), 2e18, "T sent to a box address");
        (,, uint256 tIn0, uint256 tOut0) = ghostTotals();
        _transferT(eoa[1], eoa[2], 3e18);
        (,, uint256 tIn1, uint256 tOut1) = ghostTotals();
        assertEq(tIn1, tIn0, "between outside holders: nothing booked in");
        assertEq(tOut1, tOut0, "nor out");

        _addBounty(eoa[2], r0 + 400, 0.01 ether, true);
        _addBounty(eoa[2], r0 + 401, 0.02 ether, false);
        uint256 roundA = _requestRound(eoa[2], 7, 0.003 ether, false);
        uint256 roundB = _requestRound(eoa[2], 7, 0.004 ether, true);
        assertEq(roundA, roundB, "both fix the first round at least 12 s ahead");
        assertEq(ghostEthIn(EthIn.Bounty), 0.037 ether, "four pots");
        assertEq(drand.bountyOf(r0 + 400), 0.01 ether);
        _assertGhostLedger();
    }

    /// Terminal mode's take by number: 3 days after terminal entry a hidden item of the draw pool is taken with its
    /// reveal, its principal and fee booked as T in.
    function test_review_takeByNumberBooked() public {
        _toTerminal();
        _buy(eoa[4], 1 ether);
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        (uint256 item, bool hidden) = _poolItem(0);
        assertTrue(hidden, "pool index 0 is still hidden");
        (uint256 principal, uint256 fee) = _takeByNumber(eoa[4], item, 0, true);
        assertEq(collection.ownerOf(item), eoa[4]);
        assertTrue(collection.isRevealed(item));
        assertEq(ghostTIn(TIn.TakeByNumber), principal + fee);
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Requested), "C still cancellable");
        _assertGhostLedger();
    }
}
