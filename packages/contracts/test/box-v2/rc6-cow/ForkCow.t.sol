// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {CowOrder, CowSignaturePayload, RoyaltyCowConfig, RoyaltyCowHash, IComposableCow, ICowSettlement} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {PinnedDrandSource} from "../../box/randomness/utils/PinnedDrandSource.sol";

interface IForkCoin {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
    function deposit() external payable;
}
struct ForkTrade {
    uint256 sellTokenIndex; uint256 buyTokenIndex; address receiver; uint256 sellAmount; uint256 buyAmount;
    uint32 validTo; bytes32 appData; uint256 feeAmount; uint256 flags; uint256 executedAmount; bytes signature;
}
struct ForkInteraction { address target; uint256 value; bytes callData; }
interface IForkSettlement is ICowSettlement {
    function authenticator() external view returns (address);
    function settle(address[] calldata tokens, uint256[] calldata prices, ForkTrade[] calldata trades,
        ForkInteraction[][3] calldata interactions) external;
}
interface IForkAuthenticator {
    function manager() external view returns (address);
    function addSolver(address solver) external;
    function isSolver(address solver) external view returns (bool);
}
interface IForkComposableOrders {
    function singleOrders(address owner, bytes32 hash) external view returns (bool);
}

/// Standalone fork runs must build the artifact used by the production-factory fixture, even without an RPC.
contract ForkCowArtifactsTest is Test {
    function test_AF1_poolManagerArtifactAvailable() public view {
        assertGt(vm.getCode("PoolManager.sol:PoolManager").length, 0);
    }
}

/// @notice Network gate: no mocks/etch of CoW, WETH, USDC or their signature/settlement paths.
/// Only SH_FORK_RPC_URL enables the fork. Uses latest mainnet unless SH_FORK_BLOCK is supplied.
contract ForkCowTest is M132aBase {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant COMPOSABLE = 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74;
    address constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    uint256 constant COUNTER_KEY = 0xC0FFEE; // deterministic test signer only

    function setUp() public override {
        string memory rpc = vm.envOr("SH_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        uint256 height = vm.envOr("SH_FORK_BLOCK", uint256(0));
        if (height == 0) vm.createSelectFork(rpc); else vm.createSelectFork(rpc, height);
        assertEq(block.chainid, 1, "mainnet RPC required");
        super.setUp();
    }
    /// Keep the fork's own block and time. A roll under Amsterdam refills EIP-2935's 8,191-block hash window from the
    /// RPC (forge asked public nodes for the hash of the fork block less 8,191, then waited on a reset connection).
    function _startClock() internal override {}
    function _releaseWeth() internal pure override returns (address) { return WETH; }
    /// Chain 1's factory admits only the pinned drand source (ReleaseMiswired(4)). Deploy it through the real
    /// deterministic deployer on this disposable fork, as anyone may on mainnet; never a live transaction.
    function _releaseRandomness() internal override returns (address) { return address(PinnedDrandSource.deploy(vm)); }
    function _royaltyConfig() internal pure override returns (RoyaltyCowConfig memory) {
        return RoyaltyCowConfig(COMPOSABLE, SETTLEMENT, 0.01 ether);
    }
    function test_mainnetComposableOrderSettlementAndRoyaltyBooking() public {
        BoxRoyaltyRouterV2 royalty = _box(false);
        vm.deal(address(royalty), 1 ether);
        vm.prank(address(royalty)); IForkCoin(WETH).deposit{value: 1 ether}();
        vm.recordLogs();
        royalty.refreshOrder();
        _registeredWithoutBroadcast(royalty, keccak256(abi.encode(royalty.orderParams())));
        (CowOrder memory order, bytes memory sig) = IComposableCow(COMPOSABLE).getTradeableOrderWithSignature(
            address(royalty), royalty.orderParams(), "", new bytes32[](0));
        assertEq(order.sellAmount, 1 ether);
        assertEq(order.receiver, address(royalty));
        assertEq(order.buyToken, USDC);
        _settle(royalty, order, sig);
        assertEq(IForkCoin(WETH).balanceOf(address(royalty)), 0);
        assertEq(IForkCoin(USDC).balanceOf(address(royalty)), 0);
        assertEq(IBoxReceiverV2(royalty.receiver()).royaltyHeldP(), 2000e6, "real P booked as royalty income");
    }
    function test_mainnetUSDCToNativePriceCoinSettlementAndBooking() public {
        BoxRoyaltyRouterV2 inbox = _box(true);
        deal(USDC, address(inbox), 2000e6);
        vm.recordLogs();
        inbox.refreshOrder(USDC);
        _registeredWithoutBroadcast(inbox, keccak256(abi.encode(inbox.orderParams(USDC))));
        (CowOrder memory order, bytes memory sig) = IComposableCow(COMPOSABLE).getTradeableOrderWithSignature(
            address(inbox), inbox.orderParams(USDC), "", new bytes32[](0));
        assertEq(order.sellAmount, 2000e6); assertEq(order.buyToken, WETH);
        _settle(inbox, order, sig);
        assertEq(IForkCoin(USDC).balanceOf(address(inbox)), 0);
        assertEq(IForkCoin(WETH).balanceOf(address(inbox)), 0);
        assertEq(IBoxReceiverV2(inbox.receiver()).royaltyHeldP(), 1 ether);
    }
    /// R1-1 (SH-V21-RC6-INT fix round): the real ComposableCoW stores the order (singleOrders) but emits nothing, so
    /// no ConditionalOrderCreated reaches CoW's own watch-tower, which relays every such order to the order book with
    /// no quote or fee check. Our poster applies CW7 and the 5% skip; anyone may still post a valid order.
    function _registeredWithoutBroadcast(BoxRoyaltyRouterV2 inbox, bytes32 params) private view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) assertTrue(logs[i].emitter != COMPOSABLE, "no ComposableCoW event");
        assertTrue(IForkComposableOrders(COMPOSABLE).singleOrders(address(inbox), params), "registered");
    }
    function _box(bool nativePrice) private returns (BoxRoyaltyRouterV2 royalty) {
        deal(USDC, address(this), 10000);
        IForkCoin(USDC).approve(address(listings), 10000);
        uint32 listing = listings.add(USDC, ListingClass.STABLE, 2000e6);
        listings.setRoyaltyLot(listing, 100e6);
        BoxSpec memory spec = _collectionSpec();
        if (!nativePrice) { spec.pricing.token = USDC; spec.pricing.listingId = listing; spec.raise = 2000e6; }
        spec.buyers.a.leg = 1; spec.buyers.a.dest = 4; spec.sellers = spec.buyers;
        spec.creatorFeeRecipient = CREATOR;
        spec.addOns = new AddOn[](1); spec.addOns[0] = AddOn(4, abi.encode(uint16(250), uint8(1)));
        deal(USDC, CREATOR, spec.raise);
        vm.prank(CREATOR); IForkCoin(USDC).approve(address(factory), spec.raise);
        BoxCoordinatorV2 box = _create(spec);
        royalty = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
    }
    function _settle(BoxRoyaltyRouterV2 royalty, CowOrder memory order, bytes memory sig) private {
        IForkSettlement settle = IForkSettlement(SETTLEMENT);
        ForkTrade[] memory trades = new ForkTrade[](2);
        trades[0] = ForkTrade(0, 1, order.receiver, order.sellAmount, order.buyAmount, order.validTo,
            order.appData, 0, 64, order.sellAmount, abi.encodePacked(address(royalty), sig)); // EIP-1271
        trades[1] = _counterTrade(order);
        address[] memory tokens = new address[](2); tokens[0] = order.sellToken; tokens[1] = order.buyToken;
        uint256[] memory prices = new uint256[](2); prices[0] = order.sellToken == WETH ? 2000e6 : 1 ether; prices[1] = order.sellAmount;
        ForkInteraction[][3] memory interactions;
        interactions[0] = new ForkInteraction[](0); interactions[1] = new ForkInteraction[](0);
        interactions[2] = new ForkInteraction[](1);
        interactions[2][0] = ForkInteraction(address(royalty), 0, abi.encodeCall(royalty.sweepPriceCoin, ()));
        address solver = _solver(settle);
        trades[0].receiver = address(0xBAD);
        // SH-V21-RC7-INT release review INBOX-2: the inbox's ERC-1271 check is what refuses, not any other revert.
        vm.prank(solver); vm.expectRevert(abi.encodeWithSelector(BoxRoyaltyRouterV2.InvalidSignature.selector));
        settle.settle(tokens, prices, trades, interactions);
        trades[0].receiver = address(royalty);
        // RC7: the real non-Safe payload is exactly the canonical encoding accepted by the inbox.
        assertEq(sig.length, 736);
        assertEq(sig, abi.encode(order, CowSignaturePayload(new bytes32[](0), royalty.orderParams(order.sellToken), "")));
        // GPv2's own recoverOrderSigner executes this ERC-1271 call; no local signature verifier substitute.
        vm.expectCall(address(royalty), abi.encodeCall(royalty.isValidSignature,
            (RoyaltyCowHash.digest(order, settle.domainSeparator()), sig)));
        vm.prank(solver); settle.settle(tokens, prices, trades, interactions);
    }
    function _counterTrade(CowOrder memory order) private returns (ForkTrade memory) {
        IForkSettlement settle = IForkSettlement(SETTLEMENT);
        address counter = vm.addr(COUNTER_KEY);
        uint256 bought = order.sellToken == WETH ? 2000e6 : 1 ether;
        deal(order.buyToken, counter, bought);
        if (order.buyToken == WETH) vm.deal(WETH, WETH.balance + bought);
        // Read the relayer first: a prank applies to the next call, and an argument's own call would take it.
        address relayer = settle.vaultRelayer();
        vm.prank(counter); IForkCoin(order.buyToken).approve(relayer, bought);
        CowOrder memory opposite = CowOrder(order.buyToken, order.sellToken, counter, bought, order.sellAmount, order.validTo,
            order.appData, 0, keccak256("sell"), false, keccak256("erc20"), keccak256("erc20"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(COUNTER_KEY, RoyaltyCowHash.digest(opposite, settle.domainSeparator()));
        return ForkTrade(1, 0, counter, opposite.sellAmount, opposite.buyAmount, opposite.validTo,
            opposite.appData, 0, 0, opposite.sellAmount, abi.encodePacked(r, s, v));
    }
    function _solver(IForkSettlement settle) private returns (address solver) {
        IForkAuthenticator auth = IForkAuthenticator(settle.authenticator());
        solver = vm.envOr("SH_COW_SOLVER", address(0x501A));
        // Authentic allow-list update on the disposable fork, never a live transaction.
        if (!auth.isSolver(solver)) { vm.prank(auth.manager()); auth.addSolver(solver); }
        assertTrue(auth.isSolver(solver));
    }
}
