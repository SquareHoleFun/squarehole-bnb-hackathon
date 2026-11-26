// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";

/// @notice S5.M2's new paths, today (Osaka) and under Glamsterdam (`vm.setEvmVersion("amsterdam")`), measured as
/// BoxS45Gas's and BoxSwapHandOffGas's cold paths are: a `gasleft()` delta in this contract's frame around one call
/// (under `amsterdam` it includes EIP-8037 state gas), the slots written from zero counted from the state diff. The
/// real module's step on a graduated box at graduation's depth: the pull, the sampler's poke and reads, one bounded
/// swap, the burn or the proceeds, the fee note and the tip. And the module's EIP-170 margin (BC-138).
contract BoxSwapModuleGasTest is BoxSwapModuleBase {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;
    /// A steady step's budget (P, measured here and re-sized by S5.M4): swap-module § 7 estimated (I) ≈ 220,000-320,000
    /// gas today and ≈ 260,000-400,000 under Glamsterdam; a step whose pull also takes back both sides' returned fees
    /// measures above that (SH-S5-swap § M2), so the budget is the measured maximum rounded up.
    uint256 internal constant STEP_BUDGET_TODAY = 340_000;
    uint256 internal constant STEP_BUDGET_GLAMSTERDAM = 510_000;

    IBoxSwapModule.Action internal constant BUY = IBoxSwapModule.Action.BuyBurn;
    IBoxSwapModule.Action internal constant SELL = IBoxSwapModule.Action.SellForFit;

    function setUp() public {
        _setUpModuleWorld();
        // The tip recipient exists (an empty account receiving ETH is the caller's own cost, not the box's).
        vm.deal(keeper, 1);
    }

    function test_gas_moduleSteps_today() public {
        _steps(false);
    }

    function test_gas_moduleSteps_glamsterdam() public {
        _steps(true);
    }

    function _steps(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        Params memory p = _defaultParams();
        Box memory b = _build(p);
        vm.deal(address(this), 100 ether);
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH}(address(0), 0);
        _report("launch with the real module's initialize (mock coordinator)", glamsterdam, g0 - gasleft());
        _skipWindow(b);
        _closeAndGraduate(b);
        _feedQ(b, 30 ether);
        _feedT(b, 50_000_000e18);
        // The sampler's ring filled (8 checkpoints over about 70 minutes), so a step's poke writes no new slot.
        IBoxPriceAverage(b.average).poke();
        for (uint256 i; i < 10; ++i) {
            _roll(44);
            IBoxPriceAverage(b.average).poke();
        }
        _roll(1);
        _op("step BuyBurn, the first (module claims and T balance from zero)", glamsterdam, b, BUY, false);
        _roll(1);
        _op("step SellForFit, the first (module T claims from zero)", glamsterdam, b, SELL, false);
        _settle(b);
        _op("step BuyBurn, steady state", glamsterdam, b, BUY, true);
        _settle(b);
        _op("step SellForFit, steady state", glamsterdam, b, SELL, true);
        _op("step skipped: a second in the block (BlockLimit)", glamsterdam, b, BUY, true);
        // A collect between steps (the module's notes returned) and the next pull.
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
        _settle(b);
        _op("step BuyBurn after a collect returned its fee (pull with qBack)", glamsterdam, b, BUY, true);
        _measure("sync, nothing owed", glamsterdam, b.module, abi.encodeCall(IBoxSwapModule.sync, ()), true);
        _measure(
            "burnPending, nothing held", glamsterdam, b.module, abi.encodeCall(IBoxSwapModule.burnPending, ()), true
        );
    }

    /// The average follows the module's own steps (pokes over a few minutes, nobody else trading).
    function _settle(Box memory b) internal {
        for (uint256 i; i < 25; ++i) {
            _roll(1);
            IBoxPriceAverage(b.average).poke();
        }
        _roll(1);
    }

    function _op(string memory label, bool glamsterdam, Box memory b, IBoxSwapModule.Action a, bool steady) internal {
        uint256 g = _measure(label, glamsterdam, b.module, abi.encodeCall(IBoxSwapModule.step, (a, keeper)), steady);
        if (steady) {
            assertLe(g, glamsterdam ? STEP_BUDGET_GLAMSTERDAM : STEP_BUDGET_TODAY, "within section 7 estimate");
        }
    }

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
        if (data.length > 4 && bytes4(data) == IBoxSwapModule.step.selector && !_isBlockLimit(label)) {
            (IBoxSwapModule.Stop stop,,,) = abi.decode(ret, (IBoxSwapModule.Stop, uint256, uint256, uint256));
            assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.None), string.concat(label, ": a step ran"));
        }
    }

    function _isBlockLimit(string memory label) internal pure returns (bool) {
        return keccak256(bytes(label)) == keccak256("step skipped: a second in the block (BlockLimit)");
    }

    function _report(string memory label, bool glamsterdam, uint256 g) internal returns (uint256) {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        uint256 state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "S5M2|",
                label,
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(g),
                "|new slots ",
                vm.toString(c.newSlots),
                glamsterdam ? string.concat("|of which state gas ", vm.toString(state)) : ""
            ));
        return c.newSlots;
    }

    /// The module clone's own creation (S7 CREATEs it at a nonce): the 45-byte proxy and its 102 argument bytes.
    function test_gas_moduleCloneCreation_today() public {
        _cloneCreation(false);
    }

    function test_gas_moduleCloneCreation_glamsterdam() public {
        _cloneCreation(true);
    }

    function _cloneCreation(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        BoxSwapModule impl = new BoxSwapModule(pm);
        bytes memory init = BoxClones.initCode(
            BoxClones.runtime(
                address(impl), abi.encodePacked(alice, bob, carol, address(0), keeper, uint8(1), uint8(1))
            )
        );
        vm.startStateDiffRecording();
        uint256 g0 = gasleft();
        address c = BoxClones.create(init);
        _report("module clone creation (CREATE, 147 bytes)", glamsterdam, g0 - gasleft());
        assertEq(c.code.length, 45 + 102);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-138: what the first steps write from zero (S5 review, finding 4)

    /// The creation transaction pays the module's first storage writes (§ 6), and the receiver's `initialize` seeds the
    /// module's fee-note allowances, so a box's first steps write from zero only what no creation can pre-fill: the
    /// module's own claim balances in the PoolManager and its T balance (they hold value, so only value fills them),
    /// and, once per side, the receiver's note slot (`moduleQPending | moduleBackQ`, its T twin), whose `moduleBack*`
    /// half books real claims and keeps 1 raw unit from the first return on. No other receiver slot, none of the
    /// module's.
    function test_BC138_theFirstStepsWriteFromZeroOnlyTheModulesOwnBalancesAndTheFirstNote() public {
        Box memory b = _build(_defaultParams());
        vm.deal(address(this), 100 ether);
        b.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH}(address(0), 0);
        _skipWindow(b);
        _closeAndGraduate(b);
        _feedQ(b, 30 ether);
        _feedT(b, 50_000_000e18);
        IBoxPriceAverage(b.average).poke();
        for (uint256 i; i < 10; ++i) {
            _roll(44);
            IBoxPriceAverage(b.average).poke();
        }
        _roll(1);
        bytes32 owner = keccak256(abi.encode(b.module, uint256(4))); // PoolManager.balanceOf (slot 4)
        bytes32 qClaims = keccak256(abi.encode(uint256(0), owner));
        bytes32 tClaims = keccak256(abi.encode(uint256(uint160(address(b.t))), owner));
        vm.startStateDiffRecording();
        _m(b).step(BUY, keeper);
        NewSlots memory n = _newSlots(b, vm.stopAndReturnStateDiff());
        assertEq(n.receiver.length, 1, "the first BuyBurn: one receiver slot from zero");
        assertEq(n.receiver[0], bytes32(uint256(6)), "the first Q note (moduleQPending | moduleBackQ)");
        assertEq(n.module, 0, "none of the module's own slots");
        assertEq(n.pm.length, 2, "the module's two claim balances");
        assertTrue(
            (n.pm[0] == qClaims && n.pm[1] == tClaims) || (n.pm[0] == tClaims && n.pm[1] == qClaims),
            "the module's Q and T claims"
        );
        assertEq(n.token, 1, "the module's T balance (1 raw unit kept after the burn)");
        _roll(1);
        vm.startStateDiffRecording();
        _m(b).step(SELL, keeper);
        n = _newSlots(b, vm.stopAndReturnStateDiff());
        assertEq(n.receiver.length, 1, "the first SellForFit: one receiver slot from zero");
        assertEq(n.receiver[0], bytes32(uint256(7)), "the first T note (moduleTPending | moduleBackT)");
        assertEq(n.module, 0);
        for (uint256 i; i < n.pm.length; ++i) {
            assertTrue(n.pm[i] != qClaims && n.pm[i] != tClaims, "the pool's own state only (a first crossing)");
        }
        assertEq(n.token, 0);
    }

    struct NewSlots {
        bytes32[] receiver;
        uint256 module;
        bytes32[] pm;
        uint256 token;
    }

    /// The slots written from zero (first previous value 0, last new value non-zero; reverted writes ignored, as
    /// S0StateDiff counts them), by account: the receiver's and the PoolManager's listed, the module's and T's counted.
    function _newSlots(Box memory b, VmSafe.AccountAccess[] memory accesses) internal view returns (NewSlots memory n) {
        (address[] memory acc, bytes32[] memory slot) = _fromZero(accesses);
        uint256 nr;
        uint256 np;
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i] == address(b.receiver)) ++nr;
            else if (acc[i] == address(pm)) ++np;
        }
        (n.receiver, n.pm) = (new bytes32[](nr), new bytes32[](np));
        (nr, np) = (0, 0);
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i] == address(b.receiver)) n.receiver[nr++] = slot[i];
            else if (acc[i] == address(pm)) n.pm[np++] = slot[i];
            else if (acc[i] == b.module) ++n.module;
            else if (acc[i] == address(b.t)) ++n.token;
            else revert("a slot from zero in another contract");
        }
    }

    function _fromZero(VmSafe.AccountAccess[] memory accesses)
        internal
        pure
        returns (address[] memory acc, bytes32[] memory slot)
    {
        uint256 m;
        for (uint256 i; i < accesses.length; ++i) {
            m += accesses[i].storageAccesses.length;
        }
        address[] memory a = new address[](m);
        bytes32[] memory k = new bytes32[](m);
        bytes32[] memory first = new bytes32[](m);
        bytes32[] memory last = new bytes32[](m);
        uint256 c;
        for (uint256 i; i < accesses.length; ++i) {
            for (uint256 j; j < accesses[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = accesses[i].storageAccesses[j];
                if (!s.isWrite || s.reverted) continue;
                uint256 at = c;
                for (uint256 x; x < c; ++x) {
                    if (a[x] == s.account && k[x] == s.slot) {
                        at = x;
                        break;
                    }
                }
                if (at == c) (a[c], k[c], first[c], c) = (s.account, s.slot, s.previousValue, c + 1);
                last[at] = s.newValue;
            }
        }
        uint256 n;
        for (uint256 x; x < c; ++x) {
            if (first[x] == bytes32(0) && last[x] != bytes32(0)) ++n;
        }
        (acc, slot) = (new address[](n), new bytes32[](n));
        n = 0;
        for (uint256 x; x < c; ++x) {
            if (first[x] == bytes32(0) && last[x] != bytes32(0)) (acc[n], slot[n++]) = (a[x], k[x]);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-138 (M2's part): EIP-170

    function test_BC138_moduleWithinEip170() public {
        if (address(moduleImpl) == address(0)) moduleImpl = new BoxSwapModule(pm);
        uint256 size = address(moduleImpl).code.length;
        emit log_named_uint("S5M2S|BoxSwapModule runtime bytes", size);
        emit log_named_uint("S5M2S|EIP-170 margin", 24_576 - size);
        assertLe(size, 24_576, "EIP-170");
        // swap-module § 7 estimated 10-14 KB (I) for the whole module; M2 measured 13,483 bytes, M3 (the creator
        // conversions, their REV-16 attribution and § 13 point 7's burn) 15,663: about 1.3 KB above the estimate, 8,913
        // under EIP-170 (SH-S5-swap § M3). The S5 review bounded the point-7 burn to one sale's worth (the sell room,
        // BoxSwapBounds.sellInput): 16,570 bytes, 8,006 under EIP-170 (SH-S5-swap § Review). The bound below is that
        // measurement rounded up, as a regression guard.
        assertLe(size, 17_408, "the S5 review's measured size, rounded up to 17 KB");
        assertEq(moduleImpl.ARGS_LENGTH(), 102);
    }
}
