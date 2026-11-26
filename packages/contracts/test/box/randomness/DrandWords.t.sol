// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandWords} from "../../../src/box/randomness/DrandWords.sol";
import {BoxDrandVectors} from "./utils/BoxDrandVectors.sol";

/// @notice A consumer exposing the library (internal functions) against a given source.
contract WordsHarness {
    IDrandSource internal immutable src;

    constructor(IDrandSource src_) {
        src = src_;
    }

    function request(uint256 key, uint256 bounty) external payable returns (uint256) {
        return DrandWords.request(src, key, bounty);
    }

    function wordOf(uint256 key) external view returns (bytes32, uint256) {
        return DrandWords.wordOf(src, key);
    }

    function usableWord(uint256 key, uint256 requestedAt) external view returns (bytes32, uint256, bool) {
        return DrandWords.usableWord(src, key, requestedAt);
    }

    function usable(bytes32 word, uint256 readyAt, uint256 requestedAt) external view returns (bool) {
        return DrandWords.usable(word, readyAt, requestedAt);
    }

    function isDead(uint256 key, uint256 requestedAt) external view returns (bool) {
        return DrandWords.isDead(src, key, requestedAt);
    }

    function roundTarget() external view returns (uint256) {
        return DrandWords.roundTarget();
    }

    function requestFunded(uint256 key) external payable returns (uint256 round) {
        round = DrandWords.request(src, key, msg.value);
        DrandWords.checkFunded(src, round);
    }

    /// @dev A draw's request, then `payRound` (the BoxTickets rule since the review of sh-f75): the round topped up to
    /// the target, the rest to `refundTo`.
    function requestPaid(uint256 key, address refundTo) external payable returns (uint256 round, uint256 paid) {
        round = DrandWords.request(src, key, 0);
        paid = DrandWords.payRound(src, round, msg.value, refundTo);
    }

    function isDelegation(address a) external view returns (bool) {
        return DrandWords.isDelegation(a);
    }
}

contract RevertingSource {
    function wordOf(address, uint256) external pure returns (bytes32, uint64) {
        revert("down");
    }
}

contract BurningSource {
    function wordOf(address, uint256) external view returns (bytes32 w, uint64 r) {
        while (gasleft() > 0) {
            w = keccak256(abi.encode(w));
        }
        r = 1;
    }
}

contract ShortSource {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 0x1234)
            return(0, 32)
        }
    }
}

contract FarFutureSource {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 0x1234)
            mstore(32, shl(64, 1))
            return(0, 64)
        }
    }
}

contract ReturnBombSource {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 0x1234)
            mstore(32, 7)
            return(0, 20000)
        }
    }
}

/// @notice `DrandWords` (slice S9, the consumer side): the bounded read against sources that fail every way, the rule
/// a word must meet to count, the dead-head rule matching the source's `isSilent` for every timing (fuzzed), the posting
/// bounty from the base fee, and the delegation check.
/// forge-config: default.evm_version = "osaka"
contract DrandWordsTest is BoxDrandVectors {
    DrandSource internal src;
    WordsHarness internal box;
    uint256 internal first;
    uint256 internal t0;

    function setUp() public {
        _loadBoxDrand();
        src = new DrandSource();
        box = new WordsHarness(IDrandSource(address(src)));
        first = _localFirst();
        t0 = src.roundTime(first);
        vm.deal(address(this), 100 ether);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The bounded read

    function test_wordOf_readsThePinnedSourcesWord() public {
        vm.warp(t0 - 12);
        box.request(3, 0);
        (bytes32 w, uint256 r) = box.wordOf(3);
        assertEq(w, 0);
        assertEq(r, 0);
        vm.warp(t0 + 5);
        src.postRound(first, _localSig(0));
        (w, r) = box.wordOf(3);
        (bytes32 direct, uint64 directReady) = src.wordOf(address(box), 3);
        assertEq(w, direct);
        assertEq(r, directReady);
        assertEq(r, t0 + 5);
    }

    /// A source that reverts, burns its gas, answers short, names a time past 2^64 or returns a huge payload reads as
    /// "no word"; the read costs at most about `WORD_GAS`.
    function test_wordOf_hostileSourcesReadAsNoWord() public {
        address[5] memory bad = [
            address(new RevertingSource()),
            address(new BurningSource()),
            address(new ShortSource()),
            address(new FarFutureSource()),
            address(new ReturnBombSource())
        ];
        for (uint256 i; i < bad.length; ++i) {
            WordsHarness h = new WordsHarness(IDrandSource(bad[i]));
            uint256 g = gasleft();
            (bytes32 w, uint256 r) = h.wordOf(1);
            uint256 used = g - gasleft();
            if (i == 4) {
                // The bomb answers a full 64 bytes first: its word is read, only 64 bytes are copied.
                assertEq(w, bytes32(uint256(0x1234)));
                assertEq(r, 7);
            } else {
                assertEq(w, 0, vm.toString(i));
                assertEq(r, 0, vm.toString(i));
            }
            assertLt(used, DrandWords.WORD_GAS + 20_000, "bounded");
        }
    }

    /// A caller that leaves too little gas for the whole read reverts `GasTooLow`, never reads "no word".
    function test_wordOf_starvedCallerReverts() public {
        vm.expectRevert(DrandWords.GasTooLow.selector);
        box.wordOf{gas: DrandWords.WORD_GAS_REQUIRED - 1_000}(1);
        (bool ok,) = address(box).call{gas: DrandWords.WORD_GAS_REQUIRED + 5_000}(abi.encodeCall(box.wordOf, (1)));
        assertTrue(ok, "with the required gas it reads");
    }

    // ------------------------------------------------------------------------------------------------------------
    // The rule a word must meet

    function test_usable_boundaries() public {
        uint256 at = 1_800_000_000;
        vm.warp(at + 10 days);
        bytes32 w = keccak256("w");
        assertTrue(box.usable(w, at, at), "ready at the request itself (not reachable through the source)");
        assertTrue(box.usable(w, at + 7 days, at), "ready at the deadline");
        assertFalse(box.usable(w, at + 7 days + 1, at), "ready after the deadline");
        assertFalse(box.usable(w, at - 1, at), "ready before the request");
        assertFalse(box.usable(bytes32(0), at + 1, at), "zero word");
        vm.warp(at + 1 days);
        assertFalse(box.usable(w, at + 2 days, at), "ready in the future");
    }

    /// For a request made through the source, `isDead` (the consumer's head rule) equals `isSilent` (the source's), for
    /// every posting time (never, early, at the deadline, late) and every moment checked.
    function testFuzz_isDead_equalsIsSilent(uint256 requestOffset, uint256 postDelay, bool posted, uint256 checkDelay)
        public
    {
        uint256 at = t0 - 14 + bound(requestOffset, 0, 47);
        vm.warp(at);
        uint256 round = box.request(1, 0);
        assertGe(round, first);
        assertLe(round, first + 15);
        uint256 roundAt = src.roundTime(round);
        uint256 postAt = roundAt + bound(postDelay, 0, 9 days);
        if (posted) {
            vm.warp(postAt);
            src.postRound(round, _localSig(round - first));
        }
        uint256 checkAt = (posted ? postAt : at) + bound(checkDelay, 0, 20 days);
        vm.warp(checkAt);
        bool silent = src.isSilent(address(box), 1);
        assertEq(box.isDead(1, at), silent, "the consumer's rule is the source's");
        (,, bool ok) = box.usableWord(1, at);
        if (checkAt > at + 7 days) assertEq(silent, !ok, "past the deadline: silent iff no word counts");
        else assertFalse(silent, "within 7 days nothing is silent");
    }

    // ------------------------------------------------------------------------------------------------------------
    // The posting bounty in the draw price

    function test_roundTarget_isTheBaseFeeTimesTheBountyGas() public {
        vm.fee(0.2 gwei);
        assertEq(box.roundTarget(), DrandWords.BOUNTY_GAS * 0.2 gwei);
        vm.fee(0);
        assertEq(box.roundTarget(), 0, "no base fee, no target");
    }

    /// A draw must leave its round's pot at the target: the first in a round pays it, the next in the same block finds
    /// it funded and may send nothing; a short one reverts with the pot and the target.
    function test_checkFunded_theRoundsPotMustReachTheTarget() public {
        vm.fee(1 gwei);
        uint256 target = DrandWords.BOUNTY_GAS * 1 gwei;
        vm.warp(t0 - 12);
        vm.expectRevert(abi.encodeWithSelector(DrandWords.BountyTooLow.selector, target - 1, target));
        box.requestFunded{value: target - 1}(1);
        uint256 round = box.requestFunded{value: target}(1);
        assertEq(src.bountyOf(round), target);
        assertEq(box.requestFunded(2), round, "the same round, already funded");
        // Someone topped up a later round beforehand (our keeper): its first draw needs nothing.
        src.addBounty{value: target}(first + 5);
        vm.warp(src.roundTime(first + 5) - 12);
        assertEq(box.requestFunded(3), first + 5);
    }

    /// `payRound` (review of sh-f75): the round's pot is topped up to the target and the rest of the value goes back;
    /// the next draw of the round, sending the full target as a page must, gets all of it back; a value that cannot
    /// reach the target reverts with what the pot would hold and the target; a funded round refunds everything.
    function test_payRound_topsUpToTheTargetAndRefundsTheRest() public {
        vm.fee(1 gwei);
        uint256 target = DrandWords.BOUNTY_GAS * 1 gwei;
        address payer = makeAddr("payer");
        vm.deal(payer, 1 ether);
        vm.warp(t0 - 12);
        vm.expectRevert(abi.encodeWithSelector(DrandWords.BountyTooLow.selector, target - 1, target));
        box.requestPaid{value: target - 1}(1, payer);
        (uint256 round, uint256 paid) = box.requestPaid{value: 3 * target}(1, payer);
        assertEq(paid, target);
        assertEq(src.bountyOf(round), target);
        assertEq(payer.balance, 1 ether + 2 * target, "the rest back");
        (uint256 round2, uint256 paid2) = box.requestPaid{value: target}(2, payer);
        assertEq(round2, round, "the same round");
        assertEq(paid2, 0);
        assertEq(src.bountyOf(round), target, "the pot unchanged");
        assertEq(payer.balance, 1 ether + 3 * target, "all back");
        assertEq(address(box).balance, 0, "nothing stays with the consumer");
    }

    /// A refund the recipient refuses joins the pot: the draw still goes through.
    function test_payRound_aRefusedRefundJoinsThePot() public {
        vm.fee(1 gwei);
        uint256 target = DrandWords.BOUNTY_GAS * 1 gwei;
        address refuser = address(new RevertingSource());
        vm.warp(t0 - 12);
        (uint256 round, uint256 paid) = box.requestPaid{value: target + 5}(1, refuser);
        assertEq(paid, target + 5, "all of it into the pot");
        assertEq(src.bountyOf(round), target + 5);
        (, uint256 paid2) = box.requestPaid{value: 7}(2, refuser);
        assertEq(paid2, 7);
        assertEq(src.bountyOf(round), target + 12);
        assertEq(address(box).balance, 0, "nothing stays with the consumer");
    }

    /// The bounty goes with the request into its round's pot and to whoever posts that round.
    function test_request_carriesTheBountyToThePoster() public {
        vm.warp(t0 - 12);
        uint256 round = box.request{value: 0.001 ether}(1, 0.001 ether);
        assertEq(src.bountyOf(round), 0.001 ether);
        vm.warp(t0);
        address poster = makeAddr("poster");
        vm.prank(poster);
        src.postRound(round, _localSig(0));
        assertEq(src.owedTo(poster), 0.001 ether);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Delegations

    function test_isDelegation() public {
        address eoa = makeAddr("eoa");
        assertFalse(box.isDelegation(eoa));
        assertFalse(box.isDelegation(address(src)));
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(src)));
        assertTrue(box.isDelegation(eoa));
        address other = makeAddr("23 bytes of code");
        vm.etch(other, abi.encodePacked(hex"600100", address(src)));
        assertFalse(box.isDelegation(other), "23 bytes, not the designator's prefix");
    }
}
