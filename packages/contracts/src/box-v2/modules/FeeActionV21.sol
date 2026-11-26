// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverV2} from "../interfaces/IBoxReceiverV2.sol";
import {BoxRolesV2} from "../interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2 as C} from "../interfaces/ReleaseConstantsV2.sol";
import {BoxReceiverV2Args as A} from "../libraries/BoxReceiverV2Args.sol";
import {ReceiverViews} from "../libraries/ReceiverViews.sol";
import {CheckedBurn} from "../libraries/CheckedBurn.sol";
import {PricingToken} from "../libraries/PricingToken.sol";
import {BoxClones} from "../../box/libraries/BoxClones.sol";
import {BoxReceiverV2Actions} from "../BoxReceiverV2Actions.sol";


/// @notice Shared stateless action internals. Receiver custody and storage never move to these implementations.
abstract contract FeeActionV21 is BoxReceiverV2Actions {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    IPoolManager internal immutable _pm;
    ReceiverViews internal immutable _views;
    address private immutable _self;
    constructor(IPoolManager pm, ReceiverViews views) { _pm = pm; _views = views; _self = address(this); }
    modifier onlyCallback() {
        require(msg.sender == address(_pm), "ReceiverOnlyPoolManager");
        require(address(this) != _self, "ReceiverOnlyDelegate");
        _;
    }
    function _priceCoin() internal view returns (address) { return A.addressAt(A.P); }
    /// @dev Receiver callback only. Shared exact receipt check; each claim redemption fits int128.
    function _payClaims(address asset, address to, uint256 amount) internal {
        uint256 beforeBalance = PricingToken.balanceOf(asset, to);
        // Both burn and take narrow to int128 in v4. Complete each pair before
        // the next, keeping the transient currency delta zero between parts.
        uint256 left = amount;
        while (left != 0) {
            uint256 part = left > MAX_PAYOUT_PART ? MAX_PAYOUT_PART : left;
            _pm.burn(address(this), uint160(asset), part);
            _pm.take(Currency.wrap(asset), to, part);
            left -= part;
        }
        uint256 afterBalance = PricingToken.balanceOf(asset, to);
        uint256 received = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
        if (received != amount) revert IBoxReceiverV2.TransferNotExact(amount, received);
    }

    /// @dev Own pool only, exact-in P claims, dynamic 1% override plus the protocol fee in the minimum.
    function _buy(uint256 amount, bool claims) internal returns (uint256 spent, uint256 bought) {
        PoolKey memory key = PoolKey(
            Currency.wrap(_priceCoin()), Currency.wrap(A.addressAt(A.T)), C.V2_POOL_FEE, 60, IHooks(A.addressAt(A.HOOK))
        );
        (uint160 spot,, uint24 protocolFee,) = _pm.getSlot0(key.toId());
        uint160 limit = _views.buyLimit(spot);
        // The price limit bounds movement, not raw input. v4's filled delta and
        // the claims burn must fit positive int128; keep the rest in buyBackP.
        if (amount > MAX_PAYOUT_PART) amount = MAX_PAYOUT_PART;
        // The bound above also makes the signed exact-input encoding safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        BalanceDelta d = _pm.swap(key, SwapParams(true, -int256(amount), limit), "");
        (spent, bought) = _views.buyResult(d, amount, limit, protocolFee);
        _pm.burn(address(this), uint160(_priceCoin()), spent);
        if (claims) _pm.mint(address(this), key.currency1.toId(), bought);
        else _pm.take(key.currency1, address(this), bought);
    }
}
