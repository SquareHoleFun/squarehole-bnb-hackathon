// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./AuditU3LaneBase.sol";

/// @notice Stateful adversarial callers on the factory's real box 0. Expected swap refusals are caught;
/// safety failures accumulate in ghosts and never abort a handler call. No mock oracle or storage patch.
contract AuditU3LaneHandler is Test {
    using StateLibrary for IPoolManager;
    CoreBoxAddresses internal a;
    IPoolManager internal pm;
    PoolKey internal key;
    BoxHook internal hook;
    BoxToken internal token;
    BoxReceiver internal receiver;
    BoxCoordinator internal coord;
    PriceLimitSwapper internal swapper;
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;
    AuditU3LaneUnlocker internal twoCaller;
    uint160 internal p0;
    uint160 internal p1;
    uint256 public violations;
    uint256 public seenClose;
    uint256 public closeCount;
    uint256 public swaps;
    uint256 public successfulSwaps;
    uint256 public doubleAttempts;
    uint256 public migrations;
    uint256 public pairs;
    uint256 public conversions;
    uint256 public harvests;

    constructor(CoreBox0Kit kit) {
        a = kit.addresses();
        pm = kit.pm();
        key = kit.poolKey();
        hook = BoxHook(a.hook);
        token = BoxToken(a.token);
        coord = BoxCoordinator(a.coordinator);
        receiver = BoxReceiver(payable(a.receiver));
        swapper = kit.swapper();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
        twoCaller = new AuditU3LaneUnlocker(pm);
        p0 = kit.curve().sqrtPriceUpperX96;
        p1 = kit.curve().sqrtPriceLowerX96;
        token.approve(address(swapper), type(uint256).max);
    }

    function swap(uint256 sizeSeed, uint256 priceSeed, bool buy, bool output) external {
        ++swaps;
        (uint160 before_,,,) = pm.getSlot0(key.toId());
        uint256 max = buy == output ? BoxSpecV1.ISSUANCE : 3 * hook.raise();
        uint256 amount = bound(sizeSeed, 1, max);
        uint160 limit = buy
            ? (before_ <= TickMath.MIN_SQRT_PRICE + 1
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : uint160(bound(priceSeed, TickMath.MIN_SQRT_PRICE + 1, before_ - 1)))
            : (before_ >= TickMath.MAX_SQRT_PRICE - 1
                    ? TickMath.MAX_SQRT_PRICE - 1
                    : uint160(bound(priceSeed, uint256(before_) + 1, TickMath.MAX_SQRT_PRICE - 1)));
        bool blocked = hook.closed() && hook.migratedAtBlock() == 0;
        vm.deal(address(this), 100 ether);
        try swapper.swap{value: buy ? 20 ether : 0}(
            key, buy, output ? int256(amount) : -int256(amount), limit
        ) returns (
            BalanceDelta
        ) {
            ++successfulSwaps;
            if (blocked) violations |= 1;
        } catch {}
        _observe();
    }

    function closeThenReturn(bool output, bool overshoot, bool secondBuy, bool secondOutput, uint256 seed) external {
        if (hook.closed() || hook.migratedAtBlock() != 0) return;
        ++doubleAttempts;
        vm.deal(address(twoCaller), 30 ether);
        uint256 n = bound(seed, 1, secondBuy == secondOutput ? BoxSpecV1.ISSUANCE : 3 * hook.raise());
        SwapParams memory first = SwapParams(
            true,
            output ? int256(BoxSpecV1.ISSUANCE) : -int256(3 * hook.raise()),
            overshoot ? TickMath.MIN_SQRT_PRICE + 1 : p1
        );
        SwapParams memory second = SwapParams(
            secondBuy,
            secondOutput ? int256(n) : -int256(n),
            secondBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        try twoCaller.two(key, first, second, false) {
            if (twoCaller.closedInside() != block.number || twoCaller.secondSucceeded()) violations |= 2;
        } catch {
            violations |= 4;
        }
        _observe();
    }

    function graduate() external {
        if (!hook.closed() || hook.migratedAtBlock() != 0) return;
        try coord.graduate() {
            ++migrations;
        } catch {
            violations |= 8;
        }
        _observe();
    }

    function advance(uint256 seed) external {
        uint256 count = bound(seed, 1, 32);
        for (uint256 i; i < count; ++i) {
            vm.roll(block.number + 20);
            vm.warp(block.timestamp + 240);
            try hook.priceAverage().poke() {}
            catch {
                violations |= 16;
            }
        }
        _observe();
    }

    function collect() external {
        try receiver.collect(address(this)) {
            ++harvests;
        } catch {}
        _observe();
    }

    function gift(uint256 seed, bool withT) external {
        uint256 q = bound(seed, 1, 1 ether);
        vm.deal(address(this), 100 ether);
        minter.mintTo{value: q}(address(this));
        (uint256 beforeQ,) = hook.depthBudget();
        pm.transfer(a.hook, 0, q);
        (uint256 afterQ,) = hook.depthBudget();
        if (afterQ != beforeQ + q) violations |= 32;
        if (withT) {
            uint256 t = token.balanceOf(address(this)) / 4;
            if (t != 0) funder.deposit(a.token, address(this), t, a.hook);
        }
        _observe();
    }

    function deepen() external {
        uint256 last = hook.lastDeepenBlock();
        uint128 l0 = hook.pairedLiquidity();
        (uint256 q0,) = hook.depthBudget();
        try hook.deepen(address(this)) returns (DepthKind kind, DeepenSkip skip, uint256 q, uint256, uint256 tip) {
            if (skip != DeepenSkip.None) {
                if (last != hook.lastDeepenBlock()) violations |= 64;
            } else {
                if (kind == DepthKind.Pair) ++pairs;
                if (kind == DepthKind.Convert) ++conversions;
                (uint256 q1,) = hook.depthBudget();
                if (q0 != q1 + q + tip || tip != (q / 20 < hook.deepenTipCap() ? q / 20 : hook.deepenTipCap())) {
                    violations |= 128;
                }
            }
        } catch {
            violations |= 256;
        }
        if (hook.pairedLiquidity() < l0) violations |= 512;
        _observe();
    }

    function _observe() internal {
        uint256 closed = hook.closedAtBlock();
        if (closed != 0 && seenClose == 0) {
            seenClose = closed;
            ++closeCount;
            if (closed != block.number) violations |= 1024;
        }
        if (seenClose != 0 && seenClose != closed) violations |= 2048;
        (uint160 s,,,) = pm.getSlot0(key.toId());
        if (hook.migratedAtBlock() == 0) {
            if (s > p0) violations |= 4096;
            if (s <= p1 && closed == 0) violations |= 8192;
        }
        (uint256 q, uint256 t) = hook.depthBudget();
        if (q != pm.balanceOf(a.hook, 0) || t != pm.balanceOf(a.hook, uint256(uint160(a.token)))) violations |= 16384;
        if (a.hook.balance != 0 || token.balanceOf(a.hook) != 0 || hook.reserveMinted() > hook.reserveCap()) {
            violations |= 32768;
        }
    }
    receive() external payable {}
}

contract AuditU3LaneInvariants is AuditU3LaneBase {
    AuditU3LaneHandler internal handler;

    function setUp() public override {
        super.setUp();
        _bonding();
        handler = new AuditU3LaneHandler(kit);
        kit.buy(address(handler), 0.5 ether, 0);
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.swap.selector;
        selectors[1] = handler.closeThenReturn.selector;
        selectors[2] = handler.graduate.selector;
        selectors[3] = handler.advance.selector;
        selectors[4] = handler.collect.selector;
        selectors[5] = handler.gift.selector;
        selectors[6] = handler.deepen.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_AUDIT_U3_closeFloorCustodyAndDepth() public view {
        assertEq(handler.violations(), 0, "handler safety ghosts");
        assertLe(handler.closeCount(), 1);
        assertLe(handler.migrations(), 1);
        _assertBalances();
        _assertWord();
    }

    /// @notice Mandatory non-vacuity trace, complementing random scheduling: both directions/output forms,
    /// 1 wei and full curve, close observed inside unlock, blocked return, migrate and real-average deepen.
    function testProperty_AUDIT_U3_handlerVisitsLifecycle() public {
        handler.swap(1, 1, true, false);
        handler.swap(1, type(uint160).max, false, true);
        handler.closeThenReturn(true, false, false, false, 1);
        assertEq(handler.doubleAttempts(), 1);
        handler.swap(1, 1, true, true);
        handler.swap(1, type(uint160).max, false, false);
        handler.graduate();
        handler.gift(1 ether, true);
        for (uint256 i; i < 20; ++i) {
            handler.advance(32);
        }
        handler.deepen();
        handler.collect();
        assertEq(handler.migrations(), 1);
        assertGt(handler.pairs() + handler.conversions(), 0);
        invariant_AUDIT_U3_closeFloorCustodyAndDepth();
    }
}
