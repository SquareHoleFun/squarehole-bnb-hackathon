// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {BoxKind, BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {TransientReentrancyGuard} from "../../../src/libraries/TransientReentrancyGuard.sol";
import {BoxS6Base} from "./BoxS6Base.sol";
import {HostileModule, IS6Coordinator, MockBoxTickets, RefusingRecipientS6} from "./BoxS6Mocks.sol";

/// @notice BC-098: graduation cannot be blocked after the close. A closed curve with a reverting, gas-burning,
/// re-entering or return-bombing receiver, tickets add-on or executor (each alone, then all at once), a contract
/// caller that refuses Q, and a `collect()` front-running `graduate()`: it succeeds every time, failing only on the
/// box's own hook, T, vault and PoolManager calls; each poke gets exactly POKE_GAS (checked to the unit in s8,
/// `Box0StreamCeiling`'s `eachPokeReceivesExactlyPokeGas`); the reward is credited once from the reserve as a claim.
contract BoxGraduationHostileTest is BoxS6Base {
    enum Target {
        Receiver,
        Tickets,
        Executor
    }

    bytes32 internal constant POKE_FAILED = keccak256("PokeFailed(address,bytes4)");

    function setUp() public {
        _setUpWorld();
    }

    // ------------------------------------------------------------------------------------------------------------
    // The matrix: target × mode × front-running collect

    function test_BC098_receiver_revert() public {
        _hostileCase(Target.Receiver, HostileModule.Mode.Revert, false);
    }

    function test_BC098_receiver_burnGas() public {
        _hostileCase(Target.Receiver, HostileModule.Mode.BurnGas, false);
    }

    function test_BC098_receiver_reenter() public {
        _hostileCase(Target.Receiver, HostileModule.Mode.Reenter, false);
    }

    function test_BC098_receiver_returnBomb() public {
        _hostileCase(Target.Receiver, HostileModule.Mode.ReturnBomb, false);
    }

    function test_BC098_receiver_revertBomb() public {
        _hostileCase(Target.Receiver, HostileModule.Mode.RevertBomb, false);
    }

    function test_BC098_tickets_revert() public {
        _hostileCase(Target.Tickets, HostileModule.Mode.Revert, false);
    }

    function test_BC098_tickets_revert_frontRunCollect() public {
        _hostileCase(Target.Tickets, HostileModule.Mode.Revert, true);
    }

    function test_BC098_tickets_burnGas() public {
        _hostileCase(Target.Tickets, HostileModule.Mode.BurnGas, false);
    }

    function test_BC098_tickets_burnGas_frontRunCollect() public {
        _hostileCase(Target.Tickets, HostileModule.Mode.BurnGas, true);
    }

    function test_BC098_tickets_reenter() public {
        _hostileCase(Target.Tickets, HostileModule.Mode.Reenter, true);
    }

    function test_BC098_tickets_revertBomb() public {
        _hostileCase(Target.Tickets, HostileModule.Mode.RevertBomb, false);
    }

    function test_BC098_executor_revert() public {
        _hostileCase(Target.Executor, HostileModule.Mode.Revert, false);
    }

    function test_BC098_executor_revert_frontRunCollect() public {
        _hostileCase(Target.Executor, HostileModule.Mode.Revert, true);
    }

    function test_BC098_executor_burnGas() public {
        _hostileCase(Target.Executor, HostileModule.Mode.BurnGas, true);
    }

    function test_BC098_executor_reenter() public {
        _hostileCase(Target.Executor, HostileModule.Mode.Reenter, false);
    }

    function test_BC098_executor_returnBomb() public {
        _hostileCase(Target.Executor, HostileModule.Mode.ReturnBomb, true);
    }

    function _hostileCase(Target target, HostileModule.Mode mode, bool frontRunCollect) internal {
        Params memory p = target == Target.Executor ? _creatorParams(carol) : _box0CountingParams();
        if (target == Target.Receiver) p.receiverMode = 1;
        if (target == Target.Tickets) (p.tickets, p.ticketsMode) = (true, 1);
        if (target == Target.Executor) p.tickets = true;
        Box memory b = _buildAndLaunch(p);
        address hostile = target == Target.Receiver ? b.receiver : (target == Target.Tickets ? b.tickets : b.executor);
        HostileModule(payable(hostile)).setMode(mode, address(b.coord));
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t / 2);
        _close(b, bob);
        if (frontRunCollect) {
            vm.prank(searcher);
            _recv(b).collect(searcher);
        }
        vm.recordLogs();
        vm.prank(keeper);
        uint256 reward = b.coord.graduate{gas: 12_000_000}();

        // It graduated, whatever the module did.
        assertTrue(b.coord.graduated(), "graduated");
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Graduated));
        assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "at P1");
        assertEq(b.vault.gateOpenedAt(), block.timestamp, "the gate opened");
        assertEq(reward, b.hook.reserveCap(), "the whole reserve");
        assertEq(b.coord.rewardOf(keeper), reward, "credited once, to the caller");
        assertEq(b.t.balanceOf(address(b.coord)), 0, "the pool share left");
        bytes4 sel = target == Target.Receiver
            ? IBoxReceiver.onGraduation.selector
            : (target == Target.Tickets ? IBoxTickets.requestGraduationWord.selector : IBoxPriceAverage.poke.selector);
        bool fails = mode == HostileModule.Mode.Revert || mode == HostileModule.Mode.BurnGas
            || mode == HostileModule.Mode.RevertBomb;
        assertEq(_pokeFailed(b, hostile, sel), fails, "PokeFailed logged exactly when the poke failed");
        // The other pokes ran.
        if (target != Target.Receiver) assertTrue(_recv(b).graduationSettled(), "the receiver settled");
        if (target != Target.Tickets && b.tickets != address(0)) {
            assertEq(MockBoxTickets(b.tickets).requester(), address(b.coord), "the word requested");
        }
        if (target != Target.Executor) assertEq(HostileModule(payable(b.executor)).pokes(), 1, "executor poked");
        if (mode == HostileModule.Mode.Reenter) {
            HostileModule h = HostileModule(payable(hostile));
            assertFalse(h.reentryGraduateSucceeded(), "no second graduation");
            assertEq(h.reentryGraduateError(), TransientReentrancyGuard.Reentrancy.selector, "refused by the lock");
            assertFalse(h.reentryClaimSucceeded(), "no claim from inside a poke");
        }
        // A failed poke is anyone's to repeat later.
        if (fails) {
            HostileModule(payable(hostile)).setMode(HostileModule.Mode.Ok, address(b.coord));
            vm.prank(alice);
            (bool ok,) = hostile.call(abi.encodeWithSelector(sel));
            assertTrue(ok, "repeated by anyone");
        }
        // And the reward is pulled.
        vm.prank(keeper);
        assertEq(b.coord.claimReward(keeper), reward);
    }

    /// @dev Box 0 with a settable price average in FIT's executor's place (it counts pokes); the hostile executor
    /// cases use another box, whose executor is an outside address.
    function _box0CountingParams() internal pure returns (Params memory p) {
        p = _box0Params();
        p.averageKind = 1;
    }

    function _pokeFailed(Box memory b, address target, bytes4 sel) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.coord) && logs[i].topics[0] == POKE_FAILED) {
                if (
                    address(uint160(uint256(logs[i].topics[1]))) == target
                        && bytes4(abi.decode(logs[i].data, (bytes32))) == sel
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    // ------------------------------------------------------------------------------------------------------------
    // All three hostile at once: enough gas always graduates; too little is refused before anything changes

    function test_BC098_allThreeBurnGas_andTheGasFloor() public {
        Params memory p = _creatorParams(carol);
        (p.receiverMode, p.tickets, p.ticketsMode) = (1, true, 1);
        Box memory b = _buildAndLaunch(p);
        HostileModule(payable(b.receiver)).setMode(HostileModule.Mode.BurnGas, address(b.coord));
        HostileModule(payable(b.tickets)).setMode(HostileModule.Mode.BurnGas, address(b.coord));
        HostileModule(payable(b.executor)).setMode(HostileModule.Mode.BurnGas, address(b.coord));
        _skipWindow(b);
        _close(b, bob);
        // Too little gas for three full budgets after the migration: refused, nothing changes.
        (bool ok, bytes memory ret) = address(b.coord).call{gas: 2_500_000}(abi.encodeWithSignature("graduate()"));
        assertFalse(ok);
        assertEq(bytes4(ret), IBoxCoordinator.GasTooLow.selector, "GasTooLow");
        assertFalse(b.coord.graduated());
        assertTrue(b.hook.closed());
        // Enough: each poke burns exactly its POKE_GAS and graduation completes (10,800,000 at F95's 2,600,000).
        vm.recordLogs();
        uint256 g0 = gasleft();
        vm.prank(keeper);
        b.coord.graduate{gas: 3 * b.coord.POKE_GAS() + 3_000_000}();
        uint256 used = g0 - gasleft();
        assertTrue(b.coord.graduated());
        assertGe(used, 3 * b.coord.POKE_GAS(), "three full budgets burned");
        // The migration and the rest besides: 639,624 today, 2,128,944 under Glamsterdam (SH-box0-stream-gas).
        assertLt(used, 3 * b.coord.POKE_GAS() + 2_500_000, "and not more than the migration besides");
        assertTrue(_pokeFailed(b, b.receiver, IBoxReceiver.onGraduation.selector));
        emit log_named_uint("graduate with three gas-burning modules, gas", used);
    }

    // ------------------------------------------------------------------------------------------------------------
    // A caller that refuses Q: graduation never pays it in the call; its claim waits for a good address

    function test_BC098_rewardRecipientRefusesQ() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, bob);
        RefusingRecipientS6 r = new RefusingRecipientS6();
        r.setBurn(true);
        uint256 reward = r.graduate(IS6Coordinator(address(b.coord)));
        assertTrue(b.coord.graduated());
        assertEq(reward, b.hook.reserveCap());
        vm.expectRevert(IBoxCoordinator.ClaimFailed.selector);
        r.claim{gas: 3_000_000}(IS6Coordinator(address(b.coord)), address(r));
        assertEq(r.claim(IS6Coordinator(address(b.coord)), carol), reward, "pulled to another address");
        assertEq(carol.balance, reward);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The pokes are fixed: graduation calls nothing a caller chooses, and only the box's own wiring

    function test_BC098_pokesGoOnlyToTheBoxsOwnWiring() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, bob);
        vm.recordLogs();
        vm.prank(keeper);
        b.coord.graduate();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Every log of the graduation comes from the box's own contracts, FIT's executor, T or the PoolManager.
        for (uint256 i; i < logs.length; ++i) {
            address e = logs[i].emitter;
            assertTrue(
                e == address(b.coord) || e == address(b.hook) || e == b.receiver || e == address(b.t)
                    || e == address(pm) || e == b.executor || e == b.tickets || e == address(b.vault),
                "only the box's own wiring"
            );
        }
        assertEq(uint256(b.kind), uint256(BoxKind.Box0));
    }
}
