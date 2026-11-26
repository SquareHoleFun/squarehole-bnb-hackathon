// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../../src/box/BoxHookExtension.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {BoxPhase, DepthKind, DeepenSkip, FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxSwapBounds} from "../../../../src/box/libraries/BoxSwapBounds.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreBox0Kit, CoreBoxAddresses, CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {EthClaimsMinter, ForeignUnlocker} from "../../s45/BoxS45Mocks.sol";
import {ClaimsFunder} from "../../../utils/ClaimsFunder.sol";
import {PriceLimitSwapper} from "../../../research/hookgas/HookGasKit.sol";

/// @notice Factory v1 box 0, mainnet spec, production hook/coordinator/receiver/executor and pinned local v4.
/// No oracle replacement, storage patch or token mint. ETH is test capital; T comes from real curve buys.
/// The inherited kit's MockWETH is only the wrapped-ETH adapter, unused by these hook operations.
abstract contract AuditU3LaneBase is Test {
    using StateLibrary for IPoolManager;
    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    CoreImpls internal impls;
    IPoolManager internal pm;
    BoxHook internal hook;
    BoxToken internal token;
    BoxReceiver internal receiver;
    BoxCoordinator internal coord;
    FitBuybackExecutor internal average;
    PoolKey internal key;
    BoxLayoutV1.Curve internal curve;
    PriceLimitSwapper internal swapper;
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;
    address internal trader = makeAddr("audit.u3.trader");
    address internal keeper = makeAddr("audit.u3.keeper");
    uint256 internal constant MASK40 = (1 << 40) - 1;

    function setUp() public virtual {
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        BoxSpecV1.BoxSpec memory spec = abi.decode(
            vm.parseJsonBytes(vm.readFile("test/vectors/box-spec/box-spec-v1.json"), ".columns.encoded[0]"),
            (BoxSpecV1.BoxSpec)
        );
        spec.openAt = uint32(block.timestamp + 1 hours);
        kit.build(spec);
        a = kit.addresses();
        impls = kit.impls();
        pm = kit.pm();
        hook = BoxHook(a.hook);
        token = BoxToken(a.token);
        receiver = BoxReceiver(payable(a.receiver));
        coord = BoxCoordinator(a.coordinator);
        average = FitBuybackExecutor(payable(a.executor));
        key = kit.poolKey();
        curve = kit.curve();
        swapper = kit.swapper();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
        vm.deal(address(this), 10_000 ether);
        vm.prank(trader);
        token.approve(address(swapper), type(uint256).max);
        assertEq(address(hook.priceAverage()), a.executor);
        assertEq(hook.raise(), 4.206980085 ether, "mainnet build");
    }

    function _bonding() internal {
        vm.roll(block.number + 400);
        vm.warp(hook.windowEndsAt());
    }

    function _close(bool overshoot) internal {
        _bonding();
        kit.buy(trader, 3 * hook.raise(), overshoot ? 0 : curve.sqrtPriceLowerX96);
        assertEq(hook.closedAtBlock(), block.number);
    }

    function _graduate() internal {
        _close(false);
        vm.prank(keeper);
        coord.graduate();
    }

    function _hold(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            average.poke();
        }
    }

    function _sqrt() internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(key.toId());
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(key.toId());
    }

    function _claims(address who, address asset) internal view returns (uint256) {
        return pm.balanceOf(who, uint256(uint160(asset)));
    }

    function _qValue(uint256 t, uint160 s) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(t, 1 << 96, s), 1 << 96, s);
    }

    function _tValue(uint256 q) internal view returns (uint256) {
        uint160 s = _sqrt();
        return FullMath.mulDiv(FullMath.mulDiv(q, s, 1 << 96), s, 1 << 96);
    }

    function _fundQ(uint256 q) internal {
        minter.mintTo{value: q}(a.hook);
    }

    function _fundT(uint256 t) internal {
        funder.deposit(a.token, trader, t, a.hook);
    }

    function _position(int24 lo, int24 hi, uint256 salt) internal view returns (uint128 l) {
        (l,,) = pm.getPositionInfo(key.toId(), a.hook, lo, hi, bytes32(salt));
    }

    function _coreQ(int24 ref) internal view returns (uint256 q) {
        q = _bandQ(BoxSpecV1.MIN_USABLE_TICK, curve.tickLower, 1, ref)
            + _bandQ(curve.tickLower, BoxSpecV1.MAX_USABLE_TICK, 1, ref)
            + _bandQ(curve.tickUpper, BoxSpecV1.MAX_USABLE_TICK, 1, ref)
            + _bandQ(BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 3, ref);
    }

    function _bandQ(int24 lo, int24 hi, uint256 salt, int24 ref) internal view returns (uint256) {
        uint128 l = _position(lo, hi, salt);
        lo = lo > ref ? lo : ref;
        hi = hi < ref + 953 ? hi : ref + 953;
        if (lo >= hi || l == 0) return 0;
        return SqrtPriceMath.getAmount0Delta(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), l, false);
    }

    function _land(int24 target) internal {
        uint160 s = TickMath.getSqrtPriceAtTick(target);
        if (s < _sqrt()) {
            kit.buy(trader, 100 ether, s);
        } else if (s > _sqrt()) {
            uint256 held = token.balanceOf(trader);
            vm.prank(trader);
            swapper.swap(key, false, -int256(held), s);
        }
        assertEq(_sqrt(), s, "landed at requested tick");
    }

    function _wrapped(bytes4 selector, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)")),
            a.hook,
            selector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _assertBalances() internal view {
        (uint256 q, uint256 t) = hook.depthBudget();
        assertEq(q, _claims(a.hook, address(0)));
        assertEq(t, _claims(a.hook, a.token));
        assertEq(a.hook.balance, 0);
        assertEq(token.balanceOf(a.hook), 0);
        assertLe(hook.reserveMinted(), hook.reserveCap());
    }

    function _assertWord() internal view {
        uint256 w = uint256(vm.load(a.hook, bytes32(0)));
        assertEq(w & 1, 1);
        assertEq((w >> 8) & MASK40, hook.deployBlock());
        assertEq((w >> 48) & MASK40, hook.openAt());
        assertEq((w >> 88) & MASK40, hook.closedAtBlock());
        assertEq((w >> 128) & MASK40, hook.migratedAtBlock());
        assertEq((w >> 168) & MASK40, hook.lastDeepenBlock());
        assertEq(
            w
                & ~uint256(
                    1 | (MASK40 << 8) | (MASK40 << 48) | (MASK40 << 88) | (MASK40 << 128) | (MASK40 << 168)
                        | (15 << 232)
                ),
            0
        );
    }
    receive() external payable {}
}

/// @notice An adversarial real PoolManager caller, not a replacement protocol contract. Settles actual deltas.
contract AuditU3LaneUnlocker is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    IPoolManager public immutable pm;
    uint256 public closedInside;
    bool public secondSucceeded;
    bytes public secondReason;

    constructor(IPoolManager manager) {
        pm = manager;
    }

    function two(PoolKey calldata key, SwapParams calldata first, SwapParams calldata second, bool atomic) external {
        pm.unlock(abi.encode(key, first, second, atomic));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (PoolKey memory k, SwapParams memory first, SwapParams memory second, bool atomic) =
            abi.decode(data, (PoolKey, SwapParams, SwapParams, bool));
        pm.swap(k, first, "");
        closedInside = BoxHook(address(k.hooks)).closedAtBlock();
        if (atomic) {
            pm.swap(k, second, "");
            secondSucceeded = true;
        } else {
            try pm.swap(k, second, "") returns (BalanceDelta) {
                secondSucceeded = true;
            } catch (bytes memory why) {
                secondReason = why;
            }
        }
        _settle(k.currency0);
        _settle(k.currency1);
        return "";
    }

    function _settle(Currency c) internal {
        int256 d = pm.currencyDelta(address(this), c);
        if (d > 0) {
            pm.take(c, address(this), uint256(d));
        } else if (d < 0) {
            if (Currency.unwrap(c) == address(0)) {
                pm.settle{value: uint256(-d)}();
            } else {
                pm.sync(c);
                BoxToken(Currency.unwrap(c)).transfer(address(pm), uint256(-d));
                pm.settle();
            }
        }
    }
    receive() external payable {}
}
