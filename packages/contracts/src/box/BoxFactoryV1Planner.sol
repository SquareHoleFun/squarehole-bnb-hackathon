// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxFactoryV1} from "./interfaces/IBoxFactoryV1.sol";
import {BoxKind} from "./interfaces/BoxTypes.sol";
import {BoxCloneArgs} from "./libraries/BoxCloneArgs.sol";
import {BoxClones} from "./libraries/BoxClones.sol";
import {BoxData} from "./libraries/BoxData.sol";
import {BoxBuildGuard} from "sh-box-build/BoxBuildV1.sol";

/// @title BoxFactoryV1Planner (slice S7; one per version, beside `BoxFactoryV1`)
/// @notice The pure half of factory v1: from box 0's BoxSpec and the version's fixed values it answers whether the spec
/// is template 0 (`refusal`: `BoxSpecV1.validate()` under version 1's context, then the template-0 rules) and computes
/// everything `createBox` creates: the coordinator clone's and the hook clone's init code, the codes the coordinator
/// CREATEs by nonce (the metadata table's data contract, T, the vault, collection, receiver, launch router, FIT's
/// executor, the tickets, the per-item stream and the royalty router; T's and the executor's as constructor
/// arguments, to which the factory prepends their creation codes), box 0's addresses and the template id. Separate from the
/// factory because one contract with `validate()` (≈ 10 KB), T's creation code (≈ 3.6 KB), the argument encoders and
/// the factory's re-reads measured 36,004 bytes, over EIP-170's 24,576.
///
/// It holds nothing, reads no state, has no immutables and trusts no input: anyone may call it to see exactly what
/// `createBox` would create (the deploy script and the salt miner do). The factory calls it with its own fixed values
/// and does not take its word for what was created: it checks the caller, once, the value, FIT's executor's code hash,
/// the hook's flags and the coordinator's address, and after the launch every contract's code (each clone a clone of
/// the version's implementation) and the wiring and values that bear trust (`BoxFactoryV1._verifyCode`, `_verify`;
/// review of the Misfits line, finding 1). What no re-read covers (the collection's and the tickets' texts, the art
/// commitments but the reveal root and the table, the royalty rate, the curve's arguments behind the pool's re-read)
/// follows from this contract's code, whose hash enters the factory's `versionCodeHash` and so every template id.
///
/// **The nonce plan** (the coordinator's CREATE nonces; `CoreBox0Builder` of SH-core-wave-2, the stand-in this
/// replaces, used the same for 1-8): table 1, T 2, vault 3, collection 4, receiver 5, launch router 6, FIT's executor 7,
/// tickets 8, the per-item stream 9 (S8; every template-0 box has it), royalty router 10 (only with the royalties
/// add-on, so the optional contract comes last and every address is fixed at the factory's deployment).
///
/// **Template 0** (plan § 1 "The Misfits as a BoxSpec"; F44, F53, F65, F77; `_template0Field`): version 1; a new
/// collection; Q native ETH; the buyers' side BUYBACK_BURN_T (box 0's buy-back is FIT's executor itself); the sellers'
/// side PER_ITEM_STREAM (F61 X1, F77: the per-Misfit stream after graduation, so the per-item-stream add-on, which
/// validate() ties to it; BURN_T, core v1's declared gap until S8, is refused since the S7 × S8 integration); hidden
/// art (so the placeholders add-on, which validate() requires for it); the platform Safe as marketplaceOwner;
/// royalties, when present, to box 0's fee handling (the royalty-destination byte of the collection and the receiver
/// is FeeHandling whether or not the add-on is present: without it the collection reports ERC-2981 with
/// (address(0), 0); box 0's own review W3-U1-1, F147). Names, N, texts, the art commitments, the table,
/// the royalty rate and openAt are data, fixed by the spec hash. validate() already refuses, for version 1, a
/// deadline, a creator option or payee, a creator buy, any Q but native ETH, any raise but box 0's, the creator-fee cap
/// and a token-only box.
/// @dev BoxBuildGuard (F78): empty in the mainnet build; the rehearsal build's constructor refuses chain id 1. Written
/// for Square Hole (MIT).
contract BoxFactoryV1Planner is BoxBuildGuard {
    uint8 public constant NONCE_TABLE = 1;
    uint8 public constant NONCE_TOKEN = 2;
    uint8 public constant NONCE_VAULT = 3;
    uint8 public constant NONCE_COLLECTION = 4;
    uint8 public constant NONCE_RECEIVER = 5;
    uint8 public constant NONCE_ROUTER = 6;
    uint8 public constant NONCE_EXECUTOR = 7;
    uint8 public constant NONCE_TICKETS = 8;
    uint8 public constant NONCE_STREAM = 9;
    uint8 public constant NONCE_ROYALTY = 10;
    /// @notice BoxCollection reveal trigger for hidden art: an item is revealed when it leaves the vault
    /// (MisfitsGenesis.sol:176-177: reveal on exit only, no unlocker).
    uint8 public constant REVEAL_ON_EXIT = 1;
    /// @notice The template id's domain tag.
    bytes32 public constant TEMPLATE_ID_TAG = keccak256("squarehole.box.template");

    /// @notice What the version (the factory) fixes, passed beside the spec.
    struct Version {
        address poolManager;
        address randomness;
        address weth;
        address platformSafe;
        address coordinatorImpl;
        address hookImpl;
        address launchRouterImpl;
        address receiverImpl;
        address collectionImpl;
        address vaultImpl;
        address ticketsImpl;
        address royaltyRouterImpl;
        address itemStreamImpl;
        bytes32 versionCodeHash;
        bytes32 executorInitCodeHash;
        /// Box 0's coordinator address (the factory's CREATE nonce 2).
        address coordinator;
        /// Box 0's curve: BoxLayoutV1.curve(raise, Q as currency0).
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtLower;
        uint160 sqrtUpper;
        uint128 liquidity;
        uint256 raise;
    }

    /// @notice What `createBox` creates for one spec.
    struct Plan {
        bytes32 specHash;
        bytes32 templateId;
        IBoxFactoryV1.Box0Addresses a;
        address hook;
        bytes coordinatorInit;
        bytes hookInit;
        /// In nonce order; T's and the executor's entries hold only their constructor arguments (the factory prepends
        /// T's creation code, which it holds, and FIT's executor's, which it was handed and checked by hash).
        bytes[] codes;
    }

    // ================================================================== checks

    /// @notice The revert data `createBox` gives for `spec`'s own checks (empty: accepted): `InvalidSpec(reason,
    /// field)` from validate() under version 1's context, `NotTemplate0(field)`.
    function refusal(BoxSpecV1.BoxSpec memory s, address platformSafe) public pure returns (bytes memory) {
        (uint16 reason, uint16 field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        if (reason != BoxSpecV1.REASON_OK) {
            return abi.encodeWithSelector(IBoxFactoryV1.InvalidSpec.selector, reason, field);
        }
        field = _template0Field(s, platformSafe);
        if (field != 0) return abi.encodeWithSelector(IBoxFactoryV1.NotTemplate0.selector, field);
        return "";
    }

    /// @notice The template id (BC-013): keccak256 of the tag, the version's code hash, the spec's version, box type,
    /// layout, graduated layout, launch format, Q class, both stream actions, art mode, the add-ons that change code or
    /// wiring (placeholders, per-item stream, royalties with their destination, the creator-fee cap) and the module's
    /// code hash (box 0's buy-back module is FIT's executor). Names, N, texts, art, the table, openAt and the
    /// royalty rate are data and do not enter it (box-factory § 3.1).
    function templateIdOf(BoxSpecV1.BoxSpec memory s, bytes32 versionCodeHash, bytes32 executorInitCodeHash)
        public
        pure
        returns (bytes32)
    {
        (uint256 mask, uint8 royaltyDestination) = _behaviourAddOns(s);
        bytes32 moduleCodeHash = s.qStream == BoxSpecV1.Q_STREAM_BUYBACK_BURN_T ? executorInitCodeHash : bytes32(0);
        bytes memory head = abi.encode(
            TEMPLATE_ID_TAG, versionCodeHash, s.version, s.boxType, s.layout, s.gradLayout, s.launchFormat, _qClass(s.q)
        );
        return keccak256(abi.encode(head, s.qStream, s.tStream, s.artMode, mask, royaltyDestination, moduleCodeHash));
    }

    // ================================================================== the plan

    /// @notice Everything `createBox(s, hookSalt, …)` creates, called by `creator`; `specHash` is keccak256(abi.encode(s))
    /// (the factory hashes the encoding it also records).
    function plan(BoxSpecV1.BoxSpec memory s, Version memory v, address creator, bytes32 hookSalt, bytes32 specHash)
        external
        pure
        returns (Plan memory p)
    {
        p.specHash = specHash;
        p.templateId = templateIdOf(s, v.versionCodeHash, v.executorInitCodeHash);
        (uint256 mask,) = _behaviourAddOns(s);
        p.a = addresses(v.coordinator, mask & (1 << BoxSpecV1.ADD_ON_ROYALTIES) != 0);
        p.hookInit = hookInitCode(v, p.a, s.openAt);
        p.hook = BoxClones.predict(v.coordinator, hookSalt, keccak256(p.hookInit));
        p.coordinatorInit = BoxClones.initCode(v.coordinatorImpl, _coordinatorArgs(v, p.a, creator, p.specHash));
        p.codes = _codes(s, v, p.a, p.hook);
    }

    /// @notice Box 0's addresses from its coordinator's (the royalty router only with the royalties add-on; the per-item
    /// stream always, template 0 requires it).
    function addresses(address coordinator, bool royalties) public pure returns (IBoxFactoryV1.Box0Addresses memory a) {
        a.coordinator = coordinator;
        a.table = _createAddress(coordinator, NONCE_TABLE);
        a.token = _createAddress(coordinator, NONCE_TOKEN);
        a.vault = _createAddress(coordinator, NONCE_VAULT);
        a.collection = _createAddress(coordinator, NONCE_COLLECTION);
        a.receiver = _createAddress(coordinator, NONCE_RECEIVER);
        a.launchRouter = _createAddress(coordinator, NONCE_ROUTER);
        a.executor = _createAddress(coordinator, NONCE_EXECUTOR);
        a.tickets = _createAddress(coordinator, NONCE_TICKETS);
        a.itemStream = _createAddress(coordinator, NONCE_STREAM);
        if (royalties) a.royaltyRouter = _createAddress(coordinator, NONCE_ROYALTY);
    }

    /// @notice The hook clone's init code: BoxHook's 203 argument bytes (BoxHookBase notes); the price average is
    /// FIT's executor (box 0's).
    function hookInitCode(Version memory v, IBoxFactoryV1.Box0Addresses memory a, uint32 openAt)
        public
        pure
        returns (bytes memory)
    {
        bytes memory head =
            abi.encodePacked(address(0), a.token, v.sqrtLower, v.sqrtUpper, a.launchRouter, uint8(BoxKind.Box0));
        // casting to 'uint128' is safe because the version's raise is one preset of BoxSpecV1's Q list (4.2e18 wei)
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory mid = abi.encodePacked(v.tickLower, v.tickUpper, openAt, v.liquidity, uint128(v.raise));
        return BoxClones.initCode(
            v.hookImpl, bytes.concat(head, mid, abi.encodePacked(a.coordinator, a.receiver, a.executor))
        );
    }

    // ================================================================== codes

    /// @dev The codes the coordinator CREATEs, in nonce order (NONCE_TABLE … NONCE_STREAM, then NONCE_ROYALTY with the
    /// royalties add-on).
    function _codes(BoxSpecV1.BoxSpec memory s, Version memory v, IBoxFactoryV1.Box0Addresses memory a, address hook)
        internal
        pure
        returns (bytes[] memory codes)
    {
        codes = new bytes[](a.royaltyRouter == address(0) ? NONCE_STREAM : NONCE_ROYALTY);
        codes[NONCE_TABLE - 1] = BoxData.creationCode(s.metadataTable);
        // BoxToken's constructor arguments: the spec's name and symbol, the holder (the coordinator), the vault.
        codes[NONCE_TOKEN - 1] = abi.encode(s.tokenName, s.tokenSymbol, a.coordinator, a.vault);
        codes[NONCE_VAULT - 1] = BoxClones.initCode(v.vaultImpl, _vaultArgs(s, a));
        codes[NONCE_COLLECTION - 1] = BoxClones.initCode(v.collectionImpl, _collectionArgs(s, a));
        codes[NONCE_RECEIVER - 1] = BoxClones.initCode(v.receiverImpl, _receiverArgs(s, v, a, hook));
        // BoxLaunchRouter's 105 argument bytes: box 0, native ETH, T, the hook, the coordinator, P1, openAt (F77: no
        // Safe; box 0's tax goes into its own pool after graduation).
        codes[NONCE_ROUTER - 1] = BoxClones.initCode(
            v.launchRouterImpl,
            abi.encodePacked(uint8(BoxKind.Box0), address(0), a.token, hook, a.coordinator, v.sqrtLower, s.openAt)
        );
        // FitBuybackExecutor's constructor arguments: the PoolManager, T, its launch phase (box 0's coordinator), the
        // hook, the receiver, the seed tick: P1, the curve's lower tick, where graduate() leaves the price (review of
        // the Misfits line, finding 4: seeded at the curve's start, P0, its sample had to walk 26,880 ticks after
        // graduation, 100 a sample, before its first buy and box 0's first deepen(); Standard boxes' samplers start at
        // P1 too). The factory re-reads it.
        codes[NONCE_EXECUTOR - 1] = abi.encode(v.poolManager, a.token, a.coordinator, hook, a.receiver, v.tickLower);
        codes[NONCE_TICKETS - 1] = BoxClones.initCode(v.ticketsImpl, _ticketsArgs(s, v, a));
        codes[NONCE_STREAM - 1] = BoxClones.initCode(v.itemStreamImpl, _streamArgs(s, v, a, hook));
        if (a.royaltyRouter != address(0)) {
            codes[NONCE_ROYALTY - 1] = BoxClones.initCodeReceiving(
                v.royaltyRouterImpl,
                BoxCloneArgs.router(
                    BoxCloneArgs.RouterArgs({
                        coordinator: a.coordinator,
                        receiver: a.receiver,
                        weth: v.weth,
                        destination: BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING
                    })
                )
            );
        }
    }

    /// @dev BoxCoordinator's 154 argument bytes (BoxCoordinator.sol notes): box 0, native ETH, the raise, no creator
    /// buy, the creator, the spec hash, FIT's executor created here (argument zero), the pinned source, the nonce plan
    /// (the per-item stream at NONCE_STREAM, S8).
    function _coordinatorArgs(Version memory v, IBoxFactoryV1.Box0Addresses memory a, address creator, bytes32 specHash)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory head = abi.encodePacked(
            uint8(BoxKind.Box0),
            address(0),
            // casting to 'uint128' is safe because the version's raise is one preset of BoxSpecV1's Q list (4.2e18 wei)
            // forge-lint: disable-next-line(unsafe-typecast)
            uint128(v.raise),
            uint128(0),
            creator,
            specHash,
            address(0),
            v.randomness
        );
        return abi.encodePacked(
            head,
            NONCE_TOKEN,
            NONCE_VAULT,
            NONCE_COLLECTION,
            NONCE_RECEIVER,
            NONCE_ROUTER,
            NONCE_TICKETS,
            a.royaltyRouter == address(0) ? 0 : NONCE_ROYALTY,
            NONCE_STREAM,
            NONCE_EXECUTOR
        );
    }

    /// @dev BoxReceiver's 201 argument bytes: box 0, FIT's executor, the Safe, the per-item stream (S8; box 0's
    /// receiver names it exactly with PER_ITEM_STREAM), the stream actions, fee handling, no creator payee, no swap
    /// module (box 0's buy-back is FIT's executor; the receiver refuses one for box 0), no creator-fee cap.
    function _receiverArgs(
        BoxSpecV1.BoxSpec memory s,
        Version memory v,
        IBoxFactoryV1.Box0Addresses memory a,
        address hook
    ) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            uint8(BoxKind.Box0), address(0), a.token, a.coordinator, hook, a.executor, v.platformSafe, a.itemStream
        );
        return abi.encodePacked(
            head,
            s.qStream,
            s.tStream,
            BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING,
            address(0),
            address(0),
            uint128(0),
            uint8(0)
        );
    }

    function _vaultArgs(BoxSpecV1.BoxSpec memory s, IBoxFactoryV1.Box0Addresses memory a)
        internal
        pure
        returns (bytes memory)
    {
        return BoxCloneArgs.vault(
            BoxCloneArgs.VaultArgs({
                coordinator: a.coordinator,
                token: a.token,
                collection: a.collection,
                ticketAdapter: a.tickets,
                observer: a.itemStream,
                collectionSize: s.n,
                // casting to 'uint16' is safe because the version's fees are 100, 2,500 and 500 bps
                // forge-lint: disable-next-line(unsafe-typecast)
                drawFeeBps: uint16(BoxSpecV1.DRAW_FEE_BPS),
                // forge-lint: disable-next-line(unsafe-typecast)
                pickFeeBps: uint16(BoxSpecV1.PICK_FEE_BPS),
                // forge-lint: disable-next-line(unsafe-typecast)
                returnFeeBps: uint16(BoxSpecV1.RETURN_FEE_BPS),
                firstId: s.firstId
            })
        );
    }

    function _collectionArgs(BoxSpecV1.BoxSpec memory s, IBoxFactoryV1.Box0Addresses memory a)
        internal
        pure
        returns (bytes memory)
    {
        string[5] memory p = _placeholderTexts(s);
        (uint16 bps, bytes32 banner, string memory link) = _royaltyAndPage(s);
        return BoxCloneArgs.collection(
            BoxCloneArgs.CollectionArgs({
                coordinator: a.coordinator,
                vault: a.vault,
                token: a.token,
                receiver: a.receiver,
                revealUnlocker: address(0),
                transferObserver: a.itemStream,
                royaltyRouter: a.royaltyRouter,
                marketplaceOwner: s.marketplaceOwner,
                metadataTable: a.table,
                collectionSize: s.n,
                revealTriggers: REVEAL_ON_EXIT,
                royaltyBps: bps,
                royaltyDestination: BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING,
                firstId: s.firstId,
                revealRoot: s.revealRoot,
                metadataTableHash: keccak256(s.metadataTable),
                generatorHash: s.generatorHash,
                // F74 U3: the collection's cover is field 28; field 23, the logo, is committed by the spec hash only.
                collectionCoverSha256: s.collectionCoverSha256,
                bannerSha256: banner,
                name: s.collectionName,
                symbol: s.collectionSymbol,
                description: s.description,
                hiddenDescription: p[3],
                hiddenSvg: p[4],
                externalLink: link
            })
        );
    }

    function _ticketsArgs(BoxSpecV1.BoxSpec memory s, Version memory v, IBoxFactoryV1.Box0Addresses memory a)
        internal
        pure
        returns (bytes memory)
    {
        string[5] memory p = _placeholderTexts(s);
        return BoxCloneArgs.tickets(
            BoxCloneArgs.TicketsArgs({
                coordinator: a.coordinator,
                vault: a.vault,
                collection: a.collection,
                token: a.token,
                source: v.randomness,
                openAt: s.openAt,
                collectionSize: s.n,
                firstId: s.firstId,
                name: p[0],
                symbol: p[1],
                description: p[2]
            })
        );
    }

    /// @dev BoxItemStream's 182 argument bytes (BoxCloneArgs.stream, S8): the box's contracts, the curve's ticks (which
    /// name box 0's graduated positions, BoxLayoutV1), N and firstId.
    function _streamArgs(
        BoxSpecV1.BoxSpec memory s,
        Version memory v,
        IBoxFactoryV1.Box0Addresses memory a,
        address hook
    ) internal pure returns (bytes memory) {
        return BoxCloneArgs.stream(
            BoxCloneArgs.StreamArgs({
                coordinator: a.coordinator,
                token: a.token,
                collection: a.collection,
                vault: a.vault,
                tickets: a.tickets,
                receiver: a.receiver,
                hook: hook,
                tickLower: v.tickLower,
                tickUpper: v.tickUpper,
                collectionSize: s.n,
                firstId: s.firstId
            })
        );
    }

    // ================================================================== spec reads

    /// @dev The first template-0 rule a version-1-valid spec breaks (its field id), or 0.
    function _template0Field(BoxSpecV1.BoxSpec memory s, address platformSafe) internal pure returns (uint16) {
        if (s.version != 1) return BoxSpecV1.FIELD_VERSION;
        if (s.boxType != BoxSpecV1.BOX_TYPE_NEW_COLLECTION) return BoxSpecV1.FIELD_BOX_TYPE;
        if (s.q != address(0)) return BoxSpecV1.FIELD_Q;
        if (s.qStream != BoxSpecV1.Q_STREAM_BUYBACK_BURN_T) return BoxSpecV1.FIELD_Q_STREAM;
        if (s.tStream != BoxSpecV1.T_STREAM_PER_ITEM_STREAM) return BoxSpecV1.FIELD_T_STREAM;
        if (s.artMode != BoxSpecV1.ART_MODE_HIDDEN) return BoxSpecV1.FIELD_ART_MODE;
        if (s.marketplaceOwner != platformSafe) return BoxSpecV1.FIELD_MARKETPLACE_OWNER;
        (, uint8 royaltyDestination) = _behaviourAddOns(s);
        if (royaltyDestination != 0 && royaltyDestination != BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING) {
            return BoxSpecV1.FIELD_ADD_ON_ROYALTIES_DESTINATION;
        }
        return 0;
    }

    /// @dev The spec's add-ons that change code or wiring, as a bit mask over their ids, and the royalties' destination
    /// (0: no royalties add-on). Callers pass validated specs; on any other a malformed royalties entry decodes as
    /// destination 0.
    function _behaviourAddOns(BoxSpecV1.BoxSpec memory s) internal pure returns (uint256 mask, uint8 destination) {
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (
                id == BoxSpecV1.ADD_ON_PLACEHOLDERS || id == BoxSpecV1.ADD_ON_PER_ITEM_STREAM
                    || id == BoxSpecV1.ADD_ON_ROYALTIES || id == BoxSpecV1.ADD_ON_CREATOR_FEE_CAP
            ) mask |= 1 << id;
            if (id == BoxSpecV1.ADD_ON_ROYALTIES && s.addOns[i].params.length == 64) {
                uint256 d = abi.decode(s.addOns[i].params, (uint256[2]))[1];
                // casting to 'uint8' is safe because only a value below 256 is cast
                // forge-lint: disable-next-line(unsafe-typecast)
                destination = d < 256 ? uint8(d) : type(uint8).max;
            }
        }
    }

    /// @dev The placeholders add-on's five texts (template 0 always has it: hidden art requires it).
    function _placeholderTexts(BoxSpecV1.BoxSpec memory s) internal pure returns (string[5] memory p) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_PLACEHOLDERS) continue;
            (p[0], p[1], p[2], p[3], p[4]) = abi.decode(s.addOns[i].params, (string, string, string, string, string));
        }
    }

    /// @dev The royalties add-on's rate (0 without it) and add-on 6's banner and link (zero and empty without it).
    function _royaltyAndPage(BoxSpecV1.BoxSpec memory s)
        internal
        pure
        returns (uint16 bps, bytes32 banner, string memory link)
    {
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (id == BoxSpecV1.ADD_ON_ROYALTIES) (bps,) = abi.decode(s.addOns[i].params, (uint16, uint8));
            if (id == BoxSpecV1.ADD_ON_COLLECTION_METADATA) {
                (banner,, link) = abi.decode(s.addOns[i].params, (bytes32, bytes32[], string));
            }
        }
    }

    function _qClass(address q) internal pure returns (uint8) {
        BoxSpecV1.QAsset[] memory list = BoxSpecV1.qListV1();
        for (uint256 i; i < list.length; ++i) {
            if (list[i].token == q) return list[i].qClass;
        }
        return 0;
    }

    /// @dev keccak256(rlp([deployer, nonce]))[12:] for 1 ≤ nonce ≤ 127.
    function _createAddress(address deployer, uint256 nonce) internal pure returns (address a) {
        assembly ("memory-safe") {
            mstore(0x00, or(shl(248, 0xd6), or(shl(240, 0x94), shl(80, deployer))))
            mstore8(0x16, nonce)
            a := and(keccak256(0x00, 0x17), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
