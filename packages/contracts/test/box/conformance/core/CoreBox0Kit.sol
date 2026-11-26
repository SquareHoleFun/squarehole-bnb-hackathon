// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreV1Deployment} from "../../../../script/lib/CoreV1Deployment.sol";
import {PriceLimitSwapper} from "../../../research/hookgas/HookGasKit.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {MockWETH} from "../../s45/BoxS45Mocks.sol";
import {OpenTime} from "../../utils/OpenTime.sol";

/// @notice Every address of a box built from the core v1 contracts (what the registry's `BoxCreated` row carries), plus
/// the version-wide ones the box was built against.
struct CoreBoxAddresses {
    address coordinator;
    address token;
    address collection;
    address vault;
    address hook;
    address receiver;
    address launchRouter;
    /// The tickets add-on (placeholders, F55); zero without it.
    address tickets;
    /// The royalty router (royalties add-on); zero without it.
    address royaltyRouter;
    /// FIT's buy-and-burn executor (box 0 creates it, BC-064).
    address executor;
    /// The per-item stream (add-on 2, S8); zero without it.
    address itemStream;
    /// The metadata table's data contract (BoxData).
    address table;
    address poolManager;
    address randomness;
    address platform;
    address weth;
    /// The hook's mined CREATE2 salt (deployer: the coordinator).
    bytes32 hookSalt;
}

/// @notice The version: one deployment of each core v1 implementation, the planner, the factory and its registry.
struct CoreImpls {
    address coordinator;
    address hook;
    address hookExtension;
    address launchRouter;
    address receiver;
    /// S5.M1: the receiver's fixed cold half (DELEGATECALL target, as the hook's extension).
    address receiverExtension;
    address collection;
    address vault;
    address tickets;
    address royaltyRouter;
    /// S8: the per-item stream (add-on 2).
    address itemStream;
    address planner;
    address factory;
    address registry;
}

/// @title CoreBox0Kit
/// @notice TEST ONLY. Box 0 created by **factory v1** (S7), replacing SH-core-wave-2's `CoreBox0Builder` stand-in: the
/// world (chain id 1, the PoolManager from the pinned source, S9's DrandSource at its pin and box 0's BoxBackedSource at
/// its pin (F143; `source`, the box's; rounds are posted on `drand`), WETH, a swapper), the version
/// deployed by `CoreV1Deployment` (the steps `script/DeployCoreV1.s.sol` sends: the coordinator implementation first,
/// the others naming it, the planner, the factory and its registry), then box 0 through `BoxFactoryV1.createBox` with
/// a mined hook salt (since the S7 × S8 integration with its per-item stream, which the kit's addresses carry). The phase drivers (`toWindow`, `toBonding`, `toClosed`, `toGraduated`, `toGraduatedBusy`) are
/// the builder's, unchanged, so every core harness check now runs on the factory-built box 0.
///
/// **Build profiles (F78).** Under FOUNDRY_PROFILE=rehearsal the version is the rehearsal build: its world is chain id
/// 11155111 (its constructors refuse chain id 1; the DrandSource pin is the same address and code there) and every ETH
/// amount the drivers trade or pay is scaled like the build's raise (`eth()`: × 1/10), so each phase is reached the
/// same way in a curve ten times thinner. In the mainnet build `eth(x)` is `x` and the world is chain id 1, as before.
contract CoreBox0Kit is Test, CoreV1Deployment {
    IPoolManager public pm;
    /// Box 0's source (the pinned BoxBackedSource, F143): requests, words and the backup.
    BoxBackedSource public source;
    /// The pinned DrandSource the backed source names: rounds are posted here.
    DrandSource public drand;
    MockWETH public weth;
    PriceLimitSwapper public swapper;
    BoxFactoryV1 public factory;
    CoreImpls internal _impls;
    CoreBoxAddresses internal _a;
    BoxLayoutV1.Curve internal _curve;
    PoolKey internal _key;
    /// @dev The prepared spec, ABI-encoded (a struct with a struct array cannot be copied to storage).
    bytes internal _specEncoded;
    uint256 internal _raise;
    /// @notice The creation block and its time (F80: BC-023 checks the open against it), in one slot, so the gas table's
    /// state count over `create()` stays what it was before the time was recorded.
    uint128 public creationBlock;
    uint128 public creationTime;
    /// @notice Gas of the createBox call in this test's EVM (the caller's frame).
    uint256 public creationGas;
    /// @notice The graduation call's gas and its caller (toGraduated).
    uint256 public graduateGas;
    address public graduator;
    /// @notice `PokeFailed` events of the graduation call (toGraduated).
    uint256 public pokeFailures;
    bytes32 internal _hookSalt;

    address public alice = makeAddr("core.alice");
    address public bob = makeAddr("core.bob");
    address public carol = makeAddr("core.carol");
    address public keeper = makeAddr("core.keeper");

    // ------------------------------------------------------------------------------------------------ the version

    /// @notice Chain id 1 (so the pinned source is this chain's; 11155111 for the rehearsal build, which refuses chain
    /// id 1), the PoolManager from the pinned source, WETH, a swapper, then the version through `CoreV1Deployment` with
    /// this contract as the box-0 creator and the platform Safe of the spec (`BoxSpecV1.PLATFORM_SAFE_MAINNET`).
    function setUpWorld() external {
        vm.chainId(worldChainId());
        vm.roll(100);
        vm.warp(1_800_000_000);
        _setUpVersion(
            IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("core.pmOwner")))),
            address(new MockWETH())
        );
    }

    /// @notice S5.M4: the version on a fork (mainnet or Sepolia, read only; nothing is broadcast): the chain's own
    /// PoolManager and WETH at the fork block, its block and time unchanged, the pinned DrandSource put at its pin by the
    /// chain's real CREATE2 deployer (PinnedDrandSource).
    function setUpWorldOn(IPoolManager pm_, address weth_) external {
        require(address(pm_).code.length != 0 && weth_.code.length != 0, "kit: the fork's PoolManager and WETH");
        _setUpVersion(pm_, weth_);
    }

    function _setUpVersion(IPoolManager pm_, address weth_) internal {
        pm = pm_;
        weth = MockWETH(weth_);
        swapper = new PriceLimitSwapper(pm);
        CoreV1Version memory v = _deployCoreV1(
            CoreV1Config({
                deployer: address(this),
                callsTakeNonce: false,
                poolManager: pm,
                weth: address(weth),
                platformSafe: BoxSpecV1.PLATFORM_SAFE_MAINNET,
                box0Creator: address(this)
            })
        );
        source = BoxBackedSource(v.randomness);
        drand = DrandSource(v.drand);
        factory = BoxFactoryV1(v.factory);
        _impls = CoreImpls({
            coordinator: v.impls.coordinator,
            hook: v.impls.hook,
            hookExtension: v.hookExtension,
            launchRouter: v.impls.launchRouter,
            receiver: v.impls.receiver,
            receiverExtension: v.receiverExtension,
            collection: v.impls.collection,
            vault: v.impls.vault,
            tickets: v.impls.tickets,
            royaltyRouter: v.impls.royaltyRouter,
            itemStream: v.impls.itemStream,
            planner: v.planner,
            factory: v.factory,
            registry: v.registry
        });
    }

    /// @dev Tests deploy the source with PinnedDrandSource (it puts the canonical deployer's code in place when the
    /// test EVM lacks it), the same CREATE2 the script sends.
    function _deployDrandSource(address pinned) internal override {
        require(address(PinnedDrandSource.deploy(vm)) == pinned, "kit: the pinned source");
    }

    /// @dev Box 0's source (F143) through the canonical CREATE2 deployer, the same way.
    function _deployBackedSource(address pinned) internal override {
        require(address(PinnedBackedSource.deploy(vm)) == pinned, "kit: the pinned backed source");
    }

    /// @notice The chain id of the local world: 1, or Sepolia's for a build that refuses chain id 1 (F78).
    function worldChainId() public pure returns (uint256) {
        return BoxBuildV1.REFUSED_CHAIN_ID == 1 ? 11_155_111 : 1;
    }

    /// @notice `mainnetWei` at this build's scale (F78): unchanged in the mainnet build, 1/10 in the rehearsal build.
    function eth(uint256 mainnetWei) public pure returns (uint256) {
        return mainnetWei * BoxBuildV1.SCALE_NUMERATOR / BoxBuildV1.SCALE_DENOMINATOR;
    }

    // ------------------------------------------------------------------------------------------------ creation

    /// @notice prepare + create: box 0 from `s`.
    function build(BoxSpecV1.BoxSpec memory s) external {
        prepare(s);
        create();
    }

    /// @notice What is known before the transaction: box 0's addresses (fixed at the factory's deployment), the hook's
    /// mined salt over its final init code, the pool key and the curve.
    function prepare(BoxSpecV1.BoxSpec memory s) public {
        _specEncoded = abi.encode(s);
        _raise = s.raise;
        _curve = BoxLayoutV1.curve(s.raise, false);
        IBoxFactoryV1.Box0Addresses memory b = factory.box0Addresses();
        _hookSalt = _mineHookSalt(b.coordinator, factory.hookInitCodeHash(s.openAt));
        _a.coordinator = b.coordinator;
        _a.table = b.table;
        _a.token = b.token;
        _a.vault = b.vault;
        _a.collection = b.collection;
        _a.receiver = b.receiver;
        _a.launchRouter = b.launchRouter;
        _a.executor = b.executor;
        _a.tickets = b.tickets;
        _a.itemStream = b.itemStream;
        _a.royaltyRouter = _hasAddOn(s, BoxSpecV1.ADD_ON_ROYALTIES) ? b.royaltyRouter : address(0);
        _a.hook = factory.predictHook(s.openAt, _hookSalt);
        _a.hookSalt = _hookSalt;
        _a.poolManager = address(pm);
        _a.randomness = address(source);
        _a.platform = factory.platformSafe();
        _a.weth = address(weth);
        _key = PoolKey(Currency.wrap(address(0)), Currency.wrap(_a.token), BoxSpecV1.LP_FEE, 60, IHooks(_a.hook));
    }

    /// @notice The creation transaction: `createBox` with the bootstrap and FIT's executor's creation code, measured.
    function create() public {
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH);
        // casting to 'uint128' is safe because block numbers and times stay far below 2^128
        // forge-lint: disable-next-line(unsafe-typecast)
        creationBlock = uint128(block.number);
        // forge-lint: disable-next-line(unsafe-typecast)
        creationTime = uint128(block.timestamp);
        bytes memory executorCode = _executorCode();
        BoxSpecV1.BoxSpec memory s = abi.decode(_specEncoded, (BoxSpecV1.BoxSpec));
        uint256 g0 = gasleft();
        (, address coordinator, address hook) =
            factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, _hookSalt, executorCode);
        creationGas = g0 - gasleft();
        require(coordinator == _a.coordinator && hook == _a.hook, "kit: the predicted addresses");
    }

    function _executorCode() internal pure returns (bytes memory) {
        return type(FitBuybackExecutor).creationCode;
    }

    function _hasAddOn(BoxSpecV1.BoxSpec memory s, uint16 id) internal pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------------------------------------ phases

    /// @notice Three blocks into the launch window, after one taxed launch-router buy (its tax left unswept).
    function toWindow() public {
        OpenTime.toStep(BoxHook(_a.hook).openAt(), 3);
        uint256 qIn = eth(0.02 ether);
        vm.deal(alice, alice.balance + qIn);
        vm.prank(alice);
        BoxLaunchRouter(payable(_a.launchRouter)).buy{value: qIn}(qIn, 1, alice, block.timestamp);
    }

    /// @notice On the curve after the window: buys and a sell through the PoolManager directly, a placeholder taken
    /// (F36 a), and one fee batch collected (D2; the D6 reserve topped up first).
    function toBonding() public {
        toWindow();
        OpenTime.to(BoxHook(_a.hook).windowEndsAt());
        uint256 bought = _buy(alice, eth(0.6 ether), 0);
        _buy(bob, eth(0.4 ether), 0);
        _sell(alice, bought / 3);
        vm.startPrank(alice);
        BoxToken(_a.token).approve(_a.tickets, type(uint256).max);
        BoxTickets(_a.tickets).take(1, type(uint256).max, block.timestamp);
        vm.stopPrank();
        _roll(12);
        BoxReceiver(payable(_a.receiver)).collect(keeper);
        _roll(12);
    }

    /// @notice The curve filled to exactly P1 by an exact-input buy limited at P1 (D1: closed in its own afterSwap);
    /// nobody has called graduate() yet.
    function toClosed() public {
        toBonding();
        _buy(carol, 3 * _raise, _curve.sqrtPriceLowerX96);
        require(BoxHook(_a.hook).closed(), "kit: closed");
    }

    /// @notice graduate() by a keeper right after the close, then life on the graduated pool: a buy, a sell, a fee
    /// batch, the reward claimed, the launch tax swept into box 0's own pool (F77) and a royalty paid and flushed.
    function toGraduated() public {
        toClosed();
        graduator = keeper;
        vm.recordLogs();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        BoxCoordinator(_a.coordinator).graduate();
        graduateGas = g0 - gasleft();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == _a.coordinator && logs[i].topics[0] == IBoxCoordinator.PokeFailed.selector) {
                ++pokeFailures;
            }
        }
        _roll(1);
        uint256 bought = _buy(bob, eth(1 ether), 0);
        _sell(bob, bought / 2);
        _roll(12);
        BoxReceiver(payable(_a.receiver)).collect(keeper);
        vm.prank(keeper);
        BoxCoordinator(_a.coordinator).claimReward(keeper);
        BoxLaunchRouter(payable(_a.launchRouter)).sweep();
        if (_a.royaltyRouter != address(0)) {
            vm.deal(address(this), address(this).balance + eth(0.1 ether));
            (bool ok,) = _a.royaltyRouter.call{value: eth(0.1 ether)}("");
            require(ok, "kit: royalty paid");
            BoxRoyaltyRouter(payable(_a.royaltyRouter)).flush();
        }
        _roll(12);
    }

    /// @notice `toGraduated`, then a busy life (SH-core-wave-2 § Review): a stranger's 1,000-wei `fundDepth()` gift, 300
    /// ETH of fees through the ETH intake in epoch 0 (the Safe's 32 ETH reached, the rest into depth), 30 days on, the
    /// same again in epoch 1 (the rehearsal build: 30 ETH against its 3.2 ETH cap).
    function toGraduatedBusy() public {
        toGraduated();
        address stranger = makeAddr("core.stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        IBoxReceiver(_a.receiver).fundDepth{value: 1_000}();
        vm.deal(address(this), address(this).balance + eth(600 ether));
        IBoxReceiver(_a.receiver).fundFees{value: eth(300 ether)}();
        vm.warp(block.timestamp + BoxSpecV1.PLATFORM_EPOCH_SECONDS);
        _roll(1);
        IBoxReceiver(_a.receiver).fundFees{value: eth(300 ether)}();
        _roll(12);
    }

    // ------------------------------------------------------------------------------------------------ reads

    function addresses() external view returns (CoreBoxAddresses memory) {
        return _a;
    }

    function impls() external view returns (CoreImpls memory) {
        return _impls;
    }

    function curve() external view returns (BoxLayoutV1.Curve memory) {
        return _curve;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    function hookSalt() external view returns (bytes32) {
        return _hookSalt;
    }

    function spec() public view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(_specEncoded, (BoxSpecV1.BoxSpec));
    }

    /// @notice The codes the coordinator CREATEs for the prepared spec, as `createBox` completes them (T's and FIT's
    /// executor's creation code prepended to the planner's arguments).
    function codes() external view returns (bytes[] memory c) {
        BoxFactoryV1Planner.Plan memory p = BoxFactoryV1Planner(_impls.planner)
            .plan(spec(), factory.version(), address(this), _hookSalt, keccak256(_specEncoded));
        c = p.codes;
        c[1] = bytes.concat(type(BoxToken).creationCode, c[1]);
        c[6] = bytes.concat(_executorCode(), c[6]);
    }

    /// @notice The version's deployment steps (`CoreV1Deployment`), for the gas tables.
    function steps() external view returns (CoreV1Step[] memory) {
        return _coreV1Steps;
    }

    // ------------------------------------------------------------------------------------------------ trading

    /// @notice An exact-input buy of `ethIn` through the PoolManager directly (`limit` 0: the extreme price).
    function buy(address who, uint256 ethIn, uint160 limit) external returns (uint256 tOut) {
        return _buy(who, ethIn, limit);
    }

    function sell(address who, uint256 tIn) external returns (uint256 ethOut) {
        return _sell(who, tIn);
    }

    function _buy(address who, uint256 ethIn, uint160 limit) internal returns (uint256 tOut) {
        vm.deal(who, who.balance + ethIn);
        uint256 t0 = BoxToken(_a.token).balanceOf(who);
        vm.prank(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: ethIn}(_key, true, -int256(ethIn), limit);
        tOut = BoxToken(_a.token).balanceOf(who) - t0;
    }

    function _sell(address who, uint256 tIn) internal returns (uint256 ethOut) {
        uint256 e0 = who.balance;
        vm.startPrank(who);
        BoxToken(_a.token).approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(_key, false, -int256(tIn), 0);
        vm.stopPrank();
        ethOut = who.balance - e0;
    }

    function _roll(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
    }

    function _rollTo(uint256 blockNumber) internal {
        if (block.number < blockNumber) _roll(blockNumber - block.number);
    }

    /// @notice The receiver's ETH intake, for checks that fund it.
    function fundFees() external payable {
        IBoxReceiver(_a.receiver).fundFees{value: msg.value}();
    }

    receive() external payable {}
}
