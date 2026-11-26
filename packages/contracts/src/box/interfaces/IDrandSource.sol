// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IDrandSource (slice S9; one shared contract per chain, no clone)
/// @notice The randomness of every box: drand quicknet only (F61 R4; no Chainlink or other backup exists or can be
/// switched to, BC-053). One word per (consumer, key), pulled with `wordOf`; the source never calls a consumer.
/// Generalises ChainlinkDrandSource (src/v2/ChainlinkDrandSource.sol:66-406) without its VRF half: the drand half
/// (`:255-267` `postRound`, `:299-307` `roundAt` / `roundTime`, the BLS check in src/v2/libraries/DrandQuicknet.sol).
///
/// - **Request** (`request`, by the consumer): fixes, for (msg.sender, key), the first round at least `MARGIN()` =
///   12 s after the request (F54; auto-reveal-and-fast-draws § 3.1, the 12 s row), so the word is
///   unknown to everyone, the requester and the block proposer included, when the request lands. Free: `msg.value`
///   is a posting bounty added to that round's pot, never a fee. Once per (consumer, key).
/// - **Post** (`postRound`, anyone: our keeper, the page, the open-source bot, a bounty hunter; F66 K6): once per
///   round, from the round's own time on, verified on chain against quicknet's group key; the round's whole pot is
///   credited to the poster, who pulls it (`withdrawBounty`). A round has exactly one valid signature, so the poster
///   chooses only the moment; `readyAt` is that moment.
/// - **Silence** (R4): a requested word with no post `SILENCE()` = 7 days after its request is silent (`isSilent`);
///   the consumer (BoxTickets) then lets anyone enter terminal mode. The source keeps answering honestly later; a late
///   word is the consumer's to ignore.
/// - No owner, admin, pause, upgrade, setter or fee (F23 C2). Pinned per chain by address and code hash (chains 1 and
///   11155111; BC-101): CREATE2 through the canonical deployer with no constructor input.
/// @dev Invariants: `wordOf` never changes once non-zero and answers within 50,000 gas in every state; the round of a
/// request is strictly later than its block; words are domain-separated per (consumer, key); ETH held == Σ unposted
/// pots + Σ unwithdrawn bounties.
interface IDrandSource {
    /// @notice A request: the round fixed for (consumer, key) and the bounty it added to that round.
    event Requested(address indexed consumer, uint256 indexed key, uint256 round, uint256 bounty);
    /// @notice Anyone added to a round's pot (the keeper or the page, for rounds a consumer waits on).
    event BountyAdded(uint256 indexed round, address indexed from, uint256 amount);
    event RoundPosted(uint256 indexed round, bytes32 randomness, address indexed poster, uint256 bounty);
    event BountyWithdrawn(address indexed poster, address to, uint256 amount);

    error ZeroAddress();
    error AlreadyRequested(address consumer, uint256 key);
    error InvalidRound(uint256 round);
    error RoundNotYet(uint256 round, uint256 at);
    error RoundKnown(uint256 round);
    error InvalidSignature(uint256 round);
    error NothingOwed();
    error WithdrawFailed();

    /// @notice Requests the word for (msg.sender, `key`). Any consumer contract; `msg.value` (0 allowed) is the
    /// posting bounty for the fixed round. Reverts only on a key already requested by that consumer.
    /// @return round The quicknet round whose randomness will be the word's source.
    function request(uint256 key) external payable returns (uint256 round);

    /// @notice Anyone: adds `msg.value` to the pot of a round not yet posted.
    function addBounty(uint256 round) external payable;

    /// @notice Anyone, once per round, from `roundTime(round)` on: quicknet round `round` with its signature
    /// uncompressed (x ‖ y, 48 bytes each; DrandQuicknet.sol:20-22). Credits the round's pot to msg.sender.
    function postRound(uint256 round, bytes calldata signature) external returns (bytes32 randomness);

    /// @notice The caller's credited bounties, to `to`.
    function withdrawBounty(address payable to) external returns (uint256 amount);

    /// @notice The word for (`consumer`, `key`) and when it became available; (0, 0) until its round is posted. A
    /// word of zero is never valid.
    function wordOf(address consumer, uint256 key) external view returns (bytes32 word, uint64 readyAt);
    /// @notice When (consumer, key) was requested and its round; zeros if never.
    function requestOf(address consumer, uint256 key) external view returns (uint64 requestedAt, uint64 round);
    /// @notice True when (consumer, key) was requested, `SILENCE()` has passed since the request, and no word was ready
    /// by then (none yet, or one posted later). Once true it stays true: a late post never undoes it.
    function isSilent(address consumer, uint256 key) external view returns (bool);
    /// @notice A posted round's randomness (sha256 of the compressed signature) and when it was posted.
    function beaconOf(uint256 round) external view returns (bytes32 randomness, uint64 postedAt);
    /// @notice The pot of a round not yet posted (0 after its post).
    function bountyOf(uint256 round) external view returns (uint256);
    /// @notice Bounties credited to `poster` and not yet withdrawn.
    function owedTo(address poster) external view returns (uint256);
    /// @notice The first quicknet round at or after `timestamp`.
    function roundAt(uint256 timestamp) external pure returns (uint256);
    /// @notice When quicknet publishes round `round` (≥ 1).
    function roundTime(uint256 round) external pure returns (uint256);
    /// @notice 12 seconds (F54).
    function MARGIN() external view returns (uint256);
    /// @notice 7 days (F61 R4).
    function SILENCE() external view returns (uint256);
}
