// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseTaxVault} from "openfour-kit/contracts/taxvault/BaseTaxVault.sol";
import {ModuleEncodeSchema, ParamDescriptor} from "openfour-kit/contracts/libraries/OpenFourTypes.sol";
import {FeeRules} from "fee-rules-core/src/FeeRules.sol";

interface IOpenFourTokenVault {
    function vault() external view returns (address);
}

interface IWrappedNativeDeposit {
    function deposit() external payable;
}

/// @title PileTaxVault: a TaxVault template that hands a tax token's founder tax to its holders
/// @notice For OpenFour's tax-token presets (Bonding Tax V1) through the Royalty `ForwardVault`: create the token with
/// `founder` tax at 100% and `taxVaultTypeId = keccak256("SafuSkill.ForwardVault.v1")`,
/// `taxVaultInitParams = abi.encode((address(this template), bytes("")))`. ForwardVault clones this template while
/// the token is being created; right after creation anyone calls `createPile()` (it also happens on the first tax
/// received), which deploys one `FeeRules` pile for the token, in the quote coin, with the token's vault excluded
/// (the vault is not yet set while the clone is initialised). From then on the clone pushes every unit of tax it
/// receives into that pile: the bonding-curve tax and, after graduation, the DEX
/// transfer tax. Any holder redeems `pile × tokens handed in / tokens in circulation`; the tokens handed in are burned.
/// @dev `authorWallet()` is DEAD, so ForwardVault waives its 6% royalty and forwards everything. The clone renounces
/// the ownership BaseTaxVault gives the token creator; it has no owner, no setter and no withdrawal: the only way out
/// of the pile is a holder's redemption.
contract PileTaxVault is BaseTaxVault {
    using SafeERC20 for IERC20;

    bytes32 public constant TYPE_ID = keccak256("PileBonding.PileTaxVault.v1");
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The token's pile (a `FeeRules`); zero until `createPile()` (or the first tax received) creates it.
    address public pile;

    event PileCreated(address indexed token, address indexed pile, address indexed asset);
    /// @notice `sent` left the clone; `credited` is what the pile's balance actually rose by (they differ only for a
    /// quote coin that charges a fee on its own transfers).
    event TaxToPile(uint256 sent, uint256 credited, uint256 pileAfter);

    constructor() {
        _disableInitializers();
    }

    /// @notice No royalty: ForwardVault forwards the whole tax to the clone.
    function authorWallet() public pure override returns (address) {
        return DEAD;
    }

    /// @notice Native tax (quote = wrapped native): the clone's whole native balance is wrapped and pushed into the
    /// pile. With any other quote coin, native coin is refused.
    receive() external payable override {
        _wrapNative(true);
        _toPile();
    }

    /// @notice ERC-20 tax, called by ForwardVault after its transfer: everything held is pushed into the pile.
    function onERC20TaxReceived(address asset, uint256 amount) public override {
        super.onERC20TaxReceived(asset, amount); // only the token or the ForwardVault; only the quote coin
        _toPile();
    }

    /// @notice Anyone may push what the clone holds into the pile: native coin is wrapped first when the quote is
    /// the wrapped native coin (native that arrived without a call, e.g. from a self-destruct), then the quote coin.
    function flush() external {
        _wrapNative(false);
        _toPile();
    }

    /// @notice Creates the token's pile once the token exists; anyone may call it, and it runs only once.
    function createPile() external returns (address) {
        return _ensurePile();
    }

    function moduleEncodeSchema() external pure override returns (ModuleEncodeSchema memory) {
        return ModuleEncodeSchema("taxvault", 1, new ParamDescriptor[](0));
    }

    function _customInit(address[] calldata, bytes calldata initParams) internal override {
        require(initParams.length == 0, "PileTaxVault: no params");
        _setTypeId(TYPE_ID);
        _transferOwnership(address(0));
    }

    function _ensurePile() private returns (address p) {
        p = pile;
        if (p != address(0)) return p;
        address vault = IOpenFourTokenVault(_taxVaultToken).vault();
        require(vault != address(0), "PileTaxVault: token not created yet");
        address[] memory excluded = new address[](1);
        excluded[0] = vault;
        p = address(new FeeRules(_taxVaultToken, _taxVaultQuote, excluded));
        pile = p;
        emit PileCreated(_taxVaultToken, p, _taxVaultQuote);
    }

    /// @dev Wraps the clone's whole native balance into the quote coin. `strict`: a quote coin that is not the
    /// wrapped native coin (it has no `deposit`) refuses the native coin.
    function _wrapNative(bool strict) private {
        uint256 balance = address(this).balance;
        if (balance == 0) return;
        try IWrappedNativeDeposit(_taxVaultQuote).deposit{value: balance}() {}
        catch {
            if (strict) revert("PileTaxVault: native coin needs a wrapped-native quote");
        }
    }

    function _toPile() private {
        address p = _ensurePile();
        IERC20 q = IERC20(_taxVaultQuote);
        uint256 amount = q.balanceOf(address(this));
        if (amount == 0) return;
        uint256 before = q.balanceOf(p);
        q.safeTransfer(p, amount);
        uint256 afterBalance = q.balanceOf(p);
        emit TaxToPile(amount, afterBalance - before, afterBalance);
    }
}
