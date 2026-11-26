// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ItemModel, ItemHistoryModel, ItemKit, IItemLedgerV2} from "./ItemKit.sol";
import {FundingMock, M3Claims} from "./FundingMock.sol";

contract CanonicalItemCredits {
    struct Credit { uint256 outsideP; uint256 stashP; }
    mapping(uint256 => Credit) public itemCredit;
    uint256 public immutable fundingCursor;
    uint256 public immutable lifecycleCursor;
    constructor(uint256 f, uint256 l) { fundingCursor = f; lifecycleCursor = l; }
    function setCredit(uint256 id, uint256 c, uint256 s) external { itemCredit[id] = Credit(c,s); }
}
contract WrongAccounts {
    ItemModel immutable model; bool immutable swapTickets; bytes32 immutable first; bytes32 immutable second;
    constructor(ItemModel m, bool t, bytes32 a, bytes32 b) { model = m; swapTickets = t; first = a; second = b; }
    function fundingCursor() external view returns (uint256) { return model.fundingCursor(); }
    function lifecycleCursor() external view returns (uint256) { return model.lifecycleCursor(); }
    function itemCredit(uint256 id) external view returns (uint256, uint256) {
        return model.itemCredit(!swapTickets && id <= 2 ? 3-id : id);
    }
    function ticketCredit(bytes32 id) external view returns (uint256, uint256, bool) {
        return model.ticketCredit(swapTickets ? (id == first ? second : first) : id);
    }
}
contract M303ItemKitTest is Test {
    ItemHistoryModel h; ItemModel m; bytes32[] keys;
    function setUp() public { h = new ItemHistoryModel(4,1,0); m = new ItemModel(h); }
    function compare(address actual) external view { ItemKit.compare(m,IItemLedgerV2(actual),1,4,keys); }
    function test_comparatorCanonicalIdsAndLastNft() public {
        h.graduate();
        for (uint256 id = 1; id <= 4; ++id) { h.pick(id,address(this)); h.fund(1,2,0,40); }
        m.sync(32); CanonicalItemCredits actual = new CanonicalItemCredits(5,4);
        actual.setCredit(1,40,0); actual.setCredit(2,30,10); actual.setCredit(3,20,20); actual.setCredit(4,10,30);
        this.compare(address(actual));
        actual.setCredit(4,11,30); vm.expectRevert(abi.encodeWithSelector(ItemKit.ItemMismatch.selector,4));
        this.compare(address(actual));
        actual.setCredit(4,10,31); vm.expectRevert(abi.encodeWithSelector(ItemKit.ItemMismatch.selector,4));
        this.compare(address(actual));
    }
    function test_comparatorRejectsEqualTotalsWrongItemOrTicket() public {
        bytes32 a = ItemKit.key(ItemKit.Domain.Draw,7); bytes32 b = ItemKit.key(ItemKit.Domain.Placeholder,7);
        assertTrue(a != b); keys.push(a); keys.push(b);
        h.graduate(); h.request(a); h.fund(1,2,0,40); h.request(b); h.fund(1,2,0,80); m.sync(32);
        WrongAccounts wrong = new WrongAccounts(m,true,a,b);
        vm.expectRevert(abi.encodeWithSelector(ItemKit.TicketMismatch.selector,a)); this.compare(address(wrong));
        h.deliver(b,2,address(this)); h.deliver(a,1,address(this)); m.sync(32);
        wrong = new WrongAccounts(m,false,a,b);
        vm.expectRevert(abi.encodeWithSelector(ItemKit.ItemMismatch.selector,1)); this.compare(address(wrong));
        this.compare(address(m));
    }
    function test_fundingBackedOrderedAndNoLedgerCall() public {
        M3Claims c = new M3Claims(); address p = address(0xC01); address ledger = address(new RejectCalls());
        FundingMock f = new FundingMock(c,p,ledger); c.mint(address(f),uint160(p),73);
        vm.prank(address(42)); vm.expectRevert(); f.publish(1,0,30);
        vm.expectRevert(); f.publish(2,0,30); vm.expectRevert(); f.publish(1,2,30);
        f.publish(1,0,30); f.publish(2,1,43);
        assertEq(f.funded(),73); assertEq(c.balanceOf(ledger,uint160(p)),73);
        vm.expectRevert(); f.publish(2,1,43); vm.expectRevert(); f.publish(3,0,1);
        c.mint(address(f),999,100); vm.expectRevert(); f.publish(3,0,1);
        c.mint(ledger,uint160(p),9); assertEq(f.funded(),73); f.publish(3,0,0); assertEq(f.count(),3);
    }
}
contract RejectCalls { fallback() external { revert("ledger must not be called"); } }
