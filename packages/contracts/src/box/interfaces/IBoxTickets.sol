// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, ItemReveal, TicketPhase} from "./BoxTypes.sol";

/// @title IBoxTickets (add-on 1 `placeholders`; slice S3; per-box clone with immutable arguments)
/// @notice The vault's ticket adapter and the placeholder NFT, for any new-collection box that picks the add-on
/// (F55). A copy of MisfitsPlaceholders (src/v2/MisfitsPlaceholders.sol:53-801) and PlaceholderToken
/// (src/v2/PlaceholderToken.sol:19-175) with the add-on's texts as data and drand as the only source (F61 R4):
///
/// - **Curve** (from openAt, a clock time (F80), until graduation): `take` k placeholders (the vault's quote ⌈A·k/n⌉
///   plus the 1% draw fee, burned); `handBack` (the return quote less 5%). A placeholder carries no number yet.
/// - **Graduation**: takes and hand-backs close, q is fixed, transfers freeze until the graduation word (key 0) is
///   stored. The coordinator's graduation poke calls `requestGraduationWord()` (anyone may; free, `msg.value` is a
///   posting bounty); `acceptGraduationWord()` stores it; slot j then holds item firstId + π_w(j) and `open` delivers
///   it with its reveal in one transaction.
/// - **Draws** after graduation: one word per ticket (key = ticket id), settled strictly in request order.
/// - **Silence → terminal mode**: a queue head without a usable word `SILENCE()` (7 days, the source's) after its
///   request, or `SILENCE_UNREQUESTED()` (30 days) after graduation when nobody requested the graduation word, lets
///   anyone `enterTerminal()` for good: fee-free cancels and number-less hand-backs; `takeByNumber` from
///   `TAKE_DELAY()` (3 days). Both silences start the second after their deadline (a word ready at the deadline still
///   counts), while the graces open at their edge. After the 30 days, until someone enters terminal mode, anyone may
///   still request the graduation word (or draw, which requests it): that late request gives the word a new 7-day
///   clock, the never-stuck runbook's rescue (F142; box 0's own review FQ-27, FQ-30, F147).
/// - **Safety net** (F55; auto-reveal § 1.7): an item handed over without its reveal opens after `REVEAL_GRACE()`
///   (30 days) and can be returned unrevealed `RETURN_GRACE()` (30 days, down from v2's 180) after it left, so an
///   unrevealed item is returnable about 60 days after its number was fixed (`returnableFrom`, read by the vault).
/// - Payments run through this contract; no T or ETH stays here after a call except bounties forwarded to the
///   source. No owner, setter, pause, upgrade, rescue or mint outside `take` (F23 C2).
/// @dev Invariants: every live placeholder holds a distinct slot < q; minted − burned == live placeholders; a number
/// is assigned to at most one placeholder or draw; the vault's pending tickets == live placeholders + draws not yet
/// opened or cancelled.
interface IBoxTickets {
    /// @notice One draw ticket, as `drawTicket` reports it (MisfitsPlaceholders.sol:82-90).
    struct DrawView {
        address drawer;
        DrawStatus status;
        uint256 requestedAt;
        uint256 itemId;
        uint256 revealFallbackAt;
    }

    /// @notice The phase slot (MisfitsPlaceholders.sol:95-103).
    struct TicketState {
        uint40 minted;
        uint32 slots;
        uint40 wordRequestedAt;
        uint40 wordAcceptedAt;
        uint40 terminalAt;
        uint32 drawsRequested;
        uint32 drawsSettled;
    }

    // ERC-721 surface of the placeholder (PlaceholderToken.sol:31-33)
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event PlaceholdersTaken(
        address indexed taker, uint256 firstTokenId, uint256 count, uint256 principal, uint256 fee, uint256 firstSlot
    );
    event PlaceholdersHandedBack(address indexed holder, uint256 count, uint256 principal, uint256 fee);
    event GraduationWordRequested(address indexed requester, uint256 round, uint256 bounty);
    event GraduationWordStored(bytes32 word, uint256 placeholders, uint256 readyAt);
    /// @param bounty the ETH this draw put into its round's pot (`msg.value` less the refund; review of sh-f75)
    event DrawRequested(
        uint256 indexed ticketId, address indexed drawer, uint256 principal, uint256 fee, uint256 round, uint256 bounty
    );
    event DrawSettled(uint256 indexed ticketId, uint256 indexed itemId, bytes32 word);
    /// @param kind 1 a placeholder, 2 a draw ticket
    /// @param outsideSince when its stream share starts: graduation for a placeholder, the request for a draw
    event Opened(
        uint256 indexed tokenOrTicket,
        uint8 kind,
        uint256 indexed itemId,
        address indexed holder,
        bool revealed,
        uint256 outsideSince
    );
    event TicketCancelled(uint256 indexed ticketId, address indexed drawer, uint256 principal);
    /// @param deadKey the silent queue head: 0 the graduation word, otherwise a draw ticket id
    event TerminalModeEntered(uint256 timestamp, uint256 deadKey);
    event TakenByNumber(address indexed taker, uint256 indexed itemId, uint256 principal, uint256 fee, bool revealed);

    error ZeroAddress();
    error NotCoordinator(address caller);
    error AlreadyInitialised();
    /// @notice A state-changing call to a clone its coordinator never initialised (SH-S0-spikes decision 9; BC-100).
    /// Added by S3 (docs/evidence/SH-S3-items.md, interface changes).
    error NotInitialised();
    /// @notice `requestGraduationWord` with no placeholder taken (q = 0): no word is needed, π is the identity
    /// (MisfitsPlaceholders.sol:331). Added by S3 (v2's error, dropped from the first interface draft).
    error NoPlaceholders();
    error NonexistentToken(uint256 tokenId);
    error WrongFrom(address from, address owner);
    error NotAuthorized(address operator, uint256 tokenId);
    error DirectSendRefused(address to);
    error UnsafeRecipient(address to);
    error Frozen();
    /// @notice `take` opens at `openAt` (Unix seconds).
    error NotOpenYet(uint256 openAt);
    error TakesClosed();
    error HandBackClosed();
    error DeadlineExpired(uint256 deadline, uint256 timestamp);
    error MaxTokenExceeded(uint256 total, uint256 maxTokenIn);
    error InvalidTokenList();
    error NotHolder(uint256 tokenId);
    error NotGraduated();
    error TerminalMode();
    error NotTerminal();
    error AlreadyTerminal();
    error WordAlreadyRequested();
    error WordNotRequested();
    error WordAlreadyAccepted();
    error WordNotReady();
    error WordNotAccepted();
    error TokenNotPulled();
    error GasTooLow();
    error NothingSettled();
    error UnknownDraw(uint256 ticketId);
    error NotSettled(uint256 ticketId);
    error DrawClosed(uint256 ticketId);
    error NotCancellable(uint256 ticketId);
    error NothingPending();
    error HeadNotDead(uint256 key, uint256 deadline);
    error QueueDead(uint256 key, uint256 deadline);
    error TooEarly(uint256 at);
    error IneligibleId(uint256 id);
    error NumberTaken(uint256 id);
    error NotInPool(uint256 id, uint256 poolIndex);
    error RevealRequired(uint256 id, uint256 fallbackAt);
    /// @notice A third party's `openDraw` for a contract drawer before `openFrom` (the drawer chooses the recipient).
    error DrawerOpensFirst(uint256 ticketId, uint256 openFrom);
    /// @notice A draw's `msg.value` cannot bring its quicknet round's posting pot to DRAND_BOUNTY_GAS × the block's base
    /// fee: `pot` is what the pot would hold with all of it (F75 W3; the same selector as `DrandWords.BountyTooLow`,
    /// which BoxTickets reverts with).
    error BountyTooLow(uint256 pot, uint256 needed);

    /// @notice The box's coordinator only (the `coordinator` argument, a clone of `coordinatorImplementation()`), once,
    /// in createBox: records openAt (the `openAt` argument, or block.timestamp + 1 when it is 0 (Now) or not after
    /// block.timestamp: the hook's rule, so both agree) and approves the vault for T.
    function initialize() external;

    // ------------------------------------------------------------------ the curve
    function take(uint256 count, uint256 maxTokenIn, uint256 deadline) external returns (uint256 firstTokenId);
    function handBack(uint256[] calldata tokenIds, uint256 minTokenOut, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);

    // ------------------------------------------------------------------ the graduation word (key 0)
    /// @notice Anyone, once, after graduation (the coordinator's graduation poke calls it in try/catch); `msg.value`
    /// is forwarded as the posting bounty.
    function requestGraduationWord() external payable;
    /// @notice Anyone, once the word is usable (ready within SILENCE of its request).
    function acceptGraduationWord() external;

    // ------------------------------------------------------------------ draws
    /// @notice One draw: the vault's quote for one plus the 1% draw fee (at most `maxTokenIn`), and the posting bounty
    /// of the ticket's round (which the graduation word shares if this draw requests it) from `msg.value`. F75 W3: the
    /// draw tops the round's pot up to DRAND_BOUNTY_GAS (600,000) × the block's base fee and sends the rest of
    /// `msg.value` back to the caller in the same call (review of sh-f75); a caller that refuses ETH still draws and
    /// its rest joins the pot. It reverts `BountyTooLow(pot + msg.value, needed)` when `msg.value` cannot reach the
    /// target. So the first draw of a round pays the bounty (about 0.0003 ETH at 0.5 gwei) and later draws of that
    /// round get all they sent back at the same base fee; a later draw at a higher base fee tops the pot up to its own
    /// block's target and gets back the rest (on mainnet two draws share a round only inside one block, so one base
    /// fee; box 0's own review FQ-29, F147). The pot is paid to whoever posts the round (usually the drawer's own
    /// page). The block that includes the draw fixes its round, so a page cannot see that round's pot: it sends the
    /// whole target at the highest base fee it accepts (600,000 × its maxFeePerGas) and receives the excess back.
    function draw(uint256 maxTokenIn, uint256 deadline) external payable returns (uint256 ticketId);
    function settle(uint256 maxCount) external returns (uint256 settled);

    // ------------------------------------------------------------------ opening
    function open(uint256 tokenId, ItemReveal calldata r) external returns (uint256 itemId);
    /// @notice Settles the queue up to `ticketId` if needed, then delivers the drawn item with its reveal: to `to` (or
    /// the drawer when zero) if the drawer calls; to the drawer if anyone else does. A third party may open a
    /// contract drawer's draw only from REVEAL_GRACE after its settlement (`DrawerOpensFirst`); a drawer without code
    /// (or an EIP-7702 account) may be served at once, the keeper's fast open (review of sh-core-v1). The grace runs
    /// from the settlement rounded up to the hour, at most 65,535 hours (7.48 years) after the request: a draw settled
    /// later than that has no first-right window (box 0's own review W2-U6-1, F147).
    function openDraw(uint256 ticketId, address to, ItemReveal calldata r) external returns (uint256 itemId);

    // ------------------------------------------------------------------ terminal mode
    function enterTerminal() external;
    function cancelDraw(uint256 ticketId) external returns (uint256 principal);
    function takeByNumber(
        uint256 itemId,
        uint256 poolIndex,
        uint256 maxTokenIn,
        uint256 deadline,
        ItemReveal calldata r
    ) external returns (uint256 principal, uint256 fee);

    // ------------------------------------------------------------------ views
    function phase() external view returns (TicketPhase);
    function numberOf(uint256 tokenId) external view returns (uint256);
    function slotOf(uint256 tokenId) external view returns (uint256);
    function drawTicket(uint256 ticketId) external view returns (DrawView memory);
    function poolPositionAt(uint256 index) external view returns (uint256);
    /// @notice When item `itemId`, handed over by this contract without its reveal, may be returned unrevealed:
    /// RETURN_GRACE after it left; 0 when it left revealed or never through here. The vault asks this.
    function returnableFrom(uint256 itemId) external view returns (uint256);
    function status() external view returns (TicketState memory);
    function graduationWord() external view returns (bytes32);

    function coordinator() external view returns (address);
    /// @notice The version's coordinator implementation: only a clone of it may initialise this add-on (BC-100).
    function coordinatorImplementation() external view returns (address);
    function vault() external view returns (address);
    function collection() external view returns (address);
    function token() external view returns (address);
    /// @notice The chain's pinned drand source (IDrandSource).
    function source() external view returns (address);
    /// @notice When `take` opens (Unix seconds), equal to the hook's `openAt()`; 0 before `initialize`.
    function openAt() external view returns (uint256);
    function collectionSize() external view returns (uint256);
    function firstId() external view returns (uint256);

    function SILENCE() external view returns (uint256);
    function SILENCE_UNREQUESTED() external view returns (uint256);
    function REVEAL_GRACE() external view returns (uint256);
    function TAKE_DELAY() external view returns (uint256);
    function RETURN_GRACE() external view returns (uint256);

    // ------------------------------------------------------------------ the placeholder's ERC-721 surface
    /// @notice The add-on's placeholder name and symbol (params 1, 2), fixed.
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
}
