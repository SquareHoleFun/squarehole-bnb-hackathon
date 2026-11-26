// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {DepthKind, DeepenSkip, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {OpenTime} from "../../utils/OpenTime.sol";

/// @notice TEST ONLY: a contract that holds Misfits and placeholders and cannot call the stream itself (F61 X1: any
/// owner earns, contracts included; anyone's `claimFor` pays it).
contract AuditU5LaneContractHolder {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function run(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "call");
        return ret;
    }
}

/// @notice S8 on box 0 built from the core v1 contracts with its spec as it is (the fixture: tStream PER_ITEM_STREAM and
/// add-on 2), created by factory v1 through `CoreBox0Kit` since the S7 × S8 integration: the real pool, receiver, vault,
/// collection, tickets and drand source. The stream is checked against a naive per-swap allocation computed independently of it: before and
/// after every swap the test reads each of box 0's four positions with v4's StateLibrary (getPositionInfo,
/// getFeeGrowthInside), so the swap's T fee f is the change of their uncollected fees, and every outside slot's holder
/// gets 13·f/(15·N) at that moment (BC-065). Placeholders taken on the curve earn from graduation and pass it to their
/// Misfit (G07 point 4), a draw from its request; transfers, returns, batches, a pair-and-lock add (`deepen`, which
/// pokes the pair and changes its liquidity) and claims happen between swaps. EVM Osaka (EIP-2537 for drand).
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.fuzz.runs = 256
contract AuditU5LaneLife is BoxDrandVectors {
    using StateLibrary for IPoolManager;

    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    uint256 internal constant N = 4_269;

    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    BoxItemStream internal st;
    BoxTickets internal tix;
    IDrandSource internal src;
    IPoolManager internal pm;
    PoolId internal pid;
    BoxLayoutV1.Curve internal curve;
    uint256 internal r0;

    address internal alice = makeAddr("s8.life.alice");
    address internal bob = makeAddr("s8.life.bob");
    address internal carol = makeAddr("s8.life.carol");
    address internal dave = makeAddr("s8.life.dave");
    address internal keeper = makeAddr("s8.life.keeper");
    AuditU5LaneContractHolder internal holder;
    address[4] internal owners;

    // ---------------------------------------------------------------- the reference (scaled by 15·N)
    mapping(address => uint256) internal ref;
    mapping(address => uint256) internal intervals;
    mapping(address => uint256) internal paid;
    mapping(address => uint256[]) internal held;
    mapping(address => uint256[]) internal tokensOf;
    uint256 internal placeholderAcc;
    uint256 internal openPlaceholders;
    uint256 internal drawAcc;
    address internal drawer;
    uint256 internal drawTicket;
    uint256 internal events;
    uint256 internal swaps;

    function setUp() public {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        // Rounds are posted on the DrandSource; box 0 reads them through its BoxBackedSource (F143).
        src = IDrandSource(address(b.drand()));
        vm.warp(src.roundTime(r0) - 1 days);
        b.prepare(_fixture());
        b.create();
        a = b.addresses();
        st = BoxItemStream(a.itemStream);
        tix = BoxTickets(a.tickets);
        pm = IPoolManager(a.poolManager);
        pid = BoxHook(a.hook).poolId();
        curve = b.curve();
        holder = new AuditU5LaneContractHolder();
        owners = [alice, bob, carol, address(holder)];
    }

    /// Box 0's spec exactly as the fixture (vector 0 of the shared BoxSpec vectors): PER_ITEM_STREAM and add-on 2.
    function _fixture() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        assertEq(s.tStream, BoxSpecV1.T_STREAM_PER_ITEM_STREAM, "the fixture streams the T side");
    }

    // ------------------------------------------------------------------------------------------------ the life

    /// BC-065 on the real box: the stream's books equal the per-swap allocation through the curve (placeholders taken),
    /// graduation, a draw, 30 days of trading, the openings, transfers to a contract, claims, a pair-and-lock add,
    /// returns and the final checkpoint; conservation to the raw unit. Amounts fuzzed.
    function testFuzz_AUDIT_U5_lifeAgainstPerSwapAllocation(uint256 seed) public {
        seed = bound(seed, 0, type(uint128).max);
        _curveWithPlaceholders(seed);
        _graduateOnTheVectorRound();
        assertTrue(st.started(), "the coordinator's poke started the stream");
        assertEq(st.index(), 0);
        assertEq(st.outsideCount(), 6, "six placeholders outside from their takes");
        _trade(seed, 6);
        // The graduation word, then a draw (its share from its request).
        vm.warp(src.roundTime(r0));
        src.postRound(r0, _localSig(0));
        tix.acceptGraduationWord();
        _trade(seed + 1, 4);
        _draw(carol);
        _trade(seed + 2, 4);
        _collect();
        // REVEAL_GRACE later the holders open without proofs (box 0's fixture root has none).
        _warpDays(31);
        _trade(seed + 3, 4);
        _openPlaceholder(alice, tokensOf[alice][0]);
        _openPlaceholder(alice, tokensOf[alice][1]);
        _openPlaceholder(bob, tokensOf[bob][0]);
        _trade(seed + 4, 3);
        _openPlaceholder(address(holder), tokensOf[address(holder)][0]);
        _openDraw();
        _trade(seed + 5, 5);
        _collect();
        _transfer(alice, address(holder), held[alice][0]);
        _trade(seed + 6, 3);
        _transfer(bob, alice, held[bob][0]);
        _claim(alice);
        _trade(seed + 7, 3);
        // A pair-and-lock add: deepen() creates the pair (salt 3) between swaps.
        _deepenPair();
        _trade(seed + 8, 6);
        // A second add into the pair, which now holds fees: deepen() pokes it (its T fees move to the receiver, U to R,
        // with no batch), then changes its liquidity; a checkpoint follows before the next batch.
        _deepenPair();
        _transfer(address(holder), bob, held[address(holder)][0]);
        _trade(seed + 11, 3);
        _collect();
        // RETURN_GRACE after it left unrevealed, an item comes back.
        _warpDays(31);
        _trade(seed + 9, 3);
        _return(carol, held[carol][0]);
        _trade(seed + 10, 4);
        _settleAndCompare();
    }

    // ------------------------------------------------------------------------------------------------ BC-139

    /// BC-139 on the real per-item stream (the factory's box 0, N 4,269), the receiver side of BC-065: after
    /// graduation each fee batch's T side goes exactly 13/15 to the stream and 2/15 into box 0's own pool (the hook's T
    /// claims at once), the unit first and the remainder carried, nothing burned by the receiver, never the 2/15 to the
    /// stream, whatever the notice does: a notice that reverts (mocked on the real stream) still leaves the 13/15 with
    /// the stream, which counts from its T balance and the fees still uncollected (X = F + 13·⌊(U + R)/15⌋, continuous
    /// across a batch), so nothing is lost or counted twice, and the next notice burns the items-inside share. The real
    /// notice's own gas is BC-065's (BoxItemStreamGas: under STREAM_NOTIFY_GAS under both schedules, so the cap never
    /// cuts it); a notice that burns its gas is s45's stand-in (BoxF77ReceiverTest).
    function testProperty_AUDIT_U5_theRealStreamGetsExactlyThirteenFifteenthsWhateverItsNotice() public {
        _curveWithPlaceholders(1);
        _graduateOnTheVectorRound();
        assertTrue(BoxReceiver(payable(a.receiver)).graduationSettled(), "settled at graduation");
        assertTrue(st.started(), "the stream started at graduation");
        // A batch whose notice reverts: the 13/15 is with the stream all the same, the 2/15 in the pool, and X (which
        // counted it while it was uncollected) neither falls nor counts it twice.
        _roundTrip(1 ether);
        uint256 x0 = st.streamValue();
        (, uint256 burned0) = st.totals();
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onStreamFunds.selector), "");
        (uint256 first, bool noticed) = _batch139();
        vm.clearMockedCalls();
        assertFalse(noticed, "the notice failed (StreamNotifyFailed)");
        assertGt(first, 0);
        assertEq(st.streamValue(), x0, "X continuous across the batch whose notice failed");
        (, uint256 burned1) = st.totals();
        assertEq(burned1, burned0, "nothing burned without the notice");
        // The next batch's notice runs: X still continuous, and it burns the items-inside share of both batches.
        _roundTrip(2 ether);
        uint256 x1 = st.streamValue();
        (, bool noticed2) = _batch139();
        assertTrue(noticed2, "the real notice ran (StreamFunded)");
        assertEq(st.streamValue(), x1, "X continuous across the batch");
        (uint256 claimed, uint256 burned) = st.totals();
        assertGt(burned, 0, "the notice burned the items-inside share");
        assertEq(
            st.streamValue(), BoxToken(a.token).balanceOf(a.itemStream) + claimed + burned, "X = F after the notice"
        );
    }

    /// A buy and a sell of what it bought in the next block: fees on both sides, no batch collected.
    function _roundTrip(uint256 ethIn) internal {
        vm.roll(block.number + 1);
        uint256 t = _swapBuy(dave, ethIn);
        vm.roll(block.number + 1);
        _swapSell(dave, t);
    }

    /// One fee batch after graduation: the T the stream received (T's Transfer into it, equal to what the receiver's
    /// event names; a running notice may burn the items-inside share at once, so its balance is not the measure) is
    /// exactly 13 parts to the hook's 2 (BatchSplit's T depth part, also its T claims' change), nothing burned by the
    /// receiver, the carry below one fifteenth.
    function _batch139() internal returns (uint256 streamed, bool noticed) {
        BoxReceiver r = BoxReceiver(payable(a.receiver));
        (, uint256 hookT0) = BoxHook(a.hook).depthBudget();
        vm.recordLogs();
        r.collect(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 depth;
        uint256 announced;
        bytes32 transfer = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            bytes32 topic = logs[i].topics[0];
            if (logs[i].emitter == a.token && topic == transfer && logs[i].topics.length == 3) {
                if (address(uint160(uint256(logs[i].topics[2]))) == a.itemStream) {
                    streamed += abi.decode(logs[i].data, (uint256));
                }
            }
            if (logs[i].emitter != a.receiver) continue;
            if (topic == IBoxReceiver.BatchSplit.selector) {
                (,,,,,, uint256 td, uint256 tb) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
                depth += td;
                assertEq(tb, 0, "nothing burned by the receiver after graduation: the stream takes the 13/15");
            } else if (topic == IBoxReceiver.StreamFunded.selector || topic == IBoxReceiver.StreamNotifyFailed.selector)
            {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), a.itemStream);
                announced += abi.decode(logs[i].data, (uint256));
                noticed = topic == IBoxReceiver.StreamFunded.selector;
            }
        }
        assertGt(depth, 0, "a batch with T fees");
        assertEq(streamed, announced, "the stream received what the notice names");
        assertEq(streamed * 2, depth * 13, "exactly 13/15 to the stream and 2/15 into the pool, never the 2/15 to it");
        (, uint256 hookT1) = BoxHook(a.hook).depthBudget();
        assertEq(hookT1 - hookT0, depth, "the 2/15 is the hook's T claims at once");
        (, uint256 carry) = r.carried();
        assertLt(carry, 15, "the remainder carried");
    }

    // ------------------------------------------------------------------------------------------------ phases

    function _curveWithPlaceholders(uint256 seed) internal {
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        b.buy(alice, 1 ether, 0);
        b.buy(bob, 1 ether, 0);
        b.buy(address(holder), 0.5 ether, 0);
        uint256 t = b.buy(dave, 0.4 ether + seed % 0.5 ether, 0);
        _take(alice, 3);
        _take(bob, 2);
        _take(address(holder), 1);
        b.sell(dave, t / 3);
        vm.roll(block.number + 12);
        _collect();
        b.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), curve.sqrtPriceLowerX96);
        assertTrue(BoxHook(a.hook).closed(), "closed");
    }

    function _take(address who, uint256 k) internal {
        uint256 first = uint256(tix.status().minted) + 1;
        vm.startPrank(who);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        tix.take(k, type(uint256).max, block.timestamp);
        vm.stopPrank();
        for (uint256 i; i < k; ++i) {
            tokensOf[who].push(first + i);
        }
        openPlaceholders += k;
        events += k;
    }

    function _graduateOnTheVectorRound() internal {
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        assertTrue(BoxCoordinator(a.coordinator).graduated());
    }

    function _draw(address who) internal {
        b.buy(who, 0.5 ether, 0);
        vm.startPrank(who);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.warp(src.roundTime(r0 + 5) - 12);
        drawTicket = tix.draw(type(uint256).max, block.timestamp);
        vm.stopPrank();
        drawer = who;
        ++events;
        vm.warp(src.roundTime(r0 + 5));
        src.postRound(r0 + 5, _localSig(5));
        assertEq(tix.settle(1), 1);
    }

    function _openPlaceholder(address who, uint256 tokenId) internal {
        ItemReveal memory none;
        uint256 id;
        if (who == address(holder)) {
            id = abi.decode(holder.run(a.tickets, abi.encodeCall(BoxTickets.open, (tokenId, none))), (uint256));
        } else {
            vm.prank(who);
            id = tix.open(tokenId, none);
        }
        --openPlaceholders;
        ++events;
        ref[who] += placeholderAcc;
        held[who].push(id);
        (address recorded, uint256 pending) = st.pendingOf(id);
        assertEq(recorded, who, "recorded at the opening");
        assertEq(pending, st.index(), "a placeholder's Misfit carries its share since graduation (G07 point 4)");
    }

    function _openDraw() internal {
        ItemReveal memory none;
        vm.prank(drawer);
        uint256 id = tix.openDraw(drawTicket, address(0), none);
        ++events;
        ++intervals[drawer];
        ref[drawer] += drawAcc;
        drawAcc = 0;
        drawer = address(0);
        held[carol].push(id);
    }

    function _transfer(address from, address to, uint256 id) internal {
        if (from == address(holder)) {
            holder.run(a.collection, abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, id));
        } else {
            vm.prank(from);
            BoxCollection(a.collection).transferFrom(from, to, id);
        }
        ++events;
        ++intervals[from];
        _removeHeld(from, id);
        held[to].push(id);
    }

    function _return(address who, uint256 id) internal {
        vm.startPrank(who);
        BoxCollection(a.collection).setApprovalForAll(a.vault, true);
        BoxVault(a.vault).returnItem(id, 0, block.timestamp);
        vm.stopPrank();
        ++events;
        ++intervals[who];
        _removeHeld(who, id);
    }

    function _claim(address who) internal {
        uint256[] memory ids = held[who];
        intervals[who] += ids.length;
        events += ids.length;
        vm.prank(who);
        paid[who] += st.claim(ids, who);
    }

    /// Pair and lock (F72 (B), F77): the depth budget reaches the minimum on both sides from real fees, the executor's
    /// ring gets a full hour of samples, the cooldown passes, and `deepen()` adds the pair (salt 3).
    function _deepenPair() internal {
        for (uint256 i; i < 4; ++i) {
            uint256 t = _swapBuy(dave, 10 ether);
            _swapSell(dave, t);
        }
        _collect();
        _settleAverage();
        uint128 before = BoxHook(a.hook).pairedLiquidity();
        (DepthKind kind, DeepenSkip skip) = _deepenContinuous();
        assertEq(uint256(skip), uint256(DeepenSkip.None), "deepen ran");
        if (kind == DepthKind.Convert) {
            _settleAverage();
            (kind, skip) = _deepenContinuous();
        }
        assertEq(uint256(kind), uint256(DepthKind.Pair), "a pair-and-lock add");
        assertGt(BoxHook(a.hook).pairedLiquidity(), before, "the pair's liquidity changed between swaps");
    }

    /// deepen() moves nothing the stream counts: its poke of the pair moves U into R exactly, its conversion is a buy
    /// (a fee in Q), its add earns nothing yet, so X and J are the same before and after, to the raw unit.
    function _deepenContinuous() internal returns (DepthKind kind, DeepenSkip skip) {
        uint256 x0 = st.streamValue();
        uint256 j0 = st.index();
        uint256 u0 = _uncollected();
        (kind, skip,,,) = BoxHook(a.hook).deepen(keeper);
        assertEq(st.streamValue(), x0, "X continuous across deepen()");
        assertEq(st.index(), j0, "J continuous across deepen()");
        if (BoxHook(a.hook).pairedLiquidity() != 0 && u0 != 0) {
            assertLe(_uncollected(), u0, "the pair's poke collected its fees (U fell)");
        }
    }

    /// FIT's executor ring (box 0's average): one sample a block until it has caught up with spot and a full hour of
    /// samples sits at it (deepen's guards: caught up, |spot − average| ≤ 99 ticks), and the 300-block cooldown passed.
    function _settleAverage() internal {
        uint256 steady;
        for (uint256 i; i < 3_000 && steady < 320; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            IBoxPriceAverage(a.executor).poke();
            (, int24 spot,,) = pm.getSlot0(pid);
            int24 gap = IBoxPriceAverage(a.executor).latestSampleTick() - spot;
            steady = gap == 0 ? steady + 1 : 0;
        }
        assertEq(steady, 320, "the ring caught up and held an hour at spot");
    }

    // ------------------------------------------------------------------------------------------------ trading

    function _trade(uint256 seed, uint256 k) internal {
        for (uint256 i; i < k; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.roll(block.number + 1);
            uint256 t = _swapBuy(dave, 0.05 ether + r % 2 ether);
            _swapSell(dave, t * (1 + (r >> 64) % 3) / 3);
            if ((r >> 128) % 4 == 0) _collect();
        }
    }

    function _swapBuy(address who, uint256 ethIn) internal returns (uint256 tOut) {
        uint256 u0 = _uncollected();
        tOut = b.buy(who, ethIn, 0);
        _allocate(_uncollected() - u0);
    }

    function _swapSell(address who, uint256 tIn) internal {
        uint256 u0 = _uncollected();
        b.sell(who, tIn);
        _allocate(_uncollected() - u0);
    }

    /// The per-swap allocation: the swap's T fee f, 13·f/(15·N) to each outside slot's holder now (scaled: 13·f).
    function _allocate(uint256 f) internal {
        ++swaps;
        uint256 per = 13 * f;
        for (uint256 i; i < owners.length; ++i) {
            ref[owners[i]] += held[owners[i]].length * per;
        }
        placeholderAcc += per;
        if (drawer != address(0)) drawAcc += per;
    }

    /// The T fees box 0's four positions earned and nobody collected, read with v4's StateLibrary (not the stream's).
    function _uncollected() internal view returns (uint256 u) {
        int24 mn = BoxSpecV1.MIN_USABLE_TICK;
        int24 mx = BoxSpecV1.MAX_USABLE_TICK;
        u = _owed(mn, curve.tickLower, bytes32(uint256(1)));
        u += _owed(curve.tickLower, mx, bytes32(uint256(1)));
        u += _owed(curve.tickUpper, mx, bytes32(uint256(1)));
        u += _owed(mn, mx, bytes32(uint256(3)));
    }

    function _owed(int24 lower, int24 upper, bytes32 salt) internal view returns (uint256) {
        (uint128 l,, uint256 last) = pm.getPositionInfo(pid, a.hook, lower, upper, salt);
        if (l == 0) return 0;
        (, uint256 g) = pm.getFeeGrowthInside(pid, lower, upper);
        unchecked {
            return FullMath.mulDiv(g - last, l, 1 << 128);
        }
    }

    // ------------------------------------------------------------------------------------------------ the end

    function _settleAndCompare() internal {
        _swapBuy(dave, 1 ether); // a batch above the minimum
        _collect();
        assertEq(BoxReceiver(payable(a.receiver)).graduationSettled(), true);
        for (uint256 i; i < owners.length; ++i) {
            address o = owners[i];
            uint256[] memory ids = held[o];
            intervals[o] += ids.length;
            events += ids.length;
            paid[o] += st.claimFor(o, ids);
        }
        st.burn();
        uint256 scale = 15 * N;
        uint256 owed;
        for (uint256 i; i < owners.length; ++i) {
            address o = owners[i];
            uint256 got = st.owedOf(o) + paid[o];
            owed += st.owedOf(o);
            emit log_named_uint("S8LIFE|owner got", got);
            emit log_named_int("S8LIFE|owner got - per-swap", int256(got) - int256(ref[o] / scale));
            emit log_named_uint("S8LIFE|owner intervals", intervals[o]);
            assertApproxEqAbs(got, ref[o] / scale, intervals[o] * 3 + 2, string.concat("owner ", vm.toString(i)));
            assertGt(got, 0, "every holder earned");
        }
        assertGt(BoxToken(a.token).balanceOf(address(holder)), 0, "the contract holder was paid (claimFor)");
        // Conservation: what the receiver sent = held + paid + burned (the stream's own books).
        (uint256 claimed, uint256 burned) = st.totals();
        uint256 balance = BoxToken(a.token).balanceOf(address(st));
        assertEq(st.streamValue(), balance + claimed + burned, "X = F after the last batch (no pending fifteenth)");
        uint256 j = st.index();
        (uint256 p, uint256 d, uint256 sum) = st.openTickets();
        assertEq(p, openPlaceholders, "one placeholder never opened");
        assertEq(d, 0);
        assertEq(st.liabilities(), owed + p * j + (d * j - sum), "booked or on an open ticket, exactly");
        assertApproxEqAbs(p * j, openPlaceholders * placeholderAcc / scale, 2, "the open placeholder's share");
        assertGe(balance, st.liabilities(), "owners covered");
        assertLe(balance - st.liabilities(), st.outsideCount(), "the per-slot margin only");
        assertGt(swaps, 40);
        emit log_named_uint("S8LIFE|swaps", swaps);
        emit log_named_uint("S8LIFE|burned", burned);
        emit log_named_uint("S8LIFE|claimed", claimed);
    }

    /// A fee batch when it reaches the minimum (anyone's `collect`, as a keeper runs it). After the start X is the same
    /// before and after a batch, to the raw unit: the harvest moves U into R, the split R into F (13/15) and depth.
    function _collect() internal {
        bool live = st.started();
        uint256 x0 = st.streamValue();
        try BoxReceiver(payable(a.receiver)).collect(keeper) {} catch {}
        if (live) assertEq(st.streamValue(), x0, "X continuous across a batch");
    }

    function _removeHeld(address o, uint256 id) internal {
        uint256[] storage h = held[o];
        for (uint256 i; i < h.length; ++i) {
            if (h[i] == id) {
                h[i] = h[h.length - 1];
                h.pop();
                return;
            }
        }
        revert("not held");
    }

    function _warpDays(uint256 d) internal {
        vm.warp(block.timestamp + d * 1 days);
        vm.roll(block.number + d * 7_200);
    }
}
