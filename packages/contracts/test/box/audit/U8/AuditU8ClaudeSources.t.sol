// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {History2935} from "../../backup/History2935.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";

/// @notice TEST ONLY. A poster contract whose payout re-enters the DrandSource while it receives (U8 P8.4): it reads its
/// own credit (must already be 0), withdraws again (must be refused), posts another round (a legitimate new credit,
/// then withdrawn by the nested call) and requests a key twice. It counts every wei it receives.
contract AuditU8ClaudeReentrantPoster {
    DrandSource internal immutable drand;
    uint256 public armedRound;
    bytes internal armedSig;
    uint256 public received;
    uint256 public receipts;
    uint256 public owedSeenInReceipt = type(uint256).max;
    bytes public nestedWithdrawError;
    bytes public secondRequestError;
    uint256 public nestedPosted;

    constructor(DrandSource drand_) {
        drand = drand_;
    }

    function post(uint256 round, bytes calldata sig) external {
        drand.postRound(round, sig);
    }

    function arm(uint256 round, bytes calldata sig) external {
        armedRound = round;
        armedSig = sig;
    }

    function withdraw() external returns (uint256) {
        return drand.withdrawBounty(payable(address(this)));
    }

    receive() external payable {
        received += msg.value;
        uint256 n = ++receipts;
        uint256 owed = drand.owedTo(address(this));
        if (owedSeenInReceipt == type(uint256).max) owedSeenInReceipt = owed;
        try drand.withdrawBounty(payable(address(this))) returns (uint256) {}
        catch (bytes memory e) {
            nestedWithdrawError = e;
        }
        if (armedRound != 0) {
            uint256 round = armedRound;
            armedRound = 0;
            drand.postRound(round, armedSig);
            ++nestedPosted;
            drand.withdrawBounty(payable(address(this))); // its own new credit: legitimate, received by a nested receive
        }
        if (n == 1) {
            drand.request(77);
            try drand.request(77) returns (uint256) {}
            catch (bytes memory e) {
                secondRequestError = e;
            }
        }
    }
}

/// @notice TEST ONLY. A consumer contract that counts every call made back into it (receive or fallback) and can request
/// the same key twice in one transaction through the backed source.
contract AuditU8ClaudeCountingConsumer {
    BoxBackedSource internal immutable src;
    uint256 public callbacks;

    constructor(BoxBackedSource src_) {
        src = src_;
    }

    function request(uint256 key) external payable returns (uint256) {
        return src.request{value: msg.value}(key);
    }

    function requestTwice(uint256 key) external payable returns (uint256 round) {
        round = src.request{value: msg.value}(key);
        src.request(key);
    }

    receive() external payable {
        ++callbacks;
    }

    fallback() external payable {
        ++callbacks;
    }
}

/// @notice TEST ONLY. A stand-in for BoxTickets' draw on the backed source (`BoxTickets.sol:251`): a request with no
/// value, then `DrandWords.payRound` from the ETH sent, the rest refunded to `refundTo`. It has no lock of its own (the
/// tickets' lock is U6's): the property here is the sources' and DrandWords' accounting under a refund that re-enters.
contract AuditU8ClaudePayingConsumer {
    IDrandSource internal immutable source;

    constructor(IDrandSource source_) {
        source = source_;
    }

    function draw(uint256 key, address refundTo) external payable returns (uint256 round, uint256 paid) {
        round = source.request(key);
        paid = DrandWords.payRound(source, round, msg.value, refundTo);
    }
}

/// @notice TEST ONLY. A refund recipient that re-enters the sources while it receives: it adds its own wei to the same
/// round's pot through the backed source, requests its own key there and asks for a withdrawal it is not owed.
contract AuditU8ClaudeReentrantRefundee {
    BoxBackedSource internal immutable src;
    DrandSource internal immutable drand;
    uint256 internal armedRound;
    uint256 internal armedExtra;
    uint256 public received;
    bytes public withdrawError;

    constructor(BoxBackedSource src_, DrandSource drand_) {
        src = src_;
        drand = drand_;
    }

    function arm(uint256 round, uint256 extra) external {
        armedRound = round;
        armedExtra = extra;
    }

    receive() external payable {
        received += msg.value;
        if (armedRound == 0) return;
        uint256 round = armedRound;
        armedRound = 0;
        src.addBounty{value: armedExtra}(round);
        src.request(1);
        try drand.withdrawBounty(payable(address(this))) returns (uint256) {}
        catch (bytes memory e) {
            withdrawError = e;
        }
    }
}

/// @notice TEST ONLY. The code an EIP-7702 EOA delegates to: accepts ETH with a receive that reads storage (so a 2,300-gas
/// stipend would not be enough under some schedules; the source pays with all gas).
contract AuditU8ClaudeDelegate {
    uint256 public seen;

    receive() external payable {
        seen += msg.value;
    }
}

/// @title AuditU8ClaudeSourcesTest (SH-AUDIT-B0 U8: DrandSource and BoxBackedSource at their pinned addresses)
/// @notice The pinned `DrandSource` and `BoxBackedSource` (CREATE2 through the local Arachnid deployer, chain id 1),
/// driven by plain accounts and small consumer contracts. Lenses and sources:
/// - L1 P8.1 (`IDrandSource.sol:23-25`, `DrandSource.sol:43-48`, `BoxBackedSource.sol:12-15`): the DrandSource holds
///   exactly Σ unposted pots + Σ unwithdrawn credits (+ forced or pre-funded ETH, M27); the backed source holds 0 after
///   every call; `withdrawBounty` clears the credit before the transfer, which gets all gas (an EIP-7702 account whose
///   delegate's `receive` writes storage is paid on Osaka and Amsterdam alike).
/// - L2 P8.2 (`BoxBackedSource.sol:12-15`, `:118-125`, `:250-252`): the forwarded key is uint256(keccak256(abi.encode(
///   consumer, key))) (padded); distinct pairs get distinct keys and words; one request per (consumer, key), also within
///   one transaction; words carry `WORD_TAG` / `DRAND_TAG` / `BACKUP_TAG`.
/// - L2 P8.3 (`DrandSource.sol:115-130`, `BoxBackedSource.sol:157-207`): `postRound` once per round from its time;
///   `startBackup` only after round time + 5 d and until + 5 d 18 h (edges pinned: the lower edge is exclusive, the
///   upper inclusive), unposted, with one of the last 8 blocks' headers, once per round for ever; `fixBackup` by anyone
///   with the target's own header, by BLOCKHASH then EIP-2935 within 8,191 blocks.
/// - L3 P8.4: re-entry from a payout into `withdrawBounty`, `postRound` and `request` takes no more than the credits;
///   the request path makes no call back into the consumer; re-entry from the draw's refund (`DrandWords.payRound`, the
///   one DrandWords path box 0 deploys, `BoxTickets.sol:251`) leaves the draw's split exact.
/// - L4 P8.6: for a fixed target block the backup word is keccak256(BACKUP_TAG, prevRandao, keccak256(consumer, key))
///   whoever starts or fixes it and whenever; a drand post after the start is ignored.
/// - L4 P8.7, L7 P8.14: `roundAt` / `roundTime` against quicknet's genesis and period at every boundary; a request's
///   round is 12 to 14 s after its block (never 15: the 15 s in `BoxBackedSource.sol:38` is an upper bound with 1 s
///   of slack), also at timestamps near 2^64.
/// - L6 P8.12, P8.13, L8 P8.15: no EIP-2935 code means BLOCKHASH's 256 blocks only; the history contract's refusals
///   are no answer, and a target not yet mined is never asked for; pins only on chains 1 and 11155111; the pins equal
///   CREATE2 of the compiled code, and ETH sent to the predicted addresses before deployment changes nothing but
///   staying there.
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeSourcesTest is BoxDrandVectors {
    /// @notice The bound pinned for one `startBackup` or `fixBackup` call (cold, real-size header), both EVMs: measured
    /// at most 81,140 on Osaka and 170,689 on Amsterdam (`testProperty_AUDIT_U8_keeperCallsStayBounded`).
    uint256 internal constant BACKUP_CALL_PIN = 200_000;

    DrandSource internal drand;
    BoxBackedSource internal src;
    uint256 internal r0;
    address internal consumer = makeAddr("audit.u8.consumer");
    address internal other = makeAddr("audit.u8.other");
    address internal poster = makeAddr("audit.u8.poster");

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        src = PinnedBackedSource.deploy(vm);
        vm.roll(23_000_000);
        vm.deal(consumer, 100 ether);
        vm.deal(other, 100 ether);
    }

    // ------------------------------------------------------------------------------------------------------------
    // helpers

    /// @dev Requests `key` for `who` through the backed source at the time that fixes `round`.
    function _requestOn(address who, uint256 key, uint256 round, uint256 value) internal returns (uint256 at) {
        vm.warp(src.roundTime(round) - 12);
        vm.prank(who);
        assertEq(src.request{value: value}(key), round, "the request fixed the intended round");
        at = vm.getBlockTimestamp();
    }

    /// @dev The real mainnet header as block (number - age)'s; returns it.
    function _recentHeader(uint256 age) internal returns (bytes memory h) {
        h = HeaderVectors.MAINNET;
        vm.setBlockhash(vm.getBlockNumber() - age, keccak256(h));
    }

    function _start(uint256 round) internal returns (uint256 target) {
        bytes memory h = _recentHeader(1);
        target = src.startBackup(round, vm.getBlockNumber() - 1, h);
    }

    /// @dev Makes `target`'s hash the hash of a synthetic header carrying `mix`, served as the chain would (BLOCKHASH
    /// within 256 blocks, EIP-2935's real code after), and returns the header.
    function _mine(uint256 target, bytes32 mix) internal returns (bytes memory h) {
        h = AuditHeaders.header(target, mix);
        if (vm.getBlockNumber() > target && vm.getBlockNumber() - target <= 256) vm.setBlockhash(target, keccak256(h));
        History2935.put(vm, target, keccak256(h));
    }

    function _roll(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + 12 * blocks);
    }

    function _id(address c, uint256 key) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, key));
    }

    // ------------------------------------------------------------------------------------------------------------
    // L1 P8.1: ETH

    /// @notice Every wei sent through the backed source (a request's bounty, `addBounty`) and straight to the
    /// DrandSource lands in the round's pot; the backed source holds 0 after every call; the post moves the whole pot
    /// to the poster's credit; the withdrawal empties it.
    function testFuzz_AUDIT_U8_backedSourcePassesEveryWeiThrough(uint256 v1, uint256 v2, uint256 v3, uint256 i) public {
        v1 = bound(v1, 0, 10 ether);
        v2 = bound(v2, 0, 10 ether);
        v3 = bound(v3, 0, 10 ether);
        uint256 round = r0 + bound(i, 0, 15);
        _requestOn(consumer, 5, round, v1);
        assertEq(address(src).balance, 0, "after request");
        vm.prank(other);
        src.addBounty{value: v2}(round);
        assertEq(address(src).balance, 0, "after addBounty");
        vm.prank(other);
        drand.addBounty{value: v3}(round);
        assertEq(drand.bountyOf(round), v1 + v2 + v3, "one pot");
        assertEq(src.bountyOf(round), v1 + v2 + v3, "the backed source reads the same pot");
        assertEq(address(drand).balance, v1 + v2 + v3, "DrandSource holds the pot");
        vm.warp(src.roundTime(round));
        vm.prank(poster);
        drand.postRound(round, _localSig(round - r0));
        assertEq(drand.bountyOf(round), 0);
        assertEq(drand.owedTo(poster), v1 + v2 + v3, "the whole pot to the poster");
        assertEq(address(drand).balance, v1 + v2 + v3, "pots + credits");
        if (v1 + v2 + v3 != 0) {
            uint256 b0 = poster.balance;
            vm.prank(poster);
            assertEq(drand.withdrawBounty(payable(poster)), v1 + v2 + v3);
            assertEq(poster.balance - b0, v1 + v2 + v3);
        }
        assertEq(address(drand).balance, 0, "nothing left");
        assertEq(address(src).balance, 0);
        (bool ok,) = address(src).call{value: 1}("");
        assertFalse(ok, "the backed source takes no plain ETH");
    }

    /// @notice A poster contract withdraws to itself and, while receiving, sees its credit already 0, is refused a
    /// second withdrawal (`NothingOwed`), posts another round and withdraws that new credit, and is refused a second
    /// request for one key: it receives exactly its two credits, nothing more; the DrandSource keeps the other pots.
    function testProperty_AUDIT_U8_withdrawReentryTakesNoMoreThanTheCredits() public {
        AuditU8ClaudeReentrantPoster p = new AuditU8ClaudeReentrantPoster(drand);
        vm.warp(src.roundTime(r0 + 2));
        drand.addBounty{value: 1 ether}(r0);
        drand.addBounty{value: 2 ether}(r0 + 1);
        drand.addBounty{value: 4 ether}(r0 + 2); // stays: nobody posts it here
        p.post(r0, _localSig(0));
        assertEq(drand.owedTo(address(p)), 1 ether);
        p.arm(r0 + 1, _localSig(1));
        assertEq(p.withdraw(), 1 ether);
        assertEq(p.received(), 3 ether, "exactly its two credits");
        assertEq(p.receipts(), 2);
        assertEq(p.owedSeenInReceipt(), 0, "cleared before the transfer");
        assertEq(p.nestedWithdrawError(), abi.encodeWithSelector(IDrandSource.NothingOwed.selector));
        assertEq(p.nestedPosted(), 1);
        assertEq(
            p.secondRequestError(),
            abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(p), uint256(77)),
            "a second request for one key, inside a payout, is refused"
        );
        assertEq(drand.owedTo(address(p)), 0);
        assertEq(address(drand).balance, 4 ether, "the unposted pot only");
        assertEq(drand.bountyOf(r0 + 2), 4 ether);
    }

    /// @notice The draw path's bounty (`DrandWords.payRound`, BC-053's "the round's pot is topped up to
    /// DRAND_BOUNTY_GAS x the block's base fee ... and the rest goes back to the drawer"): a refund recipient that
    /// re-enters while it receives (adds 0.01 ETH of its own to the same round through the backed source, requests its
    /// own key, asks for a withdrawal it is not owed) changes nothing of the draw's split: the pot gets exactly the
    /// shortfall (600,000 gas x 1 gwei), the recipient exactly the rest, the consumer and the backed source keep 0, the
    /// withdrawal is `NothingOwed`; the pot ends at the target plus the recipient's own 0.01 ETH. A second draw of the
    /// same round pays nothing and gets all of its value back.
    function testProperty_AUDIT_U8_payRoundRefundReentryKeepsTheSplit() public {
        AuditU8ClaudePayingConsumer c = new AuditU8ClaudePayingConsumer(IDrandSource(address(src)));
        AuditU8ClaudeReentrantRefundee f = new AuditU8ClaudeReentrantRefundee(src, drand);
        vm.deal(address(f), 1 ether);
        vm.fee(1 gwei);
        uint256 target = DrandWords.BOUNTY_GAS * 1 gwei;
        uint256 round = r0 + 3;
        vm.warp(src.roundTime(round) - 12);
        f.arm(round, 0.01 ether);
        (uint256 got, uint256 paid) = c.draw{value: 0.5 ether}(4, address(f));
        assertEq(got, round);
        assertEq(paid, target, "the shortfall only");
        assertEq(f.received(), 0.5 ether - target, "the rest, refunded");
        assertEq(drand.bountyOf(round), target + 0.01 ether, "the target plus the recipient's own wei");
        assertEq(address(drand).balance, target + 0.01 ether);
        assertEq(address(c).balance, 0, "the consumer keeps nothing");
        assertEq(address(src).balance, 0, "the backed source keeps nothing");
        assertEq(f.withdrawError(), abi.encodeWithSelector(IDrandSource.NothingOwed.selector));
        (, uint64 ownRound) = src.requestOf(address(f), 1);
        assertEq(ownRound, round, "the recipient's own request, on the same round");
        (, paid) = c.draw{value: 0.5 ether}(5, address(f));
        assertEq(paid, 0, "the round is funded: the second draw pays nothing");
        assertEq(f.received(), 1 ether - target, "and gets all of its value back");
        assertEq(drand.bountyOf(round), target + 0.01 ether);
        assertEq(address(c).balance, 0);
    }

    /// @notice Every keeper call of the unit stays bounded (lens L5; plan X18), measured cold in the caller's frame:
    /// `postRound` of a bountied round by a new poster, `withdrawBounty` to an existing and to a new account,
    /// `startBackup` with the real 646-byte mainnet header, `fixBackup` through BLOCKHASH and through EIP-2935 with a
    /// header of the same size. A whole `postRound` transaction (the call, 21,000 intrinsic gas and 16 gas per calldata
    /// byte, above its calldata cost) stays below `DrandWords.BOUNTY_GAS` (600,000), so the pot a draw pays
    /// (BOUNTY_GAS x the draw block's base fee) pays the round's post at that base fee (DrandWords.sol:46-51, BC-053,
    /// F75 W3): measured at most 228,537 on Osaka and 405,677 on Amsterdam (the NatSpec's 229,538 and 406,678); each
    /// backup call stays below `BACKUP_CALL_PIN` (start + fix: 153,672 to 159,009 on Osaka and 334,054 to 338,078 on
    /// Amsterdam here, by the fix's path; the security review logged about 158k and 339k,
    /// docs/evidence/SH-BOX0-BACKUP-SOURCE.md:224); a withdrawal costs
    /// 36,160 / 39,660 to an existing account and 65,119 / 227,719 to a new one (Osaka / Amsterdam: the new account's
    /// state costs). Logged per call; the Amsterdam variant runs the same.
    function testProperty_AUDIT_U8_keeperCallsStayBounded() public {
        _requestOn(consumer, 0, r0 + 6, 0.01 ether);
        _requestOn(other, 0, r0 + 9, 0);
        vm.warp(src.roundTime(r0 + 6));
        address newPoster = makeAddr("audit.u8.newPoster");
        bytes memory sig = _localSig(6);
        bytes memory data = abi.encodeCall(IDrandSource.postRound, (r0 + 6, sig));
        vm.cool(address(drand));
        vm.prank(newPoster);
        uint256 g0 = gasleft();
        (bool ok,) = address(drand).call(data);
        uint256 post = g0 - gasleft();
        assertTrue(ok);
        uint256 postTx = post + 21_000 + 16 * data.length;
        emit log_named_uint("postRound, bountied round, new poster (cold, caller's frame)", post);
        emit log_named_uint("postRound as a whole transaction, upper bound", postTx);
        assertLt(postTx, DrandWords.BOUNTY_GAS, "the draw's pot pays the post");
        uint256 snap = vm.snapshotState();
        vm.deal(newPoster, 1 ether); // an account that exists: the usual payee, the poster itself
        vm.cool(address(drand));
        vm.prank(newPoster);
        g0 = gasleft();
        drand.withdrawBounty(payable(newPoster));
        uint256 withdraw = g0 - gasleft();
        emit log_named_uint("withdrawBounty to an existing account (cold)", withdraw);
        assertLt(withdraw, 100_000);
        vm.revertToState(snap);
        vm.cool(address(drand));
        vm.prank(newPoster);
        g0 = gasleft();
        drand.withdrawBounty(payable(makeAddr("audit.u8.newPayee")));
        withdraw = g0 - gasleft();
        emit log_named_uint("withdrawBounty to a new account (cold)", withdraw);
        assertLt(withdraw, 300_000);
        // The backup: r0 + 9 unposted, its window open.
        vm.warp(src.roundTime(r0 + 9) + 5 days + 1);
        bytes memory p = _recentHeader(1);
        vm.cool(address(src));
        vm.cool(address(drand));
        g0 = gasleft();
        uint256 target = src.startBackup(r0 + 9, vm.getBlockNumber() - 1, p);
        uint256 start = g0 - gasleft();
        emit log_named_uint("startBackup, 646-byte header (cold)", start);
        assertLt(start, BACKUP_CALL_PIN);
        snap = vm.snapshotState();
        _roll(target + 1 - vm.getBlockNumber());
        vm.setBlockhash(target, keccak256(HeaderVectors.MAINNET));
        vm.cool(address(src));
        g0 = gasleft();
        src.fixBackup(r0 + 9, HeaderVectors.MAINNET);
        uint256 fixRecent = g0 - gasleft();
        emit log_named_uint("fixBackup through BLOCKHASH, 646-byte header (cold)", fixRecent);
        assertLt(fixRecent, BACKUP_CALL_PIN);
        vm.revertToState(snap);
        _roll(target + 8191 - vm.getBlockNumber());
        History2935.put(vm, target, keccak256(HeaderVectors.MAINNET));
        vm.cool(address(src));
        vm.cool(History2935.ADDRESS);
        g0 = gasleft();
        src.fixBackup(r0 + 9, HeaderVectors.MAINNET);
        uint256 fixHistory = g0 - gasleft();
        emit log_named_uint("fixBackup through EIP-2935, 646-byte header (cold)", fixHistory);
        assertLt(fixHistory, BACKUP_CALL_PIN);
    }

    /// @notice A refused payout (a recipient that reverts, or one that burns its gas) keeps the credit whole; the
    /// transfer gets all gas, so an EIP-7702 account whose delegate's `receive` writes storage is paid (the R0-A
    /// stipend observation does not apply: nothing in this unit pays with a 2,300-gas stipend).
    function testProperty_AUDIT_U8_withdrawPaysWithAllGasAndKeepsARefusedCredit() public {
        vm.warp(src.roundTime(r0));
        drand.addBounty{value: 1 ether}(r0);
        vm.prank(poster);
        drand.postRound(r0, _localSig(0));
        AuditU8ClaudeRevertingPayee refuser = new AuditU8ClaudeRevertingPayee();
        vm.prank(poster);
        vm.expectRevert(IDrandSource.WithdrawFailed.selector);
        drand.withdrawBounty(payable(address(refuser)));
        assertEq(drand.owedTo(poster), 1 ether, "the credit stays");
        vm.prank(poster);
        vm.expectRevert(IDrandSource.ZeroAddress.selector);
        drand.withdrawBounty(payable(address(0)));
        // An EIP-7702 EOA delegating to a storage-writing receive.
        AuditU8ClaudeDelegate delegate = new AuditU8ClaudeDelegate();
        (address eoa, uint256 key) = makeAddrAndKey("audit.u8.eoa7702");
        vm.signAndAttachDelegation(address(delegate), key);
        (bool ok,) = eoa.call("");
        assertTrue(ok && eoa.code.length == 23, "a delegation designator");
        vm.prank(poster);
        assertEq(drand.withdrawBounty(payable(eoa)), 1 ether);
        assertEq(eoa.balance, 1 ether, "paid with all gas");
        assertEq(AuditU8ClaudeDelegate(payable(eoa)).seen(), 1 ether, "the delegate's receive ran");
        assertEq(address(drand).balance, 0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // L2 P8.2: keys, words, one request per key

    /// @notice The key the backed source forwards is uint256(keccak256(abi.encode(consumer, key))) (64-byte padded
    /// preimage), keyed on the DrandSource by the backed source itself, with all of `msg.value`.
    function testFuzz_AUDIT_U8_forwardedKeyIsThePaddedPairHash(address c, uint256 key, uint256 value) public {
        vm.assume(c != address(0) && c != address(vm));
        value = bound(value, 0, 1 ether);
        vm.deal(c, value);
        vm.warp(src.roundTime(r0) - 12);
        uint256 derived = uint256(keccak256(abi.encode(c, key)));
        vm.expectEmit(true, true, false, true, address(drand));
        emit IDrandSource.Requested(address(src), derived, r0, value);
        vm.expectEmit(true, true, false, true, address(src));
        emit BoxBackedSource.Requested(c, key, r0, value);
        vm.prank(c);
        src.request{value: value}(key);
        (uint64 at, uint64 round) = drand.requestOf(address(src), derived);
        (uint64 at2, uint64 round2) = src.requestOf(c, key);
        assertEq(at, vm.getBlockTimestamp());
        assertEq(round, r0);
        assertEq(at2, at);
        assertEq(round2, round);
        assertTrue(derived != uint256(keccak256(abi.encodePacked(c, key))), "padded, not packed");
        assertEq(address(src).balance, 0);
    }

    /// @notice Two distinct (consumer, key) pairs requesting in one block (one round) get distinct forwarded keys and
    /// distinct words, each exactly keccak256(abi.encode(DRAND_TAG, randomness, keccak256(abi.encode(consumer, key)))).
    function testFuzz_AUDIT_U8_distinctPairsGetDistinctWords(address c1, uint256 k1, address c2, uint256 k2) public {
        vm.assume(c1 != c2 || k1 != k2);
        vm.assume(c1 != address(vm) && c2 != address(vm));
        vm.warp(src.roundTime(r0 + 1) - 12);
        vm.prank(c1);
        src.request(k1);
        vm.prank(c2);
        src.request(k2);
        assertTrue(uint256(_id(c1, k1)) != uint256(_id(c2, k2)), "distinct forwarded keys");
        vm.warp(src.roundTime(r0 + 1));
        bytes32 randomness = drand.postRound(r0 + 1, _localSig(1));
        (bytes32 w1, uint64 t1) = src.wordOf(c1, k1);
        (bytes32 w2, uint64 t2) = src.wordOf(c2, k2);
        assertEq(w1, keccak256(abi.encode(src.DRAND_TAG(), randomness, _id(c1, k1))));
        assertEq(w2, keccak256(abi.encode(src.DRAND_TAG(), randomness, _id(c2, k2))));
        assertTrue(w1 != w2, "distinct words");
        assertEq(t1, vm.getBlockTimestamp());
        assertEq(t2, vm.getBlockTimestamp());
    }

    /// @notice One (consumer, key) on the DrandSource directly, the same pair through the backed source on the same
    /// round, and a backup word whose mix happens to equal that round's randomness: three different words (the three
    /// tags); the tags are the documented strings and the DrandSource's is v2's drand tag.
    function testProperty_AUDIT_U8_wordsAreDomainSeparated() public {
        assertEq(drand.WORD_TAG(), keccak256("squarehole.randomness.drand-quicknet"), "v2's DRAND_WORD_TAG");
        assertEq(src.DRAND_TAG(), keccak256("squarehole.randomness.backed.drand-quicknet"));
        assertEq(src.BACKUP_TAG(), keccak256("squarehole.randomness.backed.randao"));
        vm.warp(src.roundTime(r0) - 12);
        vm.startPrank(consumer);
        drand.request(9);
        src.request(9);
        vm.stopPrank();
        vm.warp(src.roundTime(r0));
        bytes32 randomness = drand.postRound(r0, _localSig(0));
        (bytes32 direct,) = drand.wordOf(consumer, 9);
        (bytes32 backed,) = src.wordOf(consumer, 9);
        // the same pair on a later round, falling back with mix == r0's randomness
        _requestOn(consumer, 10, r0 + 4, 0);
        vm.warp(src.roundTime(r0 + 4) + 5 days + 1);
        uint256 target = _start(r0 + 4);
        _roll(257);
        src.fixBackup(r0 + 4, _mine(target, randomness));
        (bytes32 backup,) = src.wordOf(consumer, 10);
        assertEq(direct, keccak256(abi.encode(drand.WORD_TAG(), randomness, _id(consumer, 9))));
        assertEq(backed, keccak256(abi.encode(src.DRAND_TAG(), randomness, _id(consumer, 9))));
        assertEq(backup, keccak256(abi.encode(src.BACKUP_TAG(), randomness, _id(consumer, 10))));
        assertTrue(direct != backed && backed != keccak256(abi.encode(src.BACKUP_TAG(), randomness, _id(consumer, 9))));
        assertTrue(direct != keccak256(abi.encode(src.BACKUP_TAG(), randomness, _id(consumer, 9))));
    }

    /// @notice One request per (consumer, key) through the backed source, also twice in one transaction; the refusal
    /// carries the DrandSource's error naming the backed source and the forwarded key; the request path calls nothing
    /// back in the consumer.
    function testProperty_AUDIT_U8_oneRequestPerPairAndNoCallback() public {
        AuditU8ClaudeCountingConsumer c = new AuditU8ClaudeCountingConsumer(src);
        vm.deal(address(c), 1 ether);
        vm.warp(src.roundTime(r0) - 12);
        uint256 derived = uint256(_id(address(c), 3));
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(src), derived));
        c.requestTwice{value: 0.1 ether}(3);
        assertEq(c.request{value: 0.1 ether}(3), r0, "the first request");
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(src), derived));
        c.request(3);
        _roll(100);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(src), derived));
        c.request(3);
        assertEq(c.callbacks(), 0, "no call back into the consumer");
        assertEq(drand.bountyOf(r0), 0.1 ether);
    }

    // ------------------------------------------------------------------------------------------------------------
    // L2 P8.3, L7 P8.14: posting and the backup's windows

    /// @notice `postRound` from the round's time on, once: one second early `RoundNotYet(round, time)`; at the time it
    /// posts; again `RoundKnown`; round 0 and 2^64 are `InvalidRound`.
    function testProperty_AUDIT_U8_postRoundOnceFromItsTime() public {
        uint256 t = src.roundTime(r0 + 5);
        vm.warp(t - 1);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, r0 + 5, t));
        drand.postRound(r0 + 5, _localSig(5));
        vm.warp(t);
        drand.postRound(r0 + 5, _localSig(5));
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r0 + 5));
        drand.postRound(r0 + 5, _localSig(5));
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, 0));
        drand.postRound(0, _localSig(5));
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, uint256(1) << 64));
        drand.postRound(uint256(1) << 64, _localSig(5));
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r0 + 5));
        drand.addBounty{value: 1}(r0 + 5);
    }

    /// @notice The start's window edges for an unposted round: round time + 5 d − 1 s and + 5 d exactly are too early
    /// (the rule says "after"), + 5 d + 1 s and + 5 d 18 h are allowed, + 5 d 18 h + 1 s is too late.
    function testProperty_AUDIT_U8_startWindowEdges() public {
        _requestOn(consumer, 0, r0, 0);
        uint256 rt = src.roundTime(r0);
        uint256 at = rt + 5 days;
        uint256 until = rt + 5 days + 18 hours;
        uint256[5] memory times = [at - 1, at, at + 1, until, until + 1];
        bool[5] memory allowed = [false, false, true, true, false];
        for (uint256 i; i < 5; ++i) {
            uint256 snap = vm.snapshotState();
            vm.warp(times[i]);
            bytes memory h = _recentHeader(1);
            if (!allowed[i]) {
                vm.expectRevert(
                    times[i] <= at
                        ? abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, r0, at)
                        : abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, until)
                );
            }
            src.startBackup(r0, vm.getBlockNumber() - 1, h);
            if (allowed[i]) {
                (uint64 startedAt, uint64 targetBlock,,) = src.backupOf(r0);
                assertEq(startedAt, times[i]);
                assertEq(targetBlock, vm.getBlockNumber() + 256);
            }
            vm.revertToState(snap);
        }
    }

    /// @notice A start succeeds exactly when round time + 5 d < now ≤ round time + 5 d 18 h (round unposted, a valid
    /// recent header), at any moment of the day.
    function testFuzz_AUDIT_U8_startOnlyInsideTheWindow(uint256 dt) public {
        dt = bound(dt, 0, 8 days);
        _requestOn(consumer, 0, r0, 0);
        uint256 rt = src.roundTime(r0);
        vm.warp(rt + dt);
        bytes memory h = _recentHeader(1);
        (bool ok,) = address(src).call(abi.encodeCall(BoxBackedSource.startBackup, (r0, vm.getBlockNumber() - 1, h)));
        assertEq(ok, dt > 5 days && dt <= 5 days + 18 hours);
    }

    /// @notice The start's header must be one of the last 8 blocks' and hash to it: ages 1 to 8 pass, 0 (the current
    /// block) and 9 or more are `HeaderUnavailable`, another block's header is `WrongHeader`, and a block the header
    /// does not belong to is refused even inside the age window.
    function testFuzz_AUDIT_U8_startHeaderRecency(uint256 age, bool wrongHeader) public {
        age = bound(age, 0, 300);
        _requestOn(consumer, 0, r0, 0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        bytes memory h = HeaderVectors.MAINNET;
        uint256 headerBlock = vm.getBlockNumber() - age;
        if (age != 0) vm.setBlockhash(headerBlock, wrongHeader ? keccak256("another block") : keccak256(h));
        (bool ok, bytes memory ret) =
            address(src).call(abi.encodeCall(BoxBackedSource.startBackup, (r0, headerBlock, h)));
        if (age == 0 || age > 8) {
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, headerBlock));
        } else if (wrongHeader) {
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, headerBlock));
        } else {
            assertTrue(ok);
            assertEq(
                abi.decode(ret, (uint256)), vm.getBlockNumber() + 256, "the target counts from the including block"
            );
        }
    }

    /// @notice One target per round, for ever: after a start, a second start at any later time and block is refused
    /// (`BackupAlreadyStarted` inside the window, `BackupTooLate` after it), and the target never moves.
    function testFuzz_AUDIT_U8_oneTargetPerRoundForEver(uint256 dt, uint256 blocks) public {
        _requestOn(consumer, 0, r0, 0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        dt = bound(dt, 0, 30 days);
        blocks = bound(blocks, 1, 50_000);
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + dt);
        bytes memory h = _recentHeader(1);
        uint256 until = src.roundTime(r0) + src.LATEST_START();
        vm.expectRevert(
            vm.getBlockTimestamp() > until
                ? abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, until)
                : abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, r0)
        );
        src.startBackup(r0, vm.getBlockNumber() - 1, h);
        (, uint64 targetBlock,,) = src.backupOf(r0);
        assertEq(targetBlock, target);
    }

    /// @notice A round posted on the DrandSource can never start a backup (`RoundAlreadyPosted`), whenever it was
    /// posted (on time, or on day 5).
    function testFuzz_AUDIT_U8_postedRoundNeverStarts(uint256 postDelay) public {
        _requestOn(consumer, 0, r0, 0);
        postDelay = bound(postDelay, 0, 5 days + 18 hours);
        vm.warp(src.roundTime(r0) + postDelay);
        drand.postRound(r0, _localSig(0));
        if (postDelay <= 5 days) vm.warp(src.roundTime(r0) + 5 days + 1);
        bytes memory h = _recentHeader(1);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.RoundAlreadyPosted.selector, r0));
        src.startBackup(r0, vm.getBlockNumber() - 1, h);
    }

    /// @notice The fix reads the target's hash by BLOCKHASH for 256 blocks, then from EIP-2935's history contract (its
    /// real code) through target + 8,191; never at the target's own block or before; never after. Without code at the
    /// history address only BLOCKHASH's 256 blocks remain.
    function testFuzz_AUDIT_U8_fixWindow(uint256 d, bool historyCode) public {
        _requestOn(consumer, 0, r0, 0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        d = bound(d, 0, 9_000);
        _roll(target + d - vm.getBlockNumber());
        bytes memory h;
        if (historyCode) {
            h = _mine(target, keccak256("mix"));
        } else {
            h = AuditHeaders.header(target, keccak256("mix"));
            if (d >= 1 && d <= 256) vm.setBlockhash(target, keccak256(h));
            vm.etch(History2935.ADDRESS, "");
        }
        (bool ok, bytes memory ret) = address(src).call(abi.encodeCall(BoxBackedSource.fixBackup, (r0, h)));
        bool expected = d >= 1 && (d <= 256 || (historyCode && d <= 8191));
        assertEq(ok, expected);
        if (ok) assertEq(abi.decode(ret, (bytes32)), keccak256("mix"));
        else assertEq(ret, abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
    }

    /// @notice Before its target exists (from the start's own block to the target's block, 0 to 256 blocks on) a fix is
    /// refused `HeaderUnavailable(target)` and stores nothing, even with the header the target will carry and its hash
    /// already in the history contract's ring slot (P8.12: the current block and future blocks are no answer).
    function testFuzz_AUDIT_U8_fixBeforeTheTargetRefused(uint256 d) public {
        _requestOn(consumer, 0, r0, 0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        d = bound(d, 0, 256);
        _roll(d);
        assertLe(vm.getBlockNumber(), target);
        bytes memory h = AuditHeaders.header(target, keccak256("mix"));
        History2935.put(vm, target, keccak256(h));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h);
        (,, uint64 fixedAt, bytes32 mix) = src.backupOf(r0);
        assertEq(fixedAt, 0);
        assertEq(mix, bytes32(0));
    }

    /// @notice The history contract's answers outside its window are no answer: its ring slot still holding the
    /// target's hash one block after the window (target + 8,192) is not used.
    function testProperty_AUDIT_U8_historyOutsideItsWindowIsNoAnswer() public {
        _requestOn(consumer, 0, r0, 0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        bytes memory h = AuditHeaders.header(target, keccak256("mix"));
        vm.roll(target + 8192);
        History2935.put(vm, target, keccak256(h)); // the stale slot still holds the target's hash
        assertEq(vm.load(History2935.ADDRESS, bytes32(target % 8191)), keccak256(h));
        (bool served,) = History2935.ADDRESS.staticcall(abi.encode(target));
        assertFalse(served, "the history contract refuses a block 8,192 back");
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h);
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(fixedAt, 0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // L4 P8.6: the backup word

    /// @notice For a fixed target block the word is keccak256(BACKUP_TAG, the block's prevRandao, keccak256(consumer,
    /// key)), whoever starts (any account, any second of the 18 hours) and whoever fixes (any account, any block of the
    /// window); a forged header for the target is `WrongHeader`; `readyAt` is the fix's time.
    function testFuzz_AUDIT_U8_backupWordDependsOnlyOnTheTargetMix(
        bytes32 mix,
        bytes32 forged,
        address starter,
        address fixer,
        uint256 startDelay,
        uint256 fixDelay
    ) public {
        vm.assume(forged != mix);
        vm.assume(starter != address(vm) && fixer != address(vm));
        _requestOn(consumer, 4, r0 + 7, 0);
        startDelay = bound(startDelay, 1, 18 hours);
        vm.warp(src.roundTime(r0 + 7) + 5 days + startDelay);
        bytes memory p = _recentHeader(1);
        vm.prank(starter);
        uint256 target = src.startBackup(r0 + 7, vm.getBlockNumber() - 1, p);
        fixDelay = bound(fixDelay, 1, 8191);
        _roll(target + fixDelay - vm.getBlockNumber());
        bytes memory honest = _mine(target, mix);
        vm.prank(fixer);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0 + 7, AuditHeaders.header(target, forged));
        vm.prank(fixer);
        assertEq(src.fixBackup(r0 + 7, honest), mix);
        (bytes32 w, uint64 readyAt) = src.wordOf(consumer, 4);
        assertEq(w, keccak256(abi.encode(src.BACKUP_TAG(), mix, _id(consumer, 4))), "a function of the mix only");
        assertEq(readyAt, vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyFixed.selector, r0 + 7));
        src.fixBackup(r0 + 7, honest);
    }

    /// @notice Once started, the round's drand post (made at any later time) is ignored for good: the word is 0 until
    /// the fix, then the backup word; the drand word never appears for the backed source's consumers, while a direct
    /// DrandSource consumer on the same round gets drand's word.
    function testFuzz_AUDIT_U8_drandPostAfterStartIgnored(uint256 postDelay) public {
        _requestOn(consumer, 1, r0 + 9, 0);
        vm.prank(other);
        drand.request(1); // a direct (v2-style) consumer on the same round, same block
        vm.warp(src.roundTime(r0 + 9) + 5 days + 1);
        uint256 target = _start(r0 + 9);
        postDelay = bound(postDelay, 0, 3 days);
        vm.warp(vm.getBlockTimestamp() + postDelay);
        drand.postRound(r0 + 9, _localSig(9));
        (bytes32 w,) = src.wordOf(consumer, 1);
        assertEq(w, bytes32(0), "the post is ignored");
        (bytes32 v2Word,) = drand.wordOf(other, 1);
        assertTrue(v2Word != bytes32(0), "the direct consumer has drand's word");
        vm.roll(target + 1);
        src.fixBackup(r0 + 9, _mine(target, keccak256("b")));
        (w,) = src.wordOf(consumer, 1);
        assertEq(w, keccak256(abi.encode(src.BACKUP_TAG(), keccak256("b"), _id(consumer, 1))));
    }

    // ------------------------------------------------------------------------------------------------------------
    // L4 P8.7, L7 P8.14: rounds and time

    /// @notice `roundAt(t)` is the first round whose time is ≥ t (round 1 up to genesis), for any t up to 2^66.
    function testFuzz_AUDIT_U8_roundAtIsTheFirstRoundAtOrAfter(uint256 t) public view {
        t = bound(t, 0, uint256(1) << 66);
        uint256 r = src.roundAt(t);
        assertGe(r, 1);
        assertGe(src.roundTime(r), t, "at or after");
        if (r > 1) assertLt(src.roundTime(r - 1), t, "the first such round");
        assertEq(drand.roundAt(t), r, "both sources agree");
    }

    /// @notice At every round boundary: roundAt(roundTime(r)) = r, roundAt(roundTime(r) + 1) = r + 1,
    /// roundAt(roundTime(r) − 1) = r, and roundTime(r + 1) − roundTime(r) = 3; genesis is quicknet's.
    function testFuzz_AUDIT_U8_roundBoundaries(uint256 r) public view {
        r = bound(r, 1, type(uint64).max - 1);
        uint256 t = src.roundTime(r);
        assertEq(src.roundAt(t), r);
        assertEq(src.roundAt(t + 1), r + 1);
        assertEq(src.roundAt(t - 1), r);
        assertEq(src.roundTime(r + 1) - t, 3);
        assertEq(src.roundTime(1), vm.parseJsonUint(_boxDrandJson, ".genesisTime"));
        assertEq(drand.PERIOD(), vm.parseJsonUint(_boxDrandJson, ".period"));
    }

    /// @notice Every committed round's time is the vector's (api.drand.sh); round 0 has no time.
    function testProperty_AUDIT_U8_committedRoundTimes() public {
        for (uint256 i; i < _boxDrandCount(); ++i) {
            Round memory r = _boxDrandAt(i);
            assertEq(src.roundTime(r.round), r.time);
        }
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, 0));
        src.roundTime(0);
    }

    /// @notice A request's round is 12 to 14 s after its block, at any time from genesis to near 2^64 s (no wrap: the
    /// round fits in 64 bits and is stored as computed): never 15, so the 15 s of `BoxBackedSource.sol:38` and
    /// `BackupTimeline.t.sol` is a bound with 1 s of slack.
    function testFuzz_AUDIT_U8_requestRoundIs12To14SecondsAhead(uint256 ts, uint256 key) public {
        ts = bound(ts, drand.GENESIS_TIME() - 11, uint256(type(uint64).max) - 15);
        vm.warp(ts);
        vm.prank(consumer);
        uint256 round = src.request(key);
        uint256 gap = src.roundTime(round) - ts;
        assertGe(gap, 12, "at least MARGIN");
        assertLe(gap, 14, "at most 14 s");
        assertLe(round, type(uint64).max, "fits in 64 bits");
        (uint64 at, uint64 stored) = src.requestOf(consumer, key);
        assertEq(at, ts);
        assertEq(stored, round, "stored as computed");
        vm.warp(ts + 7 days);
        assertFalse(src.isSilent(consumer, key), "not silent at the deadline");
        vm.warp(ts + 7 days + 1);
        assertTrue(src.isSilent(consumer, key), "silent one second after");
    }

    // ------------------------------------------------------------------------------------------------------------
    // L6 P8.13, L8 P8.15: pins and deployment

    /// @notice Pins answer only on chains 1 and 11155111 (the same address and code hash there); on every other chain
    /// they are zeros and `isPinned` is false even for the deployed sources.
    function testFuzz_AUDIT_U8_pinsOnlyOnMainnetAndSepolia(uint64 chainId) public {
        (address a1, bytes32 h1) = DrandSourcePins.pinned(chainId);
        (address a2, bytes32 h2) = BackedSourcePins.pinned(chainId);
        vm.chainId(chainId);
        bool pinnedChain = chainId == 1 || chainId == 11_155_111;
        if (pinnedChain) {
            assertEq(a1, address(drand));
            assertEq(h1, address(drand).codehash);
            assertEq(a2, address(src));
            assertEq(h2, address(src).codehash);
        } else {
            assertEq(a1, address(0));
            assertEq(h1, bytes32(0));
            assertEq(a2, address(0));
            assertEq(h2, bytes32(0));
        }
        assertEq(DrandSourcePins.isPinned(address(drand)), pinnedChain);
        assertEq(BackedSourcePins.isPinned(address(src)), pinnedChain);
    }

    /// @notice The pins are CREATE2(Arachnid deployer, salt, keccak256(creation code)) of this build, the deployed code
    /// hashes are the pinned ones, and the backed source's DRAND is the pinned DrandSource.
    function testProperty_AUDIT_U8_pinsAreCreate2OfTheCompiledCode() public view {
        bytes32 dInit = keccak256(type(DrandSource).creationCode);
        bytes32 bInit = keccak256(type(BoxBackedSource).creationCode);
        assertEq(dInit, DrandSourcePins.INIT_CODE_HASH);
        assertEq(bInit, BackedSourcePins.INIT_CODE_HASH);
        assertEq(DrandSourcePins.SALT, keccak256("squarehole.box.v1.DrandSource"));
        assertEq(BackedSourcePins.SALT, keccak256("squarehole.box.v1.BoxBackedSource"));
        address d = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), DrandSourcePins.DEPLOYER, DrandSourcePins.SALT, dInit))
                )
            )
        );
        address b = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), BackedSourcePins.DEPLOYER, BackedSourcePins.SALT, bInit))
                )
            )
        );
        assertEq(d, DrandSourcePins.ADDRESS_MAINNET);
        assertEq(d, DrandSourcePins.ADDRESS_SEPOLIA);
        assertEq(b, BackedSourcePins.ADDRESS_MAINNET);
        assertEq(b, BackedSourcePins.ADDRESS_SEPOLIA);
        assertEq(address(drand), d);
        assertEq(address(src), b);
        assertEq(d.codehash, DrandSourcePins.CODE_HASH_MAINNET);
        assertEq(b.codehash, BackedSourcePins.CODE_HASH_MAINNET);
        assertEq(DrandSourcePins.CODE_HASH_SEPOLIA, DrandSourcePins.CODE_HASH_MAINNET);
        assertEq(BackedSourcePins.CODE_HASH_SEPOLIA, BackedSourcePins.CODE_HASH_MAINNET);
        assertEq(address(src.DRAND()), DrandSourcePins.ADDRESS_MAINNET, "the backed source names the pinned source");
    }
}

/// @notice TEST ONLY. A payout address whose receive reverts.
contract AuditU8ClaudeRevertingPayee {
    receive() external payable {
        revert("no");
    }
}

/// @notice ETH at the predicted addresses before anyone deploys (L8): the deployment still lands with the pinned code,
/// the sources work, and the early wei just stays (no exit: the M27 class).
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudePrefundedPinsTest is BoxDrandVectors {
    function testProperty_AUDIT_U8_prefundedPinnedAddressesChangeNothing() public {
        _loadBoxDrand();
        uint256 r0 = _localFirst();
        vm.chainId(1);
        address d = PinnedDrandSource.predict();
        address b = PinnedBackedSource.predict();
        vm.deal(d, 1 ether);
        vm.deal(b, 2 ether);
        DrandSource drand = PinnedDrandSource.deploy(vm);
        BoxBackedSource src = PinnedBackedSource.deploy(vm);
        assertEq(address(drand), d);
        assertEq(address(src), b);
        assertEq(d.codehash, DrandSourcePins.CODE_HASH_MAINNET, "the pinned code");
        assertEq(b.codehash, BackedSourcePins.CODE_HASH_MAINNET);
        assertTrue(DrandSourcePins.isPinned(d) && BackedSourcePins.isPinned(b));
        address c = makeAddr("audit.u8.prefund.consumer");
        vm.deal(c, 1 ether);
        vm.warp(src.roundTime(r0) - 12);
        vm.prank(c);
        src.request{value: 0.5 ether}(1);
        assertEq(src.bountyOf(r0), 0.5 ether, "the pot counts only the bounty");
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        assertEq(drand.owedTo(address(this)), 0.5 ether);
        drand.withdrawBounty(payable(makeAddr("audit.u8.prefund.payee")));
        assertEq(d.balance, 1 ether, "the early wei stays at the DrandSource, outside every ledger");
        assertEq(b.balance, 2 ether, "and at the backed source");
        (bytes32 w,) = src.wordOf(c, 1);
        assertTrue(w != bytes32(0));
    }
}

/// @notice The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeSourcesAmsterdamTest is AuditU8ClaudeSourcesTest {}
