// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpec, BoxType, AddOn, Listing} from "../interfaces/SpecTypes.sol";
import {IBoxRegistryV2} from "../interfaces/IBoxRegistryV2.sol";
import {IListingRegistry, ListingRecord, QParameters} from "../interfaces/IListingRegistry.sol";
import {ListingRaises} from "../ListingRegistry.sol";
import {BoxFactoryV2Parts} from "../BoxFactoryV2Parts.sol";
import {BoxCoordinatorV2Args, CoordinatorV2Config} from "../libraries/BoxCoordinatorV2Args.sol";
import {BoxClones} from "../../box/libraries/BoxClones.sol";
import {SetSpecV2, SetValidationContext, SetRefused} from "./SetTypesV2.sol";
import {SetConstantsV2 as C} from "./SetConstantsV2.sol";
import {SetReleaseV2} from "./SetReleaseV2.sol";
import {SetSpecV2Validator} from "./SetSpecV2Validator.sol";
import {SetAdmissionV2} from "./SetAdmissionV2.sol";
import {SetVaultV2Args, SetVaultV2Config} from "./SetVaultV2Args.sol";

/// @notice Stateless planner for one fixed picks/returns template. No old-spec admission, payouts or SHOP tail.
contract SetFactoryV2Planner {
    struct Plan {
        bytes32 specHash;
        bytes32 salt;
        bytes coordinatorInit;
        bytes hookInit;
        bytes[] codes;
        address[24] roles;
        QParameters q;
        uint256 payment;
        uint256 boxId;
    }

    error WrongPlannerCode();
    error ValidationUnavailable();
    SetSpecV2Validator public immutable validator;
    BoxFactoryV2Parts public immutable parts;

    /// @notice Pin the exact stateless encoder and validator runtimes, including linked library addresses.
    constructor(address validator_, address parts_) {
        if (
            validator_.codehash != keccak256(type(SetSpecV2Validator).runtimeCode)
                || parts_.codehash != keccak256(type(BoxFactoryV2Parts).runtimeCode)
        ) revert WrongPlannerCode();
        validator = SetSpecV2Validator(validator_);
        parts = BoxFactoryV2Parts(parts_);
    }

    /// @notice Current pricing snapshot and code-only collection admission. No creator-supplied listing context.
    function validate(SetReleaseV2 calldata r, SetSpecV2 calldata s) public view {
        SetValidationContext memory ctx;
        ctx.timestamp = block.timestamp;
        IListingRegistry lr = IListingRegistry(r.listingRegistry);
        if (s.pricing.listingId < lr.listingCount()) {
            ListingRecord memory l = lr.listing(s.pricing.listingId);
            ctx.listing = Listing(l.id, l.token, l.decimals, uint8(l.class), uint8(l.kind), l.raise);
        }
        (uint16 reason, uint16 field) = validator.validate(s, ctx);
        if (reason != 0) revert SetRefused(reason, field);
        SetAdmissionV2.requireCollection(s.collection);
    }

    /// @notice Empty means admitted now; any structural or live collection refusal is returned unchanged.
    /// A failed check with empty revert data is never reported as successful admission.
    function refusal(SetReleaseV2 calldata r, address, SetSpecV2 calldata s) external view returns (bytes memory) {
        try this.validate(r, s) {
            return "";
        } catch (bytes memory reason) {
            return reason.length == 0 ? abi.encodeWithSelector(ValidationUnavailable.selector) : reason;
        }
    }

    /// @notice Encoding projection only, never a spec accepted by the old validator/factory.
    function project(SetSpecV2 calldata s) public pure returns (BoxSpec memory b) {
        b.format = 2;
        b.version = 2;
        b.boxType = uint8(BoxType.EXISTING);
        b.tokenName = s.tokenName;
        b.tokenSymbol = s.tokenSymbol;
        b.description = s.description;
        b.coverSha256 = s.logoSha256;
        b.n = s.count;
        b.pricing = s.pricing;
        b.raise = s.raise;
        b.openAt = s.openAt;
        b.deadlineDays = s.deadlineDays;
        b.creatorBuy = s.creatorBuy;
        b.pickFeeBps = s.pickFeeBps;
        b.layout = 1;
        b.gradLayout = 3;
        b.launchFormat = 1;
        b.buyers.split = 1;
        b.buyers.a.leg = 1;
        b.buyers.a.dest = 4;
        b.sellers = b.buyers;
        b.addOns = new AddOn[](1);
        b.addOns[0] = AddOn(8, abi.encode(s.setHash, s.count));
    }

    /// @notice CREATE nonce order, distinct from the role-indexed table in coordinator arguments.
    function nonces() public pure returns (bytes memory) {
        return hex"0105060313";
    }

    /// @notice Predict with the same validation and identity domain used for creation; no funds move.
    function predictBox(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, bytes32 cs)
        external
        view
        returns (address coordinator, address token, bytes32 hookInitCodeHash)
    {
        (Plan memory p,) = _addresses(r, creator, s, cs);
        return (p.roles[0], p.roles[1], keccak256(p.hookInit));
    }

    /// @notice Predict the final hook after choosing the coordinator salt; no state changes.
    function predictHook(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, bytes32 cs, bytes32 hs)
        external
        view
        returns (address)
    {
        (Plan memory p,) = _addresses(r, creator, s, cs);
        return BoxClones.predict(p.roles[0], hs, keccak256(p.hookInit));
    }

    /// @notice Assemble five CREATEs, inserting the separately encoded vault at nonce 4.
    function plan(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, bytes32 cs, bytes32 hs)
        external
        view
        returns (Plan memory p)
    {
        BoxFactoryV2Parts.Box memory b;
        (p, b.sqrtP1) = _addresses(r, creator, s, cs);
        p.roles[2] = BoxClones.predict(p.roles[0], hs, keccak256(p.hookInit));
        p.boxId = IBoxRegistryV2(r.registry).boxCount();
        p.payment = p.q.bootstrapQ + s.creatorBuy;
        b.roles = p.roles;
        b.q = p.q;
        b.boxId = p.boxId;
        b.registry = r.registry;
        b.listingRegistry = r.listingRegistry;
        b.weth = r.weth;
        b.creator = creator;
        b.receiverImplementation = r.implementations[5];
        b.nonces = hex"01050613"; // NEVER request role 3 from the old encoder.
        (bytes[] memory args,) = parts.partArgs(b, project(s));
        p.codes = new bytes[](5);
        p.codes[0] = BoxClones.initCode(r.implementations[1], args[0]);
        p.codes[1] = BoxClones.initCode(r.implementations[5], args[1]);
        p.codes[2] = BoxClones.initCode(r.implementations[6], args[2]);
        p.codes[3] = BoxClones.initCode(
            r.implementations[3],
            SetVaultV2Args.encode(
                SetVaultV2Config(
                    p.roles[0], p.roles[1], p.roles[19], creator, s.collection, s.count, s.setHash, s.pickFeeBps
                )
            )
        );
        p.codes[4] = BoxClones.initCode(r.implementations[19], args[3]);
    }

    function _addresses(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, bytes32 cs)
        private
        view
        returns (Plan memory p, uint160 sqrtP1)
    {
        validate(r, s);
        p.specHash = keccak256(abi.encode(s));
        p.q = ListingRaises.parameters(s.raise);
        CoordinatorV2Config memory c;
        c.p = s.pricing.token;
        c.raise = s.raise;
        c.creatorBuy = s.creatorBuy;
        c.bootstrapQ = p.q.bootstrapQ;
        c.creator = creator;
        c.specHash = p.specHash;
        c.registry = r.registry;
        c.listingRegistry = r.listingRegistry;
        c.pricingListingId = s.pricing.listingId;
        c.openAt = s.openAt;
        c.deadlineDays = s.deadlineDays;
        bytes memory byRole = new bytes(24);
        bytes memory order = nonces();
        for (uint256 k; k < order.length; ++k) {
            // Five CREATEs, so the nonce fits one byte.
            // forge-lint: disable-next-line(unsafe-typecast)
            byRole[uint8(order[k])] = bytes1(uint8(k + 1));
        }
        c.nonces = bytes24(byRole);
        p.coordinatorInit = BoxClones.initCode(r.implementations[0], BoxCoordinatorV2Args.encode(c));
        p.salt = keccak256(abi.encode(C.RELEASE, C.TEMPLATE, block.chainid, r.factory, creator, p.specHash, cs));
        p.roles[0] = BoxClones.predict(r.factory, p.salt, keccak256(p.coordinatorInit));
        for (uint256 k; k < order.length; ++k) {
            p.roles[uint8(order[k])] = createAddress(p.roles[0], uint8(k + 1));
        }
        bytes memory hookArgs;
        (hookArgs, sqrtP1) = parts.hookArgs(p.roles, p.q, project(s));
        p.hookInit = BoxClones.initCode(r.implementations[2], hookArgs);
    }

    /// @notice RLP CREATE address for the release's bounded nonces (1..5).
    function createAddress(address deployer, uint8 nonce) public pure returns (address) {
        require(nonce > 0 && nonce <= 5, "SetNonce");
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", deployer, nonce)))));
    }
}
