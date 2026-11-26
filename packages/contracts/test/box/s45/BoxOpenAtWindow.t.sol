// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Vm} from "forge-std/Vm.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxS45Base} from "./BoxS45Base.sol";

/// @notice The launch window on the clock (DECISION-LOG F80; docs/design/open-at-clock-time.md; BC-023, BC-024): the
/// hook's gate and phase and the launch router's tax step are probed at **every second** around and inside the window,
/// for an openAt that is not on the 12-second grid of the blocks, so a step rounded up, a step counted one second early
/// or a window that ends a second early or late fails here (the review of the prototype found two such mutants that
/// whole-step probes let through: docs/evidence/SH-open-at-contracts.md § Mutants). Then real buys at the step edges,
/// and a fuzz over the creation time, openAt and the block's time against a model of the rule.
contract BoxOpenAtWindowTest is BoxS45Base {
    uint256 internal constant STEP = 12;
    uint256 internal constant WINDOW = 384;

    function setUp() public {
        _setUpWorld();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Every second

    /// openAt 67 s after the creation (5 slots and 7 s: never a block's time when blocks are 12 s apart from the
    /// creation): from 13 s before the open to 16 s after the window, every second.
    function test_BC023_everySecondAroundAndInsideTheWindow() public {
        uint256 created = block.timestamp;
        Box memory b = _boxOpeningAt(uint32(created + 67));
        uint256 open = created + 67;
        assertEq(b.hook.openAt(), open, "hook: the asked time, to the second");
        assertEq(b.router.openAt(), open, "router: the same");
        assertEq(b.hook.windowEndsAt(), open + WINDOW, "hook: 384 s later");
        uint24[32] memory table = b.router.taxTable();
        for (uint256 t = open - 13; t < open + WINDOW + 16; ++t) {
            _at(t);
            _checkSecond(b, open, table);
        }
    }

    /// The edges named one by one (they are inside the sweep above; here each says what it pins).
    function test_BC023_theEdgesOfTheWindow() public {
        uint256 open = block.timestamp + 67;
        Box memory b = _boxOpeningAt(uint32(open));
        uint24[32] memory table = b.router.taxTable();
        // The last second before the open: closed to everyone but the creation block's router.
        _at(open - 1);
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Upcoming), "open - 1: upcoming");
        _expectQuoteReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        // The open's own second: step 0.
        _at(open);
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Window), "open: the window");
        _expectQuoteTax(b, table[0], "open: step 0");
        // The last second of step 0 and the first of step 1 (rounding down, never up).
        _at(open + 11);
        _expectQuoteTax(b, table[0], "open + 11: still step 0");
        _at(open + 12);
        _expectQuoteTax(b, table[1], "open + 12: step 1");
        // The last second of step 31: still the window, 8.0565%, buys only through the router.
        _at(open + 383);
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Window), "open + 383: the window");
        _expectQuoteTax(b, table[31], "open + 383: step 31");
        assertEq(table[31], BoxSpecV1.LAUNCH_TAX_PIPS_BLOCK_31);
        _expectGate(
            b,
            alice,
            true,
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, address(b.router), open + 384)
        );
        // The first second after the window: bonding, every route, the router refuses.
        _at(open + 384);
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Bonding), "open + 384: bonding");
        _expectQuoteReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
        _expectGate(b, alice, true, "");
    }

    /// Real buys at the step edges: the tax kept and the `TaxedBuy` step are the second's step; a direct buy is refused
    /// until the window's last second and passes from the first second after it.
    function test_BC023_buysAtTheStepEdgesPayTheirStepsTax() public {
        uint256 open = block.timestamp + 67;
        Box memory b = _boxOpeningAt(uint32(open));
        uint24[32] memory table = b.router.taxTable();
        uint256[5] memory offsets = [uint256(0), 11, 12, 371, 383];
        for (uint256 i; i < offsets.length; ++i) {
            _at(open + offsets[i]);
            uint256 step = offsets[i] / STEP;
            (uint256 tax, uint256 logged) = _taxedBuy(b, 0.01 ether);
            assertEq(tax, _ceilTax(0.01 ether, table[step]), "the tax of the second's step");
            assertEq(logged, step, "TaxedBuy names the step");
            bytes memory viaRouter = _wrapped(
                address(b.hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, address(b.router), open + WINDOW)
            );
            vm.deal(bob, 1 ether);
            vm.prank(bob);
            vm.expectRevert(viaRouter);
            swapper.swap{value: 0.01 ether}(b.key, true, -0.01 ether, 0);
        }
        _at(open + WINDOW);
        (uint256 got,) = _buy(b, carol, 0.01 ether, 0);
        assertGt(got, 0, "a direct buy from the first second after the window");
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + WINDOW));
        b.router.buy{value: 0.01 ether}(0.01 ether, 0, bob, block.timestamp);
    }

    /// A missed slot (open-at-clock-time.md § 2.4, accepted by F80): on Ethereum's 12-second grid from the open, a slot
    /// nobody proposes leaves its step uncharged and the next block pays the next, lower step; a missed slot 31 (the
    /// window's last) leaves the window with 31 blocks, and the next block, slot 32, is already after it: the router
    /// refuses and every route buys at the pool fee alone. Blocks never stretch the window (that was blocks' property).
    function test_BC023_aMissedSlotSkipsItsStepAndNeverStretchesTheWindow() public {
        uint256 open = block.timestamp + 60; // on the 12-second grid of the creation block, as Sepolia's slots
        Box memory b = _boxOpeningAt(uint32(open));
        uint24[32] memory table = b.router.taxTable();
        // Slot 5 missed: the block of slot 6 pays step 6.
        _at(open + 4 * STEP);
        _expectQuoteTax(b, table[4], "slot 4: step 4");
        _at(open + 6 * STEP);
        _expectQuoteTax(b, table[6], "slot 6 after a missed slot 5: step 6, step 5 never charged");
        // Slot 31 missed: the block of slot 30 is the window's last; slot 32 is after it.
        _at(open + 30 * STEP);
        _expectQuoteTax(b, table[30], "slot 30: step 30");
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Window));
        _at(open + 32 * STEP);
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Bonding), "slot 32: after the window");
        _expectQuoteReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + WINDOW));
        _expectGate(b, alice, true, "");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fuzz: any creation time, any openAt the factory accepts (Now, a time reached, up to 14 days ahead), any second

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_BC023_theWindowFollowsTheClock(uint32 createdAt, uint8 mode, uint32 asked, uint256 probe) public {
        createdAt = uint32(bound(createdAt, BoxSpecV1.MIN_OPEN_AT, 3_000_000_000));
        vm.warp(createdAt);
        uint32 arg;
        mode = mode % 3;
        if (mode == 1) arg = uint32(bound(asked, BoxSpecV1.MIN_OPEN_AT, createdAt));
        if (mode == 2) {
            arg = uint32(bound(asked, uint256(createdAt) + 1, createdAt + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS));
        }
        uint256 open = arg <= createdAt ? uint256(createdAt) + 1 : arg;
        Box memory b = _boxOpeningAt(arg);
        assertEq(b.hook.openAt(), open, "hook: the model's open");
        assertEq(b.router.openAt(), open, "router: the model's open");
        assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Upcoming), "upcoming in the creation block");
        _at(bound(probe, uint256(createdAt) + 1, open + 2 * WINDOW));
        _checkSecond(b, open, b.router.taxTable());
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers

    /// @dev A Standard box (its router and hook; no tickets in S45) whose openAt argument is `openAt` (0 = Now).
    function _boxOpeningAt(uint32 openAt) internal returns (Box memory b) {
        Params memory p = _standardParams(address(0));
        p.openDelay = 0;
        p.openAt = openAt;
        b = _buildAndLaunch(p);
    }

    /// @dev To second `t`, in a block after the creation block (the pre-open router exception is the creation block's).
    function _at(uint256 t) internal {
        vm.roll(block.number + 1);
        vm.warp(t);
    }

    /// @dev The model at this second: the phase, the router's quote (tax of step ⌊(t − open) / 12⌋ or the refusal) and
    /// the hook's gate for a stranger's buy and sell and for the router's buy.
    function _checkSecond(Box memory b, uint256 open, uint24[32] memory table) internal {
        uint256 t = vm.getBlockTimestamp();
        if (t < open) {
            assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Upcoming), "before the open");
            _expectQuoteReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
            bytes memory notOpen = abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, open);
            _expectGate(b, alice, true, notOpen);
            _expectGate(b, alice, false, notOpen);
            _expectGate(b, address(b.router), true, notOpen);
        } else if (t < open + WINDOW) {
            assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Window), "in the window");
            _expectQuoteTax(b, table[(t - open) / STEP], "the step's tax");
            _expectGate(
                b,
                alice,
                true,
                abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, address(b.router), open + WINDOW)
            );
            _expectGate(b, alice, false, "");
            _expectGate(b, address(b.router), true, "");
        } else {
            assertEq(uint8(b.hook.phase()), uint8(BoxPhase.Bonding), "after the window");
            _expectQuoteReverts(b, abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + WINDOW));
            _expectGate(b, alice, true, "");
            _expectGate(b, alice, false, "");
            _expectGate(b, address(b.router), true, "");
        }
    }

    function _expectQuoteTax(Box memory b, uint24 pips, string memory what) internal view {
        (uint256 tax, uint256 swapIn) = b.router.quote(1 ether);
        assertEq(tax, _ceilTax(1 ether, pips), what);
        assertEq(swapIn, 1 ether - tax, what);
    }

    function _expectQuoteReverts(Box memory b, bytes memory reason) internal {
        vm.expectRevert(reason);
        b.router.quote(1 ether);
    }

    /// @dev The hook's `beforeSwap` as the PoolManager calls it, for `sender`'s buy (`zeroForOne`) or sell: passes when
    /// `reason` is empty, else reverts with it.
    function _expectGate(Box memory b, address sender, bool zeroForOne, bytes memory reason) internal {
        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne, amountSpecified: -1e15, sqrtPriceLimitX96: zeroForOne ? 4_295_128_740 : 0
        });
        vm.prank(address(pm));
        if (reason.length != 0) vm.expectRevert(reason);
        (bytes4 selector,,) = b.hook.beforeSwap(sender, b.key, params, "");
        if (reason.length == 0) assertEq(selector, IHooks.beforeSwap.selector);
    }

    function _taxedBuy(Box memory b, uint256 qIn) internal returns (uint256 tax, uint256 step) {
        vm.deal(alice, alice.balance + qIn);
        uint256 before = b.router.totalTaxCollected();
        vm.recordLogs();
        vm.prank(alice);
        b.router.buy{value: qIn}(qIn, 0, alice, block.timestamp);
        tax = b.router.totalTaxCollected() - before;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.router) && logs[i].topics[0] == IBoxLaunchRouter.TaxedBuy.selector) {
                (step,,,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
                return (tax, step);
            }
        }
        revert("no TaxedBuy");
    }

    function _ceilTax(uint256 qIn, uint256 pips) internal pure returns (uint256) {
        return (qIn * pips + 1e6 - 1) / 1e6;
    }
}
