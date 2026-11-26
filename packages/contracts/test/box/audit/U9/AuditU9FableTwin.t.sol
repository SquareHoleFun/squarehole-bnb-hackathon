// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {AuditU9FableTwinVectors as V} from "./AuditU9FableTwinVectors.sol";

/// @title AuditU9FableTwin
/// @notice SH-AUDIT-B0-U9 (Fable 5.1), lenses L7 (P9.7) and L6 (P9.6): the Solidity/TypeScript twin on random specs
/// and random raises, replayed without FFI. `gen/AuditU9FableGen.mjs` builds every spec vector from its index with
/// keccak256(abi.encode(seed, k)) words and records what the twin (packages/box-spec, validateBoxSpecV1Bytes) answered;
/// this contract rebuilds the same spec with the same words (`_buildSpec` mirrors `buildSpec` line for line), runs
/// `BoxSpecV1.validate` / `specHash`, and compares reason, field and hash. Layout vectors carry the raise and the twin's
/// curve and graduated layouts (layout.ts on its bigint port of the pinned v4 maths); here BoxLayoutV1 runs on the real
/// TickMath / SqrtPriceMath / LiquidityAmounts, so a match pins the TypeScript v4 port too.
/// @dev Sources: BC-001 (`BoxSpecV1.sol:11-16`), BC-002, BC-003 (`BoxLayoutV1.sol:10-36`).
contract AuditU9FableTwinTest is Test {
    string internal constant VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    uint256 internal constant R = 4_206_980_085_000_000_000;
    uint256 internal constant MIN_OPEN_AT = 1_788_220_800;
    address internal constant SAFE = 0xdCE82e76456434d0f550b492Ff212A862221e6c5;
    address internal constant Q18 = 0x1800000000000000000000000000000000000018;
    address internal constant Q6 = 0x0600000000000000000000000000000000000006;
    address internal constant QFIT = 0xf170000000000000000000000000000000000f17;
    address internal constant QBOX = 0xb0C5000000000000000000000000000000000B0C;
    bytes internal constant URL_CHARS =
        "!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~";

    uint256 internal mismatches;

    // ================================================================================================ spec vectors

    /// The generator's four bases are the shared fixtures (box 0 as vector 0; every base by its pinned fixture hash),
    /// each valid under its version's context, so the differential starts from the specs BC-001 pins.
    function testProperty_AUDIT_U9_twinBasesAreTheSharedFixtures() public view {
        string memory json = vm.readFile(VECTORS);
        assertEq(keccak256(V.base(0)), keccak256(vm.parseJsonBytes(json, ".columns.encoded[0]")), "box 0 is vector 0");
        string[4] memory names = ["box-0-misfits", "demo-placeholders", "demo-open-art", "demo-token-only"];
        for (uint256 i; i < 4; ++i) {
            BoxSpecV1.BoxSpec memory s = abi.decode(V.base(i), (BoxSpecV1.BoxSpec));
            assertEq(BoxSpecV1.specHash(s), vm.parseJsonBytes32(json, string.concat(".fixtures.", names[i])), names[i]);
            assertEq(keccak256(abi.encode(s)), keccak256(V.base(i)), "the base re-encodes to itself");
            (uint16 reason,) = BoxSpecV1.validate(s, i == 0 ? BoxSpecV1.contextV1() : BoxSpecV1.contextV2());
            assertEq(reason, BoxSpecV1.REASON_OK, "every base is a valid spec");
        }
    }

    /// P9.7: every spec vector gives the twin's (reason, field) and specHash in Solidity. Each vector runs in its own
    /// external call (fresh memory); every reason code of the format appears among the vectors (the generated file's
    /// header lists the histogram), and every refusal names a field.
    function testProperty_AUDIT_U9_twinVerdictsAndHashesAgree() public {
        bytes memory d = V.specData();
        assertEq(d.length, V.SPEC_COUNT * V.SPEC_RECORD, "record size");
        uint256 accepted;
        bool[21] memory seen;
        for (uint256 i; i < V.SPEC_COUNT; ++i) {
            (uint16 reason, uint16 field, bytes32 h) = _record(d, i);
            if (reason == 0) ++accepted;
            else assertTrue(field != 0, "a refusal names its field");
            assertLe(reason, BoxSpecV1.REASON_METADATA_TABLE_MALFORMED, "a reason of the format");
            seen[reason] = true;
            this.replaySpec(i, reason, field, h);
        }
        for (uint256 r; r <= BoxSpecV1.REASON_METADATA_TABLE_MALFORMED; ++r) {
            assertTrue(seen[r], string.concat("reason ", vm.toString(r), " appears"));
        }
        emit log_named_uint("spec vectors", V.SPEC_COUNT);
        emit log_named_uint("accepted by the twin", accepted);
        emit log_named_uint("mismatches", mismatches);
        assertGt(accepted, 400, "a good share of valid specs");
        assertEq(mismatches, 0, "Solidity and TypeScript agree on every vector");
    }

    /// @dev One vector in a fresh frame (memory does not accumulate over 2,400 specs with tables up to 24 KB).
    function replaySpec(uint256 i, uint16 reason, uint16 field, bytes32 h) external {
        (BoxSpecV1.BoxSpec memory s, BoxSpecV1.VersionContext memory ctx) = _buildSpec(i);
        (uint16 r, uint16 f) = BoxSpecV1.validate(s, ctx);
        bytes32 got = BoxSpecV1.specHash(s);
        if (r != reason || f != field || got != h) {
            ++mismatches;
            if (mismatches <= 20) {
                emit log_named_uint("vector", i);
                emit log_named_uint("  twin reason", reason);
                emit log_named_uint("  twin field", field);
                emit log_named_uint("  solidity reason", r);
                emit log_named_uint("  solidity field", f);
                emit log_named_bytes32("  twin hash", h);
                emit log_named_bytes32("  solidity hash", got);
            }
        }
    }

    function _record(bytes memory d, uint256 i) internal pure returns (uint16 reason, uint16 field, bytes32 h) {
        uint256 o = i * 36;
        uint256 w;
        assembly ("memory-safe") {
            w := mload(add(add(d, 0x20), o))
            h := mload(add(add(d, 0x24), o))
        }
        reason = uint16(w >> 240);
        field = uint16(w >> 224);
    }

    // ================================================================================================ layout vectors

    /// P9.6 / P9.7 for the layout: for every raise vector (both token orders) BoxLayoutV1 on the real v4 libraries
    /// gives the twin's curve, both graduated layouts of the full curve and a layout of a partly sold curve, or the same
    /// refusal; the laid-out ones hold exactly the raise with the smallest liquidity.
    function testProperty_AUDIT_U9_twinLayoutsAgree() public {
        bytes memory d = V.layoutData();
        assertEq(d.length, V.LAYOUT_COUNT * V.LAYOUT_RECORD, "record size");
        uint256 laidOut;
        for (uint256 i; i < V.LAYOUT_COUNT; ++i) {
            uint256[] memory rec = new uint256[](30);
            for (uint256 w; w < 30; ++w) {
                uint256 o = i * 960 + w * 32;
                uint256 v;
                assembly ("memory-safe") {
                    v := mload(add(add(d, 0x20), o))
                }
                rec[w] = v;
            }
            if (rec[2] == 0) ++laidOut;
            this.replayLayout(i, rec);
        }
        emit log_named_uint("layout vectors", V.LAYOUT_COUNT);
        emit log_named_uint("laid out", laidOut);
        emit log_named_uint("mismatches", mismatches);
        assertGt(laidOut, 150);
        assertEq(mismatches, 0, "Solidity and TypeScript agree on every raise");
    }

    function replayLayout(uint256 i, uint256[] memory rec) external {
        uint256 raise = rec[0];
        bool tIsC0 = rec[1] == 1;
        uint256[] memory got = new uint256[](30);
        got[0] = raise;
        got[1] = rec[1];
        try this.curveExt(raise, tIsC0) returns (BoxLayoutV1.Curve memory c) {
            got[3] = uint256(int256(c.tickLower));
            got[4] = c.liquidity;
            got[5] = c.curveT;
            uint256[3] memory layouts = [uint256(1), 2, 2];
            uint256[3] memory qHeld = [raise, raise, raise - raise / 7];
            uint256[3] memory tAvail = [c.poolShare, c.poolShare, c.poolShare + c.curveT / 5];
            for (uint256 j; j < 3; ++j) {
                try this.graduatedExt(c, uint8(layouts[j]), qHeld[j], tAvail[j]) returns (
                    BoxLayoutV1.Graduated memory g
                ) {
                    uint256 o = 6 + 8 * j;
                    got[o] = g.bid.liquidity;
                    got[o + 1] = g.bid.amount;
                    got[o + 2] = g.sentinel.liquidity;
                    got[o + 3] = g.sentinel.amount;
                    got[o + 4] = g.ask.liquidity;
                    got[o + 5] = g.ask.amount;
                    got[o + 6] = g.qDust;
                    got[o + 7] = g.tDust;
                } catch (bytes memory e) {
                    got[2] = 10 + _layoutCode(e);
                    for (uint256 w = 3; w < 30; ++w) {
                        got[w] = 0;
                    }
                    break;
                }
            }
            if (got[2] == 0) _checkLaidOut(c, raise, tIsC0);
        } catch (bytes memory e) {
            got[2] = _layoutCode(e);
        }
        for (uint256 w; w < 30; ++w) {
            if (got[w] != rec[w]) {
                ++mismatches;
                if (mismatches <= 20) {
                    emit log_named_uint("layout vector", i);
                    emit log_named_uint("  word", w);
                    emit log_named_uint("  twin", rec[w]);
                    emit log_named_uint("  solidity", got[w]);
                }
                break;
            }
        }
    }

    /// @dev BC-003 on every laid-out vector: the fully crossed curve holds exactly the raise (rounded down, as a
    /// removal pays it), one unit of liquidity less holds less, the split sums to the issuance, ticks on the spacing.
    function _checkLaidOut(BoxLayoutV1.Curve memory c, uint256 raise, bool tIsC0) internal pure {
        assertEq(c.tickUpper - c.tickLower, 26_880);
        assertEq(c.tickLower % 60, 0);
        assertEq(c.curveT + c.poolShare, 1e27);
        assertEq(_qHeld(c, c.liquidity, tIsC0), raise, "holds exactly the raise");
        assertLt(_qHeld(c, c.liquidity - 1, tIsC0), raise, "the smallest such liquidity");
    }

    function _qHeld(BoxLayoutV1.Curve memory c, uint128 l, bool tIsC0) internal pure returns (uint256) {
        return tIsC0
            ? SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, false)
            : SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, false);
    }

    function curveExt(uint256 raise, bool tIsC0) external pure returns (BoxLayoutV1.Curve memory) {
        return BoxLayoutV1.curve(raise, tIsC0);
    }

    function graduatedExt(BoxLayoutV1.Curve memory c, uint8 layout, uint256 qHeld, uint256 tAvailable)
        external
        pure
        returns (BoxLayoutV1.Graduated memory)
    {
        return BoxLayoutV1.graduated(c, layout, qHeld, tAvailable);
    }

    /// @dev The generator's error codes: 1 RaiseIsZero, 2 an arithmetic refusal (FullMath / LiquidityAmounts: empty
    /// revert data), 3 CentreOutOfRange, 4 CurveOutOfRange, 5 NoExactLiquidity, 6 CurveTooLarge, 8/9 TickMath.
    function _layoutCode(bytes memory e) internal pure returns (uint256) {
        if (e.length == 0) return 2;
        bytes4 sel = bytes4(e);
        if (sel == BoxLayoutV1.RaiseIsZero.selector) return 1;
        if (sel == BoxLayoutV1.CentreOutOfRange.selector) return 3;
        if (sel == BoxLayoutV1.CurveOutOfRange.selector) return 4;
        if (sel == BoxLayoutV1.NoExactLiquidity.selector) return 5;
        if (sel == BoxLayoutV1.CurveTooLarge.selector) return 6;
        if (sel == bytes4(keccak256("InvalidSqrtPrice(uint160)"))) return 8;
        if (sel == bytes4(keccak256("InvalidTick(int24)"))) return 9;
        // Panic(uint256) (an overflow in checked arithmetic) counts as the arithmetic refusal too.
        if (sel == bytes4(0x4e487b71)) return 2;
        return 99;
    }

    // ================================================================================================ the mirror

    /// @dev The one source of randomness: keccak256(abi.encode(a, b)) (the generator's `W` / `sub`).
    function _w(uint256 a, uint256 b) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(a, b)));
    }

    /// @dev `buildSpec(seed)` of the generator: the base, then `m` mutations of target fields, each from one word.
    function _buildSpec(uint256 seed)
        internal
        pure
        returns (BoxSpecV1.BoxSpec memory s, BoxSpecV1.VersionContext memory ctx)
    {
        uint256 k;
        uint256 r = _w(seed, k++);
        uint256[12] memory mPick = [uint256(0), 1, 1, 1, 1, 2, 2, 2, 3, 4, 6, 10];
        uint256[12] memory basePick = [uint256(0), 0, 0, 0, 1, 1, 2, 2, 3, 0, 1, 2];
        uint256 m = mPick[r % 12];
        uint256 baseIndex = basePick[(r >> 8) % 12];
        s = abi.decode(V.base(baseIndex), (BoxSpecV1.BoxSpec));
        ctx = baseIndex == 0 ? BoxSpecV1.contextV1() : BoxSpecV1.contextV2();
        if ((r >> 16) % 8 == 0) ctx = _context(_w(r, 7));
        for (uint256 j; j < m; ++j) {
            uint256 x = _w(seed, k++);
            uint256 t = _target(x % 44);
            if (t == 34) ctx = _context(_w(x, 1));
            else _mutate(s, t, x);
        }
    }

    function _target(uint256 i) internal pure returns (uint256) {
        if (i < 36) return i;
        uint256[8] memory extra = [uint256(16), 17, 25, 26, 15, 0, 18, 24];
        return extra[i - 36];
    }

    function _mutate(BoxSpecV1.BoxSpec memory s, uint256 t, uint256 x) internal pure {
        uint256 len = s.addOns.length;
        uint256 i = len == 0 ? 0 : (x >> 8) % len;
        if (t == 0) {
            s.version = uint16([uint256(0), 1, 2, 3, 255, 65535][x % 6]);
        } else if (t == 1) {
            s.boxType = uint8([uint256(0), 1, 2, 3, 4, 255][x % 6]);
        } else if (t == 2) {
            s.tokenName = string(_text(_w(x, 1), _lenA2((x >> 8) % 8), 10));
        } else if (t == 3) {
            s.tokenSymbol = string(_text(_w(x, 1), _lenB2((x >> 8) % 8), 10));
        } else if (t == 4) {
            s.collectionName = string(_text(_w(x, 1), _lenA2((x >> 8) % 8), 10));
        } else if (t == 5) {
            s.collectionSymbol = string(_text(_w(x, 1), _lenB2((x >> 8) % 8), 10));
        } else if (t == 6) {
            s.description = string(_text(_w(x, 1), _lenC2((x >> 8) % 8), 5));
        } else if (t == 7) {
            s.n = _n(x);
        } else if (t == 8) {
            s.firstId = [uint256(0), 1, 2, type(uint256).max, x >> 8][x % 5];
        } else if (t == 9) {
            s.q = _q(x);
        } else if (t == 10) {
            s.raise = _raise(x);
        } else if (t == 11) {
            s.layout = uint8([uint256(0), 1, 2, 255][x % 4]);
        } else if (t == 12) {
            s.gradLayout = uint8([uint256(0), 1, 2, 3, 255][x % 5]);
        } else if (t == 13) {
            s.launchFormat = uint8([uint256(0), 1, 2, 255][x % 4]);
        } else if (t == 14) {
            s.openAt = uint32(
                [
                    uint256(0),
                    MIN_OPEN_AT - 1,
                    MIN_OPEN_AT,
                    MIN_OPEN_AT + 1,
                    1_791_284_400,
                    4_294_967_295,
                    (x >> 8) & 0xffffffff
                ][x % 7]
            );
        } else if (t == 15) {
            s.deadlineDays =
                uint16([uint256(0), 30, 60, 90, 180, 1, 29, 31, 179, 181, 65535, (x >> 8) & 0xffff][x % 12]);
        } else if (t == 16) {
            s.qStream = uint8([uint256(0), 1, 2, 3, 4, 5, 6, 7, 8, 255][x % 10]);
        } else if (t == 17) {
            s.tStream = uint8([uint256(0), 1, 2, 3, 4, 5, 6, 7, 8, 255][x % 10]);
        } else if (t == 18) {
            s.artMode = uint8([uint256(0), 1, 2, 3, 255][x % 5]);
        } else if (t == 19) {
            s.revealRoot = _h(x);
        } else if (t == 20) {
            s.metadataTable = _table(_w(x, 1));
        } else if (t == 21) {
            s.generatorHash = _h(x);
        } else if (t == 22) {
            s.coverSha256 = _h(x);
        } else if (t == 23) {
            s.revealListId = _h(x);
        } else if (t == 24) {
            s.marketplaceOwner = [address(0), _addr(_w(x, 1)), SAFE][x % 3];
        } else if (t == 25) {
            s.creatorFeeRecipient = x % 2 == 0 ? address(0) : _addr(_w(x, 1));
        } else if (t == 26) {
            s.creatorBuy = [uint256(0), 1, R - 1, R, R + 1, x >> 8][x % 6];
        } else if (t == 27) {
            s.collectionCoverSha256 = _h(x);
        } else if (t == 28) {
            s.addOns = _addOnList(_w(x, 1));
        } else if (t == 29) {
            if (len != 0) s.addOns[i].params = _mutateParams(s.addOns[i].params, _w(x, 1));
        } else if (t == 30) {
            if (len != 0) s.addOns[i].params = _paramsFor(s.addOns[i].id, _w(x, 1));
        } else if (t == 31) {
            if (len != 0) s.addOns = _remove(s.addOns, i);
        } else if (t == 32) {
            if (len != 0 && len < 12) s.addOns = _duplicate(s.addOns, i);
        } else if (t == 33) {
            if (len >= 2) {
                uint256 j2 = (x >> 16) % len;
                BoxSpecV1.AddOn memory tmp = s.addOns[i];
                s.addOns[i] = s.addOns[j2];
                s.addOns[j2] = tmp;
            }
        } else if (t == 35) {
            if (len != 0) s.addOns[i].id = _id((x >> 16) % 12);
        }
    }

    function _h(uint256 x) internal pure returns (bytes32) {
        return x % 2 == 0 ? bytes32(0) : bytes32(_w(x, 1));
    }

    function _addr(uint256 v) internal pure returns (address) {
        return address(uint160(v));
    }

    function _n(uint256 x) internal pure returns (uint32) {
        uint256[14] memory ns = [
            uint256(0), 1, 9, 10, 11, 100, 1969, 4269, 9999, 10000, 10001, 65535, 4_294_967_295, (x >> 16) & 0xffffffff
        ];
        return uint32(ns[x % 14]);
    }

    function _q(uint256 x) internal pure returns (address) {
        address[7] memory qs = [address(0), _addr(_w(x, 1)), Q18, Q6, QFIT, QBOX, address(1)];
        return qs[x % 7];
    }

    function _raise(uint256 x) internal pure returns (uint256) {
        uint256 v = x % 16;
        if (v == 14) return x >> 8;
        uint256[16] memory raises = [
            R,
            R + 1,
            R - 1,
            0,
            R / 10,
            1e18,
            4.2e18,
            10e18,
            2500e18,
            10000e18,
            2_500_000_000,
            1e24,
            1e25,
            5e25,
            0,
            type(uint256).max
        ];
        return raises[v];
    }

    function _lenA2(uint256 i) internal pure returns (uint256) {
        return [uint256(0), 1, 2, 16, 31, 32, 33, 64][i];
    }

    function _lenB2(uint256 i) internal pure returns (uint256) {
        return [uint256(0), 1, 5, 10, 11, 12, 32, 3][i];
    }

    function _lenC2(uint256 i) internal pure returns (uint256) {
        return [uint256(0), 1, 100, 1023, 1024, 1025, 2000, 50][i];
    }

    function _lenA(uint256 i) internal pure returns (uint256) {
        return [uint256(1), 1, 5, 18, 32, 33, 0, 64][i];
    }

    function _lenB(uint256 i) internal pure returns (uint256) {
        return [uint256(1), 3, 8, 11, 12, 0, 32, 5][i];
    }

    function _lenC(uint256 i) internal pure returns (uint256) {
        return [uint256(0), 0, 10, 100, 1024, 1025, 2000, 1][i];
    }

    function _lenD(uint256 i) internal pure returns (uint256) {
        return [uint256(1), 1, 243, 1000, 4096, 4097, 0, 100][i];
    }

    function _lenUrl(uint256 i) internal pure returns (uint256) {
        return [uint256(0), 0, 20, 128, 129, 8, 7, 60][i];
    }

    function _id(uint256 i) internal pure returns (uint16) {
        return uint16([uint256(1), 2, 3, 4, 5, 6, 3, 3, 0, 7, 300, 65535][i]);
    }

    // ------------------------------------------------------------------------------------------------ bytes and texts

    /// @dev `bytesOf`: byte j is byte (j % 32) of keccak256(abi.encode(r, j / 32)).
    function _bytesOf(uint256 r, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 c; c * 32 < n; ++c) {
            bytes32 w = keccak256(abi.encode(r, c));
            uint256 take = n - c * 32 < 32 ? n - c * 32 : 32;
            for (uint256 j; j < take; ++j) {
                out[c * 32 + j] = w[j];
            }
        }
    }

    function _dirty(uint256 i) internal pure returns (bytes1) {
        bytes memory d = hex"00090a1f225c7f80c3a9ff0d";
        return d[i];
    }

    /// @dev `text`: JSON_TEXT-ish bytes with a `dirtyPct` % chance of a refused byte per position.
    function _text(uint256 r, uint256 n, uint256 dirtyPct) internal pure returns (bytes memory out) {
        bytes memory b = _bytesOf(r, 2 * n);
        out = new bytes(n);
        for (uint256 j; j < n; ++j) {
            uint256 b0 = uint8(b[2 * j]);
            uint256 b1 = uint8(b[2 * j + 1]);
            if (b0 % 100 < dirtyPct) {
                out[j] = _dirty(b1 % 12);
            } else {
                uint256 c = 0x20 + (b1 % 95);
                if (c == 0x22 || c == 0x5c) c = 0x41;
                out[j] = bytes1(uint8(c));
            }
        }
    }

    function _svgText(uint256 r, uint256 n, uint256 dirtyPct) internal pure returns (bytes memory out) {
        bytes memory d = hex"001f7f80ff0ac309";
        bytes memory b = _bytesOf(r, 2 * n);
        out = new bytes(n);
        for (uint256 j; j < n; ++j) {
            uint256 b0 = uint8(b[2 * j]);
            uint256 b1 = uint8(b[2 * j + 1]);
            out[j] = b0 % 100 < dirtyPct ? d[b1 % 8] : bytes1(uint8(0x20 + (b1 % 95)));
        }
    }

    function _urlPrefix(uint256 v) internal pure returns (bytes memory) {
        if (v <= 5) return "https://";
        if (v == 6) return "http://";
        if (v == 7) return "";
        if (v == 8) return "HTTPS://";
        return "https:/";
    }

    function _url(uint256 r, uint256 n, uint256 dirtyPct) internal pure returns (bytes memory out) {
        bytes memory prefix = _urlPrefix((r >> 200) % 10);
        out = new bytes(n);
        uint256 start;
        if (n >= prefix.length) {
            for (uint256 j; j < prefix.length; ++j) {
                out[j] = prefix[j];
            }
            start = prefix.length;
        }
        bytes memory b = _bytesOf(r, 2 * n);
        bytes memory chars = URL_CHARS;
        for (uint256 j = start; j < n; ++j) {
            uint256 b0 = uint8(b[2 * j]);
            uint256 b1 = uint8(b[2 * j + 1]);
            out[j] = b0 % 100 < dirtyPct ? _dirty(b1 % 12) : chars[b1 % 85];
        }
    }

    // ------------------------------------------------------------------------------------------------ tables

    function _table(uint256 x) internal pure returns (bytes memory t) {
        uint256 v = x % 16;
        if (v == 0) return "";
        if (v == 1) return hex"01";
        if (v == 2) return hex"01000000";
        if (v == 3) return hex"00000000";
        if (v == 12 || v == 13) {
            uint256 len = v == 12 ? 24_575 : 24_576;
            uint256 dl = len - 4;
            t = new bytes(len);
            t[0] = 0x01;
            t[1] = bytes1(uint8(dl >> 8));
            t[2] = bytes1(uint8(dl & 0xff));
            for (uint256 j; j < dl; ++j) {
                t[3 + j] = 0x41;
            }
            return t;
        }
        if (v == 14) {
            t = hex"01000010";
            for (uint256 j; j < 16; ++j) {
                t = bytes.concat(
                    t, bytes1(0x01), bytes1(uint8(0x41 + j)), bytes1(0x01), bytes1(0x01), bytes1(uint8(0x61 + j))
                );
            }
            return t;
        }
        if (v == 15) return hex"01ffff4141";
        uint256 descLen = [uint256(0), 1, 40, 200, 1000, 3000][(x >> 8) % 6];
        uint256 types = (x >> 16) % 18;
        t = bytes.concat(
            bytes1(0x01),
            bytes1(uint8(descLen >> 8)),
            bytes1(uint8(descLen & 0xff)),
            _text(_w(x, 1), descLen, 2),
            bytes1(uint8(types))
        );
        for (uint256 i; i < types; ++i) {
            uint256 ri = _w(x, 100 + i);
            uint256 nameLen = (ri >> 8) % 20 == 0 ? 0 : 1 + ri % 30;
            uint256 values = (ri >> 24) % 25 == 0 ? 0 : 1 + (ri >> 16) % 8;
            t = bytes.concat(t, bytes1(uint8(nameLen)), _text(_w(ri, 1), nameLen, 2), bytes1(uint8(values)));
            for (uint256 kk; kk < values; ++kk) {
                uint256 rv = _w(ri, 10 + kk);
                uint256 valueLen = (rv >> 8) % 25 == 0 ? 0 : 1 + rv % 40;
                t = bytes.concat(t, bytes1(uint8(valueLen)), _text(_w(rv, 1), valueLen, 2));
            }
        }
        uint256 mm = (x >> 24) % 8;
        if (mm == 5 && t.length > 0) t[(x >> 32) % t.length] = bytes1(uint8((x >> 40) & 0xff));
        else if (mm == 6 && t.length > 0) t = _truncate(t);
        else if (mm == 7) t = bytes.concat(t, bytes1(uint8((x >> 32) & 0xff)));
    }

    function _truncate(bytes memory p) internal pure returns (bytes memory) {
        assembly ("memory-safe") {
            mstore(p, sub(mload(p), 1))
        }
        return p;
    }

    // ------------------------------------------------------------------------------------------------ add-ons

    function _paramsFor(uint16 id, uint256 x) internal pure returns (bytes memory) {
        if (id == 1) {
            return abi.encode(
                _text(_w(x, 1), _lenA(x % 8), 5),
                _text(_w(x, 2), _lenB((x >> 8) % 8), 5),
                _text(_w(x, 3), _lenC((x >> 16) % 8), 3),
                _text(_w(x, 4), _lenC((x >> 24) % 8), 3),
                _svgText(_w(x, 5), _lenD((x >> 32) % 8), 3)
            );
        }
        if (id == 2) return x % 8 == 0 ? bytes(hex"00") : bytes("");
        if (id == 3) {
            uint256[9] memory counts = [uint256(1), 1, 10, 100, 4269, 0, 10000, 10001, 4_294_967_295];
            return abi.encode(_text(_w(x, 1), _lenA(x % 8), 5), uint32(counts[(x >> 8) % 9]));
        }
        if (id == 4) {
            uint256[9] memory bps = [uint256(0), 100, 250, 500, 1, 99, 101, 1000, 65535];
            uint256[7] memory dest = [uint256(1), 1, 2, 3, 0, 4, 255];
            return abi.encode(uint16(bps[x % 9]), uint8(dest[(x >> 8) % 7]));
        }
        if (id == 5) {
            uint256[9] memory caps = [1e18, 4e18, 8e18, 16e18, 32e18, 0, 1, 2e18, type(uint256).max];
            uint256[6] memory excess = [uint256(2), 3, 1, 0, 4, 255];
            return abi.encode(caps[x % 9], uint8(excess[(x >> 8) % 6]));
        }
        if (id == 6) {
            uint256 count = [uint256(0), 0, 1, 4, 5, 2][(x >> 8) % 6];
            bytes32[] memory teasers = new bytes32[](count);
            for (uint256 i; i < count; ++i) {
                teasers[i] = (x >> 16) % 8 == 0 && i == 0 ? bytes32(0) : bytes32(_w(x, 10 + i));
            }
            bytes32 banner = x % 4 == 0 ? bytes32(0) : bytes32(_w(x, 1));
            return abi.encode(banner, teasers, _url(_w(x, 2), _lenUrl((x >> 24) % 8), 3));
        }
        return _bytesOf(_w(x, 1), (x >> 8) % 70);
    }

    function _mutateParams(bytes memory p, uint256 x) internal pure returns (bytes memory) {
        uint256 m = x % 12;
        uint256 len = p.length;
        if (m == 6 && len > 0) return _truncate(p);
        if (m == 7) return bytes.concat(p, bytes1(uint8((x >> 8) & 0xff)));
        if (m == 8 && len > 0) {
            p[(x >> 8) % len] = bytes1(uint8((x >> 16) & 0xff));
            return p;
        }
        if (m == 9 && len >= 32) {
            uint256 v = (x >> 8) % 300;
            assembly ("memory-safe") {
                mstore(add(p, 0x20), v)
            }
            return p;
        }
        if (m == 10) return bytes.concat(new bytes(32), p);
        if (m == 11) return _bytesOf(_w(x, 1), (x >> 8) % 70);
        return p;
    }

    function _addOnList(uint256 x) internal pure returns (BoxSpecV1.AddOn[] memory list) {
        uint256 count = [uint256(0), 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2][x % 12];
        list = new BoxSpecV1.AddOn[](count);
        for (uint256 i; i < count; ++i) {
            uint256 xi = _w(x, 1 + i);
            uint16 id = _id(xi % 12);
            list[i] = BoxSpecV1.AddOn({id: id, params: _mutateParams(_paramsFor(id, _w(xi, 1)), _w(xi, 2))});
        }
        if ((x >> 8) % 4 != 0) {
            for (uint256 i = 1; i < count; ++i) {
                for (uint256 j = i; j > 0 && list[j - 1].id > list[j].id; --j) {
                    BoxSpecV1.AddOn memory tmp = list[j - 1];
                    list[j - 1] = list[j];
                    list[j] = tmp;
                }
            }
        }
    }

    function _remove(BoxSpecV1.AddOn[] memory a, uint256 i) internal pure returns (BoxSpecV1.AddOn[] memory out) {
        out = new BoxSpecV1.AddOn[](a.length - 1);
        uint256 o;
        for (uint256 j; j < a.length; ++j) {
            if (j != i) out[o++] = a[j];
        }
    }

    function _duplicate(BoxSpecV1.AddOn[] memory a, uint256 i) internal pure returns (BoxSpecV1.AddOn[] memory out) {
        out = new BoxSpecV1.AddOn[](a.length + 1);
        uint256 o;
        for (uint256 j; j < a.length; ++j) {
            out[o++] = a[j];
            if (j == i) out[o++] = BoxSpecV1.AddOn({id: a[j].id, params: a[j].params});
        }
    }

    // ------------------------------------------------------------------------------------------------ contexts

    function _context(uint256 x) internal pure returns (BoxSpecV1.VersionContext memory ctx) {
        uint256 v = x % 8;
        if (v <= 2) return BoxSpecV1.contextV1();
        if (v <= 4) return BoxSpecV1.contextV2();
        if (v == 5) return _testContext();
        if (v == 7) {
            ctx = BoxSpecV1.contextV1();
            ctx.gradLayouts = new uint8[](0);
            return ctx;
        }
        uint256 n = 1 + _w(x, 1) % 3;
        ctx.qList = new BoxSpecV1.QAsset[](n);
        for (uint256 i; i < n; ++i) {
            uint256 xi = _w(x, 10 + i);
            uint256 presetCount = (xi >> 32) % 4;
            uint256[] memory presets = new uint256[](presetCount);
            for (uint256 j; j < presetCount; ++j) {
                presets[j] = [R, R / 10, 1e18, 2_500_000_000, 0][_w(xi, 20 + j) % 5];
            }
            ctx.qList[i] = BoxSpecV1.QAsset({
                token: [address(0), _addr(xi >> 8), Q18, Q6][xi % 4],
                decimals: uint8((xi >> 16) % 19),
                qClass: uint8([uint256(1), 2, 3, 4, 0, 5][(xi >> 24) % 6]),
                raisePresets: presets
            });
        }
        ctx.gradLayouts = _gradList((x >> 8) % 6);
    }

    function _gradList(uint256 i) internal pure returns (uint8[] memory g) {
        if (i == 0) {
            g = new uint8[](1);
            g[0] = 2;
        } else if (i == 1) {
            g = new uint8[](1);
            g[0] = 1;
        } else if (i == 2) {
            g = new uint8[](0);
        } else if (i == 3) {
            g = new uint8[](2);
            g[0] = 1;
            g[1] = 2;
        } else if (i == 4) {
            g = new uint8[](2);
            g[0] = 2;
            g[1] = 3;
        } else {
            g = new uint8[](1);
            g[0] = 3;
        }
    }

    /// @dev cases.v1.json's "test" context: one Q per class.
    function _testContext() internal pure returns (BoxSpecV1.VersionContext memory ctx) {
        ctx.qList = new BoxSpecV1.QAsset[](5);
        uint256[] memory p0 = new uint256[](4);
        (p0[0], p0[1], p0[2], p0[3]) = (1e18, 4.2e18, R, 10e18);
        ctx.qList[0] = BoxSpecV1.QAsset({token: address(0), decimals: 18, qClass: 1, raisePresets: p0});
        uint256[] memory p1 = new uint256[](3);
        (p1[0], p1[1], p1[2]) = (2500e18, 10000e18, 25000e18);
        ctx.qList[1] = BoxSpecV1.QAsset({token: Q18, decimals: 18, qClass: 2, raisePresets: p1});
        uint256[] memory p2 = new uint256[](3);
        (p2[0], p2[1], p2[2]) = (2_500_000_000, 10_000_000_000, 25_000_000_000);
        ctx.qList[2] = BoxSpecV1.QAsset({token: Q6, decimals: 6, qClass: 2, raisePresets: p2});
        uint256[] memory p3 = new uint256[](3);
        (p3[0], p3[1], p3[2]) = (1e24, 1e25, 5e25);
        ctx.qList[3] = BoxSpecV1.QAsset({token: QFIT, decimals: 18, qClass: 3, raisePresets: p3});
        uint256[] memory p4 = new uint256[](3);
        (p4[0], p4[1], p4[2]) = (1e24, 1e25, 5e25);
        ctx.qList[4] = BoxSpecV1.QAsset({token: QBOX, decimals: 18, qClass: 4, raisePresets: p4});
        ctx.gradLayouts = new uint8[](1);
        ctx.gradLayouts[0] = 2;
    }
}
