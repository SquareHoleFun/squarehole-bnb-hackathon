// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProofCoordinatorD, ProofRegistryD} from "../m1-20c/BoxTokenProof.t.sol";
import {MockBoxTokenV2} from "../kit/mocks/MockBoxTokenV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {BoxTokenProofProbe} from "../m1-20c/M1_20cHarness.sol";
import {IListingRegistry, ListingClass, ListingKind, ListingRefusal} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

contract FableListingsTest is Test {
    MockBoxTokenV2 internal impl;
    ProofCoordinatorD internal coord;
    ProofRegistryD internal own;
    ProofRegistryD internal earlier;
    ListingRegistry internal listings;
    address internal token;

    function setUp() public {
        impl = new MockBoxTokenV2();
        earlier = new ProofRegistryD(address(this), new address[](0));
        address[] memory directory = new address[](1); directory[0] = address(earlier);
        own = new ProofRegistryD(address(this), directory);
        coord = new ProofCoordinatorD(); token = coord.createToken(address(impl));
        own.record(address(coord)); coord.graduate();
        address pm = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        listings = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry", abi.encode(address(this), address(own), pm, address(0x777))));
    }
    function implementation(uint256 role) external view returns (address) { return role == 1 ? address(impl) : address(0); }
    function _refused(ListingRefusal reason) private {
        assertTrue(new BoxTokenProofProbe(address(own)).isBoxToken(token), "still an authenticated box coin");
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, reason));
        listings.add(token, ListingClass.STANDARD, 1_000_000);
        assertEq(listings.listingCount(), 1);
        (bool listed,) = listings.newestListingOf(token); assertFalse(listed);
    }

    function test_item10_graduatedReleaseTokenStillRequiresValidDecimals() public {
        vm.mockCall(token, abi.encodeWithSignature("decimals()"), abi.encode(uint256(19)));
        _refused(ListingRefusal.DECIMALS_OUT_OF_RANGE);
    }
    function test_item10_graduatedReleaseTokenStillRefusesErc777() public {
        address erc1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
        vm.etch(erc1820, hex"00");
        vm.mockCall(erc1820, abi.encodeWithSignature("getInterfaceImplementer(address,bytes32)", token, keccak256("ERC777Token")), abi.encode(address(0x777)));
        _refused(ListingRefusal.ERC777_HOOKS);
    }
    function test_item10_graduatedDirectoryCoinAtAddressCeilingIsRefused() public {
        address original = token;
        token = address(C.LISTED_TOKEN_CEILING);
        vm.etch(token, original.code);
        coord.setToken(token);
        // The directory proves full-contract coins too; no release CREATE restriction hides the ceiling defect.
        own = new ProofRegistryD(address(this), _directory());
        earlier.record(address(coord));
        address pm = listings.poolManager();
        listings = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry", abi.encode(address(this), address(own), pm, address(0x777))));
        _refused(ListingRefusal.ADDRESS_TOO_HIGH);
    }
    function _directory() private view returns (address[] memory entries) {
        entries = new address[](1); entries[0] = address(earlier);
    }
    function test_item10_validGraduatedBoxStillNeedsNoListerBalanceOrApproval() public {
        assertEq(MockBoxTokenV2(token).balanceOf(address(this)), 0);
        uint32 id = listings.add(token, ListingClass.STANDARD, 1_000_000);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.BOX_TOKEN));
        assertEq(listings.listing(id).decimals, 18);
    }
}
