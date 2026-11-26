// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxDrandQuicknet} from "../../../../src/box/randomness/BoxDrandQuicknet.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @notice TEST ONLY (SH-AUDIT-B0-U8-F). `BoxDrandQuicknet.verify` with calldata, exactly as `DrandSource.postRound`
/// calls it (the library is internal): a harness over the code under review, not a stand-in for another contract.
contract AuditU8FableQuicknetProbe {
    function verify(uint64 round, bytes calldata signature) external view returns (bool, bytes32) {
        return BoxDrandQuicknet.verify(round, signature);
    }

    function hashToG1(bytes memory message, bytes memory dst) external view returns (bool, bytes memory) {
        return BoxDrandQuicknet.hashToG1(message, dst);
    }
}

/// @notice TEST ONLY (SH-AUDIT-B0-U8-F). A consumer built on `DrandWords` (the library is internal, inlined into
/// BoxTickets): a stand-in for a consumer such as box 0's tickets, used only where the property is about the
/// library's own behaviour (`GasTooLow` against "no word").
contract AuditU8FableWordsConsumer {
    IDrandSource internal immutable src;

    constructor(IDrandSource src_) {
        src = src_;
    }

    function request(uint256 key) external payable returns (uint256) {
        return DrandWords.request(src, key, msg.value);
    }

    function wordOf(uint256 key) external view returns (bytes32, uint256) {
        return DrandWords.wordOf(src, key);
    }

    function usableWord(uint256 key, uint256 requestedAt) external view returns (bytes32, uint256, bool) {
        return DrandWords.usableWord(src, key, requestedAt);
    }

    function isDead(uint256 key, uint256 requestedAt) external view returns (bool) {
        return DrandWords.isDead(src, key, requestedAt);
    }
}

/// @notice TEST ONLY (SH-AUDIT-B0-U8-F). A bounty recipient that re-enters the DrandSource while it receives its
/// credit (a stand-in: the property is how the source treats a re-entering recipient). It is also a poster and a
/// consumer in its own right, so its re-entries are the calls a real poster contract could make.
contract AuditU8FableReentrantRecipient {
    DrandSource public immutable drand;
    /// @notice 0 none, 1 withdrawBounty again, 2 postRound (of `round` with `sig`), 3 request(`key`),
    /// 4 addBounty(`round`) with everything just received.
    uint8 public mode;
    uint256 public round;
    bytes public sig;
    uint256 public key;
    bytes public lastRevert;
    bool public reentryPassed;
    uint256 public received;
    uint256 public receipts;

    constructor(DrandSource drand_) {
        drand = drand_;
    }

    function arm(uint8 mode_, uint256 round_, bytes calldata sig_, uint256 key_) external {
        mode = mode_;
        round = round_;
        sig = sig_;
        key = key_;
        lastRevert = "";
        reentryPassed = false;
    }

    function post(uint256 round_, bytes calldata sig_) external {
        drand.postRound(round_, sig_);
    }

    function withdraw() external returns (uint256) {
        return drand.withdrawBounty(payable(address(this)));
    }

    function requestKey(uint256 key_) external payable returns (uint256) {
        return drand.request{value: msg.value}(key_);
    }

    receive() external payable {
        received += msg.value;
        ++receipts;
        uint8 m = mode;
        if (m == 0) return;
        bool ok;
        bytes memory err;
        if (m == 1) {
            (ok, err) = address(drand).call(abi.encodeCall(drand.withdrawBounty, (payable(address(this)))));
        } else if (m == 2) {
            (ok, err) = address(drand).call(abi.encodeCall(drand.postRound, (round, sig)));
        } else if (m == 3) {
            (ok, err) = address(drand).call(abi.encodeCall(drand.request, (key)));
        } else if (m == 4) {
            (ok, err) = address(drand).call{value: msg.value}(abi.encodeCall(drand.addBounty, (round)));
        }
        if (ok) reentryPassed = true;
        else lastRevert = err;
    }
}

/// @notice TEST ONLY (SH-AUDIT-B0-U8-F). A caller that meters a call from its own EVM frame. Foundry 1.8.3's
/// top-level test frame under-reports a `gasleft` delta around a sub-call that ends in a precompile halt (the
/// EIP-2537 "burn all gas on a malformed input" case: 931 to 5,431 reported where a contract frame sees 988,293 of a
/// 1,000,000 cap), so every gas figure about such a call is taken here.
contract AuditU8FableGasMeter {
    uint256 public used;
    bool public ok;
    bytes public ret;

    function call(address target, bytes calldata data, uint256 gas) external returns (bool, bytes memory) {
        uint256 g0 = gasleft();
        (ok, ret) = target.call{gas: gas}(data);
        used = g0 - gasleft();
        return (ok, ret);
    }
}

/// @title AuditU8FableBase
/// @notice TEST ONLY (SH-AUDIT-B0-U8-F, the Fable 5.1 review of box 0's unit U8). The shared world (`AuditPhases`:
/// the factory's box 0 on the mainnet build, chain id 1, the pinned DrandSource and BoxBackedSource through the local
/// Arachnid deployer) plus what the randomness tests need on top: 384-bit field arithmetic over BLS12-381's p for the
/// signature probes, a reference compression of an uncompressed signature, the quicknet probe harness, header
/// builders for every post-London header shape and for malformed encodings, and a cold, gas-capped `wordOf` read as
/// BoxTickets makes it (a STATICCALL with exactly 50,000 gas).
abstract contract AuditU8FableBase is AuditPhases {
    /// @dev BLS12-381's base field modulus p as its top 16 bytes and its low 32 bytes (48 bytes big-endian).
    uint256 internal constant P_HI = 0x1a0111ea397fe69a4b1ba7b6434bacd7;
    uint256 internal constant P_LO = 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;
    /// @dev (p - 1) / 2, the same split: a y above it carries the compressed sign bit (ZCash / IETF encoding).
    uint256 internal constant HALF_HI = 0x0d0088f51cbff34d258dd3db21a5d66b;
    uint256 internal constant HALF_LO = 0xb23ba5c279c2895fb39869507b587b120f55ffff58a9ffffdcff7fffffffd555;
    /// @notice The consumers' read gas (BoxTickets' `_WORD_GAS`, `DrandWords.WORD_GAS`).
    uint256 internal constant WORD_READ_GAS = 50_000;
    address internal constant G1ADD = address(0x0b);

    AuditU8FableQuicknetProbe internal probe;
    AuditU8FableGasMeter internal meter;

    function setUp() public virtual override {
        super.setUp();
        probe = new AuditU8FableQuicknetProbe();
        meter = new AuditU8FableGasMeter();
    }

    /// @notice The EVM this concrete contract runs (its inline config); the Amsterdam variants override it.
    function _evm() internal pure virtual returns (string memory) {
        return "osaka";
    }

    // ------------------------------------------------------------------------------------------------ 384-bit field

    /// @dev The 48-byte big-endian integer at `b[off .. off + 48)` as (top 16 bytes, low 32 bytes).
    function _split48(bytes memory b, uint256 off) internal pure returns (uint256 hi, uint256 lo) {
        require(off + 48 <= b.length, "split48: out of range");
        bytes32 h;
        bytes32 l;
        assembly ("memory-safe") {
            h := mload(add(add(b, 32), off))
            l := mload(add(add(b, 48), off))
        }
        hi = uint256(h) >> 128;
        lo = uint256(l);
    }

    /// @dev (hi, lo) as 48 big-endian bytes (hi below 2^128).
    function _join48(uint256 hi, uint256 lo) internal pure returns (bytes memory) {
        require(hi < (1 << 128), "join48: does not fit in 48 bytes");
        // casting to 'uint128' is safe because hi < 2^128 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes.concat(bytes16(uint128(hi)), bytes32(lo));
    }

    function _add384(uint256 ahi, uint256 alo, uint256 bhi, uint256 blo)
        internal
        pure
        returns (uint256 hi, uint256 lo)
    {
        unchecked {
            lo = alo + blo;
            hi = ahi + bhi + (lo < alo ? 1 : 0);
        }
    }

    /// @dev a - b for a >= b.
    function _sub384(uint256 ahi, uint256 alo, uint256 bhi, uint256 blo)
        internal
        pure
        returns (uint256 hi, uint256 lo)
    {
        require(ahi > bhi || (ahi == bhi && alo >= blo), "sub384: negative");
        unchecked {
            lo = alo - blo;
            hi = ahi - bhi - (alo < blo ? 1 : 0);
        }
    }

    function _gt384(uint256 ahi, uint256 alo, uint256 bhi, uint256 blo) internal pure returns (bool) {
        return ahi > bhi || (ahi == bhi && alo > blo);
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        require(start + len <= b.length, "slice: out of range");
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = b[start + i];
        }
    }

    /// @notice The compressed 48 bytes of an uncompressed signature (x ‖ y), by the IETF rule computed independently
    /// of the library: flag 0x80 (compressed), plus 0x20 when y > (p - 1) / 2, OR-ed into x's first byte.
    function _refCompressed(bytes memory xy) internal pure returns (bytes memory) {
        require(xy.length == 96, "ref: 96 bytes");
        (uint256 yhi, uint256 ylo) = _split48(xy, 48);
        bytes1 flags = _gt384(yhi, ylo, HALF_HI, HALF_LO) ? bytes1(0xa0) : bytes1(0x80);
        return bytes.concat(xy[0] | flags, _slice(xy, 1, 47));
    }

    /// @notice Whether y > (p - 1) / 2 for the signature's y (the reference sign bit).
    function _refLargerY(bytes memory xy) internal pure returns (bool) {
        (uint256 yhi, uint256 ylo) = _split48(xy, 48);
        return _gt384(yhi, ylo, HALF_HI, HALF_LO);
    }

    /// @notice The signature with y replaced by p - y: the other point with the same x (the negated point, on the
    /// curve and in the subgroup).
    function _negated(bytes memory xy) internal pure returns (bytes memory) {
        (uint256 yhi, uint256 ylo) = _split48(xy, 48);
        (uint256 nhi, uint256 nlo) = _sub384(P_HI, P_LO, yhi, ylo);
        return bytes.concat(_slice(xy, 0, 48), _join48(nhi, nlo));
    }

    /// @notice The signature with x and/or y replaced by itself + p (the same residue, not a canonical field element;
    /// it fits in 48 bytes for every committed round).
    function _plusP(bytes memory xy, bool onX, bool onY) internal pure returns (bytes memory) {
        (uint256 xhi, uint256 xlo) = _split48(xy, 0);
        (uint256 yhi, uint256 ylo) = _split48(xy, 48);
        if (onX) (xhi, xlo) = _add384(xhi, xlo, P_HI, P_LO);
        if (onY) (yhi, ylo) = _add384(yhi, ylo, P_HI, P_LO);
        return bytes.concat(_join48(xhi, xlo), _join48(yhi, ylo));
    }

    /// @notice A G1 point (x, y) in the signature's 96-byte form.
    function _point(uint256 xhi, uint256 xlo, uint256 yhi, uint256 ylo) internal pure returns (bytes memory) {
        return bytes.concat(_join48(xhi, xlo), _join48(yhi, ylo));
    }

    /// @notice EIP-2537's 128-byte G1 encoding of a 96-byte signature (16 zero bytes before each coordinate).
    function _padded(bytes memory xy) internal pure returns (bytes memory) {
        return bytes.concat(bytes16(0), _slice(xy, 0, 48), bytes16(0), _slice(xy, 48, 48));
    }

    /// @notice Whether the G1ADD precompile takes the point (on the curve, canonical coordinates); G1ADD makes no
    /// subgroup check, so a point it takes that the pairing check refuses is on the curve and outside G1.
    function _onCurvePerG1Add(bytes memory xy) internal view returns (bool) {
        bytes memory p = _padded(xy);
        // Capped: a malformed input makes the precompile burn every unit of gas it is given.
        (bool ok, bytes memory ret) = G1ADD.staticcall{gas: 200_000}(bytes.concat(p, p));
        return ok && ret.length == 128;
    }

    /// @notice The gas a probe gets: enough for the whole check many times over (a pairing check of two pairs costs
    /// 102,900; the whole `verify` about 150,000), so a failure under it is the precompile's own, never starvation.
    uint256 internal constant PROBE_GAS = 1_000_000;

    /// @notice `probe.verify` under `PROBE_GAS`: the answer, and whether the call returned at all.
    function _probe(uint256 round, bytes memory sig) internal returns (bool called, bool valid, bytes32 randomness) {
        return _verifyWithGas(uint64(round), sig, PROBE_GAS);
    }

    /// @notice `probe.verify` under a gas cap, through a CALL (Foundry switches an EVM version at a CALL boundary, not
    /// for a STATICCALL): (false, false, 0) when the call itself fails. Every refusal probe runs under `PROBE_GAS`
    /// because an EIP-2537 precompile burns all the gas it is given on a malformed input (a coordinate at or above p,
    /// a point outside the subgroup), which is what `postRound` does to such a poster as well.
    function _verifyWithGas(uint64 round, bytes memory sig, uint256 gas)
        internal
        returns (bool called, bool valid, bytes32 randomness)
    {
        (bool ok, bytes memory ret) = address(probe).call{gas: gas}(abi.encodeCall(probe.verify, (round, sig)));
        if (!ok || ret.length != 64) return (false, false, 0);
        (valid, randomness) = abi.decode(ret, (bool, bytes32));
        called = true;
    }

    // ------------------------------------------------------------------------------------------------ headers

    /// @notice The RLP list wrapper of `body` (long form from 56 bytes on, 1 to 3 length bytes).
    function _rlpList(bytes memory body) internal pure returns (bytes memory) {
        if (body.length < 56) return bytes.concat(abi.encodePacked(uint8(0xc0 + body.length)), body);
        if (body.length < 256) return bytes.concat(hex"f8", abi.encodePacked(uint8(body.length)), body);
        if (body.length < 65_536) return bytes.concat(hex"f9", abi.encodePacked(uint16(body.length)), body);
        return bytes.concat(hex"fa", abi.encodePacked(uint24(body.length)), body);
    }

    function _rlp32(bytes32 x) internal pure returns (bytes memory) {
        return bytes.concat(hex"a0", x);
    }

    /// @notice The first 13 header fields (parent, ommers, coinbase, state, txs, receipts, bloom, difficulty 0,
    /// number, gas limit, gas used, time, extra) followed by field 13 = `mix`: `AuditHeaders`' shape.
    function _headFields(uint256 number, bytes32 mix, bytes memory extra) internal pure returns (bytes memory) {
        bytes memory head = bytes.concat(
            _rlp32(keccak256("parent")),
            _rlp32(keccak256("ommers")),
            hex"94",
            bytes20(address(0xC0FFEE)),
            _rlp32(keccak256("state")),
            _rlp32(keccak256("txs")),
            _rlp32(keccak256("receipts"))
        );
        bytes memory mid = bytes.concat(
            hex"b90100", new bytes(256), hex"80", AuditHeaders.rlpUint(number), AuditHeaders.rlpUint(60_000_000)
        );
        bytes memory tail =
            bytes.concat(AuditHeaders.rlpUint(12_345_678), AuditHeaders.rlpUint(1_790_000_000), extra, _rlp32(mix));
        return bytes.concat(head, mid, tail);
    }

    /// @notice A header of `fields` fields (15 to 23) carrying `mix` at field 13, with the real shapes' trailing
    /// fields: 14 nonce (8 bytes); 15 baseFeePerGas (London); 16 withdrawalsRoot (Shanghai); 17 blobGasUsed,
    /// 18 excessBlobGas, 19 parentBeaconBlockRoot (Cancun); 20 requestsHash (Prague; Osaka adds none); 21 the
    /// block-access-list hash and 22 the slot number (Amsterdam; the Sepolia vector's 23-field shape).
    function _shapedHeader(uint256 number, bytes32 mix, uint256 fields) internal pure returns (bytes memory) {
        require(fields >= 15 && fields <= 23, "shape: 15 to 23 fields");
        bytes memory body = _headFields(number, mix, hex"83616263");
        bytes[9] memory after_ = [
            bytes(hex"880000000000000000"),
            AuditHeaders.rlpUint(7),
            _rlp32(keccak256("withdrawals")),
            AuditHeaders.rlpUint(131_072),
            AuditHeaders.rlpUint(0),
            _rlp32(keccak256("beacon")),
            _rlp32(keccak256("requests")),
            _rlp32(keccak256("bal")),
            AuditHeaders.rlpUint(12_345_678)
        ];
        for (uint256 i; i < fields - 14; ++i) {
            body = bytes.concat(body, after_[i]);
        }
        return _rlpList(body);
    }

    /// @notice How many RLP items a long-form list holds (an independent counter for the evidence).
    function _rlpItemCount(bytes memory h) internal pure returns (uint256 n) {
        require(h.length >= 2 && uint8(h[0]) >= 0xf8, "count: long-form list");
        uint256 ll = uint8(h[0]) - 0xf7;
        uint256 p = 1 + ll;
        while (p < h.length) {
            uint256 b = uint8(h[p]);
            if (b < 0x80) p += 1;
            else if (b <= 0xb7) p += 1 + (b - 0x80);
            else if (b < 0xc0) p += 1 + (b - 0xb7) + _beOf(h, p + 1, b - 0xb7);
            else if (b <= 0xf7) p += 1 + (b - 0xc0);
            else p += 1 + (b - 0xf7) + _beOf(h, p + 1, b - 0xf7);
            ++n;
        }
        require(p == h.length, "count: overrun");
    }

    function _beOf(bytes memory h, uint256 p, uint256 n) internal pure returns (uint256 v) {
        for (uint256 i; i < n; ++i) {
            v = (v << 8) | uint8(h[p + i]);
        }
    }

    /// @notice Serves `h` as block `number`'s header the way the chain would (BLOCKHASH within 256 blocks, EIP-2935's
    /// real code after) and returns its hash.
    function _serve(uint256 number, bytes memory h) internal returns (bytes32 hh) {
        hh = keccak256(h);
        uint256 now_ = vm.getBlockNumber();
        if (now_ > number && now_ - number <= 256) vm.setBlockhash(number, hh);
        _putHistory(number, hh);
    }

    function _putHistory(uint256 number, bytes32 hh) internal {
        if (src.HISTORY().code.length == 0) vm.etch(src.HISTORY(), _history2935Code());
        vm.store(src.HISTORY(), bytes32(number % src.HISTORY_WINDOW()), hh);
    }

    /// @dev EIP-2935's Prague runtime code (test/box/backup/History2935.sol).
    function _history2935Code() internal pure returns (bytes memory) {
        return hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";
    }

    /// @notice `fixBackup(round, h)` as `who` through a low-level call: the revert data when it fails.
    function _tryFix(uint256 round, bytes memory h, address who) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = address(src).call(abi.encodeCall(src.fixBackup, (round, h)));
    }

    /// @notice `startBackup(round, headerBlock, h)` as `who` through a low-level call.
    function _tryStart(uint256 round, uint256 headerBlock, bytes memory h, address who)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(who);
        (ok, ret) = address(src).call(abi.encodeCall(src.startBackup, (round, headerBlock, h)));
    }

    // ------------------------------------------------------------------------------------------------ reads

    /// @notice A cold `wordOf` read on `source` for (consumer, key) with exactly `WORD_READ_GAS`, as BoxTickets reads
    /// it: whether it answered 64 bytes, the answer, and the gas the caller's frame spent.
    function _coldRead(address source, address consumer, uint256 key)
        internal
        returns (bool ok, bytes32 word, uint64 readyAt, uint256 used)
    {
        vm.cool(address(src));
        vm.cool(address(drand));
        bytes memory data = abi.encodeWithSelector(IDrandSource.wordOf.selector, consumer, key);
        uint256 g0 = gasleft();
        (bool called, bytes memory ret) = source.staticcall{gas: WORD_READ_GAS}(data);
        used = g0 - gasleft();
        ok = called && ret.length == 64;
        if (ok) (word, readyAt) = abi.decode(ret, (bytes32, uint64));
    }

    /// @notice The revert selector of `ret`.
    function _sel(bytes memory ret) internal pure returns (bytes4 s) {
        if (ret.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            s := mload(add(ret, 32))
        }
    }
}
