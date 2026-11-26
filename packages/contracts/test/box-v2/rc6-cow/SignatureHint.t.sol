// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FactoryLife} from "../kit/FactoryLife.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {CowOrder, ConditionalOrderParams, RoyaltyCowHash, ICowSettlement} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";

/// @notice RC7 keeps the rc6 cold-account comparison and removes the signature-hint fallback.
/// Only the canonical payload verifies, independently of previously registered and sold coins.
contract SignatureHintTest is FactoryLife {
    /// ComposableCoW's PayloadStruct, kept here independently of the inbox's own copy.
    struct Payload { bytes32[] proof; ConditionalOrderParams params; bytes offchainInput; }
    address private constant STRANGER = address(0xBAD);

    function _listN(uint256 n) private returns (HostileToken[] memory coins) {
        coins = new HostileToken[](n);
        uint256 raise = listings.listing(0).raise;
        for (uint256 i; i < n; ++i) {
            HostileToken c = new HostileToken("Coin", "C", 18);
            c.mint(address(this), 10_000);
            c.approve(address(listings), 10_000);
            listings.add(address(c), ListingClass.OTHER, raise);
            coins[i] = c;
        }
    }

    function _signed(BoxRoyaltyRouterV2 inbox, address coin) private view returns (bytes32 digest, bytes memory payload) {
        CowOrder memory o = inbox.cowOrder(coin);
        digest = RoyaltyCowHash.digest(o, ICowSettlement(inbox.settlement()).domainSeparator());
        payload = abi.encode(o, Payload(new bytes32[](0), inbox.orderParams(coin), ""));
    }

    /// Cold accounts, as a settlement's first touch of the inbox sees them.
    function _validate(BoxRoyaltyRouterV2 inbox, HostileToken[] memory coins, bytes32 digest, bytes memory signature)
        private returns (uint256 used)
    {
        vm.cool(address(inbox)); vm.cool(release.implementations[8]); vm.cool(address(box)); vm.cool(release.implementations[0]);
        vm.cool(address(listings)); vm.cool(address(registry)); vm.cool(inbox.settlement()); vm.cool(inbox.weth());
        for (uint256 i; i < coins.length; ++i) vm.cool(address(coins[i]));
        uint256 g = gasleft();
        bytes4 magic = inbox.isValidSignature(digest, signature);
        used = g - gasleft();
        assertEq(magic, bytes4(0x1626ba7e));
    }

    function _reject(BoxRoyaltyRouterV2 inbox, HostileToken[] memory coins, bytes32 digest, bytes memory signature)
        private returns (uint256 used)
    {
        vm.cool(address(inbox)); vm.cool(release.implementations[8]); vm.cool(address(box)); vm.cool(release.implementations[0]);
        vm.cool(address(listings)); vm.cool(address(registry)); vm.cool(inbox.settlement()); vm.cool(inbox.weth());
        for (uint256 i; i < coins.length; ++i) vm.cool(address(coins[i]));
        uint256 g = gasleft();
        (bool ok, bytes memory result) = address(inbox).staticcall(abi.encodeCall(inbox.isValidSignature, (digest, signature)));
        used = g - gasleft();
        assertFalse(ok);
        assertEq(result, abi.encodeWithSelector(BoxRoyaltyRouterV2.InvalidSignature.selector));
    }

    function _box(uint256 n) private returns (BoxRoyaltyRouterV2 inbox, HostileToken[] memory coins, HostileToken income) {
        coins = _listN(n);
        _start(_spec());
        inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        income = coins[n - 1];
        income.mint(address(inbox), 3 ether);
    }

    function test_SH1_payloadValidationCostIsIndependentOfStrangerRegistrations() public {
        (BoxRoyaltyRouterV2 inbox, HostileToken[] memory coins, HostileToken income) = _box(20);
        uint256 snap = vm.snapshotState();
        inbox.refreshOrder(address(income));
        (bytes32 digest, bytes memory payload) = _signed(inbox, address(income));
        uint256 alone = _validate(inbox, coins, digest, payload);
        vm.revertToState(snap);
        vm.startPrank(STRANGER);
        for (uint256 i; i + 1 < coins.length; ++i) {
            coins[i].mint(address(inbox), 1 ether);
            inbox.refreshOrder(address(coins[i]));
            vm.stopPrank(); vm.prank(inbox.vaultRelayer());
            coins[i].transferFrom(address(inbox), STRANGER, 1 ether);
            vm.startPrank(STRANGER);
        }
        vm.stopPrank();
        for (uint256 i; i + 1 < coins.length; ++i) assertTrue(inbox.orderRegistered(address(coins[i])), "a previously funded coin stays registered");
        inbox.refreshOrder(address(income));
        (digest, payload) = _signed(inbox, address(income));
        vm.record();
        uint256 griefed = _validate(inbox, coins, digest, payload);
        for (uint256 i; i + 1 < coins.length; ++i) {
            (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(coins[i]));
            assertEq(reads.length, 0, "validation never reads another coin");
            assertEq(writes.length, 0);
        }
        bytes memory refused = bytes.concat(payload);
        refused[refused.length - 1] ^= bytes1(uint8(1));
        uint256 rejected = _reject(inbox, coins, digest, refused);
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(digest, "");
        emit log_named_uint("payload, income coin registered alone", alone);
        emit log_named_uint("payload, 19 sold coins registered first", griefed);
        emit log_named_uint("refused 736-byte payload", rejected);
        assertLe(griefed, alone + 1_000, "nineteen stranger registrations cost a ComposableCoW signature nothing");
    }

    function test_SH2_noncanonicalPayloadsGrantNoAuthority() public {
        (BoxRoyaltyRouterV2 inbox, HostileToken[] memory coins, HostileToken income) = _box(3);
        coins[0].mint(address(inbox), 1 ether);
        inbox.refreshOrder(address(coins[0]));
        inbox.refreshOrder(address(income));
        (bytes32 digest, bytes memory payload) = _signed(inbox, address(income));
        CowOrder memory o = inbox.cowOrder(address(income));
        // Another registered coin, an unregistered or unlisted one, or bytes of no payload shape: all refused.
        address[3] memory named = [address(coins[0]), address(coins[1]), address(0xDEAD)];
        for (uint256 i; i < named.length; ++i) {
            bytes memory other = abi.encode(o, Payload(new bytes32[](0), inbox.orderParams(named[i]), ""));
            vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
            inbox.isValidSignature(digest, other);
        }
        address weth = inbox.weth();
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(digest, abi.encode(weth));
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(digest, hex"abcdef");
        // The canonical bytes cannot validate any other digest.
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(bytes32(uint256(digest) ^ 1), payload);
        bytes32 permit = keccak256(abi.encodePacked(hex"1901", ICowSettlement(inbox.settlement()).domainSeparator(),
            keccak256(abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            address(inbox), address(this), type(uint256).max, 0, block.timestamp))));
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(permit, payload);
        // Capture a current payload immediately before failure, so the hour does not explain refusal.
        vm.warp(box.deadline());
        (digest, payload) = _signed(inbox, address(income));
        assertEq(inbox.isValidSignature(digest, payload), bytes4(0x1626ba7e));
        box.fail();
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(digest, payload);
    }
}
