// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ShopModel} from "./ShopModel.sol";
import {IShopVaultV2, IStarterSetLoaderV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";

/// @dev Test-only input representing the fixed creator's T approval, not a production shop entry.
interface SeedApprovalModel {
    function approveSeed(uint256 amount) external;
}

contract ShopModelTest is Test {
    ShopModel m;
    IShopVaultV2 vault;
    IStarterSetLoaderV2 starter;
    address constant CREATOR = address(0xC123);
    address constant KEEPER = address(0xBEEF);
    function setUp() public { newShop(100); }
    function newShop(uint256 seed) internal {
        m = new ShopModel(CREATOR, address(this), seed);
        vault = IShopVaultV2(address(m));
        starter = IStarterSetLoaderV2(address(m));
    }
    function approveSeed(uint256 amount) internal {
        vm.prank(CREATOR); SeedApprovalModel(address(m)).approveSeed(amount);
    }
    function fundSeed() internal {
        approveSeed(100);
        vm.prank(KEEPER); vault.fundSeed();
    }
    function hash(uint256 id, bytes32 next) internal pure returns (bytes32) {
        return keccak256(abi.encode(address(0x721), id, uint8(0), next));
    }
    function test_chunksAndExactStarterCommitmentBothGateOpening() public {
        fundSeed();
        vm.expectRevert(bytes("set")); starter.complete();
        m.commit(hash(1, hash(2, 0)), 2); m.chunksReady(); assertFalse(m.open());
        vm.expectRevert(bytes("set")); starter.complete();
        m.load(1, hash(2, 0)); assertFalse(m.open());
        vm.expectRevert(bytes("set")); starter.complete();
        vm.expectRevert(); m.load(3, 0);
        m.load(2, 0); assertFalse(m.open()); assertEq(m.loaded(), 2);
        vm.prank(KEEPER); starter.complete(); assertTrue(m.open());
        vm.expectRevert(); m.load(2, 0);
    }
    function test_partialFailureReturnsNFTsButQuarantinesSeedAndClaimsT() public {
        fundSeed();
        m.commit(hash(1, hash(2, 0)), 2); m.load(1, hash(2, 0)); m.addClaims(50); m.fail();
        assertEq(m.excluded(), 150); assertEq(m.returnItems(), 1); assertEq(m.returnedTo(), CREATOR);
        vm.expectRevert(); m.load(2, 0);
        assertEq(m.burn(false), 0); assertEq(m.excluded(), 150);
        assertEq(m.burn(true), 150); assertEq(m.burn(true), 0); assertEq(m.returnedT(), 0);
    }
    function test_unauthorizedLoadAndDuplicateItemsCannotComplete() public {
        m.commit(hash(1, hash(1, 0)), 2);
        vm.prank(address(0xBAD)); vm.expectRevert(); m.load(1, hash(1, 0));
        m.load(1, hash(1, 0)); vm.expectRevert(); m.load(1, 0);
        assertFalse(m.open());
    }
    function test_partialChunksDoNotPreventStarterFirstCompletion() public {
        fundSeed();
        m.commit(hash(1, 0), 1); m.load(1, 0); assertFalse(m.open());
        vm.prank(KEEPER); starter.complete(); assertFalse(m.open());
        m.chunksReady(); assertTrue(m.open());
    }
    function test_committedSeedIsNotReceivedAtConstruction() public {
        // Failure custody must count receipts, never an unfunded commitment.
        m.fail(); assertEq(m.excluded(), 0, "unfunded seed is not custody");
        assertFalse(vault.seedReady()); assertEq(vault.budgetT(), 0);
    }
    function test_exactSetAndChunksCannotCompleteBeforeApprovedSeedArrives() public {
        m.commit(hash(1, hash(2, 0)), 2); m.chunksReady();
        m.load(1, hash(2, 0)); m.load(2, 0);
        assertFalse(m.open(), "loading cannot open an unfunded shop");
        vm.expectRevert(bytes("seed")); starter.complete();
        approveSeed(100);
        assertFalse(vault.seedReady(), "approval alone is not funding");
        vm.expectRevert(bytes("seed")); starter.complete();
        vm.prank(KEEPER); vault.fundSeed();
        assertTrue(vault.seedReady()); assertEq(vault.budgetT(), 100);
        assertFalse(m.open(), "funding alone cannot notify completion");
        vm.prank(KEEPER); starter.complete(); assertTrue(m.open());
        vm.expectRevert(bytes("phase")); starter.complete();
    }
    function test_seedOnlyZeroCountAndHashCanCompleteAfterFunding() public {
        m.commit(0, 0); m.chunksReady(); assertFalse(m.open());
        vm.expectRevert(bytes("seed")); starter.complete();
        vm.expectRevert(); m.load(1, 0);
        fundSeed(); assertFalse(m.open());
        vm.prank(KEEPER); starter.complete();
        assertTrue(m.open()); assertEq(m.loaded(), 0); assertEq(vault.budgetT(), 100);
    }
    function test_zeroCountCannotHideNonzeroHash() public {
        vm.expectRevert(bytes("commit")); m.commit(hash(1, 0), 0);
        m.commit(0, 0);
        vm.expectRevert(bytes("commit")); m.commit(0, 0);
    }
    function test_zeroSeedIsReadyButStillRequiresExactSetAndCompletion() public {
        newShop(0); assertTrue(vault.seedReady()); assertEq(vault.budgetT(), 0);
        m.commit(hash(1, 0), 1); m.chunksReady();
        vm.expectRevert(bytes("set")); starter.complete();
        m.load(1, 0); assertFalse(m.open());
        vm.prank(KEEPER); starter.complete(); assertTrue(m.open());
    }
    function test_seedPullRequiresCreatorApprovalAndCreditsExactSeedOnlyOnce() public {
        vm.prank(KEEPER); vm.expectRevert(bytes("creator"));
        SeedApprovalModel(address(m)).approveSeed(100);
        approveSeed(99);
        vm.expectRevert(bytes("approval")); vault.fundSeed();
        assertFalse(vault.seedReady()); assertEq(vault.budgetT(), 0);
        approveSeed(150);
        vm.prank(KEEPER); vault.fundSeed();
        assertTrue(vault.seedReady()); assertEq(vault.budgetT(), 100);
        vm.expectRevert(bytes("phase")); vault.fundSeed();
        assertEq(vault.budgetT(), 100);
        m.fail(); assertEq(m.excluded(), 100);
    }
    function test_failureBeforeFundingRefusesLateSeedAndCompletion() public {
        m.commit(hash(1, 0), 1); m.chunksReady(); m.load(1, 0);
        approveSeed(100); m.fail(); assertEq(m.excluded(), 0);
        vm.expectRevert(bytes("phase")); vault.fundSeed();
        vm.expectRevert(bytes("phase")); starter.complete();
        vm.expectRevert(); m.chunksReady();
        assertFalse(m.open()); assertFalse(vault.seedReady()); assertEq(vault.budgetT(), 0);
    }
    function test_failurePreventsCompletionAndReopeningOfFundedShop() public {
        fundSeed(); m.commit(hash(1, 0), 1); m.load(1, 0); m.chunksReady();
        m.fail();
        vm.expectRevert(bytes("phase")); starter.complete();
        assertFalse(m.open()); assertEq(m.excluded(), 100);
    }
    function test_failedSeedOnlyShopCannotReopenAfterBurn() public {
        m.commit(0, 0); fundSeed(); starter.complete(); m.chunksReady();
        assertTrue(m.open()); m.fail(); assertEq(m.burn(true), 100);
        vm.expectRevert(bytes("phase")); starter.complete();
        vm.expectRevert(); m.chunksReady();
        vm.expectRevert(bytes("phase")); vault.fundSeed();
        assertFalse(m.open()); assertEq(m.returnedT(), 0); assertEq(m.excluded(), 0);
    }
}
