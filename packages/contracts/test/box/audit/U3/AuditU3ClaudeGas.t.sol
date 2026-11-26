// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {AuditU3ClaudeActor, AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lens L5 (P3.11): the gas box 0's hook adds to a swap, measured against a hookless
/// twin pool (the same ETH/T pair, fee and spacing, initialised at the same price with the same positions and
/// liquidity), in the bonding phase (the curve) and after graduation (the L7 layout, then with the pair), under
/// cancun, osaka and amsterdam (`vm.setEvmVersion`, as test/box/s45/BoxS45Gas.t.sol does). Each measured swap is the
/// first touch of every account in its frame (`vm.cool` on the PoolManager, the token, the hook and its two code
/// halves, the actor and the payer). BC-018's bound (14,123 extra gas per ordinary swap) is stated for a box after
/// graduation and asserted there; the curve phase's figures are measured and reported (no written bound covers them).
/// The twin's T comes from forge-std `deal` to a stand-in liquidity provider outside the box (no ghost check here).
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeGasTest is AuditU3ClaudeBase {
    uint256 internal constant BC018_BUDGET = 14_123;

    address internal lp = makeAddr("audit.u3.lp");
    address internal payer = makeAddr("audit.u3.gasPayer");
    PoolKey internal twin;

    function setUp() public override {
        super.setUp();
        twin = _keyWith(10_000, 60, address(0));
        vm.label(lp, "audit.u3.lp");
    }

    /// Bonding (the curve): measured on the three EVMs, buys and sells; reported, not bounded (BC-018 is stated for a
    /// graduated box): about 15,210 extra gas today and 16,110 under amsterdam, above the graduated budget.
    function testProperty_AUDIT_U3_swapGasOnTheCurve() public {
        _toBonding();
        _twinCurve();
        _measureAll("curve", false, true);
    }

    /// The window (sells only: a buy from any route but the launch router is refused): the gate reads the router
    /// argument too; reported, not bounded.
    function testProperty_AUDIT_U3_swapGasInTheWindow() public {
        _toWindow();
        _twinCurve();
        _measureAll("window", false, false);
    }

    /// After graduation (ask, bid, sentinel at P1, then trades): BC-018's bound holds on cancun, osaka and amsterdam.
    function testProperty_AUDIT_U3_swapGasAfterGraduationWithinBC018() public {
        _toGraduated();
        _buy(eoa[3], 0.05 ether);
        _twinLayout();
        _measureAll("graduated", true, true);
    }

    /// After graduation with the pair-and-lock position in range too (one more position per crossing): the bound holds.
    function testProperty_AUDIT_U3_swapGasWithThePairWithinBC018() public {
        _toGraduated();
        vm.prank(keeper);
        launchRouter.sweep();
        _advance(300);
        hook.deepen(keeper);
        _advance(300);
        hook.deepen(keeper);
        require(_pairL() != 0, "a pair exists");
        _twinLayout();
        _measureAll("graduated with the pair", true, true);
    }

    /// BC-025's "Gas of each close and of the following graduate() is recorded" and ADR-0013 § 9 row 12 ("migration,
    /// and the completing swap from the extreme tick, stay below 16,777,216 gas"): an exact-input close of 3 × R
    /// through the router-like caller that runs past P1 to the extreme price (no liquidity lies below P1), then
    /// graduate(), whose migration walks the price back from there to exactly P1; each call measured from cold accounts
    /// on cancun, osaka and amsterdam, both below EIP-7825's 16,777,216-gas transaction cap.
    function testProperty_AUDIT_U3_overshootCloseAndGraduateGas() public {
        _toBonding();
        string[3] memory evms = ["cancun", "osaka", "amsterdam"];
        uint256 snap = vm.snapshotState();
        for (uint256 e; e < evms.length; ++e) {
            vm.revertToState(snap);
            vm.setEvmVersion(evms[e]);
            vm.deal(payer, 20 ether);
            AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
            legs[0] = _leg(true, -int256(3 * raise), TickMath.MIN_SQRT_PRICE + 1, false);
            _coolBox();
            uint256 g0 = gasleft();
            vm.prank(payer);
            u3actor.swaps{value: 3 * raise}(poolKey, legs, payer, payer);
            uint256 closeGas = g0 - gasleft();
            assertTrue(hook.closed(), "closed");
            assertEq(_sqrtP(), TickMath.MIN_SQRT_PRICE + 1, "ran to the extreme price");
            _coolBox();
            g0 = gasleft();
            vm.prank(keeper);
            coordinator.graduate();
            uint256 gradGas = g0 - gasleft();
            assertEq(_sqrtP(), curve.sqrtPriceLowerX96, "walked back to exactly P1");
            emit log_named_string("evm", evms[e]);
            emit log_named_uint("  overshooting close to the extreme price (gas)", closeGas);
            emit log_named_uint("  graduate() after it, walk back included (gas)", gradGas);
            assertLt(closeGas, 16_777_216, "EIP-7825 cap");
            assertLt(gradGas, 16_777_216, "EIP-7825 cap");
        }
        vm.setEvmVersion("osaka");
    }

    /// @dev Every account of box 0's system, the clones' implementations, the actor and the payer: cold.
    function _coolBox() internal {
        address[] memory sys = ghostSystem();
        for (uint256 i; i < sys.length; ++i) {
            vm.cool(sys[i]);
            bytes memory code = sys[i].code;
            if (code.length >= 45 && code[0] == 0x36 && code[1] == 0x3d) vm.cool(_implOf(sys[i]));
        }
        vm.cool(hook.extension());
        vm.cool(address(u3actor));
        vm.cool(payer);
        vm.cool(keeper);
    }

    // ------------------------------------------------------------------------------------------------ measuring

    function _measureAll(string memory phase, bool bounded, bool buys) internal {
        string[3] memory evms = ["cancun", "osaka", "amsterdam"];
        _fundPayer();
        // The same warm-up on both pools (every slot a measured swap writes then exists, as in BoxS45Gas): a buy and a
        // sale each, so neither pool's fee growth or tick data is written from zero by the measured swap.
        _warm(poolKey, buys);
        _warm(twin, buys);
        // After graduation, both pools parked 300 ticks below P1 (inside the ask, away from every position's edge), so
        // the measured swaps cross no initialised tick in either pool.
        if (bounded) {
            _landAt(poolKey, _sqrtAt(curve.tickLower - 300));
            _landAt(twin, _sqrtAt(curve.tickLower - 300));
        }
        require(_sqrtP() == _twinSqrtP(), "both pools at the same price");
        uint256 snap = vm.snapshotState();
        for (uint256 e; e < evms.length; ++e) {
            for (uint256 side = buys ? 0 : 1; side < 2; ++side) {
                vm.revertToState(snap);
                vm.setEvmVersion(evms[e]);
                bool buy = side == 0;
                uint256 withHook = _measure(poolKey, buy);
                vm.revertToState(snap);
                vm.setEvmVersion(evms[e]);
                uint256 base = _measure(twin, buy);
                uint256 extra = withHook > base ? withHook - base : 0;
                emit log_named_string("phase", phase);
                emit log_named_string("  evm", evms[e]);
                emit log_named_string("  side", buy ? "buy 0.01 ETH" : "sell 1e24 T");
                emit log_named_uint("  box pool swap gas", withHook);
                emit log_named_uint("  hookless twin swap gas", base);
                emit log_named_uint("  extra gas through the hook", extra);
                if (bounded) assertLe(extra, BC018_BUDGET, "BC-018: at most +14,123 gas per ordinary swap");
            }
        }
        vm.setEvmVersion("osaka");
    }

    /// One swap as the first touch of every account it uses: a buy of 0.01 ETH or a sale of 1e24 T, exact input.
    function _measure(PoolKey memory key, bool buy) internal returns (uint256 used) {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = buy
            ? _leg(true, -0.01 ether, TickMath.MIN_SQRT_PRICE + 1, false)
            : _leg(false, -1e24, TickMath.MAX_SQRT_PRICE - 1, false);
        address[8] memory cool =
            [address(pm), a.token, a.hook, _implOf(a.hook), hook.extension(), address(u3actor), payer, address(this)];
        for (uint256 i; i < cool.length; ++i) {
            vm.cool(cool[i]);
        }
        uint256 value = buy ? 0.01 ether : 0;
        uint256 g0 = gasleft();
        vm.prank(payer);
        u3actor.swaps{value: value}(key, legs, payer, payer);
        used = g0 - gasleft();
    }

    function _warm(PoolKey memory key, bool buys) internal {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](buys ? 2 : 1);
        legs[0] = _leg(false, -2e24, TickMath.MAX_SQRT_PRICE - 1, false);
        if (buys) legs[1] = _leg(true, -0.02 ether, TickMath.MIN_SQRT_PRICE + 1, false);
        vm.prank(payer);
        u3actor.swaps{value: buys ? 0.02 ether : 0}(key, legs, payer, payer);
        u3actor.sweepTo(payer);
    }

    /// @dev A buy in `key`'s pool down to exactly `target` (below its price).
    function _landAt(PoolKey memory key, uint160 target) internal {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(true, -10 ether, target, false);
        vm.deal(payer, payer.balance + 10 ether);
        vm.prank(payer);
        u3actor.swaps{value: 10 ether}(key, legs, payer, payer);
        u3actor.sweepTo(payer);
    }

    function _twinSqrtP() internal view returns (uint160 s) {
        bytes32 slot = keccak256(abi.encode(keccak256(abi.encode(twin)), uint256(6)));
        s = uint160(uint256(pm.extsload(slot)));
    }

    function _fundPayer() internal {
        vm.deal(payer, 10 ether);
        deal(a.token, payer, 1e26);
        vm.prank(payer);
        (bool ok,) =
            a.token.call(abi.encodeWithSignature("approve(address,uint256)", address(u3actor), type(uint256).max));
        require(ok, "approve");
    }

    // ------------------------------------------------------------------------------------------------ the twin

    /// The hookless twin of the curve: the same position [P1, P0] with the curve's liquidity, at the box's price.
    function _twinCurve() internal {
        uint160 s = _sqrtP();
        pm.initialize(twin, s);
        _twinAdd(curve.tickLower, curve.tickUpper, curve.liquidity);
    }

    /// The hookless twin of the graduated layout: ask, bid, sentinel and pair with the box's liquidities, at its price.
    function _twinLayout() internal {
        pm.initialize(twin, _sqrtP());
        _twinAdd(MIN_T, curve.tickLower, _askL());
        _twinAdd(curve.tickLower, MAX_T, _bidL());
        _twinAdd(curve.tickUpper, MAX_T, _sentinelL());
        if (_pairL() != 0) _twinAdd(MIN_T, MAX_T, _pairL());
    }

    function _twinAdd(int24 lower, int24 upper, uint128 l) internal {
        deal(a.token, lp, 1e27);
        vm.deal(lp, lp.balance + 50 ether);
        vm.prank(lp);
        (bool ok,) =
            a.token.call(abi.encodeWithSignature("approve(address,uint256)", address(u3actor), type(uint256).max));
        require(ok, "approve");
        vm.prank(lp);
        // forge-lint: disable-next-line(unsafe-typecast)
        u3actor.modify{value: 50 ether}(twin, ModifyLiquidityParams(lower, upper, int256(uint256(l)), bytes32(0)), lp);
        u3actor.sweepTo(lp);
    }

    function _implOf(address clone) internal view returns (address impl) {
        bytes memory code = clone.code;
        assembly ("memory-safe") {
            impl := shr(96, mload(add(add(code, 0x20), 10)))
        }
    }
}
