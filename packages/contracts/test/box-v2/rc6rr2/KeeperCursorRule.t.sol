// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M261Harness} from "../property/m2/MenuHarness.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// Second release review, RC6RR2-MONEY-1 and RC6RR2-HP-1, against the merged receiver and hook: our keeper's collect rule
/// (packages/keeper/src/plan.ts and chain.ts) emulated here with the same reads it makes. It sends a collect when the
/// simulated window reaches its batching floor, or the unchanged lag thresholds count two or more closed buyer
/// sources past `_lastHolderBatch` (storage slot 20), or three
/// closed seller sources in a row past `_lastSellerBatch` (slot 41). After such a lag collect, and after any press, the
/// next collect is tried on the next block. The reviewers' probes (ZeroHeadCollect, AllocationBacklog) showed the
/// window-only rule freezing; these tests require the emulated rule to book the waiting fees. RC7's sub-unit passes
/// can reach further than these conservative thresholds assume.
interface CursorView { function allocationCursors() external view returns (uint256, uint256, uint256, uint256); }
contract KeeperCursorRuleTest is M261Harness {
    using StateLibrary for IPoolManager;
    uint256 internal collectRaw;
    uint256 internal sent;
    uint256 internal lagSends;

    /// What chain.ts reads: the rc7 cursor view, then closed sellers up to three in a row. Slots remain witnesses.
    function _lag() internal view returns (uint256 buyerLag, uint256 sellerRun) {
        (uint256 lastBuyer, uint256 lastSeller, uint256 current, uint256 openSeller) = CursorView(address(receiver)).allocationCursors();
        assertEq(lastBuyer, uint256(vm.load(address(receiver), bytes32(uint256(20)))));
        assertEq(lastSeller, uint256(vm.load(address(receiver), bytes32(uint256(41)))));
        assertEq(current, hook.currentTradeBatch(true)); assertEq(openSeller, hook.currentTradeBatch(false));
        assertEq(openSeller, current + 1);
        if (lastBuyer != 0) assertTrue(receiver.holderBatchClosed(lastBuyer), "slot 20 is the last allocated buyer source");
        if (lastSeller != 0) assertTrue(receiver.holderBatchClosed(lastSeller), "slot 41 is the last allocated seller source");
        uint256 nextBuyer = lastBuyer == 0 ? 1 : lastBuyer + 2;
        buyerLag = (current - nextBuyer) / 2;
        for (uint256 id = lastSeller + 2; sellerRun < 3 && id < current + 1; id += 2) {
            if (!hook.tradeBatch(id).closed) break;
            ++sellerRun;
        }
    }

    function _window() internal returns (uint256 amount) {
        uint256 snap = vm.snapshotState();
        FeeBatchV2 memory r = receiver.collect(address(0));
        amount = r.buyersP + r.sellersP + r.qToReserve + r.tip;
        vm.revertToState(snap);
    }

    /// One keeper turn for collect; true when it sent one because of the cursors (so the next block tries again).
    function _keeperCollect() internal returns (bool lag) {
        (uint256 buyerLag, uint256 sellerRun) = _lag();
        lag = buyerLag >= 2 || sellerRun >= 3;
        uint256 amount = _window();
        if ((amount == 0 || amount < collectRaw) && !lag) return false;
        receiver.collect(address(0)); ++sent;
        if (amount < collectRaw) ++lagSends;
    }

    function _press() internal returns (ProtocolSkip skip) {
        vm.roll(block.number + 1);
        vm.prank(address(hook)); (skip,,,) = hook.sellFees();
    }

    function _firstUnallocated(bool sellers) internal view returns (uint256 id) {
        uint256 end = hook.currentTradeBatch(true) + 1;
        for (id = sellers ? 2 : 1; id < end; id += 2) if (!receiver.holderBatchClosed(id)) return id;
        return 0;
    }

    /// ZeroHeadCollect's money lens scenario: a conversion run between keeper collects, then thirty hours of buys while
    /// the seller tail cannot convert, with our keeper's collect turn every hour and on the next block after a lag collect.
    function _scenario(uint256 pressesPerCollect, uint256 tinyBuy, uint256 hourlyBuyDivisor) internal {
        _open(3, 18, 4, 1); _fillTracked(); box.graduate(); receiver.collect(address(0)); _registerBuyer();
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / 2);
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        uint256 presses;
        for (uint256 i; i < 600; ++i) {
            if (tinyBuy != 0) _trade(true, tinyBuy, true);
            if (_press() == ProtocolSkip.BelowMinimum) break;
            ++presses;
            if (presses % pressesPerCollect == 0) { vm.roll(block.number + 1); while (_keeperCollect()) vm.roll(block.number + 1); }
        }
        for (uint256 i; i < 400; ++i) { vm.roll(block.number + 25); if (!_keeperCollect()) break; }
        uint256 fit = receiver.fitOwed();
        uint256 firstBuyerSource = hook.currentTradeBatch(true);
        if (tinyBuy != 0) { HostileToken(box.q()).mint(address(buyer), box.raise() * 40); totalP = _allP(); }
        uint256 bookedHour;
        for (uint256 h; h < 30; ++h) {
            vm.warp(block.timestamp + 1 hours); vm.roll(block.number + 300);
            _trade(true, box.raise() / hourlyBuyDivisor, true);
            if (tinyBuy == 0) assertEq(uint8(_press()), uint8(ProtocolSkip.BelowMinimum), "seller tail stays below the step minimum");
            else for (uint256 k; k < 20 && _press() == ProtocolSkip.None; ++k) {}
            while (_keeperCollect()) vm.roll(block.number + 1);
            if (bookedHour == 0 && receiver.fitOwed() > fit) bookedHour = h + 1;
        }
        emit log_named_uint("keeper collects sent", sent);
        emit log_named_uint("of them below the floor, for the cursors", lagSends);
        emit log_named_uint("first hour FIT grew", bookedHour);
        emit log_named_uint("FIT owed delta", receiver.fitOwed() - fit);
        assertGt(receiver.fitOwed(), fit, "buyers' fees reach FIT within the thirty hours");
        assertTrue(receiver.holderBatchClosed(firstBuyerSource), "the first buyer source of the buy period is allocated");
        (uint256 buyerLag,) = _lag();
        assertLt(buyerLag, 2, "no closed buyer source waits where a collect cannot reach it");
    }

    function test_emptyBuyerSourcesNoLongerFreezeTheWindow() public { collectRaw = 1; _scenario(12, 0, 1000); }
    function test_smallSourcesDrainAtTheDefaultMinimum() public { collectRaw = 1e16; _scenario(12, 1e15, 1); }

    /// AllocationBacklog's busy pool: about two step minimums of sale fees a block, a matching buy and a press. The keeper
    /// rule collects on the next block after each press, so the closed buyer lag stays at most two while presses go on
    /// (the window-only rule left 96 after 100 blocks, AllocationBacklog); once they stop, lag collects on consecutive
    /// blocks drain it, and a
    /// new buy's source is then booked by the next collect.
    function test_collectsKeepPaceWithAPressEveryBlock() public {
        collectRaw = 1e16;
        _open(3, 18, 4, 1); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / 2);
        receiver.collect(address(0));
        uint256 minimum = factory.boxQParameters(1, box.raise()).swapStepMinQ;
        uint256 presses; uint256 worst;
        for (uint256 b = 1; b <= 50; ++b) {
            vm.roll(block.number + 1); vm.warp(block.timestamp + 12);
            (uint160 spot,,,) = pm.getSlot0(hook.poolId());
            _trade(false, 100 * FullMath.mulDiv(FullMath.mulDiv(2 * minimum, spot, 1 << 96), spot, 1 << 96), true);
            _trade(true, 200 * minimum, true);
            // The keeper's collect comes first in a tick (priority 3), then the press (4).
            _keeperCollect();
            (ProtocolSkip skip,,,) = hook.sellFees();
            if (skip == ProtocolSkip.None) ++presses;
            (uint256 buyerLag,) = _lag();
            if (buyerLag > worst) worst = buyerLag;
        }
        emit log_named_uint("presses in 50 blocks", presses);
        emit log_named_uint("keeper collects", sent);
        emit log_named_uint("largest closed buyer lag after a block", worst);
        assertGe(presses, 45);
        assertLe(worst, 2, "presses never pile closed buyer sources out of a collect's reach");
        uint256 drained;
        vm.roll(block.number + 1);
        while (_keeperCollect()) { vm.roll(block.number + 1); ++drained; }
        emit log_named_uint("lag collects after the presses stop", drained);
        assertLe(drained, 2);
        uint256 id = hook.currentTradeBatch(true);
        _trade(true, box.raise() / 10000, true);
        vm.roll(block.number + 1);
        receiver.collect(address(0));
        assertTrue(receiver.holderBatchClosed(id), "a new buy's source is allocated by the next collect");
    }

    /// AllocationBacklog's seller side: 48 dust sources convert in two presses; the seller-run rule then collects on
    /// consecutive blocks until fewer than three converted sources wait. RC7 advances seven sub-unit sources per full
    /// window; the real source behind them is still converting.
    function test_aConvertedDustHeadIsWalkedOnConsecutiveBlocks() public {
        collectRaw = 1e16;
        _open(3, 18, 4, 4); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        uint256 firstDust = hook.currentTradeBatch(false);
        for (uint256 i; i < 48; ++i) { _trade(false, 1000, true); receiver.collect(address(0)); }
        _trade(true, box.raise() / 20, true);
        uint256 real = hook.currentTradeBatch(false);
        _trade(false, token.balanceOf(address(buyer)) / 3, true);
        receiver.collect(address(0));
        uint256 lastDust = firstDust + 2 * 47;
        for (uint256 i; i < 50 && hook.tradeBatchPendingT(lastDust) != 0; ++i) { vm.roll(block.number + 1); hook.sellFees(); }
        assertEq(hook.tradeBatchPendingT(lastDust), 0, "the 48 dust sources converted");
        uint256 start = block.number;
        vm.roll(block.number + 1);
        while (true) {
            uint256 beforeSeller = uint256(vm.load(address(receiver), bytes32(uint256(41))));
            bool again = _keeperCollect();
            uint256 afterSeller = uint256(vm.load(address(receiver), bytes32(uint256(41))));
            if (beforeSeller + 14 <= lastDust) assertEq(afterSeller - beforeSeller, 14, "seven dust sellers per collect");
            if (!again) break;
            vm.roll(block.number + 1);
        }
        emit log_named_uint("blocks until the dust run is walked", block.number - start);
        emit log_named_uint("collects for the cursors", lagSends);
        (, uint256 sellerRun) = _lag();
        assertLt(sellerRun, 3);
        assertTrue(receiver.holderBatchClosed(lastDust - 4), "all but the last two converted dust sources allocated");
        assertLe(block.number - start, 30, "on consecutive blocks, not 25 blocks apart");
        // The real source still converts; once it has, it and the last two dust sources make a run of three again.
        assertGt(hook.tradeBatchPendingT(real), 0);
        assertGt(real, lastDust);
    }

    function test_RC7_emptyBuyerHeadWalksSevenAndTinyValuedBuysStillUseQuota() public {
        _open(3, 18, 4, 1); _fillTracked(); box.graduate(); _collect(0); _registerBuyer();
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / 2);
        // Real dust sale sources make enough press pages to build a full empty buyer head without buys between presses.
        for (uint256 i; i < 192; ++i) { _trade(false, 1000, true); receiver.collect(address(0)); }
        _trade(false, token.balanceOf(address(buyer)) / 3, true); receiver.collect(address(0));
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 12; ++i) if (_press() == ProtocolSkip.BelowMinimum) break;
        (uint256 beforeBuyer,,,) = CursorView(address(receiver)).allocationCursors();
        receiver.collect(address(0));
        (uint256 afterBuyer,,,) = CursorView(address(receiver)).allocationCursors();
        assertEq(afterBuyer - beforeBuyer, 14, "seven empty buyer sources per collect");
        assertTrue(vm.revertToState(snap));
        for (uint256 i; i < 12; ++i) { _trade(true, 1e15, true); _press(); }
        (beforeBuyer,,,) = CursorView(address(receiver)).allocationCursors();
        assertGe(hook.tradeBatch(beforeBuyer + 2).netP, 15);
        receiver.collect(address(0));
        (afterBuyer,,,) = CursorView(address(receiver)).allocationCursors();
        assertEq(afterBuyer - beforeBuyer, 4, "tiny but valued buyer sources use both quota places");
    }

    function test_RC7_unsourcedBoxHasZeroOpenIdsAndCursors() public {
        _open(3, 18, 3, 3);
        (uint256 lastBuyer, uint256 lastSeller, uint256 openBuyer, uint256 openSeller) = CursorView(address(receiver)).allocationCursors();
        assertEq(lastBuyer, 0); assertEq(lastSeller, 0); assertEq(openBuyer, 0); assertEq(openSeller, 0);
        receiver.collect(address(0));
        (lastBuyer, lastSeller, openBuyer, openSeller) = CursorView(address(receiver)).allocationCursors();
        assertEq(lastBuyer, 0); assertEq(lastSeller, 0); assertEq(openBuyer, 0); assertEq(openSeller, 0);
    }

    /// RC6RR2-HP-3: where chain.ts stepMinQ() reads the hook's STEP_MIN_Q: the EIP-1167 clone prefix, the implementation,
    /// the suffix, then the immutable arguments from byte 45; STEP_MIN_Q at argument offset 195, 16 bytes.
    function test_hookCloneCarriesStepMinQWhereTheKeeperReadsIt() public {
        _open(3, 18, 4, 1); _fillTracked(); box.graduate();
        bytes memory code = address(hook).code;
        assertGe(code.length, 45 + 211, "the clone carries the hook's arguments");
        bytes10 prefix; bytes15 suffix; uint256 stepMinQ;
        assembly ("memory-safe") {
            prefix := mload(add(code, 32))
            suffix := mload(add(code, 62))
            stepMinQ := shr(128, mload(add(code, add(32, 240))))
        }
        assertEq(prefix, bytes10(hex"363d3d373d3d3d363d73"), "an EIP-1167 clone");
        assertEq(suffix, bytes15(hex"5af43d82803e903d91602b57fd5bf3"));
        assertEq(stepMinQ, factory.boxQParameters(1, box.raise()).swapStepMinQ, "STEP_MIN_Q at clone byte 240");
        assertGt(stepMinQ, 0);
    }
}
