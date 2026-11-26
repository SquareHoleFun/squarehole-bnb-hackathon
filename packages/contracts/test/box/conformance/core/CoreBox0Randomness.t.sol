// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {DrawStatus} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "./CoreBox0Kit.sol";

/// @notice S3 x S6 x S9 end to end on box 0 built from the core v1 contracts (SH-core-wave-2): the coordinator's
/// graduation poke makes the real tickets add-on request its graduation word from box 0's pinned BoxBackedSource, which
/// requests it from the pinned DrandSource (F143); anyone posts
/// the real quicknet round (test/vectors/drand-quicknet-box.json) and the add-on accepts the word; a draw requests its
/// own word, which a later real round settles; and with no post for 7 days the add-on enters terminal mode on the
/// source's silence (BC-053's consumer side; BC-051's 7 silent days). The box is created a day before the vector rounds
/// so its graduation request lands on them. EVM Osaka (EIP-2537).
/// forge-config: default.evm_version = "osaka"
contract CoreBox0RandomnessTest is BoxDrandVectors {
    /// The backed source's drand word tag (F143: box 0's words come through the BoxBackedSource).
    bytes32 internal constant WORD_TAG = keccak256("squarehole.randomness.backed.drand-quicknet");
    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    /// Box 0's source (the BoxBackedSource, F143): requests, words, silence.
    IDrandSource internal src;
    /// The pinned DrandSource it names: rounds are posted and bounties paid here.
    IDrandSource internal drand;
    BoxTickets internal tickets;
    uint256 internal r0;

    function setUp() public {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        src = IDrandSource(address(b.source()));
        drand = IDrandSource(address(b.drand()));
        assertEq(address(BoxBackedSource(address(src)).DRAND()), address(drand), "the source names the DrandSource");
        // Start a day before the first local round, so the box's life reaches it from below.
        vm.warp(src.roundTime(r0) - 1 days);
        b.prepare(_spec());
        b.create();
        a = b.addresses();
        tickets = BoxTickets(a.tickets);
        b.toClosed();
        assertLt(block.timestamp, src.roundTime(r0) - 12, "the life so far ends before the vector rounds");
    }

    /// @dev Box 0's fixture as it is (since S8 with its per-item stream), with this build's raise (F78: the
    /// rehearsal build's is 1/10; the mainnet build's is the fixture's own).
    function _spec() internal view returns (BoxSpecV1.BoxSpec memory s) {
        string memory json = vm.readFile(BOX_SPEC_VECTORS);
        s = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
    }

    function _word(address consumer, uint256 key, bytes32 randomness) internal pure returns (bytes32) {
        return keccak256(abi.encode(WORD_TAG, randomness, keccak256(abi.encode(consumer, key))));
    }

    /// @dev graduate() 12 s before round `r0`'s time: the tickets' poke fixes exactly that round.
    function _graduateOnTheVectorRound() internal {
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        vm.prank(makeAddr("core.rnd.keeper"));
        BoxCoordinator(a.coordinator).graduate();
        (uint64 requestedAt, uint64 round) = src.requestOf(a.tickets, 0);
        assertEq(requestedAt, block.timestamp, "requested in the graduation call");
        assertEq(round, r0, "the first round at least 12 s later");
        assertGt(tickets.status().wordRequestedAt, 0);
    }

    /// BC-053 (consumer side, end to end): the word the add-on accepts is the posted round's randomness bound to
    /// (tickets, key 0), posted by anyone at the round's time; nothing earlier; then a draw's own word settles it.
    function test_BC053_graduationWordAndDrawFromThePinnedSource() public {
        _graduateOnTheVectorRound();
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        // Nobody can post the round before its time.
        vm.expectRevert();
        drand.postRound(r0, _localSig(0));
        vm.warp(src.roundTime(r0));
        vm.prank(makeAddr("core.rnd.anyone"));
        bytes32 randomness = drand.postRound(r0, _localSig(0));
        assertEq(randomness, _boxDrand(r0).randomness, "the League's published randomness");
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(a.tickets, 0, randomness), "bound to (tickets, 0)");

        // A draw after graduation: its word comes from a later round, settled by anyone's post of it.
        address drawer = makeAddr("core.rnd.drawer");
        b.buy(drawer, b.eth(0.5 ether), 0);
        vm.startPrank(drawer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.warp(src.roundTime(r0 + 3) - 12);
        uint256 ticketId = tickets.draw(type(uint256).max, block.timestamp);
        vm.stopPrank();
        (, uint64 drawRound) = src.requestOf(a.tickets, ticketId);
        assertEq(drawRound, r0 + 3, "the draw's own round");
        assertEq(uint8(tickets.drawTicket(ticketId).status), uint8(DrawStatus.Requested));
        vm.warp(src.roundTime(r0 + 3));
        drand.postRound(r0 + 3, _localSig(3));
        assertEq(tickets.settle(1), 1, "settled");
        IBoxTickets.DrawView memory v = tickets.drawTicket(ticketId);
        assertEq(uint8(v.status), uint8(DrawStatus.Settled));
        assertGe(v.itemId, BoxSpecV1.FIRST_ID);
        assertLe(v.itemId, BoxSpecV1.FIRST_ID + 4_268, "an item of box 0's 4,269");
    }

    /// F75 W3 on box 0 and the pinned source: the first draw of a round pays the round's posting (600,000 gas × the
    /// base fee); a second draw in the same block that sends the full target too, as every page must (review of
    /// sh-f75), gets it all back; whoever posts the round (here the first drawer's own page) is paid the pot and both
    /// draws settle from it.
    function test_W3_drawPaysItsRoundsPostingToItsPoster() public {
        _graduateOnTheVectorRound();
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        tickets.acceptGraduationWord();

        address drawer = makeAddr("core.rnd.drawer");
        address second = makeAddr("core.rnd.second");
        b.buy(drawer, b.eth(0.5 ether), 0);
        b.buy(second, b.eth(0.5 ether), 0);
        vm.prank(drawer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.prank(second);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);

        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        vm.fee(0.5 gwei);
        uint256 needed = DrandWords.roundTarget();
        assertEq(needed, 0.0003 ether, "600,000 gas at 0.5 gwei");
        vm.deal(drawer, 1 ether);
        vm.prank(drawer);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.BountyTooLow.selector, 0, needed));
        tickets.draw(type(uint256).max, block.timestamp);
        vm.prank(drawer);
        uint256 first = tickets.draw{value: needed}(type(uint256).max, block.timestamp);
        vm.deal(second, 1 ether);
        vm.prank(second);
        uint256 next = tickets.draw{value: needed}(type(uint256).max, block.timestamp);
        (, uint64 round) = src.requestOf(a.tickets, first);
        (, uint64 round2) = src.requestOf(a.tickets, next);
        assertEq(round, r0 + 3);
        assertEq(round2, round, "the same round, already funded");
        assertEq(src.bountyOf(round), needed, "the pot at the target");
        assertEq(second.balance, 1 ether, "the second drawer's ETH all back");
        assertEq(a.tickets.balance, 0, "nothing stays in the add-on");

        // The drawer's own page posts the round and takes the pot back; both draws settle from the one post.
        vm.warp(src.roundTime(r0 + 3));
        vm.prank(drawer);
        drand.postRound(r0 + 3, _localSig(3));
        assertEq(drand.owedTo(drawer), needed);
        uint256 before = drawer.balance;
        vm.prank(drawer);
        drand.withdrawBounty(payable(drawer));
        assertEq(drawer.balance, before + needed, "the bounty back to the drawer's page");
        assertEq(tickets.settle(5), 2, "one post settles both draws");
    }

    /// BC-051 / BC-053 (7 silent days): with no post of its round, the graduation word's request turns silent at the
    /// source after 7 days, and from then anyone can put the add-on into terminal mode; a late post changes nothing.
    function test_BC053_silentSevenDaysThenTerminal() public {
        _graduateOnTheVectorRound();
        uint256 requestedAt = block.timestamp;
        vm.warp(requestedAt + 7 days);
        assertFalse(src.isSilent(a.tickets, 0), "waits 7 days");
        vm.expectRevert();
        tickets.enterTerminal();
        vm.warp(requestedAt + 7 days + 1);
        assertTrue(src.isSilent(a.tickets, 0), "silent at the source");
        tickets.enterTerminal();
        assertGt(tickets.status().terminalAt, 0, "terminal mode");
        drand.postRound(r0, _localSig(0));
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.acceptGraduationWord();
    }
}
