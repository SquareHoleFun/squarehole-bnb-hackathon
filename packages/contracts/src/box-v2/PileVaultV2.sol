// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {IBoxToken} from "../box/interfaces/IBoxToken.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {IPileVaultV2} from "./interfaces/IPileVaultV2.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IListingRegistry} from "./interfaces/IListingRegistry.sol";
import {BoxRolesV2} from "./interfaces/IBoxRegistryV2.sol";
import {PricingToken} from "./libraries/PricingToken.sol";

/// @title Coin pile with optional fee intake and leave-behind
/// @notice A fixed listed asset backs pro-rata T burns after graduation. Failed seeds return separately.
/// @dev Standard BoxClones arguments (112 bytes): coordinator at 0, T at 20, asset at 40, seeder at 60,
/// uint256 seed amount at 80; extended clones append uint16 leaveBehindBps at 112.
/// Receiver fee moves use the fixed PoolManager; no swap, rescue or T release entry.
/// M3-32 owns factory encoding. M2-33 owns the role-19 gate; M3-40 must include all held T in H.
/// Transfers here are atomic caller operations, never best-effort lifecycle callbacks. In particular,
/// enterFailure performs no external call; a hostile seed cannot delay the coordinator's failure.
/// The creator is the immutable seeder (R43 Q5). Under R43-M3D/Q4, live fixed-asset gifts join
/// redemption; failed surplus, unrelated tokens and forced native funds have no rescue or exit.
contract PileVaultV2 is IPileVaultV2, BoxCloneBase, TransientReentrancyGuard {
    error NotCoordinator();
    error InvalidWiring();
    error WrongPhase();
    error WrongValue();
    error InvalidRedemption();
    error BelowMinimum();
    error InexactMovement();

    /// @notice Records the exact seed pulled from the immutable seeder, or supplied by it as native value.
    event SeedLoaded(address indexed seeder, address indexed asset, uint256 amount);
    /// @notice Records the coordinator's graduation notice; no funds move.
    event GateOpened();
    /// @notice Records caller T burned and fixed-asset payment to its chosen recipient.
    event Redeemed(address indexed holder, address indexed to, uint256 tIn, uint256 assetOut);
    /// @notice Records failure without calling either asset; seed payout remains independent.
    event FailureEntered();
    /// @notice Records the failed seed paid only to its original seeder (zero if never loaded).
    event SeedReturned(address indexed seeder, uint256 amount);

    /// @notice Anyone reads the release's authenticated coordinator implementation; no funds move.
    address public immutable coordinatorImplementation;
    address private immutable _implementation;
    uint256 private constant _INITIALIZED = 1;
    uint256 private constant _LOADED = 2;
    uint256 private constant _GRADUATED = 4;
    uint256 private constant _FAILED = 8;
    uint256 private constant _RETURNED = 16;
    uint256 private _state;

    /// @notice Release deployer fixes coordinator authentication; no funds move.
    constructor(address coordinatorImplementation_) {
        if (coordinatorImplementation_.code.length == 0) revert InvalidWiring();
        coordinatorImplementation = coordinatorImplementation_;
        _implementation = address(this);
    }

    /// @inheritdoc IPileVaultV2
    function initialize() external nonReentrant {
        IBoxCoordinatorV2 c = _coordinator();
        if (msg.sender != address(c) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator();
        }
        if (_state != 0) revert WrongPhase();
        if (!BoxClones.isCloneOf(address(this), _implementation)
            || (address(this).code.length != BoxClones.ARGS_OFFSET + 112
                && address(this).code.length != BoxClones.ARGS_OFFSET + 114)
            || (leaveBehindBps() != 0 && leaveBehindBps() != 500)) revert InvalidWiring();
        address t = _token();
        address a = asset();
        if (t.code.length == 0 || t != c.token() || a == t || (a != address(0) && a.code.length == 0)
            || seeder() == address(0) || seeder() == address(this) || seeder() != c.creator()
            || c.roleAddress(BoxRolesV2.ROLE_VAULT) != address(this)
            || c.starterSetLoader() != (seedAmount() == 0 ? address(0) : address(this))) revert InvalidWiring();
        (bool listed,) = IListingRegistry(c.listingRegistry()).newestListingOf(a);
        if (!listed || c.failed() || c.graduated()) revert InvalidWiring();
        _state = _INITIALIZED | (seedAmount() == 0 ? _LOADED : 0);
    }

    /// @inheritdoc IPileVaultV2
    function loadSeed() external payable nonReentrant {
        _initialized();
        IBoxCoordinatorV2 c = _coordinator();
        if (_state != _INITIALIZED || c.gateOpen() || c.failed() || c.graduated()) revert WrongPhase();
        address a = asset();
        uint256 amount = seedAmount();
        if (a == address(0)) {
            if (msg.sender != seeder() || msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            _pull(a, seeder(), amount);
        }
        _state |= _LOADED;
        // Required gate transition, not fail-safe: a refusal rolls the seed pull back for retry.
        c.starterSetLoaded();
        emit SeedLoaded(seeder(), a, amount);
    }

    /// @inheritdoc IPileVaultV2
    function openGate() external nonReentrant {
        _onlyCoordinator();
        if (_state != (_INITIALIZED | _LOADED) || !_coordinator().graduated()) revert WrongPhase();
        _state |= _GRADUATED;
        emit GateOpened();
    }

    /// @inheritdoc IPileVaultV2
    function quoteRedeem(uint256 tIn) external view returns (uint256 assetOut) {
        _initialized();
        if (tIn == 0) return 0;
        uint256 supply = IBoxToken(_token()).totalSupply();
        if (tIn > supply) revert InvalidRedemption();
        return _quote(PricingToken.balanceOf(asset(), address(this)), tIn, supply);
    }

    /// @inheritdoc IPileVaultV2
    function redeem(uint256 tIn, uint256 minOut, address to) external nonReentrant returns (uint256 assetOut) {
        if (_state != (_INITIALIZED | _LOADED | _GRADUATED)) revert WrongPhase();
        if (tIn == 0 || to == address(0) || to == address(this)) revert InvalidRedemption();
        address t = _token();
        uint256 supply = IBoxToken(t).totalSupply();
        if (tIn > supply) revert InvalidRedemption();
        uint256 beforeT = IBoxToken(t).balanceOf(address(this));
        uint256 beforeAsset = PricingToken.balanceOf(asset(), address(this));
        assetOut = _quote(beforeAsset, tIn, supply);
        if (assetOut < minOut) revert BelowMinimum();
        _pull(t, msg.sender, tIn);
        IBoxToken(t).burn(tIn);
        if (IBoxToken(t).totalSupply() != supply - tIn || IBoxToken(t).balanceOf(address(this)) != beforeT) {
            revert InexactMovement();
        }
        // Check even a zero-output operation: T's callbacks cannot alter the pre-burn pile snapshot.
        if (PricingToken.balanceOf(asset(), address(this)) != beforeAsset) revert InexactMovement();
        _pay(to, assetOut);
        emit Redeemed(msg.sender, to, tIn, assetOut);
    }

    /// @inheritdoc IPileVaultV2
    function enterFailure() external nonReentrant {
        _onlyCoordinator();
        if (_state & (_GRADUATED | _FAILED) != 0) revert WrongPhase();
        _state |= _FAILED;
        emit FailureEntered();
    }

    /// @inheritdoc IPileVaultV2
    function returnSeed() external nonReentrant returns (uint256 amount) {
        _initialized();
        if (_state & (_FAILED | _RETURNED) != _FAILED) revert WrongPhase();
        _state |= _RETURNED;
        if (_state & _LOADED != 0) amount = seedAmount();
        _pay(seeder(), amount);
        emit SeedReturned(seeder(), amount);
    }

    /// @inheritdoc IPileVaultV2
    function seeder() public view returns (address) { return _argAddress(60); }
    /// @inheritdoc IPileVaultV2
    function asset() public view returns (address) { return _argAddress(40); }
    /// @inheritdoc IPileVaultV2
    function seedAmount() public view returns (uint256) { return _argUint(80, 32); }
    /// @inheritdoc IPileVaultV2
    function supplyFloor() external pure returns (uint256) { return 0; }
    /// @inheritdoc IPileVaultV2
    function collectionSize() external pure returns (uint256) { return 0; }
    /// @inheritdoc IPileVaultV2
    function inside() external pure returns (uint256) { return 0; }

    /// @notice Anyone reads the immutable redemption preset; legacy 112-byte clones read zero.
    function leaveBehindBps() public view returns (uint256) { return _argUint(112, 2); }

    /// @notice Only the fixed PoolManager may deliver native fee P after graduation. No accounting callback.
    /// ERC-20 fees arrive through its exact take; both become part of the live redemption balance.
    receive() external payable {
        if (_state != (_INITIALIZED | _LOADED | _GRADUATED) || asset() != address(0)
            || msg.sender != _coordinator().poolManager()) revert WrongPhase();
    }

    function _quote(uint256 balance, uint256 tIn, uint256 supply) private view returns (uint256) {
        if (tIn == supply) return balance; // No remaining holder: leave nothing stranded.
        uint256 share = FullMath.mulDiv(balance, tIn, supply);
        return FullMath.mulDiv(share, 10_000 - leaveBehindBps(), 10_000);
    }

    function _coordinator() private view returns (IBoxCoordinatorV2) { return IBoxCoordinatorV2(_argAddress(0)); }
    function _token() private view returns (address) { return _argAddress(20); }
    function _initialized() private view { if (_state & _INITIALIZED == 0) revert WrongPhase(); }
    function _onlyCoordinator() private view {
        _initialized();
        if (msg.sender != address(_coordinator())) revert NotCoordinator();
    }
    function _pull(address a, address from, uint256 amount) private {
        uint256 beforeFrom = PricingToken.balanceOf(a, from);
        PricingToken.pullExact(a, from, amount);
        uint256 afterFrom = PricingToken.balanceOf(a, from);
        if (afterFrom > beforeFrom || beforeFrom - afterFrom != amount) revert InexactMovement();
    }
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        address a = asset();
        uint256 beforeVault = PricingToken.balanceOf(a, address(this));
        PricingToken.sendExact(a, to, amount);
        uint256 afterVault = PricingToken.balanceOf(a, address(this));
        if (afterVault > beforeVault || beforeVault - afterVault != amount) revert InexactMovement();
    }
}
