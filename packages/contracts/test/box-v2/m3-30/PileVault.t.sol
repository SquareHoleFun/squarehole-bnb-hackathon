// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {PileVaultV2} from "../../../src/box-v2/PileVaultV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";

/// @dev Test-only coordinator/listing fixture using existing CQ11 selectors, not a proposed production API.
contract PileCoordinatorFixture {
    address public creator;
    address public token;
    address public vault;
    address public starterSetLoader;
    address public listingRegistry;
    address public listedAsset;
    bool public graduated;
    bool public failed;
    bool public gateOpen;
    bool public refuseNotice;
    uint256 public notices;
    function configure(address t, address v, address a, bool seeded) external {
        creator = msg.sender;
        token = t; vault = v; listedAsset = a; listingRegistry = address(this);
        starterSetLoader = seeded ? v : address(0); gateOpen = !seeded;
    }
    function setCreator(address who) external { creator = who; }
    function roleAddress(uint256 role) external view returns (address) { return role == 3 ? vault : address(0); }
    function newestListingOf(address a) external view returns (bool, uint32) { return (a == listedAsset, 0); }
    function initialize() external { IPileVaultV2(vault).initialize(); }
    function setRefusal(bool on) external { refuseNotice = on; }
    function starterSetLoaded() external {
        require(msg.sender == starterSetLoader && !gateOpen && !failed && !refuseNotice, "notice");
        ++notices; gateOpen = true;
    }
    function graduate() external { graduated = true; IPileVaultV2(vault).openGate(); }
    function fail() external { failed = true; IPileVaultV2(vault).enterFailure(); }
}

contract NativeSeeder {
    bool public refuses;
    function setRefusal(bool on) external { refuses = on; }
    function load(IPileVaultV2 p, uint256 value) external { p.loadSeed{value: value}(); }
    receive() external payable { require(!refuses, "native refused"); }
}

contract PileVaultTest is Test {
    IPileVaultV2 internal pile;
    PileCoordinatorFixture internal coordinator;
    HostileToken internal seed;
    HostileToken internal t;
    address internal implementation;
    address internal coordinatorImplementation;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function setUp() public {
        coordinatorImplementation = address(new PileCoordinatorFixture());
        implementation = address(new PileVaultV2(coordinatorImplementation));
        _make(6, 1000, 100, address(this), false);
    }
    function _make(uint8 decimals_, uint256 amount, uint256 supply, address seeder_, bool native_) internal {
        coordinator = PileCoordinatorFixture(BoxClones.create(BoxClones.initCode(coordinatorImplementation, "")));
        seed = new HostileToken("Seed", "P", decimals_);
        t = new HostileToken("Own coin", "T", 18);
        address a = native_ ? address(0) : address(seed);
        pile = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coordinator), address(t), a, seeder_, amount))));
        coordinator.configure(address(t), address(pile), a, amount != 0);
        coordinator.setCreator(seeder_);
        coordinator.initialize();
        seed.mint(seeder_, amount);
        vm.prank(seeder_); seed.approve(address(pile), amount);
        t.mint(ALICE, supply);
        vm.prank(ALICE); t.approve(address(pile), type(uint256).max);
        vm.prank(BOB); t.approve(address(pile), type(uint256).max);
    }
    function _redeem(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who); return pile.redeem(amount, 0, who);
    }
    function _ready() internal { pile.loadSeed(); coordinator.graduate(); }
    function _failedCall(address target, bytes memory data) internal {
        (bool ok,) = target.call(data); assertFalse(ok, "call must revert");
    }

    function test_R10_exactSeedOnceAndImmutableWiring() public {
        assertEq(pile.seeder(), address(this)); assertEq(pile.asset(), address(seed));
        assertEq(pile.seedAmount(), 1000);
        assertEq(pile.supplyFloor(), 0); assertEq(pile.collectionSize(), 0); assertEq(pile.inside(), 0);
        vm.prank(BOB); pile.loadSeed();
        assertEq(seed.balanceOf(address(this)), 0); assertEq(seed.balanceOf(address(pile)), 1000);
        assertEq(coordinator.notices(), 1); assertTrue(coordinator.gateOpen());
        _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
        assertEq(coordinator.notices(), 1);
    }
    function test_R10_noticeFailureRollsBackSeedAndAllowance() public {
        coordinator.setRefusal(true);
        _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
        assertEq(seed.balanceOf(address(this)), 1000); assertEq(seed.balanceOf(address(pile)), 0);
        assertEq(seed.allowance(address(this), address(pile)), 1000); assertFalse(coordinator.gateOpen());
        coordinator.setRefusal(false); pile.loadSeed(); assertEq(coordinator.notices(), 1);
    }
    function test_R10_phasesAndCallerOnlySpendsOwnT() public {
        _failedCall(address(coordinator), abi.encodeCall(coordinator.graduate, ()));
        pile.loadSeed();
        _failedCall(address(pile), abi.encodeCall(pile.openGate, ()));
        _failedCall(address(pile), abi.encodeCall(pile.enterFailure, ()));
        vm.prank(ALICE); vm.expectRevert(); pile.redeem(10, 0, ALICE);
        coordinator.graduate();
        vm.prank(BOB); vm.expectRevert(); pile.redeem(10, 0, BOB);
        assertEq(t.balanceOf(ALICE), 100); assertEq(t.totalSupply(), 100);
        _failedCall(address(coordinator), abi.encodeCall(coordinator.fail, ()));
        _failedCall(address(coordinator), abi.encodeCall(coordinator.graduate, ()));
        assertEq(_redeem(ALICE, 100), 1000);
    }
    function test_R10_twoHoldersBothOrdersAndLastRedemption() public {
        for (uint256 order; order < 2; ++order) {
            _make(8, 1001, 100, address(this), false); _ready();
            vm.prank(ALICE); t.transfer(BOB, 37);
            address first = order == 0 ? ALICE : BOB;
            address last = order == 0 ? BOB : ALICE;
            uint256 firstT = t.balanceOf(first);
            uint256 expected = 1001 * firstT / 100;
            assertEq(pile.quoteRedeem(firstT), expected);
            assertEq(_redeem(first, firstT), expected);
            assertEq(_redeem(last, t.balanceOf(last)), 1001 - expected);
            assertEq(seed.balanceOf(address(pile)), 0); assertEq(t.totalSupply(), 0);
            assertEq(seed.balanceOf(ALICE) + seed.balanceOf(BOB), 1001);
            assertEq(pile.quoteRedeem(0), 0);
        }
    }
    function test_R10_splitRoundingAndZeroOutput() public {
        _make(6, 3, 100, address(this), false); _ready();
        assertEq(_redeem(ALICE, 1), 0);
        assertEq(_redeem(ALICE, 49), 1);
        assertEq(_redeem(ALICE, 50), 2);
        assertEq(seed.balanceOf(ALICE), 3); assertEq(t.totalSupply(), 0);
    }
    function test_R10_zeroSeedHasNoLoaderAndNeedsNoLoad() public {
        _make(18, 0, 100, address(this), false);
        assertEq(coordinator.starterSetLoader(), address(0));
        _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
        coordinator.graduate(); assertEq(_redeem(ALICE, 100), 0);
        assertEq(coordinator.notices(), 0); assertEq(t.totalSupply(), 0);
    }
    function test_R10_minimumRecipientAndPayoutAreAtomic() public {
        _ready();
        vm.startPrank(ALICE);
        vm.expectRevert(); pile.redeem(10, 101, ALICE);
        vm.expectRevert(); pile.redeem(10, 0, address(0));
        vm.expectRevert(); pile.redeem(10, 0, address(pile));
        vm.expectRevert(); pile.redeem(0, 0, ALICE);
        vm.stopPrank();
        seed.setPaused(true); vm.prank(ALICE); vm.expectRevert(); pile.redeem(10, 0, ALICE);
        assertEq(t.totalSupply(), 100); assertEq(t.balanceOf(ALICE), 100);
        assertEq(seed.balanceOf(address(pile)), 1000);
        seed.setPaused(false); assertEq(_redeem(ALICE, 10), 100);
    }
    function test_R10_eachDecimalExactnessAndReentryRollback() public {
        uint8[3] memory decimals_ = [uint8(6), 8, 18];
        for (uint256 i; i < 3; ++i) {
            _make(decimals_[i], 10 ** decimals_[i], 100, address(this), false);
            seed.setFeeBps(100); _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
            assertEq(seed.balanceOf(address(pile)), 0);
            seed.setFeeBps(0);
            seed.armReentry(address(pile), abi.encodeCall(pile.loadSeed, ()));
            _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
            seed.armReentry(address(0), ""); _ready();
            seed.armReentry(address(pile), abi.encodeCall(pile.redeem, (1, 0, ALICE)));
            vm.prank(ALICE); vm.expectRevert(); pile.redeem(100, 0, ALICE);
            assertEq(t.totalSupply(), 100); assertEq(t.balanceOf(ALICE), 100);
            seed.armReentry(address(0), ""); seed.setFeeBps(100);
            vm.prank(ALICE); vm.expectRevert(); pile.redeem(100, 0, ALICE);
            seed.setFeeBps(0); assertEq(_redeem(ALICE, 100), 10 ** decimals_[i]);
        }
    }
    function test_R11_failureNeverCallsSeedAndReturnRetriesWithoutReleasingT() public {
        pile.loadSeed(); vm.prank(ALICE); t.transfer(address(pile), 20);
        seed.setPaused(true); coordinator.fail();
        _failedCall(address(pile), abi.encodeCall(pile.returnSeed, ()));
        assertEq(seed.balanceOf(address(pile)), 1000); assertEq(t.balanceOf(address(pile)), 20);
        _failedCall(address(coordinator), abi.encodeCall(coordinator.graduate, ()));
        _failedCall(address(coordinator), abi.encodeCall(coordinator.fail, ()));
        seed.setPaused(false);
        seed.armReentry(address(pile), abi.encodeCall(pile.returnSeed, ()));
        _failedCall(address(pile), abi.encodeCall(pile.returnSeed, ()));
        seed.armReentry(address(0), ""); vm.prank(BOB); assertEq(pile.returnSeed(), 1000);
        assertEq(seed.balanceOf(address(this)), 1000); assertEq(seed.balanceOf(BOB), 0);
        assertEq(t.balanceOf(address(pile)), 20); assertEq(t.totalSupply(), 100);
        _failedCall(address(pile), abi.encodeCall(pile.returnSeed, ()));
        _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
    }
    function test_R11_unloadedFailureCannotPullSeederMoney() public {
        coordinator.fail();
        _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
        assertEq(pile.returnSeed(), 0); assertEq(seed.balanceOf(address(this)), 1000);
    }
    function test_R10_nativeSeedIdentityExactValueAndPayout() public {
        NativeSeeder s = new NativeSeeder(); vm.deal(address(s), 1000);
        _make(18, 1000, 100, address(s), true);
        vm.deal(address(this), 1000);
        vm.expectRevert(); pile.loadSeed{value: 1000}();
        vm.expectRevert(); s.load(pile, 999);
        s.load(pile, 1000); coordinator.graduate();
        uint256 before_ = ALICE.balance; assertEq(_redeem(ALICE, 100), 1000);
        assertEq(ALICE.balance - before_, 1000); assertEq(address(pile).balance, 0);
    }
    function test_R11_nativeFailedReturnRetries() public {
        NativeSeeder s = new NativeSeeder(); vm.deal(address(s), 1000);
        _make(18, 1000, 100, address(s), true); s.load(pile, 1000);
        s.setRefusal(true); coordinator.fail();
        _failedCall(address(pile), abi.encodeCall(pile.returnSeed, ()));
        assertEq(address(pile).balance, 1000);
        s.setRefusal(false); assertEq(pile.returnSeed(), 1000); assertEq(address(s).balance, 1000);
    }
    function test_R10_noFeeIntakeOrBudgetAndLiveBalanceQuote() public {
        _ready();
        _failedCall(address(pile), abi.encodeWithSignature("fundBudget()"));
        _failedCall(address(pile), abi.encodeWithSignature("onFee(uint256)", 100));
        seed.mint(address(pile), 99); assertEq(pile.quoteRedeem(100), 1099);
        assertEq(_redeem(ALICE, 100), 1099);
    }
    function testFuzz_R10_conservationAndSplitting(uint128 seed_, uint128 supply_, uint128 first_) public {
        uint256 amount = bound(uint256(seed_), 1, type(uint128).max);
        uint256 supply = bound(uint256(supply_), 2, type(uint128).max);
        uint256 first = bound(uint256(first_), 1, supply - 1);
        _make(18, amount, supply, address(this), false); _ready();
        vm.prank(ALICE); t.transfer(BOB, supply - first);
        uint256 expected = amount * first / supply;
        assertEq(_redeem(ALICE, first), expected);
        assertEq(_redeem(BOB, supply - first), amount - expected);
        assertEq(seed.balanceOf(address(pile)), 0); assertEq(t.totalSupply(), 0);
    }
    function test_R10_fullPrecisionProduct() public {
        _make(18, 1 << 200, 1 << 100, address(this), false); _ready();
        assertEq(pile.quoteRedeem(1 << 99), 1 << 199);
        assertEq(_redeem(ALICE, 1 << 99), 1 << 199);
        assertEq(_redeem(ALICE, 1 << 99), 1 << 199);
    }

    function test_R10_realTokenOnlyVaultPullsAndZeroFloorAllowsLastBurn() public {
        coordinator = PileCoordinatorFixture(BoxClones.create(BoxClones.initCode(coordinatorImplementation, "")));
        address tokenImpl = address(new BoxTokenV2(coordinatorImplementation));
        address predictedPile = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        BoxTokenV2 realT = BoxTokenV2(BoxClones.create(BoxClones.initCode(tokenImpl,
            BoxTokenV2Args.encode(address(coordinator), predictedPile, address(0), 100, "Pile coin", "T"))));
        pile = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coordinator), address(realT), address(seed), address(this), uint256(1000)))));
        assertEq(address(pile), predictedPile);
        coordinator.configure(address(realT), address(pile), address(seed), true);
        vm.prank(address(coordinator)); realT.initialize(); coordinator.initialize();
        vm.prank(address(coordinator)); realT.transfer(ALICE, 100);
        seed.approve(address(pile), 1000); _ready();
        vm.startPrank(ALICE);
        vm.expectRevert(); realT.transfer(address(pile), 10);
        realT.approve(BOB, 10); vm.stopPrank();
        vm.prank(BOB); vm.expectRevert(); realT.transferFrom(ALICE, address(pile), 10);
        vm.prank(ALICE); realT.approve(address(pile), 100);
        assertEq(_redeem(ALICE, 100), 1000);
        assertEq(realT.totalSupply(), 0); assertEq(realT.totalBurned(), 100);
        assertEq(realT.balanceOf(address(pile)), 0); assertEq(realT.allowance(ALICE, address(pile)), 0);
    }
    function test_R10_rebaseCannotFakeSeedReceiptOrDebit() public {
        for (uint256 side; side < 2; ++side) {
            address rebased = side == 0 ? address(pile) : address(this);
            seed.armReentry(address(seed), abi.encodeCall(seed.mint, (rebased, 1)));
            _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
            assertEq(seed.balanceOf(address(this)), 1000); assertEq(seed.balanceOf(address(pile)), 0);
            assertEq(seed.totalSupply(), 1000); assertEq(seed.allowance(address(this), address(pile)), 1000);
            assertEq(coordinator.notices(), 0);
        }
        seed.armReentry(address(0), ""); _ready();
        seed.armReentry(address(seed), abi.encodeCall(seed.mint, (address(pile), 1)));
        vm.prank(ALICE); vm.expectRevert(); pile.redeem(100, 0, ALICE);
        assertEq(t.totalSupply(), 100); assertEq(seed.balanceOf(address(pile)), 1000);
        seed.armReentry(address(0), ""); assertEq(_redeem(ALICE, 100), 1000);
    }
    function test_R10_TFailuresAndCallbacksCannotChangeQuoteSnapshot() public {
        _ready(); vm.prank(ALICE); t.approve(address(pile), 100);
        t.setFeeBps(1000); vm.prank(ALICE); vm.expectRevert(); pile.redeem(10, 0, ALICE);
        t.setFeeBps(0);
        t.armReentry(address(seed), abi.encodeCall(seed.mint, (address(pile), 1)));
        vm.prank(ALICE); vm.expectRevert(); pile.redeem(10, 0, ALICE);
        t.armReentry(address(0), "");
        vm.mockCallRevert(address(t), abi.encodeCall(t.burn, (10)), "burn refused");
        vm.prank(ALICE); vm.expectRevert(); pile.redeem(10, 0, ALICE);
        vm.clearMockedCalls();
        assertEq(t.allowance(ALICE, address(pile)), 100); assertEq(t.balanceOf(ALICE), 100);
        assertEq(t.totalSupply(), 100); assertEq(seed.balanceOf(address(pile)), 1000);
        assertEq(_redeem(ALICE, 10), 100); assertEq(t.allowance(ALICE, address(pile)), 90);
    }
    function test_R10_uninitializedAndImplementationAreInert() public {
        IPileVaultV2 bare = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coordinator), address(t), address(seed), address(this), uint256(1000)))));
        address[2] memory targets = [implementation, address(bare)];
        for (uint256 i; i < 2; ++i) {
            _failedCall(targets[i], abi.encodeCall(pile.initialize, ()));
            _failedCall(targets[i], abi.encodeCall(pile.loadSeed, ()));
            _failedCall(targets[i], abi.encodeCall(pile.openGate, ()));
            _failedCall(targets[i], abi.encodeCall(pile.enterFailure, ()));
            _failedCall(targets[i], abi.encodeCall(pile.returnSeed, ()));
            _failedCall(targets[i], abi.encodeCall(pile.redeem, (1, 0, ALICE)));
        }
        _failedCall(address(coordinator), abi.encodeCall(coordinator.initialize, ()));
        assertEq(seed.balanceOf(address(this)), 1000);
    }
    function test_R10_initializeRejectsWrongWiring() public {
        for (uint256 bad; bad < 5; ++bad) {
            PileCoordinatorFixture c = PileCoordinatorFixture(BoxClones.create(BoxClones.initCode(coordinatorImplementation, "")));
            address a = bad == 0 ? address(t) : address(seed);
            IPileVaultV2 p = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
                abi.encodePacked(address(c), address(t), a, bad == 1 ? address(0) : address(this), uint256(1000)))));
            c.configure(bad == 4 ? address(seed) : address(t), address(p), bad == 2 ? address(0) : a, bad != 3);
            vm.expectRevert(PileVaultV2.InvalidWiring.selector); c.initialize();
        }
    }
    function test_S1_creatorMustBeSeederIncludingZeroAndNativeSeed() public {
        for (uint256 variant; variant < 4; ++variant) {
            PileCoordinatorFixture c = PileCoordinatorFixture(BoxClones.create(BoxClones.initCode(coordinatorImplementation, "")));
            address a = variant < 2 ? address(seed) : address(0);
            uint256 amount = variant % 2 == 0 ? 1000 : 0;
            IPileVaultV2 p = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
                abi.encodePacked(address(c), address(t), a, BOB, amount))));
            c.configure(address(t), address(p), a, amount != 0);
            assertEq(c.creator(), address(this));
            vm.expectRevert(PileVaultV2.InvalidWiring.selector); c.initialize();
        }
    }
    function test_R10_pausedSeedLoadingAndWrongNativeValueRollback() public {
        seed.setPaused(true); _failedCall(address(pile), abi.encodeCall(pile.loadSeed, ()));
        assertFalse(coordinator.gateOpen()); assertEq(seed.balanceOf(address(this)), 1000);
        seed.setPaused(false); vm.deal(address(this), 1);
        vm.expectRevert(PileVaultV2.WrongValue.selector); pile.loadSeed{value: 1}();
        _ready(); vm.expectRevert(PileVaultV2.InvalidRedemption.selector); pile.quoteRedeem(101);
        assertEq(_redeem(ALICE, 100), 1000);
    }
    function test_R10_nativeRecipientRefusalRollsBackBurn() public {
        NativeSeeder s = new NativeSeeder(); vm.deal(address(s), 1000);
        _make(18, 1000, 100, address(s), true); s.load(pile, 1000); coordinator.graduate();
        s.setRefusal(true);
        vm.prank(ALICE); vm.expectRevert(); pile.redeem(100, 0, address(s));
        assertEq(t.totalSupply(), 100); assertEq(t.balanceOf(ALICE), 100); assertEq(address(pile).balance, 1000);
        assertEq(_redeem(ALICE, 100), 1000);
    }
    function test_R11_seedReadsCannotBlockFailureAndSurplusIsNotSeederMoney() public {
        pile.loadSeed(); seed.mint(address(pile), 50);
        vm.mockCallRevert(address(seed), abi.encodeWithSignature("balanceOf(address)", address(pile)), "reads refused");
        coordinator.fail(); vm.clearMockedCalls();
        assertEq(pile.returnSeed(), 1000); assertEq(seed.balanceOf(address(this)), 1000);
        // R43-M3D/Q4: only recorded seed returns; failed unsolicited surplus has no rescue or exit.
        assertEq(seed.balanceOf(address(pile)), 50);
        _failedCall(address(pile), abi.encodeCall(pile.returnSeed, ()));
    }
    function testFuzz_R10_splitCostsAtMostOneRawUnit(uint64 seed_, uint64 supply_, uint64 part_) public {
        uint256 amount = bound(uint256(seed_), 1, type(uint64).max);
        uint256 supply = bound(uint256(supply_), 3, type(uint64).max);
        uint256 part = bound(uint256(part_), 1, (supply - 1) / 2);
        _make(8, amount, supply, address(this), false); _ready();
        uint256 splitPaid = _redeem(ALICE, part) + _redeem(ALICE, part);
        uint256 wholePaid = amount * (2 * part) / supply;
        assertLe(splitPaid, wholePaid); assertLe(wholePaid - splitPaid, 1);
        assertEq(_redeem(ALICE, supply - 2 * part), amount - splitPaid);
        assertEq(seed.balanceOf(ALICE), amount);
    }
}
