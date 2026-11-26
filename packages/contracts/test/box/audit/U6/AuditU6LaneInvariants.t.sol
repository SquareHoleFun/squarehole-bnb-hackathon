// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU6LaneBase, AuditU6LaneArt} from "./AuditU6LaneBase.sol";
import {CoreBox0BackupBase} from "../../backup/CoreBox0BackupBase.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";

/// @notice Real factory box and pinned sources, no behavioral mocks. Failed public calls are caught; accounting
/// ghosts update only on success. Synthetic canonical headers use the existing backup fixture's BLOCKHASH/history
/// plumbing. The handler bounds minted placeholders to 48 and draws to 32, not the production contracts.
contract AuditU6LaneHandler is CoreBox0BackupBase {
    AuditU6LaneArt public art;
    BoxVault public vault;
    BoxToken public token;
    address[2] public actors;
    uint256 public minted = 1;
    uint256 public burned;
    uint256 public drawsOpen;
    uint256[16] public successes;
    bytes32 public acceptedWord;
    mapping(uint256 => uint64) public requestRound;
    mapping(uint256 => uint256) public assigned;
    mapping(uint256 => uint256) public placeholderNumber;
    uint256[] public namedItems;
    bool public violation;

    constructor(CoreBox0Kit kit, AuditU6LaneArt art_) {
        b = kit;
        a = kit.addresses();
        src = kit.source();
        drand = kit.drand();
        tickets = BoxTickets(a.tickets);
        vault = BoxVault(a.vault);
        token = BoxToken(a.token);
        art = art_;
        actors = [kit.alice(), kit.bob()];
        _loadBoxDrand();
        r0 = _localFirst();
    }

    function take(uint256 who, uint256 k) external {
        k = 1 + k % 3;
        if (minted + k > 48) return;
        vm.prank(actors[who % 2]);
        try tickets.take(k, type(uint256).max, block.timestamp) {
            minted += k;
            ++successes[0];
        } catch {}
    }

    function handBack(uint256 seed) external {
        (uint256 id, address owner) = _live(seed);
        if (owner == address(0)) return;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(owner);
        try tickets.handBack(ids, 0, block.timestamp) {
            ++burned;
            ++successes[1];
        } catch {}
    }

    function transfer(uint256 seed, uint256 to) external {
        (uint256 id, address owner) = _live(seed);
        if (owner == address(0)) return;
        vm.prank(owner);
        try tickets.transferFrom(owner, actors[to % 2], id) {
            ++successes[2];
        } catch {}
    }

    function graduate() external {
        if (vault.gateOpenedAt() != 0) return;
        try b.buy(b.carol(), 3 * b.spec().raise, b.curve().sqrtPriceLowerX96) {}
        catch {
            return;
        }
        uint256 at = src.roundTime(r0) - 12;
        if (block.timestamp < at) vm.warp(at);
        vm.roll(block.number + 1);
        try BoxCoordinator(a.coordinator).graduate() {
            ++successes[3];
            _remember(0);
        } catch {}
    }

    function requestWord() external {
        try tickets.requestGraduationWord() {
            ++successes[4];
            _remember(0);
        } catch {}
    }

    function post(uint256 seed) external {
        uint256 id = seed % (uint256(tickets.status().drawsRequested) + 1);
        (, uint64 round) = src.requestOf(a.tickets, id);
        if (round < r0 || round >= r0 + 16) return; // only committed valid quicknet signatures
        uint256 at = src.roundTime(round);
        if (block.timestamp < at) vm.warp(at);
        try drand.postRound(round, _localSig(round - r0)) {
            ++successes[5];
        } catch {}
    }

    function acceptWord() external {
        try tickets.acceptGraduationWord() {
            if (acceptedWord != bytes32(0)) violation = true;
            acceptedWord = tickets.graduationWord();
            for (uint256 id = 1; id <= minted; ++id) {
                try tickets.numberOf(id) returns (uint256 number) {
                    placeholderNumber[id] = number;
                } catch {}
            }
            ++successes[6];
        } catch {}
    }

    function draw(uint256 who, uint256 feeSeed) external {
        if (tickets.status().drawsRequested >= 32) return;
        vm.fee((feeSeed % 3) * 1 gwei);
        address actor = actors[who % 2];
        vm.deal(actor, 10 ether);
        vm.prank(actor);
        try tickets.draw{value: 0.01 ether}(type(uint256).max, block.timestamp) returns (uint256 id) {
            ++drawsOpen;
            ++successes[7];
            _remember(id);
            _remember(0);
        } catch {}
    }

    function settle(uint256 k) external {
        try tickets.settle(1 + k % 8) {
            ++successes[8];
            _assignments();
        } catch {}
    }

    function open(uint256 seed) external {
        (uint256 id, address owner) = _live(seed);
        if (owner == address(0) || tickets.status().wordAcceptedAt == 0) return;
        ItemReveal memory r = art.reveal(tickets.numberOf(id));
        vm.prank(owner);
        try tickets.open(id, r) {
            ++burned;
            ++successes[9];
        } catch {}
    }

    function openDraw(uint256 seed) external {
        uint256 count = tickets.status().drawsRequested;
        if (count == 0) return;
        uint256 id = 1 + seed % count;
        IBoxTickets.DrawView memory d = tickets.drawTicket(id);
        if (d.status != DrawStatus.Settled) return;
        ItemReveal memory r = art.reveal(d.itemId);
        vm.prank(d.drawer);
        try tickets.openDraw(id, address(0), r) {
            --drawsOpen;
            ++successes[10];
        } catch {}
    }

    /// Both sides of the backup, silence, reveal and return edges; blocks advance at 12 seconds/slot.
    function advance(uint256 seed) external {
        uint256[10] memory deltas =
            [uint256(1), 12, 1 hours, 5 days - 1, 5 days, 5 days + 18 hours, 7 days - 1, 7 days, 30 days - 1, 30 days];
        uint256 dt = deltas[seed % deltas.length];
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + (dt + 11) / 12);
        ++successes[11];
    }

    function startBackup(uint256 seed) external {
        uint256 id = seed % (uint256(tickets.status().drawsRequested) + 1);
        (, uint64 round) = src.requestOf(a.tickets, id);
        if (round == 0) return;
        bytes memory parent = _parent();
        try src.startBackup(round, block.number - 1, parent) {
            ++successes[12];
        } catch {}
    }

    function fixBackup(uint256 seed) external {
        uint256 id = seed % (uint256(tickets.status().drawsRequested) + 1);
        (, uint64 round) = src.requestOf(a.tickets, id);
        (, uint64 target, uint64 fixedAt,) = src.backupOf(round);
        if (target == 0 || fixedAt != 0) return;
        if (block.number <= target) _advance(target - block.number + 1);
        // The test chain's target mix is fixed independently of which caller/seed fixes it.
        bytes memory header = _mine(target, keccak256(abi.encode("audit canonical block", target)));
        try src.fixBackup(round, header) {
            ++successes[13];
        } catch {}
    }

    function terminalAndCancel(uint256 seed) external {
        try tickets.enterTerminal() {
            ++successes[14];
        } catch {}
        uint256 count = tickets.status().drawsRequested;
        if (count == 0) return;
        try tickets.cancelDraw(1 + seed % count) {
            --drawsOpen;
            ++successes[15];
        } catch {}
    }

    function takeByNumber(uint256 seed) external {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt == 0 || namedItems.length >= 32) return;
        uint256 n = tickets.collectionSize();
        uint256 index = seed % (n - s.slots - s.drawsSettled);
        uint256 position = tickets.poolPositionAt(index);
        uint256 offset = position;
        if (s.wordAcceptedAt != 0) {
            (uint256 u, uint256 v) = BoxShuffle.halves(n);
            offset = BoxShuffle.permute(tickets.graduationWord(), position, n, u, v);
        } else if (s.slots != 0) {
            offset = seed % n;
        }
        uint256 item = tickets.firstId() + offset;
        ItemReveal memory r = art.reveal(item);
        vm.prank(actors[seed % 2]);
        try tickets.takeByNumber(item, index, type(uint256).max, block.timestamp, r) {
            namedItems.push(item);
        } catch {}
    }

    function namedCount() external view returns (uint256) {
        return namedItems.length;
    }

    function _live(uint256 seed) internal view returns (uint256 id, address owner) {
        id = 1 + seed % minted;
        try tickets.ownerOf(id) returns (address o) {
            owner = o;
        } catch {}
    }

    function _remember(uint256 id) internal {
        (uint64 at, uint64 round) = src.requestOf(a.tickets, id);
        if (round == 0) return;
        if (requestRound[id] != 0 && requestRound[id] != round) violation = true;
        if (src.roundTime(round) < uint256(at) + 12) violation = true;
        requestRound[id] = round;
    }

    function _assignments() internal {
        for (uint256 id = 1; id <= tickets.status().drawsSettled; ++id) {
            uint256 item = tickets.drawTicket(id).itemId;
            if (assigned[id] != 0 && assigned[id] != item) violation = true;
            assigned[id] = item;
        }
    }
}

/// @notice U6.1,9,11,15 / IBoxTickets interface invariants on factory box 0 with the mainnet build.
/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneInvariants is AuditU6LaneBase {
    AuditU6LaneHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AuditU6LaneHandler(b, art);
        bytes4[] memory selectors = new bytes4[](16);
        selectors[0] = handler.take.selector;
        selectors[1] = handler.handBack.selector;
        selectors[2] = handler.transfer.selector;
        selectors[3] = handler.graduate.selector;
        selectors[4] = handler.requestWord.selector;
        selectors[5] = handler.post.selector;
        selectors[6] = handler.acceptWord.selector;
        selectors[7] = handler.draw.selector;
        selectors[8] = handler.settle.selector;
        selectors[9] = handler.open.selector;
        selectors[10] = handler.openDraw.selector;
        selectors[11] = handler.advance.selector;
        selectors[12] = handler.startBackup.selector;
        selectors[13] = handler.fixBackup.selector;
        selectors[14] = handler.terminalAndCancel.selector;
        selectors[15] = handler.takeByNumber.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_AUDIT_U6_custodySlotsNumbersQueueAndPinnedRequests() public view {
        _empty();
        assertFalse(handler.violation());
        IBoxTickets.TicketState memory s = tickets.status();
        assertEq(s.minted, handler.minted());
        bool[] memory slotSeen = new bool[](s.slots);
        bool[] memory numberSeen = new bool[](tickets.collectionSize());
        uint256 live;
        uint256 pendingDraws;
        for (uint256 id = 1; id <= s.minted; ++id) {
            uint256 assignedNumber = handler.placeholderNumber(id);
            if (assignedNumber != 0) {
                uint256 assignedOffset = assignedNumber - tickets.firstId();
                assertFalse(numberSeen[assignedOffset], "placeholder number never reused after open");
                numberSeen[assignedOffset] = true;
            }
            try tickets.ownerOf(id) returns (address) {
                ++live;
                uint256 slot = tickets.slotOf(id);
                assertLt(slot, s.slots);
                assertFalse(slotSeen[slot]);
                slotSeen[slot] = true;
                if (s.wordAcceptedAt != 0) {
                    assertEq(tickets.numberOf(id), assignedNumber);
                }
            } catch {}
        }
        for (uint256 id; id <= s.drawsRequested; ++id) {
            (, uint64 round) = src.requestOf(a.tickets, id);
            assertEq(round, handler.requestRound(id), "request round is immutable");
            if (id == 0) continue;
            IBoxTickets.DrawView memory d = tickets.drawTicket(id);
            if (d.status == DrawStatus.Requested || d.status == DrawStatus.Settled) ++pendingDraws;
            if (id <= s.drawsSettled) {
                assertTrue(d.status == DrawStatus.Settled || d.status == DrawStatus.Opened);
                assertEq(d.itemId, handler.assigned(id));
                uint256 offset = d.itemId - tickets.firstId();
                assertFalse(numberSeen[offset]);
                numberSeen[offset] = true;
            } else {
                assertTrue(d.status == DrawStatus.Requested || d.status == DrawStatus.Cancelled);
            }
        }
        for (uint256 i; i < handler.namedCount(); ++i) {
            uint256 offset = handler.namedItems(i) - tickets.firstId();
            assertFalse(numberSeen[offset], "named take cannot reuse an assigned number");
            numberSeen[offset] = true;
        }
        assertEq(live, handler.minted() - handler.burned());
        assertEq(live, tickets.balanceOf(alice) + tickets.balanceOf(bob));
        assertEq(pendingDraws, handler.drawsOpen());
        assertEq(vault.pendingTickets(), live + pendingDraws);
        assertEq(tickets.graduationWord(), handler.acceptedWord());
    }

    /// Non-vacuity checks: successful curve, drand, backup and silent-terminal traces through the same handler.
    function testProperty_AUDIT_U6_handlerSuccessfulLifecycles() public {
        handler.take(0, 2);
        handler.transfer(1, 1);
        handler.handBack(2);
        uint256 snap = vm.snapshotState();
        handler.graduate();
        handler.draw(0, 1);
        handler.post(0);
        handler.acceptWord();
        handler.settle(7);
        handler.open(0);
        handler.openDraw(0);
        invariant_AUDIT_U6_custodySlotsNumbersQueueAndPinnedRequests();
        for (uint256 i; i <= 10; ++i) {
            if (i != 4) assertGt(handler.successes(i), 0);
        }
        vm.revertToState(snap);
        handler.graduate();
        handler.draw(0, 0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        handler.startBackup(0);
        handler.fixBackup(0);
        handler.acceptWord();
        handler.settle(7);
        assertEq(handler.successes(12), 1);
        assertEq(handler.successes(13), 1);
        invariant_AUDIT_U6_custodySlotsNumbersQueueAndPinnedRequests();
        vm.revertToState(snap);
        handler.graduate();
        handler.draw(0, 0);
        handler.advance(7);
        handler.advance(0);
        handler.terminalAndCancel(0);
        assertEq(handler.successes(14), 1);
        assertEq(handler.successes(15), 1);
        invariant_AUDIT_U6_custodySlotsNumbersQueueAndPinnedRequests();
    }
}
