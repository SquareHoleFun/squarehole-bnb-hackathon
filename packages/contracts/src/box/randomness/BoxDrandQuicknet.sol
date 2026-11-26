// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxDrandQuicknet (slice S9)
/// @notice The box core's copy of the on-chain check of a drand **quicknet** round: `DrandQuicknet`
/// (src/v2/libraries/DrandQuicknet.sol:4-133 at `46a030f6`), copied so that the box core (`src/box/**`) compiles on its
/// own and the deployed v2 sources stay untouched. The logic, the constants and the precompile calls are the same line
/// for line (test/box/randomness/BoxDrandQuicknet.t.sol checks it against the v2 library on every committed round,
/// RFC 9380's vectors and fuzzed inputs); the only change is a custom error instead of a revert string for a tag
/// longer than 255 bytes, which no caller here passes.
///
/// quicknet (League of Entropy; scheme `bls-unchained-g1-rfc9380`, chain hash
/// 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971, genesis 1,692,803,367, one round every 3 s,
/// https://api.drand.sh/v2/beacons/quicknet/info): round r is the BLS12-381 signature σ ∈ G1 of
/// m = sha256(r as 8 bytes, big-endian) under the group key pk ∈ G2; its randomness is sha256(σ compressed, 48 bytes).
/// σ is valid iff e(σ, −g2) · e(H(m), pk) = 1, where H is RFC 9380's hash_to_curve for the suite
/// BLS12381G1_XMD:SHA-256_SSWU_RO_ with drand's tag. A round has exactly one valid σ, so nobody (the poster included)
/// can choose it.
///
/// Built on the EIP-2537 precompiles (Prague; live on mainnet and Sepolia) plus SHA-256 (0x02) and MODEXP (0x05):
/// - hash_to_field: expand_message_xmd (SHA-256, 128 bytes) → two 64-byte integers reduced mod p by MODEXP (b¹ mod p);
/// - map_to_curve and clear_cofactor: `BLS12_MAP_FP_TO_G1` (0x10; EIP-2537 assets/field_to_curve.md: "Cofactor is
///   cleared"), once per field element; clear_cofactor is linear, so H(m) = MAP(u0) + MAP(u1) (`BLS12_G1ADD`, 0x0b);
/// - the check: `BLS12_PAIRING_CHECK` (0x0f), which also rejects points off the curve or outside the subgroup and any
///   coordinate ≥ p.
/// The signature is taken **uncompressed** (x ‖ y, 48 bytes each) because a square root in Fp on chain would cost a
/// 381-bit MODEXP (about 37,000 gas under EIP-7883); the compressed bytes, and so the randomness, are rebuilt from
/// (x, y) here (sign bit: y > (p − 1) / 2). Precompile calls get all remaining gas (EIP-2537 burns it on a malformed
/// input): no fixed gas figure can go stale under a later repricing. On a chain without EIP-2537 every call returns
/// nothing and `verify` reports false.
/// @dev Written for Square Hole (MIT, no third-party code). The pairing check and hash follow RFC 9380 § 5.3 (expand_
/// message_xmd), § 5.2 (hash_to_field) and § 3 (hash_to_curve). The audit of this checker is open (auto-reveal § 3.1:
/// it is now the only path).
library BoxDrandQuicknet {
    /// @notice A domain separation tag longer than RFC 9380 allows (255 bytes).
    error DstTooLong(uint256 length);

    /// @notice quicknet's genesis: the time of round 1.
    uint256 internal constant GENESIS_TIME = 1_692_803_367;
    /// @notice Seconds between rounds.
    uint256 internal constant PERIOD = 3;
    /// @notice drand's domain separation tag for quicknet (RFC 9380 § 3.1; drand `bls-unchained-g1-rfc9380`).
    bytes internal constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

    /// @notice quicknet's group public key in G2, EIP-2537 encoding (x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1, 64 bytes each). The
    /// published compressed key is 83cf0f28…ece45a; `test/vectors/drand-quicknet.json` records both, and the v2 tests
    /// compress this constant back to the published bytes (the box tests compare it with the v2 constant).
    bytes internal constant PUBLIC_KEY = hex"000000000000000000000000000000000d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
        hex"0000000000000000000000000000000003cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451"
        hex"000000000000000000000000000000000e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273"
        hex"0000000000000000000000000000000001a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b";

    /// @notice −g2: BLS12-381's G2 generator with y negated, EIP-2537 encoding.
    bytes internal constant NEG_G2_GENERATOR = hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8"
        hex"0000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e"
        hex"000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa"
        hex"0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed";

    /// @dev The base field modulus p, 64 bytes big-endian (MODEXP's modulus).
    bytes private constant P =
        hex"000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";
    /// @dev (p − 1) / 2, as its top 16 and low 32 bytes: y above it is the "larger" root (the compressed sign bit).
    uint256 private constant HALF_HI = 0x0d0088f51cbff34d258dd3db21a5d66b;
    uint256 private constant HALF_LO = 0xb23ba5c279c2895fb39869507b587b120f55ffff58a9ffffdcff7fffffffd555;

    address private constant MODEXP = address(0x05);
    address private constant G1ADD = address(0x0b);
    address private constant PAIRING_CHECK = address(0x0f);
    address private constant MAP_FP_TO_G1 = address(0x10);

    /// @notice Whether `signature` (x ‖ y, 96 bytes, uncompressed) is quicknet's signature of `round`, and if so the
    /// round's randomness, sha256 of the compressed signature (what api.drand.sh publishes as `randomness`).
    function verify(uint64 round, bytes calldata signature) internal view returns (bool valid, bytes32 randomness) {
        if (signature.length != 96) return (false, 0);
        (bool ok, bytes memory h) = hashToG1(abi.encodePacked(sha256(abi.encodePacked(round))), DST);
        if (!ok) return (false, 0);
        bytes memory input =
            bytes.concat(bytes16(0), signature[0:48], bytes16(0), signature[48:96], NEG_G2_GENERATOR, h, PUBLIC_KEY);
        bytes memory out;
        (ok, out) = PAIRING_CHECK.staticcall(input);
        if (!ok || out.length != 32 || abi.decode(out, (uint256)) != 1) return (false, 0);
        // Valid, so 0 < x, y < p and σ is not the point at infinity: rebuild the 48 compressed bytes.
        uint256 yHi = uint128(bytes16(signature[48:64]));
        uint256 yLo = uint256(bytes32(signature[64:96]));
        bool larger = yHi > HALF_HI || (yHi == HALF_HI && yLo > HALF_LO);
        bytes1 flags = larger ? bytes1(0xa0) : bytes1(0x80); // compressed, and the sign bit
        randomness = sha256(bytes.concat(signature[0] | flags, signature[1:48]));
        valid = true;
    }

    /// @notice RFC 9380 hash_to_curve(message) into G1 for the suite BLS12381G1_XMD:SHA-256_SSWU_RO_ with tag `dst`,
    /// EIP-2537 encoding (x ‖ y, 64 bytes each). `ok` is false only on a chain without the precompiles.
    function hashToG1(bytes memory message, bytes memory dst) internal view returns (bool ok, bytes memory point) {
        bytes memory u0;
        bytes memory u1;
        (ok, u0, u1) = hashToField(message, dst);
        if (!ok) return (false, point);
        bytes memory q0;
        bytes memory q1;
        (ok, q0) = MAP_FP_TO_G1.staticcall(u0);
        if (!ok || q0.length != 128) return (false, point);
        (ok, q1) = MAP_FP_TO_G1.staticcall(u1);
        if (!ok || q1.length != 128) return (false, point);
        (ok, point) = G1ADD.staticcall(bytes.concat(q0, q1));
        ok = ok && point.length == 128;
    }

    /// @notice RFC 9380 hash_to_field(message, 2) over Fp (L = 64, SHA-256): two field elements in EIP-2537 encoding.
    function hashToField(bytes memory message, bytes memory dst)
        internal
        view
        returns (bool ok, bytes memory u0, bytes memory u1)
    {
        (bytes32 b1, bytes32 b2, bytes32 b3, bytes32 b4) = expandMessageXmd(message, dst);
        (ok, u0) = _modP(b1, b2);
        if (!ok) return (false, u0, u1);
        (ok, u1) = _modP(b3, b4);
    }

    /// @notice RFC 9380 § 5.3.1 expand_message_xmd with SHA-256 and len_in_bytes = 128: b_1 ‖ b_2 ‖ b_3 ‖ b_4.
    function expandMessageXmd(bytes memory message, bytes memory dst)
        internal
        pure
        returns (bytes32 b1, bytes32 b2, bytes32 b3, bytes32 b4)
    {
        if (dst.length > 255) revert DstTooLong(dst.length);
        // casting to 'uint8' is safe because dst.length <= 255 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory dstPrime = bytes.concat(dst, bytes1(uint8(dst.length)));
        // Z_pad (64 zero bytes: SHA-256's block) ‖ msg ‖ I2OSP(128, 2) ‖ I2OSP(0, 1) ‖ DST_prime
        bytes32 b0 = sha256(bytes.concat(bytes32(0), bytes32(0), message, hex"008000", dstPrime));
        b1 = sha256(bytes.concat(b0, hex"01", dstPrime));
        b2 = sha256(bytes.concat(b0 ^ b1, hex"02", dstPrime));
        b3 = sha256(bytes.concat(b0 ^ b2, hex"03", dstPrime));
        b4 = sha256(bytes.concat(b0 ^ b3, hex"04", dstPrime));
    }

    /// @dev The 64-byte integer hi ‖ lo reduced mod p, by MODEXP (base^1 mod p), 64 bytes out.
    function _modP(bytes32 hi, bytes32 lo) private view returns (bool ok, bytes memory out) {
        (ok, out) = MODEXP.staticcall(abi.encodePacked(uint256(64), uint256(1), uint256(64), hi, lo, uint8(1), P));
        ok = ok && out.length == 64;
    }
}
