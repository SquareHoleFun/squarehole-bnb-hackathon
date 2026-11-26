// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {ListingClass, ListingKind, ListingRefusal, IListingRegistry} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {MockBoxTokenV2} from "../kit/mocks/MockBoxTokenV2.sol";
import {BoxTokenProofProbe} from "./M1_20cHarness.sol";
import {BoxTokenProof} from "../../../src/box-v2/libraries/BoxTokenProof.sol";

/// @notice Only the recorded identity and graduation seam; no sampler or route exists in this fixture.
contract ProofCoordinatorD {
    address public token;
    address public hook = address(0x42);
    address public q;
    bool public graduated;
    function createToken(address impl) external returns (address t) {
        bytes memory code = BoxClones.initCode(impl, BoxTokenV2Args.encode(address(this), address(0), address(0), 1e27, "Token", "T"));
        assembly ("memory-safe") { t := create(0, add(code, 32), mload(code)) }
        token = t;
        MockBoxTokenV2(t).initialize();
    }
    function graduate() external { graduated = true; }
    function setToken(address t) external { token = t; }
}
contract ProofRegistryD {
    address public factory;
    address[] internal entries;
    address[] internal earlier;
    mapping(address => uint256) internal ids;
    constructor(address f, address[] memory e) { factory = f; earlier = e; }
    function directory() external view returns (address[] memory) { return earlier; }
    function boxCount() external view returns (uint256) { return entries.length; }
    function coordinatorOf(uint256 id) external view returns (address) { return entries[id]; }
    function boxIdOf(address c) external view returns (bool, uint256) { return (ids[c] != 0, ids[c] == 0 ? 0 : ids[c] - 1); }
    function record(address c) external { entries.push(c); ids[c] = entries.length; }
}
contract BoxTokenProofCQ11Test is Test {
    MockBoxTokenV2 internal impl;
    ProofCoordinatorD internal c;
    ProofRegistryD internal own;
    ProofRegistryD internal earlier;
    BoxTokenProofProbe internal probe;
    ListingRegistry internal listings;
    address internal token;
    function setUp() public {
        impl = new MockBoxTokenV2();
        earlier = new ProofRegistryD(address(this), new address[](0));
        address[] memory directory = new address[](1); directory[0] = address(earlier);
        own = new ProofRegistryD(address(this), directory);
        probe = new BoxTokenProofProbe(address(own));
        c = new ProofCoordinatorD(); token = c.createToken(address(impl)); own.record(address(c));
        address pm = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        listings = new ListingRegistry(address(this), address(own), pm, address(0x777));
    }
    function implementation(uint256 role) external view returns (address) { return role == 1 ? address(impl) : address(0); }
    function test_IN02_thisReleaseAndDirectoryBoxCoinsNeverEnterSellableList() public {
        c.graduate(); uint32 ownId = listings.add(token, ListingClass.STANDARD, 1_000_000);
        ProofCoordinatorD old = new ProofCoordinatorD();
        address fit = old.createToken(address(impl)); old.graduate(); earlier.record(address(old));
        uint32 fitId = listings.add(fit, ListingClass.STANDARD, 1_000_000);
        assertEq(listings.sellableLotAt(token, listings.sellableVersion()), 0);
        assertEq(listings.sellableLotAt(fit, listings.sellableVersion()), 0);
        assertEq(listings.sellableCount(listings.sellableVersion()), 1, "only WETH, neither box coin nor FIT");
        vm.expectRevert(); listings.setRoyaltyLot(ownId, 1);
        vm.expectRevert(); listings.setRoyaltyLot(fitId, 1);
    }
    function test_BC231_graduatedBoxUsesManualRaiseWithoutRouteOrHolding() public {
        assertTrue(probe.isBoxToken(token));
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.NOT_GRADUATED));
        listings.add(token, ListingClass.STANDARD, 1_000_000);
        c.graduate();
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(0xBAD)));
        listings.add(token, ListingClass.STANDARD, 1_000_000);
        uint32 id = listings.add(token, ListingClass.STANDARD, 1_000_000);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.BOX_TOKEN));
        assertEq(listings.listing(id).raise, 1_000_000);
        assertEq(MockBoxTokenV2(token).balanceOf(address(this)), 0);
        listings.updateRaise(id, 4_000_000);
        assertEq(listings.listing(id).raise, 4_000_000);
        assertEq(MockBoxTokenV2(token).totalSupply(), 1e27);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.AlreadyListed.selector, token, id));
        listings.add(token, ListingClass.STANDARD, 1_000_000);
    }
    function testFuzz_forwardAndReverseProofAgree(bool graduated) public {
        if (graduated) c.graduate();
        assertTrue(probe.isBoxToken(token));
        assertEq(probe.prove(0, 0).coordinator, address(c));
        if (!graduated) vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.NOT_GRADUATED));
        probe.proveBox(0, 0);
    }
    function test_unknownRegistryAndBoxRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.REGISTRY_UNKNOWN));
        probe.proveBox(2, 0);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.BOX_UNKNOWN));
        probe.proveBox(0, 1);
    }
    function test_BC231_wrongImplementationAndNonceTwoRefused() public {
        ProofCoordinatorD wrong = new ProofCoordinatorD();
        address t = wrong.createToken(address(new MockBoxTokenV2())); own.record(address(wrong));
        assertFalse(probe.isBoxToken(t));
        t = c.createToken(address(impl));
        assertEq(t, vm.computeCreateAddress(address(c), 2));
        assertFalse(probe.isBoxToken(t)); assertFalse(probe.isBoxToken(token));
    }
    function test_counterfeitUnrecordedAndTruncatedRuntimeRefused() public {
        ProofCoordinatorD other = new ProofCoordinatorD(); address t = other.createToken(address(impl));
        assertFalse(probe.isBoxToken(t));
        vm.etch(token, bytes.concat(token.code, hex"00"));
        assertFalse(probe.isBoxToken(token));
    }
    function test_missingReverseEntryAndWrongForwardRefused() public {
        vm.mockCall(address(own), abi.encodeWithSignature("boxIdOf(address)", address(c)), abi.encode(true, uint256(1)));
        assertFalse(probe.isBoxToken(token));
        vm.clearMockedCalls();
        vm.mockCall(address(own), abi.encodeWithSignature("coordinatorOf(uint256)", uint256(0)), abi.encode(address(0xBAD)));
        assertFalse(probe.isBoxToken(token));
    }
    function test_BC231_earlierDirectoryStillWorks() public {
        ProofCoordinatorD old = new ProofCoordinatorD(); address t = old.createToken(address(impl));
        earlier.record(address(old)); old.graduate();
        assertTrue(probe.isBoxToken(t)); assertEq(probe.proveBox(1, 0).token, t);
        assertEq(listings.add(t, ListingClass.STANDARD, 1_000_000), 1);
    }
    function testFuzz_malformedHolderNeverAuthenticates(uint8 length) public {
        length = uint8(bound(length, 0, 64));
        bytes memory reply = new bytes(length);
        vm.mockCall(token, abi.encodeWithSignature("initialHolder()"), reply);
        assertFalse(probe.isBoxToken(token));
    }
    function test_holderStipendCoversColdCloneWithMargin() public {
        vm.cool(address(impl)); vm.cool(token);
        uint256 before_ = gasleft();
        (bool ok, bytes memory answer) = token.staticcall(abi.encodeWithSignature("initialHolder()"));
        uint256 spent = before_ - gasleft();
        assertTrue(ok); assertEq(abi.decode(answer, (address)), address(c));
        emit log_named_uint("cold clone holder read incl caller overhead", spent);
        assertGe(BoxTokenProof.INITIAL_HOLDER_GAS, 2 * spent);
    }
}
