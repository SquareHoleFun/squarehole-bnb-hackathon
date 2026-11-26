// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";

/// @notice TEST ONLY: the handler. It keeps one spec (box 0's fixture to start) and one version context in storage,
/// edits one field per action (every value the fuzzer sends is accepted as it is, so the spec roams far outside the
/// menu), then runs validate() and specHash() and books what must never happen in ghost counters; the layout action
/// lays out a random raise in a random order. Every action completes (`fail_on_revert` is on), so validate() never
/// reverting is itself under test.
contract AuditU9FableSpecHandler is Test {
    uint256 internal constant R = 4_206_980_085_000_000_000;

    // The spec, field by field (an AddOn[] cannot be copied to storage as a struct array).
    uint16 internal version;
    uint8 internal boxType;
    bytes internal tokenName;
    bytes internal tokenSymbol;
    bytes internal collectionName;
    bytes internal collectionSymbol;
    bytes internal description;
    uint32 internal n;
    uint256 internal firstId;
    address internal q;
    uint256 internal raise;
    uint8 internal layout;
    uint8 internal gradLayout;
    uint8 internal launchFormat;
    uint32 internal openAt;
    uint16 internal deadlineDays;
    uint8 internal qStream;
    uint8 internal tStream;
    uint8 internal artMode;
    bytes32 internal revealRoot;
    bytes internal metadataTable;
    bytes32 internal generatorHash;
    bytes32 internal coverSha256;
    bytes32 internal revealListId;
    address internal marketplaceOwner;
    address internal creatorFeeRecipient;
    uint256 internal creatorBuy;
    bytes32 internal collectionCoverSha256;
    uint16[] internal addOnIds;
    bytes[] internal addOnParams;
    /// @dev 0 v1, 1 v2, 2 v1 without a graduated layout.
    uint8 internal ctxKind;

    // Ghosts (what must never happen stays zero).
    uint256 public calls;
    uint256 public okCount;
    /// @dev Accepted specs whose encoding is neither fixture's: the valid states the handler reached by itself.
    uint256 public okChanged;
    uint256 public refusedCount;
    uint256 public reasonOutOfFormat;
    uint256 public okWithField;
    uint256 public refusalWithoutField;
    uint256 public hashNotEncodingHash;
    uint256 public okOutsideTheMenu;
    uint256 public okWithUnsafeText;
    uint256 public okWithRefusedTable;
    uint256 public okWithBadAddOns;
    uint256 public okAgainstARule;
    uint256 public hashUnchangedByAChange;
    uint256 public layoutCalls;
    uint256 public layoutRaiseMismatch;
    uint256 public layoutNotSmallest;
    uint256 public layoutSupplyMismatch;
    uint256 public layoutQNotPlaced;
    uint256 public layoutTNotPlaced;
    uint256 public layoutAskNotMaximal;
    uint256 public layoutBidOverAsk;
    bytes32 public lastHash;
    bytes32 public lastEncodingHash;
    uint16 public lastReason;
    uint16 public lastField;

    bytes internal fixtureV1;
    bytes internal fixtureV2;

    constructor(bytes memory v1, bytes memory v2) {
        fixtureV1 = v1;
        fixtureV2 = v2;
        _load(v1);
    }

    // ------------------------------------------------------------------------------------------------ actions

    /// @dev Every setter takes the fuzzer's value as it is one time in four (`raw`), else a value of the menu, so the
    /// spec keeps returning to accepted states and the accepted-spec ghosts see many different valid specs.
    function _raw(uint256 v) internal pure returns (bool) {
        return uint256(keccak256(abi.encode(v))) % 4 == 0;
    }

    function setVersion(uint16 v) external {
        version = _raw(v) ? v : uint16(1 + v % 2);
        _check();
    }

    function setBoxType(uint8 v) external {
        boxType = _raw(v) ? v : uint8([uint256(1), 1, 1, 3][v % 4]);
        _check();
    }

    function setEnum(uint8 which, uint8 v) external {
        uint8 w = which % 6;
        bool raw = _raw(v);
        if (w == 0) layout = raw ? v : 1;
        else if (w == 1) gradLayout = raw ? v : 2;
        else if (w == 2) launchFormat = raw ? v : 1;
        else if (w == 3) qStream = raw ? v : uint8([uint256(1), 2, 3, 5, 6][v % 5]);
        else if (w == 4) tStream = raw ? v : uint8([uint256(1), 3, 4, 5, 6][v % 5]);
        else artMode = raw ? v : uint8(1 + v % 2);
        _check();
    }

    function setText(uint8 which, bytes memory b) external {
        uint8 w = which % 5;
        uint256 max = w == 4 ? 1024 : (w == 1 || w == 3) ? 11 : 32;
        if (!_raw(b.length)) {
            // A menu text: within the bound, at least a byte for a name, every byte from the allowed set.
            if (b.length > max) {
                assembly ("memory-safe") {
                    mstore(b, max)
                }
            }
            if (b.length == 0 && w != 4) b = "A";
            for (uint256 i; i < b.length; ++i) {
                uint8 c = 0x20 + uint8(b[i]) % 95;
                if (c == 0x22 || c == 0x5c) c = 0x41;
                b[i] = bytes1(c);
            }
        } else if (b.length > 1100) {
            assembly ("memory-safe") {
                mstore(b, 1100)
            }
        }
        if (w == 0) tokenName = b;
        else if (w == 1) tokenSymbol = b;
        else if (w == 2) collectionName = b;
        else if (w == 3) collectionSymbol = b;
        else description = b;
        _check();
    }

    function setN(uint32 v) external {
        n = _raw(v) ? v : uint32(10 + v % 9_991);
        _check();
    }

    function setFirstId(uint256 v) external {
        firstId = _raw(v) ? v : 1;
        _check();
    }

    function setQ(address v) external {
        q = _raw(uint160(v)) ? v : address(0);
        _check();
    }

    function setRaise(uint256 v) external {
        raise = _raw(v) ? v : R;
        _check();
    }

    function setOpenAt(uint32 v) external {
        openAt = _raw(v) ? v : (v % 2 == 0 ? 0 : uint32(BoxSpecV1.MIN_OPEN_AT + v % 1_000_000));
        _check();
    }

    function setDeadline(uint16 v) external {
        deadlineDays = _raw(v) ? v : uint16([uint256(0), 30, 60, 90, 180][v % 5]);
        _check();
    }

    function setWord(uint8 which, bytes32 v) external {
        uint8 w = which % 5;
        if (w == 0) revealRoot = v;
        else if (w == 1) generatorHash = v;
        else if (w == 2) coverSha256 = v;
        else if (w == 3) revealListId = _raw(uint256(v)) ? v : bytes32(0);
        else collectionCoverSha256 = v;
        _check();
    }

    function setAddress(uint8 which, address v) external {
        if (which % 2 == 0) marketplaceOwner = _raw(uint160(v)) || v != address(0) ? v : address(1);
        else creatorFeeRecipient = _raw(uint160(v)) ? v : address(0);
        _check();
    }

    function setCreatorBuy(uint256 v) external {
        creatorBuy = _raw(v) ? v : 0;
        _check();
    }

    /// @dev mode 0: a structured table (maybe malformed) up to about 700 bytes; 1: raw bytes; 2: the minimal table.
    function setTable(uint256 seed, uint8 mode, bytes memory raw) external {
        uint8 m = mode % 3;
        if (m == 0) {
            metadataTable = _structuredTable(seed);
        } else if (m == 1) {
            if (raw.length > 600) {
                assembly ("memory-safe") {
                    mstore(raw, 600)
                }
            }
            metadataTable = raw;
        } else {
            metadataTable = hex"01000000";
        }
        _check();
    }

    function pushAddOn(uint8 idPick, uint256 seed) external {
        if (addOnIds.length >= 9) return _check();
        uint16 id = uint16([uint256(1), 2, 3, 4, 5, 6, 3, 0, 7, 65535][idPick % 10]);
        addOnIds.push(id);
        addOnParams.push(_params(id, seed));
        _check();
    }

    function popAddOn() external {
        if (addOnIds.length != 0) {
            addOnIds.pop();
            addOnParams.pop();
        }
        _check();
    }

    function swapAddOns(uint8 i, uint8 j) external {
        uint256 len = addOnIds.length;
        if (len >= 2) {
            uint256 a = i % len;
            uint256 b = j % len;
            (addOnIds[a], addOnIds[b]) = (addOnIds[b], addOnIds[a]);
            bytes memory tmp = addOnParams[a];
            addOnParams[a] = addOnParams[b];
            addOnParams[b] = tmp;
        }
        _check();
    }

    function mutateParams(uint8 i, uint16 at, uint8 value, uint8 mode) external {
        uint256 len = addOnIds.length;
        if (len != 0) {
            uint256 k = i % len;
            bytes memory p = addOnParams[k];
            uint8 m = mode % 4;
            if (m == 0 && p.length != 0) {
                p[at % p.length] = bytes1(value);
            } else if (m == 1 && p.length != 0) {
                assembly ("memory-safe") {
                    mstore(p, sub(mload(p), 1))
                }
            } else if (m == 2) {
                p = bytes.concat(p, bytes1(value));
            } else {
                p = _params(addOnIds[k], uint256(keccak256(abi.encode(at, value))));
            }
            addOnParams[k] = p;
        }
        _check();
    }

    function setContext(uint8 kind) external {
        ctxKind = kind % 3;
        _check();
    }

    /// @dev Back to box 0's fixture (version 1) or the demo placeholders box (version 2).
    function resetToFixture(uint8 which) external {
        _load(which % 2 == 0 ? fixtureV1 : fixtureV2);
        _check();
    }

    /// @dev Called once after deployment (the first check makes an external self-call, so it cannot run in the
    /// constructor).
    function start() external {
        _check();
    }

    /// @dev Lays out a raise in the feasible band and books the BC-003 properties and the graduated layout's.
    function layoutRaise(uint256 raiseSeed, bool tIsC0, uint256 qSeed, uint256 tSeed) external {
        uint256 r = bound(raiseSeed, 1e8, 1e26);
        ++layoutCalls;
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(r, tIsC0);
        uint256 held = _q(c, c.liquidity, false);
        if (held != r) ++layoutRaiseMismatch;
        if (_q(c, c.liquidity - 1, false) >= r) ++layoutNotSmallest;
        if (c.curveT + c.poolShare != BoxSpecV1.ISSUANCE) ++layoutSupplyMismatch;
        uint256 qHeld = bound(qSeed, r / 2, r);
        uint256 tAvail = c.poolShare + bound(tSeed, 0, c.curveT);
        int24 tEdge = tIsC0 ? BoxSpecV1.MAX_USABLE_TICK : BoxSpecV1.MIN_USABLE_TICK;
        uint160 sqrtTEdge = TickMath.getSqrtPriceAtTick(tEdge);
        for (uint8 g = 1; g <= 2; ++g) {
            BoxLayoutV1.Graduated memory gr = BoxLayoutV1.graduated(c, g, qHeld, tAvail);
            if (gr.bid.amount + gr.sentinel.amount + gr.qDust != qHeld) ++layoutQNotPlaced;
            if (gr.ask.amount + gr.tDust != tAvail) ++layoutTNotPlaced;
            uint256 oneMore = tIsC0
                ? SqrtPriceMath.getAmount0Delta(sqrtTEdge, c.sqrtPriceEndX96, gr.ask.liquidity + 1, true)
                : SqrtPriceMath.getAmount1Delta(sqrtTEdge, c.sqrtPriceEndX96, gr.ask.liquidity + 1, true);
            if (oneMore <= tAvail) ++layoutAskNotMaximal;
            if (g == 2 && gr.bid.liquidity > gr.ask.liquidity) ++layoutBidOverAsk;
        }
    }

    // ------------------------------------------------------------------------------------------------ the check

    function _check() internal {
        ++calls;
        BoxSpecV1.BoxSpec memory s = _mem();
        BoxSpecV1.VersionContext memory ctx = _ctx();
        (uint16 reason, uint16 field) = BoxSpecV1.validate(s, ctx);
        bytes32 h = BoxSpecV1.specHash(s);
        bytes32 eh = keccak256(abi.encode(s));
        if (reason > BoxSpecV1.REASON_METADATA_TABLE_MALFORMED) ++reasonOutOfFormat;
        if (reason == BoxSpecV1.REASON_OK && field != 0) ++okWithField;
        if (reason != BoxSpecV1.REASON_OK && field == 0) ++refusalWithoutField;
        if (h != eh) ++hashNotEncodingHash;
        if (eh != lastEncodingHash && h == lastHash && calls > 1) ++hashUnchangedByAChange;
        if (reason == BoxSpecV1.REASON_OK) {
            ++okCount;
            if (eh != keccak256(fixtureV1) && eh != keccak256(fixtureV2)) ++okChanged;
            _bookAccepted(s, ctx);
        } else {
            ++refusedCount;
        }
        lastHash = h;
        lastEncodingHash = eh;
        lastReason = reason;
        lastField = field;
    }

    /// @dev What an accepted spec must satisfy (the menu, BC-008, BC-014, BC-072, BC-127; the add-on rules; the
    /// rules of `_checkRules`), checked independently of validate()'s own code paths.
    function _bookAccepted(BoxSpecV1.BoxSpec memory s, BoxSpecV1.VersionContext memory ctx) internal {
        bool tokenOnly = s.boxType == BoxSpecV1.BOX_TYPE_TOKEN_ONLY;
        if (
            !(s.version == 1 || s.version == 2) || !(s.boxType == 1 || s.boxType == 3) || s.layout != 1
                || s.gradLayout != 2 || s.launchFormat != 1 || s.firstId != 1 || s.q != address(0) || s.raise != R
                || ctx.gradLayouts.length == 0
                || !(s.qStream == 1 || s.qStream == 2 || s.qStream == 3 || s.qStream == 5 || s.qStream == 6)
                || !(s.tStream == 1 || s.tStream == 3 || s.tStream == 4 || s.tStream == 5 || s.tStream == 6)
                || (!tokenOnly && (s.n < 10 || s.n > 10_000)) || (tokenOnly && s.n != 0)
                || (!tokenOnly && !(s.artMode == 1 || s.artMode == 2)) || (tokenOnly && s.artMode != 0)
                || (s.openAt != 0 && s.openAt < BoxSpecV1.MIN_OPEN_AT) || s.coverSha256 == bytes32(0)
                || (!tokenOnly
                    && (s.revealRoot == bytes32(0)
                        || s.marketplaceOwner == address(0)
                        || s.collectionCoverSha256 == bytes32(0)))
        ) ++okOutsideTheMenu;
        if (
            !_safe(bytes(s.tokenName), 1, 32) || !_safe(bytes(s.tokenSymbol), 1, 11)
                || !_safe(bytes(s.description), 0, 1024)
                || (!tokenOnly && (!_safe(bytes(s.collectionName), 1, 32) || !_safe(bytes(s.collectionSymbol), 1, 11)))
                || (tokenOnly && (bytes(s.collectionName).length != 0 || bytes(s.collectionSymbol).length != 0))
        ) ++okWithUnsafeText;
        if (!tokenOnly && !this.tableAccepted(s.metadataTable)) ++okWithRefusedTable;
        if (tokenOnly && s.metadataTable.length != 0) ++okWithRefusedTable;
        if (s.addOns.length > 8) ++okWithBadAddOns;
        for (uint256 i = 1; i < s.addOns.length; ++i) {
            uint16 a = s.addOns[i - 1].id;
            uint16 b = s.addOns[i].id;
            if (b < a || (b == a && a != BoxSpecV1.ADD_ON_EDITION_SPECIALS)) ++okWithBadAddOns;
        }
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (id == 0 || id > 6) ++okWithBadAddOns;
            if (
                id == BoxSpecV1.ADD_ON_PER_ITEM_STREAM
                    && (s.version != 1 || s.addOns[i].params.length != 0 || s.tStream != 4)
            ) ++okWithBadAddOns;
            if (id == BoxSpecV1.ADD_ON_CREATOR_FEE_CAP && s.version != 2) ++okWithBadAddOns;
            if (id != BoxSpecV1.ADD_ON_CREATOR_FEE_CAP && tokenOnly) ++okWithBadAddOns;
        }
        bool creatorSide = s.qStream == 5 || s.qStream == 6 || s.tStream == 5 || s.tStream == 6;
        bool creatorRoyalty;
        bool hasPlaceholders;
        bool hasStream;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_PLACEHOLDERS) hasPlaceholders = true;
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_PER_ITEM_STREAM) hasStream = true;
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_ROYALTIES && s.addOns[i].params.length == 64) {
                (, uint8 dest) = abi.decode(s.addOns[i].params, (uint16, uint8));
                if (dest == BoxSpecV1.ROYALTY_DESTINATION_CREATOR) creatorRoyalty = true;
            }
        }
        if (
            (tokenOnly && s.version != 2)
                || (s.version == 1 && (s.deadlineDays != 0 || s.creatorBuy != 0 || creatorSide))
                || (s.version == 2
                    && !(s.deadlineDays == 30 || s.deadlineDays == 60 || s.deadlineDays == 90 || s.deadlineDays == 180))
                || s.qStream == 3 || (s.tStream == 3 && s.qStream == 1)
                || (s.artMode == 1 && s.revealListId == bytes32(0))
                || (s.artMode == 2 && (s.revealListId != bytes32(0) || !hasPlaceholders))
                || (s.tStream == 4 && !hasStream)
                || ((creatorSide || creatorRoyalty) == (s.creatorFeeRecipient == address(0)))
                || (s.creatorBuy != 0 && s.creatorBuy >= s.raise)
        ) ++okAgainstARule;
    }

    function tableAccepted(bytes memory t) external pure returns (bool) {
        BoxMetadataTable.validate(t);
        return true;
    }

    function _safe(bytes memory b, uint256 min, uint256 max) internal pure returns (bool) {
        if (b.length < min || b.length > max) return false;
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) return false;
        }
        return true;
    }

    function _q(BoxLayoutV1.Curve memory c, uint128 l, bool roundUp) internal pure returns (uint256) {
        return c.tIsCurrency0
            ? SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, roundUp)
            : SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, roundUp);
    }

    // ------------------------------------------------------------------------------------------------ storage <-> memory

    function _load(bytes memory fixture) internal {
        BoxSpecV1.BoxSpec memory s = abi.decode(fixture, (BoxSpecV1.BoxSpec));
        version = s.version;
        boxType = s.boxType;
        tokenName = bytes(s.tokenName);
        tokenSymbol = bytes(s.tokenSymbol);
        collectionName = bytes(s.collectionName);
        collectionSymbol = bytes(s.collectionSymbol);
        description = bytes(s.description);
        n = s.n;
        firstId = s.firstId;
        q = s.q;
        raise = s.raise;
        layout = s.layout;
        gradLayout = s.gradLayout;
        launchFormat = s.launchFormat;
        openAt = s.openAt;
        deadlineDays = s.deadlineDays;
        qStream = s.qStream;
        tStream = s.tStream;
        artMode = s.artMode;
        revealRoot = s.revealRoot;
        metadataTable = s.metadataTable;
        generatorHash = s.generatorHash;
        coverSha256 = s.coverSha256;
        revealListId = s.revealListId;
        marketplaceOwner = s.marketplaceOwner;
        creatorFeeRecipient = s.creatorFeeRecipient;
        creatorBuy = s.creatorBuy;
        collectionCoverSha256 = s.collectionCoverSha256;
        delete addOnIds;
        delete addOnParams;
        for (uint256 i; i < s.addOns.length; ++i) {
            addOnIds.push(s.addOns[i].id);
            addOnParams.push(s.addOns[i].params);
        }
        ctxKind = s.version == 2 ? 1 : 0;
    }

    function _mem() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s.version = version;
        s.boxType = boxType;
        s.tokenName = string(tokenName);
        s.tokenSymbol = string(tokenSymbol);
        s.collectionName = string(collectionName);
        s.collectionSymbol = string(collectionSymbol);
        s.description = string(description);
        s.n = n;
        s.firstId = firstId;
        s.q = q;
        s.raise = raise;
        s.layout = layout;
        s.gradLayout = gradLayout;
        s.launchFormat = launchFormat;
        s.openAt = openAt;
        s.deadlineDays = deadlineDays;
        s.qStream = qStream;
        s.tStream = tStream;
        s.artMode = artMode;
        s.revealRoot = revealRoot;
        s.metadataTable = metadataTable;
        s.generatorHash = generatorHash;
        s.coverSha256 = coverSha256;
        s.revealListId = revealListId;
        s.marketplaceOwner = marketplaceOwner;
        s.creatorFeeRecipient = creatorFeeRecipient;
        s.creatorBuy = creatorBuy;
        s.collectionCoverSha256 = collectionCoverSha256;
        s.addOns = new BoxSpecV1.AddOn[](addOnIds.length);
        for (uint256 i; i < addOnIds.length; ++i) {
            s.addOns[i] = BoxSpecV1.AddOn({id: addOnIds[i], params: addOnParams[i]});
        }
    }

    function _ctx() internal view returns (BoxSpecV1.VersionContext memory ctx) {
        if (ctxKind == 1) return BoxSpecV1.contextV2();
        ctx = BoxSpecV1.contextV1();
        if (ctxKind == 2) ctx.gradLayouts = new uint8[](0);
    }

    // ------------------------------------------------------------------------------------------------ generators

    function _structuredTable(uint256 seed) internal pure returns (bytes memory t) {
        uint256 r = seed;
        uint256 descLen = r % 60;
        t = abi.encodePacked(uint8(1), uint16(descLen), _text(r, descLen));
        uint256 types = (r >> 8) % 18;
        t = bytes.concat(t, bytes1(uint8(types)));
        for (uint256 i; i < types && t.length < 600; ++i) {
            r = uint256(keccak256(abi.encode(r, i)));
            uint256 nameLen = (r >> 40) % 15 == 0 ? 0 : 1 + r % 8;
            uint256 values = (r >> 48) % 15 == 0 ? 0 : 1 + (r >> 16) % 4;
            t = bytes.concat(t, bytes1(uint8(nameLen)), _text(r >> 8, nameLen), bytes1(uint8(values)));
            for (uint256 v; v < values; ++v) {
                r = uint256(keccak256(abi.encode(r, v)));
                uint256 len = (r >> 40) % 15 == 0 ? 0 : 1 + r % 8;
                t = bytes.concat(t, bytes1(uint8(len)), _text(r >> 8, len));
            }
        }
        if ((seed >> 200) % 5 == 0 && t.length > 0) t[(seed >> 208) % t.length] = bytes1(uint8(seed >> 216));
    }

    function _text(uint256 seed, uint256 len) internal pure returns (bytes memory s) {
        s = new bytes(len);
        bytes memory refused = hex"00091f227f5c80ff";
        for (uint256 i; i < len; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            s[i] = r % 40 == 0 ? refused[(r >> 8) % refused.length] : bytes1(uint8(0x41 + (r >> 8) % 26));
        }
    }

    function _params(uint16 id, uint256 seed) internal pure returns (bytes memory) {
        if (id == 1) {
            return abi.encode(
                _text(seed, 1 + seed % 33),
                _text(seed >> 8, 1 + (seed >> 8) % 12),
                _text(seed >> 16, (seed >> 16) % 40),
                _text(seed >> 24, (seed >> 24) % 40),
                _svg(seed >> 32, 1 + (seed >> 32) % 300)
            );
        }
        if (id == 2) return seed % 7 == 0 ? bytes(hex"00") : bytes("");
        if (id == 3) return abi.encode(_text(seed, 1 + seed % 33), uint32((seed >> 8) % 12_000));
        if (id == 4) return abi.encode(uint16([uint256(0), 100, 250, 500, 1, 99][seed % 6]), uint8((seed >> 8) % 5));
        if (id == 5) return abi.encode([1e18, 4e18, 8e18, 16e18, 32e18, 3e18][seed % 6], uint8((seed >> 8) % 5));
        if (id == 6) {
            bytes32[] memory teasers = new bytes32[]((seed >> 8) % 6);
            for (uint256 i; i < teasers.length; ++i) {
                teasers[i] = (seed >> 16) % 9 == 0 && i == 0 ? bytes32(0) : keccak256(abi.encode(seed, i));
            }
            bytes memory link = seed % 3 == 0
                ? bytes("")
                : bytes.concat(
                    seed % 3 == 1 ? bytes("https://") : bytes("http://"), _text(seed >> 24, (seed >> 24) % 60)
                );
            return abi.encode(seed % 4 == 0 ? bytes32(0) : keccak256(abi.encode(seed)), teasers, link);
        }
        return _text(seed, seed % 70);
    }

    function _svg(uint256 seed, uint256 len) internal pure returns (bytes memory s) {
        s = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            s[i] = r % 60 == 0 ? bytes1(uint8(r >> 8)) : bytes1(uint8(0x20 + (r >> 8) % 95));
        }
    }
}

/// @title AuditU9FableInvariants
/// @notice SH-AUDIT-B0-U9 (Fable 5.1): the invariant suite of the spec and layout libraries. The handler roams over
/// the whole field space from box 0's fixture; after every action validate() has answered (it never reverts) with a
/// reason of the format and a field exactly when refused, `specHash` is the hash of the canonical encoding and
/// changes with the encoding, and every accepted spec is inside the version's menu (BC-008, BC-014, BC-072, BC-127),
/// has a table the collection accepts, well-ordered known add-ons, and satisfies the rules; every laid-out raise is
/// held exactly with the smallest liquidity and the graduated layout places all Q and T.
contract AuditU9FableInvariants is StdInvariant, Test {
    string internal constant VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    AuditU9FableSpecHandler internal handler;

    function setUp() public {
        string memory json = vm.readFile(VECTORS);
        bytes memory v1 = vm.parseJsonBytes(json, ".columns.encoded[0]");
        bytes memory v2 = vm.parseJsonBytes(json, ".columns.encoded[1]");
        handler = new AuditU9FableSpecHandler(v1, v2);
        handler.start();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](21);
        selectors[0] = handler.setVersion.selector;
        selectors[1] = handler.setBoxType.selector;
        selectors[2] = handler.setEnum.selector;
        selectors[3] = handler.setText.selector;
        selectors[4] = handler.setN.selector;
        selectors[5] = handler.setFirstId.selector;
        selectors[6] = handler.setQ.selector;
        selectors[7] = handler.setRaise.selector;
        selectors[8] = handler.setOpenAt.selector;
        selectors[9] = handler.setDeadline.selector;
        selectors[10] = handler.setWord.selector;
        selectors[11] = handler.setAddress.selector;
        selectors[12] = handler.setCreatorBuy.selector;
        selectors[13] = handler.setTable.selector;
        selectors[14] = handler.pushAddOn.selector;
        selectors[15] = handler.popAddOn.selector;
        selectors[16] = handler.swapAddOns.selector;
        selectors[17] = handler.mutateParams.selector;
        selectors[18] = handler.layoutRaise.selector;
        selectors[19] = handler.setContext.selector;
        selectors[20] = handler.resetToFixture.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev After each run the run's tallies are logged (the last run's stay in the output): how many checks the
    /// handler made, how many specs were accepted and refused, how many raises were laid out. No assertion here: a
    /// failing run is shrunk to a few calls, which would make any coverage assertion fail by itself.
    function afterInvariant() external {
        emit log_named_uint("run: checks", handler.calls());
        emit log_named_uint("run: accepted", handler.okCount());
        emit log_named_uint("run: accepted, not a fixture", handler.okChanged());
        emit log_named_uint("run: refused", handler.refusedCount());
        emit log_named_uint("run: layouts", handler.layoutCalls());
        emit log_named_uint("run: last reason", handler.lastReason());
    }

    function invariant_AUDIT_U9_validateAlwaysAnswersWithAReasonAndAField() public view {
        assertEq(handler.reasonOutOfFormat(), 0, "a reason of the format");
        assertEq(handler.okWithField(), 0, "OK carries field 0");
        assertEq(handler.refusalWithoutField(), 0, "a refusal names a field");
        assertEq(handler.okCount() + handler.refusedCount(), handler.calls(), "every call answered");
    }

    function invariant_AUDIT_U9_specHashIsTheEncodingHashAndFollowsEveryChange() public view {
        assertEq(handler.hashNotEncodingHash(), 0, "keccak256(abi.encode(spec))");
        assertEq(handler.hashUnchangedByAChange(), 0, "a changed encoding changes the hash");
    }

    function invariant_AUDIT_U9_acceptedSpecsStayInsideTheMenu() public view {
        assertEq(handler.okOutsideTheMenu(), 0, "the version's menu, N, one raise, native ETH");
        assertEq(handler.okWithUnsafeText(), 0, "printable ASCII without quote or backslash, within bounds");
        assertEq(handler.okWithRefusedTable(), 0, "a table the collection accepts");
        assertEq(handler.okWithBadAddOns(), 0, "known, ordered, at most eight add-ons that fit the version");
        assertEq(handler.okAgainstARule(), 0, "the rules of the format");
    }

    function invariant_AUDIT_U9_layoutRaisesExactlyWithTheSmallestLiquidity() public view {
        assertEq(handler.layoutRaiseMismatch(), 0, "holds exactly the raise");
        assertEq(handler.layoutNotSmallest(), 0, "the smallest liquidity");
        assertEq(handler.layoutSupplyMismatch(), 0, "curve T + pool share = 1e27");
        assertEq(handler.layoutQNotPlaced(), 0, "all Q placed or dust");
        assertEq(handler.layoutTNotPlaced(), 0, "all T placed or dust");
        assertEq(handler.layoutAskNotMaximal(), 0, "the ask is the largest the T funds");
        assertEq(handler.layoutBidOverAsk(), 0, "the full bid never above the ask");
    }
}
