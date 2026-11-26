// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7ClaudeBase} from "./AuditU7ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U7 (Claude), L5: withdrawBatch and returnItems cost grows linearly in k (BoxVault.sol:469-547:
/// one quote, one notice, then k marks or k checks and k transfers each with its capped observer call), measured on box
/// 0 with its real stream for k = 1 … 64; the slope, the fixed part and the largest batch inside EIP-7825's 16,777,216
/// are logged and bounded (k = 64 fits under both schedules). Box 0 in terminal mode with 64 revealed shelf items.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeBatchGasTest is AuditU7ClaudeBase {
    uint256 internal constant K = 64;
    uint256 internal constant TX_CAP = 16_777_216;
    /// @dev The marginal cost per item between consecutive points within 15% of the overall slope (the first item
    /// pays the cold reads its batch shares; 128 ids share one `_states` word).
    uint256 internal constant LINEAR_TOLERANCE = 0.15e18;
    uint256[] internal shelf;

    function setUp() public virtual override {
        super.setUp();
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        _buildTree();
        vm.pauseGasMetering();
        for (uint256 i; i < K; ++i) {
            shelf.push(_takeItem(eoa[2], 50_000 + i * 31, true));
        }
        for (uint256 i; i < K; i += 16) {
            uint256[] memory ids = new uint256[](16);
            for (uint256 j; j < 16; ++j) {
                ids[j] = shelf[i + j];
            }
            _returnItems(eoa[2], ids);
        }
        _approveT(eoa[1], a.vault);
        vm.prank(eoa[1]);
        collection.setApprovalForAll(a.vault, true);
        vm.resumeGasMetering();
    }

    /// @notice P7.10: pick and return gas for k = 1, 2, 4, 8, 16, 32, 64; the marginal cost per item between
    /// consecutive points within 15% of the overall slope (linear), the slope logged, and a 64-item batch inside
    /// EIP-7825's per-transaction cap.
    function testProperty_AUDIT_U7_batchGasIsLinearInK() public {
        uint256[7] memory ks = [uint256(1), 2, 4, 8, 16, 32, 64];
        uint256[7] memory pickGas;
        uint256[7] memory returnGas;
        for (uint256 i; i < ks.length; ++i) {
            (pickGas[i], returnGas[i]) = _measure(ks[i]);
        }
        uint256 pickSlope = (pickGas[6] - pickGas[0]) / 63;
        uint256 returnSlope = (returnGas[6] - returnGas[0]) / 63;
        for (uint256 i; i < ks.length; ++i) {
            emit log_named_uint(string.concat("U7 withdrawBatch gas, k = ", vm.toString(ks[i])), pickGas[i]);
            emit log_named_uint(string.concat("U7 returnItems gas, k = ", vm.toString(ks[i])), returnGas[i]);
        }
        // Linear: the marginal cost per item between consecutive points stays within 15% of the overall slope.
        for (uint256 i = 1; i < ks.length; ++i) {
            uint256 dk = ks[i] - ks[i - 1];
            assertApproxEqRel((pickGas[i] - pickGas[i - 1]) / dk, pickSlope, LINEAR_TOLERANCE, "pick: marginal cost");
            assertApproxEqRel(
                (returnGas[i] - returnGas[i - 1]) / dk, returnSlope, LINEAR_TOLERANCE, "return: marginal cost"
            );
        }
        emit log_named_uint("U7 withdrawBatch slope per item", pickSlope);
        emit log_named_uint("U7 returnItems slope per item", returnSlope);
        emit log_named_uint("U7 withdrawBatch largest k under the tx cap", (TX_CAP - pickGas[0]) / pickSlope + 1);
        emit log_named_uint("U7 returnItems largest k under the tx cap", (TX_CAP - returnGas[0]) / returnSlope + 1);
        assertLt(pickGas[6], TX_CAP, "a 64-item pick fits one transaction");
        assertLt(returnGas[6], TX_CAP, "a 64-item return fits one transaction");
    }

    /// @dev Gas of withdrawBatch(first k shelf items) by eoa[1], then of returnItems of the same k, in a snapshot.
    function _measure(uint256 k) internal returns (uint256 pickGas, uint256 returnGas) {
        uint256 snap = vm.snapshotState();
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = shelf[i];
        }
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[1]);
        uint256 g0 = gasleft();
        vault.withdrawBatch(ids, type(uint256).max, deadline);
        pickGas = g0 - gasleft();
        vm.prank(eoa[1]);
        g0 = gasleft();
        vault.returnItems(ids, 0, deadline);
        returnGas = g0 - gasleft();
        vm.revertToState(snap);
    }
}

/// @notice The same under Amsterdam (EIP-8037 state gas in gasleft; EIP-7825's cap binds the execution gas only).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU7ClaudeBatchGasAmsterdamTest is AuditU7ClaudeBatchGasTest {}

/// @title AuditU7ClaudeUriProbe
/// @notice TEST ONLY. Calls tokenURI in a fresh frame (so the caller's memory does not grow across a loop): its gas,
/// the answer's length and whether it starts with the data-URI prefix; and the least gas a capped call needs.
contract AuditU7ClaudeUriProbe {
    function measure(address c, uint256 id) external view returns (uint256 used, uint256 len, bool prefixed) {
        uint256 g = gasleft();
        bytes memory u = bytes(IBoxCollection(c).tokenURI(id));
        used = g - gasleft();
        len = u.length;
        bytes memory p = bytes("data:application/json;base64,");
        prefixed = len > p.length;
        for (uint256 i; prefixed && i < p.length; ++i) {
            prefixed = u[i] == p[i];
        }
    }

    /// @notice Whether tokenURI(id) succeeds in a call given exactly `gas_`.
    function fits(address c, uint256 id, uint256 gas_) external view returns (bool ok) {
        (ok,) = c.staticcall{gas: gas_}(abi.encodeCall(IBoxCollection.tokenURI, (id)));
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude), L5 and L8 at the edges the factory accepts: box 0 built at N = 10,000 (BoxSpecV1
/// MAX_N) with the largest metadata table BoxSpecV1.validate and BoxMetadataTable.validate accept (24,575 bytes:
/// 16 trait types with 255-byte names and 255 one-byte values each, the rest description; MAX_METADATA_TABLE_BYTES),
/// the longest collection name (32), description (1,024), hidden description (1,024) and hidden SVG (4,096). Measured:
/// tokenURI of an unrevealed id for each decimal length (its only dependence on the id) and of revealed ids of every
/// decimal length (taken by number), each under a stated bound, and every id rendering; the creation's ERC-2309 events
/// are two (1 … 5,000 and 5,001 … 10,000; BC-009) and every id is the vault's.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeMaxTableTest is AuditU7ClaudeBase {
    /// @dev The stated bounds (measured, then rounded up; see the evidence): an unrevealed id's tokenURI and a revealed
    /// one's with the largest table.
    uint256 internal constant HIDDEN_URI_GAS_BOUND = 10_000_000;
    uint256 internal constant REVEALED_URI_GAS_BOUND = 10_000_000;

    uint256 internal consecutiveEvents;
    uint256[2] internal ranges;

    function _auditN() internal view virtual override returns (uint256) {
        return 10_000;
    }

    function _auditSpec() internal view virtual override returns (BoxSpecV1.BoxSpec memory s) {
        s = super._auditSpec();
        s.metadataTable = _maxTable();
        s.description = string(_fill(1_024, "d"));
        s.collectionName = string(_fill(32, "N"));
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_PLACEHOLDERS) continue;
            (string memory p0, string memory p1, string memory p2,,) =
                abi.decode(s.addOns[i].params, (string, string, string, string, string));
            s.addOns[i].params = abi.encode(p0, p1, p2, string(_fill(1_024, "h")), _svg(4_096));
        }
    }

    function setUp() public virtual override {
        vm.recordLogs();
        super.setUp();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.collection && logs[i].topics[0] == IBoxCollection.ConsecutiveTransfer.selector) {
                if (consecutiveEvents < 2) ranges[consecutiveEvents] = uint256(logs[i].topics[1]);
                ++consecutiveEvents;
            }
        }
    }

    /// @notice L8 / BC-009 at N = 10,000: two ConsecutiveTransfer events (from ids 1 and 5,001), balanceOf(vault) ==
    /// N; the table is the 24,575-byte one, STOP-prefixed, its hash committed.
    function testProperty_AUDIT_U7_largestBoxCreatedWithTwoConsecutiveEvents() public view {
        assertEq(consecutiveEvents, 2, "two events of at most 5,000 ids");
        assertEq(ranges[0], 1, "first range from id 1");
        assertEq(ranges[1], 5_001, "second range from id 5,001");
        assertEq(collection.balanceOf(a.vault), 10_000, "all N the vault's");
        assertEq(collection.metadataTableBytes().length, BoxMetadataTable.MAX_TABLE_BYTES, "the largest table");
        assertEq(uint8(a.table.code[0]), 0, "STOP prefix");
        assertEq(collection.treeDepth(), 14, "depth ceil(log2 10,000)");
    }

    /// @notice P7.10: an unrevealed id's tokenURI depends on the id only through its decimal digits (tokenJSON: one
    /// `_metadata[id]` read, `toString(id)` in the title, the same hidden JSON; BoxCollection.sol:401-438), so each
    /// digit class's first and last id is measured (1, 9, 10, 99, 100, 999, 1,000, 9,999, 10,000) in a fresh frame;
    /// the least gas of the worst is found to the unit and is under the stated bound.
    function testProperty_AUDIT_U7_hiddenTokenUriBounded() public {
        AuditU7ClaudeUriProbe probe = new AuditU7ClaudeUriProbe();
        uint256[9] memory ids = [uint256(1), 9, 10, 99, 100, 999, 1_000, 9_999, 10_000];
        uint256 worst;
        uint256 worstId;
        for (uint256 i; i < ids.length; ++i) {
            (uint256 used, uint256 len, bool prefixed) = probe.measure(a.collection, ids[i]);
            assertTrue(prefixed, "a data URI");
            if (used > worst) (worst, worstId) = (used, ids[i]);
            emit log_named_uint(string.concat("U7 hidden tokenURI gas, id ", vm.toString(ids[i])), used);
            emit log_named_uint("U7   its length", len);
        }
        uint256 least = _leastGas(probe, worstId);
        emit log_named_uint("U7 hidden tokenURI least call gas (worst id)", least);
        assertLt(least, HIDDEN_URI_GAS_BOUND, "under the bound");
    }

    /// @notice Every one of the 10,000 ids renders (no revert) with the data-URI prefix, each in a fresh frame (gas
    /// metering paused: the bound is the digit-class measurement above).
    function testProperty_AUDIT_U7_everyIdRendersAtTheLargestBox() public {
        AuditU7ClaudeUriProbe probe = new AuditU7ClaudeUriProbe();
        vm.pauseGasMetering();
        for (uint256 id = 1; id <= editionSize; ++id) {
            (,, bool prefixed) = probe.measure(a.collection, id);
            assertTrue(prefixed, "renders a data URI");
        }
        vm.resumeGasMetering();
    }

    function _leastGas(AuditU7ClaudeUriProbe probe, uint256 id) internal view returns (uint256 hi) {
        uint256 lo = 10_000;
        hi = 30_000_000;
        require(probe.fits(a.collection, id, hi), "U7: renders with 30M");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (probe.fits(a.collection, id, mid)) hi = mid;
            else lo = mid;
        }
    }

    /// @notice P7.10: revealed ids of 1 to 5 digits (taken by number in terminal mode with their reveal) render under
    /// the bound; the table's walk visits every value of every type whatever the traits, so the cost differs by id only
    /// through its digits and the chosen values' lengths (one byte here).
    function testProperty_AUDIT_U7_revealedTokenUriBounded() public {
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        _buildTree();
        AuditU7ClaudeUriProbe probe = new AuditU7ClaudeUriProbe();
        uint256[5] memory want = [uint256(7), 42, 640, 6_400, 9_999];
        uint256 worst;
        uint256 worstId;
        for (uint256 i; i < want.length; ++i) {
            uint256 id = _takeExact(eoa[2], want[i]);
            (uint256 used, uint256 len, bool prefixed) = probe.measure(a.collection, id);
            assertTrue(collection.isRevealed(id) && prefixed, "revealed, a data URI");
            assertGt(len, 20_000, "the long JSON");
            if (used > worst) (worst, worstId) = (used, id);
            emit log_named_uint(string.concat("U7 revealed tokenURI gas, id ", vm.toString(id)), used);
            emit log_named_uint("U7   its length", len);
        }
        uint256 least = _leastGas(probe, worstId);
        emit log_named_uint("U7 revealed tokenURI least call gas (worst id)", least);
        assertLt(least, REVEALED_URI_GAS_BOUND, "every revealed tokenURI under the bound");
    }

    /// @dev Takes item `want` by number (or the nearest hidden pool item after it), with its reveal.
    function _takeExact(address who, uint256 want) internal returns (uint256 item) {
        (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
        uint256 slots = tickets.status().slots;
        uint256 left = _poolLeft();
        for (uint256 tryId = want; tryId <= editionSize; ++tryId) {
            uint256 position = BoxShuffle.invert(tickets.graduationWord(), tryId - 1, editionSize, u, v);
            if (position < slots || !vault.isHidden(tryId)) continue;
            uint256 index = position - slots;
            if (index >= left || tickets.poolPositionAt(index) != position) continue;
            _approveT(who, a.tickets);
            ItemReveal memory r = tree.itemReveal(tryId);
            uint256 t0 = token.balanceOf(who);
            vm.prank(who);
            tickets.takeByNumber(tryId, index, type(uint256).max, vm.getBlockTimestamp(), r);
            _noteTChange(t0, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
            return tryId;
        }
        revert("U7: no takeable id");
    }

    // ------------------------------------------------------------------------------------------------ the data

    /// @dev 16 types, each a 255-byte name and 255 one-byte values; the rest of 24,575 bytes is description.
    function _maxTable() internal pure returns (bytes memory t) {
        uint256 perType = 1 + 255 + 1 + 255 * 2;
        uint256 d = BoxMetadataTable.MAX_TABLE_BYTES - 3 - 1 - 16 * perType;
        t = new bytes(BoxMetadataTable.MAX_TABLE_BYTES);
        t[0] = 0x01;
        t[1] = bytes1(uint8(d >> 8));
        t[2] = bytes1(uint8(d));
        uint256 c = 3;
        for (uint256 i; i < d; ++i) {
            t[c++] = bytes1(uint8(0x61 + (i % 26)));
        }
        t[c++] = bytes1(uint8(16));
        for (uint256 ty; ty < 16; ++ty) {
            t[c++] = bytes1(uint8(255));
            for (uint256 i; i < 255; ++i) {
                t[c++] = bytes1(uint8(0x41 + ((i + ty) % 26)));
            }
            t[c++] = bytes1(uint8(255));
            for (uint256 v; v < 255; ++v) {
                t[c++] = bytes1(uint8(1));
                t[c++] = bytes1(uint8(0x30 + (v % 10)));
            }
        }
        require(c == t.length, "U7: table size");
    }

    function _fill(uint256 len, bytes1 ch) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = ch;
        }
    }

    /// @dev An SVG of exactly `len` bytes (printable ASCII, quotes allowed by the SVG rule).
    function _svg(uint256 len) internal pure returns (string memory) {
        bytes memory head = bytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><desc>');
        bytes memory tail = bytes("</desc></svg>");
        bytes memory b = new bytes(len);
        uint256 c;
        for (uint256 i; i < head.length; ++i) {
            b[c++] = head[i];
        }
        while (c < len - tail.length) {
            b[c++] = "x";
        }
        for (uint256 i; i < tail.length; ++i) {
            b[c++] = tail[i];
        }
        return string(b);
    }
}
