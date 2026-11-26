// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {ModuleProceedsTo} from "../../../src/box/interfaces/BoxTypes.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, MockSwapModule} from "./BoxS45Mocks.sol";

/// @notice S5.M1's new receiver paths, today (Osaka) and under Glamsterdam (`vm.setEvmVersion("amsterdam")`), measured
/// as BoxS45Gas's cold paths are: a `gasleft()` delta in this contract's frame around one call (under `amsterdam` it
/// includes EIP-8037 state gas), the new slots counted from the state diff. The module is `MockSwapModule`, so a
/// "step" here is the receiver's part of a step (pull, proceeds) plus the mock's ERC-6909 transfer; S5.M4 measures the
/// real module's step (BC-138). And the size gate of swap-module § 7: BoxReceiver within 22,500 bytes with M3's cap
/// ledger counted at its estimated size.
contract BoxSwapHandOffGasTest is BoxS45Base {
    /// EIP-8037 unit state costs (as BoxS45Gas).
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;
    /// swap-module § 7's size gate (P): the receiver after M1, with M3's cap ledger built or stubbed at its size.
    uint256 internal constant M1_SIZE_GATE_BYTES = 22_500;
    /// M3's cap ledger (epoch counter, room, excess routing): S5.M3 built it, so the stub is gone and the gate holds on
    /// the built code (§ 7's estimate was ≈ 1,000-1,500 bytes, I; SH-S5-swap § M3 has the measured size).
    uint256 internal constant M3_CAP_LEDGER_STUB_BYTES = 0;

    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    function setUp() public {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    function test_gas_handOff_today() public {
        _handOff(false);
    }

    function test_gas_handOff_glamsterdam() public {
        _handOff(true);
    }

    function _handOff(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        Params memory p = _standardParams(address(0));
        (p.qStream, p.tStream) = (BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_SELL_FOR_Q);
        Box memory b = _build(p);
        MockSwapModule m = MockSwapModule(payable(b.module));
        vm.deal(address(this), 100 ether);
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH}(address(0), 0);
        _report("launch with the module's initialize (mock module and coordinator)", glamsterdam, g0 - gasleft());
        _skipWindow(b);
        _closeAndGraduate(b);
        _batches(b);
        _op("pullForModule: the first (module ledgers and allowance from zero)", glamsterdam, address(m), _pull());
        _batches(b);
        _op("pullForModule: steady state (every ledger kept at 1)", glamsterdam, address(m), _pull());
        _batches(b);
        _op(
            "a step's receiver part: pull + moduleProceeds(FitQ) (+ the mock's claim transfer)",
            glamsterdam,
            address(m),
            abi.encodeCall(MockSwapModule.step, (ModuleProceedsTo.FitQ, 0.01 ether, 0.01 ether))
        );
        // The first notes and their first return write the pending and back slots from zero (once per box).
        _notes(b, m, glamsterdam, "the first");
        _batch(b);
        _op("collect with the first fees to return", glamsterdam, address(b.receiver), _collect());
        _batches(b);
        _op("pullForModule: with returned fees to hand back", glamsterdam, address(m), _pull());
        // Steady state: every note and return writes slots that are never zero again.
        _notes(b, m, glamsterdam, "steady state");
        _batch(b);
        _op(
            "collect with the module's Q and T fees and the hook's fee to return",
            glamsterdam,
            address(b.receiver),
            _collect()
        );
        _batch(b);
        _op("collect with nothing to return (the same batch)", glamsterdam, address(b.receiver), _collect());
    }

    function _notes(Box memory b, MockSwapModule m, bool glamsterdam, string memory when) internal {
        _op(
            string.concat("noteModuleFees, the module within its allowance (", when, ")"),
            glamsterdam,
            address(m),
            abi.encodeCall(MockSwapModule.note, (0.001 ether, 1e18))
        );
        vm.prank(address(b.hook));
        _op(
            string.concat("noteModuleFees, the hook's conversion fee (", when, ")"),
            glamsterdam,
            address(b.receiver),
            abi.encodeWithSignature("noteModuleFees(uint256,uint256)", 0.001 ether, 0)
        );
    }

    /// One batch the size the notes return from (0.3 ETH and 15 T of fees).
    function _batch(Box memory b) internal {
        _fees(b, 0.3 ether);
        _tFees(b, 15e18);
    }

    function _collect() internal view returns (bytes memory) {
        return abi.encodeWithSignature("collect(address)", keeper);
    }

    /// One Q batch (fundFees) and one T batch (a collect) for the module's ledgers.
    function _batches(Box memory b) internal {
        b.receiver.fundFees{value: 1.5 ether}();
        _tFees(b, 150e18);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
    }

    function _pull() internal pure returns (bytes memory) {
        return abi.encodeCall(MockSwapModule.pull, ());
    }

    function _fees(Box memory b, uint256 q) internal {
        minter.mintTo{value: q}(address(b.receiver));
    }

    function _tFees(Box memory b, uint256 t) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + t);
        funder.deposit(address(b.t), bob, t, address(b.receiver));
    }

    function _op(string memory label, bool glamsterdam, address target, bytes memory data) internal {
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        uint256 g = g0 - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        _report(label, glamsterdam, g);
    }

    function _report(string memory label, bool glamsterdam, uint256 g) internal {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        uint256 state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "S5M1|",
                label,
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(g),
                "|new slots ",
                vm.toString(c.newSlots),
                glamsterdam ? string.concat("|of which state gas ", vm.toString(state)) : ""
            ));
    }

    /// Box 0's FIT executor notes its own chunk's fee once a chunk: since S5.M1 that note runs in the receiver's cold
    /// half (one DELEGATECALL more). The same test on `main` measures the note in one half (SH-S5-swap § M1).
    function test_gas_box0ExecutorNote_today() public {
        _box0ExecutorNote(false);
    }

    function test_gas_box0ExecutorNote_glamsterdam() public {
        _box0ExecutorNote(true);
    }

    function _box0ExecutorNote(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        Box memory z = _buildAndLaunch(_box0Params());
        _skipWindow(z);
        _closeAndGraduate(z);
        vm.prank(z.executor);
        _op(
            "noteModuleFees, box 0's FIT executor (the first)",
            glamsterdam,
            address(z.receiver),
            abi.encodeWithSignature("noteModuleFees(uint256,uint256)", 0.001 ether, 0)
        );
        vm.prank(z.executor);
        _op(
            "noteModuleFees, box 0's FIT executor (a second, before a collect)",
            glamsterdam,
            address(z.receiver),
            abi.encodeWithSignature("noteModuleFees(uint256,uint256)", 0.001 ether, 0)
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-138 (M1's part): the receiver's size gate

    function test_BC138_receiverWithinTheM1SizeGate() public {
        uint256 size = address(receiverImpl).code.length;
        emit log_named_uint("S5M1S|BoxReceiver runtime bytes", size);
        emit log_named_uint("S5M1S|EIP-170 margin", 24_576 - size);
        emit log_named_uint("S5M1S|with M3's cap ledger (built in S5.M3)", size + M3_CAP_LEDGER_STUB_BYTES);
        emit log_named_uint("S5M1S|under the gate", M1_SIZE_GATE_BYTES - size);
        assertLe(size + M3_CAP_LEDGER_STUB_BYTES, M1_SIZE_GATE_BYTES, "swap-module 7: <= 22,500 bytes after M1 + M3");
        Box memory b = _build(_standardParams(address(0)));
        assertEq(address(b.receiver).code.length, 45 + 201, "the receiver clone: proxy + 201 argument bytes");
    }
}
