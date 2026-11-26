// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPortalTypes, IPortal} from "src/flap/IPortal.sol";
import {LauncherBase} from "src/flap/LauncherBase.sol";
import {Distribution, DistributionTarget} from "src/flap/Distribution.sol";
import {IStrategy} from "src/flap/IStrategy.sol";
import {LaunchExtensionHelper} from "src/flap/LaunchExtensionHelper.sol";
import {LauncherDescription} from "src/flap/LauncherHelper.sol";
import {LauncherRecord} from "src/flap/ILauncher.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {CurveMath} from "./CurveMath.sol";
import {PileVaultFactory} from "./PileVaultFactory.sol";
import {PileVault} from "./PileVault.sol";

/// @notice The rules of one curve sale, fixed when the Launcher is created. Payload of
/// `Portal.newLauncher(factory, abi.encode(CurveConfig))` and argument of the factory's direct `createLauncher`.
/// @param name          Token name.
/// @param symbol        Token symbol.
/// @param meta          Metadata URI, passed to the token unchanged.
/// @param salt          CREATE2 launch salt; the predicted token address must end in 0x7777 (`predictToken`).
/// @param saleTokens    Tokens sold along the curve (18 decimals); all of them are claimed by their buyers.
/// @param targetRaise   BNB on the curve when every sale token is sold (exactly R(saleTokens), see `raiseTarget`);
///                      all of it becomes the pool's BNB side.
/// @param virtualBnb    The curve's virtual BNB X0: sets the start price X0 / Y0. Larger is flatter.
/// @param duration      Seconds from creation until the deadline; unsold at the deadline, the sale unwinds.
/// @param tradeFeeBps   Fee on each curve buy and sell (at most 500); kept apart, it is the pile's first money.
/// @param buyTaxBps     Tax on every pool buy after the launch, in bps (at most 1000, Flap's limit).
/// @param sellTaxBps    Tax on every pool sell after the launch, in bps (at most 1000).
/// @param burnShareBps  Share of the tax burned (0..9999); the rest fills the pile.
/// @param taxDuration   Seconds the tax runs after launch (validated by the Portal).
struct CurveConfig {
    string name;
    string symbol;
    string meta;
    bytes32 salt;
    uint256 saleTokens;
    uint256 targetRaise;
    uint256 virtualBnb;
    uint64 duration;
    uint16 tradeFeeBps;
    uint16 buyTaxBps;
    uint16 sellTaxBps;
    uint16 burnShareBps;
    uint32 taxDuration;
}

/// @title CurveLauncher: a curve sale that either graduates into a Flap pool or unwinds
/// @notice Before any pool exists, people buy from this Launcher along a constant-product price curve fixed at
/// creation, and may sell back along the same curve at any time before the launch. The Launcher always holds exactly
/// what the curve says, R(sold), to the last wei (see `CurveMath`). A small fee on each curve trade is kept apart.
/// When the last sale token is bought, that same transaction launches on Flap's Pool Launch Portal: the raised BNB
/// becomes the pool at the curve's final price (so nobody's tokens are worth less the block after), the buyers'
/// tokens become claimable, the fee pot is the pile's first money, and from then on the token's buy and sell tax,
/// part burned and the rest into the pile, raises a floor any holder can redeem.
/// If the deadline passes first, buying and selling stop and the sale unwinds: every account takes back what it put
/// in net (BNB paid for buys, fees included, minus BNB received for sells). That is exactly everyone's money: the
/// Launcher holds the sum of those nets. Only if someone sold back at a profit before the deadline is the
/// Launcher short of the others' nets, and then each of them gets the same share of their net (the last one
/// emptying the Launcher), in any order.
/// The rules are fixed at creation: no owner, no setter, a plain clone (not a proxy).
contract CurveLauncher is LauncherBase, IStrategy {
    using SafeTransferLib for address;

    uint16 public constant MAX_TRADE_FEE_BPS = 500;
    /// @notice The Portal's anti-farmer window, the reference launcher's value.
    uint32 public constant ANTI_FARMER_DURATION = 1 days;

    /// @notice The factory that created this Launcher (the only caller of `initialize`).
    address public immutable factory;
    /// @notice The Pool Launch Portal.
    address public immutable hub;
    /// @notice The vault factory named in the launch's VAULT fee slot.
    address public immutable pileVaultFactory;
    /// @notice The tax-token implementation the Portal clones: the launch must return the token it predicts.
    address public immutable tokenImpl;

    address public creator;
    uint256 public deadline;
    CurveConfig internal _cfg;
    /// @notice The curve's virtual tokens Y0, derived at creation.
    uint256 public virtualTokens;
    /// @notice The exact BNB on the curve when every sale token is sold: R(saleTokens).
    uint256 public raiseTarget;
    /// @notice Tokens seeded into the pool at the launch, and the token's whole supply (saleTokens + poolToken).
    uint256 public poolToken;
    uint256 public totalSupply;

    /// @notice Sale tokens bought and not sold back (before the launch; tokens outstanding after a failure).
    uint256 public sold;
    /// @notice BNB the curve holds: always R(sold) while the sale runs.
    uint256 public curveBalance;
    /// @notice Trade fees kept apart; the pile's first money at the launch (shared back in an unwind).
    uint256 public feePot;
    mapping(address account => uint256 amount) public tokensOf;
    mapping(address account => uint256 amount) public claimed;
    /// @notice BNB each account paid for curve buys (fees included), and received for curve sells.
    mapping(address account => uint256 amount) public paidIn;
    mapping(address account => uint256 amount) public paidOut;
    /// @notice The sum over all accounts of `owed(account)`; never below this Launcher's balance before the launch.
    uint256 public totalOwed;
    uint256 public holderCount;

    bool public launched;
    address public token;
    address public pool;
    address public pileVault;

    bool private _initialized;
    bool private _launching;
    bool private _distributed;
    uint256 private _lock;

    event Bought(address indexed account, uint256 tokens, uint256 cost, uint256 fee, uint256 sold);
    event Sold(address indexed account, uint256 tokens, uint256 proceeds, uint256 fee, uint256 sold);
    event Launched(address indexed token, address indexed pool, address indexed pileVault, uint256 feesToPile);
    event Claimed(address indexed account, uint256 amount);
    event Unwound(address indexed account, uint256 tokens, uint256 paid);

    error NotFactory();
    error AlreadyInitialized();
    error WrongValue(uint256 got, uint256 expected);
    error SaleClosed();
    error SaleNotFailed();
    error NothingBought();
    error BelowMinimum(uint256 got, uint256 min);
    error NotEnoughTokens();
    error NotLaunched();
    error NothingToClaim();
    error NothingToUnwind();
    error UnauthorizedDistribution();
    error InvalidDistribution();
    error FirstBuyCompletesSale();
    error LaunchMismatch(string what);
    error NotCompleted(uint256 tokensStillForSale);
    error InvalidRecipient();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address hub_, address pileVaultFactory_, address tokenImpl_) {
        factory = msg.sender;
        hub = hub_;
        pileVaultFactory = pileVaultFactory_;
        tokenImpl = tokenImpl_;
        _initialized = true; // the implementation itself is never a Launcher
    }

    /// @notice Runs once, from the factory, in the transaction that creates this clone. Locks the launch salt from
    /// this address (the Portal requires `locker == launcher`). Any value above the salt-lock fee is the creator's
    /// first buy, at the start price, with the trade fee; what it cannot buy is sent back to the creator.
    /// @dev The trading lock is held through the whole call, the salt payment and the creator's refund included, so
    /// no trading function can be entered from the creator's refund (or anything else) before this returns.
    function initialize(address creator_, CurveConfig calldata c) external payable {
        if (msg.sender != factory) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _lock = 2;

        uint256 fee = IPortal(hub).SALT_LOCK_FEE();
        if (msg.value < fee) revert WrongValue(msg.value, fee);

        creator = creator_;
        _cfg = c;
        deadline = block.timestamp + c.duration;
        uint256 y0 = CurveMath.virtualTokens(c.virtualBnb, c.targetRaise, c.saleTokens);
        virtualTokens = y0;
        uint256 r = CurveMath.reserve(c.virtualBnb, y0, c.saleTokens);
        raiseTarget = r;
        poolToken = CurveMath.poolToken(c.virtualBnb, y0, c.saleTokens, r);
        totalSupply = c.saleTokens + poolToken;

        IPortal(hub).lockSalt{value: fee}(c.salt, uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX));
        if (msg.value > fee) {
            uint256 left = _buy(creator_, msg.value - fee, 0);
            if (sold == c.saleTokens) revert FirstBuyCompletesSale();
            if (left != 0) creator_.safeTransferETH(left);
        }
        _lock = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The curve
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Spend `msg.value` (fee included) on the curve; at least `minTokens` or nothing. What the curve
    /// cannot take (the last sale tokens cost less) is sent back. The buy that takes the last sale token launches.
    function buy(uint256 minTokens) external payable nonReentrant returns (uint256 tokens) {
        uint256 soldBefore = sold;
        uint256 left = _buy(msg.sender, msg.value, minTokens);
        tokens = sold - soldBefore;
        if (sold == _cfg.saleTokens) _launch(left);
        if (left != 0) msg.sender.safeTransferETH(left);
    }

    /// @notice Buy every remaining sale token and launch, or nothing: reverts unless this call launches (a sell-back
    /// between quote and inclusion can no longer turn it into a partial buy). Send `costToComplete()` plus a margin;
    /// what is not needed comes back.
    function complete() external payable nonReentrant returns (uint256 tokens) {
        uint256 soldBefore = sold;
        uint256 left = _buy(msg.sender, msg.value, 0);
        if (sold != _cfg.saleTokens) revert NotCompleted(_cfg.saleTokens - sold);
        tokens = sold - soldBefore;
        _launch(left);
        if (left != 0) msg.sender.safeTransferETH(left);
    }

    /// @notice Sell `tokens` back along the curve before the launch; receive at least `minOut` (fee deducted).
    function sell(uint256 tokens, uint256 minOut) external nonReentrant returns (uint256 paid) {
        if (launched || block.timestamp >= deadline) revert SaleClosed();
        if (tokens == 0 || tokensOf[msg.sender] < tokens) revert NotEnoughTokens();
        uint256 s = sold;
        uint256 rNow = curveBalance;
        uint256 rAfter = CurveMath.reserve(_cfg.virtualBnb, virtualTokens, s - tokens);
        uint256 proceeds = rNow - rAfter;
        uint256 fee = CurveMath.feeOf(proceeds, _cfg.tradeFeeBps);
        if (fee > proceeds) fee = proceeds;
        paid = proceeds - fee;
        if (paid < minOut) revert BelowMinimum(paid, minOut);

        tokensOf[msg.sender] -= tokens;
        if (tokensOf[msg.sender] == 0) --holderCount;
        sold = s - tokens;
        curveBalance = rAfter;
        feePot += fee;
        _track(msg.sender, 0, paid);
        emit Sold(msg.sender, tokens, proceeds, fee, s - tokens);
        if (paid != 0) msg.sender.safeTransferETH(paid);
    }

    /// @dev Spends `budget` for `to`; returns what is left. Exact: cost = R(s + n) - R(s), fee = ceil(cost x bps).
    function _buy(address to, uint256 budget, uint256 minTokens) private returns (uint256 left) {
        if (launched || block.timestamp >= deadline) revert SaleClosed();
        CurveConfig storage c = _cfg;
        uint256 s = sold;
        uint256 net = FixedPointMathLib.fullMulDiv(budget, 10_000, 10_000 + c.tradeFeeBps);
        uint256 n = CurveMath.tokensForNet(c.virtualBnb, virtualTokens, s, net);
        if (n > c.saleTokens - s) n = c.saleTokens - s;
        if (n == 0) revert NothingBought();
        if (n < minTokens) revert BelowMinimum(n, minTokens);
        uint256 rAfter = CurveMath.reserve(c.virtualBnb, virtualTokens, s + n);
        uint256 cost = rAfter - curveBalance;
        uint256 fee = CurveMath.feeOf(cost, c.tradeFeeBps);
        left = budget - cost - fee; // cost + fee <= budget by construction (see CurveMath.tokensForNet)

        if (tokensOf[to] == 0) ++holderCount;
        tokensOf[to] += n;
        sold = s + n;
        curveBalance = rAfter;
        feePot += fee;
        _track(to, cost + fee, 0);
        emit Bought(to, n, cost, fee, s + n);
    }

    /// @dev Keeps `totalOwed` equal to the sum of every account's `owed`.
    function _track(address account, uint256 addIn, uint256 addOut) private {
        uint256 before = owed(account);
        paidIn[account] += addIn;
        paidOut[account] += addOut;
        totalOwed = totalOwed - before + owed(account);
    }

    /// @notice What `account` put in net: BNB paid for buys minus BNB received for sells (zero if it took more out).
    function owed(address account) public view returns (uint256) {
        uint256 i = paidIn[account];
        uint256 o = paidOut[account];
        return i > o ? i - o : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // After the sale
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice After the launch: claim your tokens, one for one with what you bought.
    function claim() external nonReentrant {
        if (!launched) revert NotLaunched();
        uint256 amount = tokensOf[msg.sender] - claimed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimed[msg.sender] += amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice After a missed deadline: take back what you put in net, `balance x owed / totalOwed` (exactly your
    /// net when nobody sold at a profit), rounded down; the last account owed empties the Launcher. Any order.
    function unwind() external returns (uint256 paid) {
        return unwindTo(msg.sender);
    }

    /// @notice The same, paid to `recipient` (for an account that cannot receive plain BNB). Only the account owed
    /// can direct its own refund.
    function unwindTo(address recipient) public nonReentrant returns (uint256 paid) {
        if (launched || block.timestamp < deadline) revert SaleNotFailed();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 o = owed(msg.sender);
        if (o == 0) revert NothingToUnwind();
        uint256 total = totalOwed;
        uint256 balance = address(this).balance;
        paid = o == total ? balance : FixedPointMathLib.fullMulDiv(balance, o, total);
        totalOwed = total - o;
        paidOut[msg.sender] = paidIn[msg.sender];
        uint256 tokens = tokensOf[msg.sender];
        if (tokens != 0) {
            tokensOf[msg.sender] = 0;
            --holderCount;
            sold -= tokens;
        }
        emit Unwound(msg.sender, tokens, paid);
        if (paid != 0) recipient.safeTransferETH(paid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views for a page
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice 0 selling, 1 launched, 2 failed (deadline passed before the last sale token: unwind open).
    function phase() public view returns (uint8) {
        if (launched) return 1;
        if (block.timestamp >= deadline) return 2;
        return 0;
    }

    /// @notice Everything a sale page shows, in one call. Prices are BNB wei per whole token.
    struct Progress {
        uint8 phase;
        uint256 sold;
        uint256 saleTokens;
        uint256 curveBalance;
        uint256 raiseTarget;
        uint256 feePot;
        uint256 priceNow;
        uint256 deadline;
        uint256 holderCount;
    }

    function progress() external view returns (Progress memory p) {
        uint256 s = sold < _cfg.saleTokens ? sold : _cfg.saleTokens;
        p.phase = phase();
        p.sold = sold;
        p.saleTokens = _cfg.saleTokens;
        p.curveBalance = curveBalance;
        p.raiseTarget = raiseTarget;
        p.feePot = feePot;
        if (p.phase == 2) {
            // unwinding: what is left to refund is the whole balance while anyone is owed, and nothing once nobody
            // is (BNB left then cannot be refunded to anyone); the curve and fee split no longer applies
            p.curveBalance = totalOwed == 0 ? 0 : address(this).balance;
            p.feePot = 0;
        }
        p.priceNow = CurveMath.price(_cfg.virtualBnb, virtualTokens, s);
        p.deadline = deadline;
        p.holderCount = holderCount;
    }

    /// @notice After the launch: the token, its pool and its pile.
    function launchInfo() external view returns (address token_, address pool_, address pileVault_) {
        return (token, pool, pileVault);
    }

    /// @notice The rules of this sale, as created.
    function config() external view returns (CurveConfig memory) {
        return _cfg;
    }

    /// @notice The curve's marginal price now, and at the last sale token (the pool's opening price).
    function prices() external view returns (uint256 now_, uint256 start_, uint256 final_) {
        uint256 s = sold < _cfg.saleTokens ? sold : _cfg.saleTokens;
        return (
            CurveMath.price(_cfg.virtualBnb, virtualTokens, s),
            CurveMath.price(_cfg.virtualBnb, virtualTokens, 0),
            CurveMath.price(_cfg.virtualBnb, virtualTokens, _cfg.saleTokens)
        );
    }

    /// @notice What `buy` would do with `budget` now: tokens, curve cost, fee, and BNB sent back.
    function quoteBuy(uint256 budget) external view returns (uint256 tokens, uint256 cost, uint256 fee, uint256 refund) {
        CurveConfig storage c = _cfg;
        uint256 s = sold;
        if (s >= c.saleTokens) return (0, 0, 0, budget);
        uint256 net = FixedPointMathLib.fullMulDiv(budget, 10_000, 10_000 + c.tradeFeeBps);
        tokens = CurveMath.tokensForNet(c.virtualBnb, virtualTokens, s, net);
        if (tokens > c.saleTokens - s) tokens = c.saleTokens - s;
        cost = CurveMath.reserve(c.virtualBnb, virtualTokens, s + tokens) - curveBalance;
        fee = CurveMath.feeOf(cost, c.tradeFeeBps);
        refund = budget - cost - fee;
    }

    /// @notice What `sell(tokens, 0)` would pay now: proceeds along the curve, the fee, and the BNB paid.
    function quoteSell(uint256 tokens) external view returns (uint256 proceeds, uint256 fee, uint256 paid) {
        proceeds = curveBalance - CurveMath.reserve(_cfg.virtualBnb, virtualTokens, sold - tokens);
        fee = CurveMath.feeOf(proceeds, _cfg.tradeFeeBps);
        if (fee > proceeds) fee = proceeds;
        paid = proceeds - fee;
    }

    /// @notice BNB the whole remaining sale costs now (fee included): the buy that would launch.
    function costToComplete() external view returns (uint256) {
        uint256 cost = raiseTarget - curveBalance;
        return cost + CurveMath.feeOf(cost, _cfg.tradeFeeBps);
    }

    /// @notice Tokens `account` can claim now.
    function claimable(address account) external view returns (uint256) {
        return launched ? tokensOf[account] - claimed[account] : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev `keep` is the launching buyer's change, still in this balance and sent back after the launch.
    function _launch(uint256 keep) private {
        IPortalTypes.CreateTaxTokenParams memory p = _buildParams();
        Distribution memory dist = Distribution({
            target: DistributionTarget.EXPLICIT,
            strategy: address(this),
            amount: uint128(_cfg.saleTokens),
            configData: ""
        });
        IPortalTypes.CreatorBuyParams memory cb;

        _launching = true;
        (address token_, address pool_) = IPortal(hub).launchTaxTokenV2{value: raiseTarget}(p, dist, cb);
        _launching = false;
        if (!_distributed) revert InvalidDistribution();

        // Check what came back before accepting it: the predicted token, the buyers' tokens all here, and a vault
        // that is OUR PileVault for this token. A mismatch reverts the launching buy; the sale stays open.
        if (token_ != predictedToken()) revert LaunchMismatch("token");
        if (SafeTransferLib.balanceOf(token_, address(this)) != _cfg.saleTokens) revert LaunchMismatch("sale tokens");
        (address vault, address vf) = IPortal(hub).getLaunchVault(token_);
        if (vf != pileVaultFactory || vault != PileVaultFactory(pileVaultFactory).predictVault(token_, address(0))) {
            revert LaunchMismatch("vault");
        }
        // ... and that the pile exists and is this token's native pile (an empty address would take the fees and
        // leave nothing to redeem)
        if (vault.code.length == 0 || PileVault(payable(vault)).token() != token_ || PileVault(payable(vault)).asset() != address(0)) {
            revert LaunchMismatch("vault");
        }

        launched = true;
        token = token_;
        pool = pool_;
        curveBalance = 0;
        feePot = 0;
        pileVault = vault;
        // Everything left here but the buyer's change goes to the pile: the curve fees, and any BNB that reached
        // this address unasked.
        uint256 toPile = address(this).balance - keep;
        emit Launched(token_, pool_, vault, toPile);
        if (toPile != 0) vault.safeTransferETH(toPile); // the pile's first money
    }

    /// @notice The token address the Portal creates for this sale's salt.
    function predictedToken() public view returns (address) {
        return ClonesUpgradeable.predictDeterministicAddress(tokenImpl, _cfg.salt, hub);
    }

    /// @inheritdoc IStrategy
    /// @dev The Portal's callback inside `_launch`: pull the buyers' tokens it approved.
    function initializeDistribution(address token_, uint256 amount, bytes calldata, bytes32) external override onlyHub {
        if (!_launching || _distributed) revert UnauthorizedDistribution();
        if (token_ != predictedToken() || amount != _cfg.saleTokens) revert InvalidDistribution();
        _distributed = true;
        token_.safeTransferFrom(msg.sender, address(this), amount);
        emit FlapDistributionInitialized(token_, amount);
    }

    function _buildParams() private view returns (IPortalTypes.CreateTaxTokenParams memory p) {
        CurveConfig storage c = _cfg;
        p.name = c.name;
        p.symbol = c.symbol;
        p.meta = c.meta;
        p.totalSupply = totalSupply;
        p.salt = c.salt;
        p.quoteToken = address(0);
        p.dexId = 0;
        p.poolQuote = raiseTarget;
        p.poolToken = poolToken;
        p.buyTaxRate = c.buyTaxBps;
        p.sellTaxRate = c.sellTaxBps;
        p.taxDuration = c.taxDuration;
        p.antiFarmerDuration = ANTI_FARMER_DURATION;
        p.feeConfigs = feeConfigs(c.burnShareBps, pileVaultFactory);
        p.antiSniperMode = 0;
        p.exemptWindow = 0;
        p.exemptAddrs = new address[](0);
        p.creatorBuyQuote = 0;
        // Show the creator, not this contract, on the launch event; the Portal honours it for a Launcher it
        // recorded (created through `Portal.newLauncher`). A Launcher created directly sends no extension.
        LauncherRecord memory rec = IPortal(hub).getLauncher(address(this));
        if (rec.launcherFactory != address(0)) {
            (p.extensionID, p.extensionData) = LaunchExtensionHelper.encodeCreator(creator);
        }
        p.commissionReceiver = address(0);
    }

    /// @notice The fee slots: `burnShareBps` burned (DEFLATION), the rest to the pile (VAULT).
    function feeConfigs(uint16 burnShareBps, address vaultFactory)
        public
        pure
        returns (IPortalTypes.FeeConfig[] memory fees)
    {
        bytes memory vaultCfg = abi.encode(IPortalTypes.FeeConfigVault({vaultFactory: vaultFactory, vaultData: ""}));
        if (burnShareBps == 0) {
            fees = new IPortalTypes.FeeConfig[](1);
            fees[0] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.VAULT, bps: 10_000, configData: vaultCfg});
        } else {
            fees = new IPortalTypes.FeeConfig[](2);
            fees[0] =
                IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.DEFLATION, bps: burnShareBps, configData: ""});
            fees[1] = IPortalTypes.FeeConfig({
                feeType: IPortalTypes.FeeSlotType.VAULT,
                bps: 10_000 - burnShareBps,
                configData: vaultCfg
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LauncherBase
    // ─────────────────────────────────────────────────────────────────────────

    function _getHub() internal view override returns (address) {
        return hub;
    }

    function _description() internal view override returns (LauncherDescription memory d) {
        d.name = _cfg.name;
        d.symbol = _cfg.symbol;
        d.quoteToken = address(0);
        d.targetRaise = raiseTarget;
        d.poolTokenRatio = totalSupply == 0 ? 0 : FixedPointMathLib.fullMulDiv(poolToken, 1e18, totalSupply);
        d.titleEn = "Curve sale with a pile";
        d.titleZh = d.titleEn;
        d.summaryEn = "Buy and sell along a price curve fixed at creation, before any pool exists. When the last sale "
            "token is bought, one transaction launches the token with the raise as its pool at the curve's final price, "
            "and buyers claim their tokens. If the deadline passes first, the sale unwinds and everyone takes back their "
            "share of the BNB. Curve fees and part of every later trade's tax fill a pile any holder can redeem.";
        d.summaryZh = d.summaryEn;
    }
}
