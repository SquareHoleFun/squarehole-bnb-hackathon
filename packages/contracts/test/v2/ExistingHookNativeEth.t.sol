// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {FitStandIn} from "./utils/FitStandIn.sol";
import {DirectSwapper} from "./utils/NativeV4Callers.sol";

/// @notice TEST-ONLY collector for the EXISTING `SquareHoleHook` with Q = native ETH (address 0): it answers the
/// hook's launch checks and pulls each receipt's ERC-6909 claims exactly like `FeeCollector.receiveFees` does
/// (`PoolManagerClaims.pullExact`), without the ledger. The real `FeeCollector` cannot be built for Q = address 0
/// (constructor zero-address check), which is one of the changes T14 lists.
contract NativeCollectorStub {
    IPoolManager public immutable pm;
    address public immutable token;
    address public feeSource;
    uint256 public tReceived;
    uint256 public qReceived;
    uint256 public receipts;

    constructor(IPoolManager pm_, address token_) {
        pm = pm_;
        token = token_;
    }

    function setFeeSource(address hook) external {
        feeSource = hook;
    }

    function quote() external pure returns (address) {
        return address(0); // native ETH
    }

    function poolManager() external view returns (address) {
        return address(pm);
    }

    function receiveFees(uint256 tAmount, uint256 qAmount) external returns (uint256) {
        require(msg.sender == feeSource, "not fee source");
        if (tAmount != 0) _pull(uint160(token), tAmount);
        if (qAmount != 0) _pull(0, qAmount); // ERC-6909 id 0 = native ETH
        tReceived += tAmount;
        qReceived += qAmount;
        return ++receipts;
    }

    function _pull(uint256 id, uint256 amount) private {
        uint256 before = pm.balanceOf(address(this), id);
        pm.transferFrom(feeSource, address(this), id, amount);
        require(pm.balanceOf(address(this), id) - before == amount, "delta");
    }
}

/// @notice Which existing contract actually blocks native ETH? Not the hook: the EXISTING `SquareHoleHook` (unchanged,
/// 3% static fee) launches and realises fees on an ETH / FIT pool with native ETH as currency0, buys and sells both
/// paying their fee as ERC-6909 claims (ETH claims have id 0). The blockers are the registry, ledger and collector
/// constructors and their ERC-20-only helpers (docs/evidence/SH-V2-T14-route-proof.md § "Contracts that must change").
contract ExistingHookNativeEthTest is Test {
    using StateLibrary for IPoolManager;

    uint256 internal constant Q128 = 1 << 128;
    int24 internal constant LOWER = 177_180;
    int24 internal constant UPPER = 204_060;

    IPoolManager internal pm;
    FitStandIn internal fit;
    SquareHoleHook internal hook;
    NativeCollectorStub internal collector;
    DirectSwapper internal direct;
    PoolKey internal key;
    uint128 internal liquidity;
    address internal launcher = makeAddr("t14.existingHookLauncher");
    address internal trader = makeAddr("t14.trader");

    function setUp() public {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("pmOwner"))));
        bytes32 initHash = keccak256(abi.encodePacked(type(SquareHoleHook).creationCode, abi.encode(pm, launcher)));
        bytes32 salt;
        for (uint256 i; i < 2_000_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), initHash, address(this));
            if (uint160(a) & 0x3FFF == 0x2A60 && uint160(a) >> 152 != 0x91) {
                salt = bytes32(i);
                break;
            }
        }
        hook = new SquareHoleHook{salt: salt}(pm, launcher);
        fit = new FitStandIn(address(hook)); // T's initial holder is the hook (SquareHoleHook pays the seed itself)
        collector = new NativeCollectorStub(pm, address(fit));
        collector.setFeeSource(address(hook));
        direct = new DirectSwapper(pm);
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(fit)), hook.LP_FEE(), 60, IHooks(address(hook)));
        liquidity = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(LOWER), TickMath.getSqrtPriceAtTick(UPPER), 800_000_000e18
        );
        vm.prank(launcher);
        hook.launchPool(
            SquareHoleHook.LaunchPoolParams({
                key: key,
                sqrtPriceX96: TickMath.getSqrtPriceAtTick(UPPER),
                tickLower: LOWER,
                tickUpper: UPPER,
                liquidity: liquidity,
                collector: address(collector)
            })
        );
    }

    function test_existingHook_nativeEthQuote_launchesAndRealisesFeesBothSides() public {
        (uint256 g0, uint256 g1) = pm.getFeeGrowthInside(key.toId(), LOWER, UPPER);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        direct.swap{value: 1 ether}(key, true, -1 ether);
        (uint256 g0b,) = pm.getFeeGrowthInside(key.toId(), LOWER, UPPER);
        assertEq(collector.qReceived(), FullMath.mulDiv(g0b - g0, liquidity, Q128), "ETH fee == fee growth x L");
        assertApproxEqAbs(collector.qReceived(), 0.03 ether, 2, "3% (the existing hook's fee)");
        assertEq(pm.balanceOf(address(collector), 0), collector.qReceived(), "held as native-ETH claims (id 0)");

        uint256 fitIn = fit.balanceOf(trader) / 2;
        vm.startPrank(trader);
        fit.approve(address(direct), fitIn);
        direct.swap(key, false, -int256(fitIn));
        vm.stopPrank();
        (, uint256 g1b) = pm.getFeeGrowthInside(key.toId(), LOWER, UPPER);
        assertEq(collector.tReceived(), FullMath.mulDiv(g1b - g1, liquidity, Q128), "FIT fee == fee growth x L");
        assertApproxEqAbs(collector.tReceived(), fitIn * 3 / 100, 2);
        assertEq(collector.receipts(), 2);
        assertGt(trader.balance, 0, "native ETH out");
    }
}

/// @notice The existing contracts that DO refuse Q = native ETH (address 0), each at its first check. Nothing here is
/// changed by T14; the evidence lists the edits the v2 build needs (or the component that replaces each one).
contract ExistingContractsRejectNativeEthTest is Test {
    function test_registry_refusesNativeEthQuote() public {
        address admin = makeAddr("admin");
        SquareHoleRegistry registry = new SquareHoleRegistry(admin, makeAddr("launcher"));
        vm.prank(admin);
        vm.expectRevert(SquareHoleRegistry.InvalidTemplate.selector); // SquareHoleRegistry.sol:138
        registry.addTemplate(address(0), 1e18, 1e14, 60, 69_060);
    }

    function test_feeCollector_refusesNativeEthQuote() public {
        vm.expectRevert(FeeCollector.ZeroAddress.selector); // FeeCollector.sol:72-75
        new FeeCollector(
            makeAddr("token"), address(0), makeAddr("ledger"), makeAddr("treasury"), makeAddr("hook"), makeAddr("pm")
        );
    }

    function test_rewardLedger_refusesNativeEthQuote() public {
        RewardLedger.Config memory c;
        c.token = makeAddr("token");
        c.quote = address(0);
        c.feeCollector = makeAddr("collector");
        c.treasury = makeAddr("treasury");
        c.poolManager = makeAddr("pm");
        c.payoutAsset = IRewardLedger.PayoutAsset.Q;
        vm.expectRevert(RewardLedger.ZeroAddress.selector); // RewardLedger.sol:106-109
        new RewardLedger(c);
    }
}
