// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SepoliaBox0Reveal} from "../../../script/SepoliaBox0Reveal.s.sol";
import {SepoliaBox0TestSet} from "../../../script/lib/SepoliaBox0TestSet.sol";

/// @notice The reveal printer of box 0's Sepolia life run (`script/SepoliaBox0Reveal.s.sol`; docs/runbooks/sepolia-core-v1.md
/// § After graduation): its root is the test set's, its proofs reach that root, and the `cast` argument it prints is
/// exactly the `ItemReveal` tuple of the library's entry and proof (decimal traits, lowercase 0x-hex words, the 13
/// siblings in order), the string forge's own formatter gives. The reveal itself on a real collection is
/// `SepoliaBox0TestSetTest.testFuzz_anyIdRevealsOnTheSepoliaSpecsCollection` (the same entry and proof).
contract SepoliaBox0RevealTest is Test {
    string internal constant VECTOR = "/test/vectors/box/sepolia-box0-test-set.json";

    SepoliaBox0Reveal internal printer;

    function setUp() public {
        printer = new SepoliaBox0Reveal();
    }

    function test_theRootIsTheTestSetsRoot() public view {
        bytes32 committed = vm.parseJsonBytes32(vm.readFile(string.concat(vm.projectRoot(), VECTOR)), ".root");
        assertEq(printer.ROOT(), committed, "the vector's root");
        assertEq(printer.ROOT(), SepoliaBox0TestSet.root(), "the library's root");
    }

    /// The edges and the two items the fork rehearsal opened (a placeholder's and a draw's).
    function test_thePrintedArgumentIsTheLibrarysEntryAndProof() public view {
        uint256[4] memory ids = [uint256(1), SepoliaBox0TestSet.COUNT, 3215, 1702];
        for (uint256 k; k < ids.length; ++k) {
            _check(ids[k]);
        }
    }

    /// Any id. Few runs: each proof rebuilds the 8,192-leaf tree.
    /// forge-config: default.fuzz.runs = 4
    function testFuzz_thePrintedArgumentIsTheLibrarysEntryAndProof(uint256 seed) public view {
        _check(1 + seed % SepoliaBox0TestSet.COUNT);
    }

    function _check(uint256 id) internal view {
        (SepoliaBox0TestSet.Entry memory e, bytes32[] memory p) = printer.revealOf(id);
        SepoliaBox0TestSet.Entry memory want = SepoliaBox0TestSet.entry(id);
        assertEq(e.traitsPacked, want.traitsPacked);
        assertEq(e.salt, want.salt);
        assertEq(p.length, SepoliaBox0TestSet.DEPTH, "13 siblings");
        string memory s = string.concat(
            "(",
            vm.toString(uint256(want.traitsPacked)),
            ",",
            vm.toString(want.imageHash),
            ",",
            vm.toString(want.avatarHash),
            ",",
            vm.toString(want.modelHash),
            ",",
            vm.toString(want.salt),
            ",["
        );
        for (uint256 i; i < p.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ",", vm.toString(p[i]));
        }
        assertEq(printer.revealArg(id), string.concat(s, "])"), "the cast argument");
    }

    function test_idsOutsideTheEditionAreRefused() public {
        vm.expectRevert(abi.encodeWithSelector(SepoliaBox0TestSet.IdOutOfRange.selector, 0));
        printer.revealArg(0);
        vm.expectRevert(abi.encodeWithSelector(SepoliaBox0TestSet.IdOutOfRange.selector, 4_270));
        printer.revealArg(4_270);
    }
}
