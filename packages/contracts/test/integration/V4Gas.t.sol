// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {LaunchMath} from "../../src/libraries/LaunchMath.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {PlainDN404} from "../Gas.t.sol";
import {ITestT} from "../utils/Fixture.sol";
import {MockERC20} from "../utils/MockTokens.sol";
import {StepRouter} from "../utils/v4/Routers.sol";
import {V4Fixture} from "../utils/v4/V4Fixture.sol";

/// @notice Gas of the full swap path on a real v4 PoolManager (built from the pinned source with upstream settings):
/// Square Hole pools (hook afterSwap fee collection + claims + collector + ledger index + T checkpoints + DN404 sync)
/// against a baseline pool with NO hook, the same fee, range and liquidity, and an unmodified token (DN404 at the pin,
/// or a plain ERC-20). Run with `forge snapshot --isolate --match-contract V4GasTest`: every call is its own
/// transaction (cold storage, 21k intrinsic). Every swap goes through the same StepRouter sequence (swap, settle all,
/// take all), so router overhead is identical on both sides. Results: snapshots/V4SquareHole.json, V4Baseline.json.
contract V4GasTest is V4Fixture {
    PoolKey internal baseKey;
    ITestT internal baseT;
    Launch internal sh;

    address internal fresh = makeAddr("freshWallet");
    address internal fresh10 = makeAddr("freshWallet10");

    /// @dev F10: the fixed supply is 1e27 raw; a 1,000-NFT collection has a unit of 1e24 (1,000,000 tokens, 0.001 WETH
    /// at the start price). The fungible launch and both baselines trade the same raw amounts ("1 unit" = 1e24).
    uint256 internal constant U = 1e24;
    uint256 internal constant SUPPLY = 1e27;

    function setUp() public {
        _deploySystem();
    }

    /// Square Hole collection (1,000 NFTs of 1e24 raw, F10) and a hook-less DN404 baseline pool with the same unit,
    /// range and liquidity; alice holds 5.5 units in both, bob 2.2; one fee event has already been indexed.
    function _setUpCollection() internal {
        sh = _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q);
        assertEq(_unit(sh), U);
        baseT = ITestT(address(new PlainDN404(SUPPLY, address(this), U)));
        _seedBaseline();
        _warmUpBoth();
    }

    function _setUpFungible() internal {
        sh = _launch(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q);
        MockERC20 plain = new MockERC20("Plain T", "PT");
        plain.mint(address(this), SUPPLY);
        baseT = ITestT(address(plain));
        _seedBaseline();
        _warmUpBoth();
    }

    /// A pool without hook: same fee, spacing, range and liquidity as the Square Hole launch.
    function _seedBaseline() internal {
        bool tIs0 = address(baseT) < address(weth);
        baseKey = PoolKey({
            currency0: Currency.wrap(tIs0 ? address(baseT) : address(weth)),
            currency1: Currency.wrap(tIs0 ? address(weth) : address(baseT)),
            fee: 30_000,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        LaunchMath.LaunchPosition memory p =
            LaunchMath.launchPosition(SUPPLY, WETH_START_FDV, RANGE_TICKS, TICK_SPACING, tIs0);
        pm.initialize(baseKey, p.sqrtPriceX96);
        baseT.approve(address(stepRouter), SUPPLY);
        StepRouter.Step[] memory s = new StepRouter.Step[](2);
        s[0].op = StepRouter.Op.ModifyLiquidity;
        s[0].key = baseKey;
        s[0].tickLower = p.tickLower;
        s[0].tickUpper = p.tickUpper;
        s[0].amount = int256(uint256(p.liquidity));
        s[1] = _payStep(StepRouter.Op.SettleAll, address(baseT), address(this), 0);
        stepRouter.run(s);
    }

    function _warmUpBoth() internal {
        for (uint256 i; i < 2; ++i) {
            bool base = i == 1;
            _buyExact(base, alice, 55 * U / 10);
            _buyExact(base, bob, 22 * U / 10);
            _buyExact(base, carol, U); // a fee event after alice and bob hold (their checkpoints are behind)
        }
        // Everyone settles once so the measured calls see "repeat" ledger slots (non-zero checkpoints).
        vm.prank(alice);
        sh.t.transfer(alice, 0);
        vm.prank(bob);
        sh.t.transfer(bob, 0);
    }

    /// Exact-output buy of `tOut` T for `trader` on either pool (not measured).
    function _buyExact(bool base, address trader, uint256 tOut) internal {
        _fundQuote(address(weth), trader, 10 ether);
        _approveExact(address(weth), trader, address(stepRouter), 10 ether);
        stepRouter.run(_steps(base, trader, true, int256(tOut)));
    }

    function _steps(bool base, address trader, bool buy, int256 amountSpecified)
        internal
        view
        returns (StepRouter.Step[] memory s)
    {
        PoolKey memory key = base ? baseKey : sh.key;
        address t = base ? address(baseT) : sh.r.token;
        bool tIs0 = Currency.unwrap(key.currency0) == t;
        s = new StepRouter.Step[](3);
        s[0].op = StepRouter.Op.Swap;
        s[0].key = key;
        s[0].zeroForOne = buy ? !tIs0 : tIs0;
        s[0].amount = amountSpecified;
        s[1] = _payStep(StepRouter.Op.SettleAll, buy ? address(weth) : t, trader, 0);
        s[2] = _payStep(StepRouter.Op.TakeAll, buy ? t : address(weth), trader, 0);
    }

    /// The measured swap: one StepRouter.run call as `trader`, preceded (in separate calls) by funding/approval.
    function _measure(bool base, address trader, bool buy, int256 amountSpecified, string memory name) internal {
        address input = buy ? address(weth) : (base ? address(baseT) : sh.r.token);
        if (buy) _fundQuote(address(weth), trader, 10 ether);
        _approveExact(input, trader, address(stepRouter), buy ? 10 ether : SUPPLY);
        StepRouter.Step[] memory s = _steps(base, trader, buy, amountSpecified);
        vm.prank(trader);
        stepRouter.run(s);
        vm.snapshotGasLastCall(base ? "V4Baseline" : "V4SquareHole", name);
    }

    function _all(string memory prefix) internal {
        for (uint256 i; i < 2; ++i) {
            bool base = i == 1;
            uint256 snap = vm.snapshotState();
            _measure(base, alice, true, -0.01 ether, string.concat(prefix, "_buyExactIn_0.01Q_existingHolder"));
            vm.revertToState(snap);
            _measure(base, fresh, true, int256(U), string.concat(prefix, "_buyExactOut_1Unit_newWallet"));
            vm.revertToState(snap);
            _measure(base, fresh10, true, int256(10 * U), string.concat(prefix, "_buyExactOut_10Units_newWallet"));
            vm.revertToState(snap);
            _measure(base, alice, false, -int256(U), string.concat(prefix, "_sellExactIn_1Unit"));
            vm.revertToState(snap);
            _measure(base, bob, false, 0.001 ether, string.concat(prefix, "_sellExactOut_0.001Q"));
            vm.revertToState(snap);
        }
    }

    function test_gasV4_collection() public {
        _setUpCollection();
        _all("collection");
    }

    function test_gasV4_fungible() public {
        _setUpFungible();
        _all("fungible");
    }

    /// Launch, claim, fee processing and the R = T conversion (no baseline: Square Hole-only operations).
    function test_gasV4_lifecycle() public {
        vm.prank(creator);
        launcher.createLaunch(
            _params(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.Q)
        );
        vm.snapshotGasLastCall("V4SquareHole", "createLaunch_collection");
        vm.prank(creator);
        launcher.createLaunch(
            _params(SquareHoleRegistry.AssetKind.Token, 1e9, 1, wethTemplate, IRewardLedger.PayoutAsset.Q)
        );
        vm.snapshotGasLastCall("V4SquareHole", "createLaunch_fungible");

        _setUpCollection();
        _buyExact(false, alice, U);
        vm.prank(alice);
        sh.ledger.claim(alice);
        vm.snapshotGasLastCall("V4SquareHole", "claimQ_repeatAccount");
        _measure(false, bob, false, -int256(U), "sell_forProcessFees");
        sh.collector.processFees();
        vm.snapshotGasLastCall("V4SquareHole", "processFees_burnT_payQ");

        Launch memory L =
            _launch(SquareHoleRegistry.AssetKind.Collection, 1_000, 0, wethTemplate, IRewardLedger.PayoutAsset.T);
        _buyIn(L, alice, 0.05 ether);
        _buyIn(L, bob, 0.05 ether);
        vm.prank(alice);
        converter.claimAsT(L.r.token, ALL, 1, block.timestamp);
        vm.snapshotGasLastCall("V4SquareHole", "converter_claimAsT");
        // Build B item 6: the whole-entitlement entry point by registry pair id (bob's share of alice's conversion fee).
        vm.prank(bob);
        converter.claimAsT(L.pairId, 1, block.timestamp);
        vm.snapshotGasLastCall("V4SquareHole", "converter_claimAsT_byPairId");

        // Emergency settlement in Q once the range is sold out (a skip-NFT whale buys it out).
        address whale = makeAddr("gasWhale");
        vm.prank(whale);
        _collection(L).setSkipNFT(true);
        _buyIn(L, whale, 100 ether);
        assertTrue(converter.isSoldOut(L.r.token));
        vm.prank(bob);
        converter.claimAsQWhenSoldOut(L.r.token, ALL);
        vm.snapshotGasLastCall("V4SquareHole", "converter_claimAsQWhenSoldOut");
    }
}
