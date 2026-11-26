// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetSpecV2, SetRefused} from "./SetTypesV2.sol";
import {SetConstantsV2 as C, SetReason as R} from "./SetConstantsV2.sol";
import {SetReleaseV2} from "./SetReleaseV2.sol";
import {SetFactoryV2Planner} from "./SetFactoryV2Planner.sol";
import {SetFactoryV2Checks} from "./SetFactoryV2Checks.sol";
import {BoxCoordinatorV2} from "../BoxCoordinatorV2.sol";
import {IBoxFactoryV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {IBoxRegistryV2} from "../interfaces/IBoxRegistryV2.sol";
import {IListingRegistry, QParameters} from "../interfaces/IListingRegistry.sol";
import {ListingRaises} from "../ListingRegistry.sol";
import {ReleaseConstantsV2 as RC} from "../interfaces/ReleaseConstantsV2.sol";
import {PricingToken} from "../libraries/PricingToken.sol";
import {BoxClones} from "../../box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../../libraries/TransientReentrancyGuard.sol";

/// @notice Separate picks/returns release: no old create selector, administrator, setters or rescue.
/// The creator is the caller. Bootstrap plus optional creator buy is the entire payment; no NFT purchase occurs.
contract SetFactoryV2 is TransientReentrancyGuard {
    error WrongRelease();
    uint16 public constant VERSION = 2;
    bytes32 public constant RELEASE = C.RELEASE;
    bytes32 public constant TEMPLATE = C.TEMPLATE;
    SetFactoryV2Planner public immutable planner;
    SetFactoryV2Checks public immutable checks;
    bytes32 public immutable versionCodeHash;
    bytes32 private immutable _checksHash;
    bytes32 private immutable _partsHash;
    bytes32 private immutable _validatorHash;
    SetReleaseV2 private _release;

    /// @notice Fix the reviewed runtime manifest, fresh registries, factory identity and redeployed implementation graph.
    /// Safe custody and build-to-manifest attestation remain deployment review responsibilities.
    constructor(SetReleaseV2 memory r, address planner_, address checks_) {
        if (r.factory != address(this) || checks_.codehash != keccak256(type(SetFactoryV2Checks).runtimeCode)) {
            revert WrongRelease();
        }
        planner = SetFactoryV2Planner(planner_);
        checks = SetFactoryV2Checks(checks_);
        checks.verifyRelease(r, planner_);
        _checksHash = checks_.codehash;
        _partsHash = address(planner.parts()).codehash;
        _validatorHash = address(planner.validator()).codehash;
        versionCodeHash =
            keccak256(abi.encode(C.RELEASE, C.TEMPLATE, r, planner_, checks_, _checksHash, _partsHash, _validatorHash));
        _release = r;
    }

    /// @notice Atomically create, launch, verify and register one canonical set. Whole calldata must be canonical.
    function createBox(SetSpecV2 calldata s, bytes32 coordinatorSalt, bytes32 hookSalt)
        external
        payable
        nonReentrant
        returns (uint256 boxId, address coordinator, address hook)
    {
        if (
            keccak256(msg.data)
                != keccak256(abi.encodeWithSelector(this.createBox.selector, s, coordinatorSalt, hookSalt))
        ) {
            revert SetRefused(R.NONCANONICAL_ABI, R.GLOBAL);
        }
        SetReleaseV2 memory r = _release;
        _authenticate(r);
        SetFactoryV2Planner.Plan memory p = planner.plan(r, msg.sender, s, coordinatorSalt, hookSalt);
        _checkPlace(p.roles[1], s.pricing.token, p.roles[2]);
        // Exclude unsolicited balances, but require the caller's exact debit and all factory balances to reconcile.
        uint256 ethBefore = address(this).balance - msg.value;
        uint256 pBefore;
        uint256 creatorBefore;
        if (s.pricing.token == address(0)) {
            if (msg.value != p.payment) revert IBoxFactoryV2.WrongValue(msg.value, p.payment);
        } else {
            if (msg.value != 0) revert IBoxFactoryV2.WrongValue(msg.value, 0);
            pBefore = PricingToken.balanceOf(s.pricing.token, address(this));
            creatorBefore = PricingToken.balanceOf(s.pricing.token, msg.sender);
            PricingToken.pullExact(s.pricing.token, msg.sender, p.payment);
        }
        coordinator = BoxClones.create2(p.coordinatorInit, p.salt);
        if (coordinator != p.roles[0]) revert IBoxFactoryV2.Miswired(0);
        hook = BoxCoordinatorV2(coordinator)
            .deploy(p.codes, p.hookInit, hookSalt, p.boxId, [bytes32(0), bytes32(0)], [uint256(0), uint256(0)]);
        if (hook != p.roles[2]) revert IBoxFactoryV2.Miswired(2);
        _launch(coordinator, s.pricing.token, p.payment);
        _authenticate(r);
        checks.verify(r, msg.sender, s, p);
        if (address(this).balance != ethBefore) revert IBoxFactoryV2.Miswired(4);
        if (s.pricing.token != address(0)) {
            if (
                PricingToken.balanceOf(s.pricing.token, address(this)) != pBefore || creatorBefore < p.payment
                    || PricingToken.balanceOf(s.pricing.token, msg.sender) != creatorBefore - p.payment
            ) {
                revert IBoxFactoryV2.Miswired(5);
            }
        }
        boxId = IBoxRegistryV2(r.registry).record(coordinator, C.TEMPLATE, abi.encode(s));
        if (boxId != p.boxId) revert IBoxFactoryV2.Miswired(6);
    }

    /// @notice Predict coordinator/T/hook init hash under current pricing and collection admission.
    function predictBox(address creator, SetSpecV2 calldata s, bytes32 cs)
        external
        view
        returns (address coordinator, address token, bytes32 hookInitCodeHash)
    {
        return planner.predictBox(_release, creator, s, cs);
    }

    /// @notice Mine the hook only after mining the coordinator salt and token placement.
    function predictHook(address creator, SetSpecV2 calldata s, bytes32 cs, bytes32 hs)
        external
        view
        returns (address)
    {
        return planner.predictHook(_release, creator, s, cs, hs);
    }

    /// @notice Report the encoded refusal against this release's pricing snapshot and current NFT code.
    function refusal(SetSpecV2 calldata s, address creator) external view returns (bytes memory) {
        return planner.refusal(_release, creator, s);
    }

    /// @notice Fixed midpoint placement from the existing release; no alternate pool order.
    function tokenAddressLimit(address p) public pure returns (address) {
        return address(uint160(uint256(uint160(p)) + ((uint256(1) << 160) - uint160(p)) / 2));
    }

    /// @notice Existing creation-raise arithmetic; later listing edits cannot change a stored box's thresholds.
    function boxQParameters(uint32 id, uint256 raise) external view returns (QParameters memory q) {
        if (id < IListingRegistry(_release.listingRegistry).listingCount()) return ListingRaises.parameters(raise);
    }

    /// @notice Complete fixed manifest; code hashes include constructor immutables and link addresses.
    function release() external view returns (SetReleaseV2 memory) {
        return _release;
    }

    function registry() external view returns (address) {
        return _release.registry;
    }

    function listingRegistry() external view returns (address) {
        return _release.listingRegistry;
    }

    function poolManager() external view returns (address) {
        return _release.poolManager;
    }

    function weth() external view returns (address) {
        return _release.weth;
    }

    function randomness() external pure returns (address) {
        return address(0);
    }

    function implementation(uint256 role) external view returns (address) {
        return role < 24 ? _release.implementations[role] : address(0);
    }

    /// @notice This release has only ordinary share vaults. Role 19 is always a distinct loader.
    function isPileVault(address) external pure returns (bool) {
        return false;
    }

    function _authenticate(SetReleaseV2 memory r) private view {
        if (
            address(checks).codehash != _checksHash || address(planner.parts()).codehash != _partsHash
                || address(planner.validator()).codehash != _validatorHash
        ) revert WrongRelease();
        checks.verifyCode(r, address(planner));
    }

    function _launch(address coordinator, address p, uint256 amount) private {
        if (p == address(0)) {
            BoxCoordinatorV2(coordinator).launch{value: amount}();
        } else {
            PricingToken.approveExact(p, coordinator, amount);
            _allowance(p, coordinator, amount);
            BoxCoordinatorV2(coordinator).launch();
            _allowance(p, coordinator, 0);
        }
    }

    function _allowance(address p, address spender, uint256 expected) private view {
        (bool ok, bytes memory ret) =
            p.staticcall(abi.encodeWithSignature("allowance(address,address)", address(this), spender));
        if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) != expected) revert IBoxFactoryV2.Miswired(5);
    }

    function _checkPlace(address t, address p, address hook) private pure {
        if (t <= p) revert IBoxFactoryV2.TokenNotAboveQ(t, p);
        address limit = tokenAddressLimit(p);
        if (t >= limit) revert IBoxFactoryV2.T_TOO_HIGH(t, limit);
        if (uint160(hook) & 0x3fff != RC.V2_HOOK_FLAGS || uint160(hook) >> 152 == 0x91) {
            revert IBoxFactoryV2.HookSaltNotMined(hook);
        }
    }
}
