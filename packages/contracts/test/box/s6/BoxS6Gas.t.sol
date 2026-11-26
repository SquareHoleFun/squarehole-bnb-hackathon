// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {BoxKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {CodeScan} from "../conformance/CodeScan.sol";
import {BoxS6Base} from "./BoxS6Base.sol";

/// @notice The coordinator's gas, today (Osaka) and under Glamsterdam (`vm.setEvmVersion("amsterdam")`): `graduate()`
/// whole and per poke (for POKE_GAS), the smallest gas limit that graduates, `claimReward`, `launch` and `deploy`; and
/// its size and admin-free code (BC-069, F23 C2). Figures are `gasleft()` deltas in the caller's frame, which under
/// `amsterdam` include EIP-8037 state gas (SH-S0-spikes § 2.4 caveat 1); the state units are counted beside them.
contract BoxS6GasTest is BoxS6Base {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;

    function setUp() public {
        _setUpWorld();
    }

    // ------------------------------------------------------------------------------------------------------------
    // graduate(), whole

    function test_gas_graduate_box0_exact_today() public {
        _graduateCase(
            _box0Params(),
            false,
            false,
            false,
            "graduate: box 0 (tickets, royalty router, FIT's executor), exact close, no batch before"
        );
    }

    function test_gas_graduate_box0_exact_glamsterdam() public {
        _graduateCase(
            _box0Params(),
            false,
            false,
            true,
            "graduate: box 0 (tickets, royalty router, FIT's executor), exact close, no batch before"
        );
    }

    function test_gas_graduate_box0_traded_today() public {
        _graduateCase(_box0Params(), false, true, false, "graduate: box 0, exact close, after trades and a batch");
    }

    function test_gas_graduate_box0_traded_glamsterdam() public {
        _graduateCase(_box0Params(), false, true, true, "graduate: box 0, exact close, after trades and a batch");
    }

    function test_gas_graduate_box0_overshoot_today() public {
        _graduateCase(
            _box0Params(),
            true,
            false,
            false,
            "graduate: box 0, after an exact-input overshoot (BC-025), no batch before"
        );
    }

    function test_gas_graduate_box0_overshoot_glamsterdam() public {
        _graduateCase(
            _box0Params(),
            true,
            false,
            true,
            "graduate: box 0, after an exact-input overshoot (BC-025), no batch before"
        );
    }

    function test_gas_graduate_standard_today() public {
        _graduateCase(
            _standardParams(),
            false,
            false,
            false,
            "graduate: other box, ALL_TO_FIT, exact close, no batch before (S45's mock case)"
        );
    }

    function test_gas_graduate_standard_glamsterdam() public {
        _graduateCase(
            _standardParams(),
            false,
            false,
            true,
            "graduate: other box, ALL_TO_FIT, exact close, no batch before (S45's mock case)"
        );
    }

    function test_gas_graduate_creator_today() public {
        _graduateCase(
            _creatorWithTickets(),
            false,
            true,
            false,
            "graduate: creator box with tickets, after trades and a batch (held creator fees)"
        );
    }

    function test_gas_graduate_creator_glamsterdam() public {
        _graduateCase(
            _creatorWithTickets(),
            false,
            true,
            true,
            "graduate: creator box with tickets, after trades and a batch (held creator fees)"
        );
    }

    function _creatorWithTickets() internal view returns (Params memory p) {
        p = _creatorParams(carol);
        p.tickets = true;
        p.royalty = true;
    }

    /// @param traded trades and one batch before the close (the receiver's ledger slots exist); else only the close
    function _ready(Params memory p, bool overshoot, bool traded) internal returns (Box memory b) {
        b = _buildAndLaunch(p);
        _skipWindow(b);
        if (traded) {
            (uint256 t,) = _buy(b, alice, 1 ether, 0);
            _sell(b, alice, t / 2);
            _recv(b).collect(keeper);
        }
        _buy(b, bob, 3 * b.raise, overshoot ? 0 : b.curve.sqrtPriceLowerX96);
        assertTrue(b.hook.closed());
    }

    function _graduateCase(Params memory p, bool overshoot, bool traded, bool glamsterdam, string memory label)
        internal
    {
        Box memory b = _ready(p, overshoot, traded);
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        vm.prank(keeper);
        b.coord.graduate();
        uint256 g = g0 - gasleft();
        _report(label, glamsterdam, g);
        assertTrue(b.coord.graduated());
    }

    // ------------------------------------------------------------------------------------------------------------
    // Each poke alone (for POKE_GAS): the poke is made to fail inside graduate() (a mocked revert, no gas), then run
    // directly from a cold start in the same post-graduation state: an upper bound of what it needs inside.

    function test_gas_pokes_today() public {
        _pokes(false);
    }

    function test_gas_pokes_glamsterdam() public {
        _pokes(true);
    }

    function _pokes(bool glamsterdam) internal {
        _pokeCase(_box0Params(), false, glamsterdam, "box 0, the first batch is the final one");
        _pokeCase(_box0Params(), true, glamsterdam, "box 0, after trades and a batch");
        _pokeCase(_creatorWithTickets(), false, glamsterdam, "creator box, the first batch is the final one");
        _pokeCase(_creatorWithTickets(), true, glamsterdam, "creator box, after trades and a batch");
    }

    function _pokeCase(Params memory p, bool traded, bool glamsterdam, string memory what) internal {
        vm.setEvmVersion("cancun");
        Box memory b = _ready(p, false, traded);
        vm.mockCallRevert(b.receiver, abi.encodeWithSelector(IBoxReceiver.onGraduation.selector), "");
        vm.mockCallRevert(b.tickets, abi.encodeWithSelector(IBoxTickets.requestGraduationWord.selector), "");
        vm.mockCallRevert(b.executor, abi.encodeWithSelector(IBoxPriceAverage.poke.selector), "");
        vm.prank(keeper);
        b.coord.graduate();
        vm.clearMockedCalls();
        _roll(1);
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        _op(
            string.concat("poke: receiver.onGraduation, ", what),
            glamsterdam,
            b.receiver,
            IBoxReceiver.onGraduation.selector
        );
        _op(string.concat("poke: executor.poke, ", what), glamsterdam, b.executor, IBoxPriceAverage.poke.selector);
        _op(
            string.concat("poke: tickets.requestGraduationWord (S3 stand-in), ", what),
            glamsterdam,
            b.tickets,
            IBoxTickets.requestGraduationWord.selector
        );
        // Not a poke of graduate(): other boxes' price sampler, whose first sample after the migration starts its
        // window (an option for the founder: depth an hour earlier, at this cost to the graduation caller).
        if (b.kind != BoxKind.Box0) {
            _op(
                string.concat("not poked (option): the price sampler's first poke, ", what),
                glamsterdam,
                b.average,
                IBoxPriceAverage.poke.selector
            );
        }
    }

    function _op(string memory label, bool glamsterdam, address target, bytes4 sel) internal {
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        (bool ok,) = target.call(abi.encodeWithSelector(sel));
        uint256 g = g0 - gasleft();
        assertTrue(ok, label);
        _report(label, glamsterdam, g);
        assertLt(g, coordImpl.POKE_GAS(), "within POKE_GAS");
    }

    // ------------------------------------------------------------------------------------------------------------
    // The smallest gas limit with which graduate() succeeds (for a keeper's transaction)

    function test_gas_minimumToGraduate_today() public {
        _minimum(false);
    }

    function test_gas_minimumToGraduate_glamsterdam() public {
        _minimum(true);
    }

    function _minimum(bool glamsterdam) internal {
        for (uint256 overshoot; overshoot < 2; ++overshoot) {
            vm.setEvmVersion("cancun");
            Box memory b = _ready(_box0Params(), overshoot == 1, false);
            vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
            uint256 lo = 500_000;
            uint256 hi = 16_777_216;
            while (lo < hi) {
                uint256 mid = (lo + hi) / 2;
                uint256 snap = vm.snapshotState();
                vm.prank(keeper);
                (bool ok,) = address(b.coord).call{gas: mid}(abi.encodeWithSignature("graduate()"));
                vm.revertToState(snap);
                if (ok) hi = mid;
                else lo = mid + 1;
            }
            emit log_string(string.concat(
                    "S6G|minimum gas limit for graduate(), box 0, ",
                    overshoot == 1 ? "after an overshoot" : "exact close",
                    glamsterdam ? "|glamsterdam " : "|today ",
                    vm.toString(lo)
                ));
            assertLt(lo, 16_777_216, "fits EIP-7825's transaction cap");
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // claimReward, launch, deploy

    function test_gas_claimAndCreation_today() public {
        _claimAndCreation(false);
    }

    function test_gas_claimAndCreation_glamsterdam() public {
        _claimAndCreation(true);
    }

    function _claimAndCreation(bool glamsterdam) internal {
        Box memory b = _ready(_box0Params(), false, false);
        vm.prank(keeper);
        b.coord.graduate();
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        vm.prank(keeper);
        b.coord.claimReward(keeper);
        _report("claimReward (to an account that exists)", glamsterdam, g0 - gasleft());
        // launch and deploy of a fresh box 0 (the S3 parts are stand-ins: their own cost is S3's)
        Params memory p = _box0Params();
        Box memory c = _buildMeasured(p, glamsterdam);
        uint256 value = 0.0015 ether;
        vm.deal(address(this), address(this).balance + value);
        vm.startStateDiffRecording();
        g0 = gasleft();
        c.coord.launch{value: value}();
        _report("launch: box 0 (initialise 6, approve, curve, bootstrap; S3 stand-ins)", glamsterdam, g0 - gasleft());
    }

    /// S5 (swap-module § 7; towards BC-138's createBox row, which S7's factory measures): the whole creation of box 0
    /// and of a creator box with the swap module, side by side in this harness (the coordinator's CREATE2, `deploy`, `launch`; the S3
    /// parts are stand-ins, as above). The creator box takes CREATOR_IN_T and CREATOR_IN_Q (the coordinator CREATEs
    /// the module clone; the receiver's `initialize` calls the module's, which writes its fifth slot), tickets and a
    /// royalty router. S7's factory, not built, adds its own frame and the registry's write.
    function test_gas_creation_box0AndCreatorBox_today() public {
        _creationPair(false);
    }

    function test_gas_creation_box0AndCreatorBox_glamsterdam() public {
        _creationPair(true);
    }

    function _creationPair(bool glamsterdam) internal {
        _creation(_box0Params(), "box 0", glamsterdam);
        Params memory p = _creatorParams(carol);
        (p.qStream, p.tStream) = (BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q);
        (p.tickets, p.royalty, p.realModule) = (true, true, true);
        Box memory c =
            _creation(p, "creator box: CREATOR_IN_T, CREATOR_IN_Q, the module clone, tickets, royalties", glamsterdam);
        assertEq(IBoxReceiver(c.receiver).swapModule(), c.module, "the receiver names the CREATEd module");
        assertGt(c.module.code.length, 0, "the module clone exists");
    }

    function _creation(Params memory p, string memory what, bool glamsterdam) internal returns (Box memory b) {
        vm.setEvmVersion("cancun");
        Prepared memory x;
        (b, x) = _prepare(p);
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        _createCoordinator(b, x);
        uint256 total = g0 - gasleft();
        _report(string.concat("creation, ", what, ": coordinator CREATE2"), glamsterdam, total);
        vm.startStateDiffRecording();
        g0 = gasleft();
        address h = b.coord.deploy(x.codes, x.hookInit, b.hookSalt, p.boxId);
        uint256 g = g0 - gasleft();
        total += g;
        _report(string.concat("creation, ", what, ": deploy"), glamsterdam, g);
        require(h == address(b.hook), "hook address");
        uint256 value = BoxSpecV1.BOOTSTRAP_ETH + b.creatorBuy;
        vm.deal(address(this), address(this).balance + value);
        vm.startStateDiffRecording();
        g0 = gasleft();
        b.coord.launch{value: value}();
        g = g0 - gasleft();
        total += g;
        _report(string.concat("creation, ", what, ": launch"), glamsterdam, g);
        emit log_string(string.concat(
                "S6G|creation, ",
                what,
                ": CREATE2 + deploy + launch",
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(total)
            ));
    }

    /// @dev `_build` with the coordinator's `deploy` measured.
    function _buildMeasured(Params memory p, bool glamsterdam) internal returns (Box memory b) {
        vm.setEvmVersion("cancun");
        Prepared memory x;
        (b, x) = _prepare(p);
        _createCoordinator(b, x);
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        b.coord.deploy(x.codes, x.hookInit, b.hookSalt, 0);
        _report(
            "deploy: box 0 (T, 6 clones and FIT's executor CREATEd, the hook CREATE2d; S3 stand-ins)",
            glamsterdam,
            g0 - gasleft()
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-069 and F23 C2 for the coordinator

    function test_BC069_coordinatorSize() public {
        uint256 runtime = address(coordImpl).code.length;
        emit log_named_uint("S6G|BoxCoordinator runtime bytes", runtime);
        assertLe(runtime, 24_576, "EIP-170");
        assertLe(type(BoxCoordinator).creationCode.length, 49_152, "EIP-3860");
        Box memory b = _build(_box0Params());
        uint256 clone = address(b.coord).code.length;
        emit log_named_uint("S6G|coordinator clone bytes (45 + arguments)", clone);
        assertEq(clone, 45 + coordImpl.ARGS_LENGTH(), "EIP-1167 runtime plus the 154 argument bytes");
        assertTrue(CodeScan.isMinimalProxy(address(b.coord).code), "a plain EIP-1167 clone");
        assertEq(CodeScan.minimalProxyTarget(address(b.coord).code), address(coordImpl));
    }

    function test_C2_coordinatorHasNoPrivilegedFunction() public {
        string[17] memory denied = [
            "owner()",
            "admin()",
            "transferOwnership(address)",
            "renounceOwnership()",
            "pause()",
            "unpause()",
            "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)",
            "rescue(address,uint256)",
            "withdraw(address,uint256)",
            "sweep()",
            "setHook(address)",
            "setReceiver(address)",
            "setExecutor(address)",
            "setPokeGas(uint256)",
            "waiveHandBackFee()",
            "fail()"
        ];
        bytes memory code = address(coordImpl).code;
        uint32[] memory words = CodeScan.pushedWords(code);
        for (uint256 j; j < denied.length; ++j) {
            assertFalse(CodeScan.pushes(words, bytes4(keccak256(bytes(denied[j])))), denied[j]);
        }
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_SELFDESTRUCT), "no SELFDESTRUCT");
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_DELEGATECALL), "no DELEGATECALL");
        // No receive or fallback: plain ETH is refused.
        Box memory b = _build(_box0Params());
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(b.coord).call{value: 1}("");
        assertFalse(ok, "plain ETH refused");
        // Positive control: the scan finds what the code has.
        assertTrue(CodeScan.pushes(words, bytes4(keccak256("graduate()"))));
    }

    // ------------------------------------------------------------------------------------------------------------

    function _report(string memory label, bool glamsterdam, uint256 g) internal {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        uint256 state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "S6G|",
                label,
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(g),
                "|new slots ",
                vm.toString(c.newSlots),
                "|accounts ",
                vm.toString(c.accounts),
                glamsterdam ? string.concat("|of which state gas ", vm.toString(state)) : ""
            ));
    }
}
