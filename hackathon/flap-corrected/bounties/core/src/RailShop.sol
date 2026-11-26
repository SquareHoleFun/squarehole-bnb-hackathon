// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRailShop} from "./IRailShop.sol";
import {PairPriceGuard} from "./PairPriceGuard.sol";

interface IERC721Min {
    function ownerOf(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}

interface IRouterMin {
    function WETH() external view returns (address);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title RailShop: a card shop for one token launched elsewhere (Flap, Four.meme), fed by that token's trading tax
/// @notice A shop for one token (a token can have any number of shops), made by `RailShopFactory` at an address that commits to every creation parameter,
/// everything fixed at creation, no owner. Give a card of a listed collection and receive its give price in the token
/// from the shop's balance; pick a held card and pay its pick price (the give price plus `pickBps`) in the token, which
/// stays in the shop for later gives; anyone stocks cards for nothing; anyone turns asset that arrived (the tax, a plain
/// payment from the token's rules) into the token.
///
/// How the code gives each property (and the harm it prevents):
/// - Nobody takes cards or tokens except by give and pick at the fixed prices: there is no owner, setter, sweep or
///   upgrade; a card leaves only by `pick` for its pick price; tokens leave only by `give` for a listed card. Give and
///   pick each move exactly one card and the exact price, MEASURED BY BALANCE on both sides.
/// - No entry can be entered again from inside: give, pick, stock, refill and drop share one lock, so a card contract,
///   the token or the router calling back is refused.
/// - A shop is as honest as its token AND its collections: the token's own balance answers settle every trade, and the
///   collections' own `ownerOf` answers decide which cards the shop holds. The creator chooses both. The budget and the
///   room are shared by all collections: a collection that lies about its owners can draw gives from everyone's budget,
///   phantom cards included, up to the period's room. An honest collection whose transfers revert blocks only its own
///   cards. Our four test collections' owner is our deploy wallet, which can mint without limit, so that wallet can
///   draw on every shop's budget (shops listing those collections) up to its room each period.
/// - A token can have any number of shops, created by anyone (the factory lists them per token and per creator).
/// - Gives are capped by a room per seven-day period counted from the shop's creation: a give needs its price within
///   the room and takes it; a pick adds the card's give price, in either order (a pick first in a period too). So in
///   every period the give prices of gives minus the give prices of picks never exceed `weeklyCap`; as a pick costs at
///   least its give price, the tokens that leave through gives, net of what picks bring in, never exceed it either. A
///   new period starts at the cap; `capLeft()` can exceed the cap after picks. Amounts: the cap is at most 2^128 - 1;
///   picks credit down to a floor of -2^200 spent (unreachable with real prices; a credit below it is dropped).
/// - A token that taxes or blocks plain transfers stops gives and picks while it prevents exact settlement: there is no
///   other exit for the cards and tokens inside.
/// - A refill buys one slice, min(`waiting()`, the guard's cap): a huge amount of an openly mintable asset sent here is
///   bought in slices a minute or more apart; the rest keeps waiting. `Refilled` reports the measured debit of the asset
///   (what `waiting()` fell by), which must equal the slice: a router that draws less, or returns without swapping, makes
///   the refill revert (`RefillShort`). A refill that fails reverts and the asset waits. A plain payment of the asset is accepted with no work in it (within the splitter's 100,000 gas).
/// - Picks send the card with a plain `transferFrom`: a receiver contract must be able to hold cards (no hook is called).
/// - The last LISTED card stays (as the platform's shop), counted across all collections; a card moved out by its
///   collection still counts until it is dropped, so the shop can be physically emptier than its list. A new shop
///   starts empty. `drop` removes a listed card only on a definite `ownerOf` answer naming another owner; a card whose
///   `ownerOf` reverts (a burned card, a broken collection) stays listed. Removal (a pick or a drop) reorders the list.
/// - The factory accepts only the routers and card collections it was constructed with (the chain's DEX routers and the
///   test card collections this repository stands behind), so a shop's creator cannot bring a router or a collection
///   of its own; someone who wants others deploys another factory, and the site shows only ours.
/// - Nothing is stocked or refilled before the token has code: the shop can be created and named in a launch's rules
///   before the token exists, and payments that arrive wait.
/// - Settlement reads balances strictly: a balance read that fails or answers short in give, pick or refill reverts the
///   call. Views read forgivingly (a failed read is zero), so a page can always render; `budget()` and `waiting()` call
///   the token and the asset, so a bad token or asset can use up a view call's gas. No view calls a collection.
/// - The pick surcharge is at most 50,000 bps and rounds up: a pick price is at most six times the give price (at 50,000
///   bps the surcharge is exactly five times the give price, with nothing to round).
/// - A safe transfer of a card straight to the shop reverts (no receiver hook). A safe transfer to the shop's address
///   BEFORE the shop exists succeeds (no code there yet), and a plain transfer at any time pays nothing: such a card
///   waits for anyone's `stock`. `Stocked.from` is the caller who listed the card, not necessarily who sent it. Cards of
///   unlisted collections and coins other than the token and the asset sent here have no way out.
/// What a caller can influence: only WHEN `refill` runs, so the price it buys at. The refill is guarded by
/// `PairPriceGuard` (Flap's pre-audit finding R2): one slice of at most 5 bps of the pair's quote reserve, one per minute,
/// and a nonzero minimum output from the pair's reserves; what the guard does not stop is stated there. Without a pool of asset and token the refill reverts and the asset waits.
/// What is NOT in it, on purpose: tiers, a curator, collections added later, a per-collection budget, any check of a
/// card's worth.
contract RailShop is IRailShop {
    uint256 public constant MAX_COLLECTIONS = 4;
    uint16 public constant MAX_PICK_BPS = 50_000;
    uint256 public constant PERIOD = 7 days;
    /// The largest cap (and so give price): every amount the cap arithmetic converts fits a signed word with room.
    uint256 public constant MAX_AMOUNT = type(uint128).max;
    /// Picks credit the period down to this floor and no further (unreachable with real prices: 2^72 picks at the
    /// largest price); below it a credit is dropped, which only leaves less room, never more.
    int256 private constant SPENT_FLOOR = -(int256(1) << 200);

    /// @inheritdoc IRailShop
    address public immutable factory;
    /// @inheritdoc IRailShop
    address public token;
    /// @inheritdoc IRailShop
    address public asset;
    /// @inheritdoc IRailShop
    address public router;
    /// @inheritdoc IRailShop
    address public creator;
    /// @inheritdoc IRailShop
    uint16 public pickBps;
    /// @inheritdoc IRailShop
    uint256 public weeklyCap;
    /// @inheritdoc IRailShop
    uint256 public createdAt;

    address[] private _nfts;
    mapping(address => uint256) private _givePrice; // 0: not listed

    struct Card {
        address nft;
        uint256 id;
    }

    Card[] private _cards;
    mapping(bytes32 => uint256) private _slot; // place in _cards plus one; 0: not held
    uint256 private _period; // the period `_spent` counts in, plus one (0: none yet)
    int256 private _spent; // this period's give prices of gives minus give prices of picks (negative after picks)
    uint256 private _lock = 1;
    /// @dev Flap's pre-audit finding R2: the refill's guard, appended after all earlier storage.
    PairPriceGuard.State private _refillGuard;

    /// @notice A refill within 60 seconds of the shop's last refill.
    error RefillTooSoon();
    /// @notice The refill's measured settlement differs from its plan: the asset did not fall by exactly the slice, or
    /// fewer tokens than the minimum arrived.
    error RefillShort();
    /// @notice `amount` is below the eligible slice, min(waiting(), 5 bps of the pair's quote reserve): a refill buys
    /// that slice or nothing (pass `waiting()`).
    error AmountBelowSlice();
    /// @notice No pair of the asset and the token on the router's factory, empty reserves, or a failed read.
    error NoPool();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    /// @notice The factory only, once, in the call that creates the shop.
    function initialize(
        address creator_,
        address token_,
        address asset_,
        address router_,
        address[] calldata nfts,
        uint256[] calldata givePrices,
        uint16 pickBps_,
        uint256 weeklyCap_
    ) external {
        if (msg.sender != factory || createdAt != 0) revert InvalidShop();
        uint256 n = nfts.length;
        if (creator_ == address(0) || token_ == address(0) || token_ == asset_ || router_.code.length == 0) revert InvalidShop();
        if (asset_ != address(0) && asset_.code.length == 0) revert InvalidShop();
        if (n == 0 || n > MAX_COLLECTIONS || n != givePrices.length || pickBps_ > MAX_PICK_BPS || weeklyCap_ == 0
            || weeklyCap_ > MAX_AMOUNT) {
            revert InvalidShop();
        }
        for (uint256 i; i < n; ++i) {
            address nft = nfts[i];
            if (nft.code.length == 0 || givePrices[i] == 0 || givePrices[i] > weeklyCap_ || _givePrice[nft] != 0
                || nft == token_ || nft == asset_) {
                revert InvalidShop();
            }
            _pickPrice(givePrices[i], pickBps_); // refuse a price whose pick price overflows
            _givePrice[nft] = givePrices[i];
            _nfts.push(nft);
        }
        creator = creator_;
        token = token_;
        asset = asset_;
        router = router_;
        pickBps = pickBps_;
        weeklyCap = weeklyCap_;
        createdAt = block.timestamp;
    }

    /// @notice A plain payment of the native asset (the tax), or an empty call (a wake call after an ERC-20 payment, as
    /// the splitter accepts): no work. A native payment is refused when the asset is an ERC-20.
    receive() external payable {
        if (msg.value != 0 && asset != address(0)) revert NativeNotAccepted();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Give, pick, stock, refill
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRailShop
    function give(address nft, uint256 id, uint256 minPaid) external nonReentrant returns (uint256 paid) {
        paid = _givePrice[nft];
        if (paid == 0) revert NotListed();
        if (paid < minPaid) revert PriceAbove();
        if (budget() < paid) revert BudgetShort();
        if (paid > capLeft()) revert CapReached();
        _turn();
        _spent += int256(paid); // paid <= MAX_AMOUNT and _spent <= weeklyCap - paid here: no overflow
        _takeCard(nft, id, msg.sender);
        _sendToken(msg.sender, paid);
        emit Given(nft, id, msg.sender, paid);
    }

    /// @inheritdoc IRailShop
    function pick(address nft, uint256 id, uint256 maxPrice, address to) external nonReentrant returns (uint256 paid) {
        uint256 givePrice = _givePrice[nft];
        if (givePrice == 0) revert NotListed();
        if (to == address(0) || to == address(this)) revert BadReceiver();
        if (_slot[_key(nft, id)] == 0) revert NotHeld();
        if (_cards.length <= 1) revert LastCard();
        paid = _pickPrice(givePrice, pickBps);
        if (paid > maxPrice) revert PriceAbove();
        _pullToken(msg.sender, paid);
        // The card's give price comes back to the current period's room, also when nothing was given in it yet.
        _turn();
        int256 s = _spent - int256(givePrice); // _spent >= SPENT_FLOOR, givePrice <= MAX_AMOUNT: no overflow
        _spent = s < SPENT_FLOOR ? SPENT_FLOOR : s;
        _removeCard(nft, id);
        IERC721Min(nft).transferFrom(address(this), to, id);
        if (IERC721Min(nft).ownerOf(id) != to) revert TransferFailed();
        emit Picked(nft, id, msg.sender, to, paid);
    }

    /// @inheritdoc IRailShop
    function stock(address nft, uint256[] calldata ids) external nonReentrant {
        if (_givePrice[nft] == 0) revert NotListed();
        if (token.code.length == 0) revert TokenNotLive();
        for (uint256 i; i < ids.length; ++i) {
            // A card already sent here by a plain transfer (not counted yet) is counted without a transfer.
            if (_slot[_key(nft, ids[i])] == 0 && IERC721Min(nft).ownerOf(ids[i]) == address(this)) _addCard(nft, ids[i]);
            else _takeCard(nft, ids[i], msg.sender);
            emit Stocked(nft, ids[i], msg.sender);
        }
    }

    /// @inheritdoc IRailShop
    function drop(address nft, uint256 id) external nonReentrant {
        if (_slot[_key(nft, id)] == 0) revert NotHeld();
        (bool ok, bytes memory ret) = nft.staticcall(abi.encodeCall(IERC721Min.ownerOf, (id)));
        // Only a definite answer removes a card: exactly one word naming a nonzero owner other than the shop. A read
        // that fails, is short or long, or is not an address is refused (a passing failure must not hide a held card).
        if (!ok || ret.length != 32) revert OwnerUnknown();
        uint256 word = abi.decode(ret, (uint256));
        if (word == 0 || word >> 160 != 0) revert OwnerUnknown();
        if (address(uint160(word)) == address(this)) revert StillHeld();
        _removeCard(nft, id);
        emit Dropped(nft, id);
    }

    /// @inheritdoc IRailShop
    function refill(uint256 amount) external nonReentrant returns (uint256 tokensOut) {
        if (token.code.length == 0) revert TokenNotLive();
        if (amount == 0) revert NothingWaiting();
        if (amount > waiting()) revert AmountAbove();
        address[] memory path = new address[](2);
        path[0] = asset == address(0) ? IRouterMin(router).WETH() : asset;
        path[1] = token;
        // Flap's R2 fix as written: a refill buys the eligible slice, min(waiting(), 5 bps of the pair's quote reserve),
        // or nothing; at most one per 60 seconds; a nonzero minimum from the pair's reserves less tax, fee and 1%
        // slippage. Stops a sandwich of a capped buy whose size was fixed BEFORE the front-run; does NOT stop a trade
        // earlier in this transaction (it moves the reserves the cap and the minimum are read from). A failed refill
        // reverts whole, the last refill's time included.
        (PairPriceGuard.Wait wait, uint256 amountIn, uint256 minOut) =
            PairPriceGuard.plan(_refillGuard, router, path[0], token, waiting());
        if (wait == PairPriceGuard.Wait.TOO_SOON) revert RefillTooSoon();
        if (wait != PairPriceGuard.Wait.NONE) revert NoPool();
        // the whole eligible slice or nothing: a smaller amount would take the minute for less than a slice
        if (amount < amountIn) revert AmountBelowSlice();
        uint256 before = _strictBalance(address(this));
        uint256 assetBefore = _assetHeld();
        if (asset == address(0)) {
            IRouterMin(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: amountIn}(
                minOut, path, address(this), block.timestamp
            );
        } else {
            if (!_call(asset, abi.encodeWithSignature("approve(address,uint256)", router, amountIn))) revert TransferFailed();
            IRouterMin(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amountIn, minOut, path, address(this), block.timestamp
            );
            if (!_call(asset, abi.encodeWithSignature("approve(address,uint256)", router, 0))) revert TransferFailed();
        }
        uint256 afterBalance = _strictBalance(address(this));
        tokensOut = afterBalance > before ? afterBalance - before : 0;
        uint256 assetAfter = _assetHeld();
        uint256 debit = assetBefore > assetAfter ? assetBefore - assetAfter : 0;
        // The eligible slice or nothing, measured: the asset must have fallen by exactly the slice and at least the
        // minimum must have arrived. An exact-input V2 swap (the routers our factory accepts) draws exactly its input or
        // reverts, so this only refuses a router that draws less or returns without swapping.
        if (debit != amountIn || tokensOut < minOut) revert RefillShort();
        PairPriceGuard.markBought(_refillGuard);
        emit Refilled(debit, tokensOut); // the measured debit
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRailShop
    function collectionCount() external view returns (uint256) {
        return _nfts.length;
    }

    /// @inheritdoc IRailShop
    function collection(uint256 i) external view returns (address nft, uint256 givePrice, uint256 pickPrice) {
        nft = _nfts[i];
        givePrice = _givePrice[nft];
        pickPrice = _pickPrice(givePrice, pickBps);
    }

    /// @inheritdoc IRailShop
    function pricesOf(address nft) external view returns (uint256 givePrice, uint256 pickPrice) {
        givePrice = _givePrice[nft];
        if (givePrice == 0) revert NotListed();
        pickPrice = _pickPrice(givePrice, pickBps);
    }

    /// @inheritdoc IRailShop
    function cardCount() external view returns (uint256) {
        return _cards.length;
    }

    /// @inheritdoc IRailShop
    function card(uint256 i) external view returns (address nft, uint256 id) {
        Card storage c = _cards[i];
        return (c.nft, c.id);
    }

    /// @inheritdoc IRailShop
    function cards(uint256 offset, uint256 limit) external view returns (address[] memory nfts, uint256[] memory ids) {
        uint256 n = _cards.length;
        uint256 end = offset >= n ? offset : (limit > n - offset ? n : offset + limit);
        nfts = new address[](end - offset);
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            nfts[i - offset] = _cards[i].nft;
            ids[i - offset] = _cards[i].id;
        }
    }

    /// @inheritdoc IRailShop
    function holds(address nft, uint256 id) external view returns (bool) {
        return _slot[_key(nft, id)] != 0;
    }

    /// @inheritdoc IRailShop
    function budget() public view returns (uint256) {
        return _balanceOf(token, address(this));
    }

    /// @inheritdoc IRailShop
    function waiting() public view returns (uint256) {
        return asset == address(0) ? address(this).balance : _balanceOf(asset, address(this));
    }

    /// @inheritdoc IRailShop
    function capLeft() public view returns (uint256) {
        if (_period != _currentPeriod() + 1) return weeklyCap; // a new period: nothing spent in it yet
        // _spent <= weeklyCap <= MAX_AMOUNT and _spent >= SPENT_FLOOR: the room is in [0, MAX_AMOUNT + 2^200].
        return uint256(int256(weeklyCap) - _spent);
    }

    /// @inheritdoc IRailShop
    function periodEnds() external view returns (uint256) {
        return createdAt + (_currentPeriod() + 1) * PERIOD;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _currentPeriod() private view returns (uint256) {
        return (block.timestamp - createdAt) / PERIOD;
    }

    /// @dev A period that turned starts at zero spent.
    function _turn() private {
        uint256 p = _currentPeriod() + 1;
        if (_period != p) {
            _period = p;
            _spent = 0;
        }
    }

    /// @dev The asset the shop holds, read strictly (a refill's debit must be measured, never guessed).
    function _assetHeld() private view returns (uint256) {
        if (asset == address(0)) return address(this).balance;
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || ret.length < 32) revert BalanceUnreadable();
        return abi.decode(ret, (uint256));
    }

    function _pickPrice(uint256 givePrice, uint16 bps) private pure returns (uint256) {
        uint256 surcharge = givePrice / 10_000 * bps + (givePrice % 10_000 * bps + 9_999) / 10_000; // rounded up
        return givePrice + surcharge;
    }

    function _key(address nft, uint256 id) private pure returns (bytes32) {
        return keccak256(abi.encode(nft, id));
    }

    /// @dev Pulls one card from `from` and counts it only when its collection reports the shop as the owner.
    function _takeCard(address nft, uint256 id, address from) private {
        if (_slot[_key(nft, id)] != 0) revert NotHeld();
        IERC721Min(nft).transferFrom(from, address(this), id);
        if (IERC721Min(nft).ownerOf(id) != address(this)) revert TransferFailed();
        _addCard(nft, id);
    }

    function _addCard(address nft, uint256 id) private {
        _cards.push(Card(nft, id));
        _slot[_key(nft, id)] = _cards.length;
    }

    function _removeCard(address nft, uint256 id) private {
        bytes32 key = _key(nft, id);
        uint256 place = _slot[key] - 1;
        uint256 last = _cards.length - 1;
        if (place != last) {
            Card memory moved = _cards[last];
            _cards[place] = moved;
            _slot[_key(moved.nft, moved.id)] = place + 1;
        }
        _cards.pop();
        delete _slot[key];
    }

    /// @dev Exactly `amount` leaves the shop and reaches `to`, measured by STRICT balance reads on both sides.
    function _sendToken(address to, uint256 amount) private {
        uint256 shopBefore = _strictBalance(address(this));
        uint256 toBefore = _strictBalance(to);
        if (shopBefore < amount) revert BudgetShort();
        if (!_call(token, abi.encodeWithSignature("transfer(address,uint256)", to, amount))) revert TransferFailed();
        if (shopBefore - _strictBalance(address(this)) != amount || _strictBalance(to) - toBefore != amount) {
            revert TransferFailed();
        }
    }

    /// @dev Exactly `amount` leaves `from` and reaches the shop, measured by STRICT balance reads on both sides.
    function _pullToken(address from, uint256 amount) private {
        uint256 shopBefore = _strictBalance(address(this));
        uint256 fromBefore = _strictBalance(from);
        if (!_call(token, abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount))) {
            revert TransferFailed();
        }
        if (_strictBalance(address(this)) - shopBefore != amount || fromBefore - _strictBalance(from) != amount) {
            revert TransferFailed();
        }
    }

    /// @dev The token's balance of `who` for settlement: a failed or short read reverts (never read as zero).
    function _strictBalance(address who) private view returns (uint256) {
        if (token.code.length == 0) revert BalanceUnreadable();
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        if (!ok || ret.length < 32) revert BalanceUnreadable();
        return abi.decode(ret, (uint256));
    }

    /// @dev A low-level call whose answer is read as a word: nothing, or 1, is success; anything else is failure.
    function _call(address target, bytes memory data) private returns (bool) {
        if (target.code.length == 0) return false;
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) return false;
        if (ret.length == 0) return true;
        return ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
    }

    /// @dev A balance read that never reverts: 0 when the token has no code or answers badly.
    function _balanceOf(address coin, address who) private view returns (uint256) {
        if (coin.code.length == 0) return 0;
        (bool ok, bytes memory ret) = coin.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }
}
