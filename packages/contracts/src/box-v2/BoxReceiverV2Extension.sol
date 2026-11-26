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
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverV2} from "./interfaces/IBoxReceiverV2.sol";
import {BoxRolesV2} from "./interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";
import {BoxReceiverV2Args as A} from "./libraries/BoxReceiverV2Args.sol";
import {ReceiverViews} from "./libraries/ReceiverViews.sol";
import {CheckedBurn} from "./libraries/CheckedBurn.sol";
import {PricingToken} from "./libraries/PricingToken.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxReceiverV2Actions} from "./BoxReceiverV2Actions.sol";

/// @notice Fixed callback code, constructed by one receiver implementation. Holds no persistent state or custody.
/// @dev Only that implementation's direct clones may delegate here, with PoolManager as the original caller.
/// The receiver consumes its armed action before delegation; there is no external route to choose another part.
contract BoxReceiverV2Extension is IUnlockCallback, BoxReceiverV2Actions {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager private immutable _pm;
    address public immutable receiverImplementation;
    ReceiverViews private immutable _views;

    /// @notice Constructed by the receiver release implementation; pins its manager and stateless views forever.
    constructor(IPoolManager pm, ReceiverViews views, address receiver) {
        _pm = pm;
        receiverImplementation = receiver;
        _views = views;
    }

    function _coordinator() private view returns (IBoxCoordinatorV2) {
        return IBoxCoordinatorV2(A.addressAt(A.COORDINATOR));
    }

    function _priceCoin() private view returns (address) {
        return A.addressAt(A.P);
    }

    /// @notice PoolManager only, delegated by a direct clone of this part's constructor caller.
    /// The receiver has already authenticated and consumed its armed action. Exact receipt and debit checks
    /// execute inside the same capped unlock; failure rolls back the entire callback and its money movements.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm), "ReceiverOnlyPoolManager");
        require(BoxClones.isCloneOf(address(this), receiverImplementation), "ReceiverOnlyDelegate");
        (uint256 action, address asset, address to, uint256 amount) =
            abi.decode(data, (uint256, address, address, uint256));
        if (action == PAY || action == TIP) {
            // Part lookups share the tip's stipend: a refused/malformed read leaves the tip at its source.
            if (action == TIP) {
                for (uint256 role; role < BoxRolesV2.ROLE_COUNT; ++role) {
                    if (to == _coordinator().roleAddress(role)) revert IBoxReceiverV2.InvalidChoice();
                }
            }
            _payClaims(asset, to, amount);
        } else if (action == FUND) {
            // Voluntary intake is exact and atomic. Pair each settlement with its mint
            // before the next part; both operations narrow to int128 in v4. The caller
            // chooses this amount; royalty-router sweeps bound their batch separately.
            while (amount != 0) {
                uint256 part = amount > MAX_PAYOUT_PART ? MAX_PAYOUT_PART : amount;
                PricingToken.settleToClaims(_pm, asset, part);
                amount -= part;
            }
        } else if (action == BURN) {
            CheckedBurn.burn(asset, amount);
        } else if (action == BURN_CLAIMS) {
            _payClaims(asset, address(this), amount);
            CheckedBurn.burn(asset, amount);
        } else if (action == BUY) {
            (uint256 spent, uint256 bought) = _buy(amount, false);
            return abi.encode(spent, bought);
        } else {
            revert IBoxReceiverV2.InvalidChoice();
        }
        return "";
    }

    /// @dev Receiver callback only. Shared exact receipt check; each claim redemption fits int128.
    function _payClaims(address asset, address to, uint256 amount) private {
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
    function _buy(uint256 amount, bool claims) private returns (uint256 spent, uint256 bought) {
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
