// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {RoyaltyDestination} from "../box/interfaces/BoxTypes.sol";
import {IBoxRoyaltyRouter} from "../box/interfaces/IBoxRoyaltyRouter.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {IBoxReceiverV2} from "./interfaces/IBoxReceiverV2.sol";
import {IBoxRoyaltyRouterV2} from "./interfaces/IBoxPeripheryV2.sol";
import {BoxRoyaltyRouterV2Args as A} from "./libraries/BoxRoyaltyRouterV2Args.sol";

import {CowOrder, ConditionalOrderParams, CowSignaturePayload, RoyaltyCowConfig, IComposableCow, ICowSettlement, RoyaltyCowHash} from "./interfaces/IRoyaltyCow.sol";
import {IListingRegistry} from "./interfaces/IListingRegistry.sol";
import {RoyaltyCowHandler} from "./RoyaltyCowHandler.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";

/// @notice The chain's WETH9 (the two calls the router makes; v1's).
interface IWETH9Unwrap {
    function balanceOf(address account) external view returns (uint256);
    function withdraw(uint256 amount) external;
    function deposit() external payable;
}

/// @title Per-box income inbox and per-coin CoW standing orders (RC6).
/// @notice P funds the receiver. The inbox offers listed foreign coins for P on CoW in whole lots; ETH wraps first.
/// Eligible coins have a thirty-day current-payee exit. No admin, ERC-165 or fallback.
/// @dev The receiving clone retains its empty-calldata 2,300-gas receipt path.
contract BoxRoyaltyRouterV2 is IBoxRoyaltyRouterV2, BoxCloneBase {
    address public immutable composableCow;
    address public immutable settlement;
    address public immutable vaultRelayer;
    address public immutable cowHandler;
    uint256 public immutable minimumLot;
    uint256 public constant IN_KIND_WAIT = 30 days;
    bytes32 public constant APP_DATA = keccak256('{"version":"1.3.0","appCode":"Square Hole Royalties","metadata":{}}');
    uint256 public constant MAX_LOTS_PER_HOUR = 20;
    struct CoinState {
        uint256 oldestUnsoldAt;
        uint256 hour;
        uint256 spent;
        uint256 approved;
        bool belowLot;
        bool registered;
        bool zeroingApproval;
    }
    mapping(address => CoinState) private _coins;
    error BadCowConfig();
    error NoOrder();
    error InvalidSignature();
    error WaitForSale();

    /// @notice Release deployment supplies chain addresses and the positive WETH minimum. No mutable release authority.
    constructor(RoyaltyCowConfig memory c) {
        if (c.composableCow.code.length == 0 || c.settlement.code.length == 0
            || c.minimumLot == 0 || c.minimumLot > type(uint256).max / MAX_LOTS_PER_HOUR) revert BadCowConfig();
        address relayer = ICowSettlement(c.settlement).vaultRelayer();
        if (relayer.code.length == 0 || ICowSettlement(c.settlement).domainSeparator() == bytes32(0)) revert BadCowConfig();
        composableCow = c.composableCow;
        settlement = c.settlement;
        vaultRelayer = relayer;
        minimumLot = c.minimumLot;
        cowHandler = address(new RoyaltyCowHandler());
    }

    function listingRegistry() public view returns (address) { return IBoxCoordinatorV2(coordinator()).listingRegistry(); }
    function listVersion() public view returns (uint256) { return _argUint(A.VERSION, 4); }
    function token() public view returns (address) { return IBoxCoordinatorV2(coordinator()).token(); }

    /// @notice The sold coin's own listed raw lot at creation. The release's WETH floor is immutable.
    function lotSize(address coin) public view returns (uint256 lot) {
        if (coin == address(0) || coin == q() || coin == token() || (q() == address(0) && coin == weth())) return 0;
        address listings = listingRegistry();
        if (listings == address(0)) return 0;
        lot = IListingRegistry(listings).sellableLotAt(coin, listVersion());
        if (lot != 0 && coin == weth() && lot < minimumLot) lot = minimumLot;
    }
    function oldestUnsoldAt(address coin) public view returns (uint256) { return _coins[coin].oldestUnsoldAt; }
    function orderRegistered(address coin) public view returns (bool) { return _coins[coin].registered; }
    function lotSize() external view returns (uint256) { return lotSize(weth()); }
    function oldestUnsoldAt() external view returns (uint256) { return oldestUnsoldAt(weth()); }
    function orderRegistered() external view returns (bool) { return orderRegistered(weth()); }

    function orderParams(address coin) public view returns (ConditionalOrderParams memory) {
        return ConditionalOrderParams(cowHandler, bytes32(0), abi.encode(coin));
    }
    function orderParams() external view returns (ConditionalOrderParams memory) { return orderParams(weth()); }
    function refreshOrder() external { refreshOrder(weth()); }

    /// @notice Anyone registers an eligible coin with approvable whole lots; refresh never restores spent hourly budget.
    /// @dev Registered without dispatch: ComposableCoW stores the order but emits no ConditionalOrderCreated, so CoW's
    /// own watch-tower, which posts every such order with no quote or fee check, never relays it. Our poster quotes
    /// first, skips a high-fee hour and finds the order through this inbox's views (the frozen sale list's coins,
    /// orderRegistered and orderParams), never through an event; anyone may still post a valid order.
    function refreshOrder(address coin) public locked {
        _onlyClone();
        uint256 lot = lotSize(coin);
        if (lot == 0) revert NoOrder();
        if (coin == weth()) _wrap();
        CoinState storage c = _coins[coin];
        uint256 balance = _balanceOf(coin);
        _observe(coin, lot, balance);
        if (_failed()) { _setApproval(coin, 0); return; }
        uint256 cap = MAX_LOTS_PER_HOUR * lot;
        uint256 left = c.spent >= cap ? 0 : cap - c.spent;
        uint256 amount = balance < left ? balance : left;
        amount = amount / lot * lot;
        if (!c.registered) {
            if (amount == 0) revert NoOrder();
            c.registered = true;
            IComposableCow(composableCow).create(orderParams(coin), false);
        }
        _setApproval(coin, amount);
        c.zeroingApproval = amount != 0 && amount == balance;
        emit OrderRefreshed(keccak256(abi.encode(orderParams(coin))), balance, c.oldestUnsoldAt);
    }

    /// @notice Approved whole lots only; native-P boxes buy WETH and unwrap it through the same P intake.
    function cowOrder(address coin) public view returns (CowOrder memory order) {
        _onlyClone();
        uint256 lot = lotSize(coin);
        if (lot == 0 || !_coins[coin].registered || _failed()) revert NoOrder();
        uint256 balance = _balanceOf(coin);
        uint256 approved = _allowance(coin, vaultRelayer);
        uint256 amount = (balance < approved ? balance : approved) / lot * lot;
        if (amount == 0 || block.timestamp / 1 hours >= type(uint32).max / 1 hours) revert NoOrder();
        order = CowOrder(coin, q() == address(0) ? weth() : q(), address(this), amount, 1,
            uint32((block.timestamp / 1 hours + 1) * 1 hours), APP_DATA, 0, keccak256("sell"), false,
            keccak256("erc20"), keccak256("erc20"));
    }
    function cowOrder() external view returns (CowOrder memory) { return cowOrder(weth()); }

    /// @notice Only ComposableCoW's canonical non-Safe payload for a current order under the chain domain passes.
    /// @dev Empty proof and offchain input encode to exactly 736 bytes. The first word is the sold coin;
    /// compare the entire encoding, including its params and offsets. Read only that registered coin's order,
    /// in an isolated call so an unreadable issuer refuses its own payload without blocking another coin.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        _onlyClone();
        if (signature.length != 736) revert InvalidSignature();
        address coin;
        assembly ("memory-safe") { coin := calldataload(signature.offset) }
        if (!_coins[coin].registered) revert InvalidSignature();
        try this.cowOrder(coin) returns (CowOrder memory order) {
            if (keccak256(signature) == keccak256(abi.encode(order,
                    CowSignaturePayload(new bytes32[](0), orderParams(coin), "")))
                && digest == RoyaltyCowHash.digest(order, ICowSettlement(settlement).domainSeparator())) return 0x1626ba7e;
        } catch {}
        revert InvalidSignature();
    }

    function _failed() private view returns (bool) { return IBoxCoordinatorV2(coordinator()).failed(); }

    /// @dev Allowance consumption witnesses sales even if donations conceal the balance decrease.
    /// Charge unobserved consumption conservatively to the current hour, including across an hour boundary.
    function _observe(address coin, uint256 lot, uint256 balance) private {
        CoinState storage c = _coins[coin];
        uint256 allowance = _allowance(coin, vaultRelayer);
        uint256 sold = c.approved > allowance ? c.approved - allowance : 0;
        uint256 hour = block.timestamp / 1 hours;
        if (c.hour != hour) { c.hour = hour; c.spent = 0; }
        c.spent += sold;
        c.approved = allowance;
        bool below = balance < lot;
        // An exhausted approval witnesses zero only if no residual was observed while it was outstanding.
        bool emptied = c.zeroingApproval && allowance == 0;
        bool retainedDust = sold != 0 && below && !c.zeroingApproval;
        if (balance == 0) c.oldestUnsoldAt = 0;
        else if (c.oldestUnsoldAt == 0 || emptied
            || (!retainedDust && (sold != 0 || below != c.belowLot))) c.oldestUnsoldAt = block.timestamp;
        // Read balance and allowance together: a deposit observed before the sale invalidates the zero witness.
        if (balance > allowance || allowance == 0) c.zeroingApproval = false;
        c.belowLot = below;
    }

    function _setApproval(address coin, uint256 amount) private {
        uint256 current = _allowance(coin, vaultRelayer);
        if (current != amount) {
            // Supports zero-first issuers; no arbitrary spender and no residual increase authority.
            if (current != 0 && !_approve(coin, vaultRelayer, 0)) revert ApproveRefused(coin);
            if (amount != 0 && !_approve(coin, vaultRelayer, amount)) revert ApproveRefused(coin);
            if (_allowance(coin, vaultRelayer) != amount) revert ApproveRefused(coin);
        }
        _coins[coin].approved = amount;
    }

    /// @notice Public clock observation without registration or any approval increase.
    function observe(address coin) external locked {
        _onlyClone();
        if (coin == weth()) _wrap();
        uint256 lot = lotSize(coin);
        if (lot != 0) {
            _observe(coin, lot, _balanceOf(coin));
            if (_failed()) _setApproval(coin, 0);
        }
    }

    function _wrap() private returns (uint256 amount) {
        amount = address(this).balance;
        if (amount != 0) IWETH9Unwrap(weth()).deposit{value: amount, gas: TOKEN_GAS}();
    }

    /// @notice `flush()` or `sweep()` on the bare implementation, which is no box's router.
    error NotAClone();
    /// @notice The box's P refused the router's approval to the receiver (a revert, false, or a malformed return).
    error ApproveRefused(address token);
    /// @notice The box's P did not show the router's balance (a revert or a short return), before or after the pull.
    error TokenUnreadable(address token);

    /// @notice An in-kind claimant is not the receiver's current payee; nothing moves.
    error NotPayee();
    /// @notice The receiver names no usable payee; custody remains unchanged.
    error MissingPayee();
    /// @notice A nested mutating call cannot enter during a payment.
    error Reentrant();
    /// @notice A non-P transfer refused or did not debit the router; the entire claim reverts.
    error TransferRefused(address token);
    /// @notice Anyone reads the bounded external-call budgets; no funds move.
    uint256 public constant READ_GAS = 50_000;
    /// @notice Anyone reads the ERC-20 call ceiling; no funds move.
    uint256 public constant TOKEN_GAS = 2_700_000;
    /// @notice Anyone reads the receiver call ceiling; no funds move.
    uint256 public constant SINK_GAS = 5_000_000;
    /// @notice Anyone reads the payee ETH call ceiling; no funds move.
    uint256 public constant PAYEE_GAS = 200_000;
    bytes32 private constant LOCK = keccak256("squarehole.royalty.rc5.lock");

    modifier locked() {
        bytes32 slot = LOCK;
        uint256 entered;
        assembly ("memory-safe") { entered := tload(slot) }
        if (entered != 0) revert Reentrant();
        assembly ("memory-safe") { tstore(slot, 1) }
        _;
        assembly ("memory-safe") { tstore(slot, 0) }
    }

    /// @dev The implementation's own address: a clone runs this code with another `address(this)`.
    address private immutable _self = address(this);
    // The receiver settles P in int128-sized parts. Bound protocol-selected work
    // even when an arbitrarily large balance has accumulated between calls.
    uint256 private constant _MAX_BATCH = 4 * uint256(uint128(type(int128).max));

    /// @dev Receiving clones carry their arguments from byte 51.
    function _argsBase() internal pure override returns (uint256) {
        return BoxClones.RECEIVING_ARGS_OFFSET;
    }

    /// @inheritdoc IBoxRoyaltyRouter
    /// @dev The clone answers empty calldata before delegating, so this body runs only for a direct payment to the
    /// implementation; it does nothing either way (v1's). A payment made straight to the bare implementation (for
    /// example a royalty address copied from it) is lost for good, as with v1: `flush()` and `sweep()` refuse there
    /// (`NotAClone`) and nothing rescues it (F23 C2); an ERC-20 sent there stays too.
    receive() external payable {}

    /// @notice Anyone wraps token-box ETH for CoW, or delivers native/WETH price-coin income to the receiver.
    function flush() public locked returns (uint256) {
        _onlyClone();
        return _flush();
    }

    /// @notice Anyone: bounded P delivery to the receiver; WETH in a native-P box flushes as ETH. Other coins
    /// are available only to the payee through claimInKind. Price-coin WETH always follows P accounting.
    function sweep(address token) external locked returns (uint256 amount) {
        _onlyClone();
        if (token != address(0) && token == q()) return _sweepP(token);
        if (token == weth() && q() == address(0)) return _flush();
        revert TokenNotTaken(token);
    }

    /// @notice Anyone sweeps P, including an empty inbox. Claims use this before pricing the failed pot.
    function sweepPriceCoin() external locked returns (uint256 amount) {
        _onlyClone();
        address p = q();
        if (p == address(0)) {
            if (address(this).balance == 0 && _balanceOf(weth()) == 0) return 0;
            amount = _flush();
            if (msg.sender == coordinator() && (address(this).balance != 0 || _balanceOf(weth()) != 0)) revert WaitForSale();
            return amount;
        }
        if (p == weth()) _wrap();
        if (_balanceOf(p) == 0) return 0;
        return _sweepP(p);
    }

    /// @notice P still awaiting intake, including ETH/WETH representations of the pricing coin.
    function pendingPriceCoin() external view returns (uint256 amount) {
        address p = q();
        amount = p == address(0) ? address(this).balance : _balanceOf(p);
        if (p == address(0)) amount += _balanceOf(weth());
        else if (p == weth()) amount += address(this).balance;
    }

    /// @notice Current payee claims non-P coins. Live listed coins wait thirty days; failed boxes exit in kind.
    /// P and native-P's WETH always use the receiver.
    /// A refused transfer rolls back; only the payee receives money, never an arbitrary supplied address.
    /// Returns and emits the router's measured debit; token rounding residue stays in custody for a later claim.
    function claimInKind(address token) external locked returns (uint256 amount) {
        _onlyClone();
        address payee = _payee();
        if (msg.sender != payee) revert NotPayee();
        if (token == q() || (q() == address(0) && token == weth())) revert TokenNotTaken(token);
        if (token == address(0)) { _wrap(); token = weth(); }
        if (token == q() || (q() == address(0) && token == weth())) revert TokenNotTaken(token);
        uint256 lot = lotSize(token);
        if (lot != 0) {
            if (token == weth()) _wrap();
            _observe(token, lot, _balanceOf(token));
            if (!_failed() && (_coins[token].oldestUnsoldAt == 0
                || block.timestamp < _coins[token].oldestUnsoldAt + IN_KIND_WAIT)) revert WaitForSale();
            _setApproval(token, 0);
        }
        amount = token == address(0) ? address(this).balance : _balanceOf(token);
        if (amount == 0) revert NothingToFlush();
        if (token == address(0)) _sendEth(payee, amount);
        else {
            if (!_tokenCall(token, abi.encodeWithSelector(0xa9059cbb, payee, amount))) {
                revert TransferRefused(token);
            }
            uint256 remaining = _balanceOf(token);
            if (remaining >= amount) revert TransferRefused(token);
            amount -= remaining;
        }
        if (lot != 0) _observe(token, lot, _balanceOf(token));
        emit InKindClaimed(token, payee, amount);
    }

    /// @dev Internal delivery, under the transient lock; the immutable receiver is the only source of payee identity.
    function _flush() private returns (uint256 ethSent) {
        if (q() != address(0)) {
            ethSent = _wrap();
            if (q() == weth()) return _sweepP(weth());
            uint256 lot = lotSize(weth());
            if (lot != 0) {
                _observe(weth(), lot, _balanceOf(weth()));
                if (_failed()) _setApproval(weth(), 0);
            }
            return ethSent;
        }
        uint256 unwrapped = _unwrapBatch();
        ethSent = address(this).balance;
        if (ethSent > _MAX_BATCH) ethSent = _MAX_BATCH;
        if (ethSent == 0) revert NothingToFlush();
        address sink = receiver();
        if (sink.code.length == 0) revert SinkFailed();
        (bool ok,) = sink.call{value: ethSent, gas: SINK_GAS}(
            abi.encodeCall(IBoxReceiverV2.fundRoyalty, (address(0), ethSent))
        );
        if (!ok) revert SinkFailed();
        IBoxCoordinatorV2(coordinator()).creditInbox(ethSent);
        emit Flushed(sink, ethSent, unwrapped);
    }

    /// @dev Internal bounded payee read; the receiver's existing two-step payee transfer remains the sole owner.
    function _payee() private view returns (address payee) {
        uint256 raw = _read(receiver(), abi.encodeCall(IBoxReceiverV2.creatorPayee, ()));
        if (raw == 0 || raw > type(uint160).max || address(uint160(raw)) == address(this)) revert MissingPayee();
        payee = address(uint160(raw));
    }

    /// @dev Internal fail-closed ETH send to the authenticated payee; refusal keeps all funds in the router.
    function _sendEth(address payee, uint256 amount) private {
        (bool ok,) = payee.call{value: amount, gas: PAYEE_GAS}("");
        if (!ok) revert SinkFailed();
    }

    /// @notice Anyone reads actual custody, including silent 2,300-gas ETH receipts; no funds move.
    function heldBalance(address token) external view returns (uint256) {
        return token == address(0) ? address(this).balance : _balanceOf(token);
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function coordinator() public view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function receiver() public view returns (address) {
        return IBoxCoordinatorV2(coordinator()).receiver();
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function weth() public view returns (address) {
        return _argAddress(A.WETH);
    }

    /// @inheritdoc IBoxRoyaltyRouterV2
    function q() public view returns (address) {
        return IBoxCoordinatorV2(coordinator()).q();
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function destination() public view returns (RoyaltyDestination) {
        // PoolDepth and Creator as written; any other byte reads as FeeHandling (v1's; the factory writes the byte).
        uint256 raw = _argUint(A.DESTINATION, 1);
        if (raw == uint8(RoyaltyDestination.PoolDepth)) return RoyaltyDestination.PoolDepth;
        if (raw == uint8(RoyaltyDestination.Creator)) return RoyaltyDestination.Creator;
        return RoyaltyDestination.FeeHandling;
    }

    /// @dev Internal bounded P delivery, pulled exactly; remainder stays in custody and no allowance remains.
    function _sweepP(address p) private returns (uint256 amount) {
        uint256 balance = _balanceOf(p);
        amount = balance > _MAX_BATCH ? _MAX_BATCH : balance;
        if (amount == 0) revert NothingToFlush();
        address sink = receiver();
        if (!_approve(p, sink, amount)) revert ApproveRefused(p);
        (bool ok,) = sink.call{gas: SINK_GAS}(abi.encodeCall(IBoxReceiverV2.fundRoyalty, (p, amount)));
        // The receiver pulls exactly `amount` or reverts (`TransferNotExact`); a receiver that took less is refused
        // too, so the sweep never reports P it did not deliver.
        if (!ok || _balanceOf(p) != balance - amount) revert SinkFailed();
        // A token that does not spend approvals leaves one: cleared, so nothing more can be pulled later.
        if (_allowance(p, sink) != 0 && !_approve(p, sink, 0)) revert ApproveRefused(p);
        IBoxCoordinatorV2(coordinator()).creditInbox(amount);
    }

    /// @dev Internal WETH unwrap fills only this batch's room; native ETH and remaining WETH keep their exits.
    function _unwrapBatch() private returns (uint256 amount) {
        uint256 native = address(this).balance;
        if (native >= _MAX_BATCH) return 0;
        address w = weth();
        if (w.code.length == 0) return 0;
        amount = _balanceOf(w);
        uint256 room = _MAX_BATCH - native;
        if (amount > room) amount = room;
        if (amount != 0) IWETH9Unwrap(w).withdraw{gas: TOKEN_GAS}(amount);
    }

    /// @dev Internal balance read; malformed/refused reads revert without transferring money.
    function _balanceOf(address token) private view returns (uint256) {
        return _read(token, abi.encodeWithSelector(0x70a08231, address(this)));
    }

    /// @dev Internal allowance read; an unreadable allowance reverts the entire exact P delivery.
    function _allowance(address token, address spender) private view returns (uint256) {
        return _read(token, abi.encodeWithSelector(0xdd62ed3e, address(this), spender));
    }

    /// @dev Internal bounded read: copy one word regardless of hostile return data size.
    function _read(address target, bytes memory data) private view returns (uint256 value) {
        bool ok;
        uint256 size;
        uint256 budget = READ_GAS;
        assembly ("memory-safe") {
            ok := staticcall(budget, target, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            value := mload(0)
        }
        if (!ok || size != 32) revert TokenUnreadable(target);
    }

    /// @dev Internal exact approval, including reset to zero after the receiver's pull.
    function _approve(address token, address spender, uint256 amount) private returns (bool) {
        return _tokenCall(token, abi.encodeWithSelector(0x095ea7b3, spender, amount));
    }

    /// @dev Internal bounded ERC-20 call, accepting no return or true and never copying unbounded return data.
    function _tokenCall(address token, bytes memory data) private returns (bool) {
        bool ok;
        uint256 size;
        uint256 value;
        uint256 budget = TOKEN_GAS;
        assembly ("memory-safe") {
            ok := call(budget, token, 0, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            value := mload(0)
        }
        return ok && token.code.length != 0 && (size == 0 || (size == 32 && value == 1));
    }

    /// @dev Refuses the bare implementation (`NotAClone`).
    function _onlyClone() private view {
        if (address(this) == _self) revert NotAClone();
    }
}
