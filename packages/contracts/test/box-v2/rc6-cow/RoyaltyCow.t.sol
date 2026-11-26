// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CowOrder, CowSignaturePayload, ConditionalOrderParams, RoyaltyCowHash, ICowSettlement, IComposableCow, IConditionalOrderGenerator} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxRoyaltyRouterV2Args} from "../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {CowOffline} from "../kit/RoyaltyRelease.sol";
import {RoyaltyCustodyTest} from "../rc5-c/RoyaltyCustody.t.sol";

contract RoyaltyCowTest is RoyaltyCustodyTest {
    function test_RC6_flushWrapsAndNeverPaysTokenBoxPayee() public {
        vm.deal(address(router), 1 ether);
        router.flush();
        assertEq(PAYEE.balance, 0, "royalties are box income");
        assertEq(weth.balanceOf(address(router)), 1 ether, "wrap for CoW");
    }

    function test_RC6_nativeClaimCannotBypassThirtyDays() public {
        vm.deal(address(router), 1 ether);
        vm.prank(PAYEE);
        (bool ok,) = address(router).call(abi.encodeWithSignature("claimInKind(address)", address(0)));
        assertFalse(ok, "ETH must enter the WETH wait");
    }

    function test_RC6_publicRefreshRegistersStandingOrder() public {
        vm.deal(address(router), 1 ether);
        (bool ok,) = address(router).call(abi.encodeWithSignature("refreshOrder()"));
        assertTrue(ok, "public standing order registration");
    }

    function _fund(uint256 amount) private {
        vm.deal(address(router), amount);
        router.refreshOrder();
    }
    function _hash(CowOrder memory o) private view returns (bytes32) {
        return RoyaltyCowHash.digest(o, ICowSettlement(router.settlement()).domainSeparator());
    }
    function _signature(CowOrder memory order) private view returns (bytes memory) {
        return abi.encode(order, CowSignaturePayload(new bytes32[](0), router.orderParams(order.sellToken), ""));
    }
    function _refused(bytes32 digest) private {
        bytes memory signature = _signature(router.cowOrder());
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        router.isValidSignature(digest, signature);
    }
    function testFuzz_RC6_wholeLotsDustAndHour(uint96 raw, uint64 time) public {
        vm.warp(bound(time, 1, type(uint32).max - 7200));
        uint256 amount = bound(raw, 0.05 ether, 0.95 ether);
        _fund(amount);
        CowOrder memory o = router.cowOrder();
        assertEq(o.sellAmount, amount / router.lotSize() * router.lotSize());
        assertEq(o.validTo, (block.timestamp / 3600 + 1) * 3600);
        assertEq(router.isValidSignature(_hash(o), _signature(o)), bytes4(0x1626ba7e));
        uint256 dustRoom = router.lotSize() - amount % router.lotSize() - 1;
        weth.mint(address(router), dustRoom);
        assertEq(_hash(router.cowOrder()), _hash(o), "dust preserves auction digest");
        weth.mint(address(router), 1);
        assertEq(_hash(router.cowOrder()), _hash(o), "only approved lots until refresh");
        router.refreshOrder();
        assertEq(router.cowOrder().sellAmount, o.sellAmount + router.lotSize());
        vm.warp(o.validTo);
        _refused(_hash(o));
    }
    function testFuzz_RC6_everyForeignDigestRefused(bytes32 digest) public {
        _fund(1 ether);
        vm.assume(digest != _hash(router.cowOrder()));
        _refused(digest);
    }
    function testFuzz_RC6_everyOtherShapeRefused(uint8 field, uint256 mutation) public {
        _fund(1 ether);
        CowOrder memory o = router.cowOrder();
        field = uint8(bound(field, 0, 11));
        uint256 mask = bound(mutation, 1, type(uint160).max);
        // All twelve static words must match, including fee, balance modes, appData and partial-fill flag.
        assembly ("memory-safe") {
            let ptr := add(o, mul(field, 32))
            mstore(ptr, xor(mload(ptr), mask))
        }
        // bool ABI normalization: exercise the actual opposite bool explicitly.
        if (field == 9) o.partiallyFillable = true;
        if (field == 5 && uint32(mask) == 0) o.validTo += 1;
        _refused(_hash(o));
    }
    function test_RC6_chainDomainComesFromSettlementAndPermitsFail() public {
        _fund(1 ether);
        bytes32 original = _hash(router.cowOrder());
        vm.chainId(1);
        _refused(original);
        assertEq(router.isValidSignature(_hash(router.cowOrder()), _signature(router.cowOrder())), bytes4(0x1626ba7e));
        vm.chainId(11155111);
        assertEq(router.isValidSignature(_hash(router.cowOrder()), _signature(router.cowOrder())), bytes4(0x1626ba7e));
        _refused(keccak256(abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            address(router), address(this), type(uint256).max, uint256(0), block.timestamp + 1 days)));
    }
    function test_RC6_zeroLotsNoOrderAndOneRegistration() public {
        vm.deal(address(router), 0.05 ether - 1);
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector); router.refreshOrder();
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector); router.cowOrder();
        assertEq(CowOffline(router.composableCow()).registrations(address(router)), 0);
        weth.mint(address(router), 1);
        router.refreshOrder();
        (CowOrder memory o,) = IComposableCow(router.composableCow()).getTradeableOrderWithSignature(
            address(router), router.orderParams(), "", new bytes32[](0));
        assertEq(o.sellAmount, 0.05 ether);
        router.refreshOrder();
        assertEq(CowOffline(router.composableCow()).registrations(address(router)), 1);
        address handler = router.cowHandler();
        vm.expectRevert(); IConditionalOrderGenerator(handler).getTradeableOrder(
            address(router), address(this), bytes32(0), hex"01", "");
    }
    function testFuzz_RC6_exitWaitCannotBeShortened(uint32 elapsed) public {
        _fund(1 ether);
        uint256 start = router.oldestUnsoldAt();
        elapsed = uint32(bound(elapsed, 0, 30 days - 1));
        vm.warp(start + elapsed);
        vm.prank(PAYEE); vm.expectRevert(BoxRoyaltyRouterV2.WaitForSale.selector);
        router.claimInKind(address(weth));
        weth.mint(address(router), 1);
        router.refreshOrder();
        assertEq(router.oldestUnsoldAt(), start, "dust cannot postpone oldest lot");
        vm.warp(start + 30 days);
        vm.prank(PAYEE); router.claimInKind(address(weth));
        assertEq(weth.balanceOf(PAYEE), 1 ether + 1);
        assertEq(router.oldestUnsoldAt(), 0);
        assertEq(weth.allowance(address(router), router.vaultRelayer()), 0);
    }
    function test_RC6_saleThenUnobservedZeroAndDepositRestartsClock() public {
        _fund(1 ether);
        vm.warp(block.timestamp + 30 days);
        // Exact whole-lot sale spends the capped approval, witnessing zero without a callback/keeper.
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 1 ether);
        weth.mint(address(router), 1 ether);
        vm.prank(PAYEE); vm.expectRevert(BoxRoyaltyRouterV2.WaitForSale.selector);
        router.claimInKind(address(weth));
        router.refreshOrder();
        assertEq(router.oldestUnsoldAt(), block.timestamp);
    }
    function test_RC6_failureDisablesSignatureAndAllowsImmediateInKind() public {
        _fund(1 ether);
        bytes32 digest = _hash(router.cowOrder());
        bytes memory signature = _signature(router.cowOrder());
        vm.mockCall(address(0xC0), abi.encodeWithSignature("failed()"), abi.encode(true));
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector);
        router.isValidSignature(digest, signature);
        router.refreshOrder();
        assertEq(weth.allowance(address(router), router.vaultRelayer()), 0);
        vm.prank(PAYEE); router.claimInKind(address(weth));
        assertEq(weth.balanceOf(PAYEE), 1 ether);
    }
    function test_RC6_saleLeavingObservedDustKeepsClock() public {
        _fund(1 ether + 1);
        uint256 start = router.oldestUnsoldAt();
        vm.warp(block.timestamp + 1 days);
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 1 ether);
        router.refreshOrder();
        assertEq(router.oldestUnsoldAt(), start, "already-observed residual dust keeps its clock");
    }
}
