// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {Vm} from "forge-std/Vm.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {OpenTime} from "../../utils/OpenTime.sol";
import {AuditU5LaneBase} from "./AuditU5LaneBase.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";

/// @notice Naive account model: every increase in independently reconstructed J credits every currently
/// outside item and each open draw separately. No reads of the stream's item/draw checkpoint storage.
contract AuditU5LaneStreamHandler is AuditU5LaneBase {
    struct Draw {
        uint256 ticket;
        uint256 actor;
        uint256 earned;
        bool active;
    }
    Draw[] internal draws;
    uint256[] internal ids;
    address[] internal holders;
    address[3] internal actors;
    uint256[3] internal earned;
    uint256[3] internal paid;
    uint256 public received;
    uint256 public previousX;
    uint256 public previousJ;
    uint256 public failures;
    uint256 public calls;
    uint256 public deliveries;
    uint256 public cancellations;
    uint256 public transfers;
    uint256 public returnedItems;
    uint256 public picks;
    uint256 public settlements;
    uint256 public requests;
    uint256 public claims;

    constructor(CoreBox0Kit kit, uint256[] memory since, address[3] memory actors_) {
        b = kit;
        a = kit.addresses();
        st = BoxItemStream(a.itemStream);
        tix = BoxTickets(a.tickets);
        actors = actors_;
        previousX = _referenceValue();
        previousJ = (previousX - st.startValue()) / 4269;
        (uint256 c, uint256 burned) = st.totals();
        received = BoxToken(a.token).balanceOf(a.itemStream) + c + burned;
        for (uint256 i; i < since.length; ++i) {
            draws.push(Draw(i + 1, i % 3, previousJ - since[i], true));
        }
    }

    modifier tracked() {
        ++calls;
        _accrue();
        vm.recordLogs();
        _;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == a.token && logs[i].topics.length == 3
                    && logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")
                    && address(uint160(uint256(logs[i].topics[2]))) == a.itemStream
            ) {
                received += abi.decode(logs[i].data, (uint256));
            }
        }
        _accrue();
        check();
    }

    function fees(uint96 raw, bool batch) external tracked {
        uint256 amount = bound(raw, 0.02 ether, 1 ether);
        uint256 bought = b.buy(dave, amount, 0);
        _accrue();
        b.sell(dave, bought);
        _accrue();
        if (batch) {
            try BoxReceiver(payable(a.receiver)).collect(keeper) {} catch {}
        }
    }

    function collect() external tracked {
        try BoxReceiver(payable(a.receiver)).collect(keeper) {} catch {}
    }

    function transferItem(uint8 which, uint8 to) external tracked {
        if (ids.length == 0) return;
        uint256 k = which % ids.length;
        address from = holders[k];
        address dest = actors[to % 3];
        if (from == address(0) || from == dest) return;
        vm.prank(from);
        try BoxCollection(a.collection).transferFrom(from, dest, ids[k]) {
            holders[k] = dest;
            ++transfers;
        } catch {
            ++failures;
        }
    }

    function returnOrPick(uint8 which, uint8 to) external tracked {
        if (ids.length == 0) return;
        uint256 k = which % ids.length;
        address owner = holders[k];
        if (owner != address(0)) {
            vm.startPrank(owner);
            BoxCollection(a.collection).setApprovalForAll(a.vault, true);
            try BoxVault(a.vault).returnItem(ids[k], 0, block.timestamp) {
                holders[k] = address(0);
                ++returnedItems;
            } catch {}
            vm.stopPrank();
        } else {
            owner = actors[to % 3];
            b.buy(owner, 0.05 ether, 0);
            _accrue();
            vm.startPrank(owner);
            BoxToken(a.token).approve(a.vault, type(uint256).max);
            try BoxVault(a.vault).withdraw(ids[k], type(uint256).max, block.timestamp) {
                holders[k] = owner;
                ++picks;
            } catch {}
            vm.stopPrank();
        }
    }

    function draw(uint8 who) external tracked {
        if (draws.length >= 24 || tix.status().terminalAt != 0) return;
        uint256 actor = who % 3;
        b.buy(actors[actor], 0.05 ether, 0);
        _accrue();
        vm.startPrank(actors[actor]);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        try tix.draw(type(uint256).max, block.timestamp) returns (uint256 ticket) {
            draws.push(Draw(ticket, actor, 0, true));
            ++requests;
        } catch {}
        vm.stopPrank();
    }

    function settle(uint8 count) external tracked {
        try tix.settle(bound(count, 1, 24)) returns (uint256 n) {
            settlements += n;
        } catch {}
    }

    function deliver(uint8 which) external tracked {
        uint256 k = which % draws.length;
        Draw storage d = draws[k];
        if (!d.active) return;
        uint256 itemId = tix.drawTicket(d.ticket).itemId;
        if (itemId == 0) return;
        SepoliaBox0TestSet.Entry memory entry = SepoliaBox0TestSet.entry(itemId);
        ItemReveal memory reveal = ItemReveal(
            entry.traitsPacked,
            entry.imageHash,
            entry.avatarHash,
            entry.modelHash,
            entry.salt,
            SepoliaBox0TestSet.proof(itemId)
        );
        vm.prank(actors[d.actor]);
        try tix.openDraw(d.ticket, address(0), reveal) returns (uint256 id) {
            earned[d.actor] += d.earned;
            d.active = false;
            ids.push(id);
            holders.push(actors[d.actor]);
            ++deliveries;
        } catch {}
    }

    function terminalAndCancel(uint8 which) external tracked {
        // No fabricated word: newly requested, unposted rounds really time out. The initial rounds were BLS verified.
        if (tix.status().terminalAt == 0) {
            try tix.enterTerminal() {}
            catch {
                return;
            }
        }
        uint256 k = which % draws.length;
        Draw storage d = draws[k];
        if (!d.active) return;
        try tix.cancelDraw(d.ticket) returns (uint256) {
            earned[d.actor] += d.earned;
            d.active = false;
            ++cancellations;
        } catch {}
    }

    function time(uint8 days_) external tracked {
        uint256 daysForward = bound(days_, 1, 32);
        vm.warp(block.timestamp + daysForward * 1 days);
        vm.roll(block.number + daysForward * 7200);
    }

    function claim(uint8 who, bool behalf, bool duplicate) external tracked {
        uint256 actor = who % 3;
        address account = actors[actor];
        uint256 count;
        for (uint256 i; i < holders.length; ++i) {
            if (holders[i] == account) ++count;
        }
        uint256[] memory owned = new uint256[](count + (duplicate && count > 0 ? 1 : 0));
        uint256 cursor;
        for (uint256 i; i < holders.length; ++i) {
            if (holders[i] == account) owned[cursor++] = ids[i];
        }
        if (owned.length > count) owned[count] = owned[0];
        uint256 beforeBalance = BoxToken(a.token).balanceOf(account);
        uint256 got;
        if (behalf) {
            got = st.claimFor(account, owned);
        } else {
            vm.prank(account);
            got = st.claim(owned, account);
        }
        if (BoxToken(a.token).balanceOf(account) != beforeBalance + got) ++failures;
        paid[actor] += got;
        ++claims;
    }

    function burn() external tracked {
        st.burn();
    }

    function _accrue() internal {
        uint256 x = _referenceValue();
        if (x < previousX) {
            ++failures;
            return;
        }
        uint256 j = (x - st.startValue()) / 4269;
        if (j < previousJ || j != st.index()) {
            ++failures;
            return;
        }
        uint256 delta = j - previousJ;
        for (uint256 i; i < holders.length; ++i) {
            for (uint256 actor; actor < 3; ++actor) {
                if (holders[i] == actors[actor]) earned[actor] += delta;
            }
        }
        for (uint256 i; i < draws.length; ++i) {
            if (draws[i].active) draws[i].earned += delta;
        }
        previousJ = j;
        previousX = x;
    }

    function entitlementHash() external view returns (bytes32) {
        uint256[3] memory total = earned;
        for (uint256 i; i < draws.length; ++i) {
            if (draws[i].active) total[draws[i].actor] += draws[i].earned;
        }
        return keccak256(abi.encode(total, st.index(), st.liabilities(), st.outsideCount()));
    }

    function check() public view {
        assertEq(failures, 0);
        assertEq(st.streamValue(), _referenceValue(), "extsload equals StateLibrary");
        uint256 liabilities;
        uint256 outside;
        for (uint256 actor; actor < 3; ++actor) {
            uint256 actual = st.owedOf(actors[actor]);
            for (uint256 i; i < holders.length; ++i) {
                if (holders[i] == actors[actor]) {
                    (address owner, uint256 amount) = st.pendingOf(ids[i]);
                    assertEq(owner, actors[actor]);
                    actual += amount;
                    ++outside;
                }
            }
            assertEq(actual + paid[actor], earned[actor], "per-account reference entitlement");
            liabilities += actual;
        }
        for (uint256 i; i < draws.length; ++i) {
            if (draws[i].active) {
                liabilities += draws[i].earned;
                ++outside;
            }
        }
        assertEq(st.liabilities(), liabilities, "draws owe only their own intervals");
        assertEq(st.outsideCount(), outside);
        (uint256 claimed, uint256 burned) = st.totals();
        uint256 held = BoxToken(a.token).balanceOf(a.itemStream);
        assertEq(held + claimed + burned, received, "independently logged inflows conserved");
        assertEq(claimed, paid[0] + paid[1] + paid[2]);
        // Uncollected fees are earned but not yet liquid; claim caps at held and leaves the remainder owed.
        assertLe(liabilities, held + previousX - received, "liabilities backed by held plus uncollected fees");
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU5LaneStreamInvariants is AuditU5LaneBase {
    AuditU5LaneStreamHandler internal handler;

    function setUp() public override {
        super.setUp();
        // Same factory/mainnet economics; public test reveal commitment allows actual return-and-pick cycles.
        vm.revertToState(_beforeCreation);
        BoxSpecV1.BoxSpec memory spec = b.spec();
        spec.revealRoot = SepoliaBox0TestSet.root();
        b.prepare(spec);
        b.create();
        a = b.addresses();
        st = BoxItemStream(a.itemStream);
        tix = BoxTickets(a.tickets);
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        b.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), b.curve().sqrtPriceLowerX96);
        vm.warp(src.roundTime(r0) - 12);
        BoxCoordinator(a.coordinator).graduate();
        address[3] memory actors = [alice, bob, carol];
        uint256[] memory since = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            b.buy(actors[i % 3], 0.2 ether, 0);
            since[i] = st.index();
            vm.startPrank(actors[i % 3]);
            BoxToken(a.token).approve(a.tickets, type(uint256).max);
            tix.draw(type(uint256).max, block.timestamp);
            vm.stopPrank();
            _trade(1);
        }
        vm.warp(src.roundTime(r0));
        src.postRound(r0, _localSig(0));
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7200);
        handler = new AuditU5LaneStreamHandler(b, since, actors);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = handler.fees.selector;
        selectors[1] = handler.collect.selector;
        selectors[2] = handler.transferItem.selector;
        selectors[3] = handler.returnOrPick.selector;
        selectors[4] = handler.draw.selector;
        selectors[5] = handler.settle.selector;
        selectors[6] = handler.deliver.selector;
        selectors[7] = handler.terminalAndCancel.selector;
        selectors[8] = handler.time.selector;
        selectors[9] = handler.claim.selector;
        selectors[10] = handler.burn.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_AUDIT_U5_accountReferenceAndConservation() public view {
        handler.check();
    }

    function testProperty_AUDIT_U5_allSameBlockBatchDrawSettlePermutations() public {
        handler.fees(1 ether, false);
        uint256 snap = vm.snapshotState();
        uint256 blockBefore = block.number;
        uint8[3][6] memory order =
            [[uint8(0), 1, 2], [uint8(0), 2, 1], [uint8(1), 0, 2], [uint8(1), 2, 0], [uint8(2), 0, 1], [uint8(2), 1, 0]];
        bytes32 expectedTotals;
        for (uint256 k; k < 6; ++k) {
            for (uint256 step; step < 3; ++step) {
                if (order[k][step] == 0) handler.collect();
                else if (order[k][step] == 1) handler.draw(1);
                else handler.settle(6);
            }
            handler.check();
            assertEq(handler.requests(), 1);
            assertEq(handler.settlements(), 6);
            assertEq(block.number, blockBefore);
            bytes32 totals = handler.entitlementHash();
            if (k == 0) expectedTotals = totals;
            else assertEq(totals, expectedTotals, "same per-account totals in all six orders");
            vm.revertToState(snap);
        }
    }

    function testProperty_AUDIT_U5_handlerExercisesEveryTransition() public {
        handler.settle(6);
        handler.time(32);
        handler.deliver(0);
        handler.deliver(1);
        handler.fees(1 ether, true);
        handler.transferItem(0, 1);
        handler.time(32);
        handler.returnOrPick(0, 1);
        handler.returnOrPick(0, 2);
        handler.draw(0);
        handler.fees(1 ether, true);
        handler.claim(1, true, true);
        handler.claim(2, false, false);
        handler.time(8);
        handler.terminalAndCancel(6);
        handler.burn();
        assertEq(handler.settlements(), 6, "settlements");
        assertEq(handler.deliveries(), 2, "deliveries");
        assertEq(handler.transfers(), 1, "transfers");
        assertEq(handler.returnedItems(), 1, "returnedItems");
        assertEq(handler.picks(), 1, "picks");
        assertEq(handler.requests(), 1, "requests");
        assertEq(handler.cancellations(), 1, "cancellations");
        assertEq(handler.claims(), 2, "claims");
        handler.check();
    }
}
