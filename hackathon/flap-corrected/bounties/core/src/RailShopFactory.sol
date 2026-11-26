// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RailShop} from "./RailShop.sol";

/// @title RailShopFactory: creates card shops at an address that commits to everything the shop will be
/// @notice The shop's address depends on this factory and on the hash of EVERY creation parameter: the creator, the
/// token, the asset, the router, the collections, their give prices, the pick surcharge and the cap (CREATE2 of a
/// constant init code with that hash as the salt). So a launch's rules can name a shop before the token exists, and the
/// address they name fixes what the shop will be: a shop with any other content lands elsewhere. The factory
/// initializes the shop in the same call; the creator is the caller. A page shows only shops this factory created
/// (`isShop`, `ShopCreated`, and the list per token). No owner, no fee, no setter.
/// The factory accepts only the routers and card collections it was constructed with (on chain 97: Flap's DEX router,
/// PancakeSwap's router and our four test card collections), so a shop's creator cannot bring a router or a collection
/// of its own; someone who wants others deploys another factory, and the site shows only ours.
contract RailShopFactory {
    /// @notice Anyone reads whether this factory created a shop.
    mapping(address => bool) public isShop;
    /// @notice Anyone reads whether a router or a card collection is one this factory accepts (fixed at construction).
    mapping(address => bool) public acceptsRouter;
    mapping(address => bool) public acceptsCollection;
    address[] private _routers;
    address[] private _collections;
    mapping(address => address[]) private _shopsOf;
    mapping(address => mapping(address => address[])) private _shopsBy; // token => creator => shops

    error NotAccepted(address what);

    constructor(address[] memory routers, address[] memory collections) {
        if (routers.length == 0 || collections.length == 0) revert NotAccepted(address(0));
        for (uint256 i; i < routers.length; ++i) {
            if (routers[i].code.length == 0 || acceptsRouter[routers[i]]) revert NotAccepted(routers[i]);
            acceptsRouter[routers[i]] = true;
            _routers.push(routers[i]);
        }
        for (uint256 i; i < collections.length; ++i) {
            if (collections[i].code.length == 0 || acceptsCollection[collections[i]]) revert NotAccepted(collections[i]);
            acceptsCollection[collections[i]] = true;
            _collections.push(collections[i]);
        }
    }

    /// @notice The routers and card collections this factory accepts, as a page lists them.
    function acceptedRouters() external view returns (address[] memory) {
        return _routers;
    }

    function acceptedCollections() external view returns (address[] memory) {
        return _collections;
    }

    event ShopCreated(
        address indexed shop, address indexed creator, address indexed token, address asset, address router, bytes32 paramsHash
    );

    /// @notice The hash every shop's address commits to.
    function paramsHash(
        address creator,
        address token,
        address asset,
        address router,
        address[] calldata collections,
        uint256[] calldata givePrices,
        uint16 pickBps,
        uint256 weeklyCap
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, token, asset, router, collections, givePrices, pickBps, weeklyCap));
    }

    /// @notice The address `create` will use for exactly these parameters (whether or not the token exists yet).
    function shopAddress(
        address creator,
        address token,
        address asset,
        address router,
        address[] calldata collections,
        uint256[] calldata givePrices,
        uint16 pickBps,
        uint256 weeklyCap
    ) external view returns (address) {
        return addressFor(paramsHash(creator, token, asset, router, collections, givePrices, pickBps, weeklyCap));
    }

    /// @notice The address for a parameters hash (`paramsHash`).
    function addressFor(bytes32 hash) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), hash, keccak256(type(RailShop).creationCode)));
        return address(uint160(uint256(h)));
    }

    /// @notice How many shops this factory made for a token; `shopOf(token, i)` reads them in creation order.
    function shopCount(address token) external view returns (uint256) {
        return _shopsOf[token].length;
    }

    function shopOf(address token, uint256 i) external view returns (address) {
        return _shopsOf[token][i];
    }

    /// @notice The shops one creator made for a token, in creation order. Anyone may create shops for any token, so
    /// `shopOf` is an open list a stranger can lengthen; this one holds only that creator's shops, so a page finds the
    /// shops of a launch's own creator without scanning.
    function shopCountBy(address token, address creator) external view returns (uint256) {
        return _shopsBy[token][creator].length;
    }

    function shopOfBy(address token, address creator, uint256 i) external view returns (address) {
        return _shopsBy[token][creator][i];
    }

    /// @notice The caller creates a shop for `token`: income in `asset` (address(0): the native coin), bought into the
    /// token on `router` (a PancakeSwap V2 router), up to four card collections with their give prices in the token, one
    /// pick surcharge, one cap on gives per seven-day period. Everything is fixed here.
    function create(
        address token,
        address asset,
        address router,
        address[] calldata collections,
        uint256[] calldata givePrices,
        uint16 pickBps,
        uint256 weeklyCap
    ) external returns (address shop) {
        if (!acceptsRouter[router]) revert NotAccepted(router);
        for (uint256 i; i < collections.length; ++i) if (!acceptsCollection[collections[i]]) revert NotAccepted(collections[i]);
        bytes32 hash = paramsHash(msg.sender, token, asset, router, collections, givePrices, pickBps, weeklyCap);
        shop = address(new RailShop{salt: hash}());
        RailShop(payable(shop)).initialize(msg.sender, token, asset, router, collections, givePrices, pickBps, weeklyCap);
        isShop[shop] = true;
        _shopsOf[token].push(shop);
        _shopsBy[token][msg.sender].push(shop);
        emit ShopCreated(shop, msg.sender, token, asset, router, hash);
    }
}
