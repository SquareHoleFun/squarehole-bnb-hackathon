// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {RewardAccountingV21 as R} from "./RewardAccountingV21.sol";
import {BoxReceiverV2Args as A} from "./BoxReceiverV2Args.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2, ItemFundingV2} from "../interfaces/IBoxReceiverV2.sol";
import {IBoxReceiverPayInTV21} from "../interfaces/IBoxReceiverPayInTV21.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../interfaces/IBoxVaultV2.sol";
import {ProtocolSkip} from "../interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../interfaces/ReleaseConstantsV2.sol";

/// @notice Fixed core accounting for bought rewards. Not a selectable module; linked immutably per release.
library ReceiverRewardsV21 {
    using R for R.State;
    struct Context { IPoolManager pm; address vault; uint32 count; uint16 policies; }
    /// @notice Locked graduated receiver only, after queue/step admission. Keeps the existing funded-batch identity.
    function buy(R.State storage s, ItemFundingV2[] storage journal, Context memory c, uint256 kind, address tipTo)
        external returns (ProtocolSkip, uint256 spent, uint256 bought, uint256 tip)
    {
        uint256 budget = s.pending[kind - 1];
        uint256 reserve = tipTo == address(0) ? 0 : _tip(budget);
        (spent, bought) = abi.decode(_unlock(c.pm, kind == 1 ? 8 : 11, address(0), address(0), budget - reserve), (uint256, uint256));
        s.pending[kind - 1] -= spent;
        uint256 paid = bought;
        uint256 retained;
        if (kind == 1) {
            require(c.pm.transfer(A.addressAt(A.HOLDER_LEDGER), uint160(A.addressAt(A.T)), bought), "ClaimsTransferFailed");
        } else {
            (paid, retained) = _items(s, journal, c, bought, kind == 3);
        }
        uint256 candidate = tipTo == address(0) ? 0 : _tip(spent);
        s.pending[kind - 1] -= candidate;
        if (candidate != 0 && tipTo != address(0) && tipTo != address(this) && tipTo != address(c.pm)) {
            if (_tryUnlock(c.pm, 6, A.addressAt(A.P), tipTo, candidate, C.TIP_GAS)) tip = candidate;
        }
        if (tip == 0) s.pending[kind - 1] += candidate;
        if (kind == 1) s.consume(spent + tip, bought);
        else _burn(s, c.pm);
        emit IBoxReceiverPayInTV21.RewardsBought(kind == 1 ? 7 : 8, kind == 1 ? 0 : kind == 2 ? 1 : 2, spent, bought, paid, retained, tip);
        return (ProtocolSkip.None, spent, bought, tip);
    }
    function _items(R.State storage s, ItemFundingV2[] storage journal, Context memory c, uint256 amount, bool sellers)
        private returns (uint256 paid, uint256 retained)
    {
        uint256 inside = IBoxVaultV2(c.vault).inside();
        uint256 hidden = IBoxVaultV2(c.vault).hiddenCount();
        if (inside > c.count || hidden > inside) revert IBoxReceiverV2.InvalidChoice();
        if (uint8(c.policies >> (sellers ? 8 : 0)) == 2) retained = inside * (amount / c.count);
        paid = amount - retained;
        s.burnClaims += retained;
        if (paid != 0) require(c.pm.transfer(A.addressAt(A.ITEM_LEDGER), uint160(A.addressAt(A.T)), paid), "ClaimsTransferFailed");
        // Depth already removed the inside P before conversion. Express the outside-only T as
        // an equal per-item basis so the unchanged ledger identity still proves its exact backing:
        // basis - inside * floor(basis/N) == bought. The basis is not a T purchase or a liability.
        if (uint8(c.policies >> (sellers ? 8 : 0)) == 3) {
            uint256 outside = c.count - inside;
            if (outside == 0) revert IBoxReceiverV2.InvalidChoice();
            amount = (amount / outside) * c.count + amount % outside;
        }
        ItemFundingV2 memory f = ItemFundingV2(0, IBoxVaultItemsV2(c.vault).itemLifecycleCount(), amount, paid,
            uint32(inside), uint32(hidden), sellers ? 2 : 1, 2);
        journal.push(f);
        emit IBoxReceiverItemsV2.ItemFunded(journal.length, f.batchId, f.side, f.source, f.choiceP, f.ledgerP);
    }
    /// @notice Locked receiver only; burns at most one int128 portion. Refusal preserves backed T for retry.
    function burn(R.State storage s, IPoolManager pm) external returns (uint256) { return _burn(s, pm); }
    function _burn(R.State storage s, IPoolManager pm) private returns (uint256 amount) {
        amount = s.burnClaims;
        if (amount == 0) return 0;
        uint256 maximum = uint256(uint128(type(int128).max));
        if (amount > maximum) amount = maximum;
        s.burnClaims -= amount;
        if (!_tryUnlock(pm, 9, A.addressAt(A.T), address(0), amount, C.BURN_GAS)) {
            s.burnClaims += amount;
            return 0;
        }
        emit IBoxReceiverPayInTV21.RewardTBurned(amount);
    }
    function _tip(uint256 amount) private view returns (uint256) {
        uint256 tip = FullMath.mulDiv(amount, C.TIP_BPS, C.BPS);
        uint256 cap = A.uintAt(A.TIP_MAX_Q, 16);
        return tip > cap ? cap : tip;
    }
    function _arm(uint256 action) private {
        bytes32 slot = keccak256("squarehole.receiver.v2.unlock");
        assembly ("memory-safe") { tstore(slot, action) }
    }
    function _unlock(IPoolManager pm, uint256 action, address asset, address to, uint256 amount) private returns (bytes memory result) {
        _arm(action);
        result = pm.unlock(abi.encode(action, asset, to, amount));
        _arm(0);
    }
    function _tryUnlock(IPoolManager pm, uint256 action, address asset, address to, uint256 amount, uint256 stipend) private returns (bool ok) {
        require(gasleft() >= stipend + stipend / 63 + C.POKE_OVERHEAD_GAS, "ReceiverGasTooLow");
        _arm(action);
        try pm.unlock{gas: stipend}(abi.encode(action, asset, to, amount)) { ok = true; } catch {}
        _arm(0);
    }
}
