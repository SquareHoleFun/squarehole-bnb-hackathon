// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @title AuditU1ClaudeBuildsTest
/// @notice SH-AUDIT-B0 U1, lenses L5 (P1.9, sizes) and L8 (P1.18; F78, `docs/decisions/DECISION-LOG.md:93`;
/// `src/box/build/rehearsal/BoxBuildV1.sol:12`, `:49-58`), from the compiled artifacts of both builds. The mainnet
/// (default) build is `out/<Name>.sol/<Name>.json`; the rehearsal build is read from `out/u1-rehearsal/<Name>.json`, a
/// copy of `out-rehearsal/<Name>.sol/<Name>.json` (this profile may read only `./out`), made by:
///   FOUNDRY_PROFILE=rehearsal forge build --offline src/box
///   mkdir -p out/u1-rehearsal && cp out-rehearsal/<Name>.sol/<Name>.json out/u1-rehearsal/<Name>.json (18 names)
/// Without that copy the rehearsal half skips with a message (the mainnet half always runs).
/// forge-config: default.evm_version = "cancun"
contract AuditU1ClaudeBuildsTest is Test {
    string internal constant REHEARSAL_DIR = "/out/u1-rehearsal/";
    bytes4 internal constant REFUSES = bytes4(keccak256("RehearsalBuildRefusesChain(uint256)"));

    function _names() internal pure returns (string[18] memory n) {
        n = [
            "BoxFactoryV1",
            "BoxFactoryV1Planner",
            "BoxRegistry",
            "BoxCoordinator",
            "BoxHook",
            "BoxHookExtension",
            "BoxLaunchRouter",
            "BoxReceiver",
            "BoxReceiverExtension",
            "BoxCollection",
            "BoxVault",
            "BoxTickets",
            "BoxItemStream",
            "BoxRoyaltyRouter",
            "BoxToken",
            "FitBuybackExecutor",
            "DrandSource",
            "BoxBackedSource"
        ];
    }

    function _mainnet(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/out/", name, ".sol/", name, ".json"));
    }

    function _rehearsalPresent() internal view returns (bool) {
        return vm.exists(string.concat(vm.projectRoot(), REHEARSAL_DIR, "BoxFactoryV1.json"));
    }

    function _rehearsal(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), REHEARSAL_DIR, name, ".json"));
    }

    function _skipWithoutRehearsal() internal {
        if (_rehearsalPresent()) return;
        emit log("rehearsal artifacts absent: run FOUNDRY_PROFILE=rehearsal forge build --offline src/box, then copy");
        emit log("out-rehearsal/<Name>.sol/<Name>.json to out/u1-rehearsal/<Name>.json (see the contract notes)");
        vm.skip(true);
    }

    // ================================================================================================ P1.9

    /// P1.9 (BC-069; EIP-170, EIP-3860; `test/box/conformance/core` BC-069 measured these on 2026-10-04): every runtime
    /// of the mainnet build is within 24,576 bytes and every creation code within 49,152; the tickets keep at least
    /// 1,000 bytes of margin. The figures are logged (`U1-SIZE|mainnet|<name>|<runtime>|<creation>`) and the tickets'
    /// margin pinned: 24,576 − 23,546 = 1,030 bytes.
    function testProperty_AUDIT_U1_sizesWithinTheLimits_mainnet() public {
        string[18] memory n = _names();
        for (uint256 i; i < n.length; ++i) {
            string memory json = _mainnet(n[i]);
            _assertSizes("mainnet", n[i], json);
        }
        uint256 tickets = vm.parseJsonBytes(_mainnet("BoxTickets"), ".deployedBytecode.object").length;
        assertEq(24_576 - tickets, 1_030, "the tickets' margin, mainnet build");
    }

    /// P1.9 on the rehearsal build: the same limits and margin (its runtimes differ only in the constants of
    /// P1.18, so the tickets' runtime, which holds none, is byte for byte the mainnet one).
    function testProperty_AUDIT_U1_sizesWithinTheLimits_rehearsal() public {
        _skipWithoutRehearsal();
        string[18] memory n = _names();
        for (uint256 i; i < n.length; ++i) {
            _assertSizes("rehearsal", n[i], _rehearsal(n[i]));
        }
        uint256 tickets = vm.parseJsonBytes(_rehearsal("BoxTickets"), ".deployedBytecode.object").length;
        assertGe(24_576 - tickets, 1_000, "the tickets keep 1,000 bytes, rehearsal build");
    }

    function _assertSizes(string memory build, string memory name, string memory json) internal {
        uint256 runtime = vm.parseJsonBytes(json, ".deployedBytecode.object").length;
        uint256 creation = vm.parseJsonBytes(json, ".bytecode.object").length;
        emit log(string.concat("U1-SIZE|", build, "|", name, "|", vm.toString(runtime), "|", vm.toString(creation)));
        assertLe(runtime, 24_576, string.concat(name, ": EIP-170"));
        assertLe(creation, 49_152, string.concat(name, ": EIP-3860"));
    }

    // ================================================================================================ P1.18

    /// P1.18 (F78; rehearsal BoxBuildV1.sol:12 "every other value as mainnet's"; `foundry.toml` "nothing else differs
    /// between the two builds"): the mainnet and rehearsal builds' runtime code, instruction by instruction, differ
    /// only in (a) PUSH values that are one of BoxBuildV1's numbers in the mainnet build and exactly a tenth of it in
    /// the rehearsal build (the seven: raise, bootstrap, batch minimum, tip cap, swap step, depth minimum, platform
    /// cap; and the creator-fee cap's five presets, which the planner's validate() carries), (b) jump targets naming the
    /// same JUMPDEST in each, and (c) offsets of the same trailing data (a constant table, T's creation code in the
    /// factory) when the code before it shrank. Eleven of the eighteen runtimes are byte-identical, among them both
    /// sources (their CREATE2 pins hold in either build), T and FIT's executor, whose creation codes are identical too. Counts are logged
    /// (`U1-BUILD|<name>|<instructions>|<constants>|<jumps>|<data>`).
    function testProperty_AUDIT_U1_rehearsalDiffersOnlyInItsNumbers() public {
        _skipWithoutRehearsal();
        string[18] memory n = _names();
        uint256 identical;
        vm.pauseGasMetering();
        for (uint256 i; i < n.length; ++i) {
            bytes memory a = vm.parseJsonBytes(_mainnet(n[i]), ".deployedBytecode.object");
            bytes memory b = vm.parseJsonBytes(_rehearsal(n[i]), ".deployedBytecode.object");
            if (keccak256(a) == keccak256(b)) {
                ++identical;
                continue;
            }
            _compare(n[i], a, b);
        }
        vm.resumeGasMetering();
        assertEq(identical, 11, "eleven runtimes are byte for byte the same in both builds");
        string[5] memory same = ["BoxRegistry", "BoxToken", "FitBuybackExecutor", "DrandSource", "BoxBackedSource"];
        for (uint256 i; i < same.length; ++i) {
            assertEq(
                keccak256(vm.parseJsonBytes(_mainnet(same[i]), ".bytecode.object")),
                keccak256(vm.parseJsonBytes(_rehearsal(same[i]), ".bytecode.object")),
                string.concat(same[i], ": the same creation code in both builds")
            );
        }
    }

    /// P1.18, the guard: every rehearsal creation code of the factory, the planner and the eleven implementations
    /// reverts `RehearsalBuildRefusesChain(1)` on chain id 1 (in its BoxBuildGuard constructor, before any argument
    /// is read), and deploys on Sepolia's chain id; the mainnet build's creation codes have no such guard (they deploy
    /// on chain id 1, as every test world here does).
    function testProperty_AUDIT_U1_rehearsalRefusesChainOne() public {
        _skipWithoutRehearsal();
        address pm = makeAddr("u1.builds.pm");
        vm.etch(pm, hex"00");
        address coord = makeAddr("u1.builds.coordinatorImpl");
        string[13] memory guarded = [
            "BoxFactoryV1",
            "BoxFactoryV1Planner",
            "BoxCoordinator",
            "BoxHook",
            "BoxHookExtension",
            "BoxLaunchRouter",
            "BoxReceiver",
            "BoxReceiverExtension",
            "BoxCollection",
            "BoxVault",
            "BoxTickets",
            "BoxItemStream",
            "BoxRoyaltyRouter"
        ];
        vm.chainId(1);
        for (uint256 i; i < guarded.length; ++i) {
            bytes memory init = bytes.concat(
                vm.parseJsonBytes(_rehearsal(guarded[i]), ".bytecode.object"), _args(i, pm, coord, address(0))
            );
            (address at, bytes memory err) = _tryCreate(init);
            assertEq(at, address(0), string.concat(guarded[i], ": refused on chain id 1"));
            assertEq(
                err,
                abi.encodeWithSelector(REFUSES, uint256(1)),
                string.concat(guarded[i], ": RehearsalBuildRefusesChain(1)")
            );
        }
        vm.chainId(11_155_111);
        address ext = _deployRehearsal("BoxReceiverExtension", abi.encode(coord));
        for (uint256 i = 1; i < guarded.length; ++i) {
            bytes memory init =
                bytes.concat(vm.parseJsonBytes(_rehearsal(guarded[i]), ".bytecode.object"), _args(i, pm, coord, ext));
            (address at,) = _tryCreate(init);
            assertTrue(at != address(0), string.concat(guarded[i], ": deploys on Sepolia's chain id"));
        }
        vm.chainId(1);
        assertEq(BoxBuildV1.REFUSED_CHAIN_ID, 0, "this (mainnet) build refuses no chain");
    }

    function _deployRehearsal(string memory name, bytes memory args) internal returns (address at) {
        (at,) = _tryCreate(bytes.concat(vm.parseJsonBytes(_rehearsal(name), ".bytecode.object"), args));
        require(at != address(0), "deploy");
    }

    /// @dev Constructor arguments per guarded contract (index into the list above); the factory's are dummies (it is
    /// only shown refused).
    function _args(uint256 i, address pm, address coord, address ext) internal pure returns (bytes memory) {
        // The factory: sixteen static words (eight parameters, one of them the nine-address Implementations).
        if (i == 0) return new bytes(16 * 32);
        if (i == 1 || i == 12) return "";
        if (i == 2) return abi.encode(pm, coord);
        if (i == 3) return abi.encode(pm, coord, ext == address(0) ? coord : ext);
        if (i == 4) return abi.encode(pm);
        if (i == 5) return abi.encode(pm, coord);
        if (i == 6) return abi.encode(pm, coord, ext);
        if (i == 7 || i == 8 || i == 9 || i == 10) return abi.encode(coord);
        if (i == 11) return abi.encode(pm, coord);
        return "";
    }

    function _tryCreate(bytes memory init) internal returns (address at, bytes memory err) {
        assembly ("memory-safe") {
            at := create(0, add(init, 0x20), mload(init))
            if iszero(at) {
                let n := returndatasize()
                err := mload(0x40)
                mstore(err, n)
                returndatacopy(add(err, 0x20), 0, n)
                mstore(0x40, add(add(err, 0x20), and(add(n, 31), not(31))))
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ the diff

    struct Ins {
        uint256 pos;
        uint8 op;
        uint256 imm;
    }

    function _dis(bytes memory code) internal pure returns (Ins[] memory out, uint256[] memory jumpdests) {
        out = new Ins[](code.length);
        jumpdests = new uint256[](code.length);
        uint256 n;
        uint256 j;
        for (uint256 i; i < code.length;) {
            uint8 op = uint8(code[i]);
            uint256 imm;
            uint256 len;
            if (op >= 0x60 && op <= 0x7f) {
                len = op - 0x5f;
                for (uint256 k; k < len && i + 1 + k < code.length; ++k) {
                    imm = (imm << 8) | uint8(code[i + 1 + k]);
                }
            }
            if (op == 0x5b) jumpdests[j++] = i;
            out[n++] = Ins(i, op, imm);
            i += 1 + len;
        }
        assembly ("memory-safe") {
            mstore(out, n)
            mstore(jumpdests, j)
        }
    }

    /// @dev The index of `pos` among `jumpdests` (type(uint256).max if it is none).
    function _jumpIndex(uint256[] memory jumpdests, uint256 pos) internal pure returns (uint256) {
        uint256 lo;
        uint256 hi = jumpdests.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (jumpdests[mid] < pos) lo = mid + 1;
            else hi = mid;
        }
        return lo < jumpdests.length && jumpdests[lo] == pos ? lo : type(uint256).max;
    }

    function _buildNumber(uint256 x, uint256 y) internal pure returns (bool) {
        uint256[12] memory m = [
            uint256(4_206_980_085_000_000_000),
            1_500_000_000_000_000,
            5_000_000_000_000_000,
            500_000_000_000_000,
            5_000_000_000_000_000,
            5_000_000_000_000_000,
            32_000_000_000_000_000_000,
            1_000_000_000_000_000_000,
            4_000_000_000_000_000_000,
            8_000_000_000_000_000_000,
            16_000_000_000_000_000_000,
            32_000_000_000_000_000_000
        ];
        for (uint256 i; i < m.length; ++i) {
            if (x == m[i] && y == m[i] / 10) return true;
        }
        return false;
    }

    function _sameTail(bytes memory a, uint256 x, bytes memory b, uint256 y) internal pure returns (bool) {
        if (x >= a.length || y >= b.length || a.length - x != b.length - y) return false;
        return keccak256(_tail(a, x)) == keccak256(_tail(b, y));
    }

    function _tail(bytes memory c, uint256 from) internal pure returns (bytes memory t) {
        t = new bytes(c.length - from);
        for (uint256 i; i < t.length; ++i) {
            t[i] = c[from + i];
        }
    }

    struct Code {
        bytes code;
        Ins[] ins;
        uint256[] jumpdests;
    }

    struct Counts {
        uint256 constants;
        uint256 jumps;
        uint256 data;
    }

    function _compare(string memory name, bytes memory a, bytes memory b) internal {
        Code memory x;
        Code memory y;
        x.code = a;
        y.code = b;
        (x.ins, x.jumpdests) = _dis(a);
        (y.ins, y.jumpdests) = _dis(b);
        assertEq(x.ins.length, y.ins.length, string.concat(name, ": the same instruction count"));
        assertEq(x.jumpdests.length, y.jumpdests.length, string.concat(name, ": the same JUMPDESTs"));
        Counts memory c;
        for (uint256 i; i < x.ins.length; ++i) {
            uint8 k = _classify(x, y, i);
            if (k == 1) ++c.constants;
            else if (k == 2) ++c.jumps;
            else if (k == 3) ++c.data;
            else if (k == 4) revert(string.concat(name, ": a difference that is no build number at #", vm.toString(i)));
        }
        assertGt(c.constants, 0, string.concat(name, ": differs by at least one build number"));
        emit log(string.concat(
                "U1-BUILD|",
                name,
                "|",
                vm.toString(x.ins.length),
                "|",
                vm.toString(c.constants),
                "|",
                vm.toString(c.jumps),
                "|",
                vm.toString(c.data)
            ));
    }

    /// @dev 0 the same instruction, 1 a build number, 2 a jump target to the same JUMPDEST, 3 an offset of the same
    /// trailing data, 4 anything else.
    function _classify(Code memory x, Code memory y, uint256 i) internal pure returns (uint8) {
        Ins memory p = x.ins[i];
        Ins memory q = y.ins[i];
        bool push = p.op >= 0x5f && p.op <= 0x7f && q.op >= 0x5f && q.op <= 0x7f;
        if (!push) return p.op == q.op ? 0 : 4;
        if (p.imm == q.imm) return 0;
        if (_buildNumber(p.imm, q.imm)) return 1;
        uint256 jx = _jumpIndex(x.jumpdests, p.imm);
        if (jx != type(uint256).max && jx == _jumpIndex(y.jumpdests, q.imm)) return 2;
        if (_sameTail(x.code, p.imm, y.code, q.imm)) return 3;
        return 4;
    }
}
