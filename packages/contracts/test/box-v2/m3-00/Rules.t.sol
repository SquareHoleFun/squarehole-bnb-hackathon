// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {FreezeRules, FailureModel} from "./FreezeRules.sol";
import {BoxType, PileParams} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ItemsDestParams} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ItemHistoryModel} from "./ItemHistoryModel.sol";

contract M300RulesTest is Test {
    FreezeRules r;
    function setUp() public { r = new FreezeRules(); }
    function test_S1_canonicalPoliciesAndSeedParams() public {
        for (uint8 policy = 1; policy <= 2; ++policy)
            assertEq(r.items(BoxType.NEW_COLLECTION,abi.encode(ItemsDestParams(policy))),policy);
        vm.expectRevert(); r.items(BoxType.NEW_COLLECTION,hex"");
        vm.expectRevert(); r.items(BoxType.NEW_COLLECTION,abi.encode(ItemsDestParams(0)));
        vm.expectRevert(); r.items(BoxType.NEW_COLLECTION,abi.encode(uint256(257)));
        vm.expectRevert(); r.items(BoxType.NEW_COLLECTION,abi.encode(uint256(1),uint256(0)));
        for (uint8 kind = 2; kind <= 5; ++kind) {
            vm.expectRevert(); r.items(BoxType(kind),abi.encode(ItemsDestParams(1)));
        }
        bytes memory data = abi.encode(PileParams(address(0),0));
        (address asset,uint256 seed) = r.pile(data,address(42),true); assertEq(asset,address(0)); assertEq(seed,0);
        vm.expectRevert(); r.pile(data,address(42),false);
        vm.expectRevert(); r.pile(abi.encode(PileParams(address(42),1)),address(42),true);
        vm.expectRevert(); r.pile(bytes.concat(data,hex"00"),address(42),true);
    }
    function test_S5_pileOnlyHClaimsClosedInventoryAndClippedK() public view {
        assertEq(r.outstanding(BoxType.PILE,1000,100,20,30,99,50,70),780);
        assertEq(r.outstanding(BoxType.SHOP,1000,100,20,30,99,50,70),830);
        assertEq(r.outstanding(BoxType.NEW_COLLECTION,1000,100,20,30,99,50,70),780);
        // A successful 20 T burn is already reflected in both supply and remaining H, never subtracted twice.
        assertEq(r.outstanding(BoxType.PILE,980,80,20,30,0,0,70),780);
    }
    function test_S2_S5_failureHeldItemsD6OnlyAndLatePotAllCauses() public {
        for (uint8 cause = 1; cause <= 3; ++cause) {
            ItemHistoryModel h = new ItemHistoryModel(4,1,2);
            h.fund(1,1,1,40); h.fund(2,1,2,60); h.fund(1,2,0,100); // D6 choice from 150 reserve
            h.fail(); assertEq(h.pot(),200); assertEq(h.itemFundingCount(),0); assertEq(h.buyBackP(),0);
            FailureModel f = new FailureModel(1000,100,150,80,cause);
            assertEq(f.pot(),1220); assertEq(f.fit(),20); assertEq(f.platform(),10);
            h.fund(1,2,0,7); assertEq(h.fit(),0); assertEq(h.pot(),207);
            f.receiverLate(7); assertEq(f.fit(),20);
            assertEq(f.claim(30),460); assertEq(f.claim(50),767); assertEq(f.pot(),0);
            f.directLate(9); assertEq(f.fit(),20); assertEq(f.pot(),9); vm.expectRevert(); f.claim(1);
        }
    }
    function test_S5_fixedNoBuyerAmountAndRetry() public {
        FailureModel f = new FailureModel(1000,100,150,0,1);
        f.directLate(17); assertEq(f.pot(),1237); assertEq(f.fit(),20);
        vm.prank(address(42)); vm.expectRevert(); f.claim(0);
        f.pause(true); vm.expectRevert(); f.claim(0); assertEq(f.pot(),1237);
        f.pause(false); assertEq(f.claim(0),1220); vm.expectRevert(); f.claim(0);
    }
    function testFuzz_S5_lastClaimNoDust(uint128 principal,uint128 held,uint64 tIn) public {
        uint256 supply = uint256(tIn)+1; FailureModel f = new FailureModel(principal,held,151,supply,2);
        uint256 total = uint256(principal)+held+121;
        uint256 paid; if (supply > 1) paid = f.claim(supply-1);
        paid += f.claim(1); assertEq(paid,total); assertEq(f.pot(),0);
        assertEq(f.fit()+f.platform()+paid,uint256(principal)+held+151);
    }
}
