// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1, IFitExecutorWiring} from "../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../src/box/interfaces/IBoxVault.sol";
import {IBoxRegistry} from "../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxRoyaltyRouter} from "../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxS7Base} from "./BoxS7Base.sol";

/// @notice TEST ONLY: factory v1 with its re-reads callable on their own.
contract BoxFactoryV1Exposed is BoxFactoryV1 {
    constructor(
        IPoolManager poolManager_,
        Implementations memory impls,
        BoxFactoryV1Planner planner_,
        address randomness_,
        address weth_,
        address platformSafe_,
        address box0Creator_,
        bytes32 executorInitCodeHash_
    )
        BoxFactoryV1(
            poolManager_, impls, planner_, randomness_, weth_, platformSafe_, box0Creator_, executorInitCodeHash_
        )
    {}

    function exposedVerify(BoxSpecV1.BoxSpec memory s, BoxFactoryV1Planner.Plan memory p) external view {
        _verify(s, p);
    }
}

/// @notice BC-063's on-chain half: createBox's re-reads after the launch (MisfitsGenesis's `_verifyNftSide` and
/// FitPoolGenesis.verify adapted). Box 0 is created through a factory whose re-reads can be called alone; each re-read
/// passes on the box as created, and each refuses with its id when one of the box's contracts answers otherwise (a
/// mocked answer stands in for a broken implementation). In createBox the same revert undoes the whole creation.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1RereadsTest is BoxS7Base {
    BoxSpecV1.BoxSpec internal _s;
    bytes internal _planEncoded;

    function _factoryCreationCode() internal pure override returns (bytes memory) {
        return type(BoxFactoryV1Exposed).creationCode;
    }

    function setUp() public override {
        super.setUp();
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        _create(s);
        BoxFactoryV1Planner.Plan memory p =
            planner.plan(s, factory.version(), address(this), salt, keccak256(abi.encode(s)));
        _planEncoded = abi.encode(p);
    }

    function _plan() internal view returns (BoxFactoryV1Planner.Plan memory) {
        return abi.decode(_planEncoded, (BoxFactoryV1Planner.Plan));
    }

    function _verify() internal view {
        BoxFactoryV1Exposed(address(factory)).exposedVerify(_box0Spec(), _plan());
    }

    function _expectMiswired(address target, bytes memory call_, bytes memory ret, uint256 check) internal {
        vm.mockCall(target, call_, ret);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, check));
        this.verifyExternally();
        vm.clearMockedCalls();
    }

    function verifyExternally() external view {
        _verify();
    }

    function test_BC063_theRereadsPassOnTheBoxAsCreated() public view {
        _verify();
    }

    function test_BC063_eachRereadRefusesAMiswiredBox() public {
        BoxFactoryV1Planner.Plan memory p = _plan();
        IBoxFactoryV1.Box0Addresses memory a = p.a;
        _expectMiswired(a.coordinator, abi.encodeCall(IBoxCoordinator.randomness, ()), abi.encode(address(1)), 1);
        _expectMiswired(a.coordinator, abi.encodeCall(IBoxCoordinator.token, ()), abi.encode(address(1)), 1);
        _expectMiswired(p.hook, abi.encodeCall(IBoxHook.openAt, ()), abi.encode(uint256(1)), 2);
        _expectMiswired(p.hook, abi.encodeCall(IBoxHook.receiver, ()), abi.encode(address(1)), 2);
        _expectMiswired(a.coordinator, abi.encodeCall(IBoxCoordinator.executor, ()), abi.encode(address(1)), 3);
        // The pool's state word (StateLibrary: keccak256(poolId, 6)) read as empty: no fee, no price.
        PoolId id = IBoxHook(p.hook).poolId();
        bytes32 slot = keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6))));
        _expectMiswired(address(pm), abi.encodeWithSignature("extsload(bytes32)", slot), abi.encode(bytes32(0)), 4);
        _expectMiswired(a.token, abi.encodeCall(IBoxToken.totalBurned, ()), abi.encode(uint256(0)), 5);
        _expectMiswired(a.token, abi.encodeCall(IBoxToken.balanceOf, (a.coordinator)), abi.encode(uint256(1)), 5);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.hiddenCount, ()), abi.encode(uint256(1)), 6);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.gateOpen, ()), abi.encode(true), 6);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.owner, ()), abi.encode(address(1)), 7);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.revealRoot, ()), abi.encode(bytes32(0)), 7);
        _expectMiswired(a.launchRouter, abi.encodeCall(IBoxLaunchRouter.bootstrapped, ()), abi.encode(false), 8);
        _expectMiswired(
            a.launchRouter, abi.encodeCall(IBoxLaunchRouter.totalTaxCollected, ()), abi.encode(uint256(1)), 8
        );
        // The router's open must be the hook's (review of sh-open-at, finding 1: the only in-transaction check that the
        // window the router taxes is the one the hook gates).
        _expectMiswired(a.launchRouter, abi.encodeCall(IBoxLaunchRouter.openAt, ()), abi.encode(uint256(1)), 8);
        _expectMiswired(a.receiver, abi.encodeCall(IBoxReceiver.swapModule, ()), abi.encode(address(1)), 9);
        _expectMiswired(a.receiver, abi.encodeCall(IBoxReceiver.platformSafe, ()), abi.encode(address(1)), 9);
        // S7 × S8: the per-item stream on its hook points, and the stream naming box 0 (MW_STREAM 11).
        _expectMiswired(a.coordinator, abi.encodeCall(IBoxCoordinator.itemStream, ()), abi.encode(address(1)), 1);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.observer, ()), abi.encode(address(0)), 6);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.transferObserver, ()), abi.encode(address(0)), 7);
        _expectMiswired(a.receiver, abi.encodeCall(IBoxReceiver.itemStream, ()), abi.encode(address(0)), 9);
        _expectMiswired(a.itemStream, abi.encodeCall(IBoxItemStream.vault, ()), abi.encode(address(1)), 11);
        _expectMiswired(a.itemStream, abi.encodeCall(IBoxItemStream.hook, ()), abi.encode(address(1)), 11);
        _expectMiswired(a.itemStream, abi.encodeCall(IBoxItemStream.receiver, ()), abi.encode(address(1)), 11);
        _expectMiswired(a.itemStream, abi.encodeCall(IBoxItemStream.coordinator, ()), abi.encode(address(1)), 11);
        _expectMiswired(a.itemStream, abi.encodeCall(IBoxItemStream.started, ()), abi.encode(true), 11);
        _verify();
    }

    /// Review of the Misfits line, finding 1: the re-reads added beside the code checks (BoxFactoryV1PlannerTrust) each
    /// refuse a box whose contract answers otherwise: the coordinator's raise and creator, the hook's T, FIT's
    /// executor's wiring and first sample, T's name and symbol, the vault's T, collection and fee rates, the
    /// collection's reveal rule, royalty router, vault, T and receiver, the router's and the receiver's T, the tickets'
    /// source, open time, vault, collection, T, N and first id (MW_TICKETS 12), the royalty router's coordinator,
    /// receiver and WETH (MW_ROYALTY 13). A getter that reverts or answers a short word is refused the same way.
    function test_BC063_eachAddedRereadRefusesAMiswiredBox() public {
        BoxFactoryV1Planner.Plan memory p = _plan();
        IBoxFactoryV1.Box0Addresses memory a = p.a;
        bytes memory one = abi.encode(address(1));
        _expectMiswired(a.coordinator, abi.encodeCall(IBoxCoordinator.raise, ()), abi.encode(uint256(1)), 1);
        _expectMiswired(a.coordinator, abi.encodeCall(IBoxCoordinator.creator, ()), one, 1);
        _expectMiswired(p.hook, abi.encodeCall(IBoxHook.token, ()), one, 2);
        address x = a.executor;
        _expectMiswired(x, abi.encodeCall(IFitExecutorWiring.poolManager, ()), one, 3);
        _expectMiswired(x, abi.encodeCall(IFitExecutorWiring.token, ()), one, 3);
        _expectMiswired(x, abi.encodeCall(IFitExecutorWiring.launchPhase, ()), one, 3);
        _expectMiswired(x, abi.encodeCall(IFitExecutorWiring.hooks, ()), one, 3);
        _expectMiswired(x, abi.encodeCall(IFitExecutorWiring.receiver, ()), one, 3);
        _expectMiswired(x, abi.encodeCall(IFitExecutorWiring.latestSampleTick, ()), abi.encode(int24(204_060)), 3);
        _expectMiswired(a.token, abi.encodeCall(IBoxToken.name, ()), abi.encode("Other"), 5);
        _expectMiswired(a.token, abi.encodeCall(IBoxToken.symbol, ()), abi.encode("OTHER"), 5);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.token, ()), one, 6);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.collection, ()), one, 6);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.drawFeeBps, ()), abi.encode(uint256(10_000)), 6);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.pickFeeBps, ()), abi.encode(uint256(0)), 6);
        _expectMiswired(a.vault, abi.encodeCall(IBoxVault.returnFeeBps, ()), abi.encode(uint256(0)), 6);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.revealUnlocker, ()), one, 7);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.revealTriggers, ()), abi.encode(uint8(3)), 7);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.royaltyRouter, ()), one, 7);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.vault, ()), one, 7);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.token, ()), one, 7);
        _expectMiswired(a.collection, abi.encodeCall(IBoxCollection.receiver, ()), one, 7);
        _expectMiswired(a.launchRouter, abi.encodeCall(IBoxLaunchRouter.token, ()), one, 8);
        _expectMiswired(a.receiver, abi.encodeCall(IBoxReceiver.token, ()), one, 9);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.source, ()), one, 12);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.openAt, ()), abi.encode(uint256(1)), 12);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.vault, ()), one, 12);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.collection, ()), one, 12);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.token, ()), one, 12);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.collectionSize, ()), abi.encode(uint256(1)), 12);
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.firstId, ()), abi.encode(uint256(7)), 12);
        assertTrue(a.royaltyRouter != address(0), "the fixture carries the royalties add-on");
        _expectMiswired(a.royaltyRouter, abi.encodeCall(IBoxRoyaltyRouter.coordinator, ()), one, 13);
        _expectMiswired(a.royaltyRouter, abi.encodeCall(IBoxRoyaltyRouter.receiver, ()), one, 13);
        _expectMiswired(a.royaltyRouter, abi.encodeCall(IBoxRoyaltyRouter.weth, ()), one, 13);
        // A getter that reverts, or answers less than a word, reads as a refusal (never as a match).
        vm.mockCallRevert(a.tickets, abi.encodeCall(IBoxTickets.source, ()), "");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, 12));
        this.verifyExternally();
        vm.clearMockedCalls();
        _expectMiswired(a.tickets, abi.encodeCall(IBoxTickets.source, ()), hex"00", 12);
        _verify();
    }
}

/// @notice TEST ONLY: the real planner's answers, except that the coordinator it plans is a clone of another
/// implementation (the hook's), with the same arguments: a planner that lies about the one contract whose address
/// cannot tell (a CREATE address does not depend on the code).
contract LyingPlanner {
    BoxFactoryV1Planner internal immutable _real = new BoxFactoryV1Planner();
    address public impostorImplementation;

    function setImpostor(address impl) external {
        impostorImplementation = impl;
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
        return _real.hookInitCode(v, a, d);
    }

    function plan(BoxSpecV1.BoxSpec memory s, BoxFactoryV1Planner.Version memory v, address c, bytes32 salt, bytes32 h)
        external
        view
        returns (BoxFactoryV1Planner.Plan memory p)
    {
        p = _real.plan(s, v, c, salt, h);
        bytes memory args = new bytes(154);
        bytes memory init = p.coordinatorInit;
        for (uint256 i; i < 154; ++i) {
            args[i] = init[10 + 45 + i];
        }
        p.coordinatorInit = BoxClones.initCode(impostorImplementation, args);
    }
}

/// @notice The factory enforces what its planner computes: a planner whose coordinator is a clone of another
/// implementation (at the same CREATE address) is refused, `Miswired(MW_COORDINATOR)`, with nothing created.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1LyingPlannerTest is BoxS7Base {
    function _plannerCreationCode() internal pure override returns (bytes memory) {
        return type(LyingPlanner).creationCode;
    }

    function test_BC063_theFactoryRefusesACoordinatorOfAnotherImplementation() public {
        LyingPlanner(address(planner)).setImpostor(version.impls.hook);
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, factory.MW_COORDINATOR()));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        _assertNothingCreated();
        assertEq(registry.boxCount(), 0);
        IBoxRegistry r = IBoxRegistry(version.registry);
        (bool recorded,) = r.boxIdOf(factory.box0Addresses().coordinator);
        assertFalse(recorded);
    }
}
