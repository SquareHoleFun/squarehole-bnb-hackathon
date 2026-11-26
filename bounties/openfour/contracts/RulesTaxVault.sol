// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseTaxVault} from "openfour-kit/contracts/taxvault/BaseTaxVault.sol";
import {ModuleEncodeSchema, ParamDescriptor} from "openfour-kit/contracts/libraries/OpenFourTypes.sol";
import {FeeRules} from "fee-rules-core/src/FeeRules.sol";
import {RuleSplitter} from "fee-rules-core/src/RuleSplitter.sol";
import {IRuleSplitter} from "fee-rules-core/src/IRuleSplitter.sol";

interface IRulesTokenVault {
    function vault() external view returns (address);
}

interface IRulesWrappedNative {
    function deposit() external payable;
}

/// @title RulesTaxVault: a TaxVault template whose tax token's founder tax is shared by the creator's rules
/// @notice For OpenFour's tax-token presets (Bonding Tax V1) through the Royalty `ForwardVault`, like `PileTaxVault`:
/// create the token with `founder` tax at 100%, `taxVaultTypeId = keccak256("SafuSkill.ForwardVault.v1")` and
/// `taxVaultInitParams = abi.encode((address(this template), abi.encode(Rules)))`. The rules (a creator payee and
/// three parts in basis points summing to 10,000: creator, pile, buy and burn) are part of the token's signed create
/// arguments, so they are final before the token exists: nothing can change them later (no owner, no setter; the
/// clone renounces the ownership BaseTaxVault gives it, and `initialize` runs once).
/// After creation anyone calls `createRules()` (it also happens on the first tax received): it deploys, for the token,
/// a `FeeRules` pile in the quote coin (when the pile part is above zero; the token's vault excluded) and one
/// `RuleSplitter` holding the non-zero rules in the order creator, pile, buy and burn (the last one gets the rounding
/// units). From then on every unit of tax the clone receives goes to the splitter: native coin (wrapped-native quote)
/// is wrapped first. Anyone calls the splitter's `distribute()` to pay the parts out.
/// @dev `authorWallet()` is DEAD, so ForwardVault waives its 6% royalty and forwards everything. The buy and burn rule
/// trades on the PancakeSwap V2 router fixed in this template's code (`router`, an immutable that every clone reads),
/// through the token's one pair with its quote coin. OpenFour registers that pair's address for the token at creation
/// (`migratedPools`) and refuses every transfer to or from it before the migration ("Token: pool transfer blocked
/// before migration"), so nobody can fund it early: until the migration the buy fails and the part stays owed. After
/// it, a pool buy does no tax work inside the token, so no income reaches the splitter while it buys.
contract RulesTaxVault is BaseTaxVault {
    using SafeERC20 for IERC20;

    bytes32 public constant TYPE_ID = keccak256("PileBonding.RulesTaxVault.v1");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant TOTAL_BPS = 10_000;

    /// @notice The creator's rules (initParams of the clone = abi.encode(Rules)).
    /// @param creator Who the creator part is paid to (zero only when creatorBps is 0).
    struct Rules {
        address creator;
        uint16 creatorBps;
        uint16 pileBps;
        uint16 burnBps;
    }

    /// @notice The PancakeSwap V2 router the buy and burn rule trades on (fixed when the template was deployed).
    address public immutable router;

    address public creator;
    uint16 public creatorBps;
    uint16 public pileBps;
    uint16 public burnBps;
    /// @notice The token's pile (zero when the pile part is 0, or before `createRules()`).
    address public pile;
    /// @notice The token's splitter; zero until `createRules()` (or the first tax received) creates it.
    address public splitter;

    event RulesCreated(
        address indexed token,
        address indexed splitter,
        address indexed pile,
        address asset,
        address creator,
        uint16 creatorBps,
        uint16 pileBps,
        uint16 burnBps
    );
    /// @notice `amount` of the quote coin left the clone for the splitter.
    event TaxToSplitter(uint256 amount);

    constructor(address router_) {
        require(router_ != address(0) && router_.code.length != 0, "RulesTaxVault: no router");
        router = router_;
        _disableInitializers();
    }

    /// @notice No royalty: ForwardVault forwards the whole tax to the clone.
    function authorWallet() public pure override returns (address) {
        return DEAD;
    }

    /// @notice Native tax (quote = wrapped native): wrapped and pushed to the splitter. Refused for any other quote.
    receive() external payable override {
        _wrapNative(true);
        _toSplitter();
    }

    /// @notice ERC-20 tax, called by ForwardVault after its transfer: everything held goes to the splitter.
    function onERC20TaxReceived(address asset, uint256 amount) public override {
        super.onERC20TaxReceived(asset, amount); // only the token or the ForwardVault; only the quote coin
        _toSplitter();
    }

    /// @notice Anyone: native coin held is wrapped (wrapped-native quote), then the quote coin held goes to the splitter.
    function flush() external {
        _wrapNative(false);
        _toSplitter();
    }

    /// @notice Anyone, once the token exists: creates the pile and the splitter (once; later calls return them).
    function createRules() external returns (address) {
        return _ensureRules();
    }

    function moduleEncodeSchema() external pure override returns (ModuleEncodeSchema memory) {
        ParamDescriptor[] memory p = new ParamDescriptor[](4);
        p[0] = ParamDescriptor("creator", "address", 0, false, "Creator payee", "", "Receives the creator part", "", "");
        p[1] = ParamDescriptor("creatorBps", "uint16", 0, false, "Creator part (bps)", "0", "Share of the tax paid to the creator", "0", "10000");
        p[2] = ParamDescriptor("pileBps", "uint16", 0, false, "Pile part (bps)", "10000", "Share of the tax into the holders' pile", "0", "10000");
        p[3] = ParamDescriptor("burnBps", "uint16", 0, false, "Buy and burn part (bps)", "0", "Share of the tax that buys the token and burns it", "0", "10000");
        return ModuleEncodeSchema("taxvault", 1, p);
    }

    /// @dev The rules are checked here, once, when ForwardVault clones the template during the token's creation: a
    /// bad set makes the creation itself revert.
    function _customInit(address[] calldata, bytes calldata initParams) internal override {
        Rules memory r = abi.decode(initParams, (Rules));
        require(uint256(r.creatorBps) + r.pileBps + r.burnBps == TOTAL_BPS, "RulesTaxVault: parts must sum to 10000");
        require(r.creatorBps == 0 || r.creator != address(0), "RulesTaxVault: no creator payee");
        // The clone itself as the payee would take the creator part back in, and flush() would share it again.
        require(r.creatorBps == 0 || r.creator != address(this), "RulesTaxVault: the clone cannot be the creator payee");
        creator = r.creatorBps == 0 ? address(0) : r.creator;
        creatorBps = r.creatorBps;
        pileBps = r.pileBps;
        burnBps = r.burnBps;
        _setTypeId(TYPE_ID);
        _transferOwnership(address(0));
    }

    function _ensureRules() private returns (address s) {
        s = splitter;
        if (s != address(0)) return s;
        address token = _taxVaultToken;
        address asset = _taxVaultQuote;
        address vault = IRulesTokenVault(token).vault();
        require(vault != address(0), "RulesTaxVault: token not created yet");
        uint256 n = (creatorBps != 0 ? 1 : 0) + (pileBps != 0 ? 1 : 0) + (burnBps != 0 ? 1 : 0);
        IRuleSplitter.Rule[] memory rules = new IRuleSplitter.Rule[](n);
        uint256 i;
        if (creatorBps != 0) rules[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.CREATOR, creatorBps, creator);
        address p;
        if (pileBps != 0) {
            address[] memory excluded = new address[](1);
            excluded[0] = vault;
            p = address(new FeeRules(token, asset, excluded));
            pile = p;
            rules[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.PILE, pileBps, p);
        }
        if (burnBps != 0) rules[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.BUY_BURN, burnBps, router);
        s = address(new RuleSplitter(token, asset, rules));
        splitter = s;
        emit RulesCreated(token, s, p, asset, creator, creatorBps, pileBps, burnBps);
    }

    /// @dev Wraps the clone's whole native balance into the quote coin. The clone holds no list of wrapped coins: the
    /// quote coin counts as the wrapped native coin only when its `deposit()` takes the value AND its balance of the
    /// clone grows by exactly that value (a coin whose payable fallback takes the call but mints nothing is refused).
    /// `strict` (native tax arriving): a quote coin without `deposit` refuses the native coin; in `flush()` the native
    /// coin then stays where it is.
    function _wrapNative(bool strict) private {
        uint256 balance = address(this).balance;
        if (balance == 0) return;
        IERC20 q = IERC20(_taxVaultQuote);
        uint256 before = q.balanceOf(address(this));
        try IRulesWrappedNative(_taxVaultQuote).deposit{value: balance}() {
            uint256 afterDeposit = q.balanceOf(address(this));
            require(afterDeposit >= before && afterDeposit - before == balance, "RulesTaxVault: the quote coin did not wrap the native coin");
        } catch {
            if (strict) revert("RulesTaxVault: native coin needs a wrapped-native quote");
        }
    }

    function _toSplitter() private {
        address s = _ensureRules();
        IERC20 q = IERC20(_taxVaultQuote);
        uint256 amount = q.balanceOf(address(this));
        if (amount == 0) return;
        q.safeTransfer(s, amount);
        emit TaxToSplitter(amount);
    }
}
