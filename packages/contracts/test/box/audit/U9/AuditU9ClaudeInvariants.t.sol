// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditU9ClaudeTwinVectors as TV} from "./AuditU9ClaudeTwinVectors.sol";
import {AuditU9ClaudeTipThief, AuditU9ClaudeWorldMulticall} from "./AuditU9ClaudeWorld.t.sol";

// ==================================================================================================== the spec walk

/// @notice TEST ONLY: validate() and specHash behind external calls (a revert is a finding, never a skip).
contract AuditU9ClaudeSpecOracle {
    function verdict(bytes calldata encoded) external pure returns (uint16 reason, uint16 field, bytes32 h) {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        (reason, field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        h = BoxSpecV1.specHash(s);
    }

    /// @dev Named so forge does not read it as a table test.
    function checkTable(bytes calldata table) external pure returns (bool) {
        BoxMetadataTable.validate(table);
        return true;
    }

    function placeholderTexts(bytes calldata params)
        external
        pure
        returns (string memory a, string memory b, string memory c, string memory d, string memory e)
    {
        return abi.decode(params, (string, string, string, string, string));
    }
}

/// @notice TEST ONLY: walks one BoxSpec through random edits near every limit (each call one edit, or a reset to a
/// valid fixture), and after each records validate()'s verdict, the hash, and what must never happen in ghosts.
contract AuditU9ClaudeSpecHandler is Test {
    AuditU9ClaudeSpecOracle internal immutable oracle;

    bytes public encoded;
    uint16 public reason;
    uint16 public field;
    bytes32 public hash;
    bytes32 public previousHash;
    bytes32 public previousEncodingHash;

    /// Ghosts: each counts something that must never happen.
    uint256 public validateReverted;
    uint256 public unknownVerdict;
    uint256 public acceptedButBreaksARule;
    uint256 public hashNotTheEncodingsKeccak;
    uint256 public hashUnchangedOnAChange;
    uint256 public tableChecksDisagree;
    /// Counts of what happened (the run reaches both verdicts).
    uint256 public accepted;
    uint256 public refused;
    uint256 public edits;

    constructor(AuditU9ClaudeSpecOracle oracle_) {
        oracle = oracle_;
        encoded = TV.base(0);
        _record();
    }

    // ------------------------------------------------------------------------------------------------ actions

    function reset(uint8 base) external {
        encoded = TV.base(base % 3);
        _record();
    }

    /// One scalar field set to a value near its limits (or random).
    function setScalar(uint8 which, uint256 seed) external {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        uint256 w = which % 16;
        uint256 v = _near(w, seed);
        // forge-lint: disable-start(unsafe-typecast)
        if (w == 0) s.version = uint16(v);
        else if (w == 1) s.boxType = uint8(v);
        else if (w == 2) s.n = uint32(v);
        else if (w == 3) s.firstId = v;
        else if (w == 4) s.raise = v;
        else if (w == 5) s.layout = uint8(v);
        else if (w == 6) s.gradLayout = uint8(v);
        else if (w == 7) s.launchFormat = uint8(v);
        else if (w == 8) s.openAt = uint32(v);
        else if (w == 9) s.deadlineDays = uint16(v);
        else if (w == 10) s.qStream = uint8(v);
        else if (w == 11) s.tStream = uint8(v);
        else if (w == 12) s.artMode = uint8(v);
        else if (w == 13) s.creatorBuy = v;
        else if (w == 14) s.creatorFeeRecipient = v % 3 == 0 ? address(uint160(v)) : address(0);
        else s.revealListId = v % 3 == 0 ? bytes32(v) : bytes32(0);
        // forge-lint: disable-end(unsafe-typecast)
        _store(s);
    }

    function _near(uint256 w, uint256 seed) internal pure returns (uint256) {
        uint256 k = seed % 8;
        if (w == 0) return [uint256(0), 1, 2, 3, 1, 1, 65535, 2][k];
        if (w == 1) return [uint256(0), 1, 2, 3, 4, 1, 255, 1][k];
        if (w == 2) return [uint256(0), 9, 10, 4269, 10_000, 10_001, type(uint32).max, 1969][k];
        if (w == 3) return [uint256(0), 1, 2, 1, 1, type(uint256).max, 1, 1][k];
        if (w == 4) {
            return [
                uint256(4_206_980_085_000_000_000),
                4_206_980_085_000_000_001,
                4_206_980_084_999_999_999,
                0,
                1 ether,
                420_698_008_500_000_000,
                seed,
                4_206_980_085_000_000_000
            ][k];
        }
        if (w == 8) {
            return [uint256(0), 1, 1_788_220_799, 1_788_220_800, type(uint32).max, 1_800_000_000, seed % 2 ** 32, 0][k];
        }
        if (w == 9) return [uint256(0), 30, 60, 90, 180, 45, 65535, 0][k];
        if (w == 13) return [uint256(0), 1, 0, 4_206_980_084_999_999_999, seed, 0, 0, 0][k];
        if (w == 14 || w == 15) return seed;
        return (seed >> 8) % (k == 7 ? 256 : 9);
    }

    /// One text field (or a placeholders text) set to `len` bytes, with one byte set to `bad` at `at`.
    function setText(uint8 which, uint16 len, uint8 at, uint8 bad) external {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        uint256 w = which % 7;
        uint256 max = w == 1 || w == 3 ? 12 : (w == 4 ? 1025 : 33);
        bytes memory t = new bytes(len % (max + 1));
        for (uint256 i; i < t.length; ++i) {
            t[i] = bytes1(uint8(0x61 + i % 26));
        }
        if (t.length != 0 && bad % 4 == 0) t[at % t.length] = bytes1(bad);
        if (w == 0) {
            s.tokenName = string(t);
        } else if (w == 1) {
            s.tokenSymbol = string(t);
        } else if (w == 2) {
            s.collectionName = string(t);
        } else if (w == 3) {
            s.collectionSymbol = string(t);
        } else if (w == 4) {
            s.description = string(t);
        } else if (s.addOns.length != 0 && s.addOns[0].id == BoxSpecV1.ADD_ON_PLACEHOLDERS) {
            // The params may have been cut or extended by editAddOns: decoded in a frame that may revert.
            try oracle.placeholderTexts(s.addOns[0].params) returns (
                string memory a, string memory b, string memory c, string memory d, string memory e
            ) {
                if (w == 5) a = string(t);
                else e = string(t);
                s.addOns[0].params = abi.encode(a, b, c, d, e);
            } catch {}
        }
        _store(s);
    }

    /// The add-on list: one entry dropped, duplicated, moved, given another id, or its params cut or extended.
    function editAddOns(uint8 op, uint8 index, uint16 id) external {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        uint256 n = s.addOns.length;
        if (n == 0) {
            s.addOns = new BoxSpecV1.AddOn[](1);
            s.addOns[0] = BoxSpecV1.AddOn({id: id % 8, params: ""});
            _store(s);
            return;
        }
        uint256 i = index % n;
        uint256 o = op % 6;
        if (o == 0) {
            BoxSpecV1.AddOn[] memory list = new BoxSpecV1.AddOn[](n - 1);
            for (uint256 j; j < n - 1; ++j) {
                list[j] = s.addOns[j < i ? j : j + 1];
            }
            s.addOns = list;
        } else if (o == 1) {
            BoxSpecV1.AddOn[] memory list = new BoxSpecV1.AddOn[](n + 1);
            for (uint256 j; j < n; ++j) {
                list[j] = s.addOns[j];
            }
            list[n] = s.addOns[i];
            s.addOns = list;
        } else if (o == 2) {
            (s.addOns[i], s.addOns[0]) = (s.addOns[0], s.addOns[i]);
        } else if (o == 3) {
            s.addOns[i].id = id % 9;
        } else if (o == 4) {
            bytes memory p = s.addOns[i].params;
            if (p.length != 0) {
                assembly ("memory-safe") {
                    mstore(p, sub(mload(p), 1))
                }
            }
        } else {
            s.addOns[i].params = bytes.concat(s.addOns[i].params, bytes1(uint8(id)));
        }
        _store(s);
    }

    /// The metadata table: a byte set, the last byte dropped, a byte appended, or a small table of its own.
    function editTable(uint8 op, uint16 at, uint8 value) external {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        bytes memory t = s.metadataTable;
        uint256 o = op % 4;
        if (o == 0 && t.length != 0) {
            t[at % t.length] = bytes1(value);
        } else if (o == 1 && t.length != 0) {
            assembly ("memory-safe") {
                mstore(t, sub(mload(t), 1))
            }
        } else if (o == 2) {
            t = bytes.concat(t, bytes1(value));
        } else {
            t = abi.encodePacked(hex"010001", bytes1(value), hex"0101410101", bytes1(uint8(0x41 + value % 26)));
        }
        s.metadataTable = t;
        _store(s);
    }

    // ------------------------------------------------------------------------------------------------ recording

    function _store(BoxSpecV1.BoxSpec memory s) internal {
        encoded = abi.encode(s);
        ++edits;
        _record();
    }

    function _record() internal {
        bytes memory e = encoded;
        previousHash = hash;
        try oracle.verdict(e) returns (uint16 r, uint16 f, bytes32 h) {
            (reason, field, hash) = (r, f, h);
        } catch {
            ++validateReverted;
            return;
        }
        if (reason > BoxSpecV1.REASON_METADATA_TABLE_MALFORMED || (reason == 0) != (field == 0)) ++unknownVerdict;
        if (hash != keccak256(e)) ++hashNotTheEncodingsKeccak;
        bytes32 encodingHash = keccak256(e);
        if (encodingHash != previousEncodingHash && previousEncodingHash != bytes32(0) && hash == previousHash) {
            ++hashUnchangedOnAChange;
        }
        previousEncodingHash = encodingHash;
        BoxSpecV1.BoxSpec memory s = abi.decode(e, (BoxSpecV1.BoxSpec));
        bool tableOk;
        try oracle.checkTable(s.metadataTable) returns (bool ok) {
            tableOk = ok;
        } catch {}
        if (reason == BoxSpecV1.REASON_OK) {
            ++accepted;
            if (!_rulesHold(s) || !tableOk) ++acceptedButBreaksARule;
        } else {
            ++refused;
        }
        // The two table checks agree on this table (judged on box 0's clean fixture, where only the table can fail).
        BoxSpecV1.BoxSpec memory clean = abi.decode(TV.base(0), (BoxSpecV1.BoxSpec));
        clean.metadataTable = s.metadataTable;
        (uint16 r2,) = BoxSpecV1.validate(clean, BoxSpecV1.contextV1());
        if ((r2 == BoxSpecV1.REASON_OK) != tableOk) ++tableChecksDisagree;
    }

    /// @dev The documented rules an accepted spec meets (from the case texts, as AuditU9ClaudeSpec.t.sol's oracles).
    function _rulesHold(BoxSpecV1.BoxSpec memory s) internal pure returns (bool) {
        if (s.version != 1 && s.version != 2) return false;
        if (s.boxType == BoxSpecV1.BOX_TYPE_NEW_COLLECTION && (s.n < 10 || s.n > 10_000)) return false;
        if (s.firstId != 1 || s.raise != BoxSpecV1.qListV1()[0].raisePresets[0] || s.q != address(0)) return false;
        if (s.version == 1 && (s.deadlineDays != 0 || s.creatorBuy != 0 || s.creatorFeeRecipient != address(0))) {
            return false;
        }
        if (s.openAt != 0 && s.openAt < BoxSpecV1.MIN_OPEN_AT) return false;
        if (!_json(bytes(s.tokenName), 1, 32) || !_json(bytes(s.tokenSymbol), 1, 11)) return false;
        if (!_json(bytes(s.description), 0, 1024)) return false;
        if (s.boxType == BoxSpecV1.BOX_TYPE_NEW_COLLECTION) {
            if (!_json(bytes(s.collectionName), 1, 32) || !_json(bytes(s.collectionSymbol), 1, 11)) return false;
        }
        if (s.qStream == 4 || s.qStream == 7 || s.tStream == 2 || s.tStream == 7) return false;
        if (s.artMode == BoxSpecV1.ART_MODE_HIDDEN && s.revealListId != bytes32(0)) return false;
        return s.addOns.length <= BoxSpecV1.MAX_ADD_ONS;
    }

    function _json(bytes memory b, uint256 min, uint256 max) internal pure returns (bool) {
        if (b.length < min || b.length > max) return false;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) return false;
        }
        return true;
    }
}

/// @title AuditU9ClaudeSpecInvariants (SH-AUDIT-B0-U9, Claude; P9.2, P9.8, P9.11 as invariants; lenses L2, L7)
/// @notice A random walk over the spec space from box 0's fixture: after every edit, validate() has not reverted,
/// its verdict is a known (reason, field) pair, an accepted spec meets the documented rules and has a table the
/// collection accepts, specHash is keccak256 of the encoding and moves with every change, and the spec's table check
/// and the collection's agree.
contract AuditU9ClaudeSpecInvariants is Test {
    AuditU9ClaudeSpecHandler internal handler;

    function setUp() public {
        handler = new AuditU9ClaudeSpecHandler(new AuditU9ClaudeSpecOracle());
        targetContract(address(handler));
    }

    function invariant_AUDIT_U9_validateNeverReverts() public view {
        assertEq(handler.validateReverted(), 0);
    }

    function invariant_AUDIT_U9_verdictIsAKnownPair() public view {
        assertEq(handler.unknownVerdict(), 0);
    }

    function invariant_AUDIT_U9_acceptedSpecsMeetTheRules() public view {
        assertEq(handler.acceptedButBreaksARule(), 0);
    }

    function invariant_AUDIT_U9_specHashIsTheEncodingsKeccak() public view {
        assertEq(handler.hashNotTheEncodingsKeccak(), 0);
        assertEq(handler.hashUnchangedOnAChange(), 0);
    }

    function invariant_AUDIT_U9_tableChecksAgree() public view {
        assertEq(handler.tableChecksDisagree(), 0);
    }

    function afterInvariant() external {
        // The walk starts accepted (box 0's fixture); every reset returns there.
        assertGe(handler.accepted(), 1);
        emit log_named_uint("edits", handler.edits());
        emit log_named_uint("accepted", handler.accepted());
        emit log_named_uint("refused", handler.refused());
    }
}

// =================================================================================================== the lock on box 0

/// @notice TEST ONLY: calls box 0's guarded entry points in pairs inside one transaction, re-enters them from a tip
/// payment, and calls their PoolManager callbacks from outside; every outcome that would break the lock's contract is
/// a ghost. It also buys (through the launch router in the window, the Universal Router stand-in after it) so fee
/// batches form and tips are paid. It never reverts (fail_on_revert): every call is caught.
contract AuditU9ClaudeLockHandler is Test {
    bytes4 internal constant REENTRANCY = 0xab143c06;

    struct Box {
        IPoolManager pm;
        address receiver;
        address executor;
        address coordinator;
        address launchRouter;
        address hook;
        AuditRouterSwapper swapper;
    }

    Box internal b;
    PoolKey internal key;
    AuditU9ClaudeWorldMulticall internal immutable multi;

    uint256 public pairs;
    uint256 public secondFailed;
    uint256 public reentryAccepted;
    uint256 public thiefRuns;
    uint256 public gateOpened;
    uint256 public gateChecks;
    uint256 public routerPairs;
    uint256 public routerSecondFailed;
    uint256 public buys;
    /// Net ETH this handler's side (itself, its multicall and its thieves: all outside box 0) put into box 0 and got
    /// out of it, for the world's ghost ledger.
    uint256 public ethIn;
    uint256 public ethOut;

    constructor(Box memory box, PoolKey memory key_) {
        b = box;
        key = key_;
        multi = new AuditU9ClaudeWorldMulticall();
    }

    function _outside() internal view returns (uint256) {
        return address(this).balance + address(multi).balance;
    }

    function _book(uint256 before) internal {
        uint256 afterBal = _outside();
        if (before > afterBal) ethIn += before - afterBal;
        else ethOut += afterBal - before;
    }

    function _first(uint256 kind, uint256 amount) internal view returns (AuditU9ClaudeWorldMulticall.Call memory) {
        uint256 k = kind % 7;
        if (k == 0) {
            return AuditU9ClaudeWorldMulticall.Call(b.receiver, amount, abi.encodeCall(IBoxReceiver.fundDepth, ()));
        }
        if (k == 1) {
            return AuditU9ClaudeWorldMulticall.Call(b.receiver, amount, abi.encodeCall(IBoxReceiver.fundFees, ()));
        }
        if (k == 2) {
            return
                AuditU9ClaudeWorldMulticall.Call(b.receiver, 0, abi.encodeCall(IBoxReceiver.collect, (address(multi))));
        }
        if (k == 3) return AuditU9ClaudeWorldMulticall.Call(b.executor, amount, "");
        if (k == 4) return AuditU9ClaudeWorldMulticall.Call(b.executor, 0, abi.encodeWithSignature("poke()"));
        if (k == 5) {
            return AuditU9ClaudeWorldMulticall.Call(
                b.coordinator, 0, abi.encodeWithSignature("claimReward(address)", address(multi))
            );
        }
        return AuditU9ClaudeWorldMulticall.Call(b.launchRouter, 0, abi.encodeWithSignature("sweep()"));
    }

    /// @dev A guarded call that succeeds whenever the lock is free (in every phase this handler reaches).
    function _second(uint256 kind, uint256 amount) internal view returns (AuditU9ClaudeWorldMulticall.Call memory) {
        uint256 k = kind % 3;
        if (k == 0) {
            return AuditU9ClaudeWorldMulticall.Call(b.receiver, amount, abi.encodeCall(IBoxReceiver.fundDepth, ()));
        }
        if (k == 1) {
            return AuditU9ClaudeWorldMulticall.Call(b.executor, amount, abi.encodeWithSignature("fundBudget()"));
        }
        return AuditU9ClaudeWorldMulticall.Call(b.executor, 0, abi.encodeWithSignature("poke()"));
    }

    /// Two guarded calls of box 0 in one transaction: whatever the first did (succeeded, or reverted inside its lock),
    /// the second, which succeeds on a free lock, must succeed.
    function pair(uint8 first, uint8 second, uint64 x, uint64 y) external {
        AuditU9ClaudeWorldMulticall.Call[] memory c = new AuditU9ClaudeWorldMulticall.Call[](2);
        c[0] = _first(first, 1 + uint256(x) % 1e15);
        c[1] = _second(second, 1 + uint256(y) % 1e15);
        uint256 value = c[0].value + c[1].value;
        vm.deal(address(this), address(this).balance + value);
        uint256 before = _outside();
        try multi.run{value: value}(c) returns (bool[] memory ok, bytes[] memory) {
            ++pairs;
            if (!ok[1]) ++secondFailed;
        } catch {
            ++secondFailed;
        }
        _book(before);
    }

    /// Two taxed buys through the launch router in one transaction, inside the window (warped there first when it
    /// has not opened yet): both succeed.
    function routerPair(uint64 x, uint64 y) external {
        uint256 openAt = IBoxHook(b.hook).openAt();
        if (block.timestamp < openAt) {
            uint256 t = openAt + 12 * (uint256(x) % 30);
            vm.roll(block.number + (t - block.timestamp) / 12 + 1);
            vm.warp(t);
        }
        if (block.timestamp >= IBoxHook(b.hook).windowEndsAt()) return;
        if (IBoxHook(b.hook).closed()) return;
        uint256 qa = 0.001 ether + uint256(x) % 0.01 ether;
        uint256 qb = 0.001 ether + uint256(y) % 0.01 ether;
        AuditU9ClaudeWorldMulticall.Call[] memory c = new AuditU9ClaudeWorldMulticall.Call[](2);
        c[0] = AuditU9ClaudeWorldMulticall.Call(
            b.launchRouter,
            qa,
            abi.encodeWithSignature("buy(uint256,uint256,address,uint256)", qa, 1, address(multi), block.timestamp)
        );
        c[1] = AuditU9ClaudeWorldMulticall.Call(
            b.launchRouter,
            qb,
            abi.encodeWithSignature("buy(uint256,uint256,address,uint256)", qb, 1, address(multi), block.timestamp)
        );
        vm.deal(address(this), address(this).balance + qa + qb);
        uint256 before = _outside();
        try multi.run{value: qa + qb}(c) returns (bool[] memory ok, bytes[] memory) {
            ++routerPairs;
            if (ok[0] && !ok[1]) ++routerSecondFailed;
        } catch {}
        _book(before);
    }

    /// An exact-input buy through the Universal Router stand-in after the window (fees for the next batch).
    function buy(uint64 x) external {
        if (block.timestamp < IBoxHook(b.hook).windowEndsAt() || IBoxHook(b.hook).closed()) return;
        uint256 q = 0.02 ether + uint256(x) % 0.5 ether;
        vm.deal(address(this), address(this).balance + q);
        uint256 before = _outside();
        try b.swapper.swapOne{value: q}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(q), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            "",
            address(multi)
        ) {
            ++buys;
        } catch {}
        _book(before);
    }

    /// A tip paid to a recipient that tries every way back into the receiver while it is paid.
    function collectWithThief() external {
        AuditU9ClaudeTipThief thief = new AuditU9ClaudeTipThief(b.pm, b.receiver);
        thief.arm();
        try IBoxReceiver(b.receiver).collect(address(thief)) {
            ++thiefRuns;
            for (uint256 i; i < 4; ++i) {
                if (thief.ok(i) || keccak256(thief.ret(i)) != keccak256(abi.encodeWithSelector(REENTRANCY))) {
                    ++reentryAccepted;
                }
            }
            if (thief.ok(4)) ++reentryAccepted;
            // The thief's net: the tip less the wei it settled into the PoolManager for its take.
            ethOut += address(thief).balance;
        } catch {}
    }

    /// The PoolManager callbacks and the receiver's receive, called from outside any guarded call.
    function gates(uint8 which, bool asPoolManager) external {
        address[4] memory callees = [b.coordinator, b.launchRouter, b.receiver, b.executor];
        address callee = callees[which % 4];
        address caller = asPoolManager ? address(b.pm) : address(0xBEEF);
        ++gateChecks;
        vm.prank(caller);
        (bool ok,) = callee.call(
            abi.encodeWithSignature("unlockCallback(bytes)", abi.encode(uint8(1), abi.encode(uint256(1), caller)))
        );
        if (ok) ++gateOpened;
        uint256 balance = caller.balance;
        vm.deal(caller, balance + 1);
        vm.prank(caller);
        (ok,) = b.receiver.call{value: 1}("");
        if (ok) ++gateOpened;
        else vm.deal(caller, balance);
    }

    /// Time passes (one to 40 blocks of 12 s).
    function advance(uint16 blocks) external {
        uint256 n = 1 + uint256(blocks) % 40;
        vm.roll(block.number + n);
        vm.warp(block.timestamp + 12 * n);
    }

    /// Into the launch window (step 0-29) when it has not opened yet.
    function toWindow(uint8 step) external {
        uint256 openAt = IBoxHook(b.hook).openAt();
        if (block.timestamp >= openAt) return;
        uint256 t = openAt + 12 * (uint256(step) % 30);
        vm.roll(block.number + (t - block.timestamp) / 12 + 1);
        vm.warp(t);
    }

    /// To the window's end (bonding) when it has not come yet.
    function toBonding() external {
        uint256 end = IBoxHook(b.hook).windowEndsAt();
        if (block.timestamp >= end) return;
        vm.roll(block.number + (end - block.timestamp) / 12 + 1);
        vm.warp(end);
    }

    receive() external payable {}
}

/// @title AuditU9ClaudeLockInvariants (SH-AUDIT-B0-U9, Claude; P9.3 as invariants; lens L3)
/// @notice On the factory's box 0 (the world, mainnet build), random sequences of guarded pairs in one transaction,
/// tips to a re-entering recipient and gate probes, with time passing: the lock is always released (no second call
/// fails), never re-entered from a tip (both receiver halves answer Reentrancy()), and no PoolManager callback or the
/// receiver's receive ever runs outside a guarded call. The world's ghost ledger holds too: the handler's ETH is
/// booked as it enters and leaves.
/// forge-config: default.evm_version = "osaka"
contract AuditU9ClaudeLockInvariants is AuditPhases {
    AuditU9ClaudeLockHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AuditU9ClaudeLockHandler(
            AuditU9ClaudeLockHandler.Box({
                pm: pm,
                receiver: a.receiver,
                executor: a.executor,
                coordinator: a.coordinator,
                launchRouter: a.launchRouter,
                hook: a.hook,
                swapper: routerSwapper
            }),
            poolKey
        );
        targetContract(address(handler));
    }

    function invariant_AUDIT_U9_lockAlwaysReleased() public view {
        assertEq(handler.secondFailed(), 0);
        assertEq(handler.routerSecondFailed(), 0);
    }

    function invariant_AUDIT_U9_tipNeverReenters() public view {
        assertEq(handler.reentryAccepted(), 0);
    }

    function invariant_AUDIT_U9_callbacksOnlyInsideGuardedCalls() public view {
        assertEq(handler.gateOpened(), 0);
    }

    /// Each run reached the actions it is about (the counts of the last run, for the evidence's call summary).
    function afterInvariant() external {
        emit log_named_uint("pairs", handler.pairs());
        emit log_named_uint("router pairs", handler.routerPairs());
        emit log_named_uint("buys", handler.buys());
        emit log_named_uint("tips to the re-entering recipient", handler.thiefRuns());
        emit log_named_uint("gate probes", handler.gateChecks());
    }

    /// The world's own ledger: system ETH equals what entered less what left, the handler's moves included.
    function invariant_AUDIT_U9_ethStaysAccounted() public view {
        (, uint256 held, uint256 inTotal, uint256 outTotal) = _ghostEthBalanced();
        assertEq(held + outTotal + handler.ethOut(), inTotal + handler.ethIn(), "system ETH");
    }
}
