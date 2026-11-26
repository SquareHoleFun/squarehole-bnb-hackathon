// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SquareHoleToken} from "../../src/SquareHoleToken.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {ClaimsFunder} from "../utils/ClaimsFunder.sol";
import {ITestT} from "../utils/Fixture.sol";
import {MockERC20} from "../utils/MockTokens.sol";
import {SameTransaction} from "../utils/SameTransaction.sol";

/// @notice Drives random transfers (fractional, whole units, threshold crossings, whole NFTs via the mirror for the
/// collection template, allowance and operator paths), skip-NFT toggles, fee events, same-transaction flash borrows
/// of pool reserves, burns, claims, donations (ERC-20 and ERC-6909 claims) and sweeps, against either launch template.
/// Keeps an independent ghost of every account's entitlement: at each fee event the holder Q is split pro rata
/// over the actors' balances directly (no index), in wei × 1e18.
/// Transient storage in Foundry: it is cleared after every call made at depth 1, i.e. between invariant calls,
/// between top-level test calls, and ALSO between the handler's own calls when the handler is the transaction
/// frame (fuzzed campaign). So ordinary handler steps never see a pool outflow from an earlier step, and
/// `flashFeeEvent` runs its whole take → fee → settle sequence inside one `SameTransaction` call (depth 2), where
/// the ledger's counter lives exactly as it would within one real transaction.
contract Handler is Test {
    uint256 internal constant GHOST_SCALE = 1e18;
    uint256 internal constant MAX_MOVE_UNITS = 40; // keeps NFT materialization per call bounded
    uint256 internal constant MAX_FEE_Q = 1e22;
    uint256 internal constant POOL_RESERVE_UNITS = 300;

    ITestT public immutable token;
    bool public immutable isCollection;
    DN404Mirror public immutable mirror; // zero for the fungible template
    uint256 public immutable unit; // raw units per NFT (collection) or per whole token (fungible)
    RewardLedger public immutable ledger;
    FeeCollector public immutable collector;
    MockERC20 public immutable quote;
    IPoolManager public immutable pm;
    ClaimsFunder public immutable funder;
    address public immutable launcher;
    address public immutable hook;
    address public immutable poolManager;
    address public immutable converter;
    bool public immutable payoutIsT;

    /// @dev Eligible actors: 4 plain EOAs, 2 EIP-7702 EOAs, 1 contract (skipNFT), 1 EOA that opted out.
    address[] public actors;
    /// @dev Everyone a transfer can come from or go to: actors, the market (launcher) and the pool manager.
    address[] public participants;
    /// @dev Executes flash sequences inside one call so they share transient storage.
    SameTransaction internal immutable runner;

    mapping(address => uint256) public ghostEntitledScaled; // wei × GHOST_SCALE
    mapping(address => uint256) public ghostClaimed;
    uint256 public ghostBootstrap;
    uint256 public ghostFeeEvents;
    uint256 public ghostMaxEntitlementError;
    /// @dev T and Q actually delivered by the fee source, counted here (external truth for F_T and F_Q).
    uint256 public ghostTIn;
    uint256 public ghostQIn;

    /// @dev Effectiveness counters (per run), logged by the invariant contract's afterInvariant hook.
    uint256 public countNftMoves;
    uint256 public countCrossings;
    uint256 public countAllocations;
    uint256 public countDeferrals; // zero eligible supply
    uint256 public countFlashReverts; // fee event with holder Q during a same-transaction pool outflow (fail-closed)
    uint256 public countReleases;
    uint256 public countBurns;
    uint256 public countClaimsPaid;
    uint256 public countSweeps;
    uint256 public countFlashOps;
    uint256 public countDustFees; // fee events with 0 < q < 12
    uint256 public countExits;

    struct Wiring {
        ITestT token;
        DN404Mirror mirror;
        uint256 unit;
        RewardLedger ledger;
        FeeCollector collector;
        MockERC20 quote;
        ClaimsFunder funder;
        address launcher;
        address hook;
        address converter;
    }

    constructor(Wiring memory w) {
        token = w.token;
        mirror = w.mirror;
        isCollection = address(w.mirror) != address(0);
        unit = w.unit;
        ledger = w.ledger;
        collector = w.collector;
        quote = w.quote;
        funder = w.funder;
        pm = w.funder.pm();
        launcher = w.launcher;
        hook = w.hook;
        poolManager = address(pm);
        converter = w.converter;
        payoutIsT = w.ledger.payoutAsset() == IRewardLedger.PayoutAsset.T;
        runner = new SameTransaction();

        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string.concat("eoa", vm.toString(i))));
        }
        address d1 = makeAddr("eip7702-a");
        address d2 = makeAddr("eip7702-b");
        vm.etch(d1, abi.encodePacked(hex"ef0100", address(0x7702)));
        vm.etch(d2, abi.encodePacked(hex"ef0100", address(w.ledger)));
        actors.push(d1);
        actors.push(d2);
        address c = makeAddr("contract-holder");
        vm.etch(c, hex"00");
        actors.push(c);
        address optedOut = makeAddr("opted-out");
        if (isCollection) {
            vm.prank(optedOut);
            SquareHoleToken(payable(address(w.token))).setSkipNFT(true);
        }
        actors.push(optedOut);

        for (uint256 i; i < actors.length; ++i) {
            participants.push(actors[i]);
        }
        participants.push(w.launcher);
        participants.push(poolManager);

        // Start with eligible holders (whole and fractional balances) and pool reserves to borrow, so campaigns
        // do not begin in the zero-eligible bootstrap state.
        uint256 u = w.unit;
        uint256[8] memory seed = [uint256(3 * u + u / 3), 1, u, 7 * u + 12_345, u / 2, 2 * u, 5 * u, 11 * u / 10];
        vm.startPrank(w.launcher);
        for (uint256 i; i < actors.length; ++i) {
            w.token.transfer(actors[i], seed[i]);
        }
        w.token.transfer(poolManager, POOL_RESERVE_UNITS * u);
        vm.stopPrank();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function participantCount() external view returns (uint256) {
        return participants.length;
    }

    /*//////////////////////////////////////////////////////////////
                               TRANSFERS
    //////////////////////////////////////////////////////////////*/

    function transferFractional(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        (address from, address to) = _pair(fromSeed, toSeed);
        amount = bound(amount, 0, _min(_available(from), MAX_MOVE_UNITS * unit));
        vm.prank(from);
        token.transfer(to, amount);
    }

    function transferWholeUnits(uint256 fromSeed, uint256 toSeed, uint256 units) external {
        (address from, address to) = _pair(fromSeed, toSeed);
        uint256 amount = bound(units, 1, 5) * unit;
        if (_available(from) < amount) return;
        vm.prank(from);
        token.transfer(to, amount);
    }

    /// @dev Moves exactly enough for `to` to reach its next whole unit.
    function transferCrossingThreshold(uint256 fromSeed, uint256 toSeed) external {
        (address from, address to) = _pair(fromSeed, toSeed);
        if (from == to) return;
        uint256 amount = unit - (token.balanceOf(to) % unit);
        if (_available(from) < amount) return;
        vm.prank(from);
        token.transfer(to, amount);
        ++countCrossings;
    }

    /// @dev A whole NFT through the mirror, by the owner or by an approved operator (collection template only).
    function transferNft(uint256 fromSeed, uint256 toSeed, uint256 idxSeed, bool viaOperator) external {
        if (!isCollection) return;
        SquareHoleToken t = SquareHoleToken(payable(address(token)));
        (address from, address to) = _pair(fromSeed, toSeed);
        // Prefer the chosen sender; otherwise the next participant that owns an NFT.
        for (uint256 i; i < participants.length && mirror.balanceOf(from) == 0; ++i) {
            from = participants[(fromSeed % participants.length + i) % participants.length];
        }
        uint256 owned = mirror.balanceOf(from);
        if (owned == 0) return;
        uint256 idx = bound(idxSeed, 0, owned - 1);
        uint256 id = t.ownedIds(from, idx, idx + 1)[0];
        address caller = from;
        if (viaOperator) {
            caller = actors[(fromSeed % actors.length + 1) % actors.length];
            vm.prank(from);
            mirror.setApprovalForAll(caller, true);
        }
        vm.prank(caller);
        mirror.transferFrom(from, to, id);
        ++countNftMoves;
        if (viaOperator) {
            vm.prank(from);
            mirror.setApprovalForAll(caller, false);
        }
    }

    function transferFromWithAllowance(uint256 ownerSeed, uint256 toSeed, uint256 amount) external {
        (address owner, address to) = _pair(ownerSeed, toSeed);
        address spender = actors[(ownerSeed % actors.length + 3) % actors.length];
        amount = bound(amount, 0, _min(_available(owner), MAX_MOVE_UNITS * unit));
        vm.prank(owner);
        token.approve(spender, amount);
        vm.prank(spender);
        token.transferFrom(owner, to, amount);
    }

    /// @dev Every actor sells everything back to the market: eligible supply becomes zero, so the next fee
    /// events exercise the bootstrap bucket until someone buys again. Acts on 1 call in 16 (seed hash), so
    /// campaigns spend most of their time with eligible holders.
    function everyoneExits(uint256 seed) external {
        if (uint256(keccak256(abi.encode(seed))) % 16 != 0) return;
        ++countExits;
        for (uint256 i; i < actors.length; ++i) {
            uint256 bal = token.balanceOf(actors[i]);
            if (bal == 0) continue;
            vm.prank(actors[i]);
            token.transfer(launcher, bal);
        }
    }

    function toggleSkipNft(uint256 actorSeed, bool skip) external {
        if (!isCollection) return;
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        SquareHoleToken(payable(address(token))).setSkipNFT(skip);
    }

    /*//////////////////////////////////////////////////////////////
                       FEES, BURNS, CLAIMS, DONATIONS
    //////////////////////////////////////////////////////////////*/

    function feeEvent(uint256 tSeed, uint256 qSeed) external {
        assertEq(ledger.poolNetOutflow(), 0, "no pool outflow is carried into a separate call");
        uint256 t = bound(tSeed, 0, _min(token.balanceOf(launcher), 20 * unit));
        uint256 q = _feeQ(qSeed);
        if (t == 0 && q == 0) q = 1;

        uint256 supply = _actorSupply();
        assertEq(supply, ledger.eligibleSupply(), "all eligible T is held by actors");
        uint256 holderBefore = collector.totalQHolders();
        _fundFeeSource(t, q);
        vm.prank(hook);
        collector.receiveFees(t, q);
        _ghostFee(t, q, collector.totalQHolders() - holderBefore, supply, false);
    }

    /// @dev Uniswap v4 flash-accounting shape inside ONE transaction (one `SameTransaction.run` call): the fee source
    /// is funded (what the hook's afterSwap mints), `borrower` may first pay T into the pool manager (a sell; builds
    /// no credit), takes `taken` T (PoolManager.take), repays `early` (sync/settle), a fee event happens (afterSwap →
    /// receiveFees), and the rest is repaid. The ghost rule is independent of the ledger's counter: with taken − early
    /// > 0 (whatever was paid in before) a fee event carrying holder Q reverts the whole transaction (fail-closed,
    /// review round A: nothing deferred, nothing earned); one without holder Q (dust Q below the 1:2 split) completes
    /// and releases nothing. In-transaction checks of `poolNetOutflow` run as steps of the same call. (The
    /// real-PoolManager version of this sequence is test/integration/V4Integration.t.sol.)
    function flashFeeEvent(uint256 toSeed, uint256 preSeed, uint256 takeSeed, uint256 earlySeed, uint256 qSeed)
        external
    {
        address borrower = actors[toSeed % actors.length];
        uint256 pre = bound(preSeed, 0, _min(token.balanceOf(borrower), 5 * unit));
        uint256 taken = bound(takeSeed, 0, _min(token.balanceOf(poolManager) + pre, MAX_MOVE_UNITS * unit));
        uint256 early = bound(earlySeed, 0, taken);
        uint256 outstanding = taken - early;
        uint256 q = _feeQ(qSeed);
        if (q == 0) q = 1;
        uint256 expectedHolderQ = (q + collector.qRemainder()) / 3 * 2;

        SameTransaction.Call[] memory calls = new SameTransaction.Call[](10);
        uint256 n;
        // Funding the fee source is part of the same transaction, so a refused fee event leaves no claims behind.
        calls[n++] = SameTransaction.Call(
            address(0), address(funder), abi.encodeCall(funder.deposit, (address(quote), address(0), q, hook))
        );
        calls[n++] =
            SameTransaction.Call(hook, address(pm), abi.encodeCall(pm.approve, (address(collector), _qId(), q)));
        if (pre != 0) calls[n++] = _transferCall(borrower, poolManager, pre);
        calls[n++] = _expectOutflowCall(0, "an inflow builds no credit");
        if (taken != 0) calls[n++] = _transferCall(poolManager, borrower, taken);
        if (early != 0) calls[n++] = _transferCall(borrower, poolManager, early);
        calls[n++] = _expectOutflowCall(outstanding, "same-transaction pool net outflow");
        calls[n++] = SameTransaction.Call(hook, address(collector), abi.encodeCall(collector.receiveFees, (0, q)));
        if (outstanding != 0) calls[n++] = _transferCall(borrower, poolManager, outstanding);
        calls[n++] = _expectOutflowCall(0, "fully settled");
        assembly ("memory-safe") {
            mstore(calls, n)
        }

        uint256 holderBefore = collector.totalQHolders();
        ++countFlashOps;
        if (outstanding != 0 && expectedHolderQ != 0) {
            vm.expectRevert(abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, outstanding));
            runner.run(calls);
            ++countFlashReverts;
            return;
        }
        runner.run(calls);
        assertEq(collector.totalQHolders() - holderBefore, expectedHolderQ, "holder Q of the event");
        // Nothing moves after the fee event unless the counter was non-zero, and then the T that moved comes back,
        // so today's balances are the fee-time ones.
        uint256 supply = _actorSupply();
        assertEq(supply, ledger.eligibleSupply(), "all eligible T is held by actors");
        _ghostFee(0, q, expectedHolderQ, supply, outstanding != 0);
    }

    function _qId() internal view returns (uint256) {
        return uint256(uint160(address(quote)));
    }

    /// @dev A fixed share (qSeed % 4 == 0) of fee events carries dust-size Q in [0, 11] wei, so every campaign and
    /// sequence exercises the collector's carried remainder and sub-wei settlement.
    function _feeQ(uint256 qSeed) internal pure returns (uint256) {
        if (qSeed % 4 == 0) return (qSeed >> 2) % 12;
        return bound(qSeed, 0, MAX_FEE_Q);
    }

    /// @dev Gives the fee source `t` T claims (T out of launch inventory into the PoolManager) and `q` Q claims,
    /// and exact ERC-6909 allowances for the collector: what the hook holds for a moment in `afterSwap`.
    function _fundFeeSource(uint256 t, uint256 q) internal {
        if (t != 0) funder.deposit(address(token), launcher, t, hook);
        if (q != 0) funder.deposit(address(quote), address(0), q, hook);
        vm.startPrank(hook);
        if (t != 0) pm.approve(address(collector), uint256(uint160(address(token))), t);
        if (q != 0) pm.approve(address(collector), uint256(uint160(address(quote))), q);
        vm.stopPrank();
    }

    function _transferCall(address from, address to, uint256 amount)
        internal
        view
        returns (SameTransaction.Call memory)
    {
        return SameTransaction.Call(from, address(token), abi.encodeCall(token.transfer, (to, amount)));
    }

    function _expectOutflowCall(uint256 expected, string memory label)
        internal
        view
        returns (SameTransaction.Call memory)
    {
        return SameTransaction.Call(
            address(0),
            address(runner),
            abi.encodeCall(
                runner.expectUint, (address(ledger), abi.encodeCall(ledger.poolNetOutflow, ()), expected, label)
            )
        );
    }

    /// @dev Ghost of one authenticated fee event with `holderQ` holder Q: while borrowed pool T is out the event
    /// can complete only without holder Q, and then releases nothing (flash guard); while no actor holds T it waits
    /// (bootstrap); otherwise it is split pro rata over the actors' balances, together with everything deferred.
    function _ghostFee(uint256 t, uint256 q, uint256 holderQ, uint256 supply, bool poolOutflow) internal {
        ++ghostFeeEvents;
        ghostTIn += t;
        ghostQIn += q;
        if (q != 0 && q < 12) ++countDustFees;
        if (poolOutflow) {
            assertEq(holderQ, 0, "a fee event with holder Q never completes during a pool outflow");
            return;
        }
        if (supply == 0) {
            ghostBootstrap += holderQ;
            if (holderQ != 0) ++countDeferrals;
            return;
        }
        uint256 allocation = holderQ + ghostBootstrap;
        if (ghostBootstrap != 0) ++countReleases;
        ghostBootstrap = 0;
        if (allocation == 0) return;
        ++countAllocations;
        for (uint256 i; i < actors.length; ++i) {
            ghostEntitledScaled[actors[i]] += token.balanceOf(actors[i]) * allocation * GHOST_SCALE / supply;
        }
    }

    function processFees() external {
        (uint256 burned,) = collector.processFees();
        if (burned != 0) ++countBurns;
    }

    function claim(uint256 actorSeed, uint256 priceSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 paid;
        if (payoutIsT) {
            // Whole entitlement, or a partial slice (review round A: partial conversion).
            uint256 maxQ = priceSeed % 3 == 0 ? bound(priceSeed >> 2, 0, ledger.claimable(a)) : type(uint256).max;
            vm.prank(converter);
            paid = ledger.claimFor(a, maxQ);
            assertLe(paid, maxQ);
            // Converter stand-in: the market pays T for the Q entitlement (price 1..100 T per Q, capped). The real
            // converter swaps through the pool (test/integration).
            uint256 tOut = _min(paid * bound(priceSeed, 1, 100), _min(token.balanceOf(launcher), 10 * unit));
            if (tOut != 0) {
                vm.prank(launcher);
                token.transfer(a, tOut);
            }
        } else {
            vm.prank(a);
            paid = ledger.claim(a);
        }
        ghostClaimed[a] += paid;
        if (paid != 0) ++countClaimsPaid;
        _trackError(a);
    }

    /// @dev Unsolicited T and Q: ERC-20 to the collector and ERC-6909 Q claims (the collector's custody medium).
    function donateToCollector(uint256 actorSeed, uint256 tSeed, uint256 qSeed) external {
        address a = actors[actorSeed % actors.length];
        uint256 t = bound(tSeed, 0, _min(token.balanceOf(a), 3 * unit));
        if (t != 0) {
            vm.prank(a);
            token.transfer(address(collector), t);
        }
        uint256 q = bound(qSeed, 0, 1e21);
        if (q % 2 == 0) quote.mint(address(collector), q);
        else funder.deposit(address(quote), address(0), q, address(collector));
    }

    function donateToLedger(uint256 qSeed) external {
        uint256 q = bound(qSeed, 1, 1e21);
        if (q % 2 == 0) quote.mint(address(ledger), q);
        else funder.deposit(address(quote), address(0), q, address(ledger));
    }

    function sweep(uint256 which) external {
        which = which % 5;
        uint256 tId = uint256(uint160(address(token)));
        uint256 qId = uint256(uint160(address(quote)));
        if (which == 0) {
            if (token.balanceOf(address(collector)) != 0) {
                collector.sweepUnaccounted(address(token));
                ++countSweeps;
            }
        } else if (which == 1) {
            if (quote.balanceOf(address(collector)) != 0) {
                collector.sweepUnaccounted(address(quote));
                ++countSweeps;
            }
        } else if (which == 2) {
            if (pm.balanceOf(address(collector), qId) > collector.protocolQPending() + collector.qRemainder()) {
                collector.sweepUnaccountedClaims(address(quote));
                ++countSweeps;
            }
            if (pm.balanceOf(address(collector), tId) > collector.pendingBurnT()) {
                collector.sweepUnaccountedClaims(address(token));
                ++countSweeps;
            }
        } else if (which == 3) {
            if (quote.balanceOf(address(ledger)) != 0) {
                ledger.sweepUnaccounted(address(quote));
                ++countSweeps;
            }
        } else if (pm.balanceOf(address(ledger), qId) > ledger.totalHolderQReceived() - ledger.totalClaimed()) {
            ledger.sweepUnaccountedClaims(address(quote));
            ++countSweeps;
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice |ledger (claimed + claimable) − ghost| for `a`, in wei.
    function entitlementError(address a) public view returns (uint256) {
        uint256 onchain = ghostClaimed[a] + ledger.claimable(a);
        uint256 expected = ghostEntitledScaled[a] / GHOST_SCALE;
        return onchain > expected ? onchain - expected : expected - onchain;
    }

    function _trackError(address a) internal {
        uint256 err = entitlementError(a);
        if (err > ghostMaxEntitlementError) ghostMaxEntitlementError = err;
    }

    function _actorSupply() internal view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += token.balanceOf(actors[i]);
        }
    }

    /// @dev What `from` may move for good. The real PoolManager also holds the T that backs outstanding T claims
    /// (pending fee T of the collector, swept claims of the treasury); a stand-in "sell from pool reserves" must never
    /// spend that backing, or a later burn could not redeem it. Flash borrows (returned in the same transaction) may.
    function _available(address from) internal view returns (uint256) {
        uint256 balance = token.balanceOf(from);
        if (from != poolManager) return balance;
        uint256 tId = uint256(uint160(address(token)));
        uint256 backing = pm.balanceOf(address(collector), tId) + pm.balanceOf(collector.treasury(), tId);
        return balance > backing ? balance - backing : 0;
    }

    function _pair(uint256 fromSeed, uint256 toSeed) internal view returns (address, address) {
        return (participants[fromSeed % participants.length], participants[toSeed % participants.length]);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
