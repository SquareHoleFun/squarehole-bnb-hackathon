// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU8LaneBase, IDrandSource} from "./AuditU8LaneBase.sol";
import {BoxDrandQuicknet} from "../../../../src/box/randomness/BoxDrandQuicknet.sol";

contract AuditU8LaneVerifier {
    function verify(uint64 round, bytes calldata signature) external view returns (bool, bytes32) {
        return BoxDrandQuicknet.verify(round, signature);
    }
}

/// @notice BC-053 / F54: real EIP-2537 precompiles, all committed drand vectors and independent byte arithmetic.
/// forge-config: default.evm_version = "osaka"
contract AuditU8LaneQuicknetTest is AuditU8LaneBase {
    AuditU8LaneVerifier internal verifier;
    bytes internal constant P =
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    function setUp() public override {
        super.setUp();
        verifier = new AuditU8LaneVerifier();
    }

    function _copy(bytes memory v) internal pure returns (bytes memory) {
        return bytes.concat(v);
    }

    // Base-256 subtraction, independent of the verifier's two-limb HALF_HI/HALF_LO comparison.
    function _negative(bytes memory sig) internal pure returns (bytes memory out) {
        out = _copy(sig);
        uint256 borrow;
        bytes memory p = P;
        for (uint256 i = 48; i > 0; --i) {
            uint256 sub = uint8(sig[47 + i]) + borrow;
            uint256 value = uint8(p[i - 1]);
            out[47 + i] = bytes1(uint8(256 + value - sub));
            borrow = value < sub ? 1 : 0;
        }
        assert(borrow == 0);
    }

    function _plusP(bytes memory sig, uint256 offset) internal pure returns (bytes memory out) {
        out = _copy(sig);
        uint256 carry;
        bytes memory p = P;
        for (uint256 i = 48; i > 0; --i) {
            uint256 sum = uint8(sig[offset + i - 1]) + uint256(uint8(p[i - 1])) + carry;
            out[offset + i - 1] = bytes1(uint8(sum));
            carry = sum >> 8;
        }
        assert(carry == 0); // 2p < 2^384, so every canonical coordinate fits after addition.
    }

    function _referenceCompression(bytes memory sig) internal pure returns (bytes memory compressed) {
        bytes memory neg = _negative(sig);
        bool greater;
        for (uint256 i = 48; i < 96; ++i) {
            if (sig[i] == neg[i]) continue;
            greater = uint8(sig[i]) > uint8(neg[i]);
            break;
        }
        compressed = new bytes(48);
        for (uint256 i; i < 48; ++i) {
            compressed[i] = sig[i];
        }
        compressed[0] |= greater ? bytes1(0xa0) : bytes1(0x80);
    }

    function _false(uint64 round, bytes memory sig) internal view {
        (bool ok, bytes memory ret) =
            address(verifier).staticcall{gas: 2_000_000}(abi.encodeCall(verifier.verify, (round, sig)));
        assertTrue(ok, "invalid input returns false with a full allowance");
        (bool valid, bytes32 randomness) = abi.decode(ret, (bool, bytes32));
        assertFalse(valid);
        assertEq(randomness, bytes32(0));
    }

    function testProperty_AUDIT_U8_allCommittedCompressionAndCanonicality() public view {
        uint256 count = _boxDrandCount();
        for (uint256 i; i < count; ++i) {
            Round memory r = _boxDrandAt(i);
            assertEq(r.xy.length, 96);
            assertEq(r.compressed.length, 48);
            bytes memory ref = _referenceCompression(r.xy);
            assertEq(ref, r.compressed, "compressed bytes including reference sign bit");
            (bool valid, bytes32 randomness) = verifier.verify(uint64(r.round), r.xy);
            assertTrue(valid);
            assertEq(randomness, sha256(ref));
            assertEq(randomness, r.randomness);
            _false(uint64(r.round), _negative(r.xy));
            _false(uint64(r.round), _plusP(r.xy, 0));
            _false(uint64(r.round), _plusP(r.xy, 48));
            _false(uint64(r.round + 1), r.xy);
            if (r.round > 1) _false(uint64(r.round - 1), r.xy);
            _false(uint64(r.round), r.compressed);
            // Cover both coordinates and their top/bottom bits for every committed round.
            for (uint256 bit; bit < 768; bit += 127) {
                bytes memory changed = _copy(r.xy);
                changed[bit / 8] ^= bytes1(uint8(1 << (bit % 8)));
                _false(uint64(r.round), changed);
            }
        }
    }

    function testProperty_AUDIT_U8_zeroLengthsAndNonSubgroup() public view {
        uint256[5] memory lengths = [uint256(0), 48, 95, 96, 97];
        for (uint256 i; i < lengths.length; ++i) {
            _false(uint64(first), new bytes(lengths[i]));
        }
        // (0, 2) lies on y^2 = x^3 + 4 and has order 3: doubling is (0, -2).
        // The BLS12-381 prime-order subgroup has order not divisible by 3.
        bytes memory torsion = new bytes(96);
        torsion[95] = bytes1(0x02);
        _false(uint64(first), torsion);
    }

    function testFuzz_AUDIT_U8_singleBitRejected(uint256 vector, uint256 bit) public view {
        Round memory r = _boxDrandAt(vector % _boxDrandCount());
        bit %= 768;
        r.xy[bit / 8] ^= bytes1(uint8(1 << (bit % 8)));
        _false(uint64(r.round), r.xy);
    }

    function testFuzz_AUDIT_U8_gasCannotValidateNonCanonical(uint256 allowance, uint256 vector, bool y) public view {
        Round memory r = _boxDrandAt(vector % _boxDrandCount());
        bytes memory noncanonical = _plusP(r.xy, y ? 48 : 0);
        allowance = bound(allowance, 0, 2_000_000);
        (bool ok, bytes memory ret) = address(verifier).staticcall{gas: allowance}(
            abi.encodeCall(verifier.verify, (uint64(r.round), noncanonical))
        );
        if (ok) {
            assertEq(ret.length, 64);
            (bool valid, bytes32 randomness) = abi.decode(ret, (bool, bytes32));
            assertFalse(valid);
            assertEq(randomness, bytes32(0));
        }
    }

    function testProperty_AUDIT_U8_starvedPostAtomic() public {
        _request(false, address(this), 1, 3 ether);
        vm.warp(drand.roundTime(first));
        bytes memory sig = _localSig(0);
        uint256[5] memory limits = [uint256(0), 10_000, 30_000, 60_000, 100_000];
        for (uint256 i; i < limits.length; ++i) {
            vm.cool(address(drand));
            (bool ok,) = address(drand).call{gas: limits[i]}(abi.encodeCall(drand.postRound, (first, sig)));
            assertFalse(ok);
            (bytes32 randomness, uint64 postedAt) = drand.beaconOf(first);
            assertEq(randomness, bytes32(0));
            assertEq(postedAt, 0);
            assertEq(drand.bountyOf(first), 3 ether);
            assertEq(drand.owedTo(address(this)), 0);
            assertEq(address(drand).balance, 3 ether);
            (bytes32 word, uint64 ready) = drand.wordOf(address(this), 1);
            assertEq(word, bytes32(0));
            assertEq(ready, 0);
        }
        drand.postRound(first, sig);
        assertEq(drand.owedTo(address(this)), 3 ether);
    }
}
