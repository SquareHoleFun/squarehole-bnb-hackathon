// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxPhase, DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";
import {CoreBox0BackupBase} from "../../backup/CoreBox0BackupBase.sol";
import {AuditActor, AuditRouterSwapper} from "./AuditActors.sol";
import {EthIn, EthOut, TIn, TOut} from "./AuditGhostLedger.sol";
import {AuditEthPlaces} from "./AuditBox0World.sol";
import {AuditHeaders} from "./AuditHeaders.sol";
import {AuditPhases} from "./AuditPhases.sol";
import {AuditRevealSet} from "./AuditRevealSet.sol";

/// @notice TEST ONLY. Exposes `CoreBox0BackupBase._header` (its setUp never runs here) so the smoke test can compare
/// `AuditHeaders` with it byte for byte.
contract AuditHeaderTwin is CoreBox0BackupBase {
    function header(uint256 number, bytes32 mix) external pure returns (bytes memory) {
        return _header(number, mix);
    }
}

/// @notice R0-A's smoke tests: the world as created, its actors and reveal set, and one test per phase of
/// `AuditPhases` asserting that phase's state (and, for the silent phases, that the backup alone gives the word).
/// forge-config: default.evm_version = "osaka"
contract AuditWorldSmokeTest is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant MIX = keccak256("audit.world.smoke mix");

    /// Box 0 by factory v1 on the mainnet build, before its open: every pin, the clock, the edition, the bootstrap.
    function test_smoke_created() public view {
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Upcoming), "hook: Upcoming");
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Upcoming), "coordinator: Upcoming");
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.BeforeOpen), "tickets: BeforeOpen");
        assertEq(coordinator.boxId(), 0, "box 0");
        assertEq(coordinator.factory(), address(factory));
        assertEq(coordinator.randomness(), address(src), "box 0 reads the pinned BoxBackedSource");
        assertEq(block.chainid, 1, "chain id 1 (the mainnet build)");
        assertEq(block.basefee, AUDIT_BASE_FEE);
        assertEq(createdAt, src.roundTime(r0) - 1 days, "created a day before r0");
        assertEq(hook.openAt(), createdAt + AUDIT_OPEN_DELAY, "open an hour after creation");
        assertEq(tickets.openAt(), hook.openAt(), "one open time");
        assertEq(editionSize, 1_969, "the mainnet edition's N");
        assertEq(collection.totalSupply(), editionSize);
        assertEq(collection.balanceOf(a.vault), editionSize, "every item in the vault");
        assertEq(ghostEthIn(EthIn.Bootstrap), BoxSpecV1.BOOTSTRAP_ETH);
        assertEq(address(pm).balance, BoxSpecV1.BOOTSTRAP_ETH, "the bootstrap's ETH is in the pool");
        assertEq(token.balanceOf(address(kit)), 0, "the bootstrap's T was burned");
        _assertGhostLedger();
    }

    /// The actors behave as declared.
    function test_smoke_actors() public {
        assertEq(eoa7702.code, abi.encodePacked(hex"ef0100", address(delegate7702)), "EIP-7702 designator");
        assertGt(address(contractDrawer).code.length, 0);
        for (uint256 i; i < 8; ++i) {
            assertEq(eoa[i], vm.addr(eoaKey[i]));
            assertEq(eoa[i].code.length, 0, "a plain EOA");
        }
        vm.deal(address(this), 1 ether);
        assertTrue(payable(address(contractDrawer)).send(1), "accepts ETH within a 2,300 stipend");
        (bool ok,) = eoa7702.call{value: 1}("");
        assertTrue(ok, "the 7702 EOA accepts ETH through its delegate");
        // Observed, not a property of box 0: the gas a value call to the 7702 EOA needs on top of the 2,300 stipend
        // (0 under Osaka; under Amsterdam, Foundry 1.8.3, the stipend alone runs out of gas in its delegate).
        uint256 extra = type(uint256).max;
        for (uint256 g; g <= 20_000; g += 100) {
            (ok,) = eoa7702.call{value: 1, gas: g}("");
            if (ok) {
                extra = g;
                break;
            }
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("gas a value call to the 7702 EOA needs beyond the stipend", extra);
        if (keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam")) {
            assertGt(extra, 0, "amsterdam: stipend short");
        } else {
            assertEq(extra, 0, "the stipend is enough");
        }
        assertFalse(payable(address(ethRefuser)).send(1), "refuses ETH");
        (ok,) = address(ethRefuser).call{value: 1}("");
        assertFalse(ok, "refuses ETH with all gas too");
        uint256 g0 = gasleft();
        (ok,) = address(gasBurner).call{value: 1, gas: 200_000}("");
        assertFalse(ok);
        assertGe(g0 - gasleft(), 200_000, "uses all the gas it is given");
        assertEq(
            AuditActor(payable(eoa7702)).onERC721Received(address(0), address(0), 1, ""),
            AuditActor.onERC721Received.selector,
            "the 7702 EOA takes ERC-721 safe transfers"
        );
        vm.expectRevert(abi.encodeWithSelector(AuditActor.NotOwner.selector, eoa[0]));
        vm.prank(eoa[0]);
        contractDrawer.exec(address(0), 0, "");
    }

    /// The reveal set is the Sepolia test set at N 4,269 and its pinned 1,969 root is the built one.
    function test_smoke_revealSet() public {
        assertEq(AuditRevealSet.computeRoot(4_269), SepoliaBox0TestSet.root(), "N 4,269: the Sepolia test set");
        assertEq(
            AuditRevealSet.computeRoot(4_269),
            vm.parseJsonBytes32(vm.readFile(string.concat(vm.projectRoot(), AUDIT_SPEC_FILE)), ".summary.revealRoot"),
            "and the spec file's root"
        );
        bytes32 built1969 = AuditRevealSet.computeRoot(1_969);
        emit log_named_bytes32("reveal root at N 1,969", built1969);
        assertEq(AuditRevealSet.ROOT_1969, built1969, "the pinned 1,969 root");
        assertEq(AuditRevealSet.root(1_969), built1969);
        assertEq(collection.revealRoot(), AuditRevealSet.computeRoot(editionSize));
        uint256[3] memory ids = [uint256(1), 1_969, 4_269];
        for (uint256 i; i < ids.length; ++i) {
            SepoliaBox0TestSet.Entry memory want = SepoliaBox0TestSet.entry(ids[i]);
            SepoliaBox0TestSet.Entry memory got = AuditRevealSet.entry(ids[i]);
            assertEq(got.traitsPacked, want.traitsPacked);
            assertEq(got.imageHash, want.imageHash);
            assertEq(got.salt, want.salt);
        }
        assertEq(AuditRevealSet.proof(1_969, 1_969).length, 11, "depth 11 at N 1,969");
        assertEq(collection.treeDepth(), 11);
    }

    /// `AuditHeaders` is CoreBox0BackupBase's synthetic header, byte for byte, for numbers from 0 to 2^64 − 1 (one-byte,
    /// short-string and multi-byte RLP integers, mainnet block 26,233,781 among them).
    function test_smoke_headersMatchTheBackupBase() public {
        AuditHeaderTwin twin = new AuditHeaderTwin();
        uint256[8] memory numbers = [uint256(0), 1, 0x7f, 0x80, 0xff, 0x100, 26_233_781, type(uint64).max];
        for (uint256 i; i < numbers.length; ++i) {
            bytes32 mix = keccak256(abi.encode(i));
            assertEq(AuditHeaders.header(numbers[i], mix), twin.header(numbers[i], mix));
        }
    }

    function test_smoke_window() public {
        _toWindow();
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Window));
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Window));
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Curve));
        assertEq(vm.getBlockTimestamp(), hook.openAt() + 4 * SLOT, "step 4 of 32");
        assertGt(launchRouter.totalTaxCollected(), 0);
        assertEq(a.launchRouter.balance, launchRouter.totalTaxCollected(), "the tax waits unswept in the router");
        assertEq(ghostEthIn(EthIn.WindowBuy), 0.07 ether);
        assertGt(token.balanceOf(eoa[0]), 0);
        assertGt(token.balanceOf(eoa[1]), 0);
        // A buy through any other route is refused in the window (the hook's gate, wrapped by the PoolManager).
        bytes memory gate = _hookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, a.launchRouter, hook.windowEndsAt())
        );
        vm.deal(eoa[4], 1 ether);
        vm.prank(eoa[4]);
        vm.expectRevert(gate);
        routerSwapper.swapOne{value: 0.01 ether}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: -0.01 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            "",
            eoa[4]
        );
        // Sells pass in the window, through any route.
        assertGt(_sell(eoa[0], token.balanceOf(eoa[0]) / 10), 0, "a sell through the router stand-in");
        _assertGhostLedger();
    }

    function test_smoke_bonding() public {
        _toBonding();
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Bonding));
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Bonding));
        assertFalse(hook.closed());
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Curve));
        IBoxTickets.TicketState memory s = tickets.status();
        assertEq(s.minted, 5, "five placeholders");
        assertEq(s.slots, 5);
        assertEq(vault.pendingTickets(), 5, "the vault's pending tickets are the live placeholders");
        assertEq(tickets.ownerOf(1), eoa[0]);
        assertEq(tickets.ownerOf(5), eoa[1]);
        assertGt(ghostEthIn(EthIn.SwapIn), 2 ether, "buys through the router stand-in");
        assertGt(ghostEthOut(EthOut.SwapOut), 0, "a sell");
        assertGt(ghostEthOut(EthOut.Tip), 0, "the keeper's tip");
        assertGt(ghostTIn(TIn.Take), 0, "the placeholders' T");
        assertGt(token.balanceOf(address(contractDrawer)), 0);
        assertGt(token.balanceOf(eoa7702), 0);
        assertLt(address(pm).balance, raise, "the curve is not full");
        emit log_named_decimal_uint("ETH in the PoolManager after bonding", address(pm).balance, 18);
        emit log_named_decimal_uint("tax held by the launch router", a.launchRouter.balance, 18);
    }

    function test_smoke_closed() public {
        _toClosed();
        assertTrue(hook.closed());
        assertEq(hook.closedAtBlock(), vm.getBlockNumber(), "closed in the closing buy's own block");
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Closed));
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Closed));
        assertFalse(coordinator.graduated());
        assertGe(address(pm).balance, raise, "the curve holds at least R");
        emit log_named_decimal_uint("ETH in the PoolManager at the close", address(pm).balance, 18);
        // Every swap reverts until graduate().
        bytes memory closed = _hookRevert(
            IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, hook.closedAtBlock())
        );
        vm.deal(eoa[4], 1 ether);
        vm.prank(eoa[4]);
        vm.expectRevert(closed);
        routerSwapper.swapOne{value: 0.01 ether}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: -0.01 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            "",
            eoa[4]
        );
    }

    function test_smoke_graduated() public {
        _toGraduated();
        assertTrue(coordinator.graduated());
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Graduated));
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Graduated));
        assertEq(hook.migratedAtBlock(), vm.getBlockNumber());
        assertEq(graduationPokeFailures, 0, "every poke succeeded");
        assertTrue(vault.gateOpen());
        assertTrue(receiver.graduationSettled());
        assertTrue(stream.started());
        assertTrue(executor.fitGraduated());
        assertGt(graduationReward, 0);
        emit log_named_decimal_uint("graduation reward credited to the keeper", graduationReward, 18);
        assertEq(coordinator.rewardOf(keeper), graduationReward, "credited, not claimed");
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord));
        (uint64 requestedAt, uint64 round) = src.requestOf(a.tickets, 0);
        assertEq(round, r0, "the graduation word is the first committed round");
        assertEq(requestedAt, vm.getBlockTimestamp());
        (, uint64 postedAt) = drand.beaconOf(r0);
        assertEq(postedAt, 0, "not posted yet");
        assertEq(_ethPlaces().launchRouter, launchRouter.totalTaxCollected(), "the window's tax waits unswept");
    }

    function test_smoke_drawing() public {
        _toDrawing();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
        (bytes32 randomness,) = drand.beaconOf(r0);
        assertEq(tickets.graduationWord(), _word(src.DRAND_TAG(), randomness, 0), "drand's word, domain-separated");
        IBoxTickets.TicketState memory s = tickets.status();
        assertEq(s.drawsRequested, 2);
        assertEq(s.drawsSettled, 2, "the queue is empty");
        assertEq(uint8(tickets.drawTicket(drawA).status), uint8(DrawStatus.Opened));
        assertEq(uint8(tickets.drawTicket(drawB).status), uint8(DrawStatus.Settled));
        assertEq(tickets.drawTicket(drawB).itemId, itemB);
        assertEq(collection.ownerOf(itemA), eoa[3]);
        assertTrue(collection.isRevealed(itemA), "opened with its reveal");
        assertEq(collection.ownerOf(itemP1), eoa[0]);
        assertTrue(collection.isRevealed(itemP1));
        assertEq(collection.ownerOf(itemB), a.vault, "draw B's item waits in the vault");
        assertEq(tickets.balanceOf(eoa[0]), 2, "placeholders 2 and 3");
        // X04: the vault's pending tickets are the live placeholders (2-5) and the open draw (B).
        assertEq(vault.pendingTickets(), 5);
        // X03: n + t + items outside == N; the vault holds n + t (A and P1 are outside).
        assertEq(vault.outside(), vault.pendingTickets() + 2);
        assertEq(collection.balanceOf(a.vault), vault.inside() + vault.pendingTickets());
        uint256 pot = BoxSpecV1.DRAND_BOUNTY_GAS * block.basefee;
        assertEq(drand.owedTo(poster), 2 * pot, "each draw paid its round's pot to the poster");
        assertEq(ghostEthIn(EthIn.DrawValue), 2 * AUDIT_DRAW_VALUE);
        assertEq(ghostEthOut(EthOut.Refund), 2 * (AUDIT_DRAW_VALUE - pot), "the rest went back to the drawers");
        AuditEthPlaces memory p = _ethPlaces();
        assertEq(p.drand, drand.owedTo(poster), "the DrandSource holds exactly the poster's credits");
        assertEq(p.others, 0, "no other box address holds ETH between calls");
        _assertGhostLedger();
    }

    function test_smoke_silent() public {
        _toSilent();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
        assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Requested));
        assertEq(tickets.drawTicket(drawC).drawer, eoa7702);
        assertEq(silentRound, r0 + 16, "the first round past the committed ones");
        assertFalse(_committed(silentRound));
        (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, drawC);
        assertEq(w, bytes32(0));
        assertEq(readyAt, 0);
        assertFalse(src.isSilent(a.tickets, drawC), "not silent before 7 days");
        assertEq(vm.getBlockTimestamp(), src.roundTime(silentRound) + src.BACKUP_AFTER() + 1, "the backup may start");
        (uint64 startedAt,,,) = src.backupOf(silentRound);
        assertEq(startedAt, 0, "nothing started");
        uint256 deadline = uint256(tickets.drawTicket(drawC).requestedAt) + tickets.SILENCE();
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, drawC, deadline));
        tickets.enterTerminal();

        // Only the backup gives the word: started by anyone, fixed 257 blocks later from the target's header.
        uint256 target = _backup(silentRound, MIX, eoa[5]);
        (w, readyAt) = src.wordOf(a.tickets, drawC);
        assertEq(w, _word(src.BACKUP_TAG(), MIX, drawC));
        assertLe(readyAt, deadline, "inside the draw's 7 days");
        (, uint64 targetBlock,, bytes32 mix) = src.backupOf(silentRound);
        assertEq(targetBlock, target);
        assertEq(mix, MIX);
        assertEq(_settle(keeper, 1), 1);
        assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Settled));
        _assertGhostLedger();
    }

    function test_smoke_terminal() public {
        _toTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        assertEq(tickets.status().terminalAt, vm.getBlockTimestamp());
        assertTrue(src.isSilent(a.tickets, drawC), "the head is dead");
        vm.expectRevert(IBoxTickets.AlreadyTerminal.selector);
        tickets.enterTerminal();
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxTickets.TerminalMode.selector);
        tickets.draw(type(uint256).max, deadline);
        uint256 principal = _cancelDraw(eoa[4], drawC);
        assertGt(principal, 0);
        assertEq(ghostTOut(TOut.Cancel), principal, "the principal back to the 7702 drawer");
        assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Cancelled));
        _assertGhostLedger();
    }

    /// The Universal Router stand-in takes any parameters: an exact-output sell, a two-swap plan in one unlock (T nets
    /// to zero, ETH pays the round trip), and a buy that stops at its price limit (the rest refunded).
    function test_smoke_routerSwapperPlans() public {
        _toBonding();
        uint256 e0 = eoa[1].balance;
        uint256 tIn = _sellExactOut(eoa[1], 0.01 ether);
        assertEq(eoa[1].balance - e0, 0.01 ether, "exactly the ETH asked for");
        assertGt(tIn, 0);

        uint256 x = 1e24;
        AuditRouterSwapper.Call[] memory calls = new AuditRouterSwapper.Call[](2);
        calls[0] = AuditRouterSwapper.Call(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: _amount(x, false), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        calls[1] = AuditRouterSwapper.Call(
            poolKey,
            SwapParams({
                zeroForOne: false, amountSpecified: _amount(x, true), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        _fund(eoa[4], 0.1 ether);
        uint256 b0 = eoa[4].balance;
        uint256 t0 = token.balanceOf(eoa[4]);
        vm.prank(eoa[4]);
        routerSwapper.swap{value: 0.1 ether}(calls, eoa[4]);
        // A unit that calls the stand-in itself books the move by hand.
        _noteEthChange(b0, eoa[4].balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(eoa[4]), TIn.Sell, TOut.Buy);
        assertEq(token.balanceOf(eoa[4]), t0, "T nets to zero");
        assertLt(eoa[4].balance, b0, "the round trip pays its fees");
        assertGt(eoa[4].balance + 0.001 ether, b0);

        (uint160 p0,,,) = pm.getSlot0(poolKey.toId());
        uint160 limit = p0 - p0 / 1_000;
        uint256 before = eoa[5].balance;
        _buyTo(eoa[5], 1 ether, limit);
        (uint160 p1,,,) = pm.getSlot0(poolKey.toId());
        assertEq(p1, limit, "stopped at the limit");
        assertGt(eoa[5].balance, before, "the unspent input came back");
        _assertGhostLedger();
    }

    /// The usage example of docs/evidence/SH-AUDIT-B0-R0A.md, as written there: graduated, 40 ETH of fees through the
    /// intake, the Safe paid, the ledger balanced.
    function test_smoke_unitExample() public {
        _toGraduated();
        _fundFees(eoa[4], 40 ether);
        uint256 paid = _payPlatform(keeper);
        assertGt(paid, 0);
        assertEq(ghostEthOut(EthOut.Platform), paid, "booked as the Safe's receipt");
        _assertGhostLedger();
    }

    /// The ghost ledger is not vacuous: an unbooked wei on a box address, or T moved to an address it does not know,
    /// shows at once.
    function test_smoke_ghostLedgerSeesUnbookedMoves() public {
        _toBonding();
        (bool ok,,,) = _ghostEthBalanced();
        assertTrue(ok);
        vm.deal(a.receiver, a.receiver.balance + 1);
        (ok,,,) = _ghostEthBalanced();
        assertFalse(ok, "a forced wei nobody booked");
        _noteEthIn(EthIn.Forced, 1);
        (ok,,,) = _ghostEthBalanced();
        assertTrue(ok);
        address stranger = makeAddr("audit.stranger");
        uint256 amount = token.balanceOf(eoa[0]) / 7;
        vm.prank(eoa[0]);
        token.transfer(stranger, amount);
        (ok,,,) = _ghostTBalanced();
        assertFalse(ok, "T that left the known holders");
        _ghostAddOutside(stranger);
        (ok,,,) = _ghostTBalanced();
        assertTrue(ok, "a registered holder closes the gap");
        _assertGhostLedger();
    }

    /// Plan § 3.2 shard S3's start: graduated with drand silent from the start; the backup saves the graduation word.
    function test_smoke_silentFromGraduation() public {
        _toSilentFromGraduation();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord));
        assertEq(silentRound, r0);
        (, uint64 postedAt) = drand.beaconOf(r0);
        assertEq(postedAt, 0);
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        _backup(r0, MIX, eoa[5]);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(src.BACKUP_TAG(), MIX, 0));
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
        // A late drand post is ignored for good once the backup started.
        _post(r0);
        (bytes32 w,) = src.wordOf(a.tickets, 0);
        assertEq(w, _word(src.BACKUP_TAG(), MIX, 0), "the source still answers the backup's word");
        _assertGhostLedger();
    }

    /// The same start, nobody fixing anything: terminal mode on the graduation word after 7 days.
    function test_smoke_terminalFromGraduation() public {
        _toSilentFromGraduation();
        _toTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
        assertTrue(src.isSilent(a.tickets, 0));
        bytes memory parent = _parentHeader();
        uint256 parentBlock = vm.getBlockNumber() - 1;
        uint256 until = src.roundTime(r0) + src.LATEST_START();
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, until));
        src.startBackup(r0, parentBlock, parent);
    }
}

/// The same world under Amsterdam (Glamsterdam's repricing): units with fork-sensitive gas or history rules use it.
/// forge-config: default.evm_version = "amsterdam"
contract AuditWorldSmokeAmsterdamTest is AuditWorldSmokeTest {}
