// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M261Harness} from "./MenuHarness.sol";
import {FeeBatchV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {TradeBatchV2, ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {HostileToken} from "../../kit/HostileToken.sol";

contract M261EdgesTest is M261Harness {
    function testFuzz_menuLifeAndOwnership(uint8 kind, uint8 decimals, uint8 buys, uint8 sells, uint8 outcome, uint8 divisor)
        public
    {
        uint8[3] memory kinds = [uint8(1), 3, 4];
        uint8[4] memory scales = [uint8(0), 6, 8, 18];
        _life(kinds[kind % 3], scales[decimals % 4], buys % 4 + 1, sells % 4 + 1, outcome % 3, 2 + divisor % 7);
    }

    function test_revertingNoticesAndOutAndBackTransfersRecoverFromHistory() public { _miss(hex"60006000fd"); }
    function test_gasSinkNoticesAndOutAndBackTransfersRecoverFromHistory() public { _miss(hex"5b600056"); }

    function _miss(bytes memory faultCode) private {
        _open(3, 8, 4, 4);
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / 3);
        _trade(true, box.raise() / 10, true);
        bytes memory realCode = address(ledger).code;
        // Unconditional local double: revert or spend the entire named optional-call stipend.
        vm.etch(address(ledger), faultCode);
        uint256 amount = token.balanceOf(ALICE) / 2;
        _move(ALICE, BOB, amount);
        vm.etch(address(ledger), realCode);
        _trade(true, box.raise() / 20, true); // Successful notice sees the move despite its missed token hint.
        vm.etch(address(ledger), faultCode);
        _trade(false, token.balanceOf(address(buyer)) / 4, false);
        _move(BOB, ALICE, amount);
        vm.etch(address(ledger), realCode);
        _trade(true, box.raise() / 20, true);
        _collect(0);
        assertEq(ledger.claimable(2, CREATOR), 0, "skipped seller notice cannot enrich another holder");
        (,,, uint256 residue) = ledger.batchState(2);
        assertEq(residue, receiver.holderBatchPaid(2)); assertEq(residue, 0, "curve seller fees burn");
        _payouts();
    }

    function test_collectTipAndRefusedTipRetainTheirOriginalSource() public {
        uint256 initial = vm.snapshotState();
        for (uint8 d; d < 3; ++d) for (uint8 refusal; refusal < 2; ++refusal) {
            assertTrue(vm.revertToState(initial));
            _open(3, d == 0 ? 6 : d == 1 ? 8 : 18, 4, 4);
            _trade(true, box.raise() / 3, true);
            _trade(false, token.balanceOf(address(buyer)) / 4, true);
            HostileToken p = HostileToken(box.q());
            if (refusal == 1) p.setBlocked(address(this), true);
            uint256 before = _balance(address(this));
            FeeBatchV2 memory batch = receiver.collect(address(this));
            uint256 net = hook.tradeBatch(1).netP;
            uint256 expected = net / 20;
            (, uint32 listing) = listings.newestListingOf(box.q());
            uint256 cap = factory.boxQParameters(listing, box.raise()).tipMaxQ;
            if (expected > cap) expected = cap;
            if (refusal == 1) expected = 0;
            assertEq(batch.tip, expected); assertEq(_balance(address(this)) - before, expected);
            if (refusal == 0) assertGt(expected, 0);
            paidTip[1] = expected;
            _fundAndSettle();
            p.setBlocked(address(this), false);
            _payouts();
        }
    }

    function test_nonTradeRoyaltiesDustAndProtocolTradesNeverCreditHolders() public {
        _open(3, 6, 4, 4);
        _trade(true, box.raise() / 10, true); _collect(0);
        uint256 funding = receiver.holderBatchPaid(1);
        _royalty(47); assertEq(receiver.royaltyHeldP(), 47);
        // Each closed 14-unit donation is terminal dust, not a loan to the next batch.
        uint256 depth = hook.depthBudget();
        _collect(14); _collect(14);
        assertEq(hook.depthBudget(), depth + 28);
        assertEq(receiver.holderBatchPaid(1), funding);
        _fillTracked(); box.graduate(); _collect(0);
        uint256 first = nextBatch;
        uint256 ledgerP = pm.balanceOf(address(ledger), uint160(box.q()));
        uint256 fit = receiver.fitOwed(); uint256 platform = receiver.platformOwed();
        depth = hook.depthBudget(); _royalty(151);
        assertEq(receiver.fitOwed() - fit, 20); assertEq(receiver.platformOwed() - platform, 10);
        assertEq(hook.depthBudget() - depth, 121);
        assertEq(pm.balanceOf(address(ledger), uint160(box.q())), ledgerP);
        _collect(0); assertEq(receiver.holderBatchPaid(first), 0); _payouts();
        _assertState();
    }

    function test_buybackPaysProtocolFeesButCannotEarnHolderCredit() public {
        _open(3, 8, 4, 2);
        _trade(true, box.raise() / 3, true);
        _trade(false, token.balanceOf(address(buyer)), true); _collect(0);
        _fillTracked(); box.graduate(); _collect(0); _payouts();
        _trade(false, token.balanceOf(address(buyer)) / 4, true); _sellFeeP(); _collect(0);
        uint256 id = hook.currentTradeBatch(true);
        uint256 before = receiver.buyBackP();
        uint256 supply = token.totalSupply();
        vm.roll(block.number + 1);
        (ProtocolSkip skip, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        assertEq(uint256(skip), uint256(ProtocolSkip.None)); assertGt(spent, 0);
        assertEq(before - receiver.buyBackP(), spent);
        assertEq(supply - token.totalSupply() + receiver.tBurnPending(), bought);
        TradeBatchV2 memory r = hook.tradeBatch(id);
        assertEq(r.tradeUnits, 0); assertGt(r.protocolUnits, 0);
        model.trade(id, r.protocolUnits, true, false);
        _collect(0);
        assertEq(ledger.claimable(id, CREATOR), 0);
        (,,, uint256 residue) = ledger.batchState(id);
        assertEq(residue, receiver.holderBatchPaid(id)); _payouts();
    }

    function test_pausedClaimRollsBackAndTheRemovedPushCannotSpendCredit() public {
        _open(3, 6, 4, 4);
        _trade(true, box.raise() / 10, true); _collect(0);
        uint256 credit = ledger.claimable(1, CREATOR); assertGt(credit, 0);
        uint256 backing = pm.balanceOf(address(ledger), uint160(box.q()));
        (bool ok,) = address(ledger).call(abi.encodeWithSignature("claimFor(uint256,address)", 1, CREATOR));
        assertFalse(ok); assertEq(ledger.claimable(1, CREATOR), credit);
        HostileToken p = HostileToken(box.q()); p.setPaused(true);
        vm.expectRevert(); vm.prank(CREATOR); ledger.claim(1, CREATOR);
        assertEq(ledger.claimable(1, CREATOR), credit);
        assertEq(pm.balanceOf(address(ledger), uint160(box.q())), backing);
        p.setPaused(false); _payouts();
    }
}
