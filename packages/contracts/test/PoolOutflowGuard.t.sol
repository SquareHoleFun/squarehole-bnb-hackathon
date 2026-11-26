// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RewardLedger} from "../src/RewardLedger.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {Fixture} from "./utils/Fixture.sol";
import {SquareHoleTokenHarness} from "./utils/Harness.sol";
import {SameTransaction} from "./utils/SameTransaction.sol";

/// @notice Same-transaction flash-borrow guard (review finding SH-B1-R1, ECO-12, ECO-09; fail-closed since SH-B2 review
/// round A): T lent out by the excluded pool manager inside one transaction (Uniswap v4 flash accounting: take →
/// swap → settle) must not dilute real holders at a fee event in between, and the event's holder share must not reach
/// whoever holds T at a later release either (the trader included). A fee event carrying holder Q while the counter
/// is non-zero therefore reverts with PoolOutflowAtFeeEvent. Every multi-step scenario runs through
/// `SameTransaction`, because Foundry clears transient storage between top-level test calls.
contract PoolOutflowGuardTest is Fixture {
    uint256 internal constant Q = 1e18;
    uint256 internal RESERVES; // 900 whole NFTs of pool reserves (set in setUp: UNIT depends on the ratio)

    address internal attacker = makeAddr("attacker");
    SameTransaction internal runner;

    SameTransaction.Call[] internal steps;
    uint256 internal stepT;
    uint256 internal stepQ;

    function setUp() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 1e6, 1_000);
        RESERVES = 900 * UNIT;
        runner = new SameTransaction();
        // Launch state: pool reserves sit in the (excluded) pool manager; alice bought 10 T in an earlier transaction.
        vm.prank(launcher);
        token.transfer(poolManager, RESERVES);
        _buy(alice, 10 * UNIT);
    }

    /*//////////////////////////////////////////////////////////////
                           THE REVIEW EXPLOITS
    //////////////////////////////////////////////////////////////*/

    /// SH-B1 review PoC: take 900 T from the pool manager, trigger a fee event, settle the 900 T back. Before the B1
    /// fix the attacker got 1.978 Q of the 2 Q holder share and alice 0.022 Q; B1 deferred the share, which let the
    /// share be recovered at the release (SH-B2 review round A); now the transaction reverts.
    function test_flashBorrowedPoolReserves_revert() public {
        _take(attacker, RESERVES); // PoolManager.take(T, attacker, 900 T)
        _expectOutflow(RESERVES);
        _fee(0, 3 * Q); // a fee-bearing swap in the same unlock: afterSwap → receiveFees
        _settle(attacker, RESERVES); // T.transfer(PoolManager) + settle()
        SameTransaction.Call[] memory calls = _prepared();

        vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, RESERVES));
        runner.run(calls);

        assertEq(token.balanceOf(attacker), 0);
        assertEq(ledger.claimable(attacker), 0, "borrowed pool reserves earn nothing");
        assertEq(ledger.bootstrapQ(), 0, "nothing deferred for a later release");
        assertEq(ledger.claimable(alice), 0);
        assertEq(collector.receiptCount(), 0, "no fee event happened");
        assertEq(ledger.poolNetOutflow(), 0, "the counter is transient");

        _feeEvent(0, 3 * Q); // the next clean fee event, a later transaction
        assertEq(ledger.claimable(alice), 2 * Q, "the real holder gets the clean event's share");
        assertEq(ledger.claimable(attacker), 0);
    }

    /// SH-B2 review round A, finding 1 (regression): a buyer takes 1 wei of T out of the pool manager, then its own
    /// fee-bearing buy runs, then the buy's output is taken. B1 deferred the buy's holder Q and a later clean event
    /// released it to the holders of that moment, the buyer's new T included (a self-rebate of A/(E+A) of its own
    /// holder fee: 89.4% on a 1 WETH buy in the reviewer's PoC). Now the buy reverts; the same buy without the take
    /// is indexed to the existing holders and the buyer earns nothing of it, at the swap or later.
    function test_selfInducedOutflow_oneWeiTake_buyReverts() public {
        _take(attacker, 1); // 1 wei of T out of the pool manager
        _expectOutflow(1);
        _fee(0, 3 * Q); // the buyer's own buy
        _take(attacker, 90 * UNIT); // the buy's output
        SameTransaction.Call[] memory calls = _prepared();
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, 1));
        runner.run(calls);
        assertEq(ledger.bootstrapQ(), 0);

        // The same buy in the ordinary order (swap first, then take): indexed to alice at the swap.
        _fee(0, 3 * Q);
        _take(attacker, 90 * UNIT);
        runner.run(_prepared());
        assertEq(ledger.claimable(alice), 2 * Q, "the existing holder gets the whole holder share");
        assertEq(ledger.claimable(attacker), 0, "a buyer never earns its own buy's fee");
        // The reviewer's release step: a dust buy in the next transaction. Nothing is waiting to be released.
        _feeEvent(0, 3);
        assertLe(ledger.claimable(attacker), 2, "at most its pro-rata share (90/100) of the dust event's 2 wei");
        assertEq(ledger.bootstrapQ(), 0);
    }

    function testFuzz_flashBorrowNeverDilutes(uint256 borrowed, uint256 repaidEarly, uint256 q) public {
        borrowed = bound(borrowed, 1, RESERVES);
        repaidEarly = bound(repaidEarly, 0, borrowed);
        q = bound(q, 1, 1e24);
        _take(attacker, borrowed);
        if (repaidEarly != 0) _settle(attacker, repaidEarly);
        _expectOutflow(borrowed - repaidEarly);
        _fee(0, q);
        if (borrowed != repaidEarly) _settle(attacker, borrowed - repaidEarly);
        SameTransaction.Call[] memory calls = _prepared();
        bool refused = borrowed != repaidEarly && q / 3 != 0; // holder Q during an outflow
        if (refused) {
            vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, borrowed - repaidEarly));
        }
        runner.run(calls);

        _feeEvent(0, 3);
        assertEq(ledger.claimable(attacker), 0, "no entitlement from borrowed T");
        // alice is the only real holder at every completed fee event: she gets all holder Q (≤ 1 wei index dust).
        uint256 holderQ = collector.totalQHolders();
        assertLe(ledger.claimable(alice), holderQ);
        assertApproxEqAbs(ledger.claimable(alice), holderQ, 1);
        assertEq(ledger.bootstrapQ(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                  ORDINARY FLOWS ARE NOT AFFECTED
    //////////////////////////////////////////////////////////////*/

    /// Universal Router order for a buy: swap (fee event) first, then settle Q and take T.
    function test_normalBuyOrder_feeEventIsIndexedImmediately() public {
        _fee(0, 3 * Q);
        _take(bob, 5 * UNIT);
        runner.run(_prepared());
        assertEq(ledger.claimable(alice), 2 * Q, "indexed at the fee event");
        assertEq(ledger.claimable(bob), 0, "a buyer never earns its own buy's fee");
        assertEq(ledger.bootstrapQ(), 0);
    }

    /// A sell: swap (fee event), then the seller settles T into the pool manager. Inflows never block.
    function test_normalSellOrder_feeEventIsIndexedImmediately() public {
        _fee(0, 3 * Q);
        _settle(alice, 4 * UNIT);
        _expectOutflow(0);
        runner.run(_prepared());
        assertEq(ledger.claimable(alice), 2 * Q, "the seller held 10 T at its sell's fee event");
    }

    /// Two buys in one transaction where the first one's take precedes the second one's swap (e.g. two V4_SWAP
    /// commands): the second fee event carries holder Q during an outflow, so the transaction reverts as a whole.
    function test_batchedSecondSwapAfterTake_reverts() public {
        _fee(0, 3 * Q);
        _take(bob, 5 * UNIT);
        _fee(0, 3 * Q);
        SameTransaction.Call[] memory calls = _prepared();
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, 5 * UNIT));
        runner.run(calls);
        assertEq(ledger.claimable(alice), 0);
        assertEq(token.balanceOf(bob), 0);
        assertEq(ledger.bootstrapQ(), 0);

        // The same two buys in two transactions: both indexed, each to the holders at its swap.
        _fee(0, 3 * Q);
        _take(bob, 5 * UNIT);
        runner.run(_prepared());
        _feeEvent(0, 3 * Q); // later transaction: 2 new over alice 10 and bob 5
        assertApproxEqAbs(ledger.claimable(alice), 2 * Q + 4 * Q / 3, 1);
        assertApproxEqAbs(ledger.claimable(bob), 2 * Q / 3, 1);
        assertEq(ledger.bootstrapQ(), 0);
    }

    /// Borrowed and fully settled before the fee event: nothing is inflated, so the event is indexed.
    function test_settledBeforeFeeEvent_isIndexed() public {
        _take(attacker, RESERVES);
        _settle(attacker, RESERVES);
        _expectOutflow(0);
        _fee(0, 3 * Q);
        runner.run(_prepared());
        assertEq(ledger.claimable(alice), 2 * Q);
        assertEq(ledger.claimable(attacker), 0);
        assertEq(ledger.bootstrapQ(), 0);
    }

    function test_partialSettlementStillReverts() public {
        _take(attacker, RESERVES);
        _settle(attacker, 600 * UNIT);
        _expectOutflow(300 * UNIT);
        _fee(0, 3 * Q);
        _settle(attacker, 300 * UNIT);
        SameTransaction.Call[] memory calls = _prepared();
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, 300 * UNIT));
        runner.run(calls);
        assertEq(ledger.bootstrapQ(), 0);
        assertEq(ledger.claimable(attacker), 0);
    }

    /// An inflow before the outflow builds no credit: the counter never goes below zero, so the fee event is refused.
    function test_inflowBeforeOutflow_buildsNoCredit() public {
        _buy(bob, 5 * UNIT);
        _settle(alice, 10 * UNIT); // alice sells into the pool first
        _expectOutflow(0);
        _take(attacker, 10 * UNIT);
        _expectOutflow(10 * UNIT);
        _fee(0, 3 * Q);
        _settle(attacker, 10 * UNIT);
        SameTransaction.Call[] memory calls = _prepared();
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, 10 * UNIT));
        runner.run(calls);
        assertEq(ledger.bootstrapQ(), 0);
        _feeEvent(0, 3 * Q); // alice (10) and bob (5) hold: the whole run above was undone
        assertApproxEqAbs(ledger.claimable(bob), 2 * Q / 3, 1);
        assertApproxEqAbs(ledger.claimable(alice), 4 * Q / 3, 1);
        assertEq(ledger.claimable(attacker), 0);
    }

    /// T that stays with the buyer across a transaction boundary is ordinary ownership and earns.
    function test_counterIsClearedBetweenTransactions() public {
        vm.prank(poolManager);
        token.transfer(attacker, 90 * UNIT); // a buy in its own transaction
        assertEq(ledger.poolNetOutflow(), 0);
        _feeEvent(0, 3 * Q);
        assertEq(ledger.claimable(alice), 2 * Q / 10);
        assertEq(ledger.claimable(attacker), 18 * Q / 10);
        assertEq(ledger.bootstrapQ(), 0);
    }

    /// A T-only fee event after an outflow does not release deferred Q to the inflated supply.
    function test_tOnlyFeeEventAfterOutflow_keepsDeferredQWaiting() public {
        vm.prank(alice);
        token.transfer(launcher, 10 * UNIT); // eligible supply 0
        _feeEvent(0, 3 * Q); // 2 Q bootstrap
        _buy(alice, 10 * UNIT);

        _take(attacker, RESERVES);
        _fee(UNIT, 0);
        _settle(attacker, RESERVES);
        runner.run(_prepared());
        assertEq(ledger.bootstrapQ(), 2 * Q, "still waiting");
        assertEq(ledger.claimable(attacker), 0);

        _feeEvent(UNIT, 0); // clean T-only event releases it
        assertEq(ledger.bootstrapQ(), 0);
        assertEq(ledger.claimable(alice), 2 * Q);
    }

    /// Pool-manager flows to other excluded roles (e.g. the hook taking fee T) do not count.
    function test_poolToExcludedRole_doesNotCount() public {
        _call(poolManager, address(token), abi.encodeCall(token.transfer, (hook, UNIT)));
        _call(poolManager, address(token), abi.encodeCall(token.transfer, (treasury, UNIT)));
        _expectOutflow(0);
        _fee(0, 3 * Q);
        runner.run(_prepared());
        assertEq(ledger.claimable(alice), 2 * Q);
    }

    /// Mints and burns of eligible balances are never mistaken for pool flows: `from` of a mint and `to` of a burn
    /// are the zero address, and the pool-manager role is always a real address (required since B2).
    function test_mintIsNotAnOutflow() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 2);
        RewardLedger l = new RewardLedger(
            _config(predictedToken, address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, true)
        );
        FeeCollector c = new FeeCollector(predictedToken, address(quote), address(l), treasury, hook, poolManager);
        SquareHoleTokenHarness h = new SquareHoleTokenHarness(_terms(1e6, 1_000, address(c), address(l)));

        funder.deposit(address(quote), address(0), 3 * Q, hook);
        vm.prank(hook);
        pm.approve(address(c), _id(address(quote)), 3 * Q);
        _call(address(0), address(h), abi.encodeCall(h.exposedMint, (alice, 5 * UNIT)));
        _call(
            address(0),
            address(runner),
            abi.encodeCall(
                runner.expectUint, (address(l), abi.encodeCall(l.poolNetOutflow, ()), 0, "mint is not an outflow")
            )
        );
        _call(hook, address(c), abi.encodeCall(c.receiveFees, (0, 3 * Q)));
        runner.run(steps);
        delete steps;
        assertEq(l.claimable(alice), 2 * Q, "indexed, not deferred");
        assertEq(l.bootstrapQ(), 0);
    }

    /*//////////////////////////////////////////////////////////////
               BOOTSTRAP CAPTURE EXPOSURE (G05, DOCUMENTED)
    //////////////////////////////////////////////////////////////*/

    /// With zero eligible supply, buying 1 wei and swapping in the SAME transaction cannot release the bucket: the
    /// buy's take makes the next fee event refuse (the whole transaction reverts).
    function test_bootstrap_sameTransactionBuyAndSwapCannotCapture() public {
        vm.prank(alice);
        token.transfer(poolManager, 10 * UNIT); // eligible supply 0
        _feeEvent(0, 300 * Q);
        assertEq(ledger.bootstrapQ(), 200 * Q);
        _fee(0, 3); // the buy's own swap: clean, but nobody eligible yet
        _take(attacker, 1); // the buy's take: 1 wei
        _fee(0, 3); // a second swap in the same transaction
        SameTransaction.Call[] memory calls = _prepared();
        vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, 1));
        runner.run(calls);
        assertEq(ledger.claimable(attacker), 0);
        assertEq(ledger.bootstrapQ(), 200 * Q, "still waiting");
    }

    /// ADR-0010 "Capture exposure (G05)": a 1-wei holder that bought in an EARLIER transaction takes the whole
    /// bucket at the next clean fee event. This is spec 05's deferred rule (an approval item), recorded here so a
    /// change of the rule is a visible test change.
    function test_bootstrap_oneWeiHolderFromEarlierTransactionCapturesBucket() public {
        vm.prank(alice);
        token.transfer(poolManager, 10 * UNIT);
        _feeEvent(0, 300 * Q);
        vm.prank(poolManager);
        token.transfer(attacker, 1); // a buy in its own transaction
        _feeEvent(0, 3); // any later swap
        assertEq(ledger.claimable(attacker), 200 * Q + 2, "the documented G05 exposure");
        assertEq(ledger.bootstrapQ(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// PoolManager.take: T from the pool manager to `to`.
    function _take(address to, uint256 amount) internal {
        _call(poolManager, address(token), abi.encodeCall(token.transfer, (to, amount)));
    }

    /// settle: `from` pays T into the pool manager.
    function _settle(address from, uint256 amount) internal {
        _call(from, address(token), abi.encodeCall(token.transfer, (poolManager, amount)));
    }

    /// A fee-bearing swap's afterSwap: the fee source delivers `t` native T and `q` Q.
    function _fee(uint256 t, uint256 q) internal {
        stepT += t;
        stepQ += q;
        _call(hook, address(collector), abi.encodeCall(collector.receiveFees, (t, q)));
    }

    function _expectOutflow(uint256 expected) internal {
        _call(
            address(0),
            address(runner),
            abi.encodeCall(
                runner.expectUint,
                (address(ledger), abi.encodeCall(ledger.poolNetOutflow, ()), expected, "pool net outflow")
            )
        );
    }

    function _call(address from, address target, bytes memory data) internal {
        steps.push(SameTransaction.Call({from: from, target: target, data: data}));
    }

    /// Funds the fee source for every fee step (exact total allowances) and returns the steps.
    function _prepared() internal returns (SameTransaction.Call[] memory calls) {
        if (stepT != 0 || stepQ != 0) _prepareFee(stepT, stepQ);
        calls = steps;
        delete steps;
        stepT = 0;
        stepQ = 0;
    }
}
