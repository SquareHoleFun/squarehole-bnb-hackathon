// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FeeCollector} from "../../../src/FeeCollector.sol";
import {RewardLedger} from "../../../src/RewardLedger.sol";
import {SquareHoleClaimConverter} from "../../../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../../../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../../src/SquareHoleRegistry.sol";
import {SquareHoleToken} from "../../../src/SquareHoleToken.sol";
import {IRewardLedger} from "../../../src/interfaces/IRewardLedger.sol";
import {CollectionTokenDeployer, CoreDeployer, FungibleTokenDeployer} from "../../../src/deployers/LaunchDeployers.sol";
import {ITestT} from "../Fixture.sol";
import {MockERC20} from "../MockTokens.sol";
import {MockUSDT} from "../MockUSDT.sol";
import {StepRouter} from "./Routers.sol";

/// @notice Deploys the whole Square Hole system against a real Uniswap v4 PoolManager built from the pinned source
/// (local tests only): registry, claim converter, the hook at a mined CREATE2 address with exactly its permission
/// bits, the three per-launch deployers and the launcher, plus quote assets (WETH-like 18 decimals, USDC-like 6
/// decimals, USDT-like 6 decimals with no return values) and their launch templates. Helpers launch pairs and
/// trade through test routers.
abstract contract V4Fixture is Test {
    using StateLibrary for IPoolManager;

    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;
    uint256 internal constant Q128 = 1 << 128;
    /// @dev `maxQIn` / `maxQ` meaning "the whole entitlement" (converter).
    uint256 internal constant ALL = type(uint256).max;
    /// @dev beforeInitialize | beforeAddLiquidity | beforeRemoveLiquidity | afterSwap | beforeDonate (checked against
    /// SquareHoleHook.REQUIRED_FLAGS in the hook tests).
    uint160 internal constant HOOK_FLAGS = 0x2A60;

    /// @dev Template shape used for every test quote: tick spacing 60, range 69,060 ticks (price ×~998 across the
    /// supply). Testnet placeholders, not approved economics (G05).
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant RANGE_TICKS = 69_060;
    uint256 internal constant WETH_START_FDV = 1e18; // 1 WETH for the whole supply at launch
    uint256 internal constant USD_START_FDV = 5_000e6; // 5,000 USDC/USDT
    /// @dev NFT unit-value floors (ADR-0011 §4): N ≤ 10,000 on every test template, so a reference buy of
    /// 1,000 × the floor (0.1 WETH / 500 USDC) delivers at most 1,000 NFTs at the start price.
    uint256 internal constant WETH_MIN_UNIT_VALUE = 1e14;
    uint256 internal constant USD_MIN_UNIT_VALUE = 0.5e6;

    IPoolManager internal pm;
    PoolSwapTest internal swapRouter;
    StepRouter internal stepRouter;

    SquareHoleRegistry internal registry;
    SquareHoleClaimConverter internal converter;
    SquareHoleHook internal hook;
    CoreDeployer internal coreDeployer;
    CollectionTokenDeployer internal collectionDeployer;
    FungibleTokenDeployer internal fungibleDeployer;
    SquareHoleLauncher internal launcher;

    MockERC20 internal weth;
    MockERC20 internal usdc;
    MockUSDT internal usdt;
    uint32 internal wethTemplate;
    uint32 internal usdcTemplate;
    uint32 internal usdtTemplate;
    uint256 internal hookMiningIterations;

    address internal admin = makeAddr("registryAdmin");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    /// @notice One launched pair, read back from the registry.
    struct Launch {
        bytes32 pairId;
        SquareHoleRegistry.PairRecord r;
        PoolKey key;
        PoolId id;
        bool tIsCurrency0;
        ITestT t;
        RewardLedger ledger;
        FeeCollector collector;
    }

    function _deploySystem() internal {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("pmOwner"))));
        swapRouter = new PoolSwapTest(pm);
        weth = new MockERC20("Wrapped Ether (test)", "WETH");
        usdc = new MockERC20("USD Coin (test)", "USDC");
        usdc.setDecimals(6);
        _deploySquareHole();
    }

    /// @dev On a fork: the canonical PoolManager, PoolSwapTest, WETH9 and USDC of that chain; Square Hole deployed
    /// locally on top (never broadcast).
    function _deploySystemOnFork(address pm_, address swapRouter_, address weth_, address usdc_) internal {
        pm = IPoolManager(pm_);
        swapRouter = PoolSwapTest(swapRouter_);
        weth = MockERC20(weth_);
        usdc = MockERC20(usdc_);
        _deploySquareHole();
    }

    function _deploySquareHole() internal {
        stepRouter = new StepRouter(pm);
        usdt = new MockUSDT();

        uint256 nonce = vm.getNonce(address(this));
        address predictedLauncher = vm.computeCreateAddress(address(this), nonce + 6);
        registry = new SquareHoleRegistry(admin, predictedLauncher); // nonce
        converter = new SquareHoleClaimConverter(pm, registry); // nonce + 1
        bytes memory hookInit = abi.encodePacked(type(SquareHoleHook).creationCode, abi.encode(pm, predictedLauncher));
        (bytes32 salt, address predictedHook) = _mineHookSalt(address(this), keccak256(hookInit));
        hook = new SquareHoleHook{salt: salt}(pm, predictedLauncher); // nonce + 2 (CREATE2 also bumps the nonce)
        assertEq(address(hook), predictedHook, "mined hook address");
        coreDeployer = new CoreDeployer(predictedLauncher); // nonce + 3
        collectionDeployer = new CollectionTokenDeployer(predictedLauncher); // nonce + 4
        fungibleDeployer = new FungibleTokenDeployer(predictedLauncher); // nonce + 5
        launcher = new SquareHoleLauncher(
            pm, hook, registry, treasury, address(converter), coreDeployer, collectionDeployer, fungibleDeployer
        );
        assertEq(address(launcher), predictedLauncher, "launcher address");

        vm.startPrank(admin);
        wethTemplate =
            registry.addTemplate(address(weth), WETH_START_FDV, WETH_MIN_UNIT_VALUE, TICK_SPACING, RANGE_TICKS);
        usdcTemplate = registry.addTemplate(address(usdc), USD_START_FDV, USD_MIN_UNIT_VALUE, TICK_SPACING, RANGE_TICKS);
        usdtTemplate = registry.addTemplate(address(usdt), USD_START_FDV, USD_MIN_UNIT_VALUE, TICK_SPACING, RANGE_TICKS);
        vm.stopPrank();
    }

    /// @dev HookMiner-style search: the first salt whose CREATE2 address has exactly the hook's 14 permission bits
    /// and does not start with 0x91 (ADR-0006 routing policy).
    function _mineHookSalt(address deployer, bytes32 initCodeHash) internal returns (bytes32 salt, address addr) {
        uint160 flags = HOOK_FLAGS;
        for (uint256 i; i < 2_000_000; ++i) {
            salt = bytes32(i);
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (uint160(addr) & 0x3FFF == flags && uint160(addr) >> 152 != 0x91) {
                hookMiningIterations = i + 1;
                return (salt, addr);
            }
        }
        revert("no hook salt found");
    }

    /*//////////////////////////////////////////////////////////////
                                LAUNCHES
    //////////////////////////////////////////////////////////////*/

    function _params(
        SquareHoleRegistry.AssetKind kind,
        uint256 units,
        uint256 fractionsPerNft,
        uint32 templateVersion,
        IRewardLedger.PayoutAsset payout
    ) internal pure returns (SquareHoleLauncher.LaunchParams memory) {
        bool collection = kind == SquareHoleRegistry.AssetKind.Collection;
        return SquareHoleLauncher.LaunchParams({
            kind: kind,
            name: collection ? "The Misfits (test)" : "Square Hole Fit (test)",
            symbol: collection ? "MISFIT" : "FIT",
            units: units,
            fractionsPerNft: fractionsPerNft,
            templateVersion: templateVersion,
            payoutAsset: payout,
            baseURI: collection ? "ipfs://bafy-misfits-test/" : "",
            metadataManifestHash: keccak256(abi.encode("manifest", kind, units, fractionsPerNft))
        });
    }

    function _launch(
        SquareHoleRegistry.AssetKind kind,
        uint256 units,
        uint256 fractionsPerNft,
        uint32 templateVersion,
        IRewardLedger.PayoutAsset payout
    ) internal returns (Launch memory L) {
        vm.prank(creator);
        (bytes32 pairId,) = launcher.createLaunch(_params(kind, units, fractionsPerNft, templateVersion, payout));
        L = _load(pairId);
    }

    function _load(bytes32 pairId) internal view returns (Launch memory L) {
        L.pairId = pairId;
        L.r = registry.pair(pairId);
        L.tIsCurrency0 = L.r.token < L.r.quote;
        L.key = PoolKey({
            currency0: Currency.wrap(L.tIsCurrency0 ? L.r.token : L.r.quote),
            currency1: Currency.wrap(L.tIsCurrency0 ? L.r.quote : L.r.token),
            fee: hook.LP_FEE(),
            tickSpacing: L.r.tickSpacing,
            hooks: IHooks(address(hook))
        });
        L.id = L.key.toId();
        L.t = ITestT(L.r.token);
        L.ledger = RewardLedger(L.r.ledger);
        L.collector = FeeCollector(L.r.collector);
    }

    /// @dev Raw units per whole NFT (collection: 1e27 / N, exact, F10) or per whole token (fungible: 1e18).
    function _unit(Launch memory L) internal pure returns (uint256) {
        return L.r.kind == SquareHoleRegistry.AssetKind.Collection ? L.r.initialSupply / L.r.units : 1e18;
    }

    /*//////////////////////////////////////////////////////////////
                                TRADING
    //////////////////////////////////////////////////////////////*/

    /// @dev Gives `to` `amount` of the quote (mint for test tokens; otherwise transferred from `qSource`).
    function _fundQuote(address q, address to, uint256 amount) internal virtual {
        (bool ok,) = q.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        require(ok, "mint quote");
    }

    /// @dev Sets `owner`'s allowance for `spender` to exactly `amount` (reset to 0 first: USDT-style tokens).
    function _approveExact(address token, address owner, address spender, uint256 amount) internal {
        vm.startPrank(owner);
        (bool ok,) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
        require(ok, "approve 0");
        (ok,) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        require(ok, "approve");
        vm.stopPrank();
    }

    /// @dev One swap of `trader` through StepRouter in the Universal Router order (swap, settle all, take all).
    /// buy = Q → T. exactIn: `amount` is the input; otherwise the output. Returns (input paid, output received).
    function _trade(Launch memory L, address trader, bool buy, bool exactIn, uint256 amount)
        internal
        returns (uint256 paid, uint256 received)
    {
        address input = buy ? L.r.quote : L.r.token;
        address output = buy ? L.r.token : L.r.quote;
        uint256 inBefore = _balance(input, trader);
        uint256 outBefore = _balance(output, trader);
        _approveExact(input, trader, address(stepRouter), exactIn ? amount : inBefore);
        StepRouter.Step[] memory steps = new StepRouter.Step[](3);
        steps[0] = _swapStep(L, buy, exactIn ? -int256(amount) : int256(amount));
        steps[1] = _payStep(StepRouter.Op.SettleAll, input, trader, 0);
        steps[2] = _payStep(StepRouter.Op.TakeAll, output, trader, 0);
        stepRouter.run(steps);
        _approveExact(input, trader, address(stepRouter), 0);
        paid = inBefore - _balance(input, trader);
        received = _balance(output, trader) - outBefore;
    }

    function _buyIn(Launch memory L, address trader, uint256 qIn) internal returns (uint256 tOut) {
        _fundQuote(L.r.quote, trader, qIn);
        (, tOut) = _trade(L, trader, true, true, qIn);
    }

    function _sellIn(Launch memory L, address trader, uint256 tIn) internal returns (uint256 qOut) {
        (, qOut) = _trade(L, trader, false, true, tIn);
    }

    function _swapStep(Launch memory L, bool buy, int256 amountSpecified)
        internal
        pure
        returns (StepRouter.Step memory s)
    {
        s.op = StepRouter.Op.Swap;
        s.key = L.key;
        // buy (Q in): zeroForOne iff Q is currency0, i.e. iff T is currency1.
        s.zeroForOne = buy ? !L.tIsCurrency0 : L.tIsCurrency0;
        s.amount = amountSpecified;
    }

    function _payStep(StepRouter.Op op, address currency, address account, uint256 amount)
        internal
        pure
        returns (StepRouter.Step memory s)
    {
        s.op = op;
        s.currency = currency;
        s.account = account;
        s.amount = int256(amount);
    }

    function _balance(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        require(ok, "balanceOf");
        return abi.decode(ret, (uint256));
    }

    /*//////////////////////////////////////////////////////////////
                        POOL STATE AND FEE GROWTH
    //////////////////////////////////////////////////////////////*/

    function _claimsOf(address owner, address asset) internal view returns (uint256) {
        return pm.balanceOf(owner, uint256(uint160(asset)));
    }

    /// @dev The protocol-owned position's fee growth inside its range (Pool.sol), per currency (T, Q order).
    function _feeGrowthInside(Launch memory L) internal view returns (uint256 tGrowth, uint256 qGrowth) {
        (uint256 g0, uint256 g1) = pm.getFeeGrowthInside(L.id, L.r.tickLower, L.r.tickUpper);
        (tGrowth, qGrowth) = L.tIsCurrency0 ? (g0, g1) : (g1, g0);
    }

    /// @dev Fees accrued to the position and not yet collected (must be zero after every swap: afterSwap collects).
    function _uncollected(Launch memory L) internal view returns (uint256 t, uint256 q) {
        bytes32 positionId =
            keccak256(abi.encodePacked(address(hook), L.r.tickLower, L.r.tickUpper, hook.POSITION_SALT()));
        (uint128 liquidity, uint256 last0, uint256 last1) = pm.getPositionInfo(L.id, positionId);
        (uint256 g0, uint256 g1) = pm.getFeeGrowthInside(L.id, L.r.tickLower, L.r.tickUpper);
        uint256 u0 = FullMath.mulDiv(g0 - last0, liquidity, Q128);
        uint256 u1 = FullMath.mulDiv(g1 - last1, liquidity, Q128);
        (t, q) = L.tIsCurrency0 ? (u0, u1) : (u1, u0);
    }

    function _positionLiquidity(Launch memory L) internal view returns (uint128 liquidity) {
        bytes32 positionId =
            keccak256(abi.encodePacked(address(hook), L.r.tickLower, L.r.tickUpper, hook.POSITION_SALT()));
        (liquidity,,) = pm.getPositionInfo(L.id, positionId);
    }

    /// @dev Principal of the position at the current price (T, Q), rounded up (what the PoolManager must hold).
    function _principal(Launch memory L) internal view returns (uint256 t, uint256 q) {
        (uint160 sqrtP,,,) = pm.getSlot0(L.id);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(L.r.tickLower);
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(L.r.tickUpper);
        uint128 liq = _positionLiquidity(L);
        if (sqrtP < sqrtL) sqrtP = sqrtL;
        if (sqrtP > sqrtU) sqrtP = sqrtU;
        uint256 a0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtU, liq, true);
        uint256 a1 = SqrtPriceMath.getAmount1Delta(sqrtL, sqrtP, liq, true);
        (t, q) = L.tIsCurrency0 ? (a0, a1) : (a1, a0);
    }

    /// @dev The revert a fee-bearing swap produces when T left the PoolManager to an eligible account earlier in the
    /// same transaction (fail-closed flash guard): the ledger's PoolOutflowAtFeeEvent, wrapped by v4's hook call.
    function _outflowRevert(uint256 outflow) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(RewardLedger.PoolOutflowAtFeeEvent.selector, outflow),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _mirror(Launch memory L) internal pure returns (DN404Mirror) {
        return DN404Mirror(payable(L.r.mirror));
    }

    function _collection(Launch memory L) internal pure returns (SquareHoleToken) {
        return SquareHoleToken(payable(L.r.token));
    }
}
