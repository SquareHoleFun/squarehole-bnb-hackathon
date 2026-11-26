// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {BoxTicketsV2Args} from "../../../src/box-v2/libraries/BoxTicketsV2Args.sol";
import {BoxVaultV2Args} from "../../../src/box-v2/libraries/BoxVaultV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxShuffle} from "../../../src/box/libraries/BoxShuffle.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {ItemReveal, DrawStatus} from "../../../src/box/interfaces/BoxTypes.sol";

contract TicketCoin is ERC20 {
    constructor() ERC20("T", "T", 18) { _mint(address(0xa11ce), 1_000_000); }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
contract TicketCollection {
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    function mint(address to) external {
        for (uint256 id = 1; id <= 10; id++) ownerOf[id] = to;
        balanceOf[to] = 10;
    }
    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from);
        ownerOf[id] = to; balanceOf[from]--; balanceOf[to]++;
    }
    function isRevealed(uint256) external pure returns (bool) { return true; }
    function placeholderTexts() external pure returns (string memory, bytes memory) { return ("Hidden", bytes("<svg/>")); }
}
contract TicketCoordinator {
    function effectiveOpenAt() external pure returns (uint256) { return 100; }
    function creator() external pure returns (address) { return address(0xcafe); }
}
contract TicketWords {
    struct Word { bytes32 word; uint256 at; }
    mapping(address => mapping(uint256 => Word)) private words;
    function request(uint256 key) external payable returns (uint256) { return key + 1; }
    function bountyOf(uint256) external pure returns (uint256) { return 1 ether; }
    function post(address consumer, uint256 key, bytes32 word) external { words[consumer][key] = Word(word, block.timestamp); }
    function wordOf(address consumer, uint256 key) external view returns (bytes32, uint256) {
        Word memory word = words[consumer][key]; return (word.word, word.at);
    }
}

/// @notice Real Tickets and Vault clones: metadata, permutation, draw queue, terminal picks and both custody paths.
contract CQ11TicketsBehaviorTest is Test {
    BoxTicketsV2 private tickets;
    BoxVaultV2 private vault;
    TicketCoin private coin;
    TicketCollection private collection;
    TicketWords private words;
    address private coordinator;
    address private constant ALICE = address(0xa11ce);
    address private constant CREATOR = address(0xcafe);

    function setUp() public {
        vm.warp(100);
        address implementation = address(new TicketCoordinator());
        coordinator = BoxClones.create(BoxClones.initCode(implementation, ""));
        coin = new TicketCoin(); collection = new TicketCollection(); words = new TicketWords();
        tickets = BoxTicketsV2(address(0x1111)); vault = BoxVaultV2(address(0x2222));
        vm.etch(address(tickets), BoxClones.runtime(address(new BoxTicketsV2(implementation)), BoxTicketsV2Args.encode(
            BoxTicketsV2Args.Args(coordinator, address(vault), address(collection), address(coin), address(words), 10, 1, "Placeholder", "PH")
        )));
        vm.etch(address(vault), BoxClones.runtime(address(new BoxVaultV2(implementation)), BoxVaultV2Args.encode(
            BoxVaultV2Args.Args(coordinator, address(coin), address(collection), address(tickets), address(0), 10, 100, 1)
        )));
        collection.mint(address(vault));
        vm.prank(coordinator); vault.initialize();
        vm.prank(coordinator); tickets.initialize();
        vm.prank(ALICE); coin.approve(address(tickets), type(uint256).max);
    }
    function _take(uint256 count) private {
        vm.prank(ALICE); tickets.take(count, type(uint256).max, block.timestamp);
    }
    function _assign(bytes32 word) private {
        tickets.requestGraduationWord(); words.post(address(tickets), 0, word); tickets.acceptGraduationWord();
    }
    function _open(uint256 id) private returns (uint256) {
        ItemReveal memory reveal;
        vm.prank(ALICE); return tickets.open(id, reveal);
    }

    function test_metadataAndUnknownToken() public {
        _take(1);
        assertEq(tickets.tokenURI(1), "data:application/json;base64,eyJuYW1lIjoiUGxhY2Vob2xkZXIiLCJkZXNjcmlwdGlvbiI6IkhpZGRlbiIsImltYWdlIjoiZGF0YTppbWFnZS9zdmcreG1sO2Jhc2U2NCxQSE4yWnk4KyIsImF0dHJpYnV0ZXMiOlt7InRyYWl0X3R5cGUiOiJTdGF0dXMiLCJ2YWx1ZSI6IlBsYWNlaG9sZGVyIn1dfQ==");
        vm.expectRevert(); tickets.tokenURI(99);
    }
    function test_metadataBubblesCollectionRefusal() public {
        _take(1);
        vm.mockCallRevert(address(collection), abi.encodeWithSelector(TicketCollection.placeholderTexts.selector), hex"abcd");
        vm.expectRevert(bytes(hex"abcd")); tickets.tokenURI(1);
    }
    function testFuzz_terminalPickBeforeAssignmentOrWithoutPlaceholders(bool placeholders) public {
        if (placeholders) _take(1);
        vm.prank(coordinator); vault.openGate();
        if (!placeholders) {
            vm.prank(ALICE); tickets.draw(type(uint256).max, block.timestamp);
        }
        vm.warp(block.timestamp + 30 days + 1);
        tickets.enterTerminal();
        if (!placeholders) tickets.cancelDraw(1);
        vm.warp(block.timestamp + 3 days);
        ItemReveal memory reveal;
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.IneligibleId.selector, 11));
        tickets.takeByNumber(11, 0, type(uint256).max, block.timestamp, reveal);
        vm.prank(ALICE); tickets.takeByNumber(3, 2, type(uint256).max, block.timestamp, reveal);
        assertEq(collection.ownerOf(3), ALICE);
    }
    function testFuzz_permutationAndNormalDeliveryKeepPrincipal(bytes32 word) public {
        vm.assume(word != bytes32(0));
        _take(3);
        vm.prank(coordinator); vault.openGate();
        _assign(word);
        uint256 escrow = vault.escrowPrincipal();
        uint256 balance = coin.balanceOf(address(vault));
        (uint256 u, uint256 v) = BoxShuffle.halves(10);
        for (uint256 id = 1; id <= 3; id++) {
            uint256 expected = 1 + BoxShuffle.permute(word, id - 1, 10, u, v);
            assertEq(tickets.numberOf(id), expected);
            assertEq(_open(id), expected);
            assertEq(collection.ownerOf(expected), ALICE);
        }
        assertEq(vault.escrowPrincipal(), escrow);
        assertEq(coin.balanceOf(address(vault)), balance);
        assertEq(coin.balanceOf(CREATOR), 0);
        assertEq(vault.pendingTickets(), 0);
    }
    function test_failureDeliveryPaysOnlyFrozenPrincipalToCreator() public {
        _take(2);
        vm.prank(coordinator); vault.enterFailure();
        (uint256 frozen,) = vault.quoteHandBack(1);
        vm.warp(vault.failureWindowEnds());
        _assign(bytes32(uint256(123)));
        uint256 escrow = vault.escrowPrincipal();
        uint256 balance = coin.balanceOf(address(vault));
        uint256 id = _open(1);
        assertEq(collection.ownerOf(id), ALICE);
        assertEq(vault.escrowPrincipal(), escrow - frozen);
        assertEq(coin.balanceOf(address(vault)), balance - frozen);
        assertEq(coin.balanceOf(CREATOR), frozen);
    }
    function test_compactionThenDrawQueueAndTerminalNumberPick() public {
        _take(3);
        uint256[] memory ids = new uint256[](1); ids[0] = 2;
        vm.prank(ALICE); tickets.handBack(ids, 0, block.timestamp);
        assertEq(tickets.slotOf(3), 1);
        vm.prank(coordinator); vault.openGate();
        _assign(bytes32(uint256(123)));
        vm.startPrank(ALICE);
        uint256 first = tickets.draw(type(uint256).max, block.timestamp);
        uint256 second = tickets.draw(type(uint256).max, block.timestamp);
        vm.stopPrank();
        words.post(address(tickets), second, bytes32(uint256(456)));
        vm.expectRevert(IBoxTickets.NothingSettled.selector); tickets.settle(2);
        words.post(address(tickets), first, bytes32(uint256(789)));
        assertEq(tickets.settle(2), 2);
        uint256 firstItem = tickets.drawTicket(first).itemId;
        uint256 secondItem = tickets.drawTicket(second).itemId;
        assertNotEq(firstItem, secondItem);
        assertNotEq(firstItem, tickets.numberOf(1));
        assertNotEq(secondItem, tickets.numberOf(3));
        ItemReveal memory reveal;
        vm.prank(ALICE); assertEq(tickets.openDraw(first, ALICE, reveal), firstItem);
        assertEq(tickets.drawTicket(first).status == DrawStatus.Opened, true);
        vm.prank(ALICE); uint256 silent = tickets.draw(type(uint256).max, block.timestamp);
        vm.warp(block.timestamp + 7 days + 1);
        tickets.enterTerminal(); tickets.cancelDraw(silent);
        vm.warp(block.timestamp + 3 days);
        (uint256 u, uint256 v) = BoxShuffle.halves(10);
        uint256 picked = 1 + BoxShuffle.permute(tickets.graduationWord(), tickets.poolPositionAt(0), 10, u, v);
        vm.prank(ALICE); tickets.takeByNumber(picked, 0, type(uint256).max, block.timestamp, reveal);
        assertEq(collection.ownerOf(picked), ALICE);
        uint256 taken = tickets.numberOf(1);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NumberTaken.selector, taken));
        tickets.takeByNumber(taken, 0, type(uint256).max, block.timestamp, reveal);
    }
}
