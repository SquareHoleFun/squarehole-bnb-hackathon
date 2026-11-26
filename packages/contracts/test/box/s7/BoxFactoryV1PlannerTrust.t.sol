// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV1Planner} from "../../../src/box/BoxFactoryV1Planner.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxCloneArgs} from "../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxS7Base} from "./BoxS7Base.sol";

/// @notice TEST ONLY (review of the Misfits line, finding 1): a receiver implementation that is not the version's,
/// with a backdoor that takes the receiver's ETH claims. A clone of it answers every getter as box 0's receiver does.
contract S7EvilReceiver is BoxReceiver {
    constructor(IPoolManager pm_, address coordImpl, address ext) BoxReceiver(pm_, coordImpl, ext) {}

    function drain(address to) external {
        poolManager.transfer(to, 0, poolManager.balanceOf(address(this), 0));
    }
}

/// @notice TEST ONLY: the real planner's answers with one lie, chosen by `lie`: one implementation of the version
/// replaced by `impostor` (each clone then is a clone of other code with the real arguments, at the same CREATE
/// address), or one argument of a contract the factory cannot tell from its address. Such a planner is what a wrong
/// `planner_` constructor argument would give the factory (a deployment mistake or a supply-chain problem).
contract S7ImpostorPlanner {
    uint256 internal constant NONE = 0;
    uint256 internal constant HOOK = 1;
    uint256 internal constant LAUNCH_ROUTER = 2;
    uint256 internal constant RECEIVER = 3;
    uint256 internal constant COLLECTION = 4;
    uint256 internal constant VAULT = 5;
    uint256 internal constant TICKETS = 6;
    uint256 internal constant ROYALTY_ROUTER = 7;
    uint256 internal constant ITEM_STREAM = 8;
    /// The royalty router as a standard EIP-1167 clone of the version's own implementation (no receiving prefix).
    uint256 internal constant ROYALTY_STANDARD_RUNTIME = 9;
    /// The tickets' drand source: `impostor` instead of the version's pinned source (BC-101).
    uint256 internal constant TICKETS_SOURCE = 10;
    /// The tickets' openAt: a time an hour ahead instead of the spec's (F80).
    uint256 internal constant TICKETS_OPEN_AT = 11;
    /// FIT's executor's launch phase (whose `graduated()` it trusts): `impostor` instead of box 0's coordinator.
    uint256 internal constant EXECUTOR_LAUNCH_PHASE = 12;
    /// FIT's executor's receiver (REV-16's notes): `impostor` instead of box 0's receiver.
    uint256 internal constant EXECUTOR_RECEIVER = 13;
    /// FIT's executor's first sample at the curve's start P0 (the seed before the review) instead of P1.
    uint256 internal constant EXECUTOR_SEED_P0 = 14;
    /// The launch router's openAt: a time an hour ahead instead of the spec's (F80; review of sh-open-at, finding 1).
    uint256 internal constant ROUTER_OPEN_AT = 15;
    /// @dev The launch router's openAt in its clone arguments (BoxLaunchRouter `_A_OPEN_AT`, private there).
    uint256 internal constant R_OPEN_AT = 101;

    /// @dev Where a clone's arguments start in its init code: the 10-byte constructor, then the proxy.
    uint256 internal constant ARGS_IN_INIT = 10 + BoxClones.ARGS_OFFSET;
    uint256 internal constant ARGS_IN_RECEIVING_INIT = 10 + BoxClones.RECEIVING_ARGS_OFFSET;

    BoxFactoryV1Planner internal immutable _real = new BoxFactoryV1Planner();
    uint256 public lie;
    address public impostor;

    function set(uint256 lie_, address impostor_) external {
        (lie, impostor) = (lie_, impostor_);
    }

    function refusal(BoxSpecV1.BoxSpec memory s, address safe) external view returns (bytes memory) {
        return _real.refusal(s, safe);
    }

    function templateIdOf(BoxSpecV1.BoxSpec memory s, bytes32 v, bytes32 e) external view returns (bytes32) {
        return _real.templateIdOf(s, v, e);
    }

    function addresses(address c, bool r) external view returns (IBoxFactoryV1.Box0Addresses memory) {
        return _real.addresses(c, r);
    }

    function hookInitCode(BoxFactoryV1Planner.Version memory v, IBoxFactoryV1.Box0Addresses memory a, uint32 d)
        external
        view
        returns (bytes memory)
    {
        return _real.hookInitCode(_swapped(v), a, d);
    }

    function plan(BoxSpecV1.BoxSpec memory s, BoxFactoryV1Planner.Version memory v, address c, bytes32 salt, bytes32 h)
        external
        view
        returns (BoxFactoryV1Planner.Plan memory p)
    {
        p = _real.plan(s, _swapped(v), c, salt, h);
        uint256 l = lie;
        if (l == ROYALTY_STANDARD_RUNTIME) {
            bytes memory init = p.codes[_real.NONCE_ROYALTY() - 1];
            p.codes[_real.NONCE_ROYALTY() - 1] =
                BoxClones.initCode(v.royaltyRouterImpl, _slice(init, ARGS_IN_RECEIVING_INIT));
        } else if (l == TICKETS_SOURCE) {
            _writeAddress(p.codes[_real.NONCE_TICKETS() - 1], ARGS_IN_INIT + BoxCloneArgs.T_SOURCE, impostor);
        } else if (l == TICKETS_OPEN_AT) {
            bytes memory init = p.codes[_real.NONCE_TICKETS() - 1];
            uint256 at = ARGS_IN_INIT + BoxCloneArgs.T_OPEN_AT;
            // A time an hour ahead (any time at or before the creation would open in the next block like the hook's
            // Now, open-at-clock-time.md, so the lie must be a future time to differ).
            _writeBytes4(init, at, bytes4(uint32(block.timestamp + 1 hours)));
        } else if (l == ROUTER_OPEN_AT) {
            // The same lie for the launch router: it would tax buys on another clock than the hook's gate.
            _writeBytes4(
                p.codes[_real.NONCE_ROUTER() - 1], ARGS_IN_INIT + R_OPEN_AT, bytes4(uint32(block.timestamp + 1 hours))
            );
        } else if (l >= EXECUTOR_LAUNCH_PHASE) {
            uint256 i = _real.NONCE_EXECUTOR() - 1;
            (address pm, address t, address phase, address hook, address rcv, int24 seed) =
                abi.decode(p.codes[i], (address, address, address, address, address, int24));
            if (l == EXECUTOR_LAUNCH_PHASE) phase = impostor;
            if (l == EXECUTOR_RECEIVER) rcv = impostor;
            if (l == EXECUTOR_SEED_P0) seed = v.tickUpper;
            p.codes[i] = abi.encode(pm, t, phase, hook, rcv, seed);
        }
    }

    function _swapped(BoxFactoryV1Planner.Version memory v) internal view returns (BoxFactoryV1Planner.Version memory) {
        uint256 l = lie;
        address x = impostor;
        if (l == HOOK) v.hookImpl = x;
        else if (l == LAUNCH_ROUTER) v.launchRouterImpl = x;
        else if (l == RECEIVER) v.receiverImpl = x;
        else if (l == COLLECTION) v.collectionImpl = x;
        else if (l == VAULT) v.vaultImpl = x;
        else if (l == TICKETS) v.ticketsImpl = x;
        else if (l == ROYALTY_ROUTER) v.royaltyRouterImpl = x;
        else if (l == ITEM_STREAM) v.itemStreamImpl = x;
        return v;
    }

    function _slice(bytes memory b, uint256 from) internal pure returns (bytes memory out) {
        out = new bytes(b.length - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }

    function _writeAddress(bytes memory b, uint256 at, address a) internal pure {
        bytes20 x = bytes20(a);
        for (uint256 i; i < 20; ++i) {
            b[at + i] = x[i];
        }
    }

    function _writeBytes4(bytes memory b, uint256 at, bytes4 x) internal pure {
        for (uint256 i; i < 4; ++i) {
            b[at + i] = x[i];
        }
    }
}

/// @notice Review of the Misfits line, finding 1: the factory checks what it creates, not what its planner says. For
/// every contract the coordinator creates from the planner's codes, a planner that plans a clone of other code (here a
/// copy of the version's own implementation at another address, or a subclass with a backdoor) at the same CREATE
/// address, or that changes an argument a getter can read but the address cannot tell, is refused with the re-read's
/// id and nothing is created: the hook, launch router, receiver, collection, vault, tickets, royalty router and
/// per-item stream are each a clone of the version's implementation (the royalty router the receiving variant,
/// BC-114); the tickets read the pinned drand source (BC-101) and open with the hook; FIT's executor (its creation code
/// checked by hash) reads box 0's coordinator, hook and receiver and starts its average at P1. The coordinator's case is
/// `BoxFactoryV1LyingPlannerTest`. The planner here answers exactly as the real one when it tells no lie.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1PlannerTrustTest is BoxS7Base {
    uint256 internal constant NONE = 0;
    uint256 internal constant HOOK = 1;
    uint256 internal constant LAUNCH_ROUTER = 2;
    uint256 internal constant RECEIVER = 3;
    uint256 internal constant COLLECTION = 4;
    uint256 internal constant VAULT = 5;
    uint256 internal constant TICKETS = 6;
    uint256 internal constant ROYALTY_ROUTER = 7;
    uint256 internal constant ITEM_STREAM = 8;
    uint256 internal constant ROYALTY_STANDARD_RUNTIME = 9;
    uint256 internal constant TICKETS_SOURCE = 10;
    uint256 internal constant TICKETS_OPEN_AT = 11;
    uint256 internal constant EXECUTOR_LAUNCH_PHASE = 12;
    uint256 internal constant EXECUTOR_RECEIVER = 13;
    uint256 internal constant EXECUTOR_SEED_P0 = 14;
    uint256 internal constant ROUTER_OPEN_AT = 15;

    function _plannerCreationCode() internal pure override returns (bytes memory) {
        return type(S7ImpostorPlanner).creationCode;
    }

    /// @dev The version's implementation's runtime (immutables included) at a fresh address: the same code, another
    /// implementation.
    function _copyOf(address impl, string memory label) internal returns (address copy) {
        copy = makeAddr(string.concat("s7.impostor.", label));
        vm.etch(copy, impl.code);
    }

    function _refused(uint256 lie, address impostor, uint256 check) internal {
        S7ImpostorPlanner(address(planner)).set(lie, impostor);
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, check));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        _assertNothingCreated();
    }

    /// The stand-in planner is faithful: telling no lie, it creates box 0 as the real planner does.
    function test_BC063_theImpostorPlannerWithoutALieCreatesBox0() public {
        S7ImpostorPlanner(address(planner)).set(NONE, address(0));
        (uint256 boxId,,) = _create(_box0Spec());
        assertEq(boxId, 0);
        assertEq(registry.boxCount(), 1);
    }

    /// Each clone the coordinator creates from the planner's codes must be a clone of the version's implementation.
    function test_BC063_theFactoryRefusesAnyCloneOfAnotherImplementation() public {
        IBoxFactoryV1.Implementations memory i = factory.implementations();
        _refused(HOOK, _copyOf(i.hook, "hook"), factory.MW_HOOK());
        _refused(LAUNCH_ROUTER, _copyOf(i.launchRouter, "router"), factory.MW_ROUTER());
        _refused(RECEIVER, _copyOf(i.receiver, "receiver"), factory.MW_RECEIVER());
        _refused(COLLECTION, _copyOf(i.collection, "collection"), factory.MW_COLLECTION());
        _refused(VAULT, _copyOf(i.vault, "vault"), factory.MW_VAULT());
        _refused(TICKETS, _copyOf(i.tickets, "tickets"), factory.MW_TICKETS());
        _refused(ROYALTY_ROUTER, _copyOf(i.royaltyRouter, "royalty"), factory.MW_ROYALTY());
        _refused(ITEM_STREAM, _copyOf(i.itemStream, "stream"), factory.MW_STREAM());
    }

    /// The royalty router must be the receiving variant (BC-114: a plain clone fails a marketplace's 2,300-gas send).
    function test_BC063_theFactoryRefusesAStandardCloneAsTheRoyaltyRouter() public {
        _refused(ROYALTY_STANDARD_RUNTIME, address(0), factory.MW_ROYALTY());
    }

    /// The reviewer's PoC: a planner that swaps box 0's receiver (nonce 5) for a clone of a subclass with a `drain()`.
    /// Every getter answers as box 0's receiver; the factory refuses it, so no fee can ever reach the backdoor.
    function test_BC063_aReceiverWithABackdoorIsRefused() public {
        S7EvilReceiver evil = new S7EvilReceiver(pm, version.impls.coordinator, version.receiverExtension);
        _refused(RECEIVER, address(evil), factory.MW_RECEIVER());
        // Nothing exists at the receiver's address, so `fundFees` (the royalty router's ETH intake) reaches nothing.
        assertEq(factory.box0Addresses().receiver.code.length, 0);
    }

    /// FIT's executor's creation code is checked by hash; its arguments are re-read: box 0's coordinator as the phase
    /// it trusts, box 0's receiver, and its first sample at P1 (review finding 4: the walk from P0).
    function test_BC063_theFactoryRefusesAnExecutorWiredOtherwise() public {
        address stranger = makeAddr("s7.stranger");
        _refused(EXECUTOR_LAUNCH_PHASE, stranger, factory.MW_EXECUTOR());
        _refused(EXECUTOR_RECEIVER, stranger, factory.MW_EXECUTOR());
        _refused(EXECUTOR_SEED_P0, address(0), factory.MW_EXECUTOR());
    }

    /// BC-101 where the source is used: the tickets add-on, which requests and reads the words, must read the pinned
    /// source the factory and coordinator name, and open with the hook.
    function test_BC101_theTicketsMustReadThePinnedSource() public {
        address twin = makeAddr("s7.twinSource");
        vm.etch(twin, version.randomness.code);
        _refused(TICKETS_SOURCE, twin, factory.MW_TICKETS());
        _refused(TICKETS_OPEN_AT, address(0), factory.MW_TICKETS());
    }

    /// BC-023 (F80): the launch router taxes the window the hook gates, so it must hold the hook's open. A planner that
    /// gives the router another time (here an hour ahead of the spec's Now) is refused by the router's re-read (review
    /// of sh-open-at, finding 1: that re-read was the only in-transaction check, and no test failed without it).
    function test_BC023_theLaunchRouterMustOpenWithTheHook() public {
        _refused(ROUTER_OPEN_AT, address(0), factory.MW_ROUTER());
    }
}
