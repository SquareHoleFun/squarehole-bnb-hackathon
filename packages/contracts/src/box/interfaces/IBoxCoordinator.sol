// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BoxKind, BoxPhase} from "./BoxTypes.sol";

/// @title IBoxCoordinator (slice S6; per-box clone, CREATE2'd by the factory, the box's deployer, SH-S0-spikes § 2.2)
/// @notice One box's launcher and graduation. Generalises MisfitsGenesis (src/v2/genesis/MisfitsGenesis.sol:288-339)
/// under D1 and D6; its creation-time re-checks and randomness pin move into the factory (S7; BC-063, BC-101).
///
/// - **`launch()`** (the factory only, once, after S7 created the clones): initialises the collection, vault, tickets
///   (if any), hook, launch router, receiver and the per-item stream (if any, S8), in that order; `hook.launch()` seeds the curve from this contract's
///   T; the bootstrap buy (its T burned here, BC-004); the creator buy if the spec has one (T to the creator,
///   BC-116). The pool share stays here until graduation; T sent here joins it (BC-043).
/// - **`graduate()`** (anyone, once, from the closing block on, also in the closing transaction; BC-026): marks
///   graduated, `hook.migrate(poolShare)` (which harvests once more, topping up the reserve), burns any T dust,
///   `vault.openGate()`, then credits the caller the whole D6 reserve (the Q claims the hook minted here, at most 0.1%
///   of R; nothing from the raise; BC-027) as a claim it pulls with `claimReward`. Then, each in try/catch behind a gas
///   floor (`POKE_GAS()`): `receiver.onGraduation()`, `tickets.requestGraduationWord()`, the executor's `poke()` and
///   (S8) the per-item stream's `onGraduation()`. F126 / M28: its start uses the baseline recorded before the pokes.
/// - **Fail-safe pokes** (BC-098): receiver, tickets, executor and stream failures cannot stop graduation. The
///   reward recipient is not called. A `collect()` just before graduation cannot empty the reward.
/// - No owner, admin, pause, upgrade, setter or rescue (F23 C2).
/// @dev Invariants: `graduate()` succeeds at most once and only after `hook.closed()`; Σ rewardOf ≤ reserveCap; the
/// reserve is credited exactly once; before graduation this contract holds the pool share and the reserve only.
interface IBoxCoordinator is IUnlockCallback {
    /// @notice Box `boxId` launched in its creation transaction; `openAt` is the hook's open (Unix seconds, F80).
    event BoxLaunched(
        uint256 indexed boxId,
        uint256 openAt,
        uint256 bootstrapTokensBurned,
        uint256 creatorBuyQ,
        uint256 creatorBuyTokens
    );
    event Graduated(
        address indexed caller, uint256 blockNumber, uint256 poolShare, uint256 tokenDustBurned, uint256 reward
    );
    event RewardClaimed(address indexed caller, address to, uint256 amount);
    /// @notice A graduation poke failed (reverted or ran out of its gas) and was skipped; graduation happened.
    event PokeFailed(address indexed target, bytes4 selector);

    error ZeroAddress();
    error NotFactory(address caller);
    error AlreadyLaunched();
    error NotLaunched();
    error WrongValue(uint256 sent, uint256 required);
    /// @notice The curve has not closed yet (D1: only the filling swap closes it).
    error NotClosed();
    error AlreadyGraduated();
    /// @notice Sent with too little gas for the pokes' floor.
    error GasTooLow(uint256 gasLeft, uint256 required);
    error NothingToClaim();
    error NotPoolManager();
    error ClaimFailed();

    /// @notice The factory only, once; `msg.value` = the bootstrap plus the spec's creator buy (native-ETH Q).
    function launch() external payable;
    /// @notice Anyone, once, after the close. Returns the reward credited to the caller.
    function graduate() external returns (uint256 reward);
    /// @notice The caller's credited reward, redeemed from the PoolManager and sent to `to` in Q.
    function claimReward(address to) external returns (uint256 amount);

    function phase() external view returns (BoxPhase);
    function graduated() external view returns (bool);
    function graduatedAt() external view returns (uint256);
    function graduatedAtBlock() external view returns (uint256);
    function rewardOf(address account) external view returns (uint256);
    /// @notice The Q claims held as the D6 reserve (credited to the graduation caller at graduation).
    function reserve() external view returns (uint256);
    /// @notice The T this contract holds for the ask until graduation; 0 afterwards.
    function poolShare() external view returns (uint256);
    function POKE_GAS() external view returns (uint256);

    // ------------------------------------------------------------------ wiring (the BoxCreated row's addresses)
    function factory() external view returns (address);
    function boxId() external view returns (uint256);
    function kind() external view returns (BoxKind);
    function specHash() external view returns (bytes32);
    function creator() external view returns (address);
    function poolManager() external view returns (address);
    function token() external view returns (address);
    function q() external view returns (address);
    function raise() external view returns (uint256);
    function creatorBuyAmount() external view returns (uint256);
    function hook() external view returns (address);
    function vault() external view returns (address);
    function collection() external view returns (address);
    function receiver() external view returns (address);
    function launchRouter() external view returns (address);
    /// @notice The tickets add-on, or address(0).
    function tickets() external view returns (address);
    /// @notice The royalty router, or address(0).
    function royaltyRouter() external view returns (address);
    /// @notice The per-item stream, or address(0).
    function itemStream() external view returns (address);
    /// @notice FIT's buy-and-burn executor.
    function executor() external view returns (address);
    /// @notice The chain's pinned drand source.
    function randomness() external view returns (address);
}

/// @notice Box 0 only: the independent graduation snapshot (F126).
interface IBoxStreamBaseline {
    /// @notice Stream T held just after migration, before any graduation poke (F126).
    function streamStartBalance() external view returns (uint256);
    /// @notice Receiver T claims at the same point; includes held curve-depth claims, excluded by the stream.
    function streamStartClaims() external view returns (uint256);

}
