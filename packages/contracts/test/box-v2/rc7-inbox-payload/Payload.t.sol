// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FactoryLife} from "../kit/FactoryLife.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {CowOrder, ConditionalOrderParams, CowSignaturePayload, RoyaltyCowHash, ICowSettlement, IComposableCow} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";

/// SH-RC7-INBOX-PAYLOAD: only the current non-Safe ComposableCoW bytes authorize a settlement.
contract InboxPayloadTest is FactoryLife {
    BoxRoyaltyRouterV2 private inbox;
    HostileToken private second;
    HostileToken private unregistered;
    address private weth;

    function setUp() public override {
        super.setUp();
        second = _list();
        unregistered = _list();
        (BoxSpec memory s,) = _priceSpec(1, 2, 6);
        _start(s);
        inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        weth = inbox.weth();
        vm.deal(address(inbox), 0.15 ether);
        inbox.refreshOrder(weth);
        second.mint(address(inbox), 3 ether);
        inbox.refreshOrder(address(second));
    }

    function _list() private returns (HostileToken coin) {
        coin = new HostileToken("Income", "INC", 18);
        coin.mint(address(this), 10_000);
        coin.approve(address(listings), 10_000);
        listings.add(address(coin), ListingClass.OTHER, listings.listing(0).raise);
    }

    function _payload(CowOrder memory order) private view returns (bytes memory) {
        return abi.encode(order, CowSignaturePayload(new bytes32[](0), inbox.orderParams(order.sellToken), ""));
    }

    function _digest(CowOrder memory order) private view returns (bytes32) {
        return RoyaltyCowHash.digest(order, ICowSettlement(inbox.settlement()).domainSeparator());
    }

    function _refused(bytes32 digest, bytes memory signature) private {
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        inbox.isValidSignature(digest, signature);
    }

    function test_P01_standinReturnsCanonicalWethAndSecondCoinPayloads() public view {
        address[2] memory coins = [weth, address(second)];
        for (uint256 i; i < coins.length; ++i) {
            (CowOrder memory order, bytes memory signature) = IComposableCow(inbox.composableCow())
                .getTradeableOrderWithSignature(address(inbox), inbox.orderParams(coins[i]), "", new bytes32[](0));
            assertEq(signature.length, 736);
            assertEq(signature, _payload(order));
            assertEq(inbox.isValidSignature(_digest(order), signature), bytes4(0x1626ba7e));
        }
    }

    function test_P02_emptyBytesRefused() public { _refused(_digest(inbox.cowOrder(weth)), ""); }
    function test_P02_addressBytesRefused() public { _refused(_digest(inbox.cowOrder(weth)), abi.encode(weth)); }
    function test_P02_randomBytesRefused() public { _refused(_digest(inbox.cowOrder(weth)), hex"abcdef"); }

    function testFuzz_P03_everyByteMatters(uint16 index, uint8 mask) public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        index = uint16(bound(index, 0, signature.length - 1));
        mask = uint8(bound(mask, 1, 255));
        signature[index] ^= bytes1(mask);
        _refused(_digest(order), signature);
    }

    function test_P03_oneByteLongerRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        _refused(_digest(order), bytes.concat(_payload(order), hex"00"));
    }

    function test_P03_oneByteShorterRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        assembly ("memory-safe") { mstore(signature, 735) }
        _refused(_digest(order), signature);
    }

    function test_P04_ownerPrefixRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        _refused(_digest(order), abi.encodePacked(address(inbox), _payload(order)));
    }

    function test_P04_equivalentValuesWithOtherOffsetsRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        // Empty proof and empty offchainInput tails have identical words. Swap their offsets without changing
        // either decoded value or the total length: a decoder accepts this, the canonical-byte check must not.
        assembly ("memory-safe") {
            let payload := add(add(signature, 32), mload(add(signature, 416)))
            let proofOffset := mload(payload)
            mstore(payload, mload(add(payload, 64)))
            mstore(add(payload, 64), proofOffset)
        }
        (CowOrder memory decoded, CowSignaturePayload memory payload) = abi.decode(signature, (CowOrder, CowSignaturePayload));
        assertEq(signature.length, 736);
        assertEq(abi.encode(decoded), abi.encode(order));
        assertEq(abi.encode(payload), abi.encode(CowSignaturePayload(new bytes32[](0), inbox.orderParams(weth), "")));
        assertTrue(keccak256(signature) != keccak256(_payload(order)));
        _refused(_digest(order), signature);
    }

    function test_P04_nonemptyProofRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes32[] memory proof = new bytes32[](1); proof[0] = keccak256("proof");
        _refused(_digest(order), abi.encode(order, CowSignaturePayload(proof, inbox.orderParams(weth), "")));
    }

    function test_P04_nonemptyOffchainInputRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        _refused(_digest(order), abi.encode(order, CowSignaturePayload(new bytes32[](0), inbox.orderParams(weth), hex"01")));
    }

    function test_P04_otherSaltRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        ConditionalOrderParams memory params = inbox.orderParams(weth); params.salt = bytes32(uint256(1));
        _refused(_digest(order), abi.encode(order, CowSignaturePayload(new bytes32[](0), params, "")));
    }

    function test_P04_otherHandlerRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        ConditionalOrderParams memory params = inbox.orderParams(weth); params.handler = address(0xBAD);
        _refused(_digest(order), abi.encode(order, CowSignaturePayload(new bytes32[](0), params, "")));
    }

    function test_P04_safeFormRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes32 domain = ICowSettlement(inbox.settlement()).domainSeparator();
        bytes32 typeHash = keccak256("Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)");
        bytes memory signature = abi.encodeWithSignature("safeSignature(bytes32,bytes32,bytes,bytes)", domain,
            typeHash, abi.encode(order), abi.encode(CowSignaturePayload(new bytes32[](0), inbox.orderParams(weth), "")));
        _refused(_digest(order), signature);
    }

    function test_P05_otherRegisteredCoinPayloadRefused() public {
        _refused(_digest(inbox.cowOrder(weth)), _payload(inbox.cowOrder(address(second))));
    }

    function test_P05_unregisteredAndUnlistedCoinPayloadsRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes32 digest = _digest(order);
        order.sellToken = address(unregistered);
        _refused(digest, _payload(order));
        _refused(_digest(order), _payload(order));
        order.sellToken = address(0xDEAD);
        _refused(digest, _payload(order));
        _refused(_digest(order), _payload(order));
    }

    function testFuzz_P06_otherDigestRefused(bytes32 digest) public {
        CowOrder memory order = inbox.cowOrder(weth);
        vm.assume(digest != _digest(order));
        _refused(digest, _payload(order));
    }

    function test_P06_permitDigestsRefused() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes32[3] memory shapes = [
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            keccak256("Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)"),
            keccak256("PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)")
        ];
        for (uint256 i; i < shapes.length; ++i) {
            bytes32 digest = keccak256(abi.encodePacked(hex"1901", ICowSettlement(inbox.settlement()).domainSeparator(),
                keccak256(abi.encode(shapes[i], address(inbox), address(this), type(uint256).max, 0, block.timestamp))));
            _refused(digest, _payload(order));
        }
    }

    function test_P07_expiredPayloadRefusedEvenWithCurrentDigest() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        vm.warp(order.validTo);
        _refused(_digest(order), signature);
        _refused(_digest(inbox.cowOrder(weth)), signature);
    }

    function test_P07_resizedPayloadRefusedEvenWithCurrentDigest() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        vm.deal(address(inbox), inbox.lotSize(weth)); inbox.refreshOrder(weth);
        assertGt(inbox.cowOrder(weth).sellAmount, order.sellAmount);
        _refused(_digest(order), signature);
        _refused(_digest(inbox.cowOrder(weth)), signature);
    }

    function testFuzz_P08_failedBoxRefusesEveryDigest(bytes32 digest) public {
        // Capture in the same hour as fail(): expiration must not explain the refusal.
        vm.warp(box.deadline());
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        assertEq(inbox.isValidSignature(_digest(order), signature), bytes4(0x1626ba7e));
        box.fail(); assertTrue(box.failed());
        _refused(_digest(order), signature);
        _refused(digest, signature);
    }

    function test_P08_noWholeLotRefusesPayload() public {
        CowOrder memory order = inbox.cowOrder(weth);
        bytes memory signature = _payload(order);
        vm.prank(inbox.vaultRelayer());
        HostileToken(weth).transferFrom(address(inbox), address(this), order.sellAmount);
        _refused(_digest(order), signature);
    }

    function test_P09_unreadableBalanceIsIsolated() public { _unreadable(false); }
    function test_P09_unreadableAllowanceIsIsolated() public { _unreadable(true); }

    function _unreadable(bool allowance) private {
        CowOrder memory order = inbox.cowOrder(address(second));
        bytes memory signature = _payload(order);
        CowOrder memory good = inbox.cowOrder(weth);
        bytes memory goodSignature = _payload(good);
        bytes memory read = allowance
            ? abi.encodeCall(second.allowance, (address(inbox), inbox.vaultRelayer()))
            : abi.encodeCall(second.balanceOf, (address(inbox)));
        vm.mockCallRevert(address(second), read, hex"deadbeef");
        _refused(_digest(order), signature);
        assertEq(inbox.isValidSignature(_digest(good), goodSignature), bytes4(0x1626ba7e));
    }

    function test_P10_keeperApprovalStorageSlot() public {
        address[2] memory coins = [weth, address(second)];
        for (uint256 i; i < coins.length; ++i) {
            bytes32 slot = bytes32(uint256(keccak256(abi.encode(coins[i], uint256(0)))) + 3);
            uint256 approved = inbox.cowOrder(coins[i]).sellAmount;
            uint256 lot = inbox.lotSize(coins[i]);
            assertEq(uint256(vm.load(address(inbox), slot)), approved, "keeper reads CoinState.approved at mapping slot 0 + 3");
            vm.prank(inbox.vaultRelayer());
            HostileToken(coins[i]).transferFrom(address(inbox), address(this), lot);
            assertEq(uint256(vm.load(address(inbox), slot)), approved, "stored approval waits for observation");
            inbox.observe(coins[i]);
            assertEq(uint256(vm.load(address(inbox), slot)), approved - inbox.lotSize(coins[i]));
        }
    }

    function test_P11_firstRegistrationRefreshGas() public {
        _start(_spec());
        inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        unregistered.mint(address(inbox), 3 ether);
        address coin = address(unregistered);
        vm.cool(address(inbox)); vm.cool(release.implementations[8]); vm.cool(address(box)); vm.cool(release.implementations[0]);
        vm.cool(address(listings)); vm.cool(address(registry)); vm.cool(inbox.composableCow()); vm.cool(coin);
        uint256 before_ = gasleft();
        inbox.refreshOrder(coin);
        emit log_named_uint("first registration refreshOrder", before_ - gasleft());
        assertTrue(inbox.orderRegistered(coin));
    }
}
