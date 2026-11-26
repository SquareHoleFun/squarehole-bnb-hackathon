// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverCodeV21, IFeeModulesV21} from "./interfaces/IFeeModulesV21.sol";
import {IBoxReceiverPayInTV21} from "./interfaces/IBoxReceiverPayInTV21.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {RoyaltyDestination} from "../box/interfaces/BoxTypes.sol";
import {FeeChoice} from "./interfaces/RecipeTypes.sol";
import {ProtocolSkip, IBoxHookV2} from "./interfaces/IBoxHookV2.sol";
import {HeldKind, FailRoute} from "./interfaces/FailureTableV2.sol";
import {IBoxReceiverV2, IBoxReceiverCursorsV21, IBoxReceiverFailedV21, IBoxReceiverItemsV2, ItemFundingV2, FeeBatchV2} from "./interfaces/IBoxReceiverV2.sol";
import {IBoxReceiverPileV21} from "./interfaces/IBoxReceiverPileV21.sol";
import {IBoxReceiverEatV21} from "./interfaces/IBoxReceiverEatV21.sol";
import {RewardAccountingV21 as Rewards} from "./libraries/RewardAccountingV21.sol";
import {BoxReceiverV2Base} from "./BoxReceiverV2Base.sol";
import {BoxReceiverV2Args as A} from "./libraries/BoxReceiverV2Args.sol";
import {FeeModuleProofV21} from "./libraries/FeeModuleProofV21.sol";
import {ReceiverRewardsV21} from "./libraries/ReceiverRewardsV21.sol";
import {ReceiverPendingV21} from "./libraries/ReceiverPendingV21.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";

/// @notice Receiver accepts price-coin royalties only; other royalty coins stay in the royalty router (the income inbox).
/// Fixed views and an authenticated callback share code; all fee and royalty books remain P claims.
contract BoxReceiverV2 is BoxReceiverV2Base, IBoxReceiverEatV21, IBoxReceiverPileV21, IFeeModulesV21, IBoxReceiverFailedV21, IBoxReceiverCursorsV21 {
    using Rewards for Rewards.State;
    /// @notice Release deployer fixes the coordinator implementation and payout Safes; no funds accepted.
    constructor(
        IPoolManager pm,
        address coordinatorImplementation_,
        address fitSafe,
        address platformSafe,
        ReceiverCodeV21 memory code
    ) BoxReceiverV2Base(pm, coordinatorImplementation_, fitSafe, platformSafe, code) {}

    /// @inheritdoc IFeeModulesV21
    function implementation() external view returns (address) { return _implementation; }
    /// @inheritdoc IFeeModulesV21
    function receiverCode() external view returns (address, address, address) {
        return (address(_views), _extension, address(_moduleDirectory));
    }
    /// @inheritdoc IFeeModulesV21
    function feeModule(uint8 choice) external view returns (address, bytes32) { return _feeModule(choice); }
    /// @inheritdoc IFeeModulesV21
    function verifyModules(uint8 buyers, uint8 sellers, uint32 buyersId, uint32 sellersId) external view {
        _verifyBuiltin(buyers);
        if (sellers != buyers) _verifyBuiltin(sellers);
        if (buyers == 10 || sellers == 10) FeeModuleProofV21.creation(address(_moduleDirectory), address(this), buyers, sellers, buyersId, sellersId);
    }
    function _verifyBuiltin(uint8 choice) private view {
        if (choice < 6 || choice >= 10) return;
        (address module, bytes32 hash) = _feeModule(choice);
        if (!_moduleDirectory.initialSelectable(uint32(choice - 6)) || module.codehash != hash) revert InvalidChoice();
    }
    /// @inheritdoc IFeeModulesV21
    function sideModule(bool sellers) external view returns (address module, bytes32 codeHash) {
        uint8 choice = uint8(A.uintAt(sellers ? A.SELLERS_CHOICE : A.BUYERS_CHOICE, 1));
        if (choice != 10) return _feeModule(choice);
        uint256 offset = sellers ? 339 : 287;
        return (A.addressAt(offset), bytes32(A.uintAt(offset + 20, 32)));
    }
    /// @inheritdoc IFeeModulesV21
    function modulePendingP(bool sellers) external view returns (uint256) { return _modulePending[sellers ? 1 : 0]; }
    /// @inheritdoc IFeeModulesV21
    function executeModule(bool sellers) external locked returns (uint256) {
        _prepare();
        if (_failed()) revert BoxFailed();
        if (!_graduationSettled) revert NotGraduated();
        uint256 slot;
        assembly ("memory-safe") { slot := _modulePending.slot }
        return ReceiverPendingV21.run(_pm, sellers, slot + (sellers ? 1 : 0), PILE_MOVE_GAS, PILE_MOVE_RESERVE_GAS);
    }

    /// @inheritdoc IBoxReceiverV2
    /// @dev Only the recorded clone of this release's coordinator may initialize a direct clone of this receiver.
    /// The coordinator's deploy/launch entries are factory-only; caller-supplied clone arguments confer no authority.
    function initialize() external locked {
        if (_initialized) revert AlreadyInitialised();
        if (
            msg.sender != A.addressAt(A.COORDINATOR)
                || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)
                || !BoxClones.isCloneOf(address(this), _implementation)
        ) revert NotCoordinator(msg.sender);
        (address payee, address vault, uint32 count, uint16 policies) = _views.checkInitial(address(this));
        if (payee != address(0)) _payee = payee;
        if (vault != address(0)) {
            // One initial write of the existing packed slot; no neighbouring state shares its upper six bytes.
            uint256 itemConfig = uint160(vault) | (uint256(count) << 160) | (uint256(policies) << 192);
            assembly ("memory-safe") { sstore(_itemVault.slot, itemConfig) }
        }
        _initialized = true;
    }

    /// @inheritdoc IBoxReceiverV2
    /// @dev Refused M1 tips remain unbooked; M2 tips remain in their original source before final funding.
    function collect(address tipTo) external locked returns (FeeBatchV2 memory batch) {
        _ready();
        _reconcile();
        if (_failureSettled) {
            batch.buyersP = _toPot();
        } else {
            // A token callback during coordinator failure cannot prematurely label the final fees as late pot receipts.
            if (_failed()) revert BoxFailed();
            _graduateIfDue();
            batch = _collectFees(tipTo);
        }
        emit Collected(msg.sender, tipTo, batch.buyersP, batch.sellersP, batch.qToReserve, batch.tip);
    }

    /// @inheritdoc IBoxReceiverCursorsV21
    function allocationCursors() external view returns (uint256 lastBuyer, uint256 lastSeller, uint256 openBuyer, uint256 openSeller) {
        IBoxHookV2 source = IBoxHookV2(A.addressAt(A.HOOK));
        return (_lastHolderBatch, _lastSellerBatch, source.currentTradeBatch(true), source.currentTradeBatch(false));
    }

    /// @inheritdoc IBoxReceiverFailedV21
    function failedCollectableP() external view returns (uint256) {
        return _failureSettled ? _unbooked() : 0;
    }

    /// @dev Shared final-source booking for collect and failure; failure supplies no tip recipient.
    function _collectFees(address tipTo) private returns (FeeBatchV2 memory batch) {
        (, uint256 sellers, uint256 reserve) = _harvestFees();
        batch.qToReserve = reserve;
        if (_hasSources()) {
            batch = _allocateBatches(tipTo, batch);
        } else {
            uint256 unbooked = _unbooked();
            batch.sellersP = sellers > unbooked ? unbooked : sellers;
            batch.buyersP = unbooked - batch.sellersP;
            uint256 tip;
            if (tipTo != address(0) && batch.buyersP >= A.uintAt(A.BATCH_MIN_Q, 16)) {
                // Amendment 3 C5.7: at most 5%, set aside only from buyers fees.
                tip = _tip(batch.buyersP);
            }
            batch.buyersP -= tip;
            _split(batch.buyersP, false);
            _split(batch.sellersP, true);
            batch.tip = _payTip(tipTo, tip); // M1 refusal leaves the set-aside amount unbooked
        }
    }

    /// @inheritdoc IBoxReceiverV2
    /// @dev Tips to this box's recorded parts or the PoolManager remain in buyBackP.
    function buyBack(address tipTo)
        external
        locked
        returns (ProtocolSkip skip, uint256 pSpent, uint256 tBought, uint256 tip)
    {
        _ready();
        _reconcile();
        if (_failed()) revert BoxFailed();
        _graduateIfDue();
        if (!_graduationSettled) revert NotGraduated();
        if (IBoxHookV2(A.addressAt(A.HOOK)).lastProtocolBlock() == block.number) return (
            ProtocolSkip.StepTaken, 0, 0, 0
        );
        uint256 minimum = A.uintAt(A.STEP_MIN_Q, 16);
        if (_rewards.total() != 0) {
            for (uint256 i; i < 4; ++i) {
                uint256 kind = (_rewards.next + i) % 4;
                uint256 waiting = kind == 0 ? _p[BUY_BACK] : _rewards.pending[kind - 1];
                if (waiting < minimum) continue;
                _rewards.next = (kind + 1) % 4;
                if (kind != 0) return _buyRewards(kind, tipTo);
                break;
            }
        }
        uint256 budget = _p[BUY_BACK];
        if (budget < minimum) return (ProtocolSkip.BelowMinimum, 0, 0, 0);
        uint256 reserve = tipTo == address(0) ? 0 : _tip(budget);
        (pSpent, tBought) = abi.decode(_unlock(BUY, address(0), address(0), budget - reserve), (uint256, uint256));
        _p[BUY_BACK] -= pSpent;
        _burnPending += tBought;
        uint256 burned = _burn();
        uint256 candidate = tipTo == address(0) ? 0 : _tip(pSpent);
        _p[BUY_BACK] -= candidate;
        tip = _payTip(tipTo, candidate);
        if (tip == 0) _p[BUY_BACK] += candidate;
        emit BoughtBack(pSpent, tBought, burned, tip);
    }

    // No token code runs in the swap/funding frame. The existing tip and burn caps isolate optional calls.
    function _buyRewards(uint256 kind, address tipTo)
        private returns (ProtocolSkip, uint256 spent, uint256 bought, uint256 tip)
    {
        return ReceiverRewardsV21.buy(_rewards, _itemFunding,
            ReceiverRewardsV21.Context(_pm, _itemVault, _itemCount, _itemPolicies), kind, tipTo);
    }

    /// @inheritdoc IBoxReceiverPayInTV21
    function rewardsPendingP() external view returns (uint256) { return _rewards.total(); }
    /// @inheritdoc IBoxReceiverPayInTV21
    function rewardsPendingByKind() external view returns (uint256, uint256, uint256) {
        return (_rewards.pending[0], _rewards.pending[1], _rewards.pending[2]);
    }
    /// @inheritdoc IBoxReceiverPayInTV21
    function rewardBurnPendingT() external view returns (uint256) { return _rewards.burnClaims; }

    /// @inheritdoc IBoxReceiverEatV21
    function eatPriceCoin() external locked returns (uint256) { return _movePendingP(false); }

    /// @inheritdoc IBoxReceiverPileV21
    function moveToPile() external locked returns (uint256) { return _movePendingP(true); }

    // Shared pending-P lifecycle. Each optional action debits only its own ledger and restores on refusal.
    function _movePendingP(bool pile) private returns (uint256 amount) {
        _prepare();
        if (_failed()) revert BoxFailed();
        if (!_graduationSettled) revert NotGraduated();
        uint256 slot;
        if (pile) { assembly ("memory-safe") { slot := _pilePendingP.slot } }
        else { assembly ("memory-safe") { slot := _eatPendingP.slot } }
        return ReceiverPendingV21.move(_pm, pile, _priceCoin(), pile ? A.addressAt(A.LENGTH + 4) : address(0xdEaD),
            slot, priceBurnSelector() != bytes4(0), pile ? PILE_MOVE_GAS : EAT_GAS,
            pile ? PILE_MOVE_RESERVE_GAS : EAT_RESERVE_GAS);
    }
    /// @inheritdoc IBoxReceiverPileV21
    function pilePendingP() external view returns (uint256) { return _pilePendingP; }
    /// @inheritdoc IBoxReceiverPileV21
    function pileMovedP() external view returns (uint256) { return _pileMovedP; }

    /// @inheritdoc IBoxReceiverEatV21
    function eatPendingP() external view returns (uint256) { return _eatPendingP; }
    /// @inheritdoc IBoxReceiverEatV21
    function eatenP() external view returns (uint256) { return _eatenP; }
    /// @inheritdoc IBoxReceiverEatV21
    function priceBurnSelector() public view returns (bytes4) { return bytes4(uint32(A.uintAt(A.LENGTH, 4))); }

    /// @inheritdoc IBoxReceiverV2
    function burnPending() external locked returns (uint256 burned) {
        _ready();
        return _burn() + _burnRewardClaims();
    }

    /// @inheritdoc IBoxReceiverV2
    /// @dev Pays at most four int128-sized parts; the unpaid ledger remains for later calls.
    function payFit() external locked returns (uint256 amount) {
        _prepare();
        amount = _payOwed(FIT, _fitSafe);
        if (amount != 0) emit FitPaid(_fitSafe, amount);
    }

    /// @inheritdoc IBoxReceiverV2
    /// @dev Pays at most four int128-sized parts; the unpaid ledger remains for later calls.
    function payPlatform() external locked returns (uint256 amount) {
        _prepare();
        amount = _payOwed(PLATFORM, _platformSafe);
        if (amount != 0) emit PlatformPaid(_platformSafe, amount);
    }

    /// @inheritdoc IBoxReceiverV2
    /// @dev Pays at most four int128-sized parts. A refused batch reverts; prior calls stay paid.
    function claimCreator(address asset, address to) external locked returns (uint256 amount) {
        _readyPayee();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        if (_failed()) revert BoxFailed();
        _reconcile();
        _graduateIfDue();
        if (!_graduationSettled) revert NotGraduated();
        if (asset != _priceCoin()) return 0;
        amount = _payoutBatch(_p[CREATOR]);
        _p[CREATOR] -= amount;
        if (amount != 0) _unlock(PAY, asset, to, amount);
        emit CreatorClaimed(msg.sender, asset, to, amount);
    }

    /// @inheritdoc IBoxReceiverV2
    function proposeCreatorPayee(address proposed) external locked {
        _readyPayee();
        if (proposed == address(0) || proposed == address(this)) revert ZeroAddress();
        _pendingPayee = proposed;
        emit CreatorPayeeProposed(_payee, proposed);
    }

    function _readyPayee() private view {
        _ready();
        if (msg.sender != _payee) revert NotPayee(msg.sender);
    }

    /// @inheritdoc IBoxReceiverV2
    function acceptCreatorPayee() external locked {
        _ready();
        if (msg.sender != _pendingPayee) revert NotPendingPayee(msg.sender);
        address previous = _payee;
        _payee = msg.sender;
        _pendingPayee = address(0);
        emit CreatorPayeeChanged(previous, msg.sender);
    }

    /// @inheritdoc IBoxReceiverV2
    function onGraduation() external locked {
        _ready();
        if (msg.sender != A.addressAt(A.COORDINATOR)) revert NotCoordinator(msg.sender);
        if (_failed()) revert BoxFailed();
        if (!_coordinator().graduated()) revert NotGraduated();
        _reconcile();
        _graduateIfDue();
    }

    /// @inheritdoc IBoxReceiverV2
    function enterFailure() external locked {
        _ready();
        if (msg.sender != A.addressAt(A.COORDINATOR)) revert NotCoordinator(msg.sender);
        require(_coordinator().failed() && !_coordinator().graduated(), "ReceiverNotFailed");
        if (_failureSettled) return;
        // Set the phase under the lock before allocating final-source dust; any failure rolls it back.
        _failureSettled = true;
        _reconcile();
        _collectFees(address(0));
        _routeFailureBooks();
    }

    /// @inheritdoc IBoxReceiverV2
    function fundRoyalty(address asset, uint256 amount) external payable locked {
        _ready();
        if (asset != _priceCoin()) revert InvalidChoice();
        _reconcile();
        _graduateIfDue();
        uint256 required = asset == address(0) ? amount : 0;
        if (msg.value != required) revert WrongValue(msg.value, required);
        if (asset != address(0)) _pullRoyalty(asset, amount);
        emit RoyaltyFunded(asset, RoyaltyDestination(A.uintAt(A.ROYALTY_DESTINATION, 1)), amount);
        if (_coordinator().failed() && !_failureSettled) revert BoxFailed();
        if (amount != 0) _unlock(FUND, asset, address(0), amount);
        if (_failureSettled) _toPot();
        else if (_graduationSettled) _bookRoyalty(amount);
        else _p[ROYALTY] += amount;
    }

    /// @inheritdoc IBoxReceiverV2
    function poolManager() external view returns (IPoolManager) {
        return _pm;
    }

    /// @inheritdoc IBoxReceiverV2
    function FIT_SAFE() external view returns (address) {
        return _fitSafe;
    }

    /// @inheritdoc IBoxReceiverV2
    function PLATFORM_SAFE() external view returns (address) {
        return _platformSafe;
    }

    /// @inheritdoc IBoxReceiverV2
    function coordinator() external view returns (address) {
        return A.addressAt(A.COORDINATOR);
    }

    /// @inheritdoc IBoxReceiverV2
    function hook() external view returns (address) {
        return A.addressAt(A.HOOK);
    }

    /// @inheritdoc IBoxReceiverV2
    function token() external view returns (address) {
        return A.addressAt(A.T);
    }

    /// @inheritdoc IBoxReceiverV2
    function q() external view returns (address) {
        return _priceCoin();
    }

    /// @inheritdoc IBoxReceiverV2
    function launchRouter() external view returns (address) {
        return A.addressAt(A.LAUNCH_ROUTER);
    }

    /// @inheritdoc IBoxReceiverV2
    function registry() external view returns (address) {
        return A.addressAt(A.REGISTRY);
    }

    /// @inheritdoc IBoxReceiverV2
    function boxId() external view returns (uint256) {
        return A.uintAt(A.BOX_ID, 32);
    }

    /// @inheritdoc IBoxReceiverV2
    function holderLedger() external view returns (address) {
        return A.addressAt(A.HOLDER_LEDGER);
    }

    /// @inheritdoc IBoxReceiverV2
    function itemLedger() external view returns (address) {
        return A.addressAt(A.ITEM_LEDGER);
    }

    /// @inheritdoc IBoxReceiverV2
    function creatorPayee() external view returns (address) {
        return _payee;
    }

    /// @inheritdoc IBoxReceiverV2
    function pendingCreatorPayee() external view returns (address) {
        return _pendingPayee;
    }

    /// @inheritdoc IBoxReceiverV2
    function buyersChoice() external view returns (FeeChoice) {
        return FeeChoice(A.uintAt(A.BUYERS_CHOICE, 1));
    }

    /// @inheritdoc IBoxReceiverV2
    function sellersChoice() external view returns (FeeChoice) {
        return FeeChoice(A.uintAt(A.SELLERS_CHOICE, 1));
    }

    /// @inheritdoc IBoxReceiverV2
    function royaltyDestination() external view returns (RoyaltyDestination) {
        return RoyaltyDestination(A.uintAt(A.ROYALTY_DESTINATION, 1));
    }

    /// @inheritdoc IBoxReceiverV2
    function graduationSettled() external view returns (bool) {
        return _graduationSettled;
    }

    /// @inheritdoc IBoxReceiverV2
    function tBurnPending() external view returns (uint256) {
        return _burnPending;
    }

    /// @inheritdoc IBoxReceiverV2
    function fitOwed() external view returns (uint256) {
        return _p[FIT];
    }

    /// @inheritdoc IBoxReceiverV2
    function platformOwed() external view returns (uint256) {
        return _p[PLATFORM];
    }

    /// @inheritdoc IBoxReceiverV2
    function poolHeldP() external view returns (uint256) {
        return _p[POOL];
    }

    /// @inheritdoc IBoxReceiverV2
    function growHeldP() external view returns (uint256) {
        return _p[GROW];
    }

    /// @inheritdoc IBoxReceiverV2
    function creatorP() external view returns (uint256) {
        return _p[CREATOR];
    }

    /// @inheritdoc IBoxReceiverV2
    function buyBackP() external view returns (uint256) {
        return _p[BUY_BACK];
    }

    /// @inheritdoc IBoxReceiverV2
    function itemsHeldP() external view returns (uint256) {
        return _p[ITEMS];
    }

    /// @inheritdoc IBoxReceiverV2
    function royaltyHeldP() external view returns (uint256) {
        return _p[ROYALTY];
    }

    /// @inheritdoc IBoxReceiverV2
    function creatorOwed(address asset) external view returns (uint256 owed, uint256 held) {
        if (asset != _priceCoin()) return (0, 0);
        return _graduationSettled ? (_p[CREATOR], uint256(0)) : (uint256(0), _p[CREATOR]);
    }

    /// @inheritdoc IBoxReceiverV2
    function booked(address asset) external view returns (uint256) {
        return asset == _priceCoin() ? _bookedP() : 0;
    }

    /// @inheritdoc IBoxReceiverV2
    function holderBatchPaid(uint256 batchId) external view returns (uint256) {
        return _holderPaid(batchId);
    }

    /// @inheritdoc IBoxReceiverV2
    function holderBatchClosed(uint256 batchId) external view returns (bool) {
        return _holderClosed(batchId);
    }

    /// @inheritdoc IBoxReceiverV2
    function harvestedFees() external view returns (uint256 buyers, uint256 sellers, uint256 reserve) {
        return (_harvestedBuyers, _harvestedSellers, _harvestedReserve);
    }

    /// @inheritdoc IBoxReceiverItemsV2
    function itemFundingCount() external view returns (uint256) { return _itemFunding.length; }

    /// @inheritdoc IBoxReceiverItemsV2
    function itemFunding(uint256 receiptId) external view returns (ItemFundingV2 memory) {
        if (receiptId == 0 || receiptId > _itemFunding.length) revert InvalidChoice();
        return _itemFunding[receiptId - 1];
    }
}
