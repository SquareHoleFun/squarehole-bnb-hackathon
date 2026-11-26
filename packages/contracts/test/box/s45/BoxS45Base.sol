// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../src/box/BoxHookExtension.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxPriceSampler} from "../../../src/box/BoxPriceSampler.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../src/box/BoxReceiverExtension.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {FitBuybackExecutor, IBurnableToken} from "../../../src/box/FitBuybackExecutor.sol";
import {BoxKind, RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {HookGasFit, PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {MockBoxCoordinator, MockFitExecutor, MockSwapModule, SettablePriceAverage} from "./BoxS45Mocks.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice TEST ONLY: builds boxes from the S4+S5 implementations on a local PoolManager (pinned v4-core source), with
/// S6's coordinator calls mocked exactly as core-v1-interfaces § 2 pins them. Every per-box contract is an EIP-1167
/// clone with immutable arguments; the hook's sits at an address carrying exactly the flags 0x2AE0 (placed with
/// `vm.etch`, as S0 placed its full-contract variants; one test mines a real CREATE2 salt instead). The mocked
/// coordinator is itself a clone of one `MockBoxCoordinator` implementation, which the implementations name as their
/// coordinator implementation (only its clones may initialise them, BC-100; review of sh-core-v1).
abstract contract BoxS45Base is Test {
    using StateLibrary for IPoolManager;

    bytes10 internal constant PROXY_HEAD = 0x363d3d373d3d3d363d73;
    bytes15 internal constant PROXY_TAIL = 0x5af43d82803e903d91602b57fd5bf3;
    uint160 internal constant FLAGS = 0x2AE0;
    uint256 internal constant BOX0_RAISE = 4_206_980_085_000_000_000;
    uint256 internal constant ONE_ETH_RAISE = 1 ether;

    /// @notice What a box is made of.
    struct Box {
        BoxKind kind;
        uint256 raise;
        HookGasFit t;
        MockBoxCoordinator coord;
        BoxHook hook;
        BoxLaunchRouter router;
        BoxReceiver receiver;
        address average;
        address executor;
        address safe;
        address stream;
        address payee;
        /// The swap module (S5.M1): every Standard box's, a `MockSwapModule` unless the params name one; box 0: none.
        address module;
        BoxLayoutV1.Curve curve;
        PoolKey key;
        uint256 openDelay;
    }

    /// @notice How to build one.
    struct Params {
        BoxKind kind;
        uint256 raise;
        /// The open in blocks of 12 s after the build (OpenTime.inBlocks: what openDelayBlocks meant); 0: use `openAt`.
        uint32 openDelay;
        /// With `openDelay` 0: the hook's, router's (and tickets') openAt argument as given (Unix seconds; 0 = Now).
        uint32 openAt;
        uint8 qStream;
        uint8 tStream;
        address payee;
        address stream;
        /// 0: the kind's real average (box 0: FIT's executor; others: a sampler clone); 1: a settable stand-in
        uint8 averageKind;
        address executor;
        uint256 creatorBuy;
        address creator;
        RoyaltyDestination royalty;
        /// A swap module to name instead of the default (a Standard box's `MockSwapModule`; box 0: none).
        address module;
        /// S5.M2: a Standard box's real `BoxSwapModule` clone (102 argument bytes) instead of the mock.
        bool realModule;
        /// S5.M3, add-on 5: the creator's cap per 30-day epoch (Q raw units; 0: none) and its excess destination.
        uint128 creatorCap;
        uint8 capExcess;
    }

    IPoolManager internal pm;
    MockBoxCoordinator internal coordImpl;
    BoxHook internal hookImpl;
    BoxHookExtension internal hookExt;
    BoxLaunchRouter internal routerImpl;
    BoxReceiver internal receiverImpl;
    BoxReceiverExtension internal receiverExt;
    BoxPriceSampler internal samplerImpl;
    BoxRoyaltyRouter internal royaltyImpl;
    /// S5.M2's module implementation, deployed the first time a box asks for a real module.
    BoxSwapModule internal moduleImpl;
    PriceLimitSwapper internal swapper;
    address internal safe = makeAddr("s45.safe");
    address internal alice = makeAddr("s45.alice");
    address internal bob = makeAddr("s45.bob");
    address internal carol = makeAddr("s45.carol");
    address internal keeper = makeAddr("s45.keeper");
    uint256 internal boxSeed;

    function _setUpWorld() internal {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("s45.pmOwner"))));
        coordImpl = new MockBoxCoordinator(pm);
        hookExt = new BoxHookExtension(pm);
        hookImpl = new BoxHook(pm, address(coordImpl), address(hookExt));
        routerImpl = new BoxLaunchRouter(pm, address(coordImpl));
        receiverExt = new BoxReceiverExtension(address(coordImpl));
        receiverImpl = new BoxReceiver(pm, address(coordImpl), address(receiverExt));
        samplerImpl = new BoxPriceSampler(pm);
        royaltyImpl = new BoxRoyaltyRouter();
        swapper = new PriceLimitSwapper(pm);
        vm.roll(100);
        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Building

    function _box0Params() internal pure returns (Params memory p) {
        p.kind = BoxKind.Box0;
        p.raise = BOX0_RAISE;
        p.openDelay = 1;
        p.qStream = BoxSpecV1.Q_STREAM_BUYBACK_BURN_T;
        p.tStream = BoxSpecV1.T_STREAM_BURN_T;
        p.royalty = RoyaltyDestination.FeeHandling;
    }

    function _standardParams(address executor_) internal pure returns (Params memory p) {
        p.kind = BoxKind.Standard;
        p.raise = BOX0_RAISE;
        p.openDelay = 1;
        p.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        p.tStream = BoxSpecV1.T_STREAM_BURN_T;
        p.executor = executor_;
        p.royalty = RoyaltyDestination.FeeHandling;
    }

    function _creatorParams(address executor_, address payee) internal pure returns (Params memory p) {
        p = _standardParams(executor_);
        p.qStream = BoxSpecV1.Q_STREAM_TO_CREATOR;
        p.tStream = BoxSpecV1.T_STREAM_TO_CREATOR;
        p.payee = payee;
    }

    function _build(Params memory p) internal returns (Box memory b) {
        ++boxSeed;
        b.kind = p.kind;
        b.raise = p.raise;
        b.openDelay = p.openDelay;
        b.coord = _newCoordinator();
        b.t = new HookGasFit(BoxSpecV1.ISSUANCE, address(b.coord), _addr("vault"));
        b.curve = BoxLayoutV1.curve(p.raise, false);
        address hook_ = _flagAddress(boxSeed);
        address router_ = _addr("router");
        address receiver_ = _addr("receiver");
        b.safe = p.kind == BoxKind.Box0 ? safe : address(0);
        b.stream = p.stream;
        b.payee = p.payee;
        if (p.kind == BoxKind.Box0) {
            b.executor = address(
                new FitBuybackExecutor(
                    pm, IBurnableToken(address(b.t)), address(b.coord), hook_, receiver_, b.curve.tickUpper
                )
            );
            b.average = p.averageKind == 1 ? address(new SettablePriceAverage()) : b.executor;
        } else {
            b.executor = p.executor == address(0) ? address(new MockFitExecutor()) : p.executor;
            if (p.averageKind == 1) {
                b.average = address(new SettablePriceAverage());
            } else {
                b.average = _addr("sampler");
                vm.etch(b.average, _clone(address(samplerImpl), abi.encodePacked(hook_, address(0), address(b.t))));
            }
        }
        if (p.module != address(0)) {
            b.module = p.module;
        } else if (p.kind == BoxKind.Standard && p.realModule) {
            if (address(moduleImpl) == address(0)) moduleImpl = new BoxSwapModule(pm);
            b.module = _addr("module");
            vm.etch(b.module, _clone(address(moduleImpl), _moduleArgs(b, p, hook_, receiver_)));
        } else if (p.kind == BoxKind.Standard) {
            b.module = address(new MockSwapModule(pm, receiver_, address(0), address(b.t), hook_));
        }
        vm.etch(hook_, _clone(address(hookImpl), _hookArgs(b, p, router_, receiver_)));
        vm.etch(router_, _clone(address(routerImpl), _routerArgs(b, p, hook_)));
        vm.etch(receiver_, _clone(address(receiverImpl), _receiverArgs(b, p, hook_)));
        b.hook = BoxHook(hook_);
        b.router = BoxLaunchRouter(payable(router_));
        b.receiver = BoxReceiver(payable(receiver_));
        b.key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(b.t)), 10_000, 60, IHooks(hook_));
        b.coord.wire(address(b.t), hook_, router_, receiver_, p.kind == BoxKind.Box0 ? b.executor : address(0));
    }

    function _launch(Box memory b, Params memory p) internal {
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH + p.creatorBuy);
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH + p.creatorBuy}(p.creator, p.creatorBuy);
    }

    function _buildAndLaunch(Params memory p) internal returns (Box memory b) {
        b = _build(p);
        _launch(b, p);
    }

    function _hookArgs(Box memory b, Params memory p, address router_, address receiver_)
        internal
        view
        returns (bytes memory)
    {
        bytes memory head = abi.encodePacked(
            address(0), address(b.t), b.curve.sqrtPriceLowerX96, b.curve.sqrtPriceUpperX96, router_, uint8(p.kind)
        );
        bytes memory mid =
            abi.encodePacked(b.curve.tickLower, b.curve.tickUpper, _openAtArg(p), b.curve.liquidity, uint128(p.raise));
        return abi.encodePacked(head, mid, address(b.coord), receiver_, b.average);
    }

    /// @dev BoxLaunchRouter's 105 argument bytes (F77: no Safe for any box); openAt as `_openAtArg`.
    function _routerArgs(Box memory b, Params memory p, address hook_) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(p.kind), address(0), address(b.t), hook_, address(b.coord), b.curve.sqrtPriceLowerX96, _openAtArg(p)
        );
    }

    /// @dev The openAt clone argument: `p.openDelay` blocks of 12 s from now, or `p.openAt` as given when the delay is 0.
    function _openAtArg(Params memory p) internal view returns (uint32) {
        return p.openDelay == 0 ? p.openAt : OpenTime.inBlocks(p.openDelay);
    }

    function _receiverArgs(Box memory b, Params memory p, address hook_) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            uint8(p.kind), address(0), address(b.t), address(b.coord), hook_, b.executor, b.safe, p.stream
        );
        return
            abi.encodePacked(head, p.qStream, p.tStream, uint8(p.royalty), p.payee, b.module, p.creatorCap, p.capExcess);
    }

    /// @dev BoxSwapModule's 102 argument bytes: receiver · hook · priceAverage · q · token · qAction · tAction.
    function _moduleArgs(Box memory b, Params memory p, address hook_, address receiver_)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(receiver_, hook_, b.average, address(0), address(b.t), p.qStream, p.tStream);
    }

    /// @dev A clone of the version's (mocked) coordinator implementation: what the implementations accept.
    function _newCoordinator() internal returns (MockBoxCoordinator) {
        return MockBoxCoordinator(payable(BoxClones.create(BoxClones.initCode(address(coordImpl), ""))));
    }

    function _clone(address impl, bytes memory args) internal pure returns (bytes memory) {
        return BoxClones.runtime(impl, args);
    }

    function _royaltyRouter(Box memory b, address weth, RoyaltyDestination dest) internal returns (BoxRoyaltyRouter r) {
        address a = _addr("royalty");
        vm.etch(
            a,
            BoxClones.receivingRuntime(
                address(royaltyImpl), abi.encodePacked(address(b.coord), address(b.receiver), weth, uint8(dest))
            )
        );
        r = BoxRoyaltyRouter(payable(a));
    }

    function _addr(string memory what) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("s45.box", boxSeed, what)))));
    }

    /// @dev An address carrying exactly the hook flags and not starting with 0x91.
    function _flagAddress(uint256 seed) internal pure returns (address a) {
        uint256 h = uint256(keccak256(abi.encode("s45.hook", seed)));
        a = address(uint160((h & ~uint256(0x3FFF)) | FLAGS));
        if (uint160(a) >> 152 == 0x91) a = address(uint160(a) ^ (uint160(1) << 156));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Trading

    /// @dev Exact-input buy of `ethIn` (limit 0: the extreme price). Returns the T received and the ETH spent.
    function _buy(Box memory b, address who, uint256 ethIn, uint160 limit)
        internal
        returns (uint256 tOut, uint256 spent)
    {
        vm.deal(who, who.balance + ethIn);
        uint256 t0 = b.t.balanceOf(who);
        uint256 e0 = who.balance;
        vm.prank(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: ethIn}(b.key, true, -int256(ethIn), limit);
        tOut = b.t.balanceOf(who) - t0;
        spent = e0 - who.balance;
    }

    function _sell(Box memory b, address who, uint256 tIn) internal returns (uint256 ethOut) {
        uint256 e0 = who.balance;
        vm.startPrank(who);
        b.t.approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(b.key, false, -int256(tIn), 0);
        vm.stopPrank();
        ethOut = who.balance - e0;
    }

    /// @dev Past the open and the window.
    function _skipWindow(Box memory b) internal {
        uint256 end = b.hook.windowEndsAt();
        if (block.timestamp < end) OpenTime.to(end);
    }

    /// @dev Fills the curve exactly to P1 (closing it) with an exact-input buy limited at P1.
    function _close(Box memory b, address who) internal returns (uint256 tOut, uint256 spent) {
        (tOut, spent) = _buy(b, who, 3 * b.raise, b.curve.sqrtPriceLowerX96);
        assertTrue(b.hook.closed(), "closed");
    }

    function _closeAndGraduate(Box memory b) internal {
        _close(b, carol);
        b.coord.graduate();
    }

    function _roll(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
    }

    function _sqrtP(Box memory b) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(b.key.toId());
    }

    function _tick(Box memory b) internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(b.key.toId());
    }

    function _curveQ(Box memory b) internal view returns (uint256) {
        // Q the curve holds at the current price (removal rounding: down).
        uint160 s = _sqrtP(b);
        if (s >= b.curve.sqrtPriceUpperX96) return 0;
        uint160 lo = s < b.curve.sqrtPriceLowerX96 ? b.curve.sqrtPriceLowerX96 : s;
        return _amount0(lo, b.curve.sqrtPriceUpperX96, b.curve.liquidity);
    }

    function _amount0(uint160 a, uint160 c, uint128 l) internal pure returns (uint256) {
        return SqrtPriceMath.getAmount0Delta(a, c, l, false);
    }

    /// @dev The PoolManager's ERC-7751 wrapping of a hook revert (Hooks.callHook → CustomRevert).
    function _wrapped(address hook_, bytes4 callback, bytes memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            hook_,
            callback,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _claims(address owner, address asset) internal view returns (uint256) {
        return pm.balanceOf(owner, uint256(uint160(asset)));
    }

    receive() external payable {}
}
