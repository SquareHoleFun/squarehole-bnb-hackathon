// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "src/box/libraries/BoxClones.sol";
import {ItemLedgerV2} from "src/box-v2/ItemLedgerV2.sol";
import {ItemCoordinatorDouble, JournalDouble} from "test/box-v2/m3-20/Fixture.sol";
import {HostileToken} from "test/box-v2/kit/HostileToken.sol";
import {PileIntegrationFixture} from "test/box-v2/m3-30/IntegrationFixture.sol";
import {SweepFixture, IBoxCoordinatorV2} from "test/box-v2/r40a/SweepFixture.sol";

/// @notice Keeper transport against the implemented ledger and real PM; S2/S3 journals are local doubles.
contract KeeperItemCallsTest is Test {
    IPoolManager internal pm;
    JournalDouble internal j;
    ItemLedgerV2 internal ledger;
    HostileToken internal token;
    address internal price;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant KEEPER = address(0xCA11);
    address internal constant DEPTH = address(0xD3);

    function setUp() public {
        _make(address(0));
    }

    function _make(address p) internal {
        price = p;
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        address ci = address(new ItemCoordinatorDouble());
        ItemCoordinatorDouble c = ItemCoordinatorDouble(BoxClones.create(BoxClones.initCode(ci, "")));
        j = new JournalDouble(pm, 4, 1, 2);
        address implementation = deployCode("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(pm, ci));
        ledger = ItemLedgerV2(
            BoxClones.create(
                BoxClones.initCode(
                    implementation,
                    abi.encodePacked(
                        address(c),
                        address(j),
                        address(j),
                        address(j),
                        address(j),
                        DEPTH,
                        p,
                        uint8(1),
                        uint8(2),
                        uint256(0),
                        uint256(0)
                    )
                )
            )
        );
        c.configure(address(pm), address(j), DEPTH, address(ledger));
        c.setPrice(p);
        j.wire(address(c), address(ledger), 1);
        j.setPrice(p);
        vm.etch(DEPTH, hex"00");
        if (p == address(0)) vm.deal(address(j), type(uint128).max);
        else HostileToken(p).mint(address(j), type(uint128).max);
        c.initializeLedger();
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _credit(uint256 id) internal view returns (uint256) {
        (uint256 outsideP, uint256 stashP) = ledger.itemCredit(id);
        return outsideP + stashP;
    }

    function test_syncResidueAndCurrentContractOwnerConserveEveryUnit() public {
        token = new HostileToken("Price", "P", 6);
        _make(address(token));
        j.graduate();
        j.pick(1, ALICE);
        j.fund(1, 2, 0, 407);
        vm.cool(address(ledger));
        vm.cool(address(j));
        vm.cool(address(pm));
        uint256 start = gasleft();
        vm.prank(KEEPER);
        ledger.sync{gas: 3_000_000}(8);
        emit log_named_uint("item sync cold call gas", start - gasleft());
        assertEq(ledger.fundingCursor(), j.itemFundingCount());
        assertEq(ledger.lifecycleCursor(), j.itemLifecycleCount());
        assertEq(_credit(1), 101);
        // Real proven residue only; 303 hidden stash and 101 outside credit remain backed.
        vm.cool(address(ledger));
        vm.cool(address(pm));
        start = gasleft();
        vm.prank(KEEPER);
        assertEq(ledger.flushResidue{gas: 350_000}(), 3);
        emit log_named_uint("item residue cold call gas", start - gasleft());
        assertEq(ledger.flushResidue(), 0);
        assertEq(pm.balanceOf(address(ledger), uint160(price)), 404);
        vm.expectRevert();
        vm.prank(KEEPER);
        ledger.claim(_ids(1), KEEPER);
        j.move(1, BOB);
        vm.expectRevert();
        vm.prank(ALICE);
        ledger.claim(_ids(1), ALICE);
        vm.etch(BOB, hex"00"); // ordinary contract owners use the same owner entry
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 101);
        assertEq(token.balanceOf(KEEPER), 0);
        assertEq(token.balanceOf(ALICE), 0);
        assertEq(token.balanceOf(BOB), 101);
        assertEq(pm.balanceOf(address(ledger), uint160(price)) + pm.balanceOf(DEPTH, uint160(price)) + 101, 407);
    }

    function test_eightReceiptPageAndLifecycleOnlyRecoveryKeepPendingLiabilities() public {
        j.graduate();
        ledger.sync(8);
        for (uint256 i; i < 9; ++i) {
            j.fund(1, 2, 0, 7);
        }
        uint256 beforeCursor = ledger.fundingCursor();
        vm.cool(address(ledger));
        vm.cool(address(j));
        uint256 start = gasleft();
        ledger.sync{gas: 3_000_000}(8);
        emit log_named_uint("eight receipts call gas", start - gasleft());
        assertEq(ledger.fundingCursor(), beforeCursor + 8);
        assertEq(ledger.flushResidue{gas: 350_000}(), 24);
        assertEq(pm.balanceOf(address(ledger), 0), 39, "stash plus pending receipt");
        ledger.sync(8);
        assertEq(ledger.flushResidue(), 3);
        for (uint256 i; i < 5; ++i) {
            j.pick(1, ALICE);
            j.back(1);
        }
        uint256 f = ledger.fundingCursor();
        start = gasleft();
        ledger.sync{gas: 3_000_000}(8);
        emit log_named_uint("eight lifecycle records call gas", start - gasleft());
        assertEq(ledger.lifecycleCursor(), 8);
        assertEq(ledger.fundingCursor(), f);
        ledger.sync(8);
        assertEq(ledger.lifecycleCursor(), 10);
        assertEq(pm.balanceOf(address(ledger), 0) + pm.balanceOf(DEPTH, 0), 63);
    }
}

/// @notice Actual pile, token, coordinator starter gate and PM. The inherited nonce-alias double is M3-32's seam.
contract KeeperPileCallsTest is PileIntegrationFixture {
    function test_exactLoadGateRollbackAndPausedReturnRetryOnlyPaySeeder() public {
        _make(false, false, SEED, false, 0);
        router.setRefuseOpen(true);
        vm.expectRevert();
        vm.prank(BOB);
        pile.loadSeed{gas: 1_000_000}();
        assertEq(seedToken.balanceOf(CREATOR), SEED);
        assertEq(seedToken.allowance(CREATOR, address(pile)), SEED);
        assertTrue(box.starterSetPending());
        router.setRefuseOpen(false);
        vm.cool(address(pile));
        vm.cool(address(seedToken));
        vm.cool(address(box));
        uint256 start = gasleft();
        vm.prank(BOB);
        pile.loadSeed{gas: 1_000_000}();
        emit log_named_uint("pile load with starter gate call gas", start - gasleft());
        assertTrue(box.gateOpen());
        assertFalse(box.starterSetPending());
        assertEq(seedToken.balanceOf(BOB), 0);
        assertEq(seedToken.balanceOf(CREATOR), 0);
        assertEq(seedToken.balanceOf(address(pile)), SEED);
        seedToken.setPaused(true);
        vm.warp(box.deadline());
        box.fail();
        vm.expectRevert();
        pile.returnSeed{gas: 500_000}();
        assertEq(seedToken.balanceOf(address(pile)), SEED);
        seedToken.setPaused(false);
        vm.cool(address(pile));
        vm.cool(address(seedToken));
        start = gasleft();
        vm.prank(BOB);
        assertEq(pile.returnSeed{gas: 500_000}(), SEED);
        emit log_named_uint("pile return cold call gas", start - gasleft());
        assertEq(seedToken.balanceOf(CREATOR), SEED);
        assertEq(seedToken.balanceOf(BOB), 0);
        assertEq(seedToken.balanceOf(address(pile)), 0);
        vm.expectRevert();
        pile.returnSeed();
    }

    function test_nativeLoadRequiresSeederButReturnNeedsNoKeeperValue() public {
        _make(true, false, SEED, false, 0);
        vm.expectRevert();
        vm.prank(BOB);
        pile.loadSeed();
        _load();
        vm.warp(box.deadline());
        box.fail();
        vm.prank(BOB);
        assertEq(pile.returnSeed{gas: 500_000}(), SEED);
        assertEq(CREATOR.balance, SEED);
        assertEq(BOB.balance, 0);
        assertEq(address(pile).balance, 0);
    }
}

/// @notice RC5 keeper may collect late receiver P, but cannot sweep anyone's failure entitlement.
contract KeeperPermanentClaimsTest is SweepFixture {
    function test_yearBoundaryAndLateReceiptsPreserveFixedCountWithoutSafePayout() public {
        _fail(101, 100); _retainedAtYear(101);
        _fund(p, address(fees), 7);
        assertEq(fees.collect(BOB).buyersP, 7);
        assertEq(fees.fitOwed(), 0); assertEq(_balance(BOB), 0);
        assertEq(_left(), 100); assertEq(_pot(), 108);
        _assertClaimsOpen(ALICE, 100);
    }
    function test_emptyPotRemainsClaimableBeyondYear() public {
        _fail(0, 100); _retainedAtYear(0);
        _assertClaimsOpen(ALICE, 100);
        assertEq(_claim(ALICE, 100, BOB), 0);
    }
}
