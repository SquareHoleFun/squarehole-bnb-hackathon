// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {console} from "forge-std/console.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, SettablePriceAverage} from "./BoxS45Mocks.sol";

interface ITokenLike {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice TEST ONLY: random trades, batches, gifts, depth adds, payouts and time on two graduated boxes (box 0 and a
/// TO_CREATOR box). Every action is fail-safe here (a refused action is a legitimate outcome, not a bug).
contract BoxS45Handler is CommonBase, StdCheats, StdUtils {
    using StateLibrary for IPoolManager;

    IPoolManager internal pm;
    PriceLimitSwapper internal swapper;
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;
    BoxHook[2] internal hooks;
    BoxReceiver[2] internal receivers;
    PoolKey[2] internal keys;
    address[2] internal tokens;
    address[2] internal averages;
    address internal payee;

    /// @notice Box 0's platform credit per epoch, as the receiver reported it (PlatformCredited).
    mapping(uint256 => uint256) public keptInEpoch;
    uint256 public maxEpoch;
    /// @notice The largest liquidity each hook position has shown (positions must never shrink).
    mapping(bytes32 => uint128) public maxLiquidity;
    bytes32[] public positionKeys;
    uint256 public calls;
    /// @notice Coverage counters: actions that did something.
    uint256 public deepenAdds;
    /// S5.M5: deepen() calls that ended as a conversion alone (the T side below MIN_ADD).
    uint256 public deepenConverts;
    uint256 public collects;
    uint256 public payouts;

    constructor(
        IPoolManager pm_,
        PriceLimitSwapper swapper_,
        BoxHook[2] memory hooks_,
        BoxReceiver[2] memory receivers_,
        PoolKey[2] memory keys_,
        address[2] memory tokens_,
        address[2] memory averages_,
        address payee_
    ) {
        pm = pm_;
        swapper = swapper_;
        minter = new EthClaimsMinter(pm_);
        funder = new ClaimsFunder(pm_);
        hooks = hooks_;
        receivers = receivers_;
        keys[0] = keys_[0];
        keys[1] = keys_[1];
        tokens = tokens_;
        averages = averages_;
        payee = payee_;
        for (uint256 i; i < 2; ++i) {
            ITokenLike(tokens[i]).approve(address(swapper_), type(uint256).max);
        }
        _track();
    }

    function buy(uint256 i, uint256 amount) external {
        i %= 2;
        amount = bound(amount, 1e12, 3 ether);
        vm.deal(address(this), address(this).balance + amount);
        // forge-lint: disable-next-line(unsafe-typecast)
        try swapper.swap{value: amount}(keys[i], true, -int256(amount), 0) {} catch {}
        _after();
    }

    function sell(uint256 i, uint256 frac) external {
        i %= 2;
        uint256 held = ITokenLike(tokens[i]).balanceOf(address(this));
        uint256 amount = held * bound(frac, 1, 100) / 100;
        if (amount == 0) return;
        // forge-lint: disable-next-line(unsafe-typecast)
        try swapper.swap(keys[i], false, -int256(amount), 0) {} catch {}
        _after();
    }

    function collect(uint256 i) external {
        i %= 2;
        try receivers[i].collect(address(this)) {
            ++collects;
        } catch {}
        _after();
    }

    function otherFees(uint256 i, uint256 amount) external {
        i %= 2;
        amount = bound(amount, 1, 200 ether);
        vm.deal(address(this), address(this).balance + amount);
        minter.mintTo{value: amount}(address(receivers[i]));
        _after();
    }

    /// @dev Sellers' fees in T reaching the receiver (as claims), so the T side of pair and lock fills too.
    function otherTFees(uint256 i, uint256 amount) external {
        i %= 2;
        uint256 held = ITokenLike(tokens[i]).balanceOf(address(this));
        amount = bound(amount, 0, held / 4);
        if (amount == 0) return;
        funder.deposit(tokens[i], address(this), amount, address(receivers[i]));
        _after();
    }

    function fundFees(uint256 i, uint256 amount) external {
        i %= 2;
        amount = bound(amount, 0, 300 ether);
        vm.deal(address(this), address(this).balance + amount);
        receivers[i].fundFees{value: amount}();
        _after();
    }

    function fundDepth(uint256 i, uint256 amount) external {
        i %= 2;
        amount = bound(amount, 0, 5 ether);
        vm.deal(address(this), address(this).balance + amount);
        receivers[i].fundDepth{value: amount}();
        _after();
    }

    function deepen(uint256 i, int24 offset) external {
        i %= 2;
        vm.roll(block.number + 300);
        vm.warp(block.timestamp + 3600);
        (, int24 spot,,) = pm.getSlot0(keys[i].toId());
        offset = int24(bound(int256(offset), -120, 120));
        SettablePriceAverage(averages[i]).set(true, spot + offset, spot);
        try hooks[i].deepen(address(this)) returns (DepthKind k, DeepenSkip, uint256, uint256, uint256) {
            if (k != DepthKind.None) ++deepenAdds;
            if (k == DepthKind.Convert) ++deepenConverts;
        } catch {}
        _after();
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 40 days);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs / 12 + 1);
        _after();
    }

    function pay(uint256 i, uint256 which) external {
        i %= 2;
        which %= 3;
        if (which == 0) {
            try receivers[i].payFit() {
                ++payouts;
            } catch {}
        } else if (which == 1) {
            try receivers[i].payPlatform() {
                ++payouts;
            } catch {}
        } else {
            vm.prank(payee);
            try receivers[i].claimCreator(payee) {
                ++payouts;
            } catch {}
        }
        _after();
    }

    function _after() internal {
        ++calls;
        (uint256 e, uint256 k,) = receivers[0].platformEpoch();
        if (k > keptInEpoch[e]) keptInEpoch[e] = k;
        if (e > maxEpoch) maxEpoch = e;
        _track();
    }

    /// @dev Records every hook position's liquidity (L7 and the pair; no rungs since F77) and the largest seen.
    function _track() internal {
        for (uint256 i; i < 2; ++i) {
            BoxHook h = hooks[i];
            (int24 lo, int24 hi,) = h.curve();
            _see(i, BoxSpecV1.MIN_USABLE_TICK, lo, 1);
            _see(i, lo, BoxSpecV1.MAX_USABLE_TICK, 1);
            _see(i, hi, BoxSpecV1.MAX_USABLE_TICK, 1);
            _see(i, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 3);
        }
    }

    function _see(uint256 i, int24 lo, int24 hi, uint256 salt) internal {
        bytes32 k = keccak256(abi.encode(i, lo, hi, salt));
        (uint128 l,,) = pm.getPositionInfo(keys[i].toId(), address(hooks[i]), lo, hi, bytes32(salt));
        if (maxLiquidity[k] == 0 && l != 0) positionKeys.push(k);
        if (l > maxLiquidity[k]) maxLiquidity[k] = l;
        positionLiquidity[k] = l;
    }

    mapping(bytes32 => uint128) public positionLiquidity;

    function positionCount() external view returns (uint256) {
        return positionKeys.length;
    }

    receive() external payable {}
}

/// @notice Invariants of the S4+S5 contracts on two graduated boxes under random operations.
contract BoxS45InvariantTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    BoxS45Handler internal handler;
    Box internal b0;
    Box internal b1;

    function setUp() public {
        _setUpWorld();
        Params memory p0 = _box0Params();
        p0.averageKind = 1;
        Box memory x0 = _buildAndLaunch(p0);
        Params memory p1 = _creatorParams(x0.executor, carol);
        p1.averageKind = 1;
        Box memory x1 = _buildAndLaunch(p1);
        _skipWindow(x0);
        _skipWindow(x1);
        _closeAndGraduate(x0);
        _closeAndGraduate(x1);
        b0 = x0;
        b1 = x1;
        BoxHook[2] memory hooks = [x0.hook, x1.hook];
        BoxReceiver[2] memory receivers = [x0.receiver, x1.receiver];
        PoolKey[2] memory keys = [x0.key, x1.key];
        address[2] memory tokens = [address(x0.t), address(x1.t)];
        address[2] memory averages = [x0.average, x1.average];
        handler = new BoxS45Handler(pm, swapper, hooks, receivers, keys, tokens, averages, carol);
        deal(address(x0.t), address(handler), 1e26);
        deal(address(x1.t), address(handler), 3e26);
        targetContract(address(handler));
    }

    /// The receiver's claims always cover every ledger (claims held == Σ ledgers + the next batch).
    function invariant_receiverClaimsCoverItsLedgers() public view {
        _covers(b0);
        _covers(b1);
    }

    function _covers(Box memory b) internal view {
        (uint256 qb, uint256 tb) = b.receiver.booked();
        assertGe(_claims(address(b.receiver), address(0)), qb, "Q claims >= Q ledgers");
        assertGe(_claims(address(b.receiver), address(b.t)), tb, "T claims >= T ledgers");
        assertGe(b.t.balanceOf(address(b.receiver)), b.receiver.tBurnPending(), "T waiting to burn is held");
        (uint256 qc, uint256 tc) = b.receiver.carried();
        assertLt(qc, 15);
        assertLt(tc, 15);
    }

    /// The hook holds no ETH and no T; its claims are its depth budget; the reserve never exceeds its cap.
    function invariant_hookHoldsOnlyClaims() public view {
        Box[2] memory bs = [b0, b1];
        for (uint256 i; i < 2; ++i) {
            assertEq(address(bs[i].hook).balance, 0, "no ETH in the hook");
            assertEq(bs[i].t.balanceOf(address(bs[i].hook)), 0, "no T in the hook");
            (uint256 q, uint256 t) = bs[i].hook.depthBudget();
            assertEq(q, _claims(address(bs[i].hook), address(0)));
            assertEq(t, _claims(address(bs[i].hook), address(bs[i].t)));
            assertLe(bs[i].hook.reserveMinted(), bs[i].hook.reserveCap());
        }
    }

    /// Box 0's Safe keeps at most 32 ETH in every 30-day epoch (BC-106), whatever reaches the receiver.
    function invariant_platformCapPerEpoch() public view {
        for (uint256 e; e <= handler.maxEpoch(); ++e) {
            assertLe(handler.keptInEpoch(e), BoxSpecV1.PLATFORM_CAP_WEI, "<= 32 ETH per epoch");
        }
        (,, uint256 rem) = b0.receiver.platformEpoch();
        assertLe(rem, BoxSpecV1.PLATFORM_CAP_WEI);
        assertEq(b1.receiver.platformOwed(), 0, "the other box never credits a platform");
    }

    /// F77: box 0's platform share is never more than 2/11 of FIT's credits (both come from the same fifteenths; only
    /// FIT's side gains anything else), and its sellers' fees split exactly 13 burned (or waiting to burn) : 2 depth.
    function invariant_box0SplitElevenTwoTwoAndThirteenTwo() public view {
        (uint256 toFit, uint256 toPlatform,, uint256 tToDepth, uint256 tBurned,,) = b0.receiver.totals();
        assertLe(
            (toPlatform + b0.receiver.platformHeld()) * BoxSpecV1.BOX0_FEE_SHARE_FIT,
            toFit * BoxSpecV1.BOX0_FEE_SHARE_PLATFORM,
            "platform <= 2/11 of FIT"
        );
        assertEq(
            tToDepth * BoxSpecV1.BOX0_FEE_SHARE_T_BURN,
            (tBurned + b0.receiver.tBurnPending()) * BoxSpecV1.FEE_SHARE_DEPTH,
            "sellers' side 13 : 2"
        );
    }

    /// No hook position's liquidity ever decreases after graduation (no removal path; D3, BC-120).
    function invariant_positionsNeverShrink() public view {
        uint256 n = handler.positionCount();
        for (uint256 i; i < n; ++i) {
            bytes32 k = handler.positionKeys(i);
            assertEq(handler.positionLiquidity(k), handler.maxLiquidity(k), "liquidity never decreases");
        }
    }

    /// Coverage: totals over the campaign (`afterInvariant`), so a run that only reverts would show.
    function afterInvariant() external view {
        console.log("calls", handler.calls(), "collects", handler.collects());
        console.log("deepen adds", handler.deepenAdds(), "payouts", handler.payouts());
        console.log("of which conversions alone (S5.M5)", handler.deepenConverts());
        console.log("box 0 pair liquidity", uint256(b0.hook.pairedLiquidity()));
        console.log("other box pair liquidity", uint256(b1.hook.pairedLiquidity()));
    }

    /// After graduation nothing ever closes, reopens or moves the phase back.
    function invariant_phasesStay() public view {
        assertEq(uint256(b0.hook.phase()), 5);
        assertEq(uint256(b1.hook.phase()), 5);
        assertEq(b0.router.totalTaxCollected(), 0);
        assertEq(address(b0.router).balance, 0, "the router holds only unswept tax");
    }
}
