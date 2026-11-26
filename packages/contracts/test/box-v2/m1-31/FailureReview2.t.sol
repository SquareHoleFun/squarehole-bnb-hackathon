// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase, BoxClones} from "./FailureTestBase.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {BoxVaultV2Args} from "../../../src/box-v2/libraries/BoxVaultV2Args.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {BoxTicketsV2Args} from "../../../src/box-v2/libraries/BoxTicketsV2Args.sol";
import {VaultFailure} from "../../../src/box-v2/libraries/VaultFailure.sol";
import {ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {ERC721} from "solmate/src/tokens/ERC721.sol";

contract FailureItems is ERC721("Items", "I") {
    constructor(address owner) {
        for (uint256 i = 1; i <= 10; ++i) {
            _mint(owner, i);
        }
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function isRevealed(uint256) external pure returns (bool) {
        return true;
    }
}

contract FailureWords {
    bytes32 public word;
    uint64 public ready;

    function request(uint256) external payable returns (uint256) {
        return 1;
    }

    function setWord(bytes32 w) external {
        word = w;
        ready = uint64(block.timestamp);
    }

    function wordOf(address, uint256) external view returns (bytes32, uint64) {
        return (word, ready);
    }
}

// Real token + vault + placeholders + coordinator + PoolManager. No library-only approximation of E/K.
contract FailureItemsTest is FailureTestBase {
    BoxVaultV2 internal realVault;
    BoxTicketsV2 internal tickets;
    FailureItems internal items;
    FailureWords internal words;
    uint256 internal frozen;

    function setUp() public override {
        super.setUp();
        realVault = BoxVaultV2(address(vault));
        items = new FailureItems(address(vault));
        words = new FailureWords();
        address adapter = address(0x777777);
        vm.etch(
            address(vault),
            BoxClones.runtime(
                address(new BoxVaultV2(address(implementation))),
                BoxVaultV2Args.encode(
                    BoxVaultV2Args.Args(address(box), address(t), address(items), adapter, address(0), 10, 100, 1)
                )
            )
        );
        vm.etch(
            adapter,
            BoxClones.runtime(
                address(new BoxTicketsV2(address(implementation))),
                BoxTicketsV2Args.encode(
                    BoxTicketsV2Args.Args(
                        address(box), address(vault), address(items), address(t), address(words), 10, 1, "Ticket", "TK"
                    )
                )
            )
        );
        tickets = BoxTicketsV2(adapter);
        vm.prank(address(box));
        realVault.initialize();
        vm.prank(address(box));
        tickets.initialize();
        _give(ALICE, SUPPLY / 2);
        vm.prank(ALICE);
        t.approve(adapter, type(uint256).max);
        vm.prank(ALICE);
        tickets.take(2, type(uint256).max, block.timestamp);
        _give(address(hook), SUPPLY / 4);
        _fund(p, address(hook), 1000);
        _expire();
    }

    function _close() internal {
        box.fail();
        (frozen,) = realVault.quoteHandBack(1);
        uint256 vaultBalance = t.balanceOf(address(vault));
        (uint256 k,) = realVault.escrowSurplus();
        assertEq(vaultBalance - k, 2 * frozen);
        assertEq(_left(), t.balanceOf(ALICE) + 2 * frozen);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function test_R28B_placeholderHandBackThenAllCoinsClaimWithZeroDust() public {
        _close();
        uint256 before = t.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 principal, uint256 fee) = tickets.handBack(_one(1), frozen, block.timestamp);
        assertEq(principal, frozen);
        assertEq(fee, 0);
        assertEq(t.balanceOf(ALICE), before + frozen);
        vm.prank(ALICE);
        tickets.handBack(_one(2), frozen, block.timestamp);
        assertEq(t.balanceOf(ALICE), _left());
        assertEq(_claim(ALICE, t.balanceOf(ALICE), ALICE), 1000);
        assertEq(_pot(), 0);
        assertEq(_left(), 0);
    }

    function testFuzz_R28B_remainingHandInEqualsTLeft(uint256 seed) public {
        _close();
        (uint256 initialK,) = realVault.escrowSurplus();
        uint256 paid;
        for (uint256 id = 1; id <= 2; ++id) {
            uint256 coins = bound(seed, 1, t.balanceOf(ALICE));
            paid += _claim(ALICE, coins, ALICE);
            assertEq(_left(), t.balanceOf(ALICE) + (3 - id) * frozen);
            vm.prank(ALICE);
            tickets.handBack(_one(id), frozen, block.timestamp);
            assertEq(_left(), t.balanceOf(ALICE) + (2 - id) * frozen);
            (uint256 k,) = realVault.escrowSurplus();
            assertEq(k, initialK);
        }
        paid += _claim(ALICE, _left(), ALICE);
        assertEq(paid, 1000);
        assertEq(_pot(), 0);
    }

    function test_R28B_feeFreeUntilLastSecondThenClosesExactly() public {
        _close();
        uint256 end = realVault.failureWindowEnds();
        vm.warp(end - 1);
        vm.prank(ALICE);
        tickets.handBack(_one(1), frozen, block.timestamp);
        vm.warp(end);
        vm.expectRevert(abi.encodeWithSelector(VaultFailure.FailureWindowClosed.selector, end));
        vm.prank(ALICE);
        tickets.handBack(_one(2), frozen, block.timestamp);
    }

    function test_R28B_noNewTakeOrDrawAndNoEarlyWordOrRelease() public {
        _close();
        vm.expectRevert();
        vm.prank(ALICE);
        tickets.take(1, type(uint256).max, block.timestamp);
        vm.expectRevert();
        vm.prank(ALICE);
        tickets.draw(type(uint256).max, block.timestamp);
        vm.expectRevert();
        tickets.requestGraduationWord();
        vm.expectRevert();
        realVault.releaseToCreator(_one(1));
    }

    function test_R28B_sharedWordThenItemPaysCreatorFrozenTAndClaim() public {
        _close();
        vm.warp(realVault.failureWindowEnds());
        tickets.requestGraduationWord();
        words.setWord(bytes32(uint256(123)));
        tickets.acceptGraduationWord();
        ItemReveal memory reveal;
        vm.prank(ALICE);
        tickets.open(1, reveal);
        assertEq(t.balanceOf(CREATOR), frozen);
        vm.prank(CREATOR);
        t.approve(address(box), frozen);
        uint256 paid = _claim(CREATOR, frozen, CREATOR);
        assertGt(paid, 0);
        assertEq(_left(), t.balanceOf(ALICE) + frozen);
    }

    function test_R28B_terminalCancellationsKeepQuoteAndConserveEscrow() public {
        _close();
        vm.warp(realVault.failureWindowEnds() + 30 days + 1);
        tickets.enterTerminal();
        vm.prank(ALICE);
        tickets.handBack(_one(1), frozen, block.timestamp);
        vm.prank(ALICE);
        tickets.handBack(_one(2), frozen, block.timestamp);
        assertEq(t.balanceOf(ALICE), _left());
        _claim(ALICE, _left(), ALICE);
        assertEq(_pot(), 0);
    }

    function test_R28B_timelyWordCanBeAcceptedLate() public {
        _close();
        vm.warp(realVault.failureWindowEnds());
        tickets.requestGraduationWord();
        words.setWord(bytes32(uint256(7)));
        vm.warp(block.timestamp + 8 days);
        tickets.acceptGraduationWord();
        vm.expectRevert();
        tickets.enterTerminal();
    }

    function test_R28B_transfersFreezeAtCutoffAndOldApprovalsExpire() public {
        _close();
        vm.prank(ALICE);
        tickets.approve(BOB, 1);
        vm.warp(realVault.failureWindowEnds());
        vm.expectRevert();
        vm.prank(BOB);
        tickets.transferFrom(ALICE, BOB, 1);
    }
}
