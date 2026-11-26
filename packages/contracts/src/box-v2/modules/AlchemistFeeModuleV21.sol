// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IFeeActionV21} from "../interfaces/IFeeModulesV21.sol";
import {IBoxReceiverV2} from "../interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {IPileVaultV2} from "../interfaces/IPileVaultV2.sol";
import {BoxClones} from "../../box/libraries/BoxClones.sol";
import {AlchemistRouteV21, AlchemistHopV21} from "./AlchemistRouteV21.sol";

/// @notice A directory CALL action: one immutable price coin, pile coin and route for the whole release.
/// @dev The core retains all split, pending, failure and stipend rules. No storage writes, upgrades or approvals.
contract AlchemistFeeModuleV21 is IFeeActionV21 {
    /// @notice Anyone reads the fixed manager, implementations, coins and route helper; no funds move.
    IPoolManager public immutable poolManager;
    /// @notice Anyone reads the authenticated receiver implementation; no funds move.
    address public immutable receiverImplementation;
    /// @notice Anyone reads the authenticated coordinator implementation; no funds move.
    address public immutable coordinatorImplementation;
    /// @notice Anyone reads the sole input currency (zero means native); no funds move.
    address public immutable priceCoin;
    /// @notice Anyone reads the sole output currency (zero means native); no funds move.
    address public immutable pileCoin;
    /// @notice Anyone reads the immutable, shared route and callback helper; never cloned per box.
    AlchemistRouteV21 public immutable executor;
    /// @notice Anyone reads the pinned executor codehash; no funds move.
    bytes32 public immutable executorCodeHash;
    /// @notice Anyone reads the immutable per-call maximum in raw price coin; no money moves.
    uint256 public immutable inputCap;
    /// @notice Anyone reads the immutable largest raw-P clip a zero minimum moves to box depth; no money moves.
    uint256 public immutable dustMax;
    /// @notice Anyone reads the platform trigger fixed at module creation; no setter or fund authority.
    address public immutable conversionTrigger;
    error InvalidCaller();
    error InvalidBudget();
    /// @notice Exact conversion into this receiver's pile; emitted only after all movements and checks succeed.
    /// P input and pile-coin output have different units. The indexer sums each separately, never as seed.
    event PileConverted(address indexed receiver, address indexed pile, address indexed asset, uint256 amountIn, uint256 amountOut);
    /// @notice A hop's zero minimum moves the whole original raw-P clip, at most dustMax, as claims to the box's hook.
    /// The fixed trigger or seven-day fallback caller starts it after graduation; no swap, tip, seed or pile credit is made.
    event DustToDepth(address indexed receiver, address indexed hook, address indexed asset, uint256 amount);

    /// @notice Release deployer fixes implementations, the route, the cap and the dust size once; deploys one shared helper.
    /// The dust size is positive and at most the cap; a zero-minimum clip above it refuses instead of adding depth.
    constructor(IPoolManager pm, address receiverImpl, address coordinatorImpl, AlchemistHopV21[] memory route, uint256 cap, uint256 dust, address trigger) {
        if (trigger == address(0) || receiverImpl.code.length == 0 || coordinatorImpl.code.length == 0) revert InvalidCaller();
        if (cap == 0 || cap > uint256(uint128(type(int128).max)) || dust == 0 || dust > cap) revert InvalidBudget();
        AlchemistRouteV21 helper = new AlchemistRouteV21(pm,route,dust);
        poolManager = pm; receiverImplementation = receiverImpl; coordinatorImplementation = coordinatorImpl;
        priceCoin = route[0].tokenIn; pileCoin = route[route.length - 1].tokenOut;
        executor = helper; executorCodeHash = address(helper).codehash;
        inputCap = cap; dustMax = dust; conversionTrigger = trigger;
    }
    /// @inheritdoc IFeeActionV21
    function feeActionVersion() external pure returns (uint256) { return 1; }
    /// @inheritdoc IFeeActionV21
    /// @dev ReceiverPendingV21 gates the original caller to the fixed trigger or seven-day fallback.
    /// Authenticated release receiver only, reciprocal coordinator wiring, graduated and not failed.
    /// Reject incompatible boxes at execution without spending their budget; creation tooling checks compatibility.
    /// A hop's zero minimum moves the exact original P claims, at most dustMax, to the authenticated coordinator's hook.
    /// The receiver's named unlock stipend bounds both paths; a refused transfer restores pending for retry.
    function execute(address manager, address asset, uint256 amount) external {
        if (manager != address(poolManager) || asset != priceCoin || amount == 0
            || amount > inputCap) revert InvalidBudget();
        if (!BoxClones.isCloneOf(msg.sender,receiverImplementation)) revert InvalidCaller();
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(IBoxReceiverV2(msg.sender).coordinator());
        if (!BoxClones.isCloneOf(address(c),coordinatorImplementation) || c.receiver() != msg.sender
            || c.poolManager() != manager || !c.graduated() || c.failed()) revert InvalidCaller();
        address pile = c.vault();
        if (pile == address(0) || IPileVaultV2(pile).asset() != pileCoin
            || address(executor).codehash != executorCodeHash) revert InvalidCaller();
        uint256 beforeClaims = poolManager.balanceOf(address(this),uint160(asset));
        if (!poolManager.transfer(address(executor),uint160(asset),amount)) revert InvalidBudget();
        address hook = c.hook();
        uint256 output = executor.convert(pile,amount,hook);
        if (poolManager.balanceOf(address(this),uint160(asset)) != beforeClaims - amount) revert InvalidBudget();
        if (output == 0) emit DustToDepth(msg.sender,hook,asset,amount);
        else emit PileConverted(msg.sender,pile,pileCoin,amount,output);
    }
}
