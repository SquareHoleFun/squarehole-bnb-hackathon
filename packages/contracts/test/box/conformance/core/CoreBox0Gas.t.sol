// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PriceLimitSwapper} from "../../../research/hookgas/HookGasKit.sol";
import {S0StateDiff} from "../../../spikes/S0StateDiff.sol";
import {CoreBox0Kit, CoreBoxAddresses, CoreImpls} from "./CoreBox0Kit.sol";
import {OpenTime} from "../../utils/OpenTime.sol";

/// @notice The integrated gas table of box 0 built from the core v1 contracts (SH-core-wave-2; since S7 created by factory
/// v1 through `CoreBox0Kit`, so the creation line is the whole `createBox`), today (Osaka) and under
/// Glamsterdam (`vm.setEvmVersion("amsterdam")`), with S3's real token, collection, vault, tickets and royalty router,
/// S9's real drand source, and the S4+S5 and S6 contracts (S6 measured its graduation and creation with S3 stand-ins;
/// this re-measures them on the merged code, and the tickets' graduation poke against POKE_GAS as S6 asked). Method as
/// SH-S0-spikes § 2.4 and BoxS6Gas.t.sol: `gasleft()` deltas in the caller's frame, which under `amsterdam` include
/// EIP-8037 state gas (caveat 1), every box account cooled first (`vm.cool`) so each operation starts cold like its own
/// transaction; the new slots, accounts and code bytes are counted beside each figure (S0StateDiff). Each line is logged
/// as `CORE|<operation>|<today|glamsterdam total> <gas>|...` and collected in docs/evidence/SH-core-wave-2.md.
/// forge-config: default.evm_version = "osaka"
contract CoreBox0GasTest is Test {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;
    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    CoreImpls internal impls;

    function setUp() public {
        b = new CoreBox0Kit();
        b.setUpWorld();
        b.prepare(_spec());
        a = b.addresses();
        impls = b.impls();
    }

    /// @dev Box 0's fixture as it is (since S8 with its per-item stream), as the template-0 core provider uses, with
    /// this build's raise (F78: the rehearsal build's is 1/10; the mainnet build's is the fixture's own).
    function _spec() internal view returns (BoxSpecV1.BoxSpec memory s) {
        string memory json = vm.readFile(BOX_SPEC_VECTORS);
        s = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
    }

    // ------------------------------------------------------------------------------------------------------------
    // Creation

    function test_gas_creation_today() public {
        _creation(false);
    }

    function test_gas_creation_glamsterdam() public {
        _creation(true);
    }

    /// @dev The creation call (`BoxFactoryV1.createBox`: validate(), the planner, the coordinator's CREATE, `deploy`,
    /// `launch`, the re-reads, the registry record), measured in the kit's frame; the state units counted over it.
    function _creation(bool glamsterdam) internal {
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.startStateDiffRecording();
        b.create();
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        _line(
            "creation: createBox (factory v1, box 0 with its per-item stream, all real contracts)",
            glamsterdam,
            b.creationGas(),
            c
        );
        assertEq(BoxCoordinator(a.coordinator).hook(), a.hook);
    }

    /// F75 W1: box 0 with every Misfit trait on chain, the full round-7 table (16 types, 3,341 bytes with Character
    /// and Finish; test/vectors/box/misfits-trait-table-r7.json) instead of the fixture's one-type stand-in.
    function test_gas_creation_allTraits_today() public {
        _creationAllTraits(false);
    }

    function test_gas_creation_allTraits_glamsterdam() public {
        _creationAllTraits(true);
    }

    function _creationAllTraits(bool glamsterdam) internal {
        BoxSpecV1.BoxSpec memory s = _spec();
        s.metadataTable = vm.parseJsonBytes(vm.readFile("test/vectors/box/misfits-trait-table-r7.json"), ".table");
        assertEq(s.metadataTable.length, 3_341);
        b.prepare(s);
        a = b.addresses();
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        vm.startStateDiffRecording();
        b.create();
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        _line("creation with every Misfit trait (3,341-byte table, F75 W1)", glamsterdam, b.creationGas(), c);
        assertEq(BoxCollection(a.collection).metadataTableBytes(), s.metadataTable, "the full table on chain");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Life

    function test_gas_life_today() public {
        _life(false);
    }

    function test_gas_life_glamsterdam() public {
        _life(true);
    }

    function _life(bool glamsterdam) internal {
        string memory evm = glamsterdam ? "amsterdam" : "osaka";
        b.create();
        BoxHook hook = BoxHook(a.hook);
        OpenTime.toStep(hook.openAt(), 3);
        address buyer = makeAddr("gas.buyer");
        vm.deal(buyer, 100 ether);
        // F78: each amount at the build's scale (the rehearsal build's 1/10), fixed before the measured call.
        uint256 amt = b.eth(0.02 ether);
        // A taxed launch-router buy in the window.
        _begin(evm);
        vm.prank(buyer);
        uint256 g0 = gasleft();
        BoxLaunchRouter(payable(a.launchRouter)).buy{value: amt}(amt, 1, buyer, block.timestamp);
        _end("launch router buy in the window (0.02 ETH)", glamsterdam, g0);
        vm.setEvmVersion("osaka");
        OpenTime.to(hook.windowEndsAt());
        amt = b.eth(0.1 ether);
        // Direct buys and a sell on the curve (the swap call alone; the swapper settles for the caller).
        _begin(evm);
        g0 = gasleft();
        _swap(buyer, true, amt, 0);
        _end("curve buy, direct through the PoolManager (0.1 ETH, a T holder already)", glamsterdam, g0);
        address fresh = makeAddr("gas.fresh");
        vm.deal(fresh, 1 ether);
        _begin(evm);
        g0 = gasleft();
        _swap(fresh, true, amt, 0);
        _end("curve buy, direct (0.1 ETH, the buyer's first T)", glamsterdam, g0);
        uint256 t = BoxToken(a.token).balanceOf(fresh);
        address sw = address(b.swapper());
        vm.prank(fresh);
        BoxToken(a.token).approve(sw, type(uint256).max);
        _begin(evm);
        g0 = gasleft();
        _swap(fresh, false, t / 2, 0);
        _end("curve sell, direct (half of it)", glamsterdam, g0);
        vm.setEvmVersion("osaka");
        b.buy(buyer, b.eth(1 ether), 0);
        // A placeholder taken on the curve.
        vm.prank(buyer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        _begin(evm);
        vm.prank(buyer);
        g0 = gasleft();
        BoxTickets(a.tickets).take(1, type(uint256).max, block.timestamp);
        _end("tickets.take(1) on the curve (the first placeholder)", glamsterdam, g0);
        // The first fee batch.
        vm.setEvmVersion("osaka");
        vm.roll(block.number + 12);
        _begin(evm);
        g0 = gasleft();
        BoxReceiver(payable(a.receiver)).collect(buyer);
        _end("receiver.collect, the first batch (D2; D6 reserve topped up)", glamsterdam, g0);
        // The closing buy.
        vm.setEvmVersion("osaka");
        BoxLayoutV1.Curve memory curve = b.curve();
        address closer = makeAddr("gas.closer");
        uint256 raise = BoxCoordinator(a.coordinator).raise();
        vm.deal(closer, 3 * raise);
        _begin(evm);
        g0 = gasleft();
        _swap(closer, true, 3 * raise, curve.sqrtPriceLowerX96);
        _end("closing buy to exactly P1 (closes in its afterSwap, D1)", glamsterdam, g0);
        assertTrue(hook.closed(), "closed");
        // graduate() with the real tickets, receiver and executor behind its pokes.
        address keeper = makeAddr("gas.keeper");
        _begin(evm);
        vm.prank(keeper);
        g0 = gasleft();
        BoxCoordinator(a.coordinator).graduate();
        _end("graduate: box 0, all real pokes (receiver, tickets + drand request, FIT's executor)", glamsterdam, g0);
        assertTrue(BoxCoordinator(a.coordinator).graduated());
        // After graduation: a buy, the reward claim.
        vm.setEvmVersion("osaka");
        vm.roll(block.number + 1);
        _begin(evm);
        g0 = gasleft();
        _swap(buyer, true, amt, 0);
        _end("buy after graduation (0.1 ETH, L7 layout)", glamsterdam, g0);
        _begin(evm);
        vm.prank(keeper);
        g0 = gasleft();
        BoxCoordinator(a.coordinator).claimReward(keeper);
        _end("coordinator.claimReward", glamsterdam, g0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Each graduation poke alone, with the real contracts (S6's POKE_GAS check, re-measured on the merged code)

    function test_gas_pokes_today() public {
        _pokes(false);
    }

    function test_gas_pokes_glamsterdam() public {
        _pokes(true);
    }

    /// @dev Isolated cold costs: optional pokes revert and the stream start also reverts.
    /// F126 keeps graduation fail-safe; each failed poke can be measured independently.
    function _pokes(bool glamsterdam) internal {
        b.create();
        b.toBonding();
        BoxLayoutV1.Curve memory curve = b.curve();
        b.buy(makeAddr("gas.closer"), 3 * BoxCoordinator(a.coordinator).raise(), curve.sqrtPriceLowerX96);
        vm.mockCallRevert(a.receiver, abi.encodeWithSelector(IBoxReceiver.onGraduation.selector), "");
        vm.mockCallRevert(a.tickets, abi.encodeWithSelector(IBoxTickets.requestGraduationWord.selector), "");
        vm.mockCallRevert(a.executor, abi.encodeWithSelector(IBoxPriceAverage.poke.selector), "");
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onGraduation.selector), "");
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        vm.roll(block.number + 1);
        uint256 pokeGas = BoxCoordinator(a.coordinator).POKE_GAS();
        _poke(
            "poke: receiver.onGraduation (real receiver)",
            glamsterdam,
            a.receiver,
            IBoxReceiver.onGraduation.selector,
            pokeGas
        );
        _poke(
            "poke: tickets.requestGraduationWord (real tickets, real drand request)",
            glamsterdam,
            a.tickets,
            IBoxTickets.requestGraduationWord.selector,
            pokeGas
        );
        _poke("poke: executor.poke (FIT's executor)", glamsterdam, a.executor, IBoxPriceAverage.poke.selector, pokeGas);
        _poke(
            "poke: stream.onGraduation (S8; the receiver settled first)",
            glamsterdam,
            a.itemStream,
            IBoxItemStream.onGraduation.selector,
            pokeGas
        );
    }

    function _poke(string memory label, bool glamsterdam, address target, bytes4 sel, uint256 pokeGas) internal {
        _begin(glamsterdam ? "amsterdam" : "osaka");
        uint256 g0 = gasleft();
        (bool ok,) = target.call(abi.encodeWithSelector(sel));
        uint256 g = g0 - gasleft();
        assertTrue(ok, label);
        _endWith(label, glamsterdam, g);
        assertLt(g, pokeGas, "within POKE_GAS");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Sizes (BC-069) of every implementation and clone of the merged core, logged for the evidence table

    function test_sizes() public {
        b.create();
        address[11] memory list = [
            impls.itemStream,
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.receiverExtension,
            impls.collection,
            impls.vault,
            impls.tickets,
            impls.royaltyRouter
        ];
        string[11] memory names = [
            "BoxItemStream",
            "BoxCoordinator",
            "BoxHook",
            "BoxHookExtension",
            "BoxLaunchRouter",
            "BoxReceiver",
            "BoxReceiverExtension",
            "BoxCollection",
            "BoxVault",
            "BoxTickets",
            "BoxRoyaltyRouter"
        ];
        for (uint256 i; i < list.length; ++i) {
            emit log_string(string.concat("CORE-SIZE|", names[i], "|", vm.toString(list[i].code.length)));
            assertLe(list[i].code.length, 24_576, "EIP-170");
        }
        emit log_string(string.concat("CORE-SIZE|BoxToken (full contract)|", vm.toString(a.token.code.length)));
        emit log_string(string.concat(
                "CORE-SIZE|FitBuybackExecutor (full contract)|", vm.toString(a.executor.code.length)
            ));
        emit log_string(string.concat("CORE-SIZE|DrandSource (pinned)|", vm.toString(a.randomness.code.length)));
        address[10] memory clones = [
            a.itemStream,
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.collection,
            a.vault,
            a.tickets,
            a.royaltyRouter,
            a.table
        ];
        string[10] memory cloneNames = [
            "item stream clone",
            "coordinator clone",
            "hook clone",
            "launch router clone",
            "receiver clone",
            "collection clone (box 0 texts)",
            "vault clone",
            "tickets clone (box 0 texts)",
            "royalty router clone (receiving)",
            "metadata table data contract (fixture)"
        ];
        for (uint256 i; i < clones.length; ++i) {
            emit log_string(string.concat("CORE-SIZE|", cloneNames[i], "|", vm.toString(clones[i].code.length)));
            assertLe(clones[i].code.length, 24_576, "EIP-170");
        }
        bytes[] memory codes = b.codes();
        for (uint256 i; i < codes.length; ++i) {
            assertLe(codes[i].length, 49_152, "EIP-3860");
        }
        emit log_string(string.concat("CORE-SIZE|BoxToken creation code + args|", vm.toString(codes[1].length)));
        emit log_string(string.concat(
                "CORE-SIZE|FitBuybackExecutor creation code + args|", vm.toString(codes[6].length)
            ));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers

    /// @dev One swap through the builder's swapper as `who` (exact input; `limit` 0: the extreme price).
    function _swap(address who, bool buy, uint256 amountIn, uint160 limit) internal {
        PriceLimitSwapper sw = b.swapper();
        PoolKey memory key = b.poolKey();
        vm.prank(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        sw.swap{value: buy ? amountIn : 0}(key, buy, -int256(amountIn), limit);
    }

    function _coolAll() internal {
        address[23] memory list = [
            a.itemStream,
            a.coordinator,
            a.token,
            a.collection,
            a.vault,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.executor,
            a.table,
            a.poolManager,
            a.randomness,
            a.weth,
            address(b.swapper()),
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.vault,
            impls.tickets
        ];
        for (uint256 i; i < list.length; ++i) {
            vm.cool(list[i]);
        }
        vm.cool(impls.collection);
        vm.cool(impls.royaltyRouter);
        vm.cool(impls.receiverExtension);
        vm.cool(impls.itemStream);
    }

    function _begin(string memory evm) internal {
        vm.setEvmVersion(evm);
        _coolAll();
        vm.startStateDiffRecording();
    }

    function _end(string memory label, bool glamsterdam, uint256 g0) internal {
        _endWith(label, glamsterdam, g0 - gasleft());
    }

    function _endWith(string memory label, bool glamsterdam, uint256 g) internal {
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        _line(label, glamsterdam, g, c);
    }

    function _line(string memory label, bool glamsterdam, uint256 g, S0StateDiff.Counts memory c) internal {
        uint256 state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes
            * STATE_GAS_PER_CODE_BYTE;
        emit log_string(string.concat(
                "CORE|",
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
