// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {BoxDrandVectors} from "./utils/BoxDrandVectors.sol";

/// @notice Fuzz properties of `DrandSource` (slice S9): the round clock, the margin at any block time, words separated
/// per (consumer, key), and the bounty accounting over random requests, bounties, posts and withdrawals.
/// forge-config: default.evm_version = "osaka"
contract DrandSourceFuzzTest is BoxDrandVectors {
    DrandSource internal src;
    uint256 internal first;
    uint256 internal t0;

    function setUp() public {
        _loadBoxDrand();
        src = new DrandSource();
        first = _localFirst();
        t0 = src.roundTime(first);
    }

    /// `roundAt(t)` is the first round whose time is at or after t; `roundTime` inverts it on round times.
    function testFuzz_roundClock(uint256 t) public view {
        t = bound(t, 0, type(uint64).max);
        uint256 r = src.roundAt(t);
        assertGe(r, 1);
        assertGe(src.roundTime(r), t > src.GENESIS_TIME() ? t : src.GENESIS_TIME());
        if (r > 1) assertLt(src.roundTime(r - 1), t, "the first such round");
        assertEq(src.roundAt(src.roundTime(r)), r);
        assertEq(src.roundTime(r + 1) - src.roundTime(r), 3);
    }

    /// At any block time after quicknet's genesis, a request's round is 12 to 14 s later: strictly after the block, so
    /// nobody (the requester and the proposer included) can know the word when the request lands.
    function testFuzz_request_roundIsTwelveToFourteenSecondsLater(uint256 t, address consumer, uint256 key) public {
        t = bound(t, src.GENESIS_TIME(), type(uint64).max - 1 days);
        vm.assume(consumer != address(0));
        vm.warp(t);
        vm.prank(consumer);
        uint256 round = src.request(key);
        uint256 at = src.roundTime(round);
        assertGe(at, t + 12);
        assertLe(at, t + 14);
        (uint64 requestedAt, uint64 r) = src.requestOf(consumer, key);
        assertEq(requestedAt, t);
        assertEq(r, round);
        assertFalse(src.isSilent(consumer, key));
    }

    /// Any two different (consumer, key) pairs that share a round get different words from it.
    function testFuzz_words_separatedPerConsumerAndKey(address a, uint256 ka, address b, uint256 kb, uint256 when)
        public
    {
        vm.assume(a != address(0) && b != address(0));
        vm.assume(a != b || ka != kb);
        uint256 t = t0 - 14 + bound(when, 0, 2);
        vm.warp(t);
        vm.prank(a);
        uint256 ra = src.request(ka);
        vm.prank(b);
        uint256 rb = src.request(kb);
        assertEq(ra, rb);
        assertEq(ra, first);
        vm.warp(t0);
        src.postRound(first, _localSig(0));
        (bytes32 wa, uint64 ya) = src.wordOf(a, ka);
        (bytes32 wb, uint64 yb) = src.wordOf(b, kb);
        assertTrue(wa != 0 && wb != 0);
        assertTrue(wa != wb, "different words");
        assertEq(ya, yb, "both ready at the post");
        assertGe(ya, t + 12, "ready no earlier than the margin");
    }

    /// Random requests (with bounties) and bounties land on the 16 local rounds; random rounds are posted by random
    /// posters, who withdraw at random: the source always holds exactly the pots not posted plus the credits not
    /// withdrawn, and every wei of every pot reaches the poster of its round.
    function testFuzz_bounties_accountExactly(uint256[12] memory amounts, uint256 seed) public {
        address[3] memory posters = [makeAddr("fz.p0"), makeAddr("fz.p1"), makeAddr("fz.p2")];
        uint256[16] memory pots;
        vm.deal(address(this), 1_000 ether);
        // Requests and bounties, all before the first round's time.
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 0, 5 ether);
            uint256 idx = uint256(keccak256(abi.encode(seed, i))) % 16;
            if (i % 2 == 0) {
                // A request whose round is local round idx (from the request window's start).
                uint256 at = src.roundTime(first + idx) - 12;
                vm.warp(at);
                address consumer = address(uint160(0x1000 + i));
                vm.deal(consumer, amount);
                vm.prank(consumer);
                assertEq(src.request{value: amount}(i), first + idx);
            } else {
                src.addBounty{value: amount}(first + idx);
            }
            pots[idx] += amount;
        }
        vm.warp(t0 + 60);
        uint256[3] memory credited;
        uint256 held;
        for (uint256 idx; idx < 16; ++idx) {
            held += pots[idx];
            assertEq(src.bountyOf(first + idx), pots[idx]);
        }
        assertEq(address(src).balance, held);
        for (uint256 idx; idx < 16; ++idx) {
            uint256 who = uint256(keccak256(abi.encode(seed, "poster", idx))) % 3;
            if (uint256(keccak256(abi.encode(seed, "skip", idx))) % 4 == 0) continue; // some rounds stay unposted
            vm.prank(posters[who]);
            src.postRound(first + idx, _localSig(idx));
            credited[who] += pots[idx];
            assertEq(src.bountyOf(first + idx), 0);
            if (uint256(keccak256(abi.encode(seed, "withdraw", idx))) % 3 == 0 && src.owedTo(posters[who]) != 0) {
                uint256 owed = src.owedTo(posters[who]);
                vm.prank(posters[who]);
                assertEq(src.withdrawBounty(payable(posters[who])), owed);
            }
        }
        uint256 unposted;
        uint256 owedAll;
        for (uint256 idx; idx < 16; ++idx) {
            unposted += src.bountyOf(first + idx);
        }
        for (uint256 w; w < 3; ++w) {
            owedAll += src.owedTo(posters[w]);
            assertEq(src.owedTo(posters[w]) + posters[w].balance, credited[w], "each poster gets its rounds' pots");
        }
        assertEq(address(src).balance, unposted + owedAll, "held = unposted pots + unwithdrawn credits");
    }
}
