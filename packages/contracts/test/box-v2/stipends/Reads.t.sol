// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {BoxTokenProof} from "../../../src/box-v2/libraries/BoxTokenProof.sol";
import {BoxCollectionV2} from "../../../src/box-v2/BoxCollectionV2.sol";

contract ReadStipendsTest is M363Base {
    function test_initialHolderColdCloneHasTwiceHeadroom() public {
        _start(_menu(3, 3));
        vm.cool(address(token)); vm.cool(release.implementations[1]);
        uint256 start = gasleft();
        assertEq(token.initialHolder(), address(box));
        uint256 used = start - gasleft();
        emit log_named_uint("initialHolder cold read including assertion", used);
        assertLe(2 * used, BoxTokenProof.INITIAL_HOLDER_GAS);
        vm.cool(address(token)); vm.cool(release.implementations[1]);
        (bool ok, bytes memory ret) = address(token).staticcall{gas: BoxTokenProof.INITIAL_HOLDER_GAS / 2}(
            abi.encodeCall(token.initialHolder, ()));
        assertTrue(ok); assertEq(abi.decode(ret, (address)), address(box));
    }

    function test_wordReadWorstThreeColdSlotsFitsHalfTicketAllowance() public {
        _assertPush(release.implementations[7].code, 50_000);
        DrandSource source = new DrandSource();
        vm.warp(source.GENESIS_TIME() + 100);
        uint256 round = source.request(1);
        // Source-state fixture only: the immutable reader sees exactly a posted round's two slots.
        // Signature verification is outside this read allowance and is not substituted in production.
        bytes32 slot = keccak256(abi.encode(round, uint256(1)));
        vm.store(address(source), slot, bytes32(uint256(123)));
        vm.store(address(source), bytes32(uint256(slot) + 1), bytes32(block.timestamp + 12));
        vm.cool(address(source));
        uint256 start = gasleft();
        (bytes32 word, uint64 at) = source.wordOf(address(this), 1);
        uint256 used = start - gasleft();
        emit log_named_uint("wordOf posted cold", used);
        assertTrue(word != bytes32(0)); assertEq(at, block.timestamp + 12);
        assertLe(2 * used, 50_000);
        vm.cool(address(source));
        (bool ok, bytes memory ret) = address(source).staticcall{gas: 25_000}(
            abi.encodeCall(source.wordOf, (address(this), 1)));
        assertTrue(ok); assertEq(keccak256(ret), keccak256(abi.encode(word, at)));
    }

    // Pin the private production read cap without adding a public ABI member.
    function _assertPush(bytes memory code, uint256 expected) private pure {
        uint256 count;
        for (uint256 i; i < code.length; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                uint256 n = op - 0x5f;
                uint256 value;
                for (uint256 j = 1; j <= n && i + j < code.length; ++j) value = (value << 8) | uint8(code[i + j]);
                if (value == expected) ++count;
                i += n;
            }
        }
        require(count != 0, "production read allowance changed");
    }

    function test_observerAllowanceIsDormant() public {
        _start(_collectionSpec());
        BoxCollectionV2 collection = BoxCollectionV2(box.collection());
        assertEq(collection.OBSERVER_GAS(), 460_000);
        assertEq(collection.transferObserver(), address(0));
    }
}
