// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {BoxKind, BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../../../src/libraries/TransientReentrancyGuard.sol";
import {HookGasFit} from "../../research/hookgas/HookGasKit.sol";
import {BoxS6Base} from "./BoxS6Base.sol";
import {
    HostileModule,
    IS6Coordinator,
    MockBoxCollection,
    MockBoxReceiverS6,
    MockBoxRouterS6,
    MockBoxTickets,
    MockBoxVault,
    MockGradHook,
    RefusingRecipientS6
} from "./BoxS6Mocks.sol";

/// @notice The coordinator alone, against stand-ins for every other contract (its hook is `MockGradHook`, whose D6
/// reserve the test sets): creation (`deploy`, `launch`), the D6 reward's arithmetic (BC-027's zero, below-cap and
/// above-cap unit cases), gifts, claims, the gas floor, the views and the inert implementation.
contract BoxCoordinatorUnitTest is BoxS6Base {
    struct UBox {
        BoxCoordinator coord;
        HookGasFit t;
        MockGradHook hook;
        address receiver;
        MockBoxRouterS6 router;
        MockBoxVault vault;
        MockBoxCollection collection;
        address tickets;
        address executor;
        uint256 raise;
        uint256 creatorBuy;
    }

    struct UParams {
        BoxKind kind;
        uint256 raise;
        uint256 creatorBuy;
        address creator;
        bool tickets;
        bool hostileReceiver;
        uint256 boxId;
    }

    address internal stranger = makeAddr("s6.stranger");
    address internal outsideExecutor;

    function setUp() public {
        _setUpWorld();
        outsideExecutor = address(new HostileModule());
    }

    // ------------------------------------------------------------------------------------------------------------
    // The unit world

    function _uParams() internal pure returns (UParams memory p) {
        p.kind = BoxKind.Box0;
        p.raise = BOX0_RAISE;
        p.tickets = true;
    }

    function _uCoordArgs(UParams memory p, uint8[9] memory nonces, address executorArg)
        internal
        view
        returns (bytes memory)
    {
        bytes memory head = abi.encodePacked(
            uint8(p.kind),
            address(0),
            uint128(p.raise),
            uint128(p.creatorBuy),
            p.creator,
            keccak256("unit spec"),
            executorArg,
            randomness
        );
        bytes memory tail;
        for (uint256 i; i < 9; ++i) {
            tail = abi.encodePacked(tail, nonces[i]);
        }
        return abi.encodePacked(head, tail);
    }

    function _uNonces(UParams memory p) internal pure returns (uint8[9] memory n) {
        n = [1, 2, 3, 4, 5, 0, 0, 0, 0];
        if (p.kind == BoxKind.Box0) n[8] = 6;
        if (p.tickets) n[5] = p.kind == BoxKind.Box0 ? 7 : 6;
    }

    /// @dev Clones a coordinator with the given arguments (CREATE2 by this test, the factory).
    function _cloneCoordinator(bytes memory args, bytes32 salt) internal returns (BoxCoordinator c) {
        bytes memory init = BoxClones.initCode(BoxClones.runtime(address(coordImpl), args));
        address a;
        assembly {
            a := create2(0, add(init, 0x20), mload(init), salt)
        }
        require(a != address(0), "clone");
        c = BoxCoordinator(a);
    }

    function _uCodes(UParams memory p, address c) internal pure returns (bytes[] memory codes) {
        uint256 count = 5 + (p.kind == BoxKind.Box0 ? 1 : 0) + (p.tickets ? 1 : 0);
        codes = new bytes[](count);
        address vault_ = _at(c, 2);
        codes[0] = abi.encodePacked(type(HookGasFit).creationCode, abi.encode(BoxSpecV1.ISSUANCE, c, vault_));
        codes[1] = abi.encodePacked(type(MockBoxVault).creationCode, abi.encode(c, _at(c, 3), uint256(69)));
        codes[2] = abi.encodePacked(type(MockBoxCollection).creationCode, abi.encode(c));
        codes[3] = p.hostileReceiver
            ? type(HostileModule).creationCode
            : abi.encodePacked(type(MockBoxReceiverS6).creationCode, abi.encode(c));
        codes[4] = abi.encodePacked(type(MockBoxRouterS6).creationCode, abi.encode(c));
        uint256 i = 5;
        if (p.kind == BoxKind.Box0) codes[i++] = type(HostileModule).creationCode;
        if (p.tickets) codes[i] = abi.encodePacked(type(MockBoxTickets).creationCode, abi.encode(c, vault_));
    }

    function _at(address c, uint256 nonce) internal pure returns (address) {
        return vm.computeCreateAddress(c, nonce);
    }

    function _uBuild(UParams memory p) internal returns (UBox memory u) {
        ++boxSeed;
        address executorArg = p.kind == BoxKind.Box0 ? address(0) : outsideExecutor;
        u.coord = _cloneCoordinator(_uCoordArgs(p, _uNonces(p), executorArg), bytes32(boxSeed));
        address c = address(u.coord);
        bytes memory hookCode = abi.encodePacked(type(MockGradHook).creationCode, abi.encode(pm, c, _at(c, 1)));
        u.coord.deploy(_uCodes(p, c), hookCode, bytes32(0), p.boxId);
        u.t = HookGasFit(_at(c, 1));
        u.vault = MockBoxVault(_at(c, 2));
        u.collection = MockBoxCollection(_at(c, 3));
        u.receiver = _at(c, 4);
        u.router = MockBoxRouterS6(_at(c, 5));
        u.hook = MockGradHook(payable(u.coord.hook()));
        u.executor = p.kind == BoxKind.Box0 ? _at(c, 6) : outsideExecutor;
        if (p.tickets) u.tickets = _at(c, p.kind == BoxKind.Box0 ? 7 : 6);
        u.raise = p.raise;
        u.creatorBuy = p.creatorBuy;
        vm.deal(address(u.hook), 100 ether);
    }

    function _uLaunch(UBox memory u) internal {
        uint256 v = BoxSpecV1.BOOTSTRAP_ETH + u.creatorBuy;
        vm.deal(address(this), address(this).balance + v);
        u.coord.launch{value: v}();
    }

    function _uReady(UParams memory p) internal returns (UBox memory u) {
        u = _uBuild(p);
        _uLaunch(u);
        u.hook.setClosed(true);
    }

    function _cap(uint256 raise_) internal pure returns (uint256) {
        return raise_ * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000;
    }

    // ------------------------------------------------------------------------------------------------------------
    // deploy: the factory only, once; the nonce arguments must fit the codes

    function test_deploy_wiringFollowsTheNonces() public {
        UParams memory p = _uParams();
        p.boxId = 0;
        UBox memory u = _uBuild(p);
        BoxCoordinator c = u.coord;
        assertEq(c.token(), _at(address(c), 1), "T at nonce 1");
        assertEq(c.vault(), _at(address(c), 2));
        assertEq(c.collection(), _at(address(c), 3));
        assertEq(c.receiver(), _at(address(c), 4));
        assertEq(c.launchRouter(), _at(address(c), 5));
        assertEq(c.executor(), _at(address(c), 6), "box 0: FIT's executor born with the box");
        assertEq(c.tickets(), _at(address(c), 7));
        assertEq(c.royaltyRouter(), address(0), "no royalties add-on");
        assertEq(c.itemStream(), address(0), "no stream");
        assertEq(c.hook(), vm.computeCreate2Address(bytes32(0), keccak256(_hookCodeOf(c)), address(c)));
        assertEq(c.boxId(), 0);
        assertEq(uint256(c.kind()), uint256(BoxKind.Box0));
        assertEq(c.q(), address(0));
        assertEq(c.raise(), BOX0_RAISE);
        assertEq(c.creatorBuyAmount(), 0);
        assertEq(c.specHash(), keccak256("unit spec"));
        assertEq(c.randomness(), randomness);
        assertEq(c.factory(), address(this));
        assertEq(c.poolManager(), address(pm));
        assertEq(c.POKE_GAS(), 2_600_000, "F95 R19M");
        assertEq(c.rewardCap(), _cap(BOX0_RAISE));
        assertEq(c.nonceOf(c.ROLE_TOKEN()), 1);
        assertEq(c.nonceOf(c.ROLE_EXECUTOR()), 6);
        assertEq(c.nonceOf(9), 0, "no tenth role");
        assertEq(uint256(c.phase()), uint256(BoxPhase.None), "deployed, not launched");
        assertEq(c.poolShare(), 0);
        assertEq(c.reserve(), 0);
        // Other boxes: FIT's executor is the argument.
        UParams memory s = _uParams();
        s.kind = BoxKind.Standard;
        s.boxId = 7;
        UBox memory v = _uBuild(s);
        assertEq(v.coord.executor(), outsideExecutor);
        assertEq(v.coord.tickets(), _at(address(v.coord), 6));
        assertEq(v.coord.boxId(), 7);
    }

    function _hookCodeOf(BoxCoordinator c) internal view returns (bytes memory) {
        return abi.encodePacked(type(MockGradHook).creationCode, abi.encode(pm, address(c), c.token()));
    }

    function test_deploy_onlyTheFactoryOnce() public {
        UParams memory p = _uParams();
        BoxCoordinator c = _cloneCoordinator(_uCoordArgs(p, _uNonces(p), address(0)), bytes32("x"));
        bytes[] memory codes = _uCodes(p, address(c));
        bytes memory hookCode = abi.encodePacked(type(MockGradHook).creationCode, abi.encode(pm, c, _at(address(c), 1)));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, stranger));
        c.deploy(codes, hookCode, bytes32(0), 0);
        c.deploy(codes, hookCode, bytes32(0), 0);
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        c.deploy(codes, hookCode, bytes32(uint256(1)), 0);
    }

    function test_deploy_refusesNoncesThatDoNotFit() public {
        UParams memory p = _uParams();
        uint256 salt;
        // A required role without a nonce.
        uint8[9] memory n = _uNonces(p);
        n[2] = 0;
        _expectInvalidNonces(p, n, address(0), ++salt);
        // A nonce beyond the last code.
        n = _uNonces(p);
        n[6] = 8;
        _expectInvalidNonces(p, n, address(0), ++salt);
        // One nonce for two roles.
        n = _uNonces(p);
        n[3] = 2;
        _expectInvalidNonces(p, n, address(0), ++salt);
        // The executor both created here and named, or neither.
        n = _uNonces(p);
        _expectInvalidNonces(p, n, outsideExecutor, ++salt);
        n[8] = 0;
        _expectInvalidNonces(p, n, address(0), ++salt);
    }

    function _expectInvalidNonces(UParams memory p, uint8[9] memory n, address executorArg, uint256 salt) internal {
        BoxCoordinator c = _cloneCoordinator(_uCoordArgs(p, n, executorArg), bytes32(salt + 1000));
        bytes[] memory codes = _uCodes(p, address(c));
        vm.expectRevert(BoxCoordinator.InvalidNonces.selector);
        c.deploy(codes, hex"00", bytes32(0), 0);
    }

    function test_deploy_refusesTooManyCodesAnUnknownKindAndALargeBoxId() public {
        UParams memory p = _uParams();
        BoxCoordinator c = _cloneCoordinator(_uCoordArgs(p, _uNonces(p), address(0)), bytes32("many"));
        vm.expectRevert(BoxCoordinator.InvalidNonces.selector);
        c.deploy(new bytes[](128), hex"00", bytes32(0), 0);
        vm.expectRevert(BoxCoordinator.InvalidNonces.selector);
        c.deploy(new bytes[](0), hex"00", bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(BoxCoordinator.BoxIdTooLarge.selector, uint256(1) << 48));
        c.deploy(_uCodes(p, address(c)), hex"00", bytes32(0), uint256(1) << 48);
        p.kind = BoxKind.None;
        BoxCoordinator d = _cloneCoordinator(_uCoordArgs(p, _uNonces(p), address(0)), bytes32("kind"));
        vm.expectRevert(abi.encodeWithSelector(BoxCoordinator.UnknownKind.selector, uint8(0)));
        d.deploy(_uCodes(p, address(d)), hex"00", bytes32(0), 0);
    }

    function test_deploy_aFailingCodeRevertsEverything() public {
        UParams memory p = _uParams();
        BoxCoordinator c = _cloneCoordinator(_uCoordArgs(p, _uNonces(p), address(0)), bytes32("fail"));
        bytes[] memory codes = _uCodes(p, address(c));
        codes[2] = hex"fe"; // INVALID: the CREATE fails
        vm.expectRevert(abi.encodeWithSelector(BoxCoordinator.DeployFailed.selector, uint256(2)));
        c.deploy{gas: 10_000_000}(codes, hex"00", bytes32(0), 0);
        codes = _uCodes(p, address(c));
        codes[4] = hex"00"; // STOP: no code left behind
        vm.expectRevert(abi.encodeWithSelector(BoxCoordinator.DeployFailed.selector, uint256(4)));
        c.deploy(codes, hex"00", bytes32(0), 0);
        // The hook's CREATE2 leaving no code.
        vm.expectRevert(abi.encodeWithSelector(BoxCoordinator.DeployFailed.selector, type(uint256).max));
        c.deploy(_uCodes(p, address(c)), hex"00", bytes32(0), 0);
        assertEq(c.hook(), address(0), "nothing recorded");
    }

    // ------------------------------------------------------------------------------------------------------------
    // launch: the factory only, once, after deploy, with exactly the bootstrap plus the creator buy

    function test_launch_pinnedOrderAndValue() public {
        UParams memory p = _uParams();
        p.kind = BoxKind.Standard;
        p.creatorBuy = 0.5 ether;
        p.creator = carol;
        UBox memory u = _uBuild(p);
        uint256 v = BoxSpecV1.BOOTSTRAP_ETH + p.creatorBuy;
        vm.deal(stranger, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, stranger));
        u.coord.launch{value: v}();
        vm.deal(address(this), 10 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.WrongValue.selector, v - 1, v));
        u.coord.launch{value: v - 1}();
        vm.recordLogs();
        u.coord.launch{value: v}();
        assertGt(u.collection.initializedAt(), 0, "collection");
        assertTrue(u.vault.initialized(), "vault (after the collection: the stand-in checks it)");
        assertTrue(MockBoxTickets(u.tickets).initialized(), "tickets");
        assertTrue(u.hook.initialized() && u.hook.launched(), "hook initialised then launched");
        assertTrue(u.router.initialized(), "router");
        assertTrue(MockBoxReceiverS6(u.receiver).initialized(), "receiver");
        assertEq(u.router.bootstrapValue(), BoxSpecV1.BOOTSTRAP_ETH, "bootstrap");
        assertEq(u.router.creatorBuyValue(), 0.5 ether, "creator buy");
        assertEq(u.router.creatorSeen(), carol, "T to the creator");
        assertEq(u.t.allowance(address(u.coord), address(u.hook)), type(uint256).max, "the hook may pull T");
        assertEq(address(u.coord).balance, 0, "no ETH left behind");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(u.coord) && logs[i].topics[0] == IBoxCoordinator.BoxLaunched.selector) {
                (uint256 openAt,, uint256 buyQ,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(openAt, block.timestamp + 1);
                assertEq(buyQ, 0.5 ether);
                seen = true;
            }
        }
        assertTrue(seen, "BoxLaunched");
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        u.coord.launch{value: v}();
    }

    function test_launch_beforeDeployRefused() public {
        UParams memory p = _uParams();
        BoxCoordinator c = _cloneCoordinator(_uCoordArgs(p, _uNonces(p), address(0)), bytes32("early"));
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BoxCoordinator.NotDeployed.selector);
        c.launch{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.expectRevert(IBoxCoordinator.NotLaunched.selector);
        c.graduate();
    }

    // ------------------------------------------------------------------------------------------------------------
    // The implementation is never a box (S0 decision 9)

    function test_implementationIsInert() public {
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        coordImpl.deploy(new bytes[](1), hex"00", bytes32(0), 0);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        coordImpl.launch{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.expectRevert();
        coordImpl.graduate();
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordImpl.claimReward(alice);
        vm.expectRevert(IBoxCoordinator.ZeroAddress.selector);
        new BoxCoordinator(pm, address(0));
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-027, unit: the reward is min(reserve, cap), exactly once, a claim; zero fees credit nothing

    function test_BC027_unit_zeroFees() public {
        UBox memory u = _uReady(_uParams());
        vm.prank(keeper);
        uint256 reward = u.coord.graduate();
        assertEq(reward, 0, "no fee, no reward");
        assertEq(u.coord.rewardOf(keeper), 0);
        assertTrue(u.coord.graduated());
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        u.coord.claimReward(keeper);
    }

    function test_BC027_unit_belowCap() public {
        UBox memory u = _uReady(_uParams());
        u.hook.mintReserve(_cap(u.raise) / 3);
        assertEq(u.coord.reserve(), _cap(u.raise) / 3);
        vm.prank(keeper);
        uint256 reward = u.coord.graduate();
        assertEq(reward, _cap(u.raise) / 3, "all the curve's fees, below the cap");
        assertEq(u.coord.reserve(), 0, "credited: no reserve left");
        _claimAndCheck(u, keeper, reward);
    }

    function test_BC027_unit_aboveCapAndTopUpInMigrate() public {
        UBox memory u = _uReady(_uParams());
        u.hook.mintReserve(_cap(u.raise) - 5);
        u.hook.setMigrate(type(uint256).max, 50); // migrate's last poke tops up by more than the room left
        vm.prank(keeper);
        uint256 reward = u.coord.graduate();
        assertEq(reward, _cap(u.raise), "never above 0.1% of R, even if a hook minted more");
        assertEq(_claims(u.receiver, address(0)), 45, "the excess became the receiver's fees");
        _claimAndCheck(u, keeper, reward);
    }

    function test_BC027_unit_giftsAreFeesNotReward() public {
        UBox memory u = _uReady(_uParams());
        u.hook.mintReserve(1000);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        minter.mintTo{value: 0.3 ether}(address(u.coord));
        assertEq(u.coord.reserve(), 1000, "a gift is not the reserve");
        vm.recordLogs();
        vm.prank(keeper);
        uint256 reward = u.coord.graduate();
        assertEq(reward, 1000);
        assertEq(_claims(u.receiver, address(0)), 0.3 ether, "the gift went to the receiver as fees");
        assertEq(_claims(address(u.coord), address(0)), 1000, "the coordinator holds only the reward");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BoxCoordinator.ClaimsForwarded.selector) seen = true;
        }
        assertTrue(seen, "ClaimsForwarded");
    }

    function _claimAndCheck(UBox memory u, address caller, uint256 reward) internal {
        assertEq(u.coord.rewardOf(caller), reward);
        assertEq(u.coord.rewardOf(stranger), 0);
        vm.prank(stranger);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        u.coord.claimReward(stranger);
        vm.prank(caller);
        vm.expectRevert(IBoxCoordinator.ZeroAddress.selector);
        u.coord.claimReward(address(0));
        uint256 before = bob.balance;
        vm.prank(caller);
        vm.expectEmit(true, false, false, true, address(u.coord));
        emit IBoxCoordinator.RewardClaimed(caller, bob, reward);
        assertEq(u.coord.claimReward(bob), reward);
        assertEq(bob.balance - before, reward, "paid in Q to any address");
        assertEq(_claims(address(u.coord), address(0)), 0, "claims redeemed");
        assertEq(u.coord.rewardOf(caller), 0);
        vm.prank(caller);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        u.coord.claimReward(bob);
    }

    /// @dev BC-027, unit fuzz: reward = min(reserve minted, 0.1% of R); the excess and any gift go to the receiver as
    /// fees; the coordinator keeps exactly the reward; the claim pays it.
    function testFuzz_BC027_unit_minReserveCap(uint256 minted, uint256 topUp, uint256 gift, uint256 raiseSeed) public {
        UParams memory p = _uParams();
        p.raise = bound(raiseSeed, 0.01 ether, 1_000 ether);
        UBox memory u = _uReady(p);
        uint256 cap = _cap(p.raise);
        minted = bound(minted, 0, 2 * cap + 1);
        topUp = bound(topUp, 0, cap + 1);
        gift = bound(gift, 0, 1 ether);
        u.hook.mintReserve(minted);
        u.hook.setMigrate(type(uint256).max, topUp);
        if (gift != 0) {
            vm.deal(stranger, gift);
            vm.prank(stranger);
            minter.mintTo{value: gift}(address(u.coord));
        }
        vm.prank(keeper);
        uint256 reward = u.coord.graduate();
        uint256 expected = minted + topUp < cap ? minted + topUp : cap;
        assertEq(reward, expected, "min(reserve, cap)");
        assertLe(reward, cap);
        assertEq(_claims(address(u.coord), address(0)), reward, "keeps exactly the reward");
        assertEq(_claims(u.receiver, address(0)), minted + topUp + gift - reward, "the rest is the receiver's fees");
        if (reward != 0) {
            vm.prank(keeper);
            assertEq(u.coord.claimReward(bob), reward);
        }
    }

    function test_claim_refusingRecipientKeepsTheClaim() public {
        UBox memory u = _uReady(_uParams());
        u.hook.mintReserve(777);
        RefusingRecipientS6 r = new RefusingRecipientS6();
        assertEq(r.graduate(IS6Coordinator(address(u.coord))), 777, "a contract that refuses ETH graduates");
        vm.expectRevert(IBoxCoordinator.ClaimFailed.selector);
        r.claim(IS6Coordinator(address(u.coord)), address(r));
        r.setBurn(true);
        vm.expectRevert(IBoxCoordinator.ClaimFailed.selector);
        r.claim{gas: 3_000_000}(IS6Coordinator(address(u.coord)), address(r));
        assertEq(u.coord.rewardOf(address(r)), 777, "still credited");
        assertEq(r.claim(IS6Coordinator(address(u.coord)), alice), 777, "to another address");
        assertEq(alice.balance, 777);
    }

    function test_unlockCallback_onlyInsideItsOwnClaim() public {
        UBox memory u = _uReady(_uParams());
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        u.coord.unlockCallback(abi.encode(alice, uint256(1)));
        vm.prank(address(pm));
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        u.coord.unlockCallback(abi.encode(alice, uint256(1)));
    }

    // ------------------------------------------------------------------------------------------------------------
    // graduate(): the order of checks; the gas floor

    function test_graduate_refusesBeforeLaunchBeforeCloseAndTwice() public {
        UBox memory u = _uBuild(_uParams());
        vm.expectRevert(IBoxCoordinator.NotLaunched.selector);
        u.coord.graduate();
        _uLaunch(u);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        u.coord.graduate();
        u.hook.setClosed(true);
        u.coord.graduate();
        vm.prank(alice);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        u.coord.graduate();
    }

    function test_graduate_statusAndViews() public {
        UBox memory u = _uReady(_uParams());
        uint256 poolShare = u.t.balanceOf(address(u.coord));
        assertEq(u.coord.poolShare(), poolShare);
        u.hook.setMigrate(poolShare - 123, 0);
        _roll(5);
        vm.recordLogs();
        u.coord.graduate();
        assertEq(u.coord.graduatedAt(), block.timestamp);
        assertEq(u.coord.graduatedAtBlock(), block.number, "the hook's migration block");
        assertEq(uint256(u.coord.phase()), uint256(BoxPhase.Graduated));
        assertEq(u.coord.poolShare(), 0);
        assertEq(u.t.balanceOf(address(u.coord)), 0, "the T the ask could not take is burned");
        assertEq(u.hook.migrateBudget(), poolShare, "the whole T to the migration");
        assertEq(u.vault.openGateCalls(), 1, "gate opened once");
        assertEq(MockBoxReceiverS6(u.receiver).graduations(), 1, "receiver poked");
        assertEq(MockBoxTickets(u.tickets).requester(), address(u.coord), "graduation word requested");
        assertEq(HostileModule(payable(u.executor)).pokes(), 1, "executor poked");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IBoxCoordinator.Graduated.selector) {
                (uint256 blockNumber, uint256 share, uint256 dust, uint256 reward) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                assertEq(blockNumber, block.number);
                assertEq(share, poolShare);
                assertEq(dust, 123);
                assertEq(reward, 0);
                return;
            }
        }
        revert("no Graduated");
    }

    /// @dev A caller sending too little gas for the pokes' floor is refused (and nothing changes); with enough it works.
    function test_graduate_gasFloor() public {
        UBox memory u = _uReady(_uParams());
        (bool ok, bytes memory ret) = address(u.coord).call{gas: 900_000}(abi.encodeWithSignature("graduate()"));
        assertFalse(ok);
        assertEq(bytes4(ret), IBoxCoordinator.GasTooLow.selector, "GasTooLow");
        assertFalse(u.coord.graduated(), "nothing changed");
        (ok,) = address(u.coord).call{gas: 4_000_000}(abi.encodeWithSignature("graduate()"));
        assertTrue(ok);
        assertTrue(u.coord.graduated());
    }

    /// @dev A hostile receiver stand-in (BC-098's unit form): with zero fees, reverting, burning or re-entering, the
    /// coordinator still graduates; the re-entry is refused by the shared lock.
    function test_BC098_unit_hostileReceiverZeroFees() public {
        HostileModule.Mode[4] memory modes = [
            HostileModule.Mode.Revert,
            HostileModule.Mode.BurnGas,
            HostileModule.Mode.Reenter,
            HostileModule.Mode.ReturnBomb
        ];
        for (uint256 i; i < modes.length; ++i) {
            UParams memory p = _uParams();
            p.hostileReceiver = true;
            UBox memory u = _uReady(p);
            HostileModule(payable(u.receiver)).setMode(modes[i], address(u.coord));
            vm.prank(keeper);
            assertEq(u.coord.graduate{gas: 8_000_000}(), 0);
            assertTrue(u.coord.graduated());
            if (modes[i] == HostileModule.Mode.Reenter) {
                HostileModule h = HostileModule(payable(u.receiver));
                assertFalse(h.reentryGraduateSucceeded());
                assertEq(h.reentryGraduateError(), TransientReentrancyGuard.Reentrancy.selector, "the lock refused it");
                assertFalse(h.reentryClaimSucceeded());
            }
        }
    }
}
