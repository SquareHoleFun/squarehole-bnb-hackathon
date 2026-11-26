// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ListingsDTest} from "../cq11-d/Listings.t.sol";
import {ListingClass, IListingRegistry} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ReceiverBurnToken} from "../cq11-b/ReceiverFixture.sol";

interface BurnListing {
    function addWithBurn(address token, ListingClass class, uint256 raise, bytes4 selector) external returns (uint32);
    function checkedBurnSelector(address token) external view returns (bytes4);
}
contract BurnListingToken is ReceiverBurnToken { function decimals() external pure returns (uint8) { return 18; } }
contract EatListingsTest is ListingsDTest {
    bytes4 constant BURN = bytes4(keccak256("burn(uint256)"));
    function _token(uint8 mode) internal returns (BurnListingToken p) {
        p = new BurnListingToken(); p.mint(address(this), 100_000); p.approve(address(registry), 10_000); p.mode(mode);
    }
    function test_EAT08_checkedListingRevertsProbeButRecordsCapabilityOnce() public {
        BurnListingToken p = _token(0);
        BurnListing b = BurnListing(address(registry));
        uint32 id = b.addWithBurn(address(p), ListingClass.OTHER, 1_000_000, BURN);
        assertEq(b.checkedBurnSelector(address(p)), BURN);
        assertEq(p.totalSupply(), 100_000); assertEq(p.balanceOf(address(this)), 100_000);
        assertEq(p.balanceOf(address(registry)), 0); assertEq(p.allowance(address(this), address(registry)), 10_000);
        registry.updateRaise(id, 2_000_000); assertEq(b.checkedBurnSelector(address(p)), BURN);
        vm.expectRevert(); b.addWithBurn(address(p), ListingClass.OTHER, 1_000_000, BURN);
    }
    function test_EAT09_oldListingsAndNativeRemainUnchecked() public {
        BurnListingToken p = _token(0); registry.add(address(p), ListingClass.OTHER, 1_000_000);
        BurnListing b = BurnListing(address(registry));
        assertEq(b.checkedBurnSelector(address(p)), bytes4(0));
        assertEq(b.checkedBurnSelector(address(0)), bytes4(0));
        vm.expectRevert(); b.addWithBurn(address(p), ListingClass.OTHER, 1_000_000, BURN);
    }
    function test_EAT10_badBurnCannotBeRecordedAndOnlyListerMayAdmit() public {
        BurnListing b = BurnListing(address(registry));
        for (uint8 mode = 1; mode <= 2; ++mode) {
            BurnListingToken p = _token(mode);
            vm.expectRevert(); b.addWithBurn(address(p), ListingClass.OTHER, 1_000_000, BURN);
            (bool listed,) = registry.newestListingOf(address(p)); assertFalse(listed);
            assertEq(p.totalSupply(), 100_000);
        }
        BurnListingToken good = _token(0);
        vm.prank(address(123)); vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(123)));
        b.addWithBurn(address(good), ListingClass.OTHER, 1_000_000, BURN);
        vm.expectRevert(); b.addWithBurn(address(good), ListingClass.OTHER, 1_000_000, bytes4(0x12345678));
    }
}
