// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
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
import {FitBuybackExecutor, IBurnableToken} from "../../../src/box/FitBuybackExecutor.sol";
import {BoxKind, RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {HookGasFit, PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {MockSwapModule, MockWETH, SettablePriceAverage} from "../s45/BoxS45Mocks.sol";
import {HostileModule, MockBoxCollection, MockBoxTickets, MockBoxVault, S6ClaimsMinter} from "./BoxS6Mocks.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice TEST ONLY: builds boxes the way S7's factory will (SH-S0-spikes § 2.2, kept by BoxCoordinator): this test
/// contract is the factory. It CREATE2s the coordinator clone (its arguments: the spec's values and the role nonces),
/// mines the hook salt over the hook's final init code with the coordinator as deployer, then calls `deploy` (the
/// coordinator CREATEs every other contract in order and CREATE2s the hook clone at the mined address) and `launch`.
/// The hook, launch router, receiver, price sampler, royalty router and FIT's executor are the S4+S5 implementations;
/// T runs FitTokenBase's code (S3's BoxToken is a copy); the vault, collection and tickets are stand-ins with S3's
/// coordinator-facing behaviour (`BoxS6Mocks.sol`), since S3 is another lane.
abstract contract BoxS6Base is Test {
    using StateLibrary for IPoolManager;

    uint256 internal constant BOX0_RAISE = 4_206_980_085_000_000_000;
    uint256 internal constant N_BOX0 = 4269;

    /// @notice Test nonce plan (S7 chooses its own; the coordinator reads whatever its arguments say).
    uint8 internal constant NONCE_TOKEN = 1;
    uint8 internal constant NONCE_VAULT = 2;
    uint8 internal constant NONCE_COLLECTION = 3;
    uint8 internal constant NONCE_RECEIVER = 4;
    uint8 internal constant NONCE_ROUTER = 5;
    /// Box 0: FIT's executor (its price average); others: the price sampler.
    uint8 internal constant NONCE_AVERAGE = 6;
    uint8 internal constant NONCE_TICKETS = 7;

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
        uint256 creatorBuy;
        address creator;
        uint256 n;
        bool tickets;
        bool royalty;
        /// 0 BoxReceiver clone, 1 HostileModule
        uint8 receiverMode;
        /// 0 MockBoxTickets, 1 HostileModule (only with `tickets`)
        uint8 ticketsMode;
        /// 0 the kind's real average, 1 a settable stand-in
        uint8 averageKind;
        uint256 boxId;
        /// S5.M2: a Standard box's real `BoxSwapModule` clone, CREATEd by the coordinator at the nonce after the last
        /// role (as S7's factory will name it, swap-module § 6), instead of a `MockSwapModule` deployed by the test.
        bool realModule;
    }

    struct Box {
        BoxKind kind;
        uint256 raise;
        uint256 openDelay;
        BoxCoordinator coord;
        HookGasFit t;
        BoxHook hook;
        BoxLaunchRouter router;
        address receiver;
        MockBoxVault vault;
        MockBoxCollection collection;
        address tickets;
        address royalty;
        address executor;
        address average;
        /// The swap module (S5.M1): a `MockSwapModule` for every Standard box unless `realModule` (S5.M2: the coordinator
        /// CREATEs the real clone); box 0: none.
        address module;
        BoxLayoutV1.Curve curve;
        PoolKey key;
        bytes32 hookSalt;
        uint256 creatorBuy;
    }

    IPoolManager internal pm;
    BoxCoordinator internal coordImpl;
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
    S6ClaimsMinter internal minter;
    MockWETH internal weth;
    address internal safe = makeAddr("s6.safe");
    address internal randomness = makeAddr("s6.drand");
    address internal alice = makeAddr("s6.alice");
    address internal bob = makeAddr("s6.bob");
    address internal carol = makeAddr("s6.carol");
    address internal keeper = makeAddr("s6.keeper");
    address internal searcher = makeAddr("s6.searcher");
    uint256 internal boxSeed;

    function _setUpWorld() internal {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("s6.pmOwner"))));
        coordImpl = new BoxCoordinator(pm, address(this));
        hookExt = new BoxHookExtension(pm);
        // Every implementation names the coordinator's: only its clones may initialise them (BC-100).
        hookImpl = new BoxHook(pm, address(coordImpl), address(hookExt));
        routerImpl = new BoxLaunchRouter(pm, address(coordImpl));
        receiverExt = new BoxReceiverExtension(address(coordImpl));
        receiverImpl = new BoxReceiver(pm, address(coordImpl), address(receiverExt));
        samplerImpl = new BoxPriceSampler(pm);
        royaltyImpl = new BoxRoyaltyRouter();
        swapper = new PriceLimitSwapper(pm);
        minter = new S6ClaimsMinter(pm);
        weth = new MockWETH();
        vm.roll(100);
        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Parameters

    function _box0Params() internal pure returns (Params memory p) {
        p.kind = BoxKind.Box0;
        p.raise = BOX0_RAISE;
        p.openDelay = 1;
        p.qStream = BoxSpecV1.Q_STREAM_BUYBACK_BURN_T;
        p.tStream = BoxSpecV1.T_STREAM_BURN_T;
        p.n = N_BOX0;
        p.tickets = true;
        p.royalty = true;
    }

    function _standardParams() internal pure returns (Params memory p) {
        p.kind = BoxKind.Standard;
        p.raise = BOX0_RAISE;
        p.openDelay = 1;
        p.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        p.tStream = BoxSpecV1.T_STREAM_BURN_T;
        p.n = 69;
        p.boxId = 1;
    }

    function _creatorParams(address payee) internal pure returns (Params memory p) {
        p = _standardParams();
        p.qStream = BoxSpecV1.Q_STREAM_TO_CREATOR;
        p.tStream = BoxSpecV1.T_STREAM_TO_CREATOR;
        p.payee = payee;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Building (the factory's part)

    function _buildAndLaunch(Params memory p) internal returns (Box memory b) {
        b = _build(p);
        _launch(b);
    }

    function _launch(Box memory b) internal {
        uint256 value = BoxSpecV1.BOOTSTRAP_ETH + b.creatorBuy;
        vm.deal(address(this), address(this).balance + value);
        b.coord.launch{value: value}();
    }

    /// @notice What the factory computes before the transaction: the coordinator's init code and salt, every code the
    /// coordinator will CREATE, and the hook's init code (its salt mined into `b.hookSalt`).
    struct Prepared {
        bytes coordInit;
        bytes32 coordSalt;
        bytes[] codes;
        bytes hookInit;
    }

    function _build(Params memory p) internal returns (Box memory b) {
        Prepared memory x;
        (b, x) = _prepare(p);
        _createCoordinator(b, x);
        address h = b.coord.deploy(x.codes, x.hookInit, b.hookSalt, p.boxId);
        require(h == address(b.hook), "hook address");
    }

    function _prepare(Params memory p) internal returns (Box memory b, Prepared memory x) {
        ++boxSeed;
        b.kind = p.kind;
        b.raise = p.raise;
        b.openDelay = p.openDelay;
        b.creatorBuy = p.creatorBuy;
        b.curve = BoxLayoutV1.curve(p.raise, false);
        address executorArg;
        // Other boxes: FIT's executor is an outside address, here a HostileModule in its well-behaved mode (a test may
        // switch it); box 0: FIT's executor, created by the coordinator at NONCE_AVERAGE.
        if (p.kind != BoxKind.Box0) executorArg = address(new HostileModule());
        x.coordInit = BoxClones.initCode(BoxClones.runtime(address(coordImpl), _coordArgs(p, executorArg)));
        x.coordSalt = keccak256(abi.encode("s6.coordinator", p.creator, boxSeed));
        address c = vm.computeCreate2Address(x.coordSalt, keccak256(x.coordInit), address(this));
        _predict(b, p, c, executorArg);
        x.hookInit = BoxClones.initCode(BoxClones.runtime(address(hookImpl), _hookArgs(b, p, c)));
        b.hookSalt = _mineHookSalt(c, keccak256(x.hookInit));
        address hook_ = vm.computeCreate2Address(b.hookSalt, keccak256(x.hookInit), c);
        b.hook = BoxHook(hook_);
        b.key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(b.t)), 10_000, 60, IHooks(hook_));
        if (p.kind == BoxKind.Standard && p.realModule) {
            if (address(moduleImpl) == address(0)) moduleImpl = new BoxSwapModule(pm);
            b.module = vm.computeCreateAddress(c, _moduleNonce(p));
        } else if (p.kind == BoxKind.Standard) {
            b.module = address(new MockSwapModule(pm, b.receiver, address(0), address(b.t), hook_));
        }
        x.codes = _codes(b, p, c);
        b.coord = BoxCoordinator(c);
    }

    /// @dev The factory's CREATE2 of the coordinator clone.
    function _createCoordinator(Box memory b, Prepared memory x) internal {
        bytes memory init = x.coordInit;
        bytes32 salt = x.coordSalt;
        address created;
        assembly {
            created := create2(0, add(init, 0x20), mload(init), salt)
        }
        require(created == address(b.coord), "coordinator address");
    }

    function _coordArgs(Params memory p, address executorArg) internal view returns (bytes memory) {
        uint8 nTickets = p.tickets ? NONCE_TICKETS : 0;
        uint8 nRoyalty = p.royalty ? (p.tickets ? NONCE_TICKETS + 1 : NONCE_TICKETS) : 0;
        uint8 nExecutor = p.kind == BoxKind.Box0 ? NONCE_AVERAGE : 0;
        bytes memory head = abi.encodePacked(
            uint8(p.kind),
            address(0),
            uint128(p.raise),
            uint128(p.creatorBuy),
            p.creator,
            keccak256(abi.encode("s6.spec", boxSeed)),
            executorArg,
            randomness
        );
        return abi.encodePacked(
            head,
            NONCE_TOKEN,
            NONCE_VAULT,
            NONCE_COLLECTION,
            NONCE_RECEIVER,
            NONCE_ROUTER,
            nTickets,
            nRoyalty,
            uint8(0),
            nExecutor
        );
    }

    /// @dev Every created address from the coordinator's address and the nonce plan (T is needed for the hook's
    /// arguments; the rest are typed once the coordinator CREATEs them).
    function _predict(Box memory b, Params memory p, address c, address executorArg) internal pure {
        b.t = HookGasFit(vm.computeCreateAddress(c, NONCE_TOKEN));
        b.vault = MockBoxVault(vm.computeCreateAddress(c, NONCE_VAULT));
        b.collection = MockBoxCollection(vm.computeCreateAddress(c, NONCE_COLLECTION));
        b.receiver = vm.computeCreateAddress(c, NONCE_RECEIVER);
        b.router = BoxLaunchRouter(payable(vm.computeCreateAddress(c, NONCE_ROUTER)));
        b.average = vm.computeCreateAddress(c, NONCE_AVERAGE);
        b.executor = p.kind == BoxKind.Box0 ? b.average : executorArg;
        if (p.tickets) b.tickets = vm.computeCreateAddress(c, NONCE_TICKETS);
        if (p.royalty) b.royalty = vm.computeCreateAddress(c, p.tickets ? NONCE_TICKETS + 1 : NONCE_TICKETS);
    }

    /// @dev The real module's nonce: right after the last code the roles use.
    function _moduleNonce(Params memory p) internal pure returns (uint8) {
        return NONCE_AVERAGE + (p.tickets ? 1 : 0) + (p.royalty ? 1 : 0) + 1;
    }

    function _codes(Box memory b, Params memory p, address c) internal view returns (bytes[] memory codes) {
        bool real = p.kind == BoxKind.Standard && p.realModule;
        codes = new bytes[](NONCE_AVERAGE + (p.tickets ? 1 : 0) + (p.royalty ? 1 : 0) + (real ? 1 : 0));
        codes[0] = abi.encodePacked(type(HookGasFit).creationCode, abi.encode(BoxSpecV1.ISSUANCE, c, address(b.vault)));
        codes[1] = abi.encodePacked(type(MockBoxVault).creationCode, abi.encode(c, address(b.collection), p.n));
        codes[2] = abi.encodePacked(type(MockBoxCollection).creationCode, abi.encode(c));
        codes[3] = p.receiverMode == 1
            ? type(HostileModule).creationCode
            : BoxClones.initCode(BoxClones.runtime(address(receiverImpl), _receiverArgs(b, p, c)));
        codes[4] = BoxClones.initCode(BoxClones.runtime(address(routerImpl), _routerArgs(b, p, c)));
        if (p.kind == BoxKind.Box0) {
            codes[5] = p.averageKind == 1
                ? type(SettablePriceAverage).creationCode
                : abi.encodePacked(
                    type(FitBuybackExecutor).creationCode,
                    abi.encode(pm, IBurnableToken(address(b.t)), c, address(b.hook), b.receiver, b.curve.tickUpper)
                );
        } else {
            codes[5] = p.averageKind == 1
                ? type(SettablePriceAverage).creationCode
                : BoxClones.initCode(
                    BoxClones.runtime(address(samplerImpl), abi.encodePacked(address(b.hook), address(0), address(b.t)))
                );
        }
        uint256 i = NONCE_AVERAGE;
        if (p.tickets) {
            codes[i++] = p.ticketsMode == 1
                ? type(HostileModule).creationCode
                : abi.encodePacked(type(MockBoxTickets).creationCode, abi.encode(c, address(b.vault)));
        }
        if (p.royalty) {
            codes[i++] = BoxClones.initCode(
                BoxClones.receivingRuntime(
                    address(royaltyImpl),
                    abi.encodePacked(c, b.receiver, address(weth), uint8(RoyaltyDestination.FeeHandling))
                )
            );
        }
        if (real) {
            // BoxSwapModule's 102 argument bytes: receiver · hook · priceAverage · q · token · qAction · tAction.
            codes[i] = BoxClones.initCode(
                BoxClones.runtime(
                    address(moduleImpl),
                    abi.encodePacked(
                        b.receiver, address(b.hook), b.average, address(0), address(b.t), p.qStream, p.tStream
                    )
                )
            );
        }
    }

    function _hookArgs(Box memory b, Params memory p, address c) internal view returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            address(0),
            address(b.t),
            b.curve.sqrtPriceLowerX96,
            b.curve.sqrtPriceUpperX96,
            address(b.router),
            uint8(p.kind)
        );
        bytes memory mid =
            abi.encodePacked(b.curve.tickLower, b.curve.tickUpper, _openAtArg(p), b.curve.liquidity, uint128(p.raise));
        return abi.encodePacked(head, mid, c, b.receiver, b.average);
    }

    /// @dev BoxLaunchRouter's 105 argument bytes (F77: no Safe for any box); openAt as `_openAtArg`.
    function _routerArgs(Box memory b, Params memory p, address c) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(p.kind), address(0), address(b.t), address(b.hook), c, b.curve.sqrtPriceLowerX96, _openAtArg(p)
        );
    }

    /// @dev The openAt clone argument: `p.openDelay` blocks of 12 s from now, or `p.openAt` as given when the delay is 0.
    function _openAtArg(Params memory p) internal view returns (uint32) {
        return p.openDelay == 0 ? p.openAt : OpenTime.inBlocks(p.openDelay);
    }

    function _receiverArgs(Box memory b, Params memory p, address c) internal view returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            uint8(p.kind),
            address(0),
            address(b.t),
            c,
            address(b.hook),
            b.executor,
            p.kind == BoxKind.Box0 ? safe : address(0),
            address(0)
        );
        // S5.M3: no creator-fee cap (add-on 5) in S6's boxes.
        return abi.encodePacked(
            head, p.qStream, p.tStream, uint8(RoyaltyDestination.FeeHandling), p.payee, b.module, uint128(0), uint8(0)
        );
    }

    /// @dev A CREATE2 salt putting the hook clone at an address with exactly the flags 0x2AE0 in its low 14 bits and
    /// no 0x91 prefix (S0's mined clone; about 16,384 tries).
    function _mineHookSalt(address deployer, bytes32 initHash) internal pure returns (bytes32 salt) {
        assembly {
            let p := mload(0x40)
            mstore8(p, 0xff)
            mstore(add(p, 0x01), shl(96, deployer))
            mstore(add(p, 0x35), initHash)
            for { let s := 0 } 1 { s := add(s, 1) } {
                mstore(add(p, 0x15), s)
                let a := and(keccak256(p, 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
                if and(eq(and(a, 0x3fff), 0x2ae0), iszero(eq(shr(152, a), 0x91))) {
                    salt := s
                    break
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Trading

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

    function _skipWindow(Box memory b) internal {
        uint256 end = b.hook.windowEndsAt();
        if (block.timestamp < end) OpenTime.to(end);
    }

    /// @dev Fills the curve exactly to P1 (closing it) with an exact-input buy limited at P1.
    function _close(Box memory b, address who) internal returns (uint256 tOut, uint256 spent) {
        (tOut, spent) = _buy(b, who, 3 * b.raise, b.curve.sqrtPriceLowerX96);
        assertTrue(b.hook.closed(), "closed");
    }

    /// @dev Buys until the curve holds `fillPpm` / 10^6 of the raise.
    function _fillTo(Box memory b, uint256 fillPpm) internal {
        uint256 target = b.raise * fillPpm / 1e6;
        uint256 held = _curveQ(b);
        if (target <= held) return;
        uint160 limit = SqrtPriceMath.getNextSqrtPriceFromInput(_sqrtP(b), b.curve.liquidity, target - held, true);
        _buy(b, alice, 2 * b.raise, limit);
    }

    function _roll(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
    }

    function _sqrtP(Box memory b) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(b.key.toId());
    }

    function _curveQ(Box memory b) internal view returns (uint256) {
        uint160 s = _sqrtP(b);
        if (s >= b.curve.sqrtPriceUpperX96) return 0;
        uint160 lo = s < b.curve.sqrtPriceLowerX96 ? b.curve.sqrtPriceLowerX96 : s;
        return SqrtPriceMath.getAmount0Delta(lo, b.curve.sqrtPriceUpperX96, b.curve.liquidity, false);
    }

    function _claims(address owner, address asset) internal view returns (uint256) {
        return pm.balanceOf(owner, uint256(uint160(asset)));
    }

    /// @dev The Q fees the curve position has accrued so far (fee growth inside its range times its liquidity).
    function _curveQFeesAccrued(Box memory b) internal view returns (uint256) {
        (uint256 inside0,) = pm.getFeeGrowthInside(b.key.toId(), b.curve.tickLower, b.curve.tickUpper);
        return FullMath.mulDiv(inside0, b.curve.liquidity, 1 << 128);
    }

    function _recv(Box memory b) internal pure returns (BoxReceiver) {
        return BoxReceiver(payable(b.receiver));
    }

    receive() external payable {}
}
