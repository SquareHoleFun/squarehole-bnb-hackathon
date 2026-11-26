// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RewardLedger} from "../src/RewardLedger.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {IFeeCollector} from "../src/interfaces/IFeeCollector.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {TransientReentrancyGuard} from "../src/libraries/TransientReentrancyGuard.sol";
import {Fixture} from "./utils/Fixture.sol";
import {
    MockERC20,
    NoReturnERC20,
    FalseReturnERC20,
    FeeOnTransferERC20,
    DenylistERC20,
    ReentrantERC20
} from "./utils/MockTokens.sol";

contract FeeCollectorTest is Fixture {
    uint256 internal constant Q = 1e18;

    function setUp() public {
        _deploy(IRewardLedger.PayoutAsset.Q, 1e6, 1_000);
        _buy(alice, 25 * UNIT);
        _buy(bob, 75 * UNIT);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_constructor_wiring() public view {
        assertEq(collector.token(), address(token));
        assertEq(collector.quote(), address(quote));
        assertEq(collector.ledger(), address(ledger));
        assertEq(collector.treasury(), treasury);
        assertEq(collector.feeSource(), hook);
        assertEq(collector.poolManager(), poolManager);
    }

    function test_constructor_rejectsBadConfig() public {
        address t = address(token);
        address q = address(quote);
        address l = address(ledger);
        vm.expectRevert(FeeCollector.ZeroAddress.selector);
        new FeeCollector(address(0), q, l, treasury, hook, poolManager);
        vm.expectRevert(FeeCollector.ZeroAddress.selector);
        new FeeCollector(t, q, l, treasury, address(0), poolManager);
        vm.expectRevert(FeeCollector.ZeroAddress.selector);
        new FeeCollector(t, q, l, treasury, hook, address(0));
        vm.expectRevert(FeeCollector.DuplicateAddress.selector);
        new FeeCollector(t, t, l, treasury, hook, poolManager);
        vm.expectRevert(FeeCollector.DuplicateAddress.selector);
        new FeeCollector(t, q, l, treasury, treasury, poolManager);
        vm.expectRevert(FeeCollector.DuplicateAddress.selector);
        new FeeCollector(t, q, l, treasury, l, poolManager);
        vm.expectRevert(FeeCollector.DuplicateAddress.selector);
        new FeeCollector(t, q, l, treasury, poolManager, poolManager);
        // The ledger names a different collector.
        vm.expectRevert(FeeCollector.LedgerMismatch.selector);
        new FeeCollector(t, q, l, treasury, hook, poolManager);
    }

    function test_constructor_requiresSamePoolManagerAsLedger() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        RewardLedger l = new RewardLedger(
            _config(address(0x7001), address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, true)
        );
        vm.expectRevert(FeeCollector.LedgerMismatch.selector);
        new FeeCollector(address(0x7001), address(quote), address(l), treasury, hook, makeAddr("otherPoolManager"));
    }

    function test_constructor_requiresExcludedFeeSource() public {
        uint256 nonce = vm.getNonce(address(this));
        address predictedCollector = vm.computeCreateAddress(address(this), nonce + 1);
        RewardLedger l = new RewardLedger(
            _config(address(0x7001), address(quote), predictedCollector, IRewardLedger.PayoutAsset.Q, launcher, true)
        );
        vm.expectRevert(FeeCollector.FeeSourceNotExcluded.selector);
        new FeeCollector(address(0x7001), address(quote), address(l), treasury, alice, poolManager);
    }

    /*//////////////////////////////////////////////////////////////
                           RECEIPTS AND SPLIT
    //////////////////////////////////////////////////////////////*/

    function test_receiveFees_onlyFeeSource() public {
        _prepareFee(UNIT, 3 * Q);
        address[4] memory callers = [alice, launcher, treasury, poolManager];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(FeeCollector.NotFeeSource.selector);
            collector.receiveFees(UNIT, 3 * Q);
        }
    }

    function test_receiveFees_rejectsEmptyReceipt() public {
        vm.prank(hook);
        vm.expectRevert(FeeCollector.EmptyReceipt.selector);
        collector.receiveFees(0, 0);
    }

    function test_receiveFees_splitsOneToTwoAndEmits() public {
        _prepareFee(30 * UNIT, 3 * Q);
        vm.expectEmit(address(collector));
        emit IFeeCollector.FeesReceived(1, 30 * UNIT, 3 * Q, Q, 2 * Q, 0);
        vm.prank(hook);
        assertEq(collector.receiveFees(30 * UNIT, 3 * Q), 1);
        assertEq(collector.pendingBurnT(), 30 * UNIT);
        assertEq(collector.protocolQPending(), Q);
        assertEq(collector.totalQHolders(), 2 * Q);
        // Custody: fee funds are PoolManager claims, never ERC-20 balances of the collector or ledger.
        assertEq(_claims(address(collector), address(token)), 30 * UNIT, "fee T waits as claims");
        assertEq(_claims(address(collector), address(quote)), Q, "protocol Q waits as claims");
        assertEq(_claims(address(ledger), address(quote)), 2 * Q, "holder Q left the collector at the fee event");
        assertEq(quote.balanceOf(address(collector)) + quote.balanceOf(address(ledger)), 0);
        assertEq(token.balanceOf(address(collector)), 0);
        assertEq(pm.allowance(address(collector), address(ledger), _id(address(quote))), 0, "exact allowance used");
        assertEq(pm.allowance(hook, address(collector), _id(address(token))), 0);
        assertEq(pm.allowance(hook, address(collector), _id(address(quote))), 0);
        assertEq(_claims(hook, address(token)) + _claims(hook, address(quote)), 0, "the fee source keeps nothing");
        assertEq(_feeEvent(0, 3), 2, "receipt ids increase");
    }

    function test_remainderIsCarriedNeverLost() public {
        _feeEvent(0, 1);
        assertEq(collector.qRemainder(), 1);
        assertEq(collector.totalQProtocol() + collector.totalQHolders(), 0);
        _feeEvent(0, 1);
        assertEq(collector.qRemainder(), 2);
        _feeEvent(0, 1);
        assertEq(collector.qRemainder(), 0);
        assertEq(collector.totalQProtocol(), 1);
        assertEq(collector.totalQHolders(), 2);
        _feeEvent(0, 5);
        assertEq(collector.totalQReceived(), 8);
        assertEq(collector.totalQProtocol(), 2);
        assertEq(collector.totalQHolders(), 4);
        assertEq(collector.qRemainder(), 2);
        assertEq(_claims(address(collector), address(quote)), collector.protocolQPending() + collector.qRemainder());
    }

    function testFuzz_splitIdentity(uint64[6] memory amounts) public {
        uint256 sum;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 q = bound(amounts[i], 1, 1e24);
            sum += q;
            _feeEvent(0, q);
            // ECO-03: F_Q = protocol + holders + remainder, with protocol:holders exactly 1:2.
            assertEq(
                collector.totalQReceived(),
                collector.totalQProtocol() + collector.totalQHolders() + collector.qRemainder()
            );
            assertEq(collector.totalQHolders(), 2 * collector.totalQProtocol());
            assertLt(collector.qRemainder(), 3);
        }
        assertEq(collector.totalQProtocol(), sum / 3, "cumulative protocol share is floor(sum / 3)");
        assertEq(collector.qRemainder(), sum % 3);
    }

    function test_tOnlyReceipt() public {
        _feeEvent(30 * UNIT, 0);
        assertEq(collector.pendingBurnT(), 30 * UNIT);
        assertEq(collector.totalQReceived(), 0);
        assertEq(ledger.totalHolderQReceived(), 0, "ECO-10: no fabricated Q");
    }

    /// Exact receipts: the collector pulls claims with the fee source's exact allowance; claims sent to the collector
    /// unsolicited can neither stand in for a receipt nor block it.
    function test_receipt_isAnExactPullNotABalanceRead() public {
        funder.deposit(address(quote), address(0), 9 * Q, address(collector)); // unsolicited claims
        funder.deposit(address(quote), address(0), 3 * Q, hook);
        vm.prank(hook);
        vm.expectRevert(); // no allowance: the donation cannot satisfy the receipt
        collector.receiveFees(0, 3 * Q);
        vm.prank(hook);
        pm.approve(address(collector), _id(address(quote)), 3 * Q);
        vm.prank(hook);
        collector.receiveFees(0, 3 * Q);
        assertEq(collector.totalQReceived(), 3 * Q, "only the pulled amount is a receipt");
        assertEq(collector.sweepUnaccountedClaims(address(quote)), 9 * Q, "the donation is swept, never split");
        assertEq(_claims(treasury, address(quote)), 9 * Q);
        assertEq(_claims(address(collector), address(quote)), collector.protocolQPending() + collector.qRemainder());
    }

    /*//////////////////////////////////////////////////////////////
                        BURN AND PROTOCOL PAYOUT
    //////////////////////////////////////////////////////////////*/

    function test_processFees_burnsOnceAndPaysTreasury() public {
        _feeEvent(30 * UNIT, 3 * Q);
        uint256 supply = token.totalSupply();
        vm.expectEmit(address(collector));
        emit IFeeCollector.FeeTBurned(30 * UNIT, 30 * UNIT);
        vm.expectEmit(address(collector));
        emit IFeeCollector.ProtocolQPaid(treasury, Q);
        vm.prank(alice); // permissionless
        (uint256 burned, uint256 paid) = collector.processFees();
        assertEq(burned, 30 * UNIT);
        assertEq(paid, Q);
        assertEq(token.totalSupply(), supply - 30 * UNIT, "real supply reduction");
        assertEq(quote.balanceOf(treasury), Q, "protocol Q redeemed to the treasury as the ERC-20");
        assertEq(_claims(address(collector), address(token)), 0);
        assertEq(_claims(address(collector), address(quote)), 0);
        (burned, paid) = collector.processFees();
        assertEq(burned + paid, 0, "ECO-01: burned once");
        assertEq(collector.totalTBurned(), collector.totalTReceived());
    }

    /// Redemption runs in the collector's own PoolManager unlock, so it cannot run inside someone else's unlock.
    function test_processFees_insideAnotherUnlockReverts() public {
        _feeEvent(30 * UNIT, 0);
        UnlockCaller caller = new UnlockCaller(IPoolManagerLike(address(pm)));
        vm.expectRevert(); // PoolManager.AlreadyUnlocked, wrapped by the caller
        caller.callInsideUnlock(address(collector), abi.encodeCall(collector.processFees, ()));
        assertEq(collector.pendingBurnT(), 30 * UNIT, "nothing changed");
    }

    function test_burnAndPayAreIndependent() public {
        DenylistERC20 dq = new DenylistERC20();
        quote = MockERC20(address(dq));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e6, 1_000, address(dq));
        _buy(alice, UNIT);
        _feeEvent(5 * UNIT, 3 * Q);
        dq.setDenied(treasury); // e.g. an issuer denylist hits the treasury
        vm.expectRevert(); // the PoolManager's transfer to the treasury fails
        collector.processFees();
        assertEq(collector.burnPendingT(), 5 * UNIT, "the burn is not blocked by the Q leg");
        assertEq(collector.protocolQPending(), Q, "protocol Q stays accounted");
        dq.setDenied(address(0));
        assertEq(collector.payProtocolQ(), Q);
    }

    /// A Q denylist naming the collector or the ledger cannot block fee events: they never hold the ERC-20.
    function test_denylistedCollectorAndLedgerStillReceiveFees() public {
        DenylistERC20 dq = new DenylistERC20();
        quote = MockERC20(address(dq));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e6, 1_000, address(dq));
        _buy(alice, UNIT);
        _prepareFee(0, 3 * Q);
        dq.setDenied(address(collector));
        vm.prank(hook);
        collector.receiveFees(0, 3 * Q);
        dq.setDenied(address(ledger));
        _feeEvent(0, 3 * Q);
        assertEq(ledger.claimable(alice), 4 * Q);
        dq.setDenied(address(0));
        assertEq(_claim(alice), 4 * Q);
    }

    function test_feeOriginTIsTheOnlyBurnedT() public {
        _feeEvent(10 * UNIT, 0);
        // T sent to the collector outside a fee receipt (e.g. converter output, a user) is not fee T (ECO-02).
        vm.prank(alice);
        token.transfer(address(collector), 4 * UNIT);
        collector.processFees();
        assertEq(collector.totalTBurned(), 10 * UNIT);
        assertEq(token.balanceOf(address(collector)), 4 * UNIT);
        assertEq(collector.sweepUnaccounted(address(token)), 4 * UNIT);
        assertEq(token.balanceOf(treasury), 4 * UNIT);
    }

    /*//////////////////////////////////////////////////////////////
                        DONATIONS AND BAD TOKENS
    //////////////////////////////////////////////////////////////*/

    function test_donationsAreNeverFeeEvents() public {
        quote.mint(address(collector), 7 * Q);
        vm.prank(alice);
        token.transfer(address(collector), UNIT);
        funder.deposit(address(token), launcher, 2 * UNIT, address(collector)); // unsolicited T claims
        assertEq(collector.pendingBurnT(), 0);
        assertEq(collector.protocolQPending(), 0);
        assertEq(ledger.rewardIndex(), 0);
        (uint256 burned, uint256 paid) = collector.processFees();
        assertEq(burned + paid, 0, "no path pays from unsolicited balances");
        assertEq(ledger.claimable(bob), 0);
        _feeEvent(0, 1);
        assertEq(collector.sweepUnaccounted(address(quote)), 7 * Q, "ERC-20 Q is always unsolicited");
        assertEq(quote.balanceOf(treasury), 7 * Q);
        assertEq(collector.qRemainder(), 1);
        vm.expectRevert(FeeCollector.NothingToSweep.selector);
        collector.sweepUnaccounted(address(quote));
        vm.expectRevert(FeeCollector.NothingToSweep.selector);
        collector.sweepUnaccountedClaims(address(quote)); // only the carried remainder is held
        assertEq(collector.sweepUnaccountedClaims(address(token)), 2 * UNIT, "donated T claims are never burned");
        assertEq(_claims(treasury, address(token)), 2 * UNIT);
        vm.expectRevert(abi.encodeWithSelector(FeeCollector.NotSweepable.selector, address(0xabc)));
        collector.sweepUnaccounted(address(0xabc));
        vm.expectRevert(abi.encodeWithSelector(FeeCollector.NotSweepable.selector, address(0xabc)));
        collector.sweepUnaccountedClaims(address(0xabc));
    }

    function test_nftDonationToCollector_isSweptNotBurned() public {
        uint256 id = token.ownedIds(alice, 0, 1)[0];
        vm.prank(alice);
        mirror.transferFrom(alice, address(collector), id);
        assertEq(mirror.ownerOf(id), address(collector));
        _feeEvent(2 * UNIT, 0);
        collector.processFees();
        assertEq(mirror.ownerOf(id), address(collector), "fee burns do not destroy a donated NFT");
        assertEq(collector.sweepUnaccounted(address(token)), UNIT);
        assertEq(token.balanceOf(address(collector)), 0);
    }

    function test_noReturnQuoteIsSupported() public {
        NoReturnERC20 nr = new NoReturnERC20();
        quote = MockERC20(address(nr));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e6, 1_000, address(nr));
        _buy(alice, UNIT);
        _feeEvent(0, 3 * Q);
        collector.processFees();
        assertEq(nr.balanceOf(treasury), Q);
        assertEq(_claim(alice), 2 * Q);
        assertEq(nr.balanceOf(alice), 2 * Q);
    }

    /// A Q whose transfer returns false moves nothing out of the PoolManager: the payout reverts (v4's Currency
    /// transfer rejects `false`), and the protocol share stays accounted.
    function test_falseReturnQuoteCannotBePaidOut() public {
        FalseReturnERC20 fr = new FalseReturnERC20();
        quote = MockERC20(address(fr));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e6, 1_000, address(fr));
        _feeEvent(0, 3 * Q); // claims are PoolManager accounting: the receipt itself works
        vm.expectRevert();
        collector.payProtocolQ();
        assertEq(collector.protocolQPending(), Q);
    }

    /// Fee-on-transfer Q is unsupported (G06 admission). The accounting stays exact because receipts are PoolManager
    /// claims; the transfer fee is charged when the PoolManager pays the ERC-20 out, so recipients get less.
    function test_feeOnTransferQuote_claimsStayExactPayoutsNetOfTheTransferFee() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        quote = MockERC20(address(fot));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e6, 1_000, address(fot));
        _buy(alice, UNIT);
        _feeEvent(0, 3000);
        assertEq(collector.totalQReceived(), 3000);
        assertEq(ledger.claimable(alice), 2000);
        assertEq(_claim(alice), 2000, "the entitlement is consumed exactly");
        assertEq(fot.balanceOf(alice), 1980, "the token's own transfer fee is charged on the way out");
    }

    function test_hostileQuoteCannotReenter() public {
        ReentrantERC20 hostile = new ReentrantERC20();
        quote = MockERC20(address(hostile));
        _deployWith(IRewardLedger.PayoutAsset.Q, 1e6, 1_000, address(hostile));
        _buy(alice, UNIT);
        _feeEvent(0, 3 * Q);
        // The only Q transfer the collector triggers is the PoolManager paying the treasury during payProtocolQ.
        hostile.arm(address(collector), abi.encodeCall(FeeCollector.processFees, ()));
        collector.payProtocolQ();
        assertFalse(hostile.lastCallSucceeded());
        assertEq(bytes4(hostile.lastRevertData()), TransientReentrancyGuard.Reentrancy.selector);
        assertEq(hostile.balanceOf(treasury), Q, "paid exactly once");
        assertEq(collector.protocolQPending(), 0);
    }

    /// The unlock callback is accepted only while the collector's own guarded payout runs.
    function test_unlockCallback_onlyDuringOwnPayout() public {
        vm.prank(poolManager);
        vm.expectRevert(FeeCollector.NotPoolManager.selector);
        collector.unlockCallback(abi.encode(address(quote), alice, uint256(1)));
        vm.prank(alice);
        vm.expectRevert(FeeCollector.NotPoolManager.selector);
        collector.unlockCallback(abi.encode(address(quote), alice, uint256(1)));
    }
}

/// @notice Calls `target` from inside its own PoolManager unlock (to prove payouts refuse to nest).
contract UnlockCaller {
    address internal immutable _pm;

    constructor(IPoolManagerLike pm_) {
        _pm = address(pm_);
    }

    function callInsideUnlock(address target, bytes calldata data) external {
        IPoolManagerLike(_pm).unlock(abi.encode(target, data));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (address target, bytes memory data) = abi.decode(raw, (address, bytes));
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return "";
    }
}

interface IPoolManagerLike {
    function unlock(bytes calldata data) external returns (bytes memory);
}
