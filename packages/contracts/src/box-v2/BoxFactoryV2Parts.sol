// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingRegistry} from "./interfaces/IListingRegistry.sol";
import {IFeeModulesV21, IFeeActionV21} from "./interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "./FeeModuleDirectoryV21.sol";
import {BoxSpec, BoxType, PileParams} from "./interfaces/SpecTypes.sol";
import {BoxRolesV2 as R} from "./interfaces/IBoxRegistryV2.sol";
import {IListingBurnV21} from "./interfaces/IListingBurnV21.sol";
import {QParameters} from "./interfaces/IListingRegistry.sol";
import {BoxTokenV2Args} from "./interfaces/IBoxTokenV2.sol";
import {BoxCollectionV2Args} from "./libraries/BoxCollectionV2Args.sol";
import {BoxHookV2Args} from "./libraries/BoxHookV2Args.sol";
import {BoxLaunchRouterV2Args} from "./libraries/BoxLaunchRouterV2Args.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "./libraries/BoxReceiverV2Args.sol";
import {BoxRoyaltyRouterV2Args} from "./libraries/BoxRoyaltyRouterV2Args.sol";
import {BoxTicketsV2Args} from "./libraries/BoxTicketsV2Args.sol";
import {BoxVaultV2Args} from "./libraries/BoxVaultV2Args.sol";
import {M2SeamArgs} from "./libraries/M2SeamArgs.sol";
import {BoxSpecV2} from "./BoxSpecV2.sol";
import {BoxLayoutV2} from "./libraries/BoxLayoutV2.sol";
import {Side, FeeChoice} from "./interfaces/RecipeTypes.sol";
import {BoxSpecV1} from "../box/BoxSpecV1.sol";
import {BoxKind, RoyaltyDestination} from "../box/interfaces/BoxTypes.sol";

/// @notice Stateless clone-argument encoder. Callers supply a validated spec; no funds move.
contract BoxFactoryV2Parts {
    struct Box {
        address[24] roles;
        QParameters q;
        uint256 boxId;
        address registry;
        address listingRegistry;
        address weth;
        address randomness;
        uint160 sqrtP1;
        bytes nonces;
        address creator;
        address receiverImplementation;
    }

    uint16 internal constant ADD_ON_PLACEHOLDERS = 1;
    uint16 internal constant ADD_ON_ROYALTIES = 4;
    uint16 internal constant ADD_ON_COLLECTION_PAGE = 6;
    uint8 internal constant REVEAL_ON_EXIT = 1;
    uint8 internal constant REVEAL_ALWAYS = 4;
    error AmountTooLarge(uint256 amount);
    error UnknownRole(uint256 role);
    error InvalidChoice();

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function hookArgs(address[24] calldata roles, QParameters calldata q, BoxSpec calldata s)
        external
        pure
        returns (bytes memory args, uint160 sqrtP1)
    {
        BoxLayoutV2.Curve memory c = BoxLayoutV2.curve(s.raise, false);
        args = BoxHookV2Args.encode(
            BoxHookV2Args.Args({
                q: s.pricing.token,
                token: roles[R.ROLE_TOKEN],
                sqrtP1: c.sqrtPriceLowerX96,
                sqrtP0: c.sqrtPriceUpperX96,
                launchRouter: roles[R.ROLE_LAUNCH_ROUTER],
                kind: uint8(BoxKind.Standard),
                tickLower: c.tickLower,
                tickUpper: c.tickUpper,
                liquidity: c.liquidity,
                raise: s.raise,
                coordinator: roles[R.ROLE_COORDINATOR],
                receiver: roles[R.ROLE_RECEIVER],
                tipMaxQ: q.tipMaxQ,
                stepMinQ: q.swapStepMinQ
            })
        );
        args = BoxHookV2Args.withHolderLedger(args, roles[R.ROLE_HOLDER_LEDGER]);
        sqrtP1 = c.sqrtPriceLowerX96;
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function partArgs(Box calldata b, BoxSpec calldata s)
        external
        view
        returns (bytes[] memory args, bytes memory texts)
    {
        args = new bytes[](b.nonces.length);
        for (uint256 k; k < args.length; ++k) {
            args[k] = _args(uint8(b.nonces[k]), b, s);
        }
        texts = _texts(s);
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _args(uint8 role, Box calldata b, BoxSpec calldata s) internal view returns (bytes memory) {
        address[24] calldata a = b.roles;
        (address c, address t, address q) = (a[R.ROLE_COORDINATOR], a[R.ROLE_TOKEN], s.pricing.token);
        if (role == R.ROLE_TOKEN) {
            return BoxTokenV2Args.encode(c, a[R.ROLE_VAULT], a[R.ROLE_HOLDER_LEDGER], BoxSpecV1.ISSUANCE, s.tokenName, s.tokenSymbol);
        }
        if (role == R.ROLE_RECEIVER) return _receiverArgs(b, s);
        if (role == R.ROLE_LAUNCH_ROUTER) {
            return BoxLaunchRouterV2Args.encode(q, t, a[R.ROLE_HOOK], c, b.sqrtP1, b.q.bootstrapQ);
        }
        if (role == R.ROLE_HOLDER_LEDGER) {
            bytes memory args = M2SeamArgs.holder(c, t, a[R.ROLE_HOOK], a[R.ROLE_RECEIVER], q);
            uint8 mask = _tMask(s, 6);
            return mask == 0 ? args : bytes.concat(args, bytes1(mask));
        }
        if (role == R.ROLE_ITEM_LEDGER) {
            return _itemArgs(b, s);
        }
        if (role == R.ROLE_STARTER_SET_LOADER) {
            (, bytes calldata params) = _addOn(s, 8);
            (bytes32 setHash, uint32 count) = abi.decode(params, (bytes32, uint32));
            return M2SeamArgs.starter(c, a[R.ROLE_VAULT], setHash, count);
        }
        if (role == R.ROLE_VAULT && s.boxType == uint8(BoxType.SHOP)) {
            // Contents are an opaque, committed M2-00 payload after the fixed wiring prefix.
            bytes memory args = M2SeamArgs.shop(c, t, a[R.ROLE_STARTER_SET_LOADER], s.contentsParams);
            if (s.sellers.a.leg == 2 && s.sellers.a.dest == 7) args = bytes.concat(args, bytes1(abi.decode(s.sellers.a.destParams, (uint8))));
            return args;
        }
        if (role == R.ROLE_VAULT && s.boxType == uint8(BoxType.PILE)) {
            PileParams memory pile = abi.decode(s.contentsParams, (PileParams));
            bytes memory args = abi.encodePacked(c, t, pile.asset, b.creator, pile.seedAmount);
            if (s.contentsParams.length == 96) {
                (,, uint16 leave) = abi.decode(s.contentsParams, (address, uint256, uint16));
                return bytes.concat(args, bytes2(leave));
            }
            return args;
        }
        if (role == R.ROLE_VAULT) {
            return BoxVaultV2Args.encode(
                BoxVaultV2Args.Args(
                    c, t, a[R.ROLE_COLLECTION], a[R.ROLE_TICKETS], a[R.ROLE_ITEM_LEDGER], s.n, s.pickFeeBps, s.firstId
                )
            );
        }
        if (role == R.ROLE_COLLECTION) return _collectionArgs(a, s);
        if (role == R.ROLE_TICKETS) {
            string[5] memory ph = _placeholders(s);
            return BoxTicketsV2Args.encode(
                BoxTicketsV2Args.Args(
                    c, a[R.ROLE_VAULT], a[R.ROLE_COLLECTION], t, b.randomness, s.n, s.firstId, ph[0], ph[1]
                )
            );
        }
        if (role == R.ROLE_ROYALTY_ROUTER) {
            (, uint8 destination) = _royalty(s);
            return BoxRoyaltyRouterV2Args.withSnapshot(
                BoxRoyaltyRouterV2Args.encode(c, b.weth, RoyaltyDestination(destination)),
                IListingRegistry(b.listingRegistry).sellableVersion());
        }
        // Every additional role needs an explicit argument encoder; never reuse another part's layout.
        revert UnknownRole(role);
    }

    /// @dev Exact S1 206-byte layout. Writes are within the allocation; each address is packed to 20 bytes.
    function _itemArgs(Box calldata b, BoxSpec calldata s) private pure returns (bytes memory) {
        address[24] calldata a = b.roles;
        uint256 policies = uint256(_itemsPolicy(s.buyers)) << 8 | _itemsPolicy(s.sellers);
        address p = s.pricing.token;
        uint256 minimum = b.q.batchMinQ;
        uint256 maximum = b.q.tipMaxQ;
        bytes memory args = new bytes(206);
        assembly ("memory-safe") {
            let d := add(args, 32)
            mstore(d, shl(96, calldataload(a))) // coordinator: role 0
            mstore(add(d, 20), shl(96, calldataload(add(a, 96)))) // vault: role 3
            mstore(add(d, 40), shl(96, calldataload(add(a, 128)))) // collection: role 4
            mstore(add(d, 60), shl(96, calldataload(add(a, 224)))) // tickets: role 7
            mstore(add(d, 80), shl(96, calldataload(add(a, 160)))) // receiver: role 5
            mstore(add(d, 100), shl(96, calldataload(add(a, 64)))) // hook: role 2
            mstore(add(d, 120), shl(96, p))
            mstore(add(d, 140), shl(240, policies))
            mstore(add(d, 142), minimum)
            mstore(add(d, 174), maximum)
        }
        uint8 mask = _tMask(s, 8);
        return mask == 0 ? args : bytes.concat(args, bytes1(mask), bytes20(a[R.ROLE_TOKEN]));
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _collectionArgs(address[24] calldata a, BoxSpec calldata s) internal pure returns (bytes memory) {
        (uint16 bps, uint8 destination) = _royalty(s);
        (bool page, bytes calldata pp) = _addOn(s, ADD_ON_COLLECTION_PAGE);
        return BoxCollectionV2Args.encode(
            BoxCollectionV2Args.Args({
                coordinator: a[R.ROLE_COORDINATOR],
                vault: a[R.ROLE_VAULT],
                token: a[R.ROLE_TOKEN],
                receiver: a[R.ROLE_RECEIVER],
                revealUnlocker: address(0),
                royaltyRouter: a[R.ROLE_ROYALTY_ROUTER],
                marketplaceOwner: s.marketplaceOwner,
                collectionSize: s.n,
                revealTriggers: s.artMode == BoxSpecV2.ART_MODE_HIDDEN ? REVEAL_ON_EXIT : REVEAL_ALWAYS,
                royaltyBps: bps,
                royaltyDestination: destination,
                firstId: s.firstId,
                revealRoot: s.revealRoot,
                generatorHash: s.generatorHash,
                collectionCoverSha256: s.collectionCoverSha256,
                bannerSha256: page ? bytes32(_word(pp, 0)) : bytes32(0),
                name: s.collectionName,
                symbol: s.collectionSymbol
            })
        );
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _texts(BoxSpec calldata s) internal pure returns (bytes memory) {
        if (s.boxType != uint8(BoxType.NEW_COLLECTION)) return "";
        string[5] memory ph = _placeholders(s);
        string memory link;
        (bool page, bytes calldata pp) = _addOn(s, ADD_ON_COLLECTION_PAGE);
        if (page) (,, link) = abi.decode(pp, (bytes32, bytes32[], string));
        return BoxCollectionV2Args.texts(s.description, ph[3], ph[4], link, ph[2]);
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _placeholders(BoxSpec calldata s) internal pure returns (string[5] memory t) {
        (bool found, bytes calldata pp) = _addOn(s, ADD_ON_PLACEHOLDERS);
        if (found) (t[0], t[1], t[2], t[3], t[4]) = abi.decode(pp, (string, string, string, string, string));
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _royalty(BoxSpec calldata s) internal pure returns (uint16 bps, uint8 destination) {
        (bool found, bytes calldata pp) = _addOn(s, ADD_ON_ROYALTIES);
        // casting is safe because `validate()` admits the canonical (uint16, uint8) tuple only
        // forge-lint: disable-next-line(unsafe-typecast)
        destination = uint8(RoyaltyDestination.FeeHandling);
        if (found) (bps, destination) = (uint16(_word(pp, 0)), uint8(_word(pp, 1)));
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _addOn(BoxSpec calldata s, uint16 id) internal pure returns (bool, bytes calldata) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return (true, s.addOns[i].params);
        }
        return (false, s.contentsParams[0:0]);
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _word(bytes calldata p, uint256 i) internal pure returns (uint256 w) {
        if (p.length < (i + 1) * 32) return 0;
        assembly ("memory-safe") {
            w := calldataload(add(p.offset, mul(i, 32)))
        }
    }

    /// @notice Factory/tool callers may encode validated spec data; no funds move.
    function _u128(uint256 a) internal pure returns (uint128) {
        if (a > type(uint128).max) revert AmountTooLarge(a);
        // casting to 'uint128' is safe because the value was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(a);
    }

    /// @notice Internal encoder fixes one choice and the creation thresholds in the receiver clone.
    function _receiverArgs(Box calldata b, BoxSpec calldata s) internal view returns (bytes memory) {
        address[24] calldata a = b.roles;
        ReceiverArgs memory x;
        x.coordinator = a[R.ROLE_COORDINATOR];
        x.hook = a[R.ROLE_HOOK];
        x.p = s.pricing.token;
        x.t = a[R.ROLE_TOKEN];
        x.launchRouter = a[R.ROLE_LAUNCH_ROUTER];
        x.registry = b.registry;
        x.creatorPayee = s.creatorFeeRecipient == address(0) ? b.creator : s.creatorFeeRecipient;
        x.boxId = b.boxId;
        x.batchMinQ = _u128(b.q.batchMinQ);
        x.tipMaxQ = _u128(b.q.tipMaxQ);
        x.stepMinQ = _u128(b.q.swapStepMinQ);
        x.holderLedger = a[R.ROLE_HOLDER_LEDGER];
        x.itemLedger = a[R.ROLE_ITEM_LEDGER];
        x.buyersChoice = _choice(s.buyers);
        x.sellersChoice = _choice(s.sellers);
        if ((s.buyers.a.dest == 6 || s.sellers.a.dest == 6 || x.sellersChoice == 11)
            && x.holderLedger == address(0)) revert InvalidChoice();
        if ((s.buyers.a.dest == 8 || s.sellers.a.dest == 8)
            && x.itemLedger == address(0)) revert InvalidChoice();
        (, x.royaltyDestination) = _royalty(s);
        bytes memory encoded = BoxReceiverV2Args.encode(x);
        if (x.buyersChoice == uint8(FeeChoice.EatPriceCoin) || x.sellersChoice == uint8(FeeChoice.EatPriceCoin)) {
            encoded = bytes.concat(encoded, _priceBurnSelector(b.listingRegistry, s.pricing.token));
        }
        if (x.buyersChoice == 9 || x.sellersChoice == 9) {
            if (encoded.length == BoxReceiverV2Args.LENGTH) encoded = bytes.concat(encoded, bytes4(0));
            encoded = bytes.concat(encoded, bytes20(a[R.ROLE_VAULT]));
        }
        if (x.buyersChoice == 10 || x.sellersChoice == 10) {
            bytes memory padded = new bytes(287);
            for (uint256 i; i < encoded.length; ++i) padded[i] = encoded[i];
            (,, address directory) = IFeeModulesV21(b.receiverImplementation).receiverCode();
            encoded = bytes.concat(padded, _moduleArgs(directory, s.buyers), _moduleArgs(directory, s.sellers));
        }
        return encoded;
    }
    function _moduleArgs(address directory, Side calldata side) private view returns (bytes memory) {
        if (side.a.dest != 9) return abi.encodePacked(bytes20(0), bytes32(0));
        (address module, bytes32 hash) = FeeModuleDirectoryV21(directory).resolve(abi.decode(side.a.destParams, (uint32)));
        if (IFeeActionV21(module).feeActionVersion() != 1) revert InvalidChoice();
        return abi.encodePacked(module, hash);
    }

    /// @dev Encoder only; read the registry's exact ABI word without allocating dynamic return data.
    function _priceBurnSelector(address registry, address token) private view returns (bytes4 selector) {
        bytes4 query = IListingBurnV21.checkedBurnSelector.selector;
        bool ok;
        assembly ("memory-safe") {
            mstore(0, query)
            mstore(4, token)
            ok := staticcall(gas(), registry, 0, 36, 0, 32)
            selector := mload(0)
            ok := and(and(ok, eq(returndatasize(), 32)), iszero(shl(32, selector)))
        }
        if (!ok) revert InvalidChoice();
    }

    /// @notice Internal choice encoder; validator admission precedes all production encoding.
    function _choice(Side calldata s) internal pure returns (uint8) {
        if (s.a.dest == 9) return 10;
        if (
            s.split != 1 || s.splitParams.length != 0 || s.a.legParams.length != 0
                || s.b.leg != 0 || s.b.dest != 0 || s.b.legParams.length != 0 || s.b.destParams.length != 0
        ) revert InvalidChoice();
        if (s.a.leg == 2 && s.a.dest == 7) {
            uint256 preset = _word(s.a.destParams, 0);
            if (s.a.destParams.length != 32 || (preset != 2 && preset != 4 && preset != 8)) revert InvalidChoice();
            return uint8(FeeChoice.ShopT);
        }
        if (s.a.leg != 1 && !(s.a.leg == 2 && (s.a.dest == 6 || s.a.dest == 8))) {
            if (s.a.leg == 2 && s.a.dest == 1 && s.a.destParams.length == 0) return uint8(FeeChoice.Burn);
            revert InvalidChoice();
        }
        if (s.a.dest == 6) {
            if (s.a.destParams.length != 32 || _word(s.a.destParams, 0) != s.a.leg) revert InvalidChoice();
            return uint8(s.a.leg == 2 ? FeeChoice.HoldersT : FeeChoice.Holders);
        }
        if (s.a.dest == 8) {
            _itemsPolicy(s);
            return uint8(s.a.leg == 2 ? FeeChoice.ItemsT : FeeChoice.Items);
        }
        if (s.a.destParams.length != 0) revert InvalidChoice();
        if (s.a.dest == 2) return uint8(FeeChoice.Keep);
        if (s.a.dest == 1) return uint8(FeeChoice.EatPriceCoin);
        if (s.a.dest == 4) return uint8(FeeChoice.Grow);
        if (s.a.dest == 7) return uint8(FeeChoice.Pile);
        revert InvalidChoice();
    }

    function _tMask(BoxSpec calldata s, uint8 dest) private pure returns (uint8) {
        return (s.buyers.a.dest == dest && s.buyers.a.leg == 2 ? 1 : 0)
            | (s.sellers.a.dest == dest && s.sellers.a.leg == 2 ? 2 : 0);
    }

    /// @dev Internal canonical policy check; no absent-byte default or removed item mode.
    function _itemsPolicy(Side calldata s) private pure returns (uint8) {
        if (s.a.dest != 8) return 0;
        bytes calldata params = s.a.destParams;
        // Subtraction wraps zero to MAX; the single range check still refuses every noncanonical word.
        unchecked {
            if (uint256(s.a.leg) - 1 > 1 || params.length != 32) revert InvalidChoice();
        }
        // The exact length is established; load the whole canonical word once, without _word's
        // redundant dynamic index/length arithmetic. High bits remain part of the range check.
        uint256 policy;
        assembly ("memory-safe") { policy := calldataload(params.offset) }
        unchecked { if (policy - 1 > 2) revert InvalidChoice(); }
        // The canonical policy was bounded to 1, 2 or 3 above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(policy);
    }
}
