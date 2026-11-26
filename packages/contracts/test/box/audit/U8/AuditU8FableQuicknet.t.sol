// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {AuditU8FableBase} from "./AuditU8FableBase.sol";

/// @title AuditU8FableQuicknetTest (SH-AUDIT-B0-U8-F, lenses L4 and L5 on the BLS checker)
/// @notice `BoxDrandQuicknet.verify` (BoxDrandQuicknet.sol:71-89) as `DrandSource.postRound` calls it (DrandSource.sol:
/// 115-130), on the pinned DrandSource of the shared world: a round has exactly one valid input, the 96 uncompressed
/// bytes of drand's signature, and its randomness is sha256 of the compressed bytes rebuilt on chain (the sign bit
/// against (p - 1) / 2, :85-86). Every other input the brief names is refused with (false, 0) and, through
/// `postRound`, `InvalidSignature` with no state change: the negated point (p - y), x or y plus p (non-canonical field
/// elements the pairing precompile must reject), the point at infinity, wrong lengths, a curve point outside the
/// subgroup, a neighbouring round's signature, single-bit changes, and every gas limit. Sources: BoxDrandQuicknet.sol:
/// 17-18 ("A round has exactly one valid σ"), DrandSource.sol:24-27, F54, F61 R4, BC-053.
/// forge-config: default.evm_version = "osaka"
contract AuditU8FableQuicknetTest is AuditU8FableBase {
    /// @dev The first local round's index in the vector file (rounds 0-2 are round 1 and the two fork rounds).
    uint256 internal constant LOCAL = 3;

    function _rounds() internal view returns (uint256 n) {
        n = _boxDrandCount();
        assertEq(n, 19, "the box vectors: round 1, two fork rounds, 16 local rounds");
    }

    /// @dev The clock at or after every committed round's time, so a post is refused only for its signature.
    function _afterEveryRound() internal {
        uint256 latest;
        for (uint256 i; i < _boxDrandCount(); ++i) {
            uint256 t = _boxDrandAt(i).time;
            if (t > latest) latest = t;
        }
        _warpTo(latest + 1);
    }

    /// @dev `postRound` must refuse `sig` for `round` with InvalidSignature and leave the round unknown.
    function _postRefused(uint256 round, bytes memory sig, string memory why) internal {
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidSignature.selector, round));
        drand.postRound{gas: PROBE_GAS}(round, sig);
        (bytes32 randomness, uint64 postedAt) = drand.beaconOf(round);
        assertEq(randomness, bytes32(0), why);
        assertEq(postedAt, 0, why);
    }

    // ------------------------------------------------------------------------------------------------ L4 P8.5

    /// P8.5: for every committed round the uncompressed signature verifies, and the randomness equals drand's
    /// published value, sha256 of the published compressed signature, and sha256 of a reference compression computed
    /// here from (x, y) and p (BoxDrandQuicknet.sol:82-87; DrandSource.sol:56-57 "sha256 of the compressed signature,
    /// as the League publishes it").
    function testProperty_AUDIT_U8_verifyTrueForTheCommittedSignatureWithThePublishedRandomness() public view {
        uint256 n = _rounds();
        for (uint256 i; i < n; ++i) {
            Round memory r = _boxDrandAt(i);
            (bool ok, bytes32 randomness) = probe.verify(uint64(r.round), r.xy);
            assertTrue(ok, string.concat("round ", vm.toString(r.round)));
            assertEq(randomness, r.randomness, "drand's published randomness");
            assertEq(randomness, sha256(r.compressed), "sha256 of the published compressed signature");
            assertEq(randomness, sha256(_refCompressed(r.xy)), "sha256 of the reference compression");
            assertEq(drand.roundTime(r.round), r.time, "the round's time is quicknet's");
        }
    }

    /// P8.5 (sign bit): the compressed bytes the checker rebuilds equal the reference compression for every committed
    /// round, which cover both branches of the rule (BoxDrandQuicknet.sol:62-64, :85-86): the vectors hold rounds
    /// whose y is above (p - 1) / 2 (flag 0xa0) and rounds whose y is below (0x80), and the published compressed
    /// signature's flag byte says the same.
    function testProperty_AUDIT_U8_signBitMatchesAReferenceCompressionOnBothBranches() public view {
        uint256 n = _rounds();
        uint256 larger;
        for (uint256 i; i < n; ++i) {
            Round memory r = _boxDrandAt(i);
            bool big = _refLargerY(r.xy);
            if (big) ++larger;
            assertEq(uint8(r.compressed[0]) & 0xe0, big ? 0xa0 : 0x80, "published flags: compressed, sign bit");
            assertEq(_refCompressed(r.xy), r.compressed, "the reference compression is the published one");
            // The sign bit is not readable from x: a wrong bit would change the randomness.
            bytes memory flipped = bytes.concat(r.compressed[0] ^ bytes1(0x20), _slice(r.compressed, 1, 47));
            assertTrue(sha256(flipped) != r.randomness, "the sign bit decides the randomness");
        }
        assertEq(larger, 6, "6 of the 19 committed rounds carry the larger y");
    }

    /// P8.5 (probe): y replaced by p - y is the negated point, on the curve and in G1, with the same x: the pairing
    /// check must fail (e(-σ, g2) != e(H(m), pk)), and the randomness rebuilt from x alone must never be returned.
    function testProperty_AUDIT_U8_verifyRefusesTheNegatedPoint() public {
        uint256 n = _rounds();
        _afterEveryRound();
        for (uint256 i; i < n; ++i) {
            Round memory r = _boxDrandAt(i);
            bytes memory neg = _negated(r.xy);
            assertTrue(_onCurvePerG1Add(neg), "p - y is on the curve");
            (bool called, bool ok, bytes32 randomness) = _probe(r.round, neg);
            assertTrue(called, "a well-formed point: the check runs and answers");
            assertFalse(ok, string.concat("negated point of round ", vm.toString(r.round)));
            assertEq(randomness, bytes32(0));
            _postRefused(r.round, neg, "negated point");
        }
    }

    /// P8.5 (probe): x + p and y + p are the same residues but not canonical field elements; EIP-2537 requires every
    /// coordinate below p (BoxDrandQuicknet.sol:24-25), so the check must fail on all three combinations. Both sums
    /// fit in 48 bytes for every committed round (p < 2^381.4).
    function testProperty_AUDIT_U8_verifyRefusesNonCanonicalFieldElements() public {
        uint256 n = _rounds();
        _afterEveryRound();
        for (uint256 i; i < n; ++i) {
            Round memory r = _boxDrandAt(i);
            bytes[3] memory probes = [_plusP(r.xy, true, false), _plusP(r.xy, false, true), _plusP(r.xy, true, true)];
            for (uint256 k; k < 3; ++k) {
                assertEq(probes[k].length, 96);
                assertFalse(_onCurvePerG1Add(probes[k]), "G1ADD refuses a coordinate at or above p too");
                (bool called, bool ok, bytes32 randomness) = _probe(r.round, probes[k]);
                assertTrue(called, "the precompile burns its gas, the checker still answers");
                assertFalse(ok, string.concat("x/y + p of round ", vm.toString(r.round)));
                assertEq(randomness, bytes32(0));
            }
            _postRefused(r.round, probes[2], "x + p and y + p");
        }
    }

    /// P8.5 (probe): all zeros is EIP-2537's point at infinity (e(O, g2) = 1 != e(H(m), pk)); lengths 0, 48 (the
    /// compressed form), 95, 97 and 128 (the EIP-2537 padded form) are refused before any precompile runs
    /// (BoxDrandQuicknet.sol:74).
    function testProperty_AUDIT_U8_verifyRefusesInfinityAndWrongLengths() public {
        uint256 n = _rounds();
        _afterEveryRound();
        for (uint256 i; i < n; ++i) {
            Round memory r = _boxDrandAt(i);
            (bool called, bool ok, bytes32 randomness) = _probe(r.round, new bytes(96));
            assertTrue(called);
            assertFalse(ok, "infinity");
            assertEq(randomness, bytes32(0));
            bytes[5] memory wrong =
                [new bytes(0), r.compressed, _slice(r.xy, 0, 95), bytes.concat(r.xy, hex"00"), _padded(r.xy)];
            for (uint256 k; k < 5; ++k) {
                uint256 g0 = gasleft();
                (called, ok, randomness) = _probe(r.round, wrong[k]);
                uint256 used = g0 - gasleft();
                assertTrue(called);
                assertFalse(ok, string.concat("length ", vm.toString(wrong[k].length)));
                assertEq(randomness, bytes32(0));
                assertLt(
                    used, 60_000, "refused by the length check before any precompile call (about 23,000 with the CALL)"
                );
            }
            if (i == LOCAL) {
                _postRefused(r.round, new bytes(96), "infinity");
                _postRefused(r.round, r.compressed, "48 compressed bytes");
                _postRefused(r.round, _padded(r.xy), "128 padded bytes");
            }
        }
    }

    /// P8.5 (probe): (0, 2) and (0, p - 2) are on the curve y^2 = x^3 + 4 (2^2 = 4) with order 3, and r is not a
    /// multiple of 3, so they lie outside G1; G1ADD takes them (it makes no subgroup check), the pairing check must
    /// not (BoxDrandQuicknet.sol:24-25).
    function testProperty_AUDIT_U8_verifyRefusesACurvePointOutsideTheSubgroup() public {
        uint256 n = _rounds();
        _afterEveryRound();
        (uint256 nhi, uint256 nlo) = _sub384(P_HI, P_LO, 0, 2);
        bytes[2] memory outside = [_point(0, 0, 0, 2), _point(0, 0, nhi, nlo)];
        for (uint256 k; k < 2; ++k) {
            assertTrue(_onCurvePerG1Add(outside[k]), "on the curve (G1ADD takes it)");
            for (uint256 i; i < n; ++i) {
                Round memory r = _boxDrandAt(i);
                (bool called, bool ok, bytes32 randomness) = _probe(r.round, outside[k]);
                assertTrue(called);
                assertFalse(ok, "a point outside G1");
                assertEq(randomness, bytes32(0));
            }
            _postRefused(_boxDrandAt(LOCAL).round, outside[k], "a point outside G1");
        }
    }

    /// P8.5 (probe): the valid signature of a neighbouring round (the previous, the next, round 1's, a fork round's)
    /// is refused for every committed round.
    function testProperty_AUDIT_U8_verifyRefusesANeighbouringRoundsSignature() public {
        uint256 n = _rounds();
        _afterEveryRound();
        for (uint256 i; i < n; ++i) {
            Round memory r = _boxDrandAt(i);
            uint256[3] memory others = [i == 0 ? n - 1 : i - 1, i == n - 1 ? 0 : i + 1, (i + 7) % n];
            for (uint256 k; k < 3; ++k) {
                Round memory o = _boxDrandAt(others[k]);
                if (o.round == r.round) continue;
                (bool called, bool ok, bytes32 randomness) = _probe(r.round, o.xy);
                assertTrue(called);
                assertFalse(ok, "another round's signature");
                assertEq(randomness, bytes32(0));
            }
            if (i >= LOCAL && i + 1 < n) _postRefused(r.round, _boxDrandAt(i + 1).xy, "the next round's signature");
        }
    }

    /// P8.5 (probe): any single bit of a valid signature changed (768 positions, every committed round) is refused.
    function testFuzz_AUDIT_U8_verifyRefusesSingleBitChanges(uint256 bit, uint256 which) public {
        Round memory r = _boxDrandAt(bound(which, 0, _boxDrandCount() - 1));
        bit = bound(bit, 0, 96 * 8 - 1);
        bytes memory xy = bytes.concat(r.xy);
        xy[bit / 8] = xy[bit / 8] ^ bytes1(uint8(1 << (bit % 8)));
        (bool called, bool ok, bytes32 randomness) = _probe(r.round, xy);
        assertTrue(called);
        assertFalse(ok, "a bit changed");
        assertEq(randomness, bytes32(0));
        _afterEveryRound();
        _postRefused(r.round, xy, "a bit changed");
    }

    /// P8.5: the sign-bit rule is read from y's top 16 bytes then its low 32 bytes (BoxDrandQuicknet.sol:83-85): a y
    /// that differs from (p - 1) / 2 only in its low 32 bytes gets the right flag either way. The checker's branch is
    /// not reachable with a valid signature at that exact y, so the rule is pinned through the reference and the
    /// compare the checker uses on the published rounds (a wrong compare would have shown in the randomness).
    function testProperty_AUDIT_U8_halfConstantsAreHalfOfPMinusOne() public pure {
        // 2 * half + 1 == p
        (uint256 hi, uint256 lo) = _add384(HALF_HI, HALF_LO, HALF_HI, HALF_LO);
        (hi, lo) = _add384(hi, lo, 0, 1);
        assertEq(hi, P_HI);
        assertEq(lo, P_LO);
        assertTrue(_gt384(HALF_HI, HALF_LO + 1, HALF_HI, HALF_LO), "the low word decides at an equal top");
        assertFalse(_gt384(HALF_HI, HALF_LO, HALF_HI, HALF_LO), "equal is not larger (flag 0x80)");
    }

    // ------------------------------------------------------------------------------------------------ L5 P8.9

    /// P8.9: no gas limit makes `verify` answer true for a non-canonical input: at every cap from 0 up the call either
    /// fails (a starved precompile is a failed STATICCALL, BoxDrandQuicknet.sol:28-29) or answers (false, 0).
    function testFuzz_AUDIT_U8_noGasLimitMakesVerifyTrueForANonCanonicalInput(uint256 gas, uint256 which, uint8 kind)
        public
    {
        Round memory r = _boxDrandAt(bound(which, 0, _boxDrandCount() - 1));
        gas = bound(gas, 0, 400_000);
        bytes memory input;
        uint256 k = kind % 4;
        if (k == 0) input = _negated(r.xy);
        else if (k == 1) input = _plusP(r.xy, true, false);
        else if (k == 2) input = _plusP(r.xy, false, true);
        else input = _boxDrandAt((bound(which, 0, _boxDrandCount() - 1) + 1) % _boxDrandCount()).xy;
        (bool called, bool valid, bytes32 randomness) = _verifyWithGas(uint64(r.round), input, gas);
        assertFalse(valid, "never true");
        assertEq(randomness, bytes32(0));
        if (gas >= 400_000) assertTrue(called, "with enough gas the probe answers (false, 0)");
    }

    /// P8.9: under a gas cap the valid signature yields either nothing (the call fails), (false, 0), or exactly the
    /// published randomness: no cap turns a right answer into a different one.
    function testFuzz_AUDIT_U8_gasCappedVerifyOfTheValidSignatureIsRightOrNothing(uint256 gas, uint256 which) public {
        Round memory r = _boxDrandAt(bound(which, 0, _boxDrandCount() - 1));
        gas = bound(gas, 0, 400_000);
        (bool called, bool valid, bytes32 randomness) = _verifyWithGas(uint64(r.round), r.xy, gas);
        if (valid) assertEq(randomness, r.randomness, "true only with the published randomness");
        else assertEq(randomness, bytes32(0));
        if (gas >= 400_000) assertTrue(called && valid, "with enough gas the signature verifies");
    }

    /// P8.9: `postRound` under every gas cap from 21,000 up (steps of 500) either fails with nothing changed (no
    /// randomness, the pot intact, nothing owed) or succeeds with the published randomness and the pot credited;
    /// the least passing cap is logged for the evidence.
    function testProperty_AUDIT_U8_postRoundStarvedChangesNothing() public {
        Round memory r = _boxDrandAt(LOCAL + 5);
        _addBounty(eoa[1], r.round, 0.01 ether, true);
        _warpTo(r.time);
        bytes memory data = abi.encodeCall(drand.postRound, (r.round, r.xy));
        uint256 passAt;
        for (uint256 g = 21_000; g <= 400_000; g += 500) {
            vm.cool(address(drand));
            vm.prank(poster);
            (bool ok,) = address(drand).call{gas: g}(data);
            (bytes32 randomness, uint64 postedAt) = drand.beaconOf(r.round);
            if (!ok) {
                assertEq(randomness, bytes32(0), "a failed post stores nothing");
                assertEq(postedAt, 0);
                assertEq(drand.bountyOf(r.round), 0.01 ether, "the pot is intact");
                assertEq(drand.owedTo(poster), 0, "nothing credited");
            } else {
                passAt = g;
                assertEq(randomness, r.randomness, "the published randomness");
                assertEq(postedAt, uint64(r.time));
                assertEq(drand.bountyOf(r.round), 0, "the pot moved");
                assertEq(drand.owedTo(poster), 0.01 ether, "to the poster");
                break;
            }
        }
        assertGt(passAt, 0, "a post passes within 400,000 gas");
        emit log_named_uint("least gas cap (500 steps) for postRound of a bountied round, cold", passAt);
        _assertGhostLedger();
    }

    /// L5 (measured bound): a well-formed wrong signature (the negated point) is refused at the cost of the check
    /// itself (201,575 gas under Osaka, 465,835 under Amsterdam: Foundry 1.8.3's Glamsterdam repricing about doubles
    /// it, below half of the cap on both), while a malformed one (a coordinate at or above p, a point outside G1)
    /// makes the EIP-2537 precompile burn every unit of gas forwarded to it (BoxDrandQuicknet.sol:28-29): through
    /// `postRound` such a poster pays all but 1/64 of the call's gas, whatever the cap (1,000,000 and 120,000 here).
    /// Metered from a contract frame (`AuditU8FableGasMeter`); the figures are logged for the keeper's gas-limit
    /// choice. The poster is the meter.
    function testProperty_AUDIT_U8_malformedPostBurnsItsGasAWellFormedWrongOneDoesNot() public {
        Round memory r = _boxDrandAt(LOCAL + 7);
        _warpTo(r.time);
        bytes[3] memory inputs = [_negated(r.xy), _plusP(r.xy, true, false), _point(0, 0, 0, 2)];
        uint256[3] memory used;
        for (uint256 k; k < 3; ++k) {
            vm.cool(address(drand));
            (bool ok, bytes memory ret) =
                meter.call(address(drand), abi.encodeCall(drand.postRound, (r.round, inputs[k])), PROBE_GAS);
            used[k] = meter.used();
            assertFalse(ok);
            assertEq(_sel(ret), IDrandSource.InvalidSignature.selector, "refused as InvalidSignature");
        }
        emit log_named_uint("postRound, negated point (well-formed, wrong): gas used under a 1,000,000 cap", used[0]);
        emit log_named_uint("postRound, x + p (malformed): gas used under a 1,000,000 cap", used[1]);
        emit log_named_uint("postRound, (0, 2) outside G1: gas used under a 1,000,000 cap", used[2]);
        assertLt(used[0], PROBE_GAS / 2, "a well-formed wrong point costs the check, not the cap");
        assertGt(used[1], PROBE_GAS * 63 / 64, "a malformed point costs all but 1/64 of the cap");
        assertGt(used[2], PROBE_GAS * 63 / 64, "a point outside G1 costs all but 1/64 of the cap");
        vm.cool(address(drand));
        (bool ok2,) = meter.call(address(drand), abi.encodeCall(drand.postRound, (r.round, inputs[1])), 120_000);
        assertFalse(ok2);
        emit log_named_uint("postRound, x + p (malformed): gas used under a 120,000 cap", meter.used());
        assertGt(meter.used(), 120_000 * 63 / 64, "the whole cap, whatever it is");
        (bytes32 stored,) = drand.beaconOf(r.round);
        assertEq(stored, bytes32(0), "nothing stored by any of them");
    }

    /// Without EIP-2537 (Cancun) every precompile call answers nothing and the checker fails closed; a post refuses
    /// with InvalidSignature and changes nothing (BoxDrandQuicknet.sol:29-30). The schedule is switched at a CALL
    /// boundary (Foundry 1.8.3), as BoxDrandQuicknet.t.sol does; restored afterwards.
    function testProperty_AUDIT_U8_withoutTheBlsPrecompilesNothingVerifies() public {
        Round memory r = _boxDrandAt(LOCAL + 2);
        _warpTo(r.time);
        vm.setEvmVersion("cancun");
        (bool called, bool valid, bytes32 randomness) = _verifyWithGas(uint64(r.round), r.xy, 5_000_000);
        assertTrue(called && !valid, "false, not a revert");
        assertEq(randomness, bytes32(0));
        vm.prank(poster);
        (bool ok, bytes memory ret) = address(drand).call(abi.encodeCall(drand.postRound, (r.round, r.xy)));
        assertFalse(ok);
        assertEq(_sel(ret), IDrandSource.InvalidSignature.selector);
        (bytes32 stored,) = drand.beaconOf(r.round);
        assertEq(stored, bytes32(0));
        vm.setEvmVersion(_evm());
        (called, valid, randomness) = _verifyWithGas(uint64(r.round), r.xy, 5_000_000);
        assertTrue(called && valid, "back on the contract's EVM it verifies");
        assertEq(randomness, r.randomness);
    }
}

/// @notice The same under Amsterdam (Glamsterdam's repricing; EIP-2537 unchanged).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8FableQuicknetAmsterdamTest is AuditU8FableQuicknetTest {
    function _evm() internal pure override returns (string memory) {
        return "amsterdam";
    }
}
