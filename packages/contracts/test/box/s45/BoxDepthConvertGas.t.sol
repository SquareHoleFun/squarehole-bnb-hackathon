// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {BoxDepthConvertBase} from "./BoxDepthConvertBase.sol";

/// @notice S5.M5's new paths (BC-138's "a conversion alone and a conversion with a pair in deepen()"), today (Osaka)
/// and under Glamsterdam (`vm.setEvmVersion("amsterdam")`), measured as BoxS45Gas's cold paths are: a `gasleft()`
/// delta in this contract's frame around one `deepen()` (under `amsterdam` it includes EIP-8037 state gas), the slots
/// written from zero counted from the state diff. Box 0 on FIT's executor ring and a Standard box on its sampler,
/// both rings filled first (so a poke writes no new checkpoint slot), Q-only depth at graduation's price. And
/// BoxHookExtension's EIP-170 margin after M5.
contract BoxDepthConvertGasTest is BoxDepthConvertBase {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;
    /// A steady conversion's budget (P, measured here; S5.M4 re-sizes it): swap-module § 7 estimated (I) a conversion
    /// alone at ≈ 160,000-220,000 gas today and ≈ 190,000-260,000 under Glamsterdam, and a conversion with a pair
    /// ≈ 90,000-130,000 (≈ 100,000-150,000) more than a pair alone. Measured (SH-S5-swap § M5): alone 189,444 /
    /// 234,621, with a pair 300,052 / 388,753 at most; the budgets are those maxima rounded up.
    uint256 internal constant CONVERT_BUDGET_TODAY = 200_000;
    uint256 internal constant CONVERT_BUDGET_GLAMSTERDAM = 250_000;
    uint256 internal constant CONVERT_PAIR_BUDGET_TODAY = 320_000;
    uint256 internal constant CONVERT_PAIR_BUDGET_GLAMSTERDAM = 410_000;
    /// BoxHookExtension's EIP-170 margin after M5 (P): at least 2 KB stays for S5.M4's review.
    uint256 internal constant EXTENSION_MIN_MARGIN = 2048;

    function setUp() public {
        _setUpConvertWorld();
        // The tip recipient exists (an empty account receiving ETH is the caller's own cost, not the box's).
        vm.deal(keeper, 1);
    }

    function test_BC138_depthConversionGas_today() public {
        _conversions(false, true);
        _conversions(false, false);
    }

    function test_BC138_depthConversionGas_glamsterdam() public {
        _conversions(true, true);
        _conversions(true, false);
    }

    /// A conversion alone (the first: the hook's T claims from zero; then steady), a conversion with the first pair,
    /// and a conversion with a pair into the existing pair (steady).
    function _conversions(bool glamsterdam, bool box0) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        Box memory b = _graduated(box0, false);
        _fillRing(b);
        _fundQ(b, 5 ether);
        string memory k = box0 ? "box 0" : "standard";
        _op(string.concat(k, ": conversion alone, the first (the hook's T claims from zero)"), glamsterdam, b, false, false);
        _settle(b);
        _op(string.concat(k, ": conversion alone, steady"), glamsterdam, b, true, false);
        // The T side brought just below MIN_ADD (sellers' 2/15 over time, topped up here), so the next conversion
        // reaches it and pairs.
        _settle(b);
        _topUpT(b);
        _op(string.concat(k, ": conversion and the first pair"), glamsterdam, b, false, true);
        _settle(b);
        _topUpT(b);
        _op(string.concat(k, ": conversion and a pair into the pair, steady"), glamsterdam, b, true, true);
    }

    /// The ring filled: a poke about every 44 blocks for about 70 minutes (8 checkpoints), so a deepen's poke writes
    /// no new checkpoint (box 0's executor ring: first walked from its seed to P1).
    function _fillRing(Box memory b) internal {
        IBoxPriceAverage avg = IBoxPriceAverage(b.average);
        avg.poke();
        if (b.average == b.executor) {
            for (uint256 i; i < 600; ++i) {
                _roll(1);
                avg.poke();
            }
        }
        for (uint256 i; i < 10; ++i) {
            _roll(44);
            avg.poke();
        }
    }

    /// The next call's cooldown passed, the average poked across it (it follows the price).
    function _settle(Box memory b) internal {
        for (uint256 i; i < 7; ++i) {
            _roll(44);
            IBoxPriceAverage(b.average).poke();
        }
        uint256 last = b.hook.lastDeepenBlock();
        if (block.number < last + 300) _roll(last + 300 - block.number);
    }

    /// The hook's T side topped up to 95% of MIN_ADD at spot.
    function _topUpT(Box memory b) internal {
        uint256 want = _tFor(b.hook.minAdd() * 95 / 100, _sqrtP(b));
        uint256 have = _budget(b).t;
        if (want > have) _fundT(b, want - have);
    }

    function _op(string memory label, bool glamsterdam, Box memory b, bool steady, bool pair) internal {
        uint256 last = b.hook.lastDeepenBlock();
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = address(b.hook).call(abi.encodeWithSignature("deepen(address)", keeper));
        uint256 g = g0 - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        uint256 newSlots = _report(label, glamsterdam, g);
        assertTrue(b.hook.lastDeepenBlock() > last, "it ran");
        _checkRun(label, ret, pair);
        if (steady) _checkSteady(label, glamsterdam, pair, g, newSlots);
    }

    function _checkRun(string memory label, bytes memory ret, bool pair) internal pure {
        (DepthKind kind, DeepenSkip skip,,,) = abi.decode(ret, (DepthKind, DeepenSkip, uint256, uint256, uint256));
        assertEq(uint256(skip), uint256(DeepenSkip.None), label);
        assertEq(uint256(kind), uint256(pair ? DepthKind.Pair : DepthKind.Convert), label);
    }

    function _checkSteady(string memory label, bool glamsterdam, bool pair, uint256 g, uint256 newSlots)
        internal
        pure
    {
        assertEq(newSlots, 0, string.concat(label, ": no slot written from zero in steady state"));
        uint256 budget = pair
            ? (glamsterdam ? CONVERT_PAIR_BUDGET_GLAMSTERDAM : CONVERT_PAIR_BUDGET_TODAY)
            : (glamsterdam ? CONVERT_BUDGET_GLAMSTERDAM : CONVERT_BUDGET_TODAY);
        assertLe(g, budget, string.concat(label, ": within the measured budget"));
    }

    function _report(string memory label, bool glamsterdam, uint256 g) internal returns (uint256) {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        uint256 state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "S5M5G|",
                label,
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(g),
                "|new slots ",
                vm.toString(c.newSlots),
                glamsterdam ? string.concat("|of which state gas ", vm.toString(state)) : ""
            ));
        return c.newSlots;
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-138 (M5's part): the hook's halves within EIP-170, the extension keeping its margin

    function test_BC138_hookExtensionWithinEip170AfterM5() public {
        uint256 ext = address(hookExt).code.length;
        uint256 hook = address(hookImpl).code.length;
        emit log_named_uint("S5M5S|BoxHookExtension runtime bytes", ext);
        emit log_named_uint("S5M5S|BoxHookExtension EIP-170 margin", 24_576 - ext);
        emit log_named_uint("S5M5S|BoxHook runtime bytes", hook);
        assertLe(ext, 24_576, "EIP-170");
        assertLe(ext + EXTENSION_MIN_MARGIN, 24_576, "the extension keeps at least 2 KB");
        assertLe(hook, 24_576, "EIP-170");
        assertEq(BoxSpecV1.DEPTH_CONVERT_SHARE_BPS, 5000, "R F76: half");
        assertEq(BoxSpecV1.DEPTH_CONVERT_MIN_Q, BoxSpecV1.SWAP_STEP_MIN_Q, "a conversion alone: the step minimum");
    }
}
