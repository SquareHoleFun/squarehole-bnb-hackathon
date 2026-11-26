// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {TicketPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {BoxDrandVectors} from "../randomness/utils/BoxDrandVectors.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../conformance/core/CoreBox0Kit.sol";

abstract contract CoreBox0NeverStuckExtraBase is BoxDrandVectors {
    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    /// Box 0's source (F143: the pinned BoxBackedSource): its requests, words and clocks.
    IDrandSource internal src;
    /// The pinned DrandSource the backed source names: rounds are posted here.
    IDrandSource internal drand;
    BoxTickets internal tickets;
    uint256 internal r0;
    uint256 internal gate;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        src = IDrandSource(address(b.source()));
        drand = IDrandSource(address(b.drand()));
        vm.warp(src.roundTime(r0) - 1 days);
        string memory json = vm.readFile("test/vectors/box-spec/box-spec-v1.json");
        BoxSpecV1.BoxSpec memory spec = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        spec.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
        b.prepare(spec);
        b.create();
        a = b.addresses();
        tickets = BoxTickets(a.tickets);
        b.toClosed();
        assertLt(block.timestamp, src.roundTime(r0) - 12);
    }

    function _graduate(bool failedPoke) internal {
        vm.warp(src.roundTime(r0) - 12);
        gate = block.timestamp;
        if (failedPoke) vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "failed poke");
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        assertEq(tickets.status().wordRequestedAt, failedPoke ? 0 : gate);
    }

    function _alive(uint256 at) internal {
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, at + 7 days));
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord));
    }

    function test_lateRequestStillSavesBoxOnDayThirtyFive() public {
        _graduate(true);
        vm.warp(gate + 35 days);
        vm.prank(makeAddr("late requester"));
        tickets.requestGraduationWord();
        _alive(block.timestamp);
    }

    function test_drawRequestsMissingWordOnDayThirtyOne() public {
        _graduate(true);
        address drawer = makeAddr("late drawer");
        b.buy(drawer, b.eth(0.5 ether), 0);
        vm.prank(drawer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.warp(gate + 31 days);
        vm.prank(drawer);
        tickets.draw(type(uint256).max, block.timestamp);
        assertEq(tickets.status().wordRequestedAt, block.timestamp);
        _alive(block.timestamp);
    }

    /// @dev The first gas limit at which a cold `enterTerminal` reads the timely word, pinned for the EVM the test
    /// actually runs on: the contract's inline `evm_version`, or the one `forge test --hardfork` sets for every contract
    /// (it overrides the inline one; SH-V21-RC8-INT open item 68). Another EVM has no pin and fails.
    function expectedColdGas() internal view returns (uint256) {
        bytes32 evm = keccak256(bytes(vm.getEvmVersion()));
        if (evm == keccak256("osaka")) return 71_300;
        if (evm == keccak256("amsterdam")) return 72_600;
        revert(string.concat("no cold gas pin for ", vm.getEvmVersion()));
    }

    function test_coldLowGasCannotHideTimelyWord() public {
        _graduate(false);
        vm.warp(gate + 7 days);
        drand.postRound(r0, _localSig(0));
        vm.warp(gate + 8 days);
        bytes memory expected = abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, gate + 7 days);
        uint256 first;
        for (uint256 gasLimit = 40_000; gasLimit <= 160_000; gasLimit += 100) {
            vm.cool(address(src)); vm.cool(address(drand)); vm.cool(a.tickets); vm.cool(a.vault);
            (bool ok, bytes memory reason) = a.tickets.call{gas: gasLimit}(abi.encodeCall(tickets.enterTerminal, ()));
            assertFalse(ok, "low gas must never create a dead head");
            if (first == 0 && keccak256(reason) == keccak256(expected)) first = gasLimit;
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("first cold HeadNotDead gas", first);
        assertEq(first, expectedColdGas());
    }
}

/// forge-config: default.evm_version = "osaka"
contract CoreBox0NeverStuckExtraOsakaTest is CoreBox0NeverStuckExtraBase {}

/// forge-config: default.evm_version = "amsterdam"
contract CoreBox0NeverStuckExtraAmsterdamTest is CoreBox0NeverStuckExtraBase {}
