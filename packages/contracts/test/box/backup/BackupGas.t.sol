// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {CoreBox0BackupBase} from "./CoreBox0BackupBase.sol";
import {HeaderVectors} from "./HeaderVectors.sol";

/// @title BackupGasTest (F143; the R4 read margin and the backup's calls)
/// @notice `wordOf` as BoxTickets reads it (a STATICCALL with exactly 50,000 gas, `DrandWords`), cold, in each of its
/// states (nothing posted, drand posted, backup started, backup fixed, never requested), on both EVMs: the worst must
/// stay at or below `WORD_READ_PIN`, so at least `MIN_MARGIN_X100` / 100 times headroom under the consumers' 50,000
/// (the design study's review: about 2.4x, against rc7's 4.6x). Also the gas of the backup's two calls and of the
/// user calls that pass through the wrapper (logged; the review's figures are in docs/evidence/SH-BOX0-BACKUP-SOURCE.md).
/// forge-config: default.evm_version = "osaka"
contract BackupGasTest is CoreBox0BackupBase {
    /// @notice The consumers' read gas (BoxTickets `_WORD_GAS`, DrandWords).
    uint256 internal constant WORD_READ_GAS = 50_000;
    /// @notice The pinned worst cold `wordOf` (the caller's frame of the STATICCALL), both EVMs.
    uint256 internal constant WORD_READ_PIN = 21_000;
    /// @notice 50,000 / 21,000 = 2.38x at least.
    uint256 internal constant MIN_MARGIN_X100 = 238;

    uint256 internal _worst;

    function _cool() internal {
        vm.cool(address(src));
        vm.cool(address(drand));
        vm.cool(a.tickets);
        vm.cool(a.vault);
        vm.cool(a.token);
        vm.cool(a.coordinator);
    }

    function _read(string memory what, uint256 key) internal {
        vm.cool(address(src));
        vm.cool(address(drand));
        uint256 g0 = gasleft();
        (bool ok, bytes memory ret) =
            address(src).staticcall{gas: WORD_READ_GAS}(abi.encodeCall(BoxBackedSource.wordOf, (a.tickets, key)));
        uint256 used = g0 - gasleft();
        assertTrue(ok && ret.length == 64, "answers within 50,000");
        if (used > _worst) _worst = used;
        emit log_named_uint(what, used);
    }

    function test_gas_wordOfWithinTheReadOnBothEvms() public {
        _read("wordOf, never requested", 99);
        uint256 requestedAt = _graduate();
        _read("wordOf, requested, nothing posted", 0);
        vm.warp(_startable(r0));
        uint256 target = _start(r0, address(this));
        _read("wordOf, backup started", 0);
        _advance(src.TARGET_BLOCKS() + 1);
        vm.setBlockhash(target, keccak256(HeaderVectors.MAINNET));
        src.fixBackup(r0, HeaderVectors.MAINNET);
        _read("wordOf, backup fixed", 0);
        tickets.acceptGraduationWord();
        _drawOn(3, "gas.drawer");
        vm.warp(src.roundTime(r0 + 3));
        drand.postRound(r0 + 3, _localSig(3));
        _read("wordOf, drand posted (draw key)", 1);
        emit log_named_uint("worst wordOf", _worst);
        emit log_named_uint("margin x100 under 50,000", WORD_READ_GAS * 100 / _worst);
        assertLe(_worst, WORD_READ_PIN, "the pinned worst cold wordOf");
        assertGe(WORD_READ_GAS * 100 / _worst, MIN_MARGIN_X100, "the pinned margin");
        assertGt(requestedAt, 0);
    }

    /// startBackup (with a 646-byte parent header) and fixBackup (a 646-byte mainnet header), cold, the caller's frame.
    function test_gas_backupCalls() public {
        _graduate();
        vm.warp(_startable(r0));
        bytes memory p = _parent();
        _cool();
        uint256 g0 = gasleft();
        uint256 target = src.startBackup(r0, block.number - 1, p);
        emit log_named_uint("startBackup, 646-byte parent header (cold, caller's frame)", g0 - gasleft());
        _advance(src.TARGET_BLOCKS() + 1);
        vm.setBlockhash(target, keccak256(HeaderVectors.MAINNET));
        _cool();
        g0 = gasleft();
        src.fixBackup(r0, HeaderVectors.MAINNET);
        emit log_named_uint("fixBackup, 646-byte mainnet header (cold, caller's frame)", g0 - gasleft());
        _cool();
        g0 = gasleft();
        tickets.acceptGraduationWord();
        emit log_named_uint("acceptGraduationWord on the backup word (cold)", g0 - gasleft());
    }

    /// The user calls through the wrapper, cold (the design study's DrawGasCompare, rc7: graduate 847,812, accept
    /// 70,077, draw 302,562, settle(1) 86,673 under the default EVM).
    function test_gas_userCalls() public {
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        _cool();
        uint256 g0 = gasleft();
        BoxCoordinator(a.coordinator).graduate();
        emit log_named_uint("graduate (with the word request poke)", g0 - gasleft());
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        _cool();
        g0 = gasleft();
        tickets.acceptGraduationWord();
        emit log_named_uint("acceptGraduationWord (drand word)", g0 - gasleft());
        address drawer = makeAddr("d");
        b.buy(drawer, b.eth(0.5 ether), 0);
        vm.deal(drawer, 1 ether);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        vm.prank(drawer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        _cool();
        vm.prank(drawer);
        g0 = gasleft();
        tickets.draw{value: 0.01 ether}(type(uint256).max, block.timestamp);
        emit log_named_uint("draw (request + bounty top-up + refund)", g0 - gasleft());
        vm.warp(src.roundTime(r0 + 3));
        drand.postRound(r0 + 3, _localSig(3));
        _cool();
        g0 = gasleft();
        tickets.settle(1);
        emit log_named_uint("settle(1) (drand word)", g0 - gasleft());
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract BackupGasAmsterdamTest is BackupGasTest {}
