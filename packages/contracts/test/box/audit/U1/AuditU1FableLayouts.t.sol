// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "../../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxKind, RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxCloneArgs} from "../../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {AuditU1FableWorld} from "./AuditU1FableBase.sol";

/// @notice SH-AUDIT-B0 U1 (Fable), L7: clone argument encoding and decoding agree for every layout (P1.12: the
/// planner and `BoxCloneArgs` encode, each implementation's getters and documented offsets read, every field fuzzed to
/// 0, 1 and its maximum; no getter reads past the encoded length; a short encoding reads zeros, ADR-0016 item 2); the
/// template id is data-blind and structure-sensitive (P1.13, BC-013); every planner-trusted field the factory does not
/// re-read equals the spec field it came from, on the world's box 0 (P1.16; BoxFactoryV1.sol:61-63).
/// forge-config: default.evm_version = "osaka"
contract AuditU1FableLayoutsTest is AuditU1FableWorld {
    // ============================================================================================================
    // P1.12 · the S3 layouts through BoxCloneArgs and the implementations' getters

    /// @dev A clone of `impl` carrying `args`, made by the test (its address is nobody's coordinator; only argument
    /// getters are read).
    function _clone(address impl, bytes memory args) internal returns (address) {
        return BoxClones.create(BoxClones.initCode(impl, args));
    }

    /// @dev The `size` bytes at argument offset `offset` of `clone`'s code (after the proxy), as an unsigned integer.
    function _argAt(address clone, uint256 offset, uint256 size, bool receiving) internal view returns (uint256 v) {
        bytes memory code = clone.code;
        uint256 at = (receiving ? BoxClones.RECEIVING_ARGS_OFFSET : BoxClones.ARGS_OFFSET) + offset;
        for (uint256 i; i < size; ++i) {
            v = (v << 8) | (at + i < code.length ? uint8(code[at + i]) : 0);
        }
    }

    struct CollectionInputs {
        address[9] addrs;
        uint32 size;
        uint8 triggers;
        uint16 bps;
        uint8 dest;
        uint256 firstId;
        bytes32[5] words;
        uint16[6] lengths;
        uint8 edge;
    }

    /// P1.12 (collection, 389 fixed bytes + texts): every field to 0, 1 and its maximum (texts up to the encoder's
    /// bounds within EIP-170) reads back exactly through the collection's getters; the texts' header is 9 bytes and the
    /// encoded length is the fixed part plus the texts, so no getter reads past the end.
    function testFuzz_AUDIT_U1_collectionLayoutRoundTrips(CollectionInputs memory f) public {
        BoxCloneArgs.CollectionArgs memory c = _collectionArgs(f);
        bytes memory args = BoxCloneArgs.collection(c);
        assertEq(args.length, BoxCloneArgs.C_TEXT_BYTES + _textBytes(c), "fixed part + header + texts");
        _assertCollection(IBoxCollection(_clone(impls.collection, args)), c);
    }

    function _collectionArgs(CollectionInputs memory f) internal pure returns (BoxCloneArgs.CollectionArgs memory c) {
        c.coordinator = f.addrs[0];
        c.vault = f.addrs[1];
        c.token = f.addrs[2];
        c.receiver = f.addrs[3];
        c.revealUnlocker = f.addrs[4];
        c.transferObserver = f.addrs[5];
        c.royaltyRouter = f.addrs[6];
        c.marketplaceOwner = f.addrs[7];
        c.metadataTable = f.addrs[8];
        c.collectionSize = _edge32(f.size, f.edge);
        c.revealTriggers = f.triggers;
        c.royaltyBps = f.bps;
        c.royaltyDestination = f.dest % 4; // 0..3: None, FeeHandling, Creator, PoolDepth (any other byte reads None)
        c.firstId = f.edge % 5 == 1 ? type(uint256).max : f.firstId;
        c.revealRoot = f.words[0];
        c.metadataTableHash = f.words[1];
        c.generatorHash = f.words[2];
        c.collectionCoverSha256 = f.words[3];
        c.bannerSha256 = f.words[4];
        c.name = _text(f.lengths[0] % 256, "n");
        c.symbol = _text(f.lengths[1] % 256, "s");
        c.description = _text(f.lengths[2] % 4097, "d");
        c.hiddenDescription = _text(f.lengths[3] % 4097, "h");
        c.hiddenSvg = _text(f.lengths[4] % 8193, "v");
        c.externalLink = _text(f.lengths[5] % 256, "l");
    }

    function _textBytes(BoxCloneArgs.CollectionArgs memory c) internal pure returns (uint256) {
        return bytes(c.name).length + bytes(c.symbol).length + bytes(c.description).length
            + bytes(c.hiddenDescription).length + bytes(c.hiddenSvg).length + bytes(c.externalLink).length;
    }

    function _assertCollection(IBoxCollection k, BoxCloneArgs.CollectionArgs memory c) internal view {
        assertEq(k.coordinator(), c.coordinator);
        assertEq(k.vault(), c.vault);
        assertEq(k.token(), c.token);
        assertEq(k.receiver(), c.receiver);
        assertEq(k.revealUnlocker(), c.revealUnlocker);
        assertEq(k.transferObserver(), c.transferObserver);
        assertEq(k.owner(), c.marketplaceOwner);
        assertEq(k.metadataTable(), c.metadataTable);
        assertEq(k.collectionSize(), c.collectionSize);
        assertEq(k.revealTriggers(), c.revealTriggers);
        assertEq(k.royaltyBps(), c.royaltyBps);
        assertEq(uint8(k.royaltyDestination()), c.royaltyDestination, "destination 0..3 as written");
        assertEq(k.royaltyRouter(), c.royaltyDestination == 0 ? address(0) : c.royaltyRouter, "router unless None");
        assertEq(k.firstId(), c.firstId);
        assertEq(k.revealRoot(), c.revealRoot);
        assertEq(k.metadataTableHash(), c.metadataTableHash);
        assertEq(k.generatorHash(), c.generatorHash);
        assertEq(k.collectionCoverSha256(), c.collectionCoverSha256);
        assertEq(k.bannerSha256(), c.bannerSha256);
        assertEq(k.name(), c.name);
        assertEq(k.symbol(), c.symbol);
        assertEq(k.description(), c.description);
        assertEq(k.hiddenDescription(), c.hiddenDescription);
        assertEq(k.hiddenSvg(), c.hiddenSvg);
        assertEq(k.externalLink(), c.externalLink);
    }

    /// P1.12 (vault, 146 bytes): every field to its extremes reads back through the vault's getters.
    function testFuzz_AUDIT_U1_vaultLayoutRoundTrips(
        address[5] memory addrs,
        uint64 size,
        uint16[3] memory fees,
        uint256 firstId,
        uint8 edge
    ) public {
        BoxCloneArgs.VaultArgs memory v;
        v.coordinator = addrs[0];
        v.token = addrs[1];
        v.collection = addrs[2];
        v.ticketAdapter = addrs[3];
        v.observer = addrs[4];
        v.collectionSize = edge % 3 == 0 ? type(uint64).max : edge % 3 == 1 ? 0 : size;
        v.drawFeeBps = edge % 5 == 0 ? type(uint16).max : fees[0];
        v.pickFeeBps = fees[1];
        v.returnFeeBps = edge % 7 == 0 ? 0 : fees[2];
        v.firstId = edge % 2 == 0 ? firstId : type(uint256).max;
        bytes memory args = BoxCloneArgs.vault(v);
        assertEq(args.length, BoxCloneArgs.V_LENGTH, "146 bytes");
        IBoxVault k = IBoxVault(_clone(impls.vault, args));
        assertEq(k.coordinator(), v.coordinator);
        assertEq(k.token(), v.token);
        assertEq(k.collection(), v.collection);
        assertEq(k.ticketAdapter(), v.ticketAdapter);
        assertEq(k.observer(), v.observer);
        assertEq(k.collectionSize(), v.collectionSize);
        assertEq(k.drawFeeBps(), v.drawFeeBps);
        assertEq(k.pickFeeBps(), v.pickFeeBps);
        assertEq(k.returnFeeBps(), v.returnFeeBps);
        assertEq(k.firstId(), v.firstId);
    }

    struct TicketsInputs {
        address[5] addrs;
        uint32 openAt;
        uint32 size;
        uint256 firstId;
        uint16[3] lengths;
        uint8 edge;
    }

    /// P1.12 (tickets, 144 fixed bytes + texts): every field to its extremes reads back through the tickets' getters
    /// and, for the open time and the description (stored at `initialize`, private), at the documented offsets.
    function testFuzz_AUDIT_U1_ticketsLayoutRoundTrips(TicketsInputs memory f) public {
        BoxCloneArgs.TicketsArgs memory t;
        t.coordinator = f.addrs[0];
        t.vault = f.addrs[1];
        t.collection = f.addrs[2];
        t.token = f.addrs[3];
        t.source = f.addrs[4];
        t.openAt = f.edge % 3 == 0 ? type(uint32).max : f.openAt;
        t.collectionSize = _edge32(f.size, f.edge);
        t.firstId = f.edge % 2 == 0 ? f.firstId : type(uint256).max;
        t.name = _text(f.lengths[0] % 256, "n");
        t.symbol = _text(f.lengths[1] % 256, "s");
        t.description = _text(f.lengths[2] % 8193, "d");
        bytes memory args = BoxCloneArgs.tickets(t);
        uint256 texts = bytes(t.name).length + bytes(t.symbol).length + bytes(t.description).length;
        assertEq(args.length, BoxCloneArgs.T_TEXT_BYTES + texts, "fixed part + header + texts");
        address clone = _clone(impls.tickets, args);
        _assertTickets(clone, t);
    }

    function _assertTickets(address clone, BoxCloneArgs.TicketsArgs memory t) internal view {
        IBoxTickets k = IBoxTickets(clone);
        assertEq(k.coordinator(), t.coordinator);
        assertEq(k.vault(), t.vault);
        assertEq(k.collection(), t.collection);
        assertEq(k.token(), t.token);
        assertEq(k.source(), t.source);
        assertEq(k.collectionSize(), t.collectionSize);
        assertEq(k.firstId(), t.firstId);
        assertEq(k.name(), t.name);
        assertEq(k.symbol(), t.symbol);
        assertEq(_argAt(clone, BoxCloneArgs.T_OPEN_AT, 4, false), t.openAt, "openAt at offset 100");
        assertEq(k.openAt(), 0, "openAt is storage until initialize");
        uint256 descAt =
            BoxClones.ARGS_OFFSET + BoxCloneArgs.T_TEXT_BYTES + bytes(t.name).length + bytes(t.symbol).length;
        bytes memory code = clone.code;
        bytes memory d = bytes(t.description);
        for (uint256 i; i < d.length; ++i) {
            assertEq(code[descAt + i], d[i], "description bytes");
        }
    }

    /// P1.12 (royalty router, 61 bytes, the receiving shape): the three addresses and the destination byte read
    /// back; PoolDepth and Creator as written, any other byte as FeeHandling (BoxRoyaltyRouter.sol:96-102).
    function testFuzz_AUDIT_U1_routerLayoutRoundTrips(address[3] memory addrs, uint8 dest) public {
        BoxCloneArgs.RouterArgs memory r =
            BoxCloneArgs.RouterArgs({coordinator: addrs[0], receiver: addrs[1], weth: addrs[2], destination: dest});
        bytes memory args = BoxCloneArgs.router(r);
        assertEq(args.length, BoxCloneArgs.R_LENGTH, "61 bytes");
        address clone = BoxClones.create(BoxClones.initCodeReceiving(impls.royaltyRouter, args));
        IBoxRoyaltyRouter k = IBoxRoyaltyRouter(payable(clone));
        assertEq(k.coordinator(), r.coordinator);
        assertEq(k.receiver(), r.receiver);
        assertEq(k.weth(), r.weth);
        RoyaltyDestination expected = dest == uint8(RoyaltyDestination.PoolDepth)
            ? RoyaltyDestination.PoolDepth
            : dest == uint8(RoyaltyDestination.Creator) ? RoyaltyDestination.Creator : RoyaltyDestination.FeeHandling;
        assertEq(uint8(k.destination()), uint8(expected));
        assertEq(_argAt(clone, BoxCloneArgs.R_DESTINATION, 1, true), dest, "the byte at offset 60");
        assertEq(clone.code.length, BoxClones.RECEIVING_ARGS_OFFSET + 61);
    }

    /// P1.12 (per-item stream, 182 bytes): every field to its extremes reads back through the stream's getters and,
    /// for the ticks (private), at the documented offsets, as two's complement.
    function testFuzz_AUDIT_U1_streamLayoutRoundTrips(
        address[7] memory addrs,
        int24 lower,
        int24 upper,
        uint32 size,
        uint256 firstId,
        uint8 edge
    ) public {
        BoxCloneArgs.StreamArgs memory s;
        s.coordinator = addrs[0];
        s.token = addrs[1];
        s.collection = addrs[2];
        s.vault = addrs[3];
        s.tickets = addrs[4];
        s.receiver = addrs[5];
        s.hook = addrs[6];
        s.tickLower = edge % 3 == 0 ? type(int24).min : lower;
        s.tickUpper = edge % 3 == 1 ? type(int24).max : upper;
        s.collectionSize = _edge32(size, edge);
        s.firstId = firstId;
        bytes memory args = BoxCloneArgs.stream(s);
        assertEq(args.length, BoxCloneArgs.S_LENGTH, "182 bytes");
        address clone = _clone(impls.itemStream, args);
        IBoxItemStream k = IBoxItemStream(clone);
        assertEq(k.coordinator(), s.coordinator);
        assertEq(k.token(), s.token);
        assertEq(k.collection(), s.collection);
        assertEq(k.vault(), s.vault);
        assertEq(k.tickets(), s.tickets);
        assertEq(k.receiver(), s.receiver);
        assertEq(k.hook(), s.hook);
        assertEq(k.collectionSize(), s.collectionSize);
        assertEq(k.firstId(), s.firstId);
        assertEq(int24(uint24(_argAt(clone, BoxCloneArgs.S_TICK_LOWER, 3, false))), s.tickLower, "tick lower");
        assertEq(int24(uint24(_argAt(clone, BoxCloneArgs.S_TICK_UPPER, 3, false))), s.tickUpper, "tick upper");
    }

    /// P1.12 (ADR-0016 item 2): a clone whose arguments stop short reads zeros for the missing fields and reverts on
    /// none of its argument getters (EXTCODECOPY past the end copies zeros): the vault's 146 bytes cut to 100 leave
    /// the observer, N, the fees and the first id at zero and the five addresses before them intact; one byte short
    /// of the first id reads it shifted, its missing low byte zero.
    function testProperty_AUDIT_U1_shortArgumentsReadAsZero() public {
        BoxCloneArgs.VaultArgs memory v;
        v.coordinator = eoa[0];
        v.token = eoa[1];
        v.collection = eoa[2];
        v.ticketAdapter = eoa[3];
        v.observer = eoa[4];
        v.collectionSize = 1_969;
        v.drawFeeBps = 100;
        v.pickFeeBps = 2_500;
        v.returnFeeBps = 500;
        v.firstId = 0x0102;
        bytes memory full = BoxCloneArgs.vault(v);
        IBoxVault k = IBoxVault(_clone(impls.vault, _head(full, 100)));
        assertEq(k.coordinator(), eoa[0]);
        assertEq(k.ticketAdapter(), eoa[3]);
        assertEq(k.observer(), eoa[4], "the last whole address");
        assertEq(k.collectionSize(), 0, "missing: zero");
        assertEq(k.drawFeeBps(), 0);
        assertEq(k.firstId(), 0);
        assertEq(IBoxVault(_clone(impls.vault, _head(full, 145))).firstId(), 1 << 8, "the missing low byte reads zero");
    }

    function _head(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
    }

    // ============================================================================================================
    // P1.12 · the planner's layouts (coordinator, hook, launch router, receiver) with the version's values fuzzed

    struct PlanInputs {
        address[5] addrs;
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtLower;
        uint160 sqrtUpper;
        uint128 liquidity;
        uint128 raise;
        uint32 openAt;
        bytes32 specHash;
        address creator;
        uint32 n;
        uint256 firstId;
    }

    /// P1.12 (the planner encodes, the implementations read): with the version's values and the spec's fields fuzzed
    /// to their extremes, the planner's coordinator, hook, launch router and receiver init codes put every field where
    /// the implementation reads it: the coordinator's 154 bytes (kind, Q, raise, no creator buy, the creator, the
    /// spec hash, no executor argument, the source, the nine nonces), the hook's 203, the router's 105 (the open at
    /// 101) and the receiver's 201, read through stranger clones' getters and at the documented offsets.
    function testFuzz_AUDIT_U1_plannerLayoutsRoundTrip(PlanInputs memory f) public {
        BoxFactoryV1Planner.Version memory v = _version(f);
        BoxSpecV1.BoxSpec memory s = _worldSpec();
        s.openAt = f.openAt;
        s.n = f.n;
        s.firstId = f.firstId;
        IBoxFactoryV1.Box0Addresses memory ad = planner.addresses(v.coordinator, true);
        BoxFactoryV1Planner.Plan memory p = planner.plan(s, v, f.creator, bytes32(0), f.specHash);
        _checkCoordinatorLayout(p, v, ad, f);
        _checkHookLayout(p, v, ad, f.openAt);
        _checkRouterLayout(p, v, ad, f.openAt);
        _checkReceiverLayout(p, v, ad);
    }

    function _version(PlanInputs memory f) internal view returns (BoxFactoryV1Planner.Version memory v) {
        v = factory.version();
        v.poolManager = f.addrs[0];
        v.randomness = f.addrs[1];
        v.weth = f.addrs[2];
        v.platformSafe = f.addrs[3];
        v.coordinator = f.addrs[4];
        v.tickLower = f.tickLower;
        v.tickUpper = f.tickUpper;
        v.sqrtLower = f.sqrtLower;
        v.sqrtUpper = f.sqrtUpper;
        v.liquidity = f.liquidity;
        v.raise = f.raise;
    }

    function _checkCoordinatorLayout(
        BoxFactoryV1Planner.Plan memory p,
        BoxFactoryV1Planner.Version memory v,
        IBoxFactoryV1.Box0Addresses memory ad,
        PlanInputs memory f
    ) internal {
        assertEq(p.coordinatorInit.length - 55, BoxCoordinator(impls.coordinator).ARGS_LENGTH(), "154 bytes");
        BoxCoordinator c = BoxCoordinator(BoxClones.create(p.coordinatorInit));
        assertEq(uint8(c.kind()), uint8(BoxKind.Box0));
        assertEq(c.q(), address(0), "native ETH");
        assertEq(c.raise(), v.raise, "raise (16 bytes)");
        assertEq(c.creatorBuyAmount(), 0, "no creator buy for box 0");
        assertEq(c.creator(), f.creator);
        assertEq(c.specHash(), f.specHash);
        assertEq(c.randomness(), v.randomness, "the source argument");
        _checkNonces(c);
        assertEq(ad.coordinator, v.coordinator);
        assertEq(ad.token, vm.computeCreateAddress(v.coordinator, 2), "addresses(): the same nonces");
        assertEq(ad.executor, vm.computeCreateAddress(v.coordinator, 7));
        assertEq(ad.royaltyRouter, vm.computeCreateAddress(v.coordinator, 10));
        assertEq(c.boxId(), 0, "storage until deploy");
        assertEq(c.hook(), address(0), "storage until deploy");
    }

    /// @dev The roles: CREATE addresses of the clone itself at the planned nonces.
    function _checkNonces(BoxCoordinator c) internal view {
        assertEq(c.nonceOf(0), 2, "token");
        assertEq(c.nonceOf(1), 3, "vault");
        assertEq(c.nonceOf(2), 4, "collection");
        assertEq(c.nonceOf(3), 5, "receiver");
        assertEq(c.nonceOf(4), 6, "launch router");
        assertEq(c.nonceOf(5), 8, "tickets");
        assertEq(c.nonceOf(6), 10, "royalty router");
        assertEq(c.nonceOf(7), 9, "item stream");
        assertEq(c.nonceOf(8), 7, "executor");
        assertEq(c.nonceOf(9), 0, "no tenth role");
        assertEq(c.token(), vm.computeCreateAddress(address(c), 2));
        assertEq(c.executor(), vm.computeCreateAddress(address(c), 7), "created here: the argument is zero");
        assertEq(c.itemStream(), vm.computeCreateAddress(address(c), 9));
        assertEq(c.royaltyRouter(), vm.computeCreateAddress(address(c), 10));
    }

    function _checkHookLayout(
        BoxFactoryV1Planner.Plan memory p,
        BoxFactoryV1Planner.Version memory v,
        IBoxFactoryV1.Box0Addresses memory ad,
        uint32 openAt
    ) internal {
        assertEq(p.hookInit.length - 55, 203, "203 bytes");
        assertEq(keccak256(p.hookInit), keccak256(planner.hookInitCode(v, ad, openAt)), "hookInitCode == plan's");
        address clone = BoxClones.create(p.hookInit);
        IBoxHook h = IBoxHook(clone);
        assertEq(h.q(), address(0));
        assertEq(h.token(), ad.token);
        assertEq(h.launchRouter(), ad.launchRouter);
        assertEq(uint8(h.kind()), uint8(BoxKind.Box0));
        assertEq(h.coordinator(), ad.coordinator);
        assertEq(h.receiver(), ad.receiver);
        assertEq(address(h.priceAverage()), ad.executor, "the average is FIT's executor");
        assertEq(h.raise(), v.raise);
        (int24 lower, int24 upper, uint128 liquidity) = h.curve();
        assertEq(lower, v.tickLower, "tick lower (3 bytes, two's complement)");
        assertEq(upper, v.tickUpper, "tick upper");
        assertEq(liquidity, 0, "liquidity reads 0 before launch (storage-gated)");
        assertEq(_argAt(clone, 40, 20, false), v.sqrtLower, "sqrt P1 at 40");
        assertEq(_argAt(clone, 60, 20, false), v.sqrtUpper, "sqrt P0 at 60");
        assertEq(_argAt(clone, 107, 4, false), openAt, "openAt at 107");
        assertEq(_argAt(clone, 111, 16, false), v.liquidity, "liquidity at 111");
        assertEq(_argAt(clone, 127, 16, false), v.raise, "raise at 127");
    }

    function _checkRouterLayout(
        BoxFactoryV1Planner.Plan memory p,
        BoxFactoryV1Planner.Version memory v,
        IBoxFactoryV1.Box0Addresses memory ad,
        uint32 openAt
    ) internal {
        bytes memory init = p.codes[planner.NONCE_ROUTER() - 1];
        assertEq(init.length - 55, BoxLaunchRouter(payable(impls.launchRouter)).ARGS_LENGTH(), "105 bytes");
        address clone = BoxClones.create(init);
        IBoxLaunchRouter r = IBoxLaunchRouter(clone);
        assertEq(uint8(r.kind()), uint8(BoxKind.Box0));
        assertEq(r.q(), address(0));
        assertEq(r.token(), ad.token);
        assertEq(r.hook(), p.hook, "the predicted hook");
        assertEq(r.coordinator(), ad.coordinator);
        assertEq(_argAt(clone, 81, 20, false), v.sqrtLower, "sqrt P1 at 81");
        assertEq(_argAt(clone, 101, 4, false), openAt, "openAt at 101");
        assertEq(r.openAt(), 0, "storage until initialize");
    }

    function _checkReceiverLayout(
        BoxFactoryV1Planner.Plan memory p,
        BoxFactoryV1Planner.Version memory v,
        IBoxFactoryV1.Box0Addresses memory ad
    ) internal {
        bytes memory init = p.codes[planner.NONCE_RECEIVER() - 1];
        assertEq(init.length - 55, 201, "201 bytes");
        address clone = BoxClones.create(init);
        IBoxReceiver r = IBoxReceiver(clone);
        assertEq(uint8(r.kind()), uint8(BoxKind.Box0));
        assertEq(r.q(), address(0));
        assertEq(r.token(), ad.token);
        assertEq(r.coordinator(), ad.coordinator);
        assertEq(r.hook(), p.hook);
        assertEq(r.executor(), ad.executor);
        assertEq(r.platformSafe(), v.platformSafe);
        assertEq(r.itemStream(), ad.itemStream);
        assertEq(r.qStream(), BoxSpecV1.Q_STREAM_BUYBACK_BURN_T);
        assertEq(r.tStream(), BoxSpecV1.T_STREAM_PER_ITEM_STREAM);
        assertEq(uint8(r.royaltyDestination()), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING);
        assertEq(r.creatorPayee(), address(0), "no payee");
        assertEq(r.swapModule(), address(0), "no module");
        assertEq(_argAt(clone, 184, 16, false), 0, "no creator-fee cap");
        assertEq(_argAt(clone, 200, 1, false), 0, "no cap excess");
    }

    // ============================================================================================================
    // P1.13 · the template id (BC-013)

    struct DataInputs {
        uint32 n;
        uint256 firstId;
        bytes32 root;
        bytes32 generator;
        uint32 openAt;
        uint8 preset;
        bytes32 bannerSeed;
    }

    /// P1.13: the template id is unchanged by every data field (names, N, first id, texts, art commitments, the
    /// table, the open time, the royalty rate, the specials, the page) and by re-encoding; it differs for every
    /// structural change the planner hashes (box type, layouts, launch format, Q, each stream, art mode, the royalty
    /// destination, the version's code hash, the executor's code hash); the record carries the factory's.
    function testFuzz_AUDIT_U1_templateIdIsDataBlind(DataInputs memory f) public view {
        BoxSpecV1.BoxSpec memory s = _worldSpec();
        bytes32 id = factory.templateIdOf(s);
        (,, bytes32 recorded,,) = registry.entry(0);
        assertEq(recorded, id, "the record carries the factory's template id");
        assertEq(planner.templateIdOf(s, factory.versionCodeHash(), factory.executorInitCodeHash()), id);
        assertEq(factory.templateIdOf(_copySpec(s)), id, "re-encoding");
        assertEq(factory.templateIdOf(_withData(s, f)), id, "data never moves the template id");
        _assertStructureMovesIt(s, id);
    }

    function _withData(BoxSpecV1.BoxSpec memory s, DataInputs memory f)
        internal
        pure
        returns (BoxSpecV1.BoxSpec memory d)
    {
        d = _copySpec(s);
        d.tokenName = "Other";
        d.tokenSymbol = "OTH";
        d.collectionName = "Others";
        d.collectionSymbol = "O";
        d.description = "another";
        d.n = f.n;
        d.firstId = f.firstId;
        d.revealRoot = f.root;
        d.generatorHash = f.generator;
        d.coverSha256 = f.bannerSeed;
        d.collectionCoverSha256 = ~f.bannerSeed;
        d.revealListId = f.root ^ f.generator;
        d.openAt = f.openAt;
        d.metadataTable = hex"01000000";
        uint16[4] memory presets = [uint16(0), 100, 250, 500];
        for (uint256 i; i < d.addOns.length; ++i) {
            uint16 idd = d.addOns[i].id;
            if (idd == BoxSpecV1.ADD_ON_ROYALTIES) {
                d.addOns[i].params = abi.encode(presets[f.preset % 4], BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING);
            } else if (idd == BoxSpecV1.ADD_ON_PLACEHOLDERS) {
                d.addOns[i].params = abi.encode("P", "P", "", "", "x");
            } else if (idd == BoxSpecV1.ADD_ON_EDITION_SPECIALS) {
                d.addOns[i].params = abi.encode("S", uint32(f.n % 7 + 1));
            } else if (idd == BoxSpecV1.ADD_ON_COLLECTION_METADATA) {
                d.addOns[i].params = abi.encode(f.bannerSeed, new bytes32[](0), "");
            }
        }
    }

    function _assertStructureMovesIt(BoxSpecV1.BoxSpec memory s, bytes32 id) internal view {
        bytes32[11] memory ids;
        BoxSpecV1.BoxSpec memory x;
        (x = _copySpec(s)).boxType = BoxSpecV1.BOX_TYPE_TOKEN_ONLY;
        ids[0] = factory.templateIdOf(x);
        (x = _copySpec(s)).layout = 2;
        ids[1] = factory.templateIdOf(x);
        (x = _copySpec(s)).gradLayout = x.gradLayout + 1;
        ids[2] = factory.templateIdOf(x);
        (x = _copySpec(s)).launchFormat = x.launchFormat + 1;
        ids[3] = factory.templateIdOf(x);
        (x = _copySpec(s)).q = address(kit.weth());
        ids[4] = factory.templateIdOf(x);
        (x = _copySpec(s)).qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        ids[5] = factory.templateIdOf(x);
        (x = _copySpec(s)).tStream = BoxSpecV1.T_STREAM_BURN_T;
        ids[6] = factory.templateIdOf(x);
        (x = _copySpec(s)).artMode = BoxSpecV1.ART_MODE_OPEN;
        ids[7] = factory.templateIdOf(x);
        x = _copySpec(s);
        for (uint256 i; i < x.addOns.length; ++i) {
            if (x.addOns[i].id == BoxSpecV1.ADD_ON_ROYALTIES) {
                x.addOns[i].params = abi.encode(uint16(250), BoxSpecV1.ROYALTY_DESTINATION_POOL_DEPTH);
            }
        }
        ids[8] = factory.templateIdOf(x);
        ids[9] = planner.templateIdOf(s, factory.versionCodeHash(), keccak256("another executor"));
        ids[10] = planner.templateIdOf(s, ~factory.versionCodeHash(), factory.executorInitCodeHash());
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(ids[i] != id, string.concat("structure moves it: ", vm.toString(i)));
            for (uint256 j; j < i; ++j) {
                assertTrue(ids[i] != ids[j], "pairwise distinct");
            }
        }
    }

    // ============================================================================================================
    // P1.16 · the planner-trusted values on the world's box 0 equal the spec

    /// P1.16 (BoxFactoryV1.sol:61-63): every value the factory does not re-read after the launch equals the spec
    /// field it came from, read through the created contracts' getters: the collection's name, symbol, description,
    /// hidden description and hidden picture (placeholders params 4-5), its generator and cover commitments, the
    /// banner and link (add-on 6), N, first id, the royalty rate and destination (add-on 4); the tickets' name,
    /// symbol, N, first id; T's name and symbol; the curve's arguments behind the pool re-read (the hook's ticks and
    /// liquidity are BoxLayoutV1.curve(R)'s, the stream's ticks the same, the executor's seed P1); the receiver's
    /// stream actions, destination and Safe; the royalty router's WETH and destination; the vault's fees.
    function testProperty_AUDIT_U1_plannerTrustedValuesAreTheSpecs() public view {
        BoxSpecV1.BoxSpec memory s = _worldSpec();
        _assertTexts(s);
        _assertNumbers(s);
        _assertCurveAndWiring(s);
    }

    function _assertTexts(BoxSpecV1.BoxSpec memory s) internal view {
        (string[5] memory p,,, bytes32 banner, string memory link) = _addOns(s);
        assertEq(collection.name(), s.collectionName, "collection name");
        assertEq(collection.symbol(), s.collectionSymbol, "collection symbol");
        assertEq(collection.description(), s.description, "description");
        assertEq(collection.hiddenDescription(), p[3], "hidden description (placeholders param 4)");
        assertEq(collection.hiddenSvg(), p[4], "hidden picture (param 5)");
        assertEq(collection.externalLink(), link, "external link (add-on 6)");
        assertEq(collection.bannerSha256(), banner, "banner (add-on 6)");
        assertEq(tickets.name(), p[0], "placeholder name (param 1)");
        assertEq(tickets.symbol(), p[1], "placeholder symbol (param 2)");
        assertEq(token.name(), s.tokenName, "T name");
        assertEq(token.symbol(), s.tokenSymbol, "T symbol");
        assertEq(collection.metadataTableBytes(), s.metadataTable, "the table's bytes");
    }

    function _assertNumbers(BoxSpecV1.BoxSpec memory s) internal view {
        (, uint16 bps, uint8 dest,,) = _addOns(s);
        assertEq(collection.generatorHash(), s.generatorHash, "generator hash");
        assertEq(collection.collectionCoverSha256(), s.collectionCoverSha256, "collection cover (field 28)");
        assertEq(collection.collectionSize(), s.n, "N");
        assertEq(collection.firstId(), s.firstId, "first id");
        assertEq(collection.royaltyBps(), bps, "royalty rate (add-on 4)");
        assertEq(uint8(collection.royaltyDestination()), dest, "royalty destination");
        assertEq(collection.revealRoot(), s.revealRoot);
        assertEq(collection.metadataTableHash(), keccak256(s.metadataTable));
        assertEq(collection.revealTriggers(), planner.REVEAL_ON_EXIT());
        assertEq(collection.owner(), s.marketplaceOwner);
        assertEq(tickets.collectionSize(), s.n);
        assertEq(tickets.firstId(), s.firstId);
        assertEq(tickets.openAt(), s.openAt);
        assertEq(vault.collectionSize(), s.n);
        assertEq(vault.firstId(), s.firstId);
        assertEq(vault.drawFeeBps(), BoxSpecV1.DRAW_FEE_BPS);
        assertEq(vault.pickFeeBps(), BoxSpecV1.PICK_FEE_BPS);
        assertEq(vault.returnFeeBps(), BoxSpecV1.RETURN_FEE_BPS);
        assertEq(stream.collectionSize(), s.n);
        assertEq(stream.firstId(), s.firstId);
        IBoxRegistry.BoxRecord memory rec = registry.recordOf(0);
        assertEq(rec.raise, s.raise);
        assertEq(rec.openAt, s.openAt);
        assertEq(rec.creator, address(kit));
        assertEq(rec.specHash, keccak256(abi.encode(s)));
    }

    function _assertCurveAndWiring(BoxSpecV1.BoxSpec memory s) internal view {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(s.raise, false);
        (int24 lower, int24 upper, uint128 liquidity) = hook.curve();
        assertEq(lower, c.tickLower, "hook tick lower");
        assertEq(upper, c.tickUpper, "hook tick upper");
        assertEq(liquidity, c.liquidity, "hook liquidity");
        assertEq(hook.raise(), s.raise, "hook raise");
        assertEq(_argAt(a.hook, 40, 20, false), c.sqrtPriceLowerX96, "sqrt P1");
        assertEq(_argAt(a.hook, 60, 20, false), c.sqrtPriceUpperX96, "sqrt P0");
        assertEq(_argAt(a.launchRouter, 81, 20, false), c.sqrtPriceLowerX96, "the router's P1");
        assertEq(int24(uint24(_argAt(a.itemStream, BoxCloneArgs.S_TICK_LOWER, 3, false))), c.tickLower);
        assertEq(int24(uint24(_argAt(a.itemStream, BoxCloneArgs.S_TICK_UPPER, 3, false))), c.tickUpper);
        assertEq(executor.latestSampleTick(), c.tickLower, "the executor's seed is P1");
        assertEq(coordinator.raise(), s.raise);
        assertEq(receiver.qStream(), s.qStream);
        assertEq(receiver.tStream(), s.tStream);
        assertEq(uint8(receiver.royaltyDestination()), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING);
        assertEq(receiver.platformSafe(), s.marketplaceOwner, "the Safe is the spec's marketplaceOwner");
        assertEq(royaltyRouter.weth(), factory.weth());
        assertEq(uint8(royaltyRouter.destination()), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING);
        assertEq(royaltyRouter.receiver(), a.receiver);
        assertEq(royaltyRouter.coordinator(), a.coordinator);
    }

    /// @dev The add-ons' values the collection and tickets carry: the placeholders' five texts, the royalties' rate and
    /// destination, the page's banner and link.
    function _addOns(BoxSpecV1.BoxSpec memory s)
        internal
        pure
        returns (string[5] memory p, uint16 bps, uint8 dest, bytes32 banner, string memory link)
    {
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (id == BoxSpecV1.ADD_ON_PLACEHOLDERS) {
                (p[0], p[1], p[2], p[3], p[4]) =
                    abi.decode(s.addOns[i].params, (string, string, string, string, string));
            } else if (id == BoxSpecV1.ADD_ON_ROYALTIES) {
                (bps, dest) = abi.decode(s.addOns[i].params, (uint16, uint8));
            } else if (id == BoxSpecV1.ADD_ON_COLLECTION_METADATA) {
                (banner,, link) = abi.decode(s.addOns[i].params, (bytes32, bytes32[], string));
            }
        }
    }

    // ============================================================================================================
    // helpers

    function _copySpec(BoxSpecV1.BoxSpec memory s) internal pure returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(abi.encode(s), (BoxSpecV1.BoxSpec));
    }

    function _edge32(uint32 v, uint8 edge) internal pure returns (uint32) {
        if (edge % 4 == 0) return type(uint32).max;
        if (edge % 4 == 1) return 0;
        if (edge % 4 == 2) return 1;
        return v;
    }

    function _text(uint256 n, string memory seed) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        bytes1 first = bytes(seed)[0];
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(uint8(32 + (uint8(first) + i) % 95));
        }
        return string(b);
    }
}
