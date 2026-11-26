// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {CodeScan} from "../conformance/CodeScan.sol";
import {BoxDrandVectors} from "./utils/BoxDrandVectors.sol";
import {ProbeState} from "./utils/ProbeState.sol";
import {SourceCodeScan} from "./utils/SourceCodeScan.sol";

/// @notice BC-053's instance checks on a deployed drand source, in the S2 harness's shape (box conformance § 5): one
/// abstract suite, run by every provider on the source it loads (`_source()`): **local** (the pinned deployment made
/// through the canonical deployer on a local chain, `DrandSourceConformanceLocal.t.sol`) and **fork** (the same, made
/// through the real deployer on a mainnet or Sepolia fork at a pinned block, `DrandSourceFork.t.sol`; opt-in). Each
/// check runs inside `vm.snapshotState` / `vm.revertToState`, so its probes (requests, posts, warps) leave the chain as
/// it was; nothing is broadcast. On a live chain anyone may already have posted a probe's committed round or requested
/// from its labelled consumers (`makeAddr` keys are public): each probe first resets that state on its snapshot
/// (`ProbeState`, rc8 open item 78), writing nothing where nobody touched it. The checks read the source only through `IDrandSource` and its code, so S7's built
/// provider can run them on the source a factory pins. The case's map entry in
/// `packages/box-spec/conformance/coverage.v1.json` is a spec change for the next pass (this run does not edit
/// packages/box-spec; docs/evidence/SH-S9-drand-source.md).
abstract contract DrandSourceConformance is BoxDrandVectors {
    /// @dev The source under test.
    function _source() internal view virtual returns (IDrandSource);

    modifier sourceCheck() {
        uint256 snap = vm.snapshotState();
        _;
        vm.revertToState(snap);
    }

    /// BC-053 "no Chainlink VRF or other backup source exists or can be switched to": the code dispatches none of v2's
    /// Chainlink functions, makes no delegate call and cannot change its code (no SELFDESTRUCT, CALLCODE, CREATE or
    /// CREATE2), and has no constructor input or immutable that could name another source; on chains 1 and 11155111
    /// it is the pinned deployment.
    function test_BC053_drandOnly_noBackupSource() public virtual sourceCheck {
        address src = address(_source());
        assertGt(src.code.length, 0, "the source has code");
        assertFalse(CodeScan.isDelegation(src.code), "not a delegation");
        bytes memory code = SourceCodeScan.instructions(src.code);
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_DELEGATECALL), "no DELEGATECALL");
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_CALLCODE), "no CALLCODE");
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_SELFDESTRUCT), "no SELFDESTRUCT");
        assertFalse(CodeScan.hasOpcode(code, 0xf0), "no CREATE");
        assertFalse(CodeScan.hasOpcode(code, 0xf5), "no CREATE2");
        uint32[] memory words = CodeScan.pushedWords(code);
        assertTrue(CodeScan.pushes(words, IDrandSource.postRound.selector), "positive control");
        string[9] memory vrf = [
            "requestFee()",
            "request(uint256,address)",
            "rawFulfillRandomWords(uint256,uint256[])",
            "withdrawRefund(address)",
            "refundOf(address)",
            "wrapper()",
            "vrfCoordinator()",
            "vrfRequestOf(uint256)",
            "requestRandomWordsInNative(uint32,uint16,uint32,bytes)"
        ];
        for (uint256 i; i < vrf.length; ++i) {
            assertFalse(CodeScan.pushes(words, bytes4(keccak256(bytes(vrf[i])))), string.concat("Chainlink: ", vrf[i]));
        }
        assertEq(_source().MARGIN(), 12, "F54's margin");
        assertEq(_source().SILENCE(), 7 days, "F61 R4's 7 days");
        if (block.chainid == 1 || block.chainid == 11_155_111) {
            (address pin, bytes32 codeHash) = DrandSourcePins.pinned(block.chainid);
            assertEq(src, pin, "the pinned address");
            assertEq(src.codehash, codeHash, "the pinned code hash");
        }
    }

    /// BC-053 "each consumer and key gets its own word; the word comes only from the drand round fixed at the request,
    /// once anyone posts it": two boxes request the same key in one block; nothing can be posted before the round's
    /// time; after anyone posts the real round, each word is that round's randomness bound to its own (consumer, key).
    function test_BC053_wordPerConsumerAndKey_fromTheFixedRoundOnly() public virtual sourceCheck {
        IDrandSource src = _source();
        uint256 round = _localFirst();
        uint256 at = src.roundTime(round);
        address boxA = makeAddr("bc053.instance.a");
        address boxB = makeAddr("bc053.instance.b");
        ProbeState.freshRound(vm, src, round);
        ProbeState.freshRequest(vm, src, boxA, 0);
        ProbeState.freshRequest(vm, src, boxB, 0);
        vm.warp(at - 12);
        vm.prank(boxA);
        assertEq(src.request(0), round);
        vm.prank(boxB);
        assertEq(src.request(0), round);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, round, at));
        src.postRound(round, _localSig(0));
        (bytes32 w,) = src.wordOf(boxA, 0);
        assertEq(w, 0, "no word before its round");
        vm.warp(at);
        vm.prank(makeAddr("bc053.instance.anyone"));
        src.postRound(round, _localSig(0));
        bytes32 r = _boxDrand(round).randomness;
        (bytes32 wa, uint64 ra) = src.wordOf(boxA, 0);
        (bytes32 wb,) = src.wordOf(boxB, 0);
        assertEq(wa, keccak256(abi.encode(_tag(), r, keccak256(abi.encode(boxA, uint256(0))))));
        assertEq(wb, keccak256(abi.encode(_tag(), r, keccak256(abi.encode(boxB, uint256(0))))));
        assertTrue(wa != wb);
        assertEq(ra, at);
    }

    /// BC-053 "a request waits until its round is posted, and after 7 days with no word ... terminal mode": silent
    /// after 7 days without a post, and still silent after a late post.
    function test_BC053_waitsThenSilentAfterSevenDays() public virtual sourceCheck {
        IDrandSource src = _source();
        uint256 round = _localFirst() + 3;
        uint256 at = src.roundTime(round) - 12;
        address box = makeAddr("bc053.instance.silent");
        ProbeState.freshRound(vm, src, round);
        ProbeState.freshRequest(vm, src, box, 5);
        vm.warp(at);
        vm.prank(box);
        src.request(5);
        vm.warp(at + 7 days);
        assertFalse(src.isSilent(box, 5), "waits for 7 days");
        (bytes32 w,) = src.wordOf(box, 5);
        assertEq(w, 0, "no other word appears meanwhile");
        vm.warp(at + 7 days + 1);
        assertTrue(src.isSilent(box, 5));
        src.postRound(round, _localSig(3));
        assertTrue(src.isSilent(box, 5), "final");
    }

    function _tag() internal pure returns (bytes32) {
        return keccak256("squarehole.randomness.drand-quicknet");
    }
}
