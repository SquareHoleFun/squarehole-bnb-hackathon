// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice P6.3 by fuzz on the factory's box 0 (F75 W3, `DrandWords.sol:77-98`, `IBoxTickets.sol:155-164`; money review
/// M18 holds): from the word's acceptance (set up once), any base fee (0 to 200 gwei), any pot already in the round
/// (from anyone's `addBounty`), any value, a drawer that takes ETH or one that refuses it. The draw reverts
/// `BountyTooLow(pot + value, target)` exactly when pot + value < DRAND_BOUNTY_GAS × base fee; otherwise the pot ends
/// at pot + max(0, target − pot) (or pot + value for a refusing drawer with a rest), the drawer pays exactly that much
/// ETH, the event reports it, and nothing stays in the tickets contract.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeBountyFuzzTest is AuditU6ClaudeBase {
    function setUp() public override {
        super.setUp();
        _toWordAccepted();
        _giveT(eoa[2], address(ethRefuser), 20 * vault.quoteWithdraw(1));
        _approveT(address(ethRefuser), a.tickets);
        _approveT(eoa[3], a.tickets);
    }

    function testFuzz_AUDIT_U6_drawBountyMath(uint256 feeRaw, uint256 potRaw, uint256 valueRaw, bool refuser) public {
        uint256 fee = bound(feeRaw, 0, 200 gwei);
        vm.fee(fee);
        uint256 target = BOUNTY_GAS * fee;
        uint256 round = _roundNow();
        uint256 pot0 = bound(potRaw, 0, 2 * target + 1);
        if (pot0 != 0) _addBounty(eoa[2], round, pot0, potRaw % 2 == 0);
        assertEq(drand.bountyOf(round), pot0);
        uint256 value = bound(valueRaw, 0, 3 * target + 1);
        address who = refuser ? address(ethRefuser) : eoa[3];
        if (pot0 + value < target) {
            vm.deal(who, value);
            uint256 deadline = vm.getBlockTimestamp();
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.BountyTooLow.selector, pot0 + value, target));
            tickets.draw{value: value}(type(uint256).max, deadline);
            return;
        }
        uint256 shortfall = pot0 < target ? target - pot0 : 0;
        uint256 rest = value - shortfall;
        uint256 paid = refuser && rest != 0 ? value : shortfall;
        uint256 e0 = who.balance;
        vm.recordLogs();
        uint256 id = _draw(who, value);
        assertEq(_bountyOf(id), paid, "the event reports what went into the pot");
        assertEq(e0 + value - who.balance, paid, "the drawer paid exactly that");
        assertEq(drand.bountyOf(round), pot0 + paid, "the pot: topped up to the target, plus a refused rest");
        assertGe(drand.bountyOf(round), target, "never below the target after a draw");
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Requested));
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    function _bountyOf(uint256 id) internal view returns (uint256) {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.tickets && logs[i].topics[0] == IBoxTickets.DrawRequested.selector) {
                if (uint256(logs[i].topics[1]) == id) {
                    (,,, uint256 bounty) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                    return bounty;
                }
            }
        }
        revert("no DrawRequested event");
    }
}

/// The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeBountyFuzzAmsterdamTest is AuditU6ClaudeBountyFuzzTest {}

/// @notice P6.13 / X18 against EIP-7825's transaction cap (2^24 = 16,777,216 gas) on the factory's box 0: 24 draws
/// waiting on three committed rounds; `settle(24)` and an `openDraw` of the last ticket (which first settles the 23
/// before it, `BoxTickets.sol:292-296`) each fit one capped transaction from cold state, and the measured slope gives
/// how many settlements one capped transaction holds (logged per fork). A longer queue is settled in chunks by anyone
/// (`settle(k)`), so no queue length blocks an open.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeTxCapTest is AuditU6ClaudeBase {
    uint256 internal constant TX_CAP = 16_777_216;

    function _coolAll() internal {
        vm.cool(address(src));
        vm.cool(address(drand));
        vm.cool(a.tickets);
        vm.cool(a.vault);
        vm.cool(a.collection);
        vm.cool(a.itemStream);
        vm.cool(a.token);
    }

    function testProperty_AUDIT_U6_settleAndOpenDrawUnderTheTransactionCap() public {
        _toWordAccepted();
        address[6] memory who = [eoa[3], eoa[4], eoa[5], eoa7702, eoa[0], eoa[1]];
        for (uint256 i; i < 6; ++i) {
            _giveT(eoa[2], who[i], 6 * vault.quoteWithdraw(1));
        }
        uint256[24] memory ids;
        for (uint256 b; b < 3; ++b) {
            if (b != 0) _advance(1);
            for (uint256 i; i < 8; ++i) {
                ids[8 * b + i] = _draw(who[(8 * b + i) % 6], AUDIT_DRAW_VALUE);
            }
        }
        _advance(1);
        _post(r0 + 4);
        _post(r0 + 8);
        _post(r0 + 12);
        uint256[] memory want = _replayItems(24);
        ItemReveal memory r24 = _reveal(want[24]);

        uint256 snap = vm.snapshotState();
        _coolAll();
        uint256 g0 = gasleft();
        tickets.settle(1);
        uint256 one = g0 - gasleft();
        vm.revertToState(snap);
        _coolAll();
        g0 = gasleft();
        tickets.settle(24);
        uint256 all = g0 - gasleft();
        vm.revertToState(snap);
        _coolAll();
        g0 = gasleft();
        vm.prank(who[23 % 6]);
        tickets.openDraw(ids[23], address(0), r24);
        uint256 openAll = g0 - gasleft();
        assertEq(collection.ownerOf(want[24]), who[23 % 6]);
        assertEq(tickets.status().drawsSettled, 24);

        uint256 slope = (all - one) / 23;
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("settle(1), cold", one);
        emit log_named_uint("settle(24), cold", all);
        emit log_named_uint("openDraw of ticket 24 settling 23 first, cold", openAll);
        emit log_named_uint("slope per settlement", slope);
        emit log_named_uint("settlements in one 2^24-gas transaction", (TX_CAP - one) / slope + 1);
        assertLt(all, TX_CAP, "settle(24) fits one capped transaction");
        assertLt(openAll, TX_CAP, "an open that settles 23 first fits one capped transaction");
        assertGe((TX_CAP - one) / slope + 1, 48, "one capped transaction settles at least 48");
    }
}

/// The same under Amsterdam (Glamsterdam's repricing).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeTxCapAmsterdamTest is AuditU6ClaudeTxCapTest {}

/// @notice P6.10 for every domain size from 1 to 10,000 (`BoxShuffle.sol:30-54`): `halves(n)` gives the smallest
/// b = max(2, ⌈log₂ n⌉), and at three points of every domain (0, n / 2, n − 1) π stays inside [0, n), `invert` undoes
/// it and distinct points get distinct images. The full bijection is checked exhaustively in
/// `AuditU6ClaudeShuffleTest` (n ≤ 64, 1,969, 4,269) and by fuzz up to 10,000. Pure library code.
contract AuditU6ClaudeShuffleDomainsTest is Test {
    function testProperty_AUDIT_U6_shuffleEveryDomainSizeSampled() public pure {
        bytes32 key = keccak256("audit.u6.claude domains");
        for (uint256 n = 1; n <= 10_000; ++n) {
            (uint256 u, uint256 v) = BoxShuffle.halves(n);
            uint256 b = u + v;
            require(b >= 2 && (uint256(1) << b) >= n, "2^b covers n");
            require(b == 2 || (uint256(1) << (b - 1)) < n, "the smallest such b");
            require(u == b / 2, "u = floor(b / 2)");
            uint256[3] memory xs = [uint256(0), n / 2, n - 1];
            uint256[3] memory ys;
            for (uint256 i; i < 3; ++i) {
                ys[i] = BoxShuffle.permute(key, xs[i], n, u, v);
                require(ys[i] < n, "pi stays inside the domain");
                require(BoxShuffle.invert(key, ys[i], n, u, v) == xs[i], "invert undoes pi");
                for (uint256 j; j < i; ++j) {
                    require(xs[i] == xs[j] || ys[i] != ys[j], "distinct points, distinct images");
                }
            }
        }
    }
}
