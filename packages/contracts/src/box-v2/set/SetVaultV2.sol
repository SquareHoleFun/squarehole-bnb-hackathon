// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCloneBase} from "../../box/BoxCloneBase.sol";
import {BoxClones} from "../../box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../../libraries/TransientReentrancyGuard.sol";
import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {IBoxToken} from "../../box/interfaces/IBoxToken.sol";
import {IBoxVaultV2 as V, IBoxVaultItemsV2 as B} from "../interfaces/IBoxVaultV2.sol";
import {VaultViews} from "../libraries/VaultViews.sol";
import {StarterSetLoaderV2} from "../StarterSetLoaderV2.sol";
import {BoxCoordinatorV2Args} from "../libraries/BoxCoordinatorV2Args.sol";
import {SetVaultV2Args as A} from "./SetVaultV2Args.sol";
import {SetAdmissionV2} from "./SetAdmissionV2.sol";
import {SetConstantsV2 as C, SetReason as R} from "./SetConstantsV2.sol";
import {SetRefused} from "./SetTypesV2.sol";

/// @notice Immutable single-collection custody for the existing-NFT add-on. Only committed, creator-owned pulls count.
/// @dev Named supply-share picks and returns only; no approvals or rescue. The unchanged loader verifies every
/// ordered page before calling this vault. Initialization binds its exact implementation AND immutable args.
contract SetVaultV2 is BoxCloneBase, TransientReentrancyGuard {
    error InvalidRequest();
    error Unauthorized(address caller);
    error ReceiptRefused();
    error TransferRefused();
    error TransferGas();

    /// @dev Includes receiver callback; covers three fresh collection slots without a state-gas reservoir.
    uint256 private constant NFT_TRANSFER_GAS = 450_000;
    /// @dev 450k call + 7,143 EIP-150 margin + 20k overhead + 972,857 reserve for a 300k owner read,
    /// receipt handling and first custody writes on Amsterdam. Checked immediately before CALL.
    uint256 private constant MIN_TRANSFER_GAS = 1_450_000;
    /// @dev Includes clone delegatecall, 300k pre-owner read, accounting and the 1.45M transfer floor.
    uint256 private constant RELEASE_GAS = 1_900_000;
    /// @dev Outer bookkeeping reserve after a fully exhausted self-call; EIP-150 and CALL overhead are additional.
    uint256 private constant RELEASE_RESERVE_GAS = 100_000;
    bytes32 private constant RECEIPT_FROM_SLOT = keccak256("SquareHole.SetVaultV2.receipt.from");
    bytes32 private constant RECEIPT_ID_SLOT = keccak256("SquareHole.SetVaultV2.receipt.id");

    /// @notice Release identities, fixed at implementation deployment; no mutable role or upgrade authority.
    address public immutable coordinatorImplementation;
    address public immutable starterSetLoaderImplementation;
    address private immutable _implementation;
    VaultViews private immutable _views;
    /// @notice Initialization, graduation-only conversion gate and permanent failure freeze.
    bool public initialized;
    bool public gateOpen;
    bool public failed;
    enum MemberState {
        Unlisted,
        Inside,
        Outside,
        Released
    }
    mapping(uint256 => MemberState) private _members;
    uint256[] private _loadedIds;
    uint256 private _inside;
    uint256 public escrowPrincipal;

    event SetLoaded(uint256 indexed index, address indexed collection, uint256 indexed id);
    event GateOpened();
    event FailureEntered();
    event ReleaseSucceeded(address indexed collection, uint256 indexed id, address indexed creator);
    event ReleaseDeferred(address indexed collection, uint256 indexed id);

    /// @notice Fix the new release coordinator and unchanged loader implementations, never old deployment addresses.
    constructor(address coordinatorImpl, address loaderImpl) {
        if (
            coordinatorImpl.code.length == 0 || loaderImpl.code.length == 0
                || StarterSetLoaderV2(loaderImpl).coordinatorImplementation() != coordinatorImpl
        ) revert InvalidRequest();
        coordinatorImplementation = coordinatorImpl;
        starterSetLoaderImplementation = loaderImpl;
        _implementation = address(this);
        _views = new VaultViews();
    }

    /// @notice Fixed authenticated coordinator only, once: initialize empty custody and immutable membership terms.
    function initialize() external nonReentrant {
        if (
            initialized || address(this).code.length != BoxClones.ARGS_OFFSET + A.LENGTH
                || !BoxClones.isCloneOf(address(this), _implementation)
        ) revert InvalidRequest();
        address cAddress = coordinator();
        if (msg.sender != cAddress) revert Unauthorized(msg.sender);
        if (
            cAddress.code.length != BoxClones.ARGS_OFFSET + BoxCoordinatorV2Args.LENGTH
                || !BoxClones.isCloneOf(cAddress, coordinatorImplementation)
        ) revert InvalidRequest();
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(cAddress);
        address t = token();
        address l = starterSetLoader();
        address owner = creator();
        uint256 n = collectionSize();
        uint256 fee = pickFeeBps();
        if (
            t.code.length == 0 || c.token() != t || c.vault() != address(this) || l == address(this)
                || c.starterSetLoader() != l || owner == address(0) || owner == address(this) || c.creator() != owner
                || c.failed() || c.graduated() || c.gateOpen() || c.collection() != address(0)
                || c.tickets() != address(0) || c.roleAddress(16) != address(0) || c.roleAddress(17) != address(0)
                || n < C.MIN_COUNT || n > C.MAX_COUNT || setHash() == bytes32(0)
                || (fee != 100 && fee != 500 && fee != 2500)
        ) revert InvalidRequest();
        // The code hash checks proxy, exact length and every loader argument together. A clone naming a
        // different vault/root/count/coordinator cannot become the commitment authority for this vault.
        // n is a four-byte immutable argument, range-checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory loaderArgs = abi.encodePacked(cAddress, address(this), setHash(), uint32(n));
        if (l.codehash != keccak256(BoxClones.runtime(starterSetLoaderImplementation, loaderArgs))) {
            revert InvalidRequest();
        }
        SetAdmissionV2.requireCollection(collection());
        initialized = true;
    }

    /// @notice Fixed loader only, before trading: record exactly one successful creator-owned committed pull.
    /// @dev The authenticated loader checks the whole page's hash/count/duplicates first; any refusal here rolls
    /// back all earlier items, loader progress, membership, receipt state and events in that page.
    function loadStarter(address nft, uint256 id, uint8 tier) external nonReentrant {
        if (!initialized || failed || gateOpen) revert InvalidRequest();
        if (msg.sender != starterSetLoader()) revert Unauthorized(msg.sender);
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(coordinator());
        if (c.failed() || c.graduated() || c.gateOpen() || _loadedIds.length >= collectionSize()) {
            revert InvalidRequest();
        }
        if (nft != collection()) revert SetRefused(R.COLLECTION_MISMATCH, 10);
        if (tier != 0) revert SetRefused(R.NONZERO_TIER, 12);
        if (_members[id] != MemberState.Unlisted) revert SetRefused(R.DUPLICATE_ID, 12);
        _receiveItem(nft, id, creator());
        uint256 index = _loadedIds.length;
        _members[id] = MemberState.Inside;
        _loadedIds.push(id);
        ++_inside;
        emit SetLoaded(index, nft, id);
    }

    /// @notice Only the fixed collection can consume the exact receipt while this vault's pull is locked.
    /// @dev Nonzero expected FROM arms the receipt, not id+1; id zero and max uint256 remain ordinary members.
    function onERC721Received(address operator, address from, uint256 id, bytes calldata) external returns (bytes4) {
        (address expectedFrom, uint256 expectedId) = _receipt();
        if (
            !_insideGuardedCall() || expectedFrom == address(0) || msg.sender != collection()
                || operator != address(this) || from != expectedFrom || id != expectedId
        ) revert ReceiptRefused();
        _expectReceipt(address(0), 0);
        return this.onERC721Received.selector;
    }

    /// @notice Exact recorded deposit completion; never a continuous custody guarantee against an issuer's seizure.
    function seedReady() public view returns (bool) {
        return initialized && !failed && _loadedIds.length == collectionSize();
    }

    /// @notice Fixed coordinator only after graduation and complete loading; trading completion alone cannot open it.
    function openGate() external nonReentrant {
        _onlyCoordinator();
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(coordinator());
        if (gateOpen || !seedReady() || !c.graduated() || c.failed() || !c.gateOpen()) revert InvalidRequest();
        gateOpen = true;
        emit GateOpened();
    }

    /// @notice Fixed coordinator only: freeze intake permanently, with no foreign calls or item iteration.
    function enterFailure() external nonReentrant {
        _onlyCoordinator();
        if (failed || gateOpen) revert InvalidRequest();
        failed = true;
        emit FailureEntered();
    }

    /// @notice Anyone after failure: independently retry up to 32 loaded ids, only to the immutable creator.
    /// @dev Duplicate, unlisted, already released and refused ids are deferred without changing their accounting.
    /// An insufficient outer envelope reverts the whole batch, rather than disguising gas starvation as NFT refusal.
    function releaseToCreator(uint256[] calldata ids) external nonReentrant returns (uint256 released) {
        if (!initialized || !failed) revert InvalidRequest();
        _checkBatch(ids.length);
        address self = address(this);
        address nft = collection();
        for (uint256 i; i < ids.length; ++i) {
            bytes memory data = abi.encodeCall(this.releaseOne, (ids[i]));
            // Immediately before CALL: ceiling + ceil(ceiling/63) + instruction/access allowance + outer reserve.
            // The clone adds another EIP-150 hop inside RELEASE_GAS, covered by that ceiling's measured headroom.
            if (gasleft() < RELEASE_GAS + (RELEASE_GAS + 62) / 63 + 20_000 + RELEASE_RESERVE_GAS) {
                revert TransferGas();
            }
            bool ok;
            assembly ("memory-safe") {
                ok := call(RELEASE_GAS, self, 0, add(data, 32), mload(data), 0, 0)
            }
            if (ok) ++released;
            else emit ReleaseDeferred(nft, ids[i]);
        }
    }

    /// @notice Self only inside the shared recovery lock. Refusal rolls back this item's transfer and accounting.
    /// @dev No admission probes or safe-receiver callback: a contract creator need not implement ERC721Receiver.
    /// Released is distinct from Outside, so retries and unsafe gifts back can never create a second release/return.
    function releaseOne(uint256 id) external {
        if (msg.sender != address(this)) revert Unauthorized(msg.sender);
        if (!_insideGuardedCall() || !failed || _members[id] != MemberState.Inside) revert InvalidRequest();
        address nft = collection();
        address to = creator();
        SetAdmissionV2.requireOwner(nft, id, address(this));
        _members[id] = MemberState.Released;
        --_inside;
        _transferItem(nft, address(this), to, id, false);
        SetAdmissionV2.requireOwner(nft, id, to);
        emit ReleaseSucceeded(nft, id, to);
    }

    /// @notice Fixed clone identity and terms; reads do not move assets.
    function coordinator() public view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    function token() public view returns (address) {
        return _argAddress(A.TOKEN);
    }

    function starterSetLoader() public view returns (address) {
        return _argAddress(A.LOADER);
    }

    function creator() public view returns (address) {
        return _argAddress(A.CREATOR);
    }

    function collection() public view returns (address) {
        return _argAddress(A.COLLECTION);
    }

    function collectionSize() public view returns (uint256) {
        return _argUint(A.COUNT, 4);
    }

    function setHash() public view returns (bytes32) {
        return _argWord(A.HASH);
    }

    function pickFeeBps() public view returns (uint256) {
        return _argUint(A.PICK_FEE, 2);
    }

    /// @notice Accepted members in committed order, one bounded read at a time. Unsafe gifts never appear here.
    function memberAt(uint256 index) external view returns (uint256) {
        if (index >= _loadedIds.length) revert InvalidRequest();
        return _loadedIds[index];
    }

    /// @notice Number of guarded initial deposits, independent of observed NFT balances.
    function loaded() external view returns (uint256) {
        return _loadedIds.length;
    }

    /// @notice Recorded counted custody, including items an issuer later seizes.
    function inside() external view returns (uint256) {
        return _inside;
    }

    /// @notice True only after this committed id's guarded initial deposit succeeds.
    function eligible(uint256 id) external view returns (bool) {
        return _members[id] != MemberState.Unlisted;
    }

    /// @notice True only for a listed member this vault previously transferred out through a paid pick.
    function isOutside(uint256 id) external view returns (bool) {
        return _members[id] == MemberState.Outside;
    }

    /// @notice The token enforces this floor for every burn, including fees after conversion accounting changes.
    function supplyFloor() external view returns (uint256) {
        return escrowPrincipal + _inside;
    }

    /// @notice Live rational surplus (floor plus remainder/inside), permanently retained in escrow.
    /// On failure K is fixed to E, independent of subsequent creator recovery counts or extra token balances.
    function escrowSurplus() external view returns (uint256 floor, uint256 remainder) {
        uint256 e = escrowPrincipal;
        if (failed) return (e, 0);
        _requireConversion();
        return _views.surplus(e, collectionSize() - _inside, _token().totalSupply() - e, _inside);
    }

    /// @notice Pre-operation principal only; the immutable pick preset adds a separately rounded-up burned fee.
    /// Quantity quotes do not promise a particular id is available or that the fee fits the supply floor.
    function quoteWithdraw(uint256 count) external view returns (uint256 principal) {
        _requireConversion();
        _checkBatch(count);
        return _views.quoteWithdraw(count, _inside, _token().totalSupply() - escrowPrincipal);
    }

    /// @notice Pre-operation principal only; returns withhold a separately rounded-up 5% burned fee.
    function quoteReturn(uint256 count) external view returns (uint256 principal) {
        _requireConversion();
        _checkBatch(count);
        return _quoteReturn(count, _token().totalSupply(), escrowPrincipal);
    }

    /// @notice Current caller pays for the named members; one snapshot prices the entire atomic batch.
    function withdrawBatch(uint256[] calldata ids, uint256 maxTokenIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        _requireConversion();
        _checkDeadline(deadline);
        _checkIds(ids, MemberState.Inside);
        uint256 supply = _token().totalSupply();
        uint256 e = escrowPrincipal;
        principal = _views.quoteWithdraw(ids.length, _inside, supply - e);
        fee = _views.fee(principal, pickFeeBps());
        uint256 total = principal + fee;
        if (total > maxTokenIn) revert V.MaxTokenExceeded(total, maxTokenIn);
        uint256 balance = _token().balanceOf(msg.sender);
        if (balance < total) revert V.InsufficientToken(balance, total);
        escrowPrincipal = e + principal;
        _inside -= ids.length;
        for (uint256 i; i < ids.length; ++i) {
            _members[ids[i]] = MemberState.Outside;
        }
        emit V.Withdrawn(msg.sender, ids, principal, fee, supply - fee, escrowPrincipal, _inside);
        _pullToken(total);
        _token().burn(fee); // observes post-conversion E+n; a floor refusal rolls back the entire batch
        address nft = collection();
        for (uint256 i; i < ids.length; ++i) {
            SetAdmissionV2.requireOwner(nft, ids[i], address(this));
            _transferItem(nft, address(this), msg.sender, ids[i], true);
            SetAdmissionV2.requireOwner(nft, ids[i], msg.sender);
        }
    }

    /// @notice Only a previously withdrawn member's current owner can receive its current net return quote.
    function returnItems(uint256[] calldata ids, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        _requireConversion();
        _checkDeadline(deadline);
        _checkIds(ids, MemberState.Outside);
        uint256 supply = _token().totalSupply();
        uint256 e = escrowPrincipal;
        principal = _quoteReturn(ids.length, supply, e);
        fee = _views.fee(principal, C.RETURN_FEE_BPS);
        uint256 net = principal - fee;
        if (net < minTokenOut) revert V.MinTokenNotMet(net, minTokenOut);
        escrowPrincipal = e - principal;
        _inside += ids.length;
        for (uint256 i; i < ids.length; ++i) {
            _members[ids[i]] = MemberState.Inside;
        }
        emit V.Returned(msg.sender, ids, principal, fee, supply - fee, escrowPrincipal, _inside);
        address nft = collection();
        // Admission, current ownership, one exact receipt and post-owner checks repeat for each pull.
        // No burn or payment survives even a late failure; the shared lock covers the whole operation.
        for (uint256 i; i < ids.length; ++i) {
            _receiveItem(nft, ids[i], msg.sender);
        }
        _token().burn(fee);
        if (!_token().transfer(msg.sender, net)) revert V.TokenNotReceived(0, net);
    }

    function _requireConversion() private view {
        if (!initialized || !gateOpen || failed) revert V.GateClosed();
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert V.DeadlineExpired(deadline, block.timestamp);
    }

    function _checkBatch(uint256 count) private pure {
        if (count == 0) revert V.InvalidIdList();
        if (count > C.MAX_PAGE) revert B.ItemBatchTooLarge(count, C.MAX_PAGE);
    }

    function _checkIds(uint256[] calldata ids, MemberState expected) private view {
        _checkBatch(ids.length);
        for (uint256 i; i < ids.length; ++i) {
            if (_members[ids[i]] != expected) {
                if (expected == MemberState.Outside) revert V.NotOwner(ids[i]);
                revert V.IneligibleId(ids[i]);
            }
            // At most 32 ids; compare full uint256 values without a sentinel or persistent scratch mapping.
            for (uint256 j; j < i; ++j) {
                if (ids[i] == ids[j]) revert V.InvalidIdList();
            }
        }
    }

    function _quoteReturn(uint256 count, uint256 supply, uint256 e) private view returns (uint256 principal) {
        principal = _views.quoteReturn(count, _inside, collectionSize() - _inside, supply - e);
        if (principal > e) revert V.EscrowInsolvent(principal, e);
    }

    function _token() private view returns (IBoxToken) {
        return IBoxToken(token());
    }

    function _pullToken(uint256 amount) private {
        IBoxToken t = _token();
        uint256 beforeBalance = t.balanceOf(address(this));
        if (!t.transferFrom(msg.sender, address(this), amount)) revert V.TokenNotReceived(0, amount);
        uint256 received = t.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert V.TokenNotReceived(received, amount);
    }

    function _onlyCoordinator() private view {
        if (!initialized) revert InvalidRequest();
        if (msg.sender != coordinator()) revert Unauthorized(msg.sender);
    }

    function _receiveItem(address nft, uint256 id, address from) private {
        SetAdmissionV2.requireToken(nft, id);
        SetAdmissionV2.requireOwner(nft, id, from);
        _expectReceipt(from, id);
        _transferItem(nft, from, address(this), id, true);
        (address pending,) = _receipt();
        if (pending != address(0)) revert ReceiptRefused();
        SetAdmissionV2.requireOwner(nft, id, address(this));
    }

    /// @dev All directions use the same bounded transfer ceiling/reserve and discard all foreign return data.
    function _transferItem(address nft, address from, address to, uint256 id, bool safe) private {
        bytes memory data = abi.encodeWithSelector(safe ? bytes4(0x42842e0e) : bytes4(0x23b872dd), from, to, id);
        if (gasleft() < MIN_TRANSFER_GAS) revert TransferGas();
        bool ok;
        assembly ("memory-safe") {
            ok := call(NFT_TRANSFER_GAS, nft, 0, add(data, 32), mload(data), 0, 0)
        }
        if (!ok) revert TransferRefused();
    }

    function _expectReceipt(address from, uint256 id) private {
        bytes32 fromSlot = RECEIPT_FROM_SLOT;
        bytes32 idSlot = RECEIPT_ID_SLOT;
        assembly ("memory-safe") {
            tstore(fromSlot, from)
            tstore(idSlot, id)
        }
    }

    function _receipt() private view returns (address from, uint256 id) {
        bytes32 fromSlot = RECEIPT_FROM_SLOT;
        bytes32 idSlot = RECEIPT_ID_SLOT;
        assembly ("memory-safe") {
            from := tload(fromSlot)
            id := tload(idSlot)
        }
    }
}
