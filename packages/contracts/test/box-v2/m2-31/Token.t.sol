// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {TokenFixture, LedgerProbe, TokenCoordinator, BoxClones, BoxTokenV2Args, IBoxTokenV2, IHolderTokenHistoryV2, KitSupplyFloor} from "./Fixture.sol";
import {HolderModel} from "../m2-00/HolderModel.sol";

contract LedgerTokenTest is TokenFixture {
    function test_mintHistoryAndFrozenClone() public view {
        assertEq(address(token).code, BoxClones.runtime(implementation,
            BoxTokenV2Args.encode(address(coordinator), address(0), address(ledger), SUPPLY, "Ledger T", "LT")));
        assertEq(token.name(), "Ledger T"); assertEq(token.symbol(), "LT");
        assertEq(token.ledger(), address(ledger)); assertEq(token.totalSupply(), SUPPLY);
        assertEq(history.holderCheckpoint(), 1); assertEq(history.eligibleSupplyAt(1), 0);
        assertEq(history.eligibleBalanceAt(address(coordinator), 1), 0);
        assertEq(history.holderCount(), 0); assertEq(ledger.hints(), 1);
    }
    function test_firstReceiptSelfZeroBurnAndAllowance() public {
        give(ALICE, 100); uint256 cp = history.holderCheckpoint();
        assertEq(history.eligibleSupplyAt(cp), 100); assertEq(history.eligibleBalanceAt(ALICE, cp), 100);
        vm.startPrank(ALICE); token.transfer(ALICE, 3); token.transfer(BOB, 0); token.burn(0);
        assertEq(history.holderCheckpoint(), cp); token.approve(BOB, 30); vm.stopPrank();
        vm.prank(BOB); token.transferFrom(ALICE, BOB, 30);
        assertEq(token.allowance(ALICE, BOB), 0); assertEq(history.eligibleBalanceAt(ALICE, cp), 100);
        assertEq(history.eligibleBalanceAt(ALICE, cp + 1), 70);
        vm.prank(BOB); token.burn(10);
        assertEq(history.eligibleSupplyAt(cp + 2), 90); assertEq(token.totalBurned(), 10);
        assertEq(history.holderCount(), 2); assertEq(history.holderAt(0), ALICE); assertEq(history.holderAt(1), BOB);
        vm.prank(ALICE); token.approve(BOB, type(uint256).max);
        vm.prank(BOB); token.transferFrom(ALICE, BOB, 1);
        assertEq(token.allowance(ALICE, BOB), type(uint256).max);
    }
    function test_allSystemsExcludedAndCannotRegister() public {
        for (uint256 i; i < 24; ++i) {
            address a = coordinator.roleAddress(i);
            if (a != address(coordinator)) give(a, 1);
            vm.prank(a); vm.expectRevert(); ledger.register();
            assertEq(history.eligibleBalanceAt(a, history.holderCheckpoint()), 0);
        }
        give(PM, 10);
        vm.prank(PM); vm.expectRevert(); ledger.register();
        vm.prank(address(token)); vm.expectRevert(); ledger.register();
        vm.prank(address(0)); vm.expectRevert(); ledger.register();
        assertEq(history.eligibleSupplyAt(history.holderCheckpoint()), 0); assertEq(history.holderCount(), 0);
    }
    function test_contractRegistrationIsFutureOnlyAndCodeClassificationIsSticky() public {
        vm.etch(BOB, hex"60006000f3"); give(BOB, 20); uint256 before = history.holderCheckpoint();
        assertEq(history.eligibleBalanceAt(BOB, before), 0); assertEq(history.holderCount(), 0);
        vm.expectRevert(); history.registerHolder(BOB);
        vm.prank(BOB); ledger.register();
        assertEq(history.eligibleBalanceAt(BOB, before), 0); assertEq(history.eligibleBalanceAt(BOB, before + 1), 20);
        vm.prank(BOB); ledger.register(); assertEq(history.holderCheckpoint(), before + 1);
        give(ALICE, 10); vm.etch(ALICE, hex"60006000f3"); give(ALICE, 10);
        assertEq(history.eligibleBalanceAt(ALICE, history.holderCheckpoint()), 20);
    }
    function test_exact7702DesignationOnlyAndFirstReceiptCannotBeReclassified() public {
        vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(0xabcde))); give(ALICE, 7);
        vm.etch(BOB, abi.encodePacked(hex"600100", address(0xabcde))); give(BOB, 9);
        assertEq(history.eligibleSupplyAt(history.holderCheckpoint()), 7);
        vm.etch(BOB, hex""); give(BOB, 2);
        assertEq(history.eligibleBalanceAt(BOB, history.holderCheckpoint()), 0);
    }
    function test_hostileCallbacksAndMissedOutAndBackMatchReference() public {
        HolderModel model = new HolderModel(address(coordinator));
        give(ALICE, 100); model.move(address(coordinator), ALICE, 100, true);
        for (uint256 m = 1; m <= 3; ++m) {
            ledger.setMode(m); uint256 cp = history.holderCheckpoint(); uint256 mp = model.checkpoint();
            vm.prank(ALICE); token.transfer(BOB, 40); model.move(ALICE, BOB, 40, false);
            vm.prank(BOB); token.transfer(ALICE, 40); model.move(BOB, ALICE, 40, false);
            for (uint256 j; j < 3; ++j) {
                assertEq(history.eligibleBalanceAt(ALICE, cp + j), model.balanceAt(ALICE, mp + j));
                assertEq(history.eligibleBalanceAt(BOB, cp + j), model.balanceAt(BOB, mp + j));
            }
        }
        assertEq(ledger.hints(), 2); assertEq(history.holderCount(), 2);
    }
    function test_revertsPreserveHistoryAndImplementationIsInert() public {
        give(ALICE, 10); uint256 cp = history.holderCheckpoint();
        vm.startPrank(ALICE);
        vm.expectRevert(); token.transfer(BOB, 11);
        vm.expectRevert(); token.transfer(address(0), 1);
        vm.expectRevert(); token.transfer(address(token), 1);
        vm.expectRevert(); token.burn(11); vm.stopPrank();
        vm.expectRevert(); token.transferFrom(ALICE, BOB, 1);
        assertEq(history.holderCheckpoint(), cp); assertEq(token.balanceOf(ALICE), 10);
        vm.expectRevert(); history.eligibleSupplyAt(cp + 1);
        vm.expectRevert(); history.eligibleBalanceAt(ALICE, cp + 1);
        vm.expectRevert(); history.holderAt(1);
        vm.expectRevert(IBoxTokenV2.AlreadyInitialised.selector); token.initialize();
        vm.expectRevert(IBoxTokenV2.AlreadyInitialised.selector); IBoxTokenV2(implementation).initialize();
        assertLe(implementation.code.length, 22118);
    }
    function test_uninitializedAndStrangerClonesCannotRegisterOrMint() public {
        IBoxTokenV2 fresh = IBoxTokenV2(BoxClones.create(BoxClones.initCode(implementation,
            BoxTokenV2Args.encode(address(coordinator), address(0), address(ledger), SUPPLY, "T", "T"))));
        vm.prank(address(ledger)); vm.expectRevert(); IHolderTokenHistoryV2(address(fresh)).registerHolder(ALICE);
        vm.prank(ALICE); vm.expectRevert(); fresh.initialize();
        IBoxTokenV2 stranger = IBoxTokenV2(BoxClones.create(BoxClones.initCode(implementation,
            BoxTokenV2Args.encode(ALICE, address(0), address(ledger), SUPPLY, "T", "T"))));
        vm.prank(ALICE); vm.expectRevert(); stranger.initialize();
        assertEq(fresh.totalSupply(), 0); assertEq(stranger.totalSupply(), 0);
    }
    function test_absentLedgerDoesNoHistoryOrExternalWork() public {
        TokenCoordinator ci = new TokenCoordinator();
        address c = BoxClones.create(BoxClones.initCode(address(ci), ""));
        address impl = deployCode("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(address(ci)));
        IBoxTokenV2 plain = IBoxTokenV2(BoxClones.create(BoxClones.initCode(impl,
            BoxTokenV2Args.encode(c, address(0), address(0), SUPPLY, "T", "T"))));
        vm.prank(c); plain.initialize(); vm.prank(c); plain.transfer(ALICE, 10);
        vm.prank(ALICE); plain.burn(1);
        IHolderTokenHistoryV2 h = IHolderTokenHistoryV2(address(plain));
        assertEq(h.holderCheckpoint(), 0); assertEq(h.holderCount(), 0);
        vm.expectRevert(); h.registerHolder(ALICE);
    }
    function test_vaultPullAndFloorPreserveERC20Rules() public {
        KitSupplyFloor floor = new KitSupplyFloor(SUPPLY - 10);
        // Same implementation/args, a fresh clone with the kit's supply-floor boundary.
        IBoxTokenV2 other = IBoxTokenV2(BoxClones.create(BoxClones.initCode(implementation,
            BoxTokenV2Args.encode(address(coordinator), address(floor), address(ledger), SUPPLY, "T", "T"))));
        coordinator.wire(PM, 3, address(floor)); ledger.wire(address(other), address(this));
        vm.prank(address(coordinator)); other.initialize();
        vm.startPrank(address(coordinator));
        vm.expectRevert(); other.transfer(address(floor), 100);
        other.approve(address(floor), 100); vm.stopPrank();
        vm.prank(address(floor)); other.transferFrom(address(coordinator), address(floor), 100);
        assertEq(other.balanceOf(address(floor)), 100);
        vm.prank(address(floor)); vm.expectRevert(); other.burn(11);
        vm.prank(address(floor)); other.burn(10); assertEq(other.totalBurned(), 10);
    }
    function testFuzz_historyConservation(uint64 seed) public {
        give(ALICE, 1e18); give(BOB, 1e18);
        for (uint256 i; i < 16; ++i) {
            uint256 amount = uint256(keccak256(abi.encode(seed, i))) % (token.balanceOf(ALICE) + 1);
            vm.prank(ALICE); token.transfer(BOB, amount);
            uint256 cp = history.holderCheckpoint();
            assertEq(history.eligibleSupplyAt(cp), token.balanceOf(ALICE) + token.balanceOf(BOB));
            assertEq(history.eligibleBalanceAt(ALICE, cp), token.balanceOf(ALICE));
            assertEq(history.eligibleBalanceAt(BOB, cp), token.balanceOf(BOB));
            vm.prank(BOB); token.transfer(ALICE, amount);
            assertEq(history.eligibleBalanceAt(BOB, cp), 1e18 + amount);
        }
    }
}
