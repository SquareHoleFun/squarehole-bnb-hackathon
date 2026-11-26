// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";

import {BoxRolesV2 as R} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxLaunchRouterV2} from "../../../src/box-v2/BoxLaunchRouterV2.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxRoyaltyRouterV2} from "../../../src/box-v2/interfaces/IBoxPeripheryV2.sol";
import {GATE_CLOSED_OPEN_AT} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IHolderTokenHistoryV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2, ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {IBoxVaultCountV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxSupplyFloor} from "../../../src/box/interfaces/IBoxToken.sol";

/// @notice Stateless factory readbacks. Anyone may verify a plan; no funds move or state is written.
/// Called by STATICCALL; code and argument checks precede state reads. A mismatch rolls creation back.
/// @dev Frozen c969057e checks; only imports/name and this pure test entry differ.
contract ReferenceChecks {
    function curve(uint256 raise) external pure returns (BoxLayoutV2.Curve memory) {
        return BoxLayoutV2.curve(raise, false);
    }

    error Miswired(uint256 check);
    uint256 private constant MW_COORDINATOR = 1;
    uint256 private constant MW_HOOK = 2;
    uint256 private constant MW_PART = 100;

    /// @notice Anyone may verify this release plan and creator; only reads code and state, never moves funds.
    function verify(
        BoxFactoryV2Planner.Release calldata r,
        address creator,
        BoxSpec calldata s,
        BoxFactoryV2Planner.Plan memory p,
        uint256 boxId
    ) external view {
        if (p.roles[0].codehash != _runtimeHash(p.coordinatorInit)) revert Miswired(MW_COORDINATOR);
        if (p.roles[2].codehash != _runtimeHash(p.hookInit)) revert Miswired(MW_HOOK);
        for (uint256 k; k < p.codes.length; ++k) {
            uint256 role = uint8(p.nonces[k]);
            if (p.roles[role].codehash != _runtimeHash(p.codes[k])) revert Miswired(MW_PART + role);
        }
        _verifyCoordinator(r, creator, s, p, boxId);
        _verifyHookAndRouter(s.pricing.token, p.roles);
        IBoxReceiverV2 receiver = IBoxReceiverV2(p.roles[5]);
        if (
            receiver.coordinator() != p.roles[0] || receiver.hook() != p.roles[2] || receiver.token() != p.roles[1]
                || receiver.q() != s.pricing.token || receiver.launchRouter() != p.roles[6]
                || receiver.registry() != r.registry || receiver.boxId() != boxId
                || receiver.holderLedger() != p.roles[R.ROLE_HOLDER_LEDGER] || receiver.itemLedger() != address(0)
                || receiver.creatorPayee() != (s.creatorFeeRecipient == address(0) ? creator : s.creatorFeeRecipient)
        ) {
            revert Miswired(MW_PART + 5);
        }
        _verifyState(r, creator, s, p);
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _verifyState(
        BoxFactoryV2Planner.Release calldata r,
        address creator,
        BoxSpec calldata s,
        BoxFactoryV2Planner.Plan memory p
    ) private view {
        BoxTokenV2 t = BoxTokenV2(p.roles[1]);
        uint256 supply = t.totalSupply();
        if (
            !_names(address(t), BoxTokenV2.ledger.selector, p.roles[R.ROLE_HOLDER_LEDGER])
                || !_names(address(t), BoxTokenV2.vault.selector, p.roles[R.ROLE_VAULT])
                || supply == 0 || supply >= BoxSpecV1.ISSUANCE
                || supply != t.balanceOf(r.poolManager) + t.balanceOf(p.roles[0]) + t.balanceOf(creator)
                || t.balanceOf(p.roles[0]) != IBoxCoordinator(p.roles[0]).poolShare()
                || (s.creatorBuy == 0 ? t.balanceOf(creator) != 0 : t.balanceOf(creator) == 0)
        ) {
            revert Miswired(201);
        }
        _verifyPool(r, s, p);
        uint256 open = _partOpen(p);
        BoxLaunchRouterV2 lr = BoxLaunchRouterV2(payable(p.roles[6]));
        if (!lr.bootstrapped() || lr.openAt() != open || lr.bootstrapQ() != p.q.bootstrapQ) {
            revert Miswired(206);
        }
        IBoxReceiverV2 receiver = IBoxReceiverV2(p.roles[5]);
        uint8 buyers = s.buyers.a.dest == 6 ? 4 : s.buyers.a.leg == 2 ? 2 : s.buyers.a.dest == 2 ? 1 : 3;
        uint8 sellers = s.sellers.a.dest == 6 ? 4 : s.sellers.a.leg == 2 ? 2 : s.sellers.a.dest == 2 ? 1 : 3;
        if (
            uint8(receiver.buyersChoice()) != buyers || uint8(receiver.sellersChoice()) != sellers
                || receiver.graduationSettled() || receiver.pendingCreatorPayee() != address(0)
                || receiver.booked(s.pricing.token) != 0 || receiver.tBurnPending() != 0
        ) {
            revert Miswired(205);
        }
        if (p.roles[R.ROLE_HOLDER_LEDGER] != address(0)) {
            IHolderTokenHistoryV2 history = IHolderTokenHistoryV2(p.roles[1]);
            uint256 checkpoint = history.holderCheckpoint();
            if (checkpoint == 0 || history.eligibleSupplyAt(checkpoint) != history.eligibleBalanceAt(creator, checkpoint)) {
                revert Miswired(201);
            }
        }
        _verifyItems(r, s, p, open);
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _partOpen(BoxFactoryV2Planner.Plan memory p) private view returns (uint256 open) {
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(p.roles[0]);
        bool starter = p.roles[R.ROLE_STARTER_SET_LOADER] != address(0);
        bool gate = p.chunkLengths[0] == 0 && p.chunkLengths[1] == 0 && !starter;
        open = gate ? c.openAt() : GATE_CLOSED_OPEN_AT;
        if (
            c.starterSetPending() != starter || c.gateOpen() != gate || c.effectiveOpenAt() != (gate ? open : 0)
                || c.deadline() != (gate ? open + c.deadlineDays() * 1 days : 0) || c.graduated() || c.failed()
        ) revert Miswired(MW_COORDINATOR);
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _verifyPool(BoxFactoryV2Planner.Release calldata r, BoxSpec calldata s, BoxFactoryV2Planner.Plan memory p)
        private
        view
    {
        IBoxHookV2 h = IBoxHookV2(p.roles[2]);
        PoolKey memory key = PoolKey(
            Currency.wrap(s.pricing.token),
            Currency.wrap(p.roles[1]),
            C.V2_POOL_FEE,
            BoxSpecV1.TICK_SPACING,
            IHooks(p.roles[2])
        );
        PoolId id = PoolIdLibrary.toId(key);
        if (
            PoolId.unwrap(h.poolId()) != PoolId.unwrap(id)
                || keccak256(abi.encode(h.poolKey())) != keccak256(abi.encode(key))
        ) revert Miswired(202);
        BoxLayoutV2.Curve memory curve = BoxLayoutV2.curve(s.raise, false);
        (int24 low, int24 high, uint128 liquidity) = h.curve();
        (uint160 price,,, uint24 lpFee) = StateLibrary.getSlot0(IPoolManager(r.poolManager), id);
        if (
            low != curve.tickLower || high != curve.tickUpper || liquidity != curve.liquidity
                || StateLibrary.getLiquidity(IPoolManager(r.poolManager), id) != liquidity
                || price >= curve.sqrtPriceStartX96 || price < curve.sqrtPriceEndX96 || lpFee != C.V2_POOL_FEE
                || h.raise() != s.raise || h.deployBlock() != block.number || h.openAt() != _partOpen(p)
                || h.migratedAtBlock() != 0 || h.failed()
        ) revert Miswired(202);
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _verifyItems(
        BoxFactoryV2Planner.Release calldata r,
        BoxSpec calldata s,
        BoxFactoryV2Planner.Plan memory p,
        uint256 open
    ) private view {
        address v = p.roles[3];
        address n = p.roles[4];
        if (s.boxType == 4) {
            ShopConfigV2 memory cfg = abi.decode(s.contentsParams, (ShopConfigV2));
            if (!_reads(v, IBoxVaultCountV2.collectionSize.selector, 0)
                || !_reads(v, IBoxVaultCountV2.inside.selector, 0)
                || !_reads(v, IShopVaultV2.budgetT.selector, 0)
                || !_reads(v, IBoxSupplyFloor.supplyFloor.selector, 0)
                || !_reads(v, IShopVaultV2.seedReady.selector, cfg.seedT == 0 ? 1 : 0)) revert Miswired(203);
            if (p.roles[R.ROLE_STARTER_SET_LOADER] != address(0)) {
                (uint32 loaded, bytes32 remaining, bool notified) =
                    IStarterSetLoaderV2(p.roles[R.ROLE_STARTER_SET_LOADER]).progress();
                for (uint256 i; i < s.addOns.length; ++i) {
                    if (s.addOns[i].id != 8) continue;
                    (bytes32 root,) = abi.decode(s.addOns[i].params, (bytes32, uint32));
                    if (loaded != 0 || remaining != root || notified) revert Miswired(MW_PART + 19);
                }
            }
        } else if (v != address(0)) {
            IBoxVaultV2 vault = IBoxVaultV2(v);
            if (
                vault.coordinator() != p.roles[0] || vault.token() != p.roles[1] || vault.collection() != n
                    || vault.collectionSize() != s.n || vault.inside() != s.n || vault.firstId() != s.firstId
                    || vault.ticketAdapter() != p.roles[7] || vault.itemLedger() != address(0)
            ) revert Miswired(203);
            IBoxCollection collection = IBoxCollection(n);
            if (
                collection.collectionSize() != s.n || collection.balanceOf(v) != s.n
                    || collection.ownerOf(s.firstId) != v || collection.ownerOf(s.firstId + s.n - 1) != v
                    || collection.coordinator() != p.roles[0] || collection.vault() != v
                    || collection.royaltyRouter() != p.roles[8]
            ) revert Miswired(204);
        }
        if (p.roles[7] != address(0)) {
            IBoxTickets tickets = IBoxTickets(p.roles[7]);
            if (
                tickets.coordinator() != p.roles[0] || tickets.vault() != v || tickets.collection() != n
                    || tickets.token() != p.roles[1] || tickets.source() != r.randomness
                    || tickets.collectionSize() != s.n || tickets.firstId() != s.firstId || tickets.openAt() != open
            ) {
                revert Miswired(207);
            }
        }
        if (p.roles[8] != address(0)) {
            IBoxRoyaltyRouterV2 royalty = IBoxRoyaltyRouterV2(payable(p.roles[8]));
            if (
                royalty.coordinator() != p.roles[0] || royalty.receiver() != p.roles[5] || royalty.weth() != r.weth
                    || royalty.q() != s.pricing.token
                    || royalty.destination() != IBoxReceiverV2(p.roles[5]).royaltyDestination()
            ) revert Miswired(208);
        }
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _runtimeHash(bytes memory init) private pure returns (bytes32 h) {
        assembly ("memory-safe") { h := keccak256(add(init, 0x2a), sub(mload(init), 10)) }
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _verifyCoordinator(
        BoxFactoryV2Planner.Release calldata r,
        address creator,
        BoxSpec calldata s,
        BoxFactoryV2Planner.Plan memory p,
        uint256 boxId
    ) internal view {
        address c = p.roles[R.ROLE_COORDINATOR];
        address[24] memory a = p.roles;
        // The open is a time by design (F80): Now or a time already reached opens in the next block, as v1's.
        // forge-lint: disable-next-line(block-timestamp)
        uint256 open = s.openAt <= block.timestamp ? block.timestamp + 1 : s.openAt;
        if (
            !_names(c, IBoxCoordinator.token.selector, a[R.ROLE_TOKEN])
                || !_names(c, IBoxCoordinator.hook.selector, a[R.ROLE_HOOK])
                || !_reads(c, IBoxCoordinator.specHash.selector, uint256(p.specHash))
                || !_names(c, IBoxCoordinator.factory.selector, r.factory)
                || !_names(c, IBoxCoordinator.poolManager.selector, r.poolManager)
                || !_names(c, IBoxCoordinator.creator.selector, creator)
                || !_names(c, IBoxCoordinator.q.selector, s.pricing.token)
                || !_reads(c, IBoxCoordinator.raise.selector, s.raise)
                || !_reads(c, IBoxCoordinator.creatorBuyAmount.selector, s.creatorBuy)
                || !_reads(c, IBoxCoordinator.boxId.selector, boxId)
                || !_names(c, IBoxCoordinator.executor.selector, address(0))
                || !_names(c, IBoxCoordinator.randomness.selector, r.randomness)
                || !_reads(c, IBoxCoordinatorV2.pricingListingId.selector, s.pricing.listingId)
                || !_names(c, IBoxCoordinatorV2.registry.selector, r.registry)
                || !_names(c, IBoxCoordinatorV2.listingRegistry.selector, r.listingRegistry)
                || !_reads(c, IBoxCoordinatorV2.openAt.selector, open)
                || !_reads(c, IBoxCoordinatorV2.deadlineDays.selector, s.deadlineDays)
        ) revert Miswired(MW_COORDINATOR);
        if (
            !_names(c, IBoxCoordinator.vault.selector, a[R.ROLE_VAULT])
                || !_names(c, IBoxCoordinator.collection.selector, a[R.ROLE_COLLECTION])
                || !_names(c, IBoxCoordinator.receiver.selector, a[R.ROLE_RECEIVER])
                || !_names(c, IBoxCoordinator.launchRouter.selector, a[R.ROLE_LAUNCH_ROUTER])
                || !_names(c, IBoxCoordinator.tickets.selector, a[R.ROLE_TICKETS])
                || !_names(c, IBoxCoordinator.royaltyRouter.selector, a[R.ROLE_ROYALTY_ROUTER])
        ) revert Miswired(MW_COORDINATOR);
        for (uint256 role; role < R.ROLE_COUNT; ++role) {
            bytes memory call_ = abi.encodeWithSelector(IBoxCoordinatorV2.roleAddress.selector, role);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!_readsCall(c, call_, uint160(a[role]))) revert Miswired(MW_COORDINATOR);
        }
        _verifyChunks(c, p);
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _verifyChunks(address c, BoxFactoryV2Planner.Plan memory p) internal view {
        for (uint256 i; i < 2; ++i) {
            bytes memory call_ = abi.encodeWithSelector(IBoxCoordinatorV2.chunkRoot.selector, i + 1);
            // The coordinator is this release's clone, checked above; one view per part.
            // forge-lint: disable-next-line(calls-loop)
            (bool ok, bytes memory ret) = c.staticcall(call_);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!ok || keccak256(ret) != keccak256(abi.encode(p.chunkRoots[i], p.chunkLengths[i]))) {
                revert Miswired(MW_COORDINATOR);
            }
        }
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _verifyHookAndRouter(address q, address[24] memory a) internal view {
        address h = a[R.ROLE_HOOK];
        if (
            !_names(h, IBoxHookV2.coordinator.selector, a[R.ROLE_COORDINATOR])
                || !_names(h, IBoxHookV2.token.selector, a[R.ROLE_TOKEN]) || !_names(h, IBoxHookV2.q.selector, q)
                || !_names(h, IBoxHookV2.receiver.selector, a[R.ROLE_RECEIVER])
                || !_names(h, IBoxHookV2.launchRouter.selector, a[R.ROLE_LAUNCH_ROUTER])
                || !_names(h, IBoxHookV2.holderLedger.selector, a[R.ROLE_HOLDER_LEDGER])
        ) revert Miswired(MW_HOOK);
        bool holders = a[R.ROLE_HOLDER_LEDGER] != address(0);
        if (IBoxHookV2(h).currentTradeBatch(true) != (holders ? 1 : 0)
            || IBoxHookV2(h).currentTradeBatch(false) != (holders ? 2 : 0)) revert Miswired(MW_HOOK);
        address lr = a[R.ROLE_LAUNCH_ROUTER];
        if (
            !_names(lr, IBoxLaunchRouter.coordinator.selector, a[R.ROLE_COORDINATOR])
                || !_names(lr, IBoxLaunchRouter.hook.selector, h)
                || !_names(lr, IBoxLaunchRouter.token.selector, a[R.ROLE_TOKEN])
                || !_names(lr, IBoxLaunchRouter.q.selector, q)
        ) revert Miswired(MW_PART + R.ROLE_LAUNCH_ROUTER);
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _reads(address target, bytes4 selector, uint256 expected) internal view returns (bool yes) {
        assembly ("memory-safe") {
            mstore(0x00, selector)
            let ok := staticcall(gas(), target, 0x00, 0x04, 0x00, 0x20)
            yes := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), expected)))
        }
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _names(address target, bytes4 selector, address expected) internal view returns (bool) {
        return _reads(target, selector, uint160(expected));
    }

    /// @dev Internal plan verification; only reads code and state, never moves funds.
    function _readsCall(address target, bytes memory call_, uint256 expected) internal view returns (bool yes) {
        assembly ("memory-safe") {
            let ok := staticcall(gas(), target, add(call_, 0x20), mload(call_), 0x00, 0x20)
            yes := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), expected)))
        }
    }
}
