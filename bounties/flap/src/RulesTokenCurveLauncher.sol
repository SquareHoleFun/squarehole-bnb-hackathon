// SPDX-License-Identifier: MIT
// Text-only copy of src/TokenCurveLauncher.sol for the rules pair (script/rules-launchers.py): only names, string
// literals and comments differ.
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
import {CurveConfig} from "./RulesCurveLauncher.sol";
import {PileVault} from "./PileVault.sol";
import {TokenPileVaultFactory} from "./TokenPileVaultFactory.sol";

interface IERC20Q {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

/// @title RulesTokenCurveLauncher: the curve sale with an ERC-20 as the quote (for example a test USDT)
/// @notice The same mechanism as `RulesCurveLauncher`, priced and paid in one ERC-20 `quote` fixed by the factory: people
/// buy and sell along the curve before any pool exists; the buy that takes the last sale token launches on Flap's
/// Pool Launch Portal with the raise as the pool's quote side; buyers claim; the token's tax fills a PileVault held in
/// the quote; a missed deadline unwinds to everyone's net deposit. The `CurveConfig` fields read in the quote's units
/// (`targetRaise` and `virtualBnb` are amounts of the quote).
/// Exact movements, no change: a buy pulls exactly its cost plus fee by `transferFrom` and checks that exactly that
/// arrived (a quote that takes a cut or rebases makes the call revert); nothing more is ever pulled, so nothing is
/// sent back. Every payment out checks the recipient's credit and this contract's debit. No native coin moves here
/// except the Portal's salt-lock fee at creation: every other function refuses value, and there is no `receive`.
/// The rules are fixed at creation: no owner, no setter, a plain clone.
contract RulesTokenCurveLauncher is LauncherBase, IStrategy {
    using SafeTransferLib for address;

    /// @notice The Portal's anti-farmer window, the reference launcher's value.
    uint32 public constant ANTI_FARMER_DURATION = 1 days;

    address public immutable factory;
    address public immutable hub;
    /// @notice The vault factory named in the launch's VAULT fee slot (it serves exactly `quote`).
    address public immutable pileVaultFactory;
    address public immutable tokenImpl;
    /// @notice The quote this sale is priced, paid and pooled in.
    address public immutable quote;

    address public creator;
    uint256 public deadline;
    CurveConfig internal _cfg;
    uint256 public virtualTokens;
    uint256 public raiseTarget;
    uint256 public poolToken;
    uint256 public totalSupply;

    uint256 public sold;
    /// @notice Quote the curve holds: always R(sold) while the sale runs.
    uint256 public curveBalance;
    /// @notice Trade fees kept apart, in the quote; the pile's first money at the launch.
    uint256 public feePot;
    mapping(address account => uint256 amount) public tokensOf;
    mapping(address account => uint256 amount) public claimed;
    mapping(address account => uint256 amount) public paidIn;
    mapping(address account => uint256 amount) public paidOut;
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
    event Launched(address indexed token, address indexed pool, address indexed pileVault, uint256 toPile);
    event Claimed(address indexed account, uint256 amount);
    event Unwound(address indexed account, uint256 tokens, uint256 paid);

    error NotFactory();
    error AlreadyInitialized();
    error WrongValue(uint256 got, uint256 expected);
    error SaleClosed();
    error SaleNotFailed();
    error NothingBought();
    error BelowMinimum(uint256 got, uint256 min);
    error AboveMaximum(uint256 cost, uint256 max);
    error NotEnoughTokens();
    error NotLaunched();
    error NothingToClaim();
    error NothingToUnwind();
    error UnauthorizedDistribution();
    error InvalidDistribution();
    error LaunchMismatch(string what);
    error NotCompleted(uint256 tokensStillForSale);
    error InvalidRecipient();
    error InexactTransfer();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock == 2) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address hub_, address pileVaultFactory_, address tokenImpl_, address quote_) {
        factory = msg.sender;
        hub = hub_;
        pileVaultFactory = pileVaultFactory_;
        tokenImpl = tokenImpl_;
        quote = quote_;
        _initialized = true; // the implementation itself is never a Launcher
    }

    /// @notice Runs once, from the factory. `msg.value` is exactly the Portal's salt-lock fee (in the native coin),
    /// paid from this address so the Portal records it as the locker. There is no first buy in this variant: the
    /// creator buys like anyone else, after creation.
    function initialize(address creator_, CurveConfig calldata c) external payable {
        if (msg.sender != factory) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _lock = 2;
        uint256 fee = IPortal(hub).SALT_LOCK_FEE();
        if (msg.value != fee) revert WrongValue(msg.value, fee);

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
        _lock = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The curve
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Buy as many sale tokens as `maxCost` of the quote buys (fee included), at least `minTokens`; the
    /// caller approves this Launcher first. Exactly the cost plus fee is pulled, nothing more. The buy that takes the
    /// last sale token launches.
    function buy(uint256 maxCost, uint256 minTokens) external nonReentrant returns (uint256 tokens) {
        tokens = _buy(msg.sender, maxCost, minTokens);
        if (sold == _cfg.saleTokens) _launch();
    }

    /// @notice Buy every remaining sale token and launch, or revert as a whole; pulls exactly the cost of the rest
    /// plus fee, which must not exceed `maxCost`.
    function complete(uint256 maxCost) external nonReentrant returns (uint256 tokens) {
        if (launched || block.timestamp >= deadline) revert SaleClosed();
        uint256 rest = _cfg.saleTokens - sold;
        uint256 cost = raiseTarget - curveBalance;
        uint256 fee = CurveMath.feeOf(cost, _cfg.tradeFeeBps);
        if (cost + fee > maxCost) revert AboveMaximum(cost + fee, maxCost);
        tokens = _buy(msg.sender, cost + fee, rest);
        if (sold != _cfg.saleTokens) revert NotCompleted(_cfg.saleTokens - sold);
        _launch();
    }

    /// @notice Sell `tokens` back along the curve before the launch; receive at least `minOut` of the quote.
    function sell(uint256 tokens, uint256 minOut) external nonReentrant returns (uint256 paid) {
        if (launched || block.timestamp >= deadline) revert SaleClosed();
        if (tokens == 0 || tokensOf[msg.sender] < tokens) revert NotEnoughTokens();
        uint256 s = sold;
        uint256 rAfter = CurveMath.reserve(_cfg.virtualBnb, virtualTokens, s - tokens);
        uint256 proceeds = curveBalance - rAfter;
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
        if (paid != 0) _pay(msg.sender, paid);
    }

    /// @dev The largest buy `maxCost` pays for (exactly as the native launcher computes it), then pulls exactly its
    /// cost plus fee.
    function _buy(address to, uint256 maxCost, uint256 minTokens) private returns (uint256 n) {
        if (launched || block.timestamp >= deadline) revert SaleClosed();
        CurveConfig storage c = _cfg;
        uint256 s = sold;
        uint256 net = FixedPointMathLib.fullMulDiv(maxCost, 10_000, 10_000 + c.tradeFeeBps);
        if (net > raiseTarget - curveBalance) net = raiseTarget - curveBalance; // any cap above the rest buys the rest
        n = CurveMath.tokensForNet(c.virtualBnb, virtualTokens, s, net);
        if (n > c.saleTokens - s) n = c.saleTokens - s;
        if (n == 0) revert NothingBought();
        if (n < minTokens) revert BelowMinimum(n, minTokens);
        uint256 rAfter = CurveMath.reserve(c.virtualBnb, virtualTokens, s + n);
        uint256 cost = rAfter - curveBalance;
        uint256 fee = CurveMath.feeOf(cost, c.tradeFeeBps);

        if (tokensOf[to] == 0) ++holderCount;
        tokensOf[to] += n;
        sold = s + n;
        curveBalance = rAfter;
        feePot += fee;
        _track(to, cost + fee, 0);
        emit Bought(to, n, cost, fee, s + n);
        _pull(to, cost + fee);
    }

    function _track(address account, uint256 addIn, uint256 addOut) private {
        uint256 before = owed(account);
        paidIn[account] += addIn;
        paidOut[account] += addOut;
        totalOwed = totalOwed - before + owed(account);
    }

    /// @notice What `account` put in net, in the quote: paid for buys minus received for sells (zero if it took more
    /// out).
    function owed(address account) public view returns (uint256) {
        uint256 i = paidIn[account];
        uint256 o = paidOut[account];
        return i > o ? i - o : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // After the sale
    // ─────────────────────────────────────────────────────────────────────────

    function claim() external nonReentrant {
        if (!launched) revert NotLaunched();
        uint256 amount = tokensOf[msg.sender] - claimed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimed[msg.sender] += amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice After a missed deadline: take back what you put in net, by the same rule as the native launcher
    /// (`balance x owed / totalOwed`, rounded down, the last one owed emptying it), paid in the quote.
    function unwind() external returns (uint256 paid) {
        return unwindTo(msg.sender);
    }

    function unwindTo(address recipient) public nonReentrant returns (uint256 paid) {
        if (launched || block.timestamp < deadline) revert SaleNotFailed();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 o = owed(msg.sender);
        if (o == 0) revert NothingToUnwind();
        uint256 total = totalOwed;
        uint256 balance = IERC20Q(quote).balanceOf(address(this));
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
        if (paid != 0) _pay(recipient, paid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Exact movements of the quote
    // ─────────────────────────────────────────────────────────────────────────

    function _pull(address from, uint256 amount) private {
        uint256 before = IERC20Q(quote).balanceOf(address(this));
        quote.safeTransferFrom(from, address(this), amount);
        if (IERC20Q(quote).balanceOf(address(this)) != before + amount) revert InexactTransfer();
    }

    function _pay(address to, uint256 amount) private {
        uint256 here = IERC20Q(quote).balanceOf(address(this));
        uint256 there = IERC20Q(quote).balanceOf(to);
        quote.safeTransfer(to, amount);
        if (
            IERC20Q(quote).balanceOf(address(this)) != here - amount
                || IERC20Q(quote).balanceOf(to) != there + amount
        ) revert InexactTransfer();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views for a page
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice 0 selling, 1 launched, 2 failed (unwind open).
    function phase() public view returns (uint8) {
        if (launched) return 1;
        if (block.timestamp >= deadline) return 2;
        return 0;
    }

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

    /// @notice Everything a sale page shows, in one call. Amounts in the quote; prices in quote units per whole token.
    function progress() external view returns (Progress memory p) {
        uint256 s = sold < _cfg.saleTokens ? sold : _cfg.saleTokens;
        p.phase = phase();
        p.sold = sold;
        p.saleTokens = _cfg.saleTokens;
        p.curveBalance = curveBalance;
        p.raiseTarget = raiseTarget;
        p.feePot = feePot;
        if (p.phase == 2) {
            p.curveBalance = totalOwed == 0 ? 0 : IERC20Q(quote).balanceOf(address(this));
            p.feePot = 0;
        }
        p.priceNow = CurveMath.price(_cfg.virtualBnb, virtualTokens, s);
        p.deadline = deadline;
        p.holderCount = holderCount;
    }

    function launchInfo() external view returns (address token_, address pool_, address pileVault_) {
        return (token, pool, pileVault);
    }

    function config() external view returns (CurveConfig memory) {
        return _cfg;
    }

    function prices() external view returns (uint256 now_, uint256 start_, uint256 final_) {
        uint256 s = sold < _cfg.saleTokens ? sold : _cfg.saleTokens;
        return (
            CurveMath.price(_cfg.virtualBnb, virtualTokens, s),
            CurveMath.price(_cfg.virtualBnb, virtualTokens, 0),
            CurveMath.price(_cfg.virtualBnb, virtualTokens, _cfg.saleTokens)
        );
    }

    /// @notice What `buy(maxCost, 0)` would do now: tokens, curve cost, fee (cost + fee is what is pulled).
    function quoteBuy(uint256 maxCost) external view returns (uint256 tokens, uint256 cost, uint256 fee) {
        CurveConfig storage c = _cfg;
        uint256 s = sold;
        if (s >= c.saleTokens) return (0, 0, 0);
        uint256 net = FixedPointMathLib.fullMulDiv(maxCost, 10_000, 10_000 + c.tradeFeeBps);
        if (net > raiseTarget - curveBalance) net = raiseTarget - curveBalance; // any cap above the rest buys the rest
        tokens = CurveMath.tokensForNet(c.virtualBnb, virtualTokens, s, net);
        if (tokens > c.saleTokens - s) tokens = c.saleTokens - s;
        cost = CurveMath.reserve(c.virtualBnb, virtualTokens, s + tokens) - curveBalance;
        fee = CurveMath.feeOf(cost, c.tradeFeeBps);
    }

    function quoteSell(uint256 tokens) external view returns (uint256 proceeds, uint256 fee, uint256 paid) {
        proceeds = curveBalance - CurveMath.reserve(_cfg.virtualBnb, virtualTokens, sold - tokens);
        fee = CurveMath.feeOf(proceeds, _cfg.tradeFeeBps);
        if (fee > proceeds) fee = proceeds;
        paid = proceeds - fee;
    }

    /// @notice What `complete` pulls now: the cost of the rest plus its fee.
    function costToComplete() external view returns (uint256) {
        uint256 cost = raiseTarget - curveBalance;
        return cost + CurveMath.feeOf(cost, _cfg.tradeFeeBps);
    }

    function claimable(address account) external view returns (uint256) {
        return launched ? tokensOf[account] - claimed[account] : 0;
    }

    function predictedToken() public view returns (address) {
        return ClonesUpgradeable.predictDeterministicAddress(tokenImpl, _cfg.salt, hub);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch
    // ─────────────────────────────────────────────────────────────────────────

    function _launch() private {
        IPortalTypes.CreateTaxTokenParams memory p = _buildParams();
        Distribution memory dist = Distribution({
            target: DistributionTarget.EXPLICIT,
            strategy: address(this),
            amount: uint128(_cfg.saleTokens),
            configData: ""
        });
        IPortalTypes.CreatorBuyParams memory cb;

        // The Portal pulls the raise from here: approve exactly it, and nothing may remain approved afterwards.
        uint256 before = IERC20Q(quote).balanceOf(address(this));
        quote.safeApprove(hub, raiseTarget);
        _launching = true;
        (address token_, address pool_) = IPortal(hub).launchTaxTokenV2{value: 0}(p, dist, cb);
        _launching = false;
        if (!_distributed) revert InvalidDistribution();
        if (IERC20Q(quote).allowance(address(this), hub) != 0) revert LaunchMismatch("allowance");
        if (IERC20Q(quote).balanceOf(address(this)) != before - raiseTarget) revert LaunchMismatch("raise");

        if (token_ != predictedToken()) revert LaunchMismatch("token");
        if (SafeTransferLib.balanceOf(token_, address(this)) != _cfg.saleTokens) revert LaunchMismatch("sale tokens");
        (address vault, address vf) = IPortal(hub).getLaunchVault(token_);
        if (
            vf != pileVaultFactory || vault != TokenPileVaultFactory(pileVaultFactory).predictVault(token_)
                || vault.code.length == 0 || PileVault(payable(vault)).token() != token_
                || PileVault(payable(vault)).asset() != quote
        ) revert LaunchMismatch("vault");

        launched = true;
        token = token_;
        pool = pool_;
        curveBalance = 0;
        feePot = 0;
        pileVault = vault;
        // Everything left here goes to the pile: the curve fees, and any quote that reached this address unasked.
        uint256 toPile = IERC20Q(quote).balanceOf(address(this));
        emit Launched(token_, pool_, vault, toPile);
        if (toPile != 0) _pay(vault, toPile);
    }

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
        p.quoteToken = quote;
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
        d.quoteToken = quote;
        d.targetRaise = raiseTarget;
        d.poolTokenRatio = totalSupply == 0 ? 0 : FixedPointMathLib.fullMulDiv(poolToken, 1e18, totalSupply);
        d.titleEn = "Curve sale with the creator's rules";
        d.titleZh = d.titleEn;
        d.summaryEn = "Buy and sell along a price curve fixed at creation, before any pool exists. When the last sale "
            "token is bought, one transaction launches the token with the raise as its pool at the curve's final price, "
            "and buyers claim their tokens. If the deadline passes first, the sale unwinds and everyone takes back their "
            "share. " "Curve fees and part of every later trade's tax are shared by the creator's rules (creator, pile, buy and burn), fixed before the sale opened: read them at the RulesVaultFactory with rulesOf(this launcher); without rules, all of it fills a pile any holder can redeem.";
        d.summaryZh = d.summaryEn;
    }
}
