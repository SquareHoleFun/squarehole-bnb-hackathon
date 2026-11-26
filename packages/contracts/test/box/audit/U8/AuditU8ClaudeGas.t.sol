// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";

/// @notice TEST ONLY. Reads `wordOf` as the consumers do (a STATICCALL with exactly 50,000 gas, 64 bytes back) and
/// measures the gas of that call in the caller's frame (the call's own account access included).
contract AuditU8ClaudeWordMeter {
    function read(address source, address consumer, uint256 key)
        external
        view
        returns (bool ok, uint256 size, uint256 used, bytes32 word, uint64 readyAt)
    {
        bytes memory data = abi.encodeCall(IDrandSource.wordOf, (consumer, key));
        uint256 g0 = gasleft();
        bytes memory ret;
        (ok, ret) = source.staticcall{gas: 50_000}(data);
        used = g0 - gasleft();
        size = ret.length;
        if (ok && ret.length == 64) (word, readyAt) = abi.decode(ret, (bytes32, uint64));
    }
}

/// @notice TEST ONLY. A consumer of the backed source written with `DrandWords` (whose bounded read box 0's tickets copy
/// as `_wordOf`): it requests through the source and reads with `DrandWords.wordOf` / `isDead`.
contract AuditU8ClaudeWordsConsumer {
    IDrandSource internal immutable source;

    constructor(IDrandSource source_) {
        source = source_;
    }

    function request(uint256 key) external returns (uint256) {
        return DrandWords.request(source, key, 0);
    }

    function read(uint256 key) external view returns (bytes32 word, uint256 readyAt) {
        return DrandWords.wordOf(source, key);
    }

    function dead(uint256 key, uint256 requestedAt) external view returns (bool) {
        return DrandWords.isDead(source, key, requestedAt);
    }
}

/// @title AuditU8ClaudeGasTest (SH-AUDIT-B0 U8, lens L5 P8.8: the 50,000-gas word read)
/// @notice Sources: `IDrandSource.sol:23` ("answers within 50,000 gas in every state"), `DrandSource.sol:36-37`,
/// `:150-151`, `BoxBackedSource.sol:53-54` ("about 20,000 gas cold on both EVMs, within the consumers' 50,000"),
/// `DrandWords.sol:23-25` and `:110-114` ("a caller that leaves too little gas for the full read reverts `GasTooLow`, so
/// a failure is always the source's own"), the unit brief's P8.8. Properties:
/// - `wordOf` of the backed source and of the DrandSource, read cold with exactly 50,000 gas, answers 64 bytes and the
///   right word in every state (never requested; requested and unposted, also silent past 7 days; posted; backup
///   started; backup fixed; posted 8 days late) under Cancun, Osaka and Amsterdam; the worst is pinned;
/// - a `DrandWords` consumer given any gas limit either reads the right word or reverts (`GasTooLow` or out of gas):
///   it never reads "no word", and `isDead` never says dead, while a usable word exists (cold, Osaka and Amsterdam).
/// The states are built on committed rounds r0 + k (one request per round, each in its own block).
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeGasTest is BoxDrandVectors {
    /// @notice The pinned worst cold read of the backed source over the three EVMs (BackupGas.t.sol pins 21,000 on two).
    uint256 internal constant WORST_PIN = 21_000;

    DrandSource internal drand;
    BoxBackedSource internal src;
    AuditU8ClaudeWordMeter internal meter;
    AuditU8ClaudeWordsConsumer internal consumer;
    address internal direct = makeAddr("audit.u8.gas.direct");
    uint256 internal r0;

    uint256 internal constant K_NONE = 99;
    uint256 internal constant K_REQUESTED = 1; // r0 + 1, never posted (silent at the end)
    uint256 internal constant K_POSTED = 2; // r0 + 2, posted on time
    uint256 internal constant K_STARTED = 3; // r0 + 3, backup started, never fixed
    uint256 internal constant K_FIXED = 5; // r0 + 5, backup fixed
    uint256 internal constant K_LATE = 6; // r0 + 6, posted 8 days after the request
    uint256 internal constant K_DIRECT_POSTED = 7; // the direct consumer on r0 + 7, posted
    uint256 internal constant K_DIRECT_NONE = 9; // the direct consumer on r0 + 9, never posted

    mapping(uint256 => bytes32) internal expected;
    mapping(uint256 => uint64) internal expectedAt;
    mapping(uint256 => uint256) internal requestedAt;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        src = PinnedBackedSource.deploy(vm);
        meter = new AuditU8ClaudeWordMeter();
        consumer = new AuditU8ClaudeWordsConsumer(IDrandSource(address(src)));
        vm.roll(23_000_000);
        uint256[7] memory ks = [K_REQUESTED, K_POSTED, K_STARTED, K_FIXED, K_LATE, K_DIRECT_POSTED, K_DIRECT_NONE];
        for (uint256 i; i < ks.length; ++i) {
            uint256 k = ks[i];
            vm.warp(src.roundTime(r0 + k) - 12);
            vm.roll(vm.getBlockNumber() + 1);
            requestedAt[k] = vm.getBlockTimestamp();
            if (k == K_DIRECT_POSTED || k == K_DIRECT_NONE) {
                vm.prank(direct);
                assertEq(drand.request(k), r0 + k);
            } else {
                assertEq(consumer.request(k), r0 + k);
            }
        }
        vm.warp(src.roundTime(r0 + 9));
        bytes32 rnd = drand.postRound(r0 + 2, _localSig(2));
        expected[K_POSTED] = keccak256(abi.encode(src.DRAND_TAG(), rnd, _id(address(consumer), K_POSTED)));
        expectedAt[K_POSTED] = uint64(vm.getBlockTimestamp());
        rnd = drand.postRound(r0 + 7, _localSig(7));
        expected[K_DIRECT_POSTED] = keccak256(abi.encode(drand.WORD_TAG(), rnd, _id(direct, K_DIRECT_POSTED)));
        expectedAt[K_DIRECT_POSTED] = uint64(vm.getBlockTimestamp());
        // r0 + 3 and r0 + 5 start in one block (inside both windows); r0 + 5 is fixed through BLOCKHASH.
        vm.warp(src.roundTime(r0 + 6) + 5 days + 1);
        vm.roll(vm.getBlockNumber() + 1);
        vm.setBlockhash(vm.getBlockNumber() - 1, keccak256(HeaderVectors.MAINNET));
        src.startBackup(r0 + 3, vm.getBlockNumber() - 1, HeaderVectors.MAINNET);
        uint256 target = src.startBackup(r0 + 5, vm.getBlockNumber() - 1, HeaderVectors.MAINNET);
        vm.roll(target + 1);
        vm.warp(vm.getBlockTimestamp() + 12 * 257);
        bytes memory h = AuditHeaders.header(target, keccak256("gas mix"));
        vm.setBlockhash(target, keccak256(h));
        src.fixBackup(r0 + 5, h);
        expected[K_FIXED] =
            keccak256(abi.encode(src.BACKUP_TAG(), keccak256("gas mix"), _id(address(consumer), K_FIXED)));
        expectedAt[K_FIXED] = uint64(vm.getBlockTimestamp());
        // r0 + 6 posted 8 days after its request: a word, but a late one.
        vm.warp(requestedAt[K_LATE] + 8 days);
        rnd = drand.postRound(r0 + 6, _localSig(6));
        expected[K_LATE] = keccak256(abi.encode(src.DRAND_TAG(), rnd, _id(address(consumer), K_LATE)));
        expectedAt[K_LATE] = uint64(vm.getBlockTimestamp());
        assertTrue(src.isSilent(address(consumer), K_REQUESTED), "silent");
        assertTrue(src.isSilent(address(consumer), K_STARTED), "started, never fixed: silent");
        assertTrue(src.isSilent(address(consumer), K_LATE), "late: silent");
        assertFalse(src.isSilent(address(consumer), K_FIXED));
        assertFalse(src.isSilent(address(consumer), K_POSTED));
    }

    function _id(address c, uint256 k) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, k));
    }

    /// @notice Every state, read cold with exactly 50,000 gas under Cancun, Osaka and Amsterdam: 64 bytes, the right word
    /// and time; the worst read of the backed source stays at or below `WORST_PIN` (logged per EVM).
    function testProperty_AUDIT_U8_wordOfWithin50kInEveryStateOnEveryEvm() public {
        string[3] memory evms = ["cancun", "osaka", "amsterdam"];
        uint256[8] memory keys =
            [K_NONE, K_REQUESTED, K_POSTED, K_STARTED, K_FIXED, K_LATE, K_DIRECT_POSTED, K_DIRECT_NONE];
        uint256 worstAll;
        for (uint256 e; e < 3; ++e) {
            vm.setEvmVersion(evms[e]);
            uint256 worstBacked;
            uint256 worstDirect;
            for (uint256 i; i < keys.length; ++i) {
                (uint256 used, bool isDirect) = _readOne(keys[i]);
                if (isDirect) worstDirect = used > worstDirect ? used : worstDirect;
                else worstBacked = used > worstBacked ? used : worstBacked;
            }
            emit log_named_uint(string.concat(evms[e], ": worst cold wordOf, backed source"), worstBacked);
            emit log_named_uint(string.concat(evms[e], ": worst cold wordOf, DrandSource"), worstDirect);
            if (worstBacked > worstAll) worstAll = worstBacked;
        }
        vm.setEvmVersion("osaka");
        assertLe(worstAll, WORST_PIN, "the pinned worst");
        emit log_named_uint("margin x100 under 50,000", 5_000_000 / worstAll);
    }

    /// @dev One cold read of `key`'s word through the meter (a CALL boundary, so a switched EVM applies).
    function _readOne(uint256 key) internal returns (uint256 used, bool isDirect) {
        isDirect = key == K_DIRECT_POSTED || key == K_DIRECT_NONE;
        vm.cool(address(src));
        vm.cool(address(drand));
        (bool called, bytes memory ret) = address(meter)
            .call(
                abi.encodeCall(
                    AuditU8ClaudeWordMeter.read,
                    (isDirect ? address(drand) : address(src), isDirect ? direct : address(consumer), key)
                )
            );
        assertTrue(called);
        bool ok;
        uint256 size;
        bytes32 w;
        uint64 at;
        (ok, size, used, w, at) = abi.decode(ret, (bool, uint256, uint256, bytes32, uint64));
        assertTrue(ok && size == 64, "answers within 50,000");
        assertEq(w, expected[key], "the right word");
        assertEq(at, expectedAt[key], "the right time");
        assertLe(used, 50_000);
    }

    /// @notice A `DrandWords` consumer with any gas limit, cold: the right word, or a revert (`GasTooLow`, out of gas);
    /// never "no word" while the word exists. `isDead` past the deadline: false or a revert, never true.
    function testFuzz_AUDIT_U8_consumerNeverReadsNoWordForLackOfGas(uint256 gas, bool backupWord) public {
        uint256 key = backupWord ? K_FIXED : K_POSTED;
        gas = bound(gas, 0, 150_000);
        vm.cool(address(consumer));
        vm.cool(address(src));
        vm.cool(address(drand));
        (bool ok, bytes memory ret) =
            address(consumer).staticcall{gas: gas}(abi.encodeCall(AuditU8ClaudeWordsConsumer.read, (key)));
        if (ok) {
            (bytes32 w, uint256 at) = abi.decode(ret, (bytes32, uint256));
            assertEq(w, expected[key], "the word, never none");
            assertEq(at, expectedAt[key]);
        } else {
            assertTrue(
                ret.length == 0 || keccak256(ret) == keccak256(abi.encodeWithSelector(DrandWords.GasTooLow.selector))
            );
        }
        vm.cool(address(consumer));
        vm.cool(address(src));
        vm.cool(address(drand));
        (ok, ret) = address(consumer).staticcall{gas: gas}(
            abi.encodeCall(AuditU8ClaudeWordsConsumer.dead, (key, requestedAt[key]))
        );
        if (ok) {
            assertFalse(abi.decode(ret, (bool)), "a usable word is never dead");
        } else {
            assertTrue(
                ret.length == 0 || keccak256(ret) == keccak256(abi.encodeWithSelector(DrandWords.GasTooLow.selector))
            );
        }
    }

    /// @notice Gas limits from 40,000 to 80,000 (steps of 97), then every limit within 300 of the least that reads, one
    /// by one, cold, for both words: below some limit the read reverts, from it on it reads the word; nothing else
    /// (the least reading limit is logged).
    function testProperty_AUDIT_U8_consumerGasSweep() public {
        uint256[2] memory keys = [K_POSTED, K_FIXED];
        for (uint256 j; j < 2; ++j) {
            uint256 coarse = _sweep(keys[j], 40_000, 80_000, 97);
            assertGt(coarse, 0, "some limit reads");
            uint256 fine = _sweep(keys[j], coarse - 300, coarse + 300, 1);
            assertGt(fine, 0);
            emit log_named_uint(
                j == 0
                    ? "least gas limit that reads a drand word (cold)"
                    : "least gas limit that reads a backup word (cold)",
                fine
            );
        }
    }

    /// @dev Reads `key` at every limit in [from, to] by `step`: reverts below the first limit that reads, the right word
    /// from it on; returns that limit (0 if none).
    function _sweep(uint256 key, uint256 from, uint256 to, uint256 step) internal returns (uint256 firstRead) {
        for (uint256 g = from; g <= to; g += step) {
            vm.cool(address(consumer));
            vm.cool(address(src));
            vm.cool(address(drand));
            (bool ok, bytes memory ret) =
                address(consumer).staticcall{gas: g}(abi.encodeCall(AuditU8ClaudeWordsConsumer.read, (key)));
            if (!ok) {
                assertEq(firstRead, 0, "once it reads, a larger limit reads too");
                assertTrue(
                    ret.length == 0
                        || keccak256(ret) == keccak256(abi.encodeWithSelector(DrandWords.GasTooLow.selector))
                );
                continue;
            }
            (bytes32 w,) = abi.decode(ret, (bytes32, uint256));
            assertEq(w, expected[key], "never no word");
            if (firstRead == 0) firstRead = g;
        }
    }
}

/// @notice The same under Amsterdam (the read sweep and fuzz; the every-EVM table switches on its own).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeGasAmsterdamTest is AuditU8ClaudeGasTest {}
