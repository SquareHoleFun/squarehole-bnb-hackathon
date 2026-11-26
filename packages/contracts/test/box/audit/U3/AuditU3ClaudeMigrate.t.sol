// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lens L1 on the curve's fees and the migration, and L5's forcing cost (P3.2, P3.3,
/// P3.12) on the factory's box 0: `harvest` mints the curve's fees as claims, the D6 reserve first and never above its
/// cap, only before graduation; `migrate` turns the curve's Q and the coordinator's pool share into exactly the L7
/// positions, the Q dust to the receiver, nothing left in the hook or the coordinator; forcing graduation costs at
/// least BC-029's figures on the mainnet build. Sources: `BoxHookBase.sol:197-215`, `BoxHook.sol:440-466`,
/// `BoxHookExtension.sol:169-244`, `IBoxHook.sol:54-64`, BC-017, BC-027, BC-029, BC-067, D6.
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeMigrateTest is AuditU3ClaudeBase {
    /// @dev ERC-6909's Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256).
    bytes32 internal constant _TRANSFER_6909 = keccak256("Transfer(address,address,address,uint256,uint256)");
    address internal forcer = makeAddr("audit.u3.forcer");

    /// @dev One `Migrated` event.
    struct Mig {
        uint256 qFrom;
        uint256 tFrom;
        uint128 askL;
        uint128 bidL;
        uint128 sentL;
        uint256 pulled;
        uint256 qDust;
    }

    // ============================================================================================================
    // P3.2: harvest

    /// Batches from the window's end on, the reserve filling across them: every batch mints exactly the fees poked
    /// (the Harvested event's figures), first min(Q fees, cap − minted) to the coordinator, the rest of Q and all T to
    /// the receiver; reserveMinted never exceeds the cap and equals the coordinator's Q claims (BC-017, D6).
    function testFuzz_AUDIT_U3_harvestReserveFirstNeverAboveTheCap(uint256 seed) public {
        _toWindow();
        _warpTo(hook.windowEndsAt());
        uint256 cap = hook.reserveCap();
        uint256 sumReserve;
        for (uint256 i; i < 4; ++i) {
            uint256 eth = bound(uint256(keccak256(abi.encode(seed, i))), 0.5 ether, 1 ether);
            uint256 t = _buy(eoa[i], eth);
            _sell(eoa[i], t / 2);
            _advance(2);
            uint256 minted0 = hook.reserveMinted();
            vm.recordLogs();
            FeeBatch memory b = _collect(keeper, keeper);
            VmSafe.Log[] memory logs = vm.getRecordedLogs();
            (uint256 hq, uint256 ht, uint256 hr) = _harvestedIn(logs);
            assertEq(b.qToReserve, hr, "the batch reports the hook's reserve part");
            uint256 want = cap - minted0 < hq ? cap - minted0 : hq;
            assertEq(hr, want, "min(Q fees, cap - minted) to the reserve");
            assertEq(hook.reserveMinted(), minted0 + hr);
            assertLe(hook.reserveMinted(), cap, "never above the cap");
            assertEq(_mintedIn(logs, a.coordinator, 0), hr, "the reserve minted to the coordinator only");
            assertEq(_mintedIn(logs, a.receiver, 0), hq - hr, "the rest of Q minted to the receiver");
            assertEq(_mintedIn(logs, a.receiver, uint256(uint160(a.token))), ht, "all T minted to the receiver");
            assertEq(_mintedIn(logs, a.hook, 0) + _mintedIn(logs, a.hook, uint256(uint160(a.token))), 0);
            sumReserve += hr;
        }
        assertEq(sumReserve, hook.reserveMinted());
        assertEq(pm.balanceOf(a.coordinator, 0), hook.reserveMinted(), "the coordinator holds exactly the reserve");
    }

    /// After graduation no batch mints anything to the coordinator: the reserve is closed (qToReserve 0), its claims
    /// stay the reward credited at graduation.
    function testProperty_AUDIT_U3_noReserveAfterGraduation() public {
        _toGraduated();
        uint256 minted = hook.reserveMinted();
        uint256 cq = pm.balanceOf(a.coordinator, 0);
        _buy(eoa[3], 0.8 ether);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _advance(3);
        vm.recordLogs();
        FeeBatch memory b = _collect(keeper, keeper);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        (uint256 hq, uint256 ht, uint256 hr) = _harvestedIn(logs);
        assertEq(b.qToReserve, 0);
        assertEq(hr, 0);
        assertEq(_mintedIn(logs, a.coordinator, 0), 0, "nothing minted to the coordinator");
        assertEq(_mintedIn(logs, a.receiver, 0), hq, "all Q fees to the receiver");
        assertEq(_mintedIn(logs, a.receiver, uint256(uint160(a.token))), ht);
        assertEq(hook.reserveMinted(), minted);
        assertEq(pm.balanceOf(a.coordinator, 0), cq, "the coordinator's claims do not grow after graduation");
    }

    // ============================================================================================================
    // P3.3: migrate

    /// The migration turns the curve's Q and the coordinator's whole T into exactly BoxLayoutV1.graduated(curve,
    /// ASK_FULL_BID_SENTINEL, qFromCurve, share + tFromCurve): the three positions at salt 1 with exactly the library's
    /// liquidities, the Q dust to the receiver as claims, the pool share out of the coordinator (the ask's part pulled,
    /// the rest burned), the price at exactly P1, and the hook holding no ETH, no T and no position but L7 (BC-067).
    function testProperty_AUDIT_U3_migrateIsExactlyTheLayout() public {
        _toClosed();
        uint256 share = token.balanceOf(a.coordinator);
        uint160 sFrom = _sqrtP() < curve.sqrtPriceLowerX96 ? curve.sqrtPriceLowerX96 : _sqrtP();
        uint256 qCurve = SqrtPriceMath.getAmount0Delta(sFrom, curve.sqrtPriceUpperX96, curve.liquidity, false);
        uint256 tCurve = SqrtPriceMath.getAmount1Delta(curve.sqrtPriceLowerX96, sFrom, curve.liquidity, false);
        uint256 supply0 = token.totalSupply();
        vm.recordLogs();
        vm.prank(keeper);
        coordinator.graduate();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        Mig memory m = _migratedIn(logs);
        assertEq(m.qFrom, qCurve, "the curve's Q at removal (rounded down)");
        assertEq(m.tFrom, tCurve, "the curve's T at removal");
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.qFrom, share + m.tFrom);
        assertEq(m.askL, g.ask.liquidity);
        assertEq(m.bidL, g.bid.liquidity);
        assertEq(m.sentL, g.sentinel.liquidity);
        assertEq(_askL(), m.askL, "the ask in the pool");
        assertEq(_bidL(), m.bidL, "the full-range bid");
        assertEq(_sentinelL(), m.sentL, "the sentinel");
        assertEq(m.bidL, m.askL, "the bid at the ask's liquidity (Q enough)");
        assertEq(m.qDust, g.qDust);
        assertEq(m.qDust, m.qFrom - g.bid.amount - g.sentinel.amount, "dust = what the bid and the sentinel left");
        assertEq(m.pulled, g.ask.amount - m.tFrom, "T beyond the curve's from the pool share");
        assertEq(token.balanceOf(a.coordinator), 0, "the pool share left the coordinator");
        assertEq(supply0 - token.totalSupply(), share - m.pulled, "the rest of the share burned");
        assertEq(token.balanceOf(a.hook), 0, "the hook holds no T");
        assertEq(a.hook.balance, 0, "the hook holds no ETH");
        assertEq(_curveL(), 0, "the curve removed whole");
        assertEq(_pairL(), 0);
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96, "the price at exactly P1");
        assertGe(_mintedIn(logs, a.receiver, 0), m.qDust, "the dust minted to the receiver (with the last fees)");
        uint256 toHook = _mintedIn(logs, a.hook, 0) + _mintedIn(logs, a.hook, uint256(uint160(a.token)));
        assertEq(toHook, 0, "none to the hook");
        emit log_named_uint("qFromCurve (wei)", m.qFrom);
        emit log_named_uint("qDust (wei)", m.qDust);
        emit log_named_uint("pool share (T raw)", share);
        emit log_named_uint("ask's T pulled from the share", m.pulled);
        emit log_named_uint("share burned", share - m.pulled);
    }

    /// A third party's T sent to the coordinator before graduation (T refuses no send there) joins the pool share: the
    /// ask takes it, the bid stays at most the curve's Q, and the coordinator still ends with none (BC-067 "the pool
    /// share left the coordinator only into the pool or a burn"); graduation does not fail.
    function testProperty_AUDIT_U3_aTGiftToTheCoordinatorJoinsTheAsk() public {
        _toClosed();
        uint256 gift = token.balanceOf(eoa[2]) / 2;
        _transferT(eoa[2], a.coordinator, gift);
        uint256 share = token.balanceOf(a.coordinator);
        vm.recordLogs();
        vm.prank(keeper);
        coordinator.graduate();
        Mig memory m = _migratedIn(vm.getRecordedLogs());
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.qFrom, share + m.tFrom);
        assertEq(m.askL, g.ask.liquidity, "the ask takes the gift");
        assertEq(m.bidL, g.bid.liquidity);
        assertLe(g.bid.amount + g.sentinel.amount + g.qDust, m.qFrom, "no Q beyond the curve's");
        assertEq(token.balanceOf(a.coordinator), 0);
        assertEq(m.pulled, g.ask.amount - m.tFrom);
        emit log_named_uint("ask L with the gift", m.askL);
        emit log_named_uint("bid L with the gift", m.bidL);
        _assertGhostLedger();
    }

    /// Any T gift to the coordinator between the close and graduate() (T refuses no transfer there and nothing takes T
    /// out of the coordinator), from one to four holders, from 1 raw unit up to all they hold: graduation still
    /// succeeds and seeds exactly BoxLayoutV1's layout for the pool share plus the gift (the ask takes it), the Q side
    /// is the curve's whole raise, the coordinator ends with no T and the hook with none (BC-067; launch-pipeline-v1.md
    /// § 3.4 "It cannot be blocked"). A gift that broke one of the migration's exact-amount checks
    /// (`BoxHookExtension.sol:219-243`) would freeze a closed box for good: every swap reverts until graduate().
    function testFuzz_AUDIT_U3_anyTGiftToTheCoordinatorStillGraduates(uint256 giftSeed, uint8 holders) public {
        _toClosed();
        address[4] memory from = [eoa[2], eoa[0], eoa[3], eoa[1]];
        uint256 gift;
        for (uint256 i; i <= holders % 4; ++i) {
            uint256 bal = token.balanceOf(from[i]);
            if (bal == 0) continue;
            uint256 seed = uint256(keccak256(abi.encode(giftSeed, i)));
            // A third of the cases a small gift (dust edges), else anything up to the whole balance.
            uint256 amt = seed % 3 == 0 ? bound(seed, 1, 1e6) : bound(seed, 1, bal);
            if (amt > bal) amt = bal;
            _transferT(from[i], a.coordinator, amt);
            gift += amt;
        }
        uint256 share = token.balanceOf(a.coordinator);
        vm.recordLogs();
        vm.prank(keeper);
        coordinator.graduate();
        Mig memory m = _migratedIn(vm.getRecordedLogs());
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.qFrom, share + m.tFrom);
        assertEq(m.qFrom, raise, "the curve closed at P1 holds exactly R");
        assertEq(m.askL, g.ask.liquidity, "the ask takes the share and the gift");
        assertEq(m.bidL, g.bid.liquidity);
        assertEq(m.sentL, g.sentinel.liquidity);
        assertEq(m.qDust, g.qDust);
        assertEq(_askL(), m.askL);
        assertEq(_bidL(), m.bidL);
        assertEq(_sentinelL(), m.sentL);
        assertLe(g.bid.amount + g.sentinel.amount + g.qDust, m.qFrom);
        assertEq(token.balanceOf(a.coordinator), 0, "the coordinator ends with no T");
        assertEq(token.balanceOf(a.hook), 0, "the hook holds no T");
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96, "at exactly P1");
        emit log_named_uint("gift (T raw)", gift);
        _assertGhostLedger();
    }

    /// Every batch mints exactly the fees v4 owes the hook's positions (StateLibrary's fee growth inside times the
    /// liquidity, floored: `Position.update`), on the curve and after graduation (ask, bid, sentinel), and leaves none
    /// owed (P3.2 "nothing lost to rounding"); the Q fees are 1% of the exact-input buys within one raw unit per swap
    /// step, two steps at most per buy here (BC-017 "the 1% LP fee of every input ... within one raw unit per swap
    /// step").
    function testFuzz_AUDIT_U3_harvestMintsExactlyWhatV4Owes(uint256 seed, bool graduated) public {
        if (graduated) _toGraduated();
        else _toBonding();
        // Two to four buys of 0.26-0.4 ETH: a batch above the 0.005 ETH minimum that leaves the curve open.
        uint256 n = 2 + seed % 3;
        uint256 fees1pct;
        for (uint256 i; i < n; ++i) {
            uint256 eth = bound(uint256(keccak256(abi.encode(seed, i))), 0.26 ether, 0.4 ether);
            uint256 t = _buy(eoa[3 + i % 3], eth);
            fees1pct += eth - eth * 99 / 100;
            if (i % 2 == 1) _sell(eoa[3 + i % 3], t / 3);
        }
        _advance(2);
        (uint256 oq, uint256 ot) = _owedAll();
        vm.recordLogs();
        _collect(keeper, keeper);
        (uint256 hq, uint256 ht,) = _harvestedIn(vm.getRecordedLogs());
        assertEq(hq, oq, "Q: exactly what v4 owes");
        assertEq(ht, ot, "T: exactly what v4 owes");
        (uint256 oq2, uint256 ot2) = _owedAll();
        assertEq(oq2 + ot2, 0, "nothing left owed");
        // One raw unit per swap step either way: v4 rounds each step's fee up and the fee growth down, and a buy that
        // crosses a word of the tick bitmap (15,360 ticks) takes two steps.
        assertApproxEqAbs(hq, fees1pct, 2 * n, "1% of the buys within one raw unit per swap step");
    }

    // ============================================================================================================
    // P3.12: forcing graduation (BC-029), re-measured on the mainnet build

    /// BC-029 at 20.7% fill by ETH: the round trip (buy to P1, graduate, sell all back) costs at least 0.670 ETH and
    /// the pool keeps at least the Q the curve held (margin at least 0.636); the D6 reward (0.1% of R) leaves it a
    /// loss.
    function testProperty_AUDIT_U3_forcingCostFill207() public {
        (uint256 cost, uint256 reward) = _forcing(207_000, 0.67 ether, 0.636 ether);
        assertGt(cost, reward, "forcing at 20.7% loses money even with the reward");
    }

    /// BC-029 at 70.1%: at least 0.121 ETH (margin 0.108); a loss after the reward.
    function testProperty_AUDIT_U3_forcingCostFill701() public {
        (uint256 cost, uint256 reward) = _forcing(701_000, 0.121 ether, 0.108 ether);
        assertGt(cost, reward, "forcing at 70.1% loses money even with the reward");
    }

    /// BC-029 at 98.1%: at least 0.0019 ETH (margin 0.0011). Measured: the D6 reward the forcer is credited
    /// (0.004207 ETH) exceeds the round trip's cost (0.002028 ETH), so forcing a 98.1%-full curve nets 0.002179 ETH:
    /// pinned as the accepted behaviour (launch-pipeline-v1.md § 3.4: "the near-full-curve round trip below is
    /// accepted"; F75 W2 keeps the reward at 0.1% of R); BC-029 itself counts no reward.
    function testProperty_AUDIT_U3_forcingCostFill981() public {
        (uint256 cost, uint256 reward) = _forcing(981_000, 0.0019 ether, 0.0011 ether);
        assertGt(reward, cost, "accepted: the reward exceeds the cost of forcing a 98.1%-full curve");
    }

    function _forcing(uint256 fillPpm, uint256 minCost, uint256 minMargin)
        internal
        returns (uint256 cost, uint256 reward)
    {
        _toWindow();
        _warpTo(hook.windowEndsAt());
        uint256 target = raise * fillPpm / 1e6;
        uint256 held = _curveQNow();
        require(target > held, "fill above the window's buys");
        uint160 limit = SqrtPriceMath.getNextSqrtPriceFromInput(_sqrtP(), curve.liquidity, target - held, true);
        _buyTo(eoa[4], 2 * raise, limit);
        uint256 qBefore = _curveQNow();
        // The forcer: one block, buy to P1, graduate, sell everything back.
        _advance(1);
        uint256 e0 = forcer.balance + 3 * raise;
        uint256 tBought = _buyTo(forcer, 3 * raise, curve.sqrtPriceLowerX96);
        assertTrue(hook.closed());
        uint256 paid = e0 - forcer.balance;
        _graduate(forcer);
        uint256 received = _sell(forcer, tBought);
        cost = paid - received;
        reward = coordinator.rewardOf(forcer);
        uint256 poolQ = _poolQAbovePrice();
        emit log_named_decimal_uint("fill by ETH (of R)", qBefore * 1e18 / raise, 18);
        emit log_named_decimal_uint("round-trip cost (ETH)", cost, 18);
        emit log_named_decimal_uint("D6 reward credited to the forcer (ETH)", reward, 18);
        emit log_named_decimal_int("net cost after the reward (ETH)", int256(cost) - int256(reward), 18);
        emit log_named_decimal_uint("pool Q after - curve Q before (ETH)", poolQ - qBefore, 18);
        assertGe(cost, minCost, "BC-029: the round trip costs at least the case's figure");
        assertGe(poolQ, qBefore, "the pool keeps at least what the curve held");
        assertGe(poolQ - qBefore, minMargin, "by the case's margin");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev The Q the curve holds at the price (removal rounding: down).
    function _curveQNow() internal view returns (uint256) {
        uint160 s = _sqrtP();
        if (s >= curve.sqrtPriceUpperX96) return 0;
        uint160 lo = s < curve.sqrtPriceLowerX96 ? curve.sqrtPriceLowerX96 : s;
        return SqrtPriceMath.getAmount0Delta(lo, curve.sqrtPriceUpperX96, curve.liquidity, false);
    }

    /// @dev The Q the hook's positions hold above the price (ETH a seller of T can still reach).
    function _poolQAbovePrice() internal view returns (uint256 q) {
        uint160 s = _sqrtP();
        uint160 maxS = TickMath.getSqrtPriceAtTick(MAX_T);
        q = _q0(s > _sqrtAt(curve.tickLower) ? s : _sqrtAt(curve.tickLower), maxS, _bidL());
        q += _q0(s > _sqrtAt(curve.tickUpper) ? s : _sqrtAt(curve.tickUpper), maxS, _sentinelL());
        if (s < _sqrtAt(curve.tickLower)) q += _q0(s, _sqrtAt(curve.tickLower), _askL());
        q += _q0(s, maxS, _pairL());
    }

    /// @dev The `Harvested` event's (qFees, tFees, qToReserve) among `logs`.
    function _harvestedIn(VmSafe.Log[] memory logs) internal view returns (uint256 q, uint256 t, uint256 r) {
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.Harvested.selector) {
                (q, t, r) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                seen = true;
            }
        }
        require(seen, "no Harvested event");
    }

    /// @dev Σ ERC-6909 claims of `id` the PoolManager minted to `to` among `logs` (Transfer with from = 0).
    function _mintedIn(VmSafe.Log[] memory logs, address to, uint256 id) internal view returns (uint256 sum) {
        for (uint256 i; i < logs.length; ++i) {
            VmSafe.Log memory l = logs[i];
            if (l.emitter != address(pm) || l.topics.length != 4 || l.topics[0] != _TRANSFER_6909) continue;
            if (l.topics[1] != bytes32(0) || l.topics[2] != bytes32(uint256(uint160(to)))) continue;
            if (uint256(l.topics[3]) != id) continue;
            (, uint256 amount) = abi.decode(l.data, (address, uint256));
            sum += amount;
        }
    }

    /// @dev The `Migrated` event's figures among `logs`.
    function _migratedIn(VmSafe.Log[] memory logs) internal view returns (Mig memory m) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.Migrated.selector) {
                (m.qFrom, m.tFrom, m.askL, m.bidL, m.sentL, m.pulled, m.qDust) =
                    abi.decode(logs[i].data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
                return m;
            }
        }
        revert("no Migrated event");
    }
}
