// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ItemNotices, NoticeProbe, IItemLedgerCalls} from "./ItemNotices.sol";
import {ItemModel, ItemHistoryModel, ItemKit} from "./ItemKit.sol";
import {BoxSpecV2} from "../../../../src/box-v2/BoxSpecV2.sol";

contract M303ItemNoticesTest is Test {
    uint256 constant FIRST_ID = BoxSpecV2.FIRST_ID;
    ItemNotices driver;
    NoticeProbe probe;
    function setUp() public { driver = new ItemNotices(); probe = new NoticeProbe(address(driver)); }
    function notice(uint256 i) internal view returns (bytes memory) {
        uint256[] memory ids = new uint256[](1); ids[0] = FIRST_ID;
        if (i == 0) return abi.encodeCall(IItemLedgerCalls.onTicketsOpened, (1, 4));
        if (i == 1) return abi.encodeCall(IItemLedgerCalls.onTicketsReleased, (address(this), 1, 3, 7));
        if (i == 2) return abi.encodeCall(IItemLedgerCalls.onWithdrawn, (address(this), ids));
        if (i == 3) return abi.encodeCall(IItemLedgerCalls.onReturned, (address(this), ids));
        return abi.encodeCall(IItemLedgerCalls.onDelivered, (FIRST_ID, address(this), uint64(block.timestamp)));
    }
    function test_R6_allFrozenNoticesFailSafeWithNamedStipend() public {
        for (uint256 i; i < 5; ++i) {
            bytes memory data = notice(i);
            (bool unauthorized,) = address(probe).call(data); assertFalse(unauthorized);
            probe.setMode(0); assertTrue(driver.notify(address(probe), data));
            assertEq(probe.calls(), i + 1); assertEq(probe.last(), bytes4(data));
            for (uint8 mode = 1; mode <= 2; ++mode) {
                probe.setMode(mode); assertFalse(driver.notify(address(probe), data));
                assertEq(probe.calls(), i + 1); // Reverted callee state never leaks.
            }
        }
        assertEq(driver.attempts(), 15);
        assertTrue(driver.notify(address(0), notice(0))); assertEq(driver.attempts(), 15);
        bytes memory callData = abi.encodeCall(driver.notify, (address(probe), notice(0)));
        (bool ok,) = address(driver).call{gas: 100_000}(callData);
        assertFalse(ok); assertEq(driver.attempts(), 15);
    }
    function test_R6_nearFloorMustRejectExplicitlyOrSurviveHostileCall() public {
        probe.setMode(2);
        bytes memory data = abi.encodeCall(driver.notify, (address(probe), notice(0)));
        // Enough for the callee stipend, but fresh caller storage costs differ between forks.
        // Either the floor refuses atomically or the capped failure returns. An outer OOG is wrong.
        (bool ok, bytes memory ret) = address(driver).call{gas: 1_060_000}(data);
        if (ok) {
            assertFalse(abi.decode(ret, (bool))); assertEq(driver.attempts(), 1);
        } else {
            assertEq(ret, abi.encodeWithSignature("Error(string)", "gas floor"));
            assertEq(driver.attempts(), 0);
        }
        uint256 before_ = driver.attempts();
        assertFalse(driver.notify{gas: 1_250_000}(address(probe), notice(0)));
        assertEq(driver.attempts(), before_ + 1); assertEq(probe.calls(), 0);
    }
    function test_R5_failedOpenDeliveryAndReturnNeverSpendOldCredit() public {
        ItemHistoryModel h = new ItemHistoryModel(4, 1, 0);
        ItemModel m = new ItemModel(h); h.graduate();
        bytes32 ticket = ItemKit.key(ItemKit.Domain.Draw, 7);
        h.request(ticket); probe.setMode(1); assertFalse(driver.notify(address(probe), notice(0)));
        h.fund(1, 2, 0, 40); h.deliver(ticket, FIRST_ID, address(this));
        assertFalse(driver.notify(address(probe), notice(4)));
        h.fund(1, 2, 0, 40); h.back(FIRST_ID);
        assertFalse(driver.notify(address(probe), notice(3)));
        h.fund(1, 2, 0, 40); h.pick(FIRST_ID, address(this)); h.fund(1, 2, 0, 40);
        m.sync(32);
        (uint256 c, uint256 stash) = m.itemCredit(FIRST_ID);
        assertEq(c, 30); assertEq(stash, 10); assertEq(m.hiddenStash(), 120);
        assertEq(m.residue(), 0); assertEq(m.accounted(), 160);
        assertEq(m.flushResidue(), 0); // Durable records recover missed intervals exactly.
    }
}
