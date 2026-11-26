// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetReleaseV2} from "./SetReleaseV2.sol";
import {SetFactoryV2Planner} from "./SetFactoryV2Planner.sol";
import {SetSpecV2} from "./SetTypesV2.sol";
import {SetVaultV2} from "./SetVaultV2.sol";
import {BoxCoordinatorV2} from "../BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../BoxTokenV2.sol";
import {BoxReceiverV2} from "../BoxReceiverV2.sol";
import {BoxLaunchRouterV2} from "../BoxLaunchRouterV2.sol";
import {StarterSetLoaderV2} from "../StarterSetLoaderV2.sol";
import {IBoxHookV2} from "../interfaces/IBoxHookV2.sol";
import {IBoxRegistryV2} from "../interfaces/IBoxRegistryV2.sol";
import {GATE_CLOSED_OPEN_AT, ChunkPart} from "../interfaces/IBoxCoordinatorV2.sol";
import {ReleaseConstantsV2 as RC} from "../interfaces/ReleaseConstantsV2.sol";
import {BoxSpecV1} from "../../box/BoxSpecV1.sol";
import {BoxLayoutV2} from "../libraries/BoxLayoutV2.sol";
import {FactoryChecksCurve, IFactoryChecksCurve} from "../libraries/FactoryChecksCurve.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

/// @notice Stateless release authentication and post-launch readbacks; a failure rolls back the whole creation.
contract SetFactoryV2Checks {
    error ReleaseCode(uint256 slot);
    error ReleaseWiring(uint256 slot);
    error Miswired(uint256 role);

    /// @notice Deployment only: authenticate the manifest and every exposed immutable relationship.
    /// Private immutables and linked addresses are bound by the reviewed runtime hashes in the manifest.
    function verifyRelease(SetReleaseV2 calldata r, address planner) external view {
        verifyCode(r, planner);
        address ci = r.implementations[0];
        _name(ci, "factory()", r.factory, 0);
        _name(ci, "poolManager()", r.poolManager, 0);
        _name(r.registry, "factory()", r.factory, 100);
        _name(r.listingRegistry, "boxRegistry()", r.registry, 101);
        _name(r.listingRegistry, "poolManager()", r.poolManager, 101);
        _name(r.listingRegistry, "weth()", r.weth, 101);
        _name(r.listingRegistry, "lister()", r.platformSafe, 101);
        for (uint256 role = 1; role < 24; ++role) {
            if (r.implementations[role] == address(0)) continue;
            _name(r.implementations[role], "coordinatorImplementation()", ci, role);
            if (role == 2 || role == 5 || role == 6) {
                _name(r.implementations[role], "poolManager()", r.poolManager, role);
            }
        }
        _name(r.implementations[3], "starterSetLoaderImplementation()", r.implementations[19], 3);
        _name(r.implementations[5], "implementation()", r.implementations[5], 5);
        _name(r.implementations[5], "FIT_SAFE()", r.fitSafe, 5);
        _name(r.implementations[5], "PLATFORM_SAFE()", r.platformSafe, 5);
        if (r.fitSafe == r.platformSafe || r.fitSafe.code.length == 0 || r.platformSafe.code.length == 0) {
            revert ReleaseWiring(5);
        }
        (, address callback,) = BoxReceiverV2(payable(r.implementations[5])).receiverCode();
        _name(callback, "receiverImplementation()", r.implementations[5], 107);
    }

    /// @notice Recheck immutable code identity before money moves. Lister changes do not veto later creations.
    function verifyCode(SetReleaseV2 calldata r, address planner) public view {
        for (uint256 i; i < 24; ++i) {
            bool used = i == 0 || i == 1 || i == 2 || i == 3 || i == 5 || i == 6 || i == 19;
            if (used) _hash(r.implementations[i], r.implementationHashes[i], i);
            else if (r.implementations[i] != address(0) || r.implementationHashes[i] != bytes32(0)) revert ReleaseCode(i);
        }
        _hash(planner, r.plannerHash, 200);
        address[13] memory d;
        d[0] = r.registry;
        d[1] = r.listingRegistry;
        d[2] = r.poolManager;
        d[3] = r.weth;
        (bool ok, bytes memory result) = r.implementations[2].staticcall(abi.encodeWithSignature("extension()"));
        if (!ok || result.length != 32) revert ReleaseWiring(2);
        d[4] = abi.decode(result, (address));
        // BoxCoordinatorV2 constructs its sole stateless helper at nonce 1.
        d[5] = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", r.implementations[0], hex"01")))));
        BoxReceiverV2 receiver = BoxReceiverV2(payable(r.implementations[5]));
        (d[6], d[7], d[8]) = receiver.receiverCode();
        for (uint8 i; i < 4; ++i) {
            bytes32 recorded;
            (d[9 + i], recorded) = receiver.feeModule(i + 6);
            if (recorded != r.dependencyHashes[9 + i]) revert ReleaseCode(109 + i);
        }
        for (uint256 i; i < d.length; ++i) {
            _hash(d[i], r.dependencyHashes[i], 100 + i);
        }
        address[] memory directory = IBoxRegistryV2(r.registry).directory();
        bytes32[] memory hashes = new bytes32[](directory.length);
        for (uint256 i; i < directory.length; ++i) {
            if (directory[i] == r.registry || directory[i].code.length == 0) revert ReleaseWiring(102);
            hashes[i] = directory[i].codehash;
        }
        if (keccak256(abi.encode(directory, hashes)) != r.directoryHash) revert ReleaseWiring(102);
    }

    /// @notice Authenticate complete proxy code/arguments, then initial state, money and pool geometry.
    function verify(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, SetFactoryV2Planner.Plan calldata p)
        external
        view
    {
        if (p.roles[0].codehash != _runtimeHash(p.coordinatorInit)) revert Miswired(0);
        if (p.roles[2].codehash != _runtimeHash(p.hookInit)) revert Miswired(2);
        bytes memory order = hex"0105060313";
        for (uint256 i; i < order.length; ++i) {
            if (p.roles[uint8(order[i])].codehash != _runtimeHash(p.codes[i])) revert Miswired(uint8(order[i]));
        }
        _coordinator(r, creator, s, p);
        _custody(creator, s, p);
        _money(r, creator, s, p);
        _pool(r, s, p);
    }

    function _coordinator(
        SetReleaseV2 calldata r,
        address creator,
        SetSpecV2 calldata s,
        SetFactoryV2Planner.Plan calldata p
    ) private view {
        BoxCoordinatorV2 c = BoxCoordinatorV2(p.roles[0]);
        if (
            c.creator() != creator || c.factory() != r.factory || c.registry() != r.registry
                || c.listingRegistry() != r.listingRegistry || c.specHash() != p.specHash || c.boxId() != p.boxId
                || c.q() != s.pricing.token || c.raise() != s.raise || c.creatorBuyAmount() != s.creatorBuy
                || c.pricingListingId() != s.pricing.listingId || c.randomness() != address(0)
                || c.executor() != address(0) || c.gateOpen() || !c.starterSetPending() || c.effectiveOpenAt() != 0
                || c.deadline() != 0 || c.graduated() || c.failed() || c.deadlineDays() != s.deadlineDays
                || c.openAt() != (s.openAt <= block.timestamp ? block.timestamp + 1 : s.openAt)
        ) revert Miswired(0);
        for (uint256 i; i < 24; ++i) {
            if (c.roleAddress(i) != p.roles[i]) revert Miswired(i);
        }
        for (uint8 i = 1; i <= 2; ++i) {
            (bytes32 root, uint256 length) = c.chunkRoot(ChunkPart(i));
            if (root != bytes32(0) || length != 0) revert Miswired(0);
        }
    }

    function _custody(address creator, SetSpecV2 calldata s, SetFactoryV2Planner.Plan calldata p) private view {
        SetVaultV2 v = SetVaultV2(p.roles[3]);
        if (
            !v.initialized() || v.gateOpen() || v.failed() || v.seedReady() || v.inside() != 0 || v.loaded() != 0
                || v.escrowPrincipal() != 0 || v.supplyFloor() != 0 || v.coordinator() != p.roles[0]
                || v.token() != p.roles[1] || v.starterSetLoader() != p.roles[19] || v.creator() != creator
                || v.collection() != s.collection || v.collectionSize() != s.count || v.setHash() != s.setHash
                || v.pickFeeBps() != s.pickFeeBps
        ) revert Miswired(3);
        (uint32 loaded, bytes32 remaining, bool notified) = StarterSetLoaderV2(p.roles[19]).progress();
        if (loaded != 0 || remaining != s.setHash || notified) revert Miswired(19);
    }

    function _money(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, SetFactoryV2Planner.Plan calldata p)
        private
        view
    {
        BoxTokenV2 t = BoxTokenV2(p.roles[1]);
        uint256 supply = t.totalSupply();
        if (
            t.ledger() != address(0) || t.vault() != p.roles[3] || supply == 0 || supply >= BoxSpecV1.ISSUANCE
                || supply != t.balanceOf(r.poolManager) + t.balanceOf(p.roles[0]) + t.balanceOf(creator)
                || t.balanceOf(p.roles[0]) != BoxCoordinatorV2(p.roles[0]).poolShare()
                || (s.creatorBuy == 0 ? t.balanceOf(creator) != 0 : t.balanceOf(creator) == 0)
        ) revert Miswired(1);
        BoxReceiverV2 receiver = BoxReceiverV2(payable(p.roles[5]));
        if (
            receiver.coordinator() != p.roles[0] || receiver.token() != p.roles[1] || receiver.hook() != p.roles[2]
                || receiver.launchRouter() != p.roles[6] || receiver.q() != s.pricing.token
                || receiver.registry() != r.registry || receiver.boxId() != p.boxId
                || receiver.creatorPayee() != creator || receiver.holderLedger() != address(0)
                || receiver.itemLedger() != address(0) || uint8(receiver.buyersChoice()) != 3
                || uint8(receiver.sellersChoice()) != 3 || receiver.graduationSettled()
                || receiver.pendingCreatorPayee() != address(0) || receiver.booked(s.pricing.token) != 0
                || receiver.tBurnPending() != 0
        ) revert Miswired(5);
        BoxLaunchRouterV2 router = BoxLaunchRouterV2(payable(p.roles[6]));
        if (
            !router.bootstrapped() || router.openAt() != GATE_CLOSED_OPEN_AT || router.bootstrapQ() != p.q.bootstrapQ
                || router.coordinator() != p.roles[0] || router.hook() != p.roles[2] || router.token() != p.roles[1]
                || router.q() != s.pricing.token
        ) revert Miswired(6);
    }

    function _pool(SetReleaseV2 calldata r, SetSpecV2 calldata s, SetFactoryV2Planner.Plan calldata p) private view {
        IBoxHookV2 h = IBoxHookV2(p.roles[2]);
        PoolKey memory key = PoolKey(
            Currency.wrap(s.pricing.token),
            Currency.wrap(p.roles[1]),
            RC.V2_POOL_FEE,
            BoxSpecV1.TICK_SPACING,
            IHooks(p.roles[2])
        );
        PoolId id = PoolIdLibrary.toId(key);
        if (
            PoolId.unwrap(h.poolId()) != PoolId.unwrap(id)
                || keccak256(abi.encode(h.poolKey())) != keccak256(abi.encode(key)) || h.coordinator() != p.roles[0]
                || h.receiver() != p.roles[5] || h.launchRouter() != p.roles[6] || h.holderLedger() != address(0)
                || h.currentTradeBatch(true) != 0 || h.currentTradeBatch(false) != 0
        ) {
            revert Miswired(2);
        }
        BoxLayoutV2.Curve memory curve = IFactoryChecksCurve(address(FactoryChecksCurve)).curve(s.raise);
        (int24 low, int24 high, uint128 liquidity) = h.curve();
        (uint160 price,,, uint24 fee) = StateLibrary.getSlot0(IPoolManager(r.poolManager), id);
        if (
            low != curve.tickLower || high != curve.tickUpper || liquidity != curve.liquidity
                || StateLibrary.getLiquidity(IPoolManager(r.poolManager), id) != liquidity
                || price >= curve.sqrtPriceStartX96 || price < curve.sqrtPriceEndX96 || fee != RC.V2_POOL_FEE
                || h.raise() != s.raise || h.deployBlock() != block.number || h.openAt() != GATE_CLOSED_OPEN_AT
                || h.migratedAtBlock() != 0 || h.failed()
        ) revert Miswired(2);
    }

    function _runtimeHash(bytes calldata init) private pure returns (bytes32) {
        return keccak256(init[10:]); // BoxClones' ten-byte constructor followed by the exact runtime and args.
    }

    function _hash(address target, bytes32 expected, uint256 slot) private view {
        if (target.code.length == 0 || expected == bytes32(0) || target.codehash != expected) revert ReleaseCode(slot);
    }

    function _name(address target, string memory signature, address expected, uint256 slot) private view {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(signature));
        if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) != uint160(expected)) revert ReleaseWiring(slot);
    }
}
