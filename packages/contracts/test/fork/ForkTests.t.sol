// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {StepRouter} from "../utils/v4/Routers.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPermit2Allowance {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IProtocolFeesView {
    function protocolFeeController() external view returns (address);
    function owner() external view returns (address);
}

/// @notice Shared fork helpers: compare the canonical PoolManager's runtime code with the locally compiled pinned
/// source (immutables masked).
abstract contract ForkBase is V4Fixture {
    struct ImmutableRef {
        uint256 length;
        uint256 start;
    }

    /// @dev Local artifact (via-IR, 44,444,444 runs, solc 0.8.26, cancun, bytecode_hash none; foundry.toml) vs the
    /// deployed runtime, with every immutable reference zeroed in both.
    function _assertPoolManagerMatchesPinnedSource(address deployed) internal view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/out/PoolManager.sol/PoolManager.json"));
        bytes memory local = vm.parseJsonBytes(json, ".deployedBytecode.object");
        bytes memory remote = deployed.code;
        assertEq(remote.length, local.length, "runtime length");
        string[] memory keys = vm.parseJsonKeys(json, ".deployedBytecode.immutableReferences");
        uint256 masked;
        for (uint256 k; k < keys.length; ++k) {
            ImmutableRef[] memory refs = abi.decode(
                vm.parseJson(json, string.concat(".deployedBytecode.immutableReferences.", keys[k])), (ImmutableRef[])
            );
            for (uint256 i; i < refs.length; ++i) {
                for (uint256 j; j < refs[i].length; ++j) {
                    local[refs[i].start + j] = 0;
                    remote[refs[i].start + j] = 0;
                }
                masked += refs[i].length;
            }
        }
        assertGt(masked, 0, "the PoolManager has immutables (NoDelegateCall.original)");
        assertEq(keccak256(remote), keccak256(local), "canonical runtime == pinned source build (immutables masked)");
    }
}

/// @notice Sepolia fork tests against the canonical Uniswap v4 deployment (docs/research/sepolia-infrastructure.md
/// § 2.1). Opt-in: `SH_FORK_SEPOLIA=true forge test --match-contract SepoliaForkTest`. Reads a public keyless RPC
/// (default: the Tenderly gateway, which serves historical state; publicnode and 0xrpc.io do not) at a pinned block,
/// through Foundry's RPC cache. Square Hole is deployed only inside the local fork; nothing is ever broadcast and no
/// key is used.
contract SepoliaForkTest is ForkBase {
    address internal constant PM = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant POOL_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;
    address internal constant UNIVERSAL_ROUTER_2_1_2 = 0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3;
    address internal constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant WETH9 = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    /// @dev The block of the SH-018/Sepolia research re-run (2026-09-25).
    uint256 internal constant FORK_BLOCK = 11_780_483;
    string internal constant DEFAULT_RPC = "https://sepolia.gateway.tenderly.co";

    bool internal forkEnabled;

    function setUp() public {
        forkEnabled = vm.envOr("SH_FORK_SEPOLIA", false);
        if (!forkEnabled) return;
        vm.createSelectFork(vm.envOr("SEPOLIA_FORK_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        assertEq(block.chainid, 11_155_111);
        _deploySystemOnFork(PM, POOL_SWAP_TEST, WETH9, USDC);
    }

    modifier forkOnly() {
        if (!forkEnabled) vm.skip(true);
        _;
    }

    /// WETH9 is funded by depositing test ETH (fork only); other quotes are the local mocks.
    function _fundQuote(address q, address to, uint256 amount) internal override {
        if (q == WETH9) {
            vm.deal(to, amount);
            vm.prank(to);
            IWETH9(WETH9).deposit{value: amount}();
        } else {
            super._fundQuote(q, to, amount);
        }
    }

    function test_fork_canonicalPoolManager_isThePinnedSource() public forkOnly {
        _assertPoolManagerMatchesPinnedSource(PM);
        assertEq(IProtocolFeesView(PM).protocolFeeController(), address(0), "SEP-S01: no protocol fee controller");
        assertEq(address(PoolSwapTest(POOL_SWAP_TEST).manager()), PM);
    }

    /// The whole Square Hole flow on the canonical Sepolia PoolManager: launch, buys (canonical PoolSwapTest,
    /// exact in and exact out), a sell, fee reconciliation, claims, burns, and the fail-closed flash-outflow guard.
    function test_fork_fullCycle_canonicalPoolManager() public forkOnly {
        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        uint256 unit = _unit(L);
        // Canonical PoolSwapTest (the documented external test harness): exact in, then exact out of 3 NFTs.
        _fundQuote(WETH9, alice, 1 ether);
        _fundQuote(WETH9, bob, 1 ether);
        bool buy0For1 = !L.tIsCurrency0;
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings(false, false);
        vm.prank(alice);
        IWETH9(WETH9).approve(POOL_SWAP_TEST, 0.2 ether);
        vm.prank(alice);
        PoolSwapTest(POOL_SWAP_TEST).swap(L.key, SwapParams(buy0For1, -0.2 ether, _lim(buy0For1)), ts, "");
        vm.prank(bob);
        IWETH9(WETH9).approve(POOL_SWAP_TEST, 1 ether);
        vm.prank(bob);
        PoolSwapTest(POOL_SWAP_TEST).swap(L.key, SwapParams(buy0For1, int256(3 * unit), _lim(buy0For1)), ts, "");
        assertEq(_mirror(L).balanceOf(bob), 3, "exact-out delivered 3 NFTs on the canonical harness");
        assertEq(L.collector.receiptCount(), 2);
        // A sell through the step router, then claims and burns.
        (uint256 gT0,) = _feeGrowthInside(L);
        _sellIn(L, alice, L.t.balanceOf(alice) / 2);
        (uint256 gT1,) = _feeGrowthInside(L);
        assertEq(L.collector.totalTReceived(), FullMath.mulDiv(gT1 - gT0, L.r.liquidity, Q128));
        uint256 owed = L.ledger.claimable(alice);
        assertGt(owed, 0);
        vm.prank(alice);
        L.ledger.claim(alice);
        uint256 supply = L.t.totalSupply();
        uint256 pending = L.collector.pendingBurnT();
        L.collector.processFees();
        assertEq(L.t.totalSupply(), supply - pending);
        // Flash-outflow guard through the canonical PoolManager: take → swap → settle in one unlock.
        address attacker = makeAddr("attacker");
        uint256 borrowed = L.t.balanceOf(PM) / 2;
        _fundQuote(WETH9, attacker, 1 ether);
        _approveExact(WETH9, attacker, address(stepRouter), 1 ether);
        _approveExact(L.r.token, attacker, address(stepRouter), borrowed);
        StepRouter.Step[] memory s = new StepRouter.Step[](5);
        s[0] = _payStep(StepRouter.Op.Take, L.r.token, attacker, borrowed);
        s[1] = _swapStep(L, true, -0.1 ether);
        s[2] = _payStep(StepRouter.Op.Settle, L.r.token, attacker, borrowed);
        s[3] = _payStep(StepRouter.Op.SettleAll, WETH9, attacker, 0);
        s[4] = _payStep(StepRouter.Op.TakeAll, L.r.token, attacker, 0);
        uint256 bobBefore = L.ledger.claimable(bob);
        vm.expectRevert(_outflowRevert(borrowed)); // fail-closed on the canonical PoolManager too
        stepRouter.run(s);
        assertEq(L.ledger.bootstrapQ(), 0, "nothing deferred");
        assertEq(L.ledger.claimable(attacker), 0);
        assertEq(L.ledger.claimable(bob), bobBefore);
    }

    /// Universal Router 2.1.2 (the Trading API's Sepolia router): V4_SWAP with SWAP_EXACT_IN_SINGLE → SETTLE_ALL →
    /// TAKE_ALL, paid through Permit2 with an exact, expiring allowance. Tries the current V4Router parameter layout
    /// (with minHopPriceX36) and the earlier one; records which the deployed router accepts.
    function test_fork_universalRouter212_v4Swap() public forkOnly {
        Launch memory L = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        _buyIn(L, alice, 0.05 ether); // a prior holder
        uint256 aliceBefore = L.ledger.claimable(alice);
        _fundQuote(WETH9, bob, 0.3 ether);
        vm.startPrank(bob);
        IWETH9(WETH9).approve(PERMIT2_ADDR, 0.3 ether);
        IPermit2Allowance(PERMIT2_ADDR)
            .approve(WETH9, UNIVERSAL_ROUTER_2_1_2, uint160(0.3 ether), uint48(block.timestamp + 600));
        vm.stopPrank();
        bool zeroForOne = !L.tIsCurrency0;
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[1] = abi.encode(Currency.wrap(WETH9), uint256(0.3 ether));
        params[2] = abi.encode(Currency.wrap(L.r.token), uint256(1));
        bytes[] memory inputs = new bytes[](1);
        bytes memory commands = hex"10"; // V4_SWAP

        params[0] = abi.encode(IV4Router.ExactInputSingleParams(L.key, zeroForOne, 0.3 ether, 1, 0, ""));
        inputs[0] = abi.encode(actions, params);
        vm.prank(bob);
        bool ok;
        try IUniversalRouter(UNIVERSAL_ROUTER_2_1_2).execute(commands, inputs, block.timestamp + 60) {
            ok = true;
            emit log("UR 2.1.2 accepted the ExactInputSingleParams layout WITH minHopPriceX36");
        } catch {
            params[0] = abi.encode(LegacyExactInputSingleParams(L.key, zeroForOne, 0.3 ether, 1, ""));
            inputs[0] = abi.encode(actions, params);
            vm.prank(bob);
            IUniversalRouter(UNIVERSAL_ROUTER_2_1_2).execute(commands, inputs, block.timestamp + 60);
            ok = true;
            emit log("UR 2.1.2 accepted the ExactInputSingleParams layout WITHOUT minHopPriceX36");
        }
        assertTrue(ok);
        assertGt(L.t.balanceOf(bob), 0, "bought through the Universal Router");
        assertEq(L.ledger.bootstrapQ(), 0, "the router's swap precedes settle/take: a clean fee event");
        assertGt(L.ledger.claimable(alice), aliceBefore, "indexed at the swap to the prior holder");
        assertEq(L.ledger.claimable(bob), 0);
    }

    struct LegacyExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function _lim(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
    }
}

/// @notice Mainnet read-only provenance check (opt-in `SH_FORK_MAINNET=true`): the canonical mainnet PoolManager's
/// runtime equals the pinned source build (immutables masked), at a pinned block, through a keyless archive RPC.
contract MainnetForkTest is ForkBase {
    address internal constant PM = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    /// @dev The block of ADR-0006's AU-03 read-only check.
    uint256 internal constant FORK_BLOCK = 26_055_260;
    string internal constant DEFAULT_RPC = "https://eth.drpc.org";

    function test_fork_mainnetPoolManager_isThePinnedSource() public {
        if (!vm.envOr("SH_FORK_MAINNET", false)) vm.skip(true);
        vm.createSelectFork(vm.envOr("MAINNET_FORK_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        assertEq(block.chainid, 1);
        _assertPoolManagerMatchesPinnedSource(PM);
        emit log_named_address("mainnet protocolFeeController", IProtocolFeesView(PM).protocolFeeController());
    }
}
