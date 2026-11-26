// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandWords} from "../../../src/box/randomness/DrandWords.sol";
import {BoxDrandVectors} from "./utils/BoxDrandVectors.sol";
import {DrawQueueConsumer} from "./utils/DrawQueueConsumer.sol";

/// @notice A hostile box: a consumer contract that tries everything a box can do to another box's word.
contract HostileBox {
    IDrandSource internal immutable src;

    constructor(IDrandSource src_) {
        src = src_;
    }

    function requestKey(uint256 key) external payable returns (uint256) {
        return src.request{value: msg.value}(key);
    }

    function bounty(uint256 round) external payable {
        src.addBounty{value: msg.value}(round);
    }

    function post(uint256 round, bytes calldata sig) external returns (bool ok) {
        (ok,) = address(src).call{gas: 5_000_000}(abi.encodeCall(src.postRound, (round, sig)));
    }
}

/// @notice BC-053 (slice S9, G0, all templates): "Shared randomness stays per box (drand only)". Two boxes (two
/// tickets consumers, `DrawQueueConsumer`, the shape S3 builds) request words from one shared `DrandSource`; the
/// drand round fixed at each request is posted at once, late, or not for 7 days, by our keeper or by anyone. Checks:
/// each consumer and key gets its own word; no box can read a word early, change it or block another box's; the word
/// comes only from the round fixed at the request, once anyone posts it, and from nothing else (no Chainlink VRF or
/// other backup exists or can be switched to: `DrandSourceTest.test_surface_isTheInterfaceAndNothingElse`); a request
/// waits until its round is posted, and after 7 days without a word the box enters terminal mode (BC-051's part on
/// the source side), for good. Real quicknet rounds; EVM Osaka (EIP-2537).
/// forge-config: default.evm_version = "osaka"
contract DrandSharedRandomnessTest is BoxDrandVectors {
    /// @dev The coordinator's graduation poke budget modelled here (S6 fixes `POKE_GAS` from measurements; the word
    /// request needs about 60,000 today and about 160,000 after Glamsterdam, DrandSourceGas.t.sol).
    uint256 internal constant POKE_GAS = 250_000;

    DrandSource internal src;
    DrawQueueConsumer internal boxA;
    DrawQueueConsumer internal boxB;
    address internal keeper = makeAddr("bc053.keeper");
    address internal anyone = makeAddr("bc053.anyone");
    address internal alice = makeAddr("bc053.alice");
    address internal bob = makeAddr("bc053.bob");
    uint256 internal first;
    uint256 internal t0;

    function setUp() public {
        _loadBoxDrand();
        src = new DrandSource();
        boxA = new DrawQueueConsumer(IDrandSource(address(src)), true, POKE_GAS);
        boxB = new DrawQueueConsumer(IDrandSource(address(src)), true, POKE_GAS);
        first = _localFirst();
        t0 = src.roundTime(first);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(keeper, 10 ether);
        vm.deal(anyone, 10 ether);
        vm.fee(0.5 gwei);
    }

    // ------------------------------------------------------------------------------------------------------------
    // posted at once, by the keeper

    /// Both boxes graduate in one block: their graduation words (both key 0) share the round fixed then, and still
    /// differ; so do two draws in one block, one per box. Each word is the round's randomness bound to its own
    /// (consumer, key).
    function test_BC053_eachConsumerAndKeyGetsItsOwnWord_postedAtOnce() public {
        vm.warp(t0 - 12);
        boxA.graduate();
        boxB.graduate();
        (, uint64 roundA) = src.requestOf(address(boxA), 0);
        (, uint64 roundB) = src.requestOf(address(boxB), 0);
        assertEq(roundA, first, "the graduation poke requested the word");
        assertEq(roundB, first, "the same round for both boxes");
        vm.warp(t0);
        vm.prank(keeper);
        src.postRound(first, _localSig(0));
        boxA.acceptGraduationWord();
        boxB.acceptGraduationWord();
        bytes32 wA = boxA.graduationWord();
        bytes32 wB = boxB.graduationWord();
        assertTrue(wA != 0 && wB != 0 && wA != wB, "two words from one round");
        assertEq(wA, _word(first, address(boxA), 0));
        assertEq(wB, _word(first, address(boxB), 0));

        uint256 bounty = DrandWords.roundTarget();
        vm.prank(alice);
        uint256 ta = boxA.draw{value: bounty}();
        vm.prank(bob);
        uint256 tb = boxB.draw{value: bounty}();
        assertEq(ta, 1);
        assertEq(tb, 1, "the same key in both boxes");
        (, uint64 drawRound) = src.requestOf(address(boxA), 1);
        assertEq(drawRound, src.roundAt(t0 + 12));
        vm.warp(src.roundTime(drawRound));
        vm.prank(keeper);
        src.postRound(drawRound, _localSig(drawRound - first));
        boxA.settle(1);
        boxB.settle(1);
        bytes32 dA = boxA.drawOf(1).word;
        bytes32 dB = boxB.drawOf(1).word;
        assertTrue(dA != dB && dA != wA && dB != wB);
        assertEq(dA, _word(drawRound, address(boxA), 1));
        assertEq(dB, _word(drawRound, address(boxB), 1));
        assertEq(src.owedTo(keeper), 2 * bounty, "the keeper earned both draws' bounties");
    }

    // ------------------------------------------------------------------------------------------------------------
    // no box can read early, change or block another's

    function test_BC053_noBoxCanReadEarlyChangeOrBlockAnothersWord() public {
        HostileBox evil = new HostileBox(IDrandSource(address(src)));
        vm.deal(address(evil), 1 ether);
        // The hostile box takes box A's future keys for itself first: they are its own keys, not A's.
        vm.warp(t0 - 20);
        for (uint256 key; key < 3; ++key) {
            evil.requestKey(key);
        }
        vm.warp(t0 - 12);
        boxA.graduate();
        (uint64 at, uint64 round) = src.requestOf(address(boxA), 0);
        assertEq(at, t0 - 12, "box A's own request went through");
        assertEq(round, first);
        // Nobody can read A's word early: its round cannot be posted before its time, by anyone.
        assertFalse(evil.post(first, _localSig(0)), "too early");
        (bytes32 w,) = src.wordOf(address(boxA), 0);
        assertEq(w, 0);
        // A forged or wrong signature changes nothing.
        vm.warp(t0);
        assertFalse(evil.post(first, _localSig(1)), "another round's signature");
        bytes memory forged = bytes.concat(_localSig(0));
        forged[40] = forged[40] ^ 0x04;
        assertFalse(evil.post(first, forged), "a forged signature");
        (w,) = src.wordOf(address(boxA), 0);
        assertEq(w, 0, "still no word");
        // Bounties and posts by the hostile box only help: the post gives A exactly the round's word.
        evil.bounty{value: 0.1 ether}(first);
        assertTrue(evil.post(first, _localSig(0)), "a valid post by anyone");
        boxA.acceptGraduationWord();
        assertEq(boxA.graduationWord(), _word(first, address(boxA), 0), "the round fixed at the request, nothing else");
        // Posting other rounds or making more requests never moves A's word.
        vm.warp(t0 + 30);
        evil.post(first + 9, _localSig(9));
        evil.requestKey(77);
        (bytes32 again,) = src.wordOf(address(boxA), 0);
        assertEq(again, boxA.graduationWord());
    }

    // ------------------------------------------------------------------------------------------------------------
    // posted late, by anyone

    /// A draw whose round nobody of ours posts for three days: anyone posts it (for the bounty), and it still counts.
    function test_BC053_postedLateByAnyone_stillCounts() public {
        _bothGraduatedWithWords();
        uint256 bounty = DrandWords.roundTarget();
        vm.prank(alice);
        boxA.draw{value: bounty}();
        (uint64 requestedAt, uint64 round) = src.requestOf(address(boxA), 1);
        vm.warp(src.roundTime(round) + 1 hours);
        vm.expectRevert(DrawQueueConsumer.NothingSettled.selector);
        boxA.settle(1);
        (bytes32 w,) = src.wordOf(address(boxA), 1);
        assertEq(w, 0, "the request waits until its round is posted; no other word appears");
        vm.warp(uint256(requestedAt) + 3 days);
        vm.prank(anyone);
        src.postRound(round, _localSig(round - first));
        assertEq(src.owedTo(anyone), bounty, "the late poster takes the pot");
        assertEq(boxA.settle(1), 1);
        (bytes32 word, uint64 ready) = src.wordOf(address(boxA), 1);
        assertEq(boxA.drawOf(1).word, word);
        assertEq(ready, uint256(requestedAt) + 3 days, "readyAt is the honest posting time");
    }

    // ------------------------------------------------------------------------------------------------------------
    // silent for 7 days

    /// Box A's graduation word round is never posted: after 7 days anyone enters terminal mode in box A, for good; a
    /// late post changes nothing; box B, whose round was posted, is untouched.
    function test_BC053_silentSevenDays_boxEntersTerminalModeAlone() public {
        vm.warp(t0 - 12);
        boxB.graduate();
        vm.warp(t0 - 9);
        boxA.graduate();
        (uint64 aAt, uint64 aRound) = src.requestOf(address(boxA), 0);
        (, uint64 bRound) = src.requestOf(address(boxB), 0);
        assertTrue(aRound != bRound, "different rounds");
        vm.warp(t0);
        src.postRound(bRound, _localSig(bRound - first));
        boxB.acceptGraduationWord();

        vm.warp(uint256(aAt) + 7 days);
        vm.expectRevert(abi.encodeWithSelector(DrawQueueConsumer.HeadNotDead.selector, 0, uint256(aAt) + 7 days));
        boxA.enterTerminal();
        assertFalse(src.isSilent(address(boxA), 0));
        vm.warp(uint256(aAt) + 7 days + 1);
        assertTrue(src.isSilent(address(boxA), 0));
        vm.prank(anyone);
        boxA.enterTerminal();
        assertTrue(boxA.terminalAt() != 0);
        // The late post: honest, but neither the source nor the box counts it.
        src.postRound(aRound, _localSig(aRound - first));
        assertTrue(src.isSilent(address(boxA), 0), "silence is final");
        vm.expectRevert(DrawQueueConsumer.TerminalMode.selector);
        boxA.acceptGraduationWord();
        vm.expectRevert(DrawQueueConsumer.TerminalMode.selector);
        vm.prank(alice);
        boxA.draw{value: 1 ether}();
        // Box B goes on drawing.
        vm.prank(bob);
        boxB.draw{value: DrandWords.roundTarget()}();
        assertFalse(src.isSilent(address(boxB), 0));
        assertEq(boxB.terminalAt(), 0);
    }

    /// The same for a draw at the head of the queue: its round never posted, 7 days later the box is terminal with
    /// that ticket as the dead key; a draw behind a dead head is refused before it pays.
    function test_BC053_silentDrawHead_terminalWithItsTicket() public {
        _bothGraduatedWithWords();
        uint256 bounty = DrandWords.roundTarget();
        vm.prank(alice);
        boxA.draw{value: bounty}();
        (uint64 at,) = src.requestOf(address(boxA), 1);
        vm.warp(uint256(at) + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(DrawQueueConsumer.QueueDead.selector, 1, uint256(at) + 7 days));
        vm.prank(bob);
        boxA.draw{value: DrandWords.roundTarget()}();
        vm.expectEmit(address(boxA));
        emit DrawQueueConsumer.TerminalModeEntered(block.timestamp, 1);
        boxA.enterTerminal();
    }

    // ------------------------------------------------------------------------------------------------------------
    // the bounty in the draw price, and who earns it

    function test_BC053_drawPriceCarriesThePostingBounty() public {
        _bothGraduatedWithWords();
        uint256 needed = DrandWords.roundTarget();
        assertEq(needed, DrandWords.BOUNTY_GAS * 0.5 gwei);
        vm.expectRevert(abi.encodeWithSelector(DrandWords.BountyTooLow.selector, needed - 1, needed));
        vm.prank(alice);
        boxA.draw{value: needed - 1}();
        vm.prank(alice);
        boxA.draw{value: needed}();
        // A second draw in the same block shares the round, already funded: it may add nothing, or more.
        vm.prank(bob);
        boxA.draw();
        vm.prank(bob);
        boxB.draw{value: needed}();
        (, uint64 round) = src.requestOf(address(boxA), 2);
        (, uint64 roundB) = src.requestOf(address(boxB), 1);
        assertEq(round, roundB);
        assertEq(src.bountyOf(round), needed * 2, "one pot per round, for both boxes' draws");
        vm.warp(src.roundTime(round));
        vm.prank(anyone);
        src.postRound(round, _localSig(round - first));
        assertEq(boxA.settle(5), 2, "one post settles every draw of that round");
        assertEq(boxB.settle(5), 1);
        vm.prank(anyone);
        src.withdrawBounty(payable(anyone));
        assertEq(anyone.balance, 10 ether + needed * 2);
    }

    /// The graduation poke fails (too little gas: here a coordinator that gives it 30,000): graduation goes on, and
    /// the first draw sends the word with its own request; both share the draw's round and its one bounty.
    function test_BC053_failedPoke_firstDrawSendsTheWord() public {
        DrawQueueConsumer starved = new DrawQueueConsumer(IDrandSource(address(src)), true, 30_000);
        vm.warp(t0 - 30);
        starved.graduate();
        assertTrue(starved.gateAt() != 0, "graduated");
        assertEq(starved.wordRequestedAt(), 0, "the poke failed");
        uint256 needed = DrandWords.roundTarget();
        vm.prank(alice);
        starved.draw{value: needed}();
        (uint64 wAt, uint64 wRound) = src.requestOf(address(starved), 0);
        (uint64 dAt, uint64 dRound) = src.requestOf(address(starved), 1);
        assertEq(wAt, dAt);
        assertEq(wRound, dRound);
        assertEq(src.bountyOf(wRound), needed);
    }

    /// The poke with the modelled budget succeeds, measured for S6.
    function test_BC053_graduationPokeRequestsTheWord() public {
        vm.warp(t0 - 12);
        uint256 g = gasleft();
        boxA.graduate();
        emit log_named_uint("graduate() with the word request (consumer side, today)", g - gasleft());
        assertEq(boxA.wordRequestedAt(), t0 - 12);
    }

    // ------------------------------------------------------------------------------------------------------------

    function _bothGraduatedWithWords() internal {
        vm.warp(t0 - 12);
        boxA.graduate();
        boxB.graduate();
        vm.warp(t0);
        vm.prank(keeper);
        src.postRound(first, _localSig(0));
        boxA.acceptGraduationWord();
        boxB.acceptGraduationWord();
    }

    function _word(uint256 round, address consumer, uint256 key) internal view returns (bytes32) {
        return keccak256(abi.encode(src.WORD_TAG(), _boxDrand(round).randomness, keccak256(abi.encode(consumer, key))));
    }
}
