// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpec, Listing, ReleaseContext, BoxType} from "./interfaces/SpecTypes.sol";
import {Side, Leg, Dest} from "./interfaces/RecipeTypes.sol";
import {IBoxFactoryV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IBoxRegistryV2, BoxRolesV2 as R} from "./interfaces/IBoxRegistryV2.sol";
import {IListingRegistry, ListingRecord, ListingKind, QParameters} from "./interfaces/IListingRegistry.sol";
import {IListingBurnV21} from "./interfaces/IListingBurnV21.sol";
import {ListingRaises} from "./ListingRegistry.sol";
import {BoxCoordinatorV2Args, CoordinatorV2Config} from "./libraries/BoxCoordinatorV2Args.sol";
import {ChunkLoader} from "./libraries/ChunkLoader.sol";
import {BoxSpecV2} from "./BoxSpecV2.sol";
import {BoxFactoryV2Parts} from "./BoxFactoryV2Parts.sol";
import {IBoxSpecV2Validator} from "./BoxSpecV2Validator.sol";
import {BoxSpecV1} from "../box/BoxSpecV1.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";

/// @notice Anyone may inspect a plan. One current listing supplies validation; immutable arguments store the
/// creation raise and its thresholds. No routes, external price readings or fund transfers.
contract BoxFactoryV2Planner {
    struct Release {
        address factory;
        address registry;
        address listingRegistry;
        address poolManager;
        address weth;
        address randomness;
        bytes32 versionCodeHash;
        address[24] implementations;
    }

    struct Plan {
        bytes32 specHash;
        bytes32 templateId;
        bytes32 salt;
        bytes coordinatorInit;
        bytes hookInit;
        bytes[] codes;
        bytes nonces;
        address[24] roles;
        QParameters q;
        uint256 payment;
        uint256 boxId;
        bytes32[2] chunkRoots;
        uint256[2] chunkLengths;
    }
    error NoCode(address account);
    error UnlistedPileAsset(address asset);
    error PileAssetIsToken();
    /// @notice A box coin is eaten only by its listing's checked burn. Locking it at 0xdEaD would give that
    /// unclaimable address a permanent share of the origin box's holder fees or pile (V21-MONEY-01).
    /// Native ETH and other listed coins still lock; no funds move.
    error BoxTokenNeedsCheckedBurn(address token);
    /// @notice Read-only release-array slot for the ledger-token implementation, never a box role.
    uint256 public constant LEDGER_TOKEN_IMPLEMENTATION = 20;
    /// @notice Read-only release-array slot for the shop implementation, never a box role.
    uint256 public constant SHOP_IMPLEMENTATION = 21;
    /// @notice Read-only release-array slot for the pile implementation, never a box role.
    uint256 public constant PILE_IMPLEMENTATION = 22;
    /// @notice Anyone may read the fixed template domain; no money moves.
    bytes32 public constant TEMPLATE_ID_TAG = keccak256("squarehole.box.template.v2");
    uint256 internal constant NONCE_TOKEN = 1;
    uint256 internal constant CHUNK_MAX = BoxSpecV2.CHUNK_MAX;
    uint16 internal constant ADD_ON_PLACEHOLDERS = 1;
    uint16 internal constant ADD_ON_ROYALTIES = 4;
    uint8 internal constant _TOKEN = 1;
    uint8 internal constant _VAULT = 3;
    uint8 internal constant _COLLECTION = 4;
    uint8 internal constant _RECEIVER = 5;
    uint8 internal constant _LAUNCH_ROUTER = 6;
    uint8 internal constant _TICKETS = 7;
    uint8 internal constant _ROYALTY_ROUTER = 8;
    /// @notice Anyone may read the fixed validator/encoder; neither holds funds.
    IBoxSpecV2Validator public immutable validator;
    /// @notice Anyone may read the fixed argument encoder; no funds move.
    BoxFactoryV2Parts public immutable parts;

    /// @notice Release deployer pins the validator; no funds accepted.
    constructor(address validator_, address parts_) {
        if (validator_.code.length == 0) revert NoCode(validator_);
        validator = IBoxSpecV2Validator(validator_);
        require(parts_.codehash == keccak256(type(BoxFactoryV2Parts).runtimeCode), "WrongFactoryParts");
        parts = BoxFactoryV2Parts(parts_);
    }

    /// @notice Anyone may check a spec against the current listing; no funds move.
    function refusal(Release calldata r, BoxSpec calldata s) public view returns (bytes memory) {
        ReleaseContext memory ctx = context(r, s);
        (uint16 reason, uint16 field) = validator.validate(s, ctx);
        if (reason != 0) return abi.encodeWithSelector(IBoxFactoryV2.InvalidSpec.selector, reason, field);
        uint256 latest = block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS;
        if (s.openAt > latest) return abi.encodeWithSelector(IBoxFactoryV2.OpenAtTooFar.selector, s.openAt, latest);
        if (s.boxType == uint8(BoxType.PILE)) {
            (address asset,) = abi.decode(s.contentsParams, (address, uint256));
            (bool listed,) = IListingRegistry(r.listingRegistry).newestListingOf(asset);
            if (!listed) return abi.encodeWithSelector(UnlistedPileAsset.selector, asset);
        }
        if (s.pricing.token != address(0) && (_eats(s.buyers) || _eats(s.sellers))
            && _uncheckedBoxCoin(r, s.pricing.token, ctx.listing.kind)) {
            return abi.encodeWithSelector(BoxTokenNeedsCheckedBurn.selector, s.pricing.token);
        }
        return "";
    }

    /// @dev Eat without a checked burn locks P at 0xdEaD; refused for a box coin. A box coin is a BOX_TOKEN listing
    /// or this release's ledger T, which the reverse proof (slot-1 clones only) admits as an ordinary listing.
    /// Validation has matched the listing's token to P and admits Eat only as a side's single branch.
    function _uncheckedBoxCoin(Release calldata r, address p, uint8 kind) private view returns (bool) {
        if (kind != uint8(ListingKind.BOX_TOKEN)
            && !BoxClones.isCloneOf(p, r.implementations[LEDGER_TOKEN_IMPLEMENTATION])) return false;
        return IListingBurnV21(r.listingRegistry).checkedBurnSelector(p) == bytes4(0);
    }

    /// @dev AsPaid then Eat (FeeChoice.EatPriceCoin).
    function _eats(Side calldata d) private pure returns (bool) {
        return d.a.leg == uint8(Leg.AsPaid) && d.a.dest == uint8(Dest.Eat);
    }

    /// @notice Anyone may read the single listing context. An unknown id has kind zero and is refused by validation.
    function context(Release calldata r, BoxSpec calldata s) public view returns (ReleaseContext memory ctx) {
        IListingRegistry lr = IListingRegistry(r.listingRegistry);
        if (s.pricing.listingId >= lr.listingCount()) return ctx;
        ListingRecord memory l = lr.listing(s.pricing.listingId);
        ctx.listing = Listing(l.id, l.token, l.decimals, uint8(l.class), uint8(l.kind), l.raise);
    }

    /// @notice Anyone may compute thresholds for a stored creation raise, even after the listing's raise changes.
    /// Unknown ids return zero. Numeric/layout admission belongs to the listing registry.
    function boxQParameters(Release calldata r, uint32 id, uint256 raise) public view returns (QParameters memory q) {
        if (id >= IListingRegistry(r.listingRegistry).listingCount()) return q;
        return ListingRaises.parameters(raise);
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function predictBox(Release calldata r, address creator, BoxSpec calldata s, bytes32 coordinatorSalt)
        external
        view
        returns (address coordinator, address token, bytes32 hookInitCodeHash)
    {
        (Plan memory p,) = _addresses(r, creator, s, coordinatorSalt);
        return (p.roles[R.ROLE_COORDINATOR], p.roles[R.ROLE_TOKEN], keccak256(p.hookInit));
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function predictHook(Release calldata r, address creator, BoxSpec calldata s, bytes32 cs, bytes32 hookSalt)
        external
        view
        returns (address)
    {
        (Plan memory p,) = _addresses(r, creator, s, cs);
        return BoxClones.predict(p.roles[R.ROLE_COORDINATOR], hookSalt, keccak256(p.hookInit));
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function plan(Release calldata r, address creator, BoxSpec calldata s, bytes32 cs, bytes32 hookSalt)
        external
        view
        returns (Plan memory p)
    {
        BoxFactoryV2Parts.Box memory b;
        (p, b.sqrtP1) = _addresses(r, creator, s, cs);
        p.roles[R.ROLE_HOOK] = BoxClones.predict(p.roles[R.ROLE_COORDINATOR], hookSalt, keccak256(p.hookInit));
        p.templateId = templateIdOf(r, s);
        p.payment = p.q.bootstrapQ + s.creatorBuy;
        p.boxId = IBoxRegistryV2(r.registry).boxCount();
        p.nonces = _nonces(s);
        (b.roles, b.q, b.boxId, b.nonces) = (p.roles, p.q, p.boxId, p.nonces);
        b.creator = creator;
        b.receiverImplementation = r.implementations[5];
        (b.registry, b.listingRegistry, b.weth, b.randomness) = (r.registry, r.listingRegistry, r.weth, r.randomness);
        (bytes[] memory args, bytes memory texts) = parts.partArgs(b, s);
        (p.chunkRoots[0], p.chunkLengths[0]) = (ChunkLoader.rootOf(s.metadataTable, CHUNK_MAX), s.metadataTable.length);
        (p.chunkRoots[1], p.chunkLengths[1]) = (ChunkLoader.rootOf(texts, CHUNK_MAX), texts.length);
        p.codes = new bytes[](args.length);
        for (uint256 k; k < args.length; ++k) {
            uint8 role = uint8(p.nonces[k]);
            uint256 slot = role;
            if (role == _TOKEN && p.roles[R.ROLE_HOLDER_LEDGER] != address(0)) slot = LEDGER_TOKEN_IMPLEMENTATION;
            if (role == _VAULT && s.boxType == uint8(BoxType.SHOP)) slot = SHOP_IMPLEMENTATION;
            if (role == _VAULT && s.boxType == uint8(BoxType.PILE)) slot = PILE_IMPLEMENTATION;
            address impl = r.implementations[slot];
            if (impl.code.length == 0) revert NoCode(impl);
            p.codes[k] = role == _ROYALTY_ROUTER
                ? BoxClones.initCodeReceiving(impl, args[k])
                : BoxClones.initCode(impl, args[k]);
        }
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function templateIdOf(Release calldata r, BoxSpec calldata s) public view returns (bytes32) {
        uint16[] memory addOns = new uint16[](s.addOns.length);
        for (uint256 i; i < addOns.length; ++i) {
            addOns[i] = s.addOns[i].id;
        }
        (uint8 class, uint8 kind) = _classOf(r, s.pricing.listingId);
        bytes memory head = abi.encode(
            TEMPLATE_ID_TAG, r.versionCodeHash, s.version, s.boxType, s.layout, s.gradLayout, s.launchFormat, s.artMode
        );
        bytes memory shape = abi.encode(class, kind, _shape(s.buyers), _shape(s.sellers));
        return keccak256(abi.encode(head, shape, keccak256(abi.encode(addOns)), _nonces(s)));
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _classOf(Release calldata r, uint32 id) internal view returns (uint8, uint8) {
        IListingRegistry lr = IListingRegistry(r.listingRegistry);
        if (id >= lr.listingCount()) return (0, 0);
        ListingRecord memory l = lr.listing(id);
        return (uint8(l.class), uint8(l.kind));
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _addresses(Release calldata r, address creator, BoxSpec calldata s, bytes32 cs)
        internal
        view
        returns (Plan memory p, uint160 sqrtP1)
    {
        bytes memory err = refusal(r, s);
        if (err.length != 0) {
            assembly ("memory-safe") { revert(add(err, 32), mload(err)) }
        }
        p.specHash = keccak256(abi.encode(s));
        p.q = boxQParameters(r, s.pricing.listingId, s.raise);
        bytes memory nonces = _nonces(s);
        p.coordinatorInit =
            BoxClones.initCode(r.implementations[R.ROLE_COORDINATOR], _coordinatorArgs(r, creator, s, p, nonces));
        p.salt = keccak256(abi.encode(creator, p.specHash, cs));
        address c = BoxClones.predict(r.factory, p.salt, keccak256(p.coordinatorInit));
        p.roles[R.ROLE_COORDINATOR] = c;
        for (uint256 k; k < nonces.length; ++k) {
            p.roles[uint8(nonces[k])] = _createAddress(c, NONCE_TOKEN + k);
        }
        if (s.boxType == uint8(BoxType.PILE)) {
            (address asset, uint256 seed) = abi.decode(s.contentsParams, (address, uint256));
            if (asset == p.roles[R.ROLE_TOKEN]) revert PileAssetIsToken();
            if (seed != 0) p.roles[R.ROLE_STARTER_SET_LOADER] = p.roles[R.ROLE_VAULT];
        }
        bytes memory hookArgs;
        (hookArgs, sqrtP1) = parts.hookArgs(p.roles, p.q, s);
        p.hookInit = BoxClones.initCode(r.implementations[R.ROLE_HOOK], hookArgs);
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _nonces(BoxSpec calldata s) internal pure returns (bytes memory n) {
        // At most nine unique CREATEs: three core, four collection, holder and item ledgers.
        // Allocate once; repeated concatenation otherwise grows both deployment bytecode and memory work.
        n = new bytes(9);
        assembly ("memory-safe") { mstore(add(n, 32), shl(232, 0x010506)) }
        uint256 k = 3;
        if (s.boxType == uint8(BoxType.NEW_COLLECTION)) {
            k = _appendRole(n, k, _VAULT);
            k = _appendRole(n, k, _COLLECTION);
            if (_hasAddOn(s, ADD_ON_PLACEHOLDERS)) k = _appendRole(n, k, _TICKETS);
        } else if (s.boxType == uint8(BoxType.SHOP) || s.boxType == uint8(BoxType.PILE)) {
            k = _appendRole(n, k, _VAULT);
        }
        k = _appendRole(n, k, _ROYALTY_ROUTER);
        if (_holders(s.buyers) || _holders(s.sellers)) k = _appendRole(n, k, 17);
        if (s.boxType == uint8(BoxType.SHOP) && _hasAddOn(s, 8)) k = _appendRole(n, k, 19);
        if (s.buyers.a.dest == 8 || s.sellers.a.dest == 8) k = _appendRole(n, k, 16);
        // Only shorten the allocated buffer; the disjoint branches above append at most six bytes.
        assembly ("memory-safe") { mstore(n, k) }
    }

    /// @dev Only _nonces calls this, with its nine-byte allocation and k in [3,8].
    function _appendRole(bytes memory n, uint256 k, uint8 role) private pure returns (uint256 next) {
        assembly ("memory-safe") {
            mstore8(add(add(n, 32), k), role)
            next := add(k, 1)
        }
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _coordinatorArgs(
        Release calldata r,
        address creator,
        BoxSpec calldata s,
        Plan memory p,
        bytes memory nonces
    ) internal pure returns (bytes memory) {
        bytes memory byRole = new bytes(24);
        for (uint256 k; k < nonces.length; ++k) {
            // casting to 'uint8' is safe because at most nine parts are created, from nonce 1
            // forge-lint: disable-next-line(unsafe-typecast)
            byRole[uint8(nonces[k])] = bytes1(uint8(NONCE_TOKEN + k));
        }
        if (s.boxType == uint8(BoxType.PILE)) {
            (, uint256 seed) = abi.decode(s.contentsParams, (address, uint256));
            if (seed != 0) byRole[R.ROLE_STARTER_SET_LOADER] = byRole[R.ROLE_VAULT];
        }
        return BoxCoordinatorV2Args.withShop(BoxCoordinatorV2Args.encode(
            CoordinatorV2Config({
                p: s.pricing.token,
                raise: s.raise,
                creatorBuy: s.creatorBuy,
                bootstrapQ: p.q.bootstrapQ,
                creator: creator,
                specHash: p.specHash,
                executor: address(0), // Legacy slot; no on-chain burn executor in CQ11.
                randomness: r.randomness,
                registry: r.registry,
                listingRegistry: r.listingRegistry,
                pricingListingId: s.pricing.listingId,
                openAt: s.openAt,
                deadlineDays: s.deadlineDays,
                nonces: bytes24(byRole)
            })
        ), s.boxType == uint8(BoxType.SHOP));
    }

    /// @dev Internal reserved-recipe detection; admission remains the validator's responsibility.
    function _holders(Side calldata s) private pure returns (bool) { return (s.a.leg == 1 || s.a.leg == 2) && s.a.dest == 6 || s.a.leg == 2 && s.a.dest == 7; }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _shape(Side calldata d) internal pure returns (uint256) {
        return
            uint256(d.a.leg) << 32 | uint256(d.a.dest) << 24 | uint256(d.b.leg) << 16 | uint256(d.b.dest) << 8 | d.split;
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _hasAddOn(BoxSpec calldata s, uint16 id) internal pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return true;
        }
        return false;
    }

    /// @notice Factory/tool callers may compute this value; no funds move.
    function _createAddress(address deployer, uint256 nonce) internal pure returns (address a) {
        assembly ("memory-safe") {
            mstore(0x00, or(shl(248, 0xd6), or(shl(240, 0x94), shl(80, deployer))))
            mstore8(0x16, nonce)
            a := and(keccak256(0x00, 0x17), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
