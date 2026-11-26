// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxDrandQuicknet} from "../../../../src/box/randomness/BoxDrandQuicknet.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";

/// @notice TEST ONLY. `BoxDrandQuicknet.verify` with calldata, as `DrandSource.postRound` passes it.
contract AuditU8ClaudeQuicknetHarness {
    function verify(uint64 round, bytes calldata signature) external view returns (bool, bytes32) {
        return BoxDrandQuicknet.verify(round, signature);
    }
}

/// @title AuditU8ClaudeQuicknetTest (SH-AUDIT-B0 U8, lens L4 P8.5 and L5 P8.9: the quicknet checker)
/// @notice The on-chain check of a drand quicknet round (`BoxDrandQuicknet.sol:71-89`) takes the signature uncompressed
/// (x ‖ y, 96 bytes) and rebuilds drand's 48 compressed bytes for the randomness (sign bit: y > (p − 1) / 2, `:62-64`,
/// `:83-87`). Properties (sources: `BoxDrandQuicknet.sol:17-18` "a round has exactly one valid σ, so nobody (the poster
/// included) can choose it"; `DrandSource.sol:24-27`; F54; F61 R4; the unit brief's P8.5 and P8.9):
/// - every committed real round verifies to the published randomness, and the rebuilt compressed bytes equal a reference
///   compression computed here independently (y against p − y in 384-bit arithmetic, the field modulus checked against
///   the curve equation with MODEXP), with both sign branches present among the committed rounds;
/// - every other encoding of a round's point and every other point is refused: (x, p − y), x + p, y + p (both fit in
///   48 bytes), all zeros (infinity), the compressed form padded to 96 bytes, the infinity flag, swapped halves, lengths
///   0 to 192, two points on the curve outside G1 (a cofactor point and σ plus an order-3 point), G1's generator, the
///   neighbouring rounds' valid signatures, and single- and double-bit changes;
/// - no gas limit turns a refused input into `true`; `postRound` with too little gas reverts without a trace and never
///   stores a wrong result.
/// The off-subgroup probe points were computed offline (pure-Python curve arithmetic over BLS12-381's p) and are checked
/// here on chain: on the curve with MODEXP, in or outside G1 with BLS12_G1MSM's subgroup check, the order-3 point and
/// the sum σ(r0) + (0, p − 2) with BLS12_G1ADD (`testProperty_AUDIT_U8_quicknetProbePointsCheckedOnChain`).
/// The EIP-2537 precompiles exist from Prague on: Osaka here, Amsterdam in the variant below.
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeQuicknetTest is BoxDrandVectors {
    /// @dev BLS12-381's base field modulus p as its top 16 and low 32 bytes (48 bytes big-endian).
    uint256 internal constant P_HI = 0x1a0111ea397fe69a4b1ba7b6434bacd7;
    uint256 internal constant P_LO = 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    /// @dev On the curve y² = x³ + 4, outside G1 (x = 4: the smallest x ≥ 1 whose x³ + 4 is a square mod p).
    bytes internal constant OFF_SUBGROUP_POINT = hex"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004"
        hex"0a989badd40d6212b33cffc3f3763e9bc760f988c9926b26da9dd85e928483446346b8ed00e1de5d5ea93e354abe706c";
    /// @dev (0, p − 2): a point of order 3 (y² = 4).
    bytes internal constant ORDER3_POINT = hex"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaa9";
    /// @dev σ(r0) + (0, p − 2): on the curve, outside G1 (round r0 = 32,654,000's signature moved by the order-3 point).
    bytes internal constant SIG_R0_PLUS_ORDER3 = hex"19627a3899fc4a7bee19f7834c72b1fd892d8a8808f070c736995605eae30e2bb74ebb5a50904be6f6a336378c1220ab"
        hex"10fb0ebfb078472b35d49577224340024549e24a178221f857c42a3db52e3e5e0c9cfd3dfa414b42f4486339155a431d";
    /// @dev G1's generator: in G1, never a quicknet signature.
    bytes internal constant G1_GENERATOR = hex"17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"
        hex"08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";

    /// @dev Gas for one probe: an EIP-2537 precompile burns all the gas it is given on a malformed input, so each probe
    /// is capped; `testProperty_AUDIT_U8_quicknetProbeCapFitsAValidCheck` shows a valid check fits in a quarter of it,
    /// so no probe passes for lack of gas.
    uint256 internal constant PROBE_GAS = 2_000_000;

    AuditU8ClaudeQuicknetHarness internal q;
    DrandSource internal drand;
    uint256 internal r0;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        q = new AuditU8ClaudeQuicknetHarness();
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // 384-bit helpers (48-byte big-endian values as a 16-byte high part and a 32-byte low part)

    function _split(bytes memory b, uint256 off) internal pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let ptr := add(add(b, 32), off)
            hi := shr(128, mload(ptr))
            lo := mload(add(ptr, 16))
        }
    }

    function _join(uint256 hi, uint256 lo) internal pure returns (bytes memory) {
        return bytes.concat(bytes16(uint128(hi)), bytes32(lo));
    }

    /// @dev (hi, lo) + p, which must still fit in 48 bytes.
    function _plusP(uint256 hi, uint256 lo) internal pure returns (uint256, uint256) {
        uint256 l;
        unchecked {
            l = lo + P_LO;
        }
        uint256 carry = l < lo ? 1 : 0;
        uint256 h = hi + P_HI + carry;
        require(h < (1 << 128), "fits in 48 bytes");
        return (h, l);
    }

    /// @dev p − (hi, lo), for 0 < value < p.
    function _pMinus(uint256 hi, uint256 lo) internal pure returns (uint256, uint256) {
        uint256 l;
        unchecked {
            l = P_LO - lo;
        }
        uint256 borrow = lo > P_LO ? 1 : 0;
        return (P_HI - hi - borrow, l);
    }

    function _gt(uint256 aHi, uint256 aLo, uint256 bHi, uint256 bLo) internal pure returns (bool) {
        return aHi > bHi || (aHi == bHi && aLo > bLo);
    }

    /// @dev base^e mod p with the MODEXP precompile (48-byte operands), 48 bytes out.
    function _modexp(bytes memory base, uint256 e) internal view returns (bytes memory out) {
        bytes memory modulus = _join(P_HI, P_LO);
        (bool ok, bytes memory ret) =
            address(0x05).staticcall(abi.encodePacked(uint256(48), uint256(32), uint256(48), base, e, modulus));
        require(ok && ret.length == 48, "modexp");
        out = ret;
    }

    /// @dev Whether the 96-byte (x ‖ y) is on y² = x³ + 4 over Fp (x, y < p assumed).
    function _onCurve(bytes memory xy) internal view returns (bool) {
        bytes memory x = new bytes(48);
        bytes memory y = new bytes(48);
        for (uint256 i; i < 48; ++i) {
            x[i] = xy[i];
            y[i] = xy[48 + i];
        }
        (uint256 y2Hi, uint256 y2Lo) = _split(_modexp(y, 2), 0);
        (uint256 x3Hi, uint256 x3Lo) = _split(_modexp(x, 3), 0);
        // x³ + 4 mod p: add 4 and subtract p once if needed.
        uint256 l;
        unchecked {
            l = x3Lo + 4;
        }
        uint256 h = x3Hi + (l < x3Lo ? 1 : 0);
        if (_gt(h, l, P_HI, P_LO) || (h == P_HI && l == P_LO)) {
            uint256 borrow = l < P_LO ? 1 : 0;
            unchecked {
                l = l - P_LO;
            }
            h = h - P_HI - borrow;
        }
        return h == y2Hi && l == y2Lo;
    }

    /// @dev The reference compression of (x ‖ y) (ZCash's format): x with the top byte's 0x80 (compressed) and 0x20
    /// (y is the larger of y and p − y) bits, computed from p, not from the checker's constants.
    function _referenceCompress(bytes memory xy) internal pure returns (bytes memory c, bool larger) {
        (uint256 yHi, uint256 yLo) = _split(xy, 48);
        (uint256 nHi, uint256 nLo) = _pMinus(yHi, yLo);
        larger = _gt(yHi, yLo, nHi, nLo);
        c = new bytes(48);
        for (uint256 i; i < 48; ++i) {
            c[i] = xy[i];
        }
        c[0] = c[0] | (larger ? bytes1(0xa0) : bytes1(0x80));
    }

    function _sigOf(uint256 round) internal view returns (bytes memory) {
        return _boxDrand(round).xy;
    }

    function _refuse(uint256 round, bytes memory sig, string memory what) internal view {
        (bool ok, bytes32 randomness) = q.verify{gas: PROBE_GAS}(uint64(round), sig);
        assertFalse(ok, what);
        assertEq(randomness, bytes32(0), string.concat(what, ": no randomness"));
    }

    // ------------------------------------------------------------------------------------------------------------
    // P8.5: every committed round, with a reference compression

    /// @notice Every committed round (19: genesis, the fork blocks' rounds and 16 local rounds) verifies, its randomness
    /// is the published one and sha256 of drand's compressed signature, and the checker's rebuilt bytes equal the
    /// reference compression of (x, y): the sign rule matches for both branches (6 rounds with y > p − y, 13 below).
    function testProperty_AUDIT_U8_quicknetCommittedRoundsMatchReferenceCompression() public view {
        uint256 count = _boxDrandCount();
        assertEq(count, 19, "the committed rounds");
        uint256 larger;
        for (uint256 i; i < count; ++i) {
            Round memory r = _boxDrandAt(i);
            assertTrue(_onCurve(r.xy), "the committed point is on the curve (p checked)");
            (bytes memory c, bool isLarger) = _referenceCompress(r.xy);
            assertEq(c, r.compressed, "reference compression == drand's compressed signature");
            if (isLarger) ++larger;
            (bool ok, bytes32 randomness) = q.verify(uint64(r.round), r.xy);
            assertTrue(ok, string.concat("round ", vm.toString(r.round)));
            assertEq(randomness, sha256(c), "randomness == sha256(reference compression)");
            assertEq(randomness, r.randomness, "the published randomness");
        }
        assertEq(larger, 6, "rounds with the sign bit set");
        assertEq(count - larger, 13, "rounds with it clear");
    }

    /// @notice The probe cap is not what refuses: every committed round verifies with a quarter of `PROBE_GAS`, cold.
    function testProperty_AUDIT_U8_quicknetProbeCapFitsAValidCheck() public {
        uint256 count = _boxDrandCount();
        for (uint256 i; i < count; ++i) {
            Round memory r = _boxDrandAt(i);
            vm.cool(address(q));
            uint256 g0 = gasleft();
            (bool ok, bytes32 randomness) = q.verify{gas: PROBE_GAS / 4}(uint64(r.round), r.xy);
            uint256 used = g0 - gasleft();
            assertTrue(ok, "a valid check fits in PROBE_GAS / 4");
            assertEq(randomness, r.randomness);
            if (i == 0) emit log_named_uint("gas of one valid check (caller's frame, cold)", used);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // P8.5: other encodings of the same point, and other points

    /// @notice For every committed round: (x, p − y), x + p, y + p, both + p, swapped halves, the compressed form padded
    /// to 96 bytes (front and back), the infinity flag, and all zeros are refused; only (x, y) verifies.
    function testProperty_AUDIT_U8_quicknetOtherEncodingsRefused() public view {
        uint256 count = _boxDrandCount();
        for (uint256 i; i < count; ++i) {
            Round memory r = _boxDrandAt(i);
            (bytes[] memory encodings, string[] memory names) = _otherEncodings(r);
            for (uint256 k; k < encodings.length; ++k) {
                _refuse(r.round, encodings[k], names[k]);
            }
            (bool ok,) = q.verify(uint64(r.round), r.xy);
            assertTrue(ok, "the canonical (x, y) verifies");
        }
    }

    /// @dev The other encodings of a round's point (and the infinity forms) the checker must refuse.
    function _otherEncodings(Round memory r) internal pure returns (bytes[] memory e, string[] memory n) {
        e = new bytes[](9);
        n = new string[](9);
        bytes memory xB = new bytes(48);
        bytes memory yB = new bytes(48);
        for (uint256 j; j < 48; ++j) {
            xB[j] = r.xy[j];
            yB[j] = r.xy[48 + j];
        }
        bytes memory xP;
        bytes memory yP;
        bytes memory yN;
        {
            (uint256 xHi, uint256 xLo) = _split(r.xy, 0);
            (uint256 hi, uint256 lo) = _plusP(xHi, xLo);
            xP = _join(hi, lo);
        }
        {
            (uint256 yHi, uint256 yLo) = _split(r.xy, 48);
            (uint256 hi, uint256 lo) = _plusP(yHi, yLo);
            yP = _join(hi, lo);
            (hi, lo) = _pMinus(yHi, yLo);
            yN = _join(hi, lo);
        }
        (e[0], n[0]) = (bytes.concat(xB, yN), "(x, p - y)");
        (e[1], n[1]) = (bytes.concat(xP, yB), "(x + p, y)");
        (e[2], n[2]) = (bytes.concat(xB, yP), "(x, y + p)");
        (e[3], n[3]) = (bytes.concat(xP, yP), "(x + p, y + p)");
        (e[4], n[4]) = (bytes.concat(yB, xB), "(y, x)");
        (e[5], n[5]) = (bytes.concat(r.compressed, new bytes(48)), "compressed, then zeros");
        (e[6], n[6]) = (bytes.concat(new bytes(48), r.compressed), "zeros, then compressed");
        bytes memory inf = new bytes(96);
        inf[0] = 0xc0;
        (e[7], n[7]) = (inf, "the compressed infinity flag");
        (e[8], n[8]) = (new bytes(96), "all zeros (infinity)");
    }

    /// @notice Points other than the round's own: two on the curve outside G1 (refused by the pairing precompile's
    /// subgroup check: had they passed, σ + T would be a second signature with another x, so another randomness), an
    /// order-3 point, G1's generator, and points off the curve.
    function testProperty_AUDIT_U8_quicknetOffSubgroupAndForeignPointsRefused() public view {
        assertTrue(_onCurve(OFF_SUBGROUP_POINT), "(4, y) is on the curve");
        assertTrue(_onCurve(ORDER3_POINT), "(0, p - 2) is on the curve");
        assertTrue(_onCurve(SIG_R0_PLUS_ORDER3), "sigma + T3 is on the curve");
        assertTrue(_onCurve(G1_GENERATOR), "the generator is on the curve");
        for (uint256 i; i < 16; ++i) {
            uint256 round = r0 + i;
            _refuse(round, OFF_SUBGROUP_POINT, "(4, y): on the curve, outside G1");
            _refuse(round, ORDER3_POINT, "(0, p - 2): order 3");
            _refuse(round, SIG_R0_PLUS_ORDER3, "sigma(r0) + T3: outside G1");
            _refuse(round, G1_GENERATOR, "G1's generator");
        }
        bytes memory off = bytes.concat(OFF_SUBGROUP_POINT);
        off[95] = off[95] ^ 0x01;
        assertFalse(_onCurve(off), "a changed y leaves the curve");
        _refuse(r0, off, "off the curve");
    }

    /// @dev The 128-byte EIP-2537 encoding of a 96-byte (x ‖ y).
    function _eip2537(bytes memory xy) internal pure returns (bytes memory) {
        bytes memory x = new bytes(48);
        bytes memory y = new bytes(48);
        for (uint256 i; i < 48; ++i) {
            x[i] = xy[i];
            y[i] = xy[48 + i];
        }
        return bytes.concat(bytes16(0), x, bytes16(0), y);
    }

    /// @dev Whether (x ‖ y) is in G1, decided by the chain: BLS12_G1MSM (0x0c) checks that every input point is on the
    /// curve and in G1 (EIP-2537; G1ADD, 0x0b, checks only the curve), so a one-term MSM by the scalar 1 answers 128
    /// bytes exactly for points of G1. Capped: a refused input burns the gas it is given.
    function _inG1(bytes memory xy) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            address(0x0c).staticcall{gas: 200_000}(bytes.concat(_eip2537(xy), bytes32(uint256(1))));
        return ok && ret.length == 128;
    }

    /// @dev BLS12_G1ADD (0x0b) of two EIP-2537 points (no subgroup check), 128 bytes.
    function _g1add(bytes memory p, bytes memory q2) internal view returns (bytes memory sum) {
        bool ok;
        (ok, sum) = address(0x0b).staticcall(bytes.concat(p, q2));
        require(ok && sum.length == 128, "G1ADD");
    }

    /// @notice The probe points are what their names say, checked by the chain's own precompiles rather than taken on
    /// trust from the offline computation: σ(r0), −σ(r0) = (x, p − y) and G1's generator are in G1 (so −σ is refused by
    /// the pairing equation, not by a subgroup check); (4, y), (0, p − 2) and σ(r0) + (0, p − 2) are on the curve and
    /// outside G1; (0, p − 2) has order 3 (doubled it is (0, 2), tripled the point at infinity); and the constant
    /// SIG_R0_PLUS_ORDER3 is exactly G1ADD(σ(r0), (0, p − 2)). The canonical σ(r0) verifies; the others are refused.
    function testProperty_AUDIT_U8_quicknetProbePointsCheckedOnChain() public view {
        Round memory r = _boxDrand(r0);
        (bytes[] memory e,) = _otherEncodings(r);
        assertTrue(_inG1(r.xy), "sigma(r0) is in G1");
        assertTrue(_inG1(e[0]), "-sigma(r0) = (x, p - y) is in G1");
        assertTrue(_inG1(G1_GENERATOR), "the generator is in G1");
        assertFalse(_inG1(OFF_SUBGROUP_POINT), "(4, y) is outside G1");
        assertFalse(_inG1(ORDER3_POINT), "(0, p - 2) is outside G1");
        assertFalse(_inG1(SIG_R0_PLUS_ORDER3), "sigma(r0) + T3 is outside G1");
        assertFalse(_inG1(e[2]), "(x, y + p): a non-canonical coordinate is refused");
        bytes memory t3 = _eip2537(ORDER3_POINT);
        bytes memory twoT3 = _g1add(t3, t3);
        bytes memory zeroTwo = new bytes(128);
        zeroTwo[127] = 0x02;
        assertEq(twoT3, zeroTwo, "2 * (0, p - 2) = (0, 2)");
        assertEq(_g1add(twoT3, t3), new bytes(128), "3 * (0, p - 2) = the point at infinity");
        assertEq(_g1add(_eip2537(r.xy), t3), _eip2537(SIG_R0_PLUS_ORDER3), "the constant is sigma(r0) + T3");
        (bool ok, bytes32 randomness) = q.verify(uint64(r0), r.xy);
        assertTrue(ok);
        assertEq(randomness, r.randomness);
        _refuse(r0, e[0], "-sigma(r0)");
        _refuse(r0, SIG_R0_PLUS_ORDER3, "sigma(r0) + T3");
    }

    /// @notice Lengths other than 96 are refused before any precompile runs, including the right point's bytes cut or
    /// extended: 0, 1, 47, 48 (the compressed signature itself), 64, 95, 97 (a byte appended), 128, 192.
    function testProperty_AUDIT_U8_quicknetLengthsRefused() public view {
        bytes memory sig = _sigOf(r0);
        Round memory r = _boxDrand(r0);
        uint256[9] memory lengths = [uint256(0), 1, 47, 48, 64, 95, 97, 128, 192];
        for (uint256 i; i < lengths.length; ++i) {
            bytes memory b = new bytes(lengths[i]);
            for (uint256 j; j < lengths[i] && j < 96; ++j) {
                b[j] = sig[j];
            }
            _refuse(r0, b, string.concat("length ", vm.toString(lengths[i])));
        }
        _refuse(r0, r.compressed, "the 48-byte compressed signature");
        _refuse(r0, bytes.concat(sig, sig), "the signature twice");
    }

    /// @notice A committed round's valid signature is refused for its neighbours (± 1, ± 4, ± 16), for round 0, for the
    /// round's number with its 33rd bit set, and for 2^64 − 1.
    function testProperty_AUDIT_U8_quicknetNeighbourRoundsRefused() public view {
        for (uint256 i; i < 16; ++i) {
            uint256 round = r0 + i;
            bytes memory sig = _sigOf(round);
            _refuse(round + 1, sig, "round + 1");
            _refuse(round - 1, sig, "round - 1");
            _refuse(round + 4, sig, "round + 4");
            _refuse(round - 4, sig, "round - 4");
            _refuse(round + 16, sig, "round + 16");
            _refuse(round ^ (1 << 32), sig, "the 33rd bit flipped");
            _refuse(0, sig, "round 0");
            _refuse(type(uint64).max, sig, "round 2^64 - 1");
        }
    }

    /// @notice Any single-bit change of any committed round's 96 bytes is refused.
    function testFuzz_AUDIT_U8_quicknetSingleBitChangeRefused(uint256 which, uint256 bit) public view {
        Round memory r = _boxDrandAt(bound(which, 0, _boxDrandCount() - 1));
        bit = bound(bit, 0, 96 * 8 - 1);
        bytes memory xy = bytes.concat(r.xy);
        xy[bit / 8] = xy[bit / 8] ^ bytes1(uint8(1 << (bit % 8)));
        _refuse(r.round, xy, "one bit changed");
    }

    /// @notice Any two-bit change (one in x, one in y) of any committed round is refused.
    function testFuzz_AUDIT_U8_quicknetTwoBitChangeRefused(uint256 which, uint256 bitX, uint256 bitY) public view {
        Round memory r = _boxDrandAt(bound(which, 0, _boxDrandCount() - 1));
        bitX = bound(bitX, 0, 48 * 8 - 1);
        bitY = bound(bitY, 48 * 8, 96 * 8 - 1);
        bytes memory xy = bytes.concat(r.xy);
        xy[bitX / 8] = xy[bitX / 8] ^ bytes1(uint8(1 << (bitX % 8)));
        xy[bitY / 8] = xy[bitY / 8] ^ bytes1(uint8(1 << (bitY % 8)));
        _refuse(r.round, xy, "two bits changed");
    }

    /// @notice A committed signature is valid for its own round only, whatever other round number is asked.
    function testFuzz_AUDIT_U8_quicknetValidForItsRoundOnly(uint256 which, uint64 round) public view {
        Round memory r = _boxDrandAt(bound(which, 0, _boxDrandCount() - 1));
        vm.assume(round != r.round);
        _refuse(round, r.xy, "another round");
    }

    // ------------------------------------------------------------------------------------------------------------
    // P8.9: gas

    /// @dev The probes a gas limit must never turn into a valid signature.
    function _probe(uint256 kind) internal view returns (uint256 round, bytes memory sig) {
        Round memory r = _boxDrand(r0 + 1);
        round = r.round;
        kind = kind % 7;
        if (kind < 2) {
            (bytes[] memory e,) = _otherEncodings(r);
            sig = kind == 0 ? e[0] : e[2]; // (x, p - y) and (x, y + p)
        } else if (kind == 2) {
            sig = new bytes(96);
        } else if (kind == 3) {
            sig = OFF_SUBGROUP_POINT;
        } else if (kind == 4) {
            sig = SIG_R0_PLUS_ORDER3;
            round = r0;
        } else if (kind == 5) {
            sig = _sigOf(r0); // r0's valid signature, asked for r0 + 1
        } else {
            sig = bytes.concat(r.xy);
            sig[50] = sig[50] ^ 0x10;
        }
    }

    /// @notice No gas limit makes `verify` answer true for a refused input: every call either reverts (out of gas) or
    /// answers false with no randomness.
    function testFuzz_AUDIT_U8_quicknetNoGasLimitTurnsARefusalTrue(uint256 kind, uint256 gas) public view {
        (uint256 round, bytes memory sig) = _probe(kind);
        gas = bound(gas, 0, 3_000_000);
        (bool called, bytes memory ret) =
            address(q).staticcall{gas: gas}(abi.encodeCall(AuditU8ClaudeQuicknetHarness.verify, (uint64(round), sig)));
        if (!called) return;
        (bool ok, bytes32 randomness) = abi.decode(ret, (bool, bytes32));
        assertFalse(ok, "never true");
        assertEq(randomness, bytes32(0));
    }

    /// @notice `postRound` with a valid signature at every gas limit from 30,000 to 700,000 (steps of 2,500): a call
    /// that fails leaves the round unposted, its pot in place and nobody credited; the first call that succeeds stores
    /// the published randomness. Measured: the least gas limit that posts (logged).
    function testProperty_AUDIT_U8_postRoundLowGasIsARefusal() public {
        Round memory r = _boxDrand(r0 + 2);
        vm.warp(r.time - 12);
        address consumer = makeAddr("audit.u8.consumer");
        vm.deal(consumer, 1 ether);
        vm.prank(consumer);
        drand.request{value: 0.25 ether}(7);
        assertEq(drand.bountyOf(r.round), 0.25 ether);
        vm.warp(r.time);
        address poster = makeAddr("audit.u8.poster");
        uint256 postedWith;
        for (uint256 g = 30_000; g <= 700_000; g += 2_500) {
            vm.cool(address(drand));
            vm.prank(poster);
            (bool ok,) = address(drand).call{gas: g}(abi.encodeCall(IDrandSource.postRound, (r.round, r.xy)));
            (bytes32 randomness, uint64 postedAt) = drand.beaconOf(r.round);
            if (!ok) {
                assertEq(randomness, bytes32(0), "a failed post stores nothing");
                assertEq(postedAt, 0);
                assertEq(drand.bountyOf(r.round), 0.25 ether, "the pot stays");
                assertEq(drand.owedTo(poster), 0, "nobody credited");
                continue;
            }
            assertEq(randomness, r.randomness, "the first post that lands stores the published randomness");
            assertEq(postedAt, vm.getBlockTimestamp());
            assertEq(drand.owedTo(poster), 0.25 ether);
            postedWith = g;
            break;
        }
        assertGt(postedWith, 0, "some gas limit posts");
        emit log_named_uint("least gas limit (steps of 2,500) that posts a bountied round, cold", postedWith);
        (bytes32 w,) = drand.wordOf(consumer, 7);
        assertEq(w, keccak256(abi.encode(drand.WORD_TAG(), r.randomness, keccak256(abi.encode(consumer, uint256(7))))));
    }

    /// @notice The refused encodings, posted: each reverts `InvalidSignature` and the round stays postable with its pot;
    /// then the canonical signature posts it.
    function testProperty_AUDIT_U8_postRoundRefusesEveryOtherEncoding() public {
        Round memory r = _boxDrand(r0 + 3);
        vm.deal(address(this), 1 ether);
        drand.addBounty{value: 0.1 ether}(r.round);
        vm.warp(r.time);
        for (uint256 k; k < 7; ++k) {
            // The probes are built on r0 + 1's point (and r0's); posted as r0 + 3 they are refused as well. Each call is
            // capped: a malformed point makes the pairing precompile burn the gas it is given (EIP-2537).
            (, bytes memory sig) = _probe(k);
            (bool ok, bytes memory ret) =
                address(drand).call{gas: PROBE_GAS}(abi.encodeCall(IDrandSource.postRound, (r.round, sig)));
            assertFalse(ok, "refused");
            assertEq(ret, abi.encodeWithSelector(IDrandSource.InvalidSignature.selector, r.round), "InvalidSignature");
        }
        (, uint64 postedAt) = drand.beaconOf(r.round);
        assertEq(postedAt, 0);
        assertEq(drand.bountyOf(r.round), 0.1 ether);
        assertEq(drand.postRound(r.round, r.xy), r.randomness);
    }
}

/// @notice The same under Amsterdam (Glamsterdam's repricing; EIP-2537 retained).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeQuicknetAmsterdamTest is AuditU8ClaudeQuicknetTest {}

/// @title AuditU8ClaudeQuicknetCancunTest (U8 L6: a chain without EIP-2537)
/// @notice `BoxDrandQuicknet.sol:29-30`: "On a chain without EIP-2537 every call returns nothing and `verify` reports
/// false". Runs on the profile's own EVM (Cancun, the build target; no inline override), which has no BLS12-381
/// precompiles.
contract AuditU8ClaudeQuicknetCancunTest is BoxDrandVectors {
    /// @notice BLS12_G1ADD answers no bytes; every committed round's valid signature verifies false with no
    /// randomness, and `postRound` reverts `InvalidSignature` with the round left unposted and its pot in place: no
    /// word can come from drand on such a chain (a word for box 0 there would come only from the backup).
    function testProperty_AUDIT_U8_quicknetWithoutEip2537IsFalse() public {
        _loadBoxDrand();
        assertEq(vm.getEvmVersion(), "cancun");
        (bool ok, bytes memory ret) = address(0x0b).staticcall(new bytes(256));
        assertTrue(ok && ret.length == 0, "no BLS12_G1ADD under Cancun");
        AuditU8ClaudeQuicknetHarness q = new AuditU8ClaudeQuicknetHarness();
        uint256 count = _boxDrandCount();
        for (uint256 i; i < count; ++i) {
            Round memory c = _boxDrandAt(i);
            (bool valid, bytes32 randomness) = q.verify(uint64(c.round), c.xy);
            assertFalse(valid, "false without EIP-2537");
            assertEq(randomness, bytes32(0));
        }
        vm.chainId(1);
        DrandSource drand = PinnedDrandSource.deploy(vm);
        Round memory r = _boxDrand(_localFirst() + 4);
        drand.addBounty{value: 1 wei}(r.round);
        vm.warp(r.time);
        (ok, ret) = address(drand).call(abi.encodeCall(IDrandSource.postRound, (r.round, r.xy)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IDrandSource.InvalidSignature.selector, r.round));
        (, uint64 postedAt) = drand.beaconOf(r.round);
        assertEq(postedAt, 0, "nothing stored");
        assertEq(drand.bountyOf(r.round), 1 wei, "the pot stays");
    }
}
