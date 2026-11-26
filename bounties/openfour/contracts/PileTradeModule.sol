// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IOpenFourTradeModule} from "openfour-kit/developer/startup/contracts/interfaces/IOpenFourTradeModule.sol";
import {IOpenFourModuleSchema} from "openfour-kit/developer/startup/contracts/interfaces/IOpenFourModuleSchema.sol";
import {IOpenFourToken} from "openfour-kit/developer/startup/contracts/interfaces/IOpenFourToken.sol";
import {IOpenFourVault} from "openfour-kit/developer/startup/contracts/interfaces/IOpenFourVault.sol";
import {
    OpenFourTypes,
    ParamDescriptor,
    ModuleEncodeSchema
} from "openfour-kit/developer/startup/contracts/libraries/OpenFourTypes.sol";
import {FeeRules} from "fee-rules-core/src/FeeRules.sol";

/// @title PileTradeModule (`module.trade.pile`)
/// @notice The Trade slot of the "Pile Bonding" preset. When OpenFour creates a token with this preset, the module's
/// `init` deploys one `FeeRules` pile for that token, held in the token's quote asset. From then on every buy and
/// sell on the bonding curve pays a fee tier to that pile, and any holder can redeem
/// `pile * tokens handed in / tokens in circulation` from it, with the tokens handed in burned.
/// The fee rates are fixed at creation and the pile has no owner: nothing in this module, in the validator or in the
/// pile can change the rules afterwards. The fee runs while the token trades on the curve; after migration to the
/// DEX the pile stops growing and stays redeemable.
/// @dev View-only `evaluate`, per the OpenFour Trade rules: no state is written while trading. A beacon proxy clone
/// per token, like every OpenFour module.
contract PileTradeModule is Initializable, IOpenFourTradeModule, IOpenFourModuleSchema {
    /// @notice The highest fee rate a token can choose, per side: 10%.
    uint16 public constant MAX_FEE_BPS = 1_000;
    string public constant TAG = "module.trade.pile";

    /// @notice Returned as `revertData` (never reverted with) when Core asks about another token.
    error PileTradeWrongToken(address token, address boundToken);

    /// @notice The creation parameters (tradeParams = abi.encode(Params)).
    /// @param buyFeeBps Share of every buy's curve quote paid into the pile, in basis points.
    /// @param sellFeeBps Share of every sell's curve quote paid into the pile, in basis points.
    struct Params {
        uint16 buyFeeBps;
        uint16 sellFeeBps;
    }

    event PileCreated(address indexed token, address indexed pile, address asset, uint16 buyFeeBps, uint16 sellFeeBps);

    address public boundToken;
    address public fourCore;
    /// @notice The token's pile (a `FeeRules`), created in `init`.
    address public pile;
    uint16 public buyFeeBps;
    uint16 public sellFeeBps;
    bytes private _initParams;
    string private _moduleVersion;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Binds this clone to one token and creates its pile. Called once, by OpenFour, at token creation.
    function init(address token, address fourCore_, bytes calldata params, string calldata moduleVersion_)
        external
        override
        initializer
    {
        require(fourCore_ != address(0), "PileTrade: zero fourCore");
        require(token != address(0), "PileTrade: zero token");
        Params memory p = abi.decode(params, (Params));
        require(p.buyFeeBps <= MAX_FEE_BPS && p.sellFeeBps <= MAX_FEE_BPS, "PileTrade: fee too high");
        require(p.buyFeeBps != 0 || p.sellFeeBps != 0, "PileTrade: no fee");

        address vault = IOpenFourToken(token).vault();
        address asset = IOpenFourVault(vault).quoteAsset();
        require(asset != address(0), "PileTrade: no quote asset");

        boundToken = token;
        fourCore = fourCore_;
        buyFeeBps = p.buyFeeBps;
        sellFeeBps = p.sellFeeBps;
        _initParams = params;
        _moduleVersion = moduleVersion_;
        pile = _newPile(token, asset, vault);
        emit PileCreated(token, pile, asset, p.buyFeeBps, p.sellFeeBps);
    }

    /// @notice Allows every trade and adds one fee tier: the side's rate, paid to the pile.
    function evaluate(OpenFourTypes.TradeContext calldata ctx)
        external
        view
        override
        returns (OpenFourTypes.TradeResult memory result)
    {
        if (ctx.token != boundToken) {
            return OpenFourTypes.TradeResult({
                allowed: false,
                minAmount: 0,
                maxAmount: 0,
                fees: new OpenFourTypes.FeeTier[](0),
                revertData: abi.encodeWithSelector(PileTradeWrongToken.selector, ctx.token, boundToken)
            });
        }
        uint16 bps = ctx.isBuy ? buyFeeBps : sellFeeBps;
        OpenFourTypes.FeeTier[] memory fees = new OpenFourTypes.FeeTier[](bps == 0 ? 0 : 1);
        if (bps != 0) fees[0] = OpenFourTypes.FeeTier({recipient: pile, bps: bps});
        return OpenFourTypes.TradeResult({
            allowed: true,
            minAmount: 0,
            maxAmount: type(uint256).max,
            fees: fees,
            revertData: ""
        });
    }

    function descriptor() external view override returns (bytes8 tagId, string memory tag, string memory version) {
        tag = TAG;
        return (bytes8(keccak256(bytes(tag))), tag, _moduleVersion);
    }

    function getInitParams() external view returns (bytes memory) {
        return _initParams;
    }

    function moduleEncodeSchema() external pure override returns (ModuleEncodeSchema memory) {
        ParamDescriptor[] memory p = new ParamDescriptor[](2);
        p[0] = ParamDescriptor({
            name: "buyFeeBps",
            abiType: "uint16",
            decimals: 0,
            optional: false,
            title: "Buy fee to the pile (bps)",
            defaultValue: "100",
            hint: "Share of every buy paid into the pile holders redeem from. 100 = 1%. Fixed for good at creation.",
            minValue: "0",
            maxValue: "1000"
        });
        p[1] = ParamDescriptor({
            name: "sellFeeBps",
            abiType: "uint16",
            decimals: 0,
            optional: false,
            title: "Sell fee to the pile (bps)",
            defaultValue: "100",
            hint: "Share of every sell paid into the pile holders redeem from. 100 = 1%. Fixed for good at creation.",
            minValue: "0",
            maxValue: "1000"
        });
        return ModuleEncodeSchema("trade", 1, p);
    }

    /// @dev The one place the pile is constructed. OpenFour mints the whole supply to the token's vault, which sells
    /// it on the curve and hands the rest to the DEX pair (or burns it) at migration. Excluding the vault makes
    /// "tokens in circulation" the tokens SOLD during the curve, and the pair's and holders' tokens after it. The
    /// vault is a contract nobody redeems through, so excluding it takes nothing away from a holder.
    function _newPile(address token, address asset, address vault) private returns (address) {
        address[] memory excluded = new address[](1);
        excluded[0] = vault;
        return address(new FeeRules(token, asset, excluded));
    }
}
