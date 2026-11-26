// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxPriceSampler} from "../../../src/box/BoxPriceSampler.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../src/box/BoxReceiverExtension.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";

/// @notice S5.M3's new paths, today (Osaka) and under Glamsterdam (`vm.setEvmVersion("amsterdam")`), measured as
/// BoxSwapModuleGas's are: a `gasleft()` delta in this contract's frame around one call (under `amsterdam` it includes
/// EIP-8037 state gas), the slots written from zero counted from the state diff. The creator conversions' steps
/// (BuyForCreator, SellForCreator) on a graduated box with add-on 5's cap, a collect that counts creator Q and values
/// held T, and the settlement with the cap; then the EIP-170 sizes of every contract M3 changed (BC-138).
contract BoxSwapCreatorGasTest is BoxSwapModuleBase {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;
    /// M2's measured step budget (BoxSwapModuleGas): the creator steps add the cap's count and the attribution.
    uint256 internal constant STEP_BUDGET_TODAY = 340_000;
    uint256 internal constant STEP_BUDGET_GLAMSTERDAM = 510_000;

    IBoxSwapModule.Action internal constant BUY_C = IBoxSwapModule.Action.BuyForCreator;
    IBoxSwapModule.Action internal constant SELL_C = IBoxSwapModule.Action.SellForCreator;

    function setUp() public {
        _setUpModuleWorld();
        vm.deal(keeper, 1);
    }

    function _creatorParams(uint8 qs, uint8 ts, uint128 cap) internal view returns (Params memory p) {
        p = _mp(qs, ts, false);
        p.payee = carol;
        if (cap != 0) (p.creatorCap, p.capExcess) = (cap, BoxSpecV1.CAP_EXCESS_POOL_DEPTH);
    }

    function _fillRing(Box memory b) internal {
        IBoxPriceAverage(b.average).poke();
        for (uint256 i; i < 10; ++i) {
            _roll(44);
            IBoxPriceAverage(b.average).poke();
        }
        _roll(1);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The creator steps

    function test_gas_creatorSteps_today() public {
        _creatorSteps(false);
    }

    function test_gas_creatorSteps_glamsterdam() public {
        _creatorSteps(true);
    }

    function _creatorSteps(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        Params memory p = _creatorParams(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 32 ether);
        Box memory b = _build(p);
        vm.deal(address(this), 200 ether);
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH}(address(0), 0);
        _report("launch, CREATOR_IN_T and CREATOR_IN_Q with add-on 5 (mock coordinator)", glamsterdam, g0 - gasleft());
        _skipWindow(b);
        _closeAndGraduate(b);
        _feedQ(b, 30 ether);
        _feedT(b, 50_000_000e18);
        _fillRing(b);
        _op("step BuyForCreator, the first", glamsterdam, b, BUY_C, false);
        _roll(1);
        _op("step SellForCreator, the first (the cap's first count)", glamsterdam, b, SELL_C, false);
        _settle(b);
        _op("step BuyForCreator, steady state", glamsterdam, b, BUY_C, true);
        _settle(b);
        _op("step SellForCreator, steady state (cap counted)", glamsterdam, b, SELL_C, true);
        // A collect returns both fees; the next pull attributes them to the creator ledgers first.
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        _settle(b);
        _op("step BuyForCreator after a collect returned its fee (attribution)", glamsterdam, b, BUY_C, true);
    }

    function _settle(Box memory b) internal {
        for (uint256 i; i < 25; ++i) {
            _roll(1);
            IBoxPriceAverage(b.average).poke();
        }
        _roll(1);
    }

    function _op(string memory label, bool glamsterdam, Box memory b, IBoxSwapModule.Action a, bool steady) internal {
        uint256 g = _measure(label, glamsterdam, b.module, abi.encodeCall(IBoxSwapModule.step, (a, keeper)), steady);
        if (steady) assertLe(g, glamsterdam ? STEP_BUDGET_GLAMSTERDAM : STEP_BUDGET_TODAY, "within M2's step budget");
    }

    /// § 13 point 7: SellForCreator with the room spent and a BURN excess burns the creator's T (no swap).
    function test_gas_creatorBurnStep_today() public {
        _creatorBurnStep(false);
    }

    function test_gas_creatorBurnStep_glamsterdam() public {
        _creatorBurnStep(true);
    }

    function _creatorBurnStep(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.deal(address(this), 200 ether);
        Params memory p = _creatorParams(BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_CREATOR_IN_Q, 0);
        (p.creatorCap, p.capExcess) = (1 ether, BoxSpecV1.CAP_EXCESS_BURN);
        Box memory b = _graduatedBox(p);
        _feedQ(b, 3 ether); // the room spent
        _feedT(b, 3_000_000e18);
        _fillRing(b);
        _op("step SellForCreator at room 0 with BURN: a burn, the first", glamsterdam, b, SELL_C, false);
        _feedT(b, 3_000_000e18);
        _roll(1);
        _op("step SellForCreator at room 0 with BURN: a burn, steady state", glamsterdam, b, SELL_C, true);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The receiver's cap paths: a collect counting creator Q and valuing held T, and the settlement

    function test_gas_capPaths_today() public {
        _capPaths(false);
    }

    function test_gas_capPaths_glamsterdam() public {
        _capPaths(true);
    }

    function _capPaths(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.deal(address(this), 200 ether);
        for (uint256 withCap; withCap < 2; ++withCap) {
            string memory tag = withCap == 1 ? " (add-on 5, 32 ETH)" : " (no add-on 5)";
            Box memory b = _buildAndLaunch(
                _creatorParams(
                    BoxSpecV1.Q_STREAM_TO_CREATOR, BoxSpecV1.T_STREAM_TO_CREATOR, withCap == 1 ? 32 ether : 0
                )
            );
            _skipWindow(b);
            _feedQ(b, 3 ether);
            _feedT(b, 3_000_000e18);
            b.coord.setSkipPokes(true);
            _closeAndGraduate(b);
            _measure(
                string.concat("onGraduation: the settlement, TO_CREATOR held both sides", tag),
                glamsterdam,
                address(b.receiver),
                abi.encodeCall(IBoxReceiver.onGraduation, ()),
                false
            );
            _fillRing(b);
            // The first collect after it (the cap: the held T valued from the slot it was held in).
            _batch(b);
            _measure(
                string.concat("collect, TO_CREATOR both sides, the first after the settlement", tag),
                glamsterdam,
                address(b.receiver),
                abi.encodeCall(IBoxReceiver.collect, (keeper)),
                false
            );
            _roll(1);
            _batch(b);
            _measure(
                string.concat("collect, TO_CREATOR both sides, steady state", tag),
                glamsterdam,
                address(b.receiver),
                abi.encodeCall(IBoxReceiver.collect, (keeper)),
                true
            );
            vm.deal(address(this), 1 ether);
            _measureValue(
                string.concat("fundFees 0.3 ETH, TO_CREATOR", tag),
                glamsterdam,
                address(b.receiver),
                abi.encodeCall(IBoxReceiver.fundFees, ()),
                0.3 ether
            );
        }
    }

    /// The next batch: Q and T claims as a round trip would leave them.
    function _batch(Box memory b) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + 3_000_000e18);
        funder.deposit(address(b.t), bob, 3_000_000e18, address(b.receiver));
        _mintQ(b, 0.02 ether);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Measuring

    function _measure(string memory label, bool glamsterdam, address target, bytes memory data, bool steady)
        internal
        returns (uint256 g)
    {
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        g = g0 - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        uint256 newSlots = _report(label, glamsterdam, g);
        if (steady) assertEq(newSlots, 0, string.concat(label, ": no slot written from zero in steady state"));
        if (data.length > 4 && bytes4(data) == IBoxSwapModule.step.selector) {
            (IBoxSwapModule.Stop stop,,,) = abi.decode(ret, (IBoxSwapModule.Stop, uint256, uint256, uint256));
            assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.None), string.concat(label, ": a step ran"));
        }
    }

    function _measureValue(string memory label, bool glamsterdam, address target, bytes memory data, uint256 value)
        internal
    {
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        uint256 g = g0 - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        _report(label, glamsterdam, g);
    }

    function _report(string memory label, bool glamsterdam, uint256 g) internal returns (uint256) {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        uint256 state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "S5M3|",
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
    // BC-138 (M3's part): EIP-170 for every contract M3 changed

    function test_BC138_m3SizesWithinEip170() public {
        if (address(moduleImpl) == address(0)) moduleImpl = new BoxSwapModule(pm);
        address[4] memory impls =
            [address(receiverImpl), address(receiverExt), address(moduleImpl), address(samplerImpl)];
        string[4] memory names = ["BoxReceiver", "BoxReceiverExtension", "BoxSwapModule", "BoxPriceSampler"];
        for (uint256 i; i < impls.length; ++i) {
            uint256 size = impls[i].code.length;
            emit log_named_uint(string.concat("S5M3S|", names[i], " runtime bytes"), size);
            emit log_named_uint(string.concat("S5M3S|", names[i], " EIP-170 margin"), 24_576 - size);
            assertLe(size, 24_576, string.concat(names[i], ": EIP-170"));
        }
        assertLe(address(receiverImpl).code.length, 22_500, "swap-module 7: the receiver's gate, with the cap built");
        assertEq(
            BoxReceiver(payable(address(receiverImpl))).ARGS_LENGTH(), 201, "S5.M3: 184 + the cap (16) + excess (1)"
        );
        assertEq(BoxSwapModule(address(moduleImpl)).ARGS_LENGTH(), 102, "the module's clone layout is unchanged");
        assertEq(BoxPriceSampler(address(samplerImpl)).ARGS_LENGTH(), 60, "the sampler's clone layout is unchanged");
        // The cold half has no clone layout of its own: it runs in the receiver clone's context.
        assertEq(BoxReceiverExtension(address(receiverExt)).coordinatorImplementation(), address(coordImpl));
    }
}
