// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../../test/box-v2/kit/RoyaltyRelease.sol";
import {M361ItemLife} from "../../test/box-v2/property/m3/ItemLifeHarness.sol";
import {M234DeploymentHarness} from "../../test/box-v2/m2-34/Deployment.t.sol";
import {WBox0Read} from "../../test/box-v2/m1-64/CQ11WDeployment.t.sol";
import {CoreV2Deployment} from "./CoreV2Deployment.sol";
import {BoxRegistryV2} from "../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../src/box-v2/ListingRegistry.sol";
import {RoyaltyWeth} from "../../test/box-v2/cq11-c/RoyaltyRouter.t.sol";
import {MockDrandSource} from "../../test/box/items/BoxItemsKit.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LifeCustody} from "../../test/box-v2/kit/FactoryLife.sol";
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {IItemLedgerV2} from "../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {HostileToken} from "../../test/box-v2/kit/HostileToken.sol";
import {PileVaultV2} from "../../src/box-v2/PileVaultV2.sol";

/// @notice Test contract owner: the controller alone asks it to claim its own item to a chosen recipient.
contract RehearsalItemOwner {
    address public immutable controller = msg.sender;

    function claim(IItemLedgerV2 ledger, uint256 id, address to) external returns (uint256) {
        require(msg.sender == controller, "controller");
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return ledger.claim(ids, to);
    }

    function transferItem(BoxCollectionV2 collection, uint256 id, address to) external {
        require(msg.sender == controller, "controller");
        collection.transferFrom(address(this), to, id);
    }
}

/// @notice Offline extended lives reuse the frozen model but replace its historic M3 admission doubles
/// with the production deploy recipe. Only token assets, randomness and Safe custody are local doubles.
contract SepoliaExtendedRehearsal is M361ItemLife {
    function setUp() public override {
        vm.warp(1_790_000_000);
        vm.roll(100);
        vm.deal(CREATOR, 1000 ether);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(DEPLOYER)));
        address w = address(new RoyaltyWeth());
        fitSafe = address(new LifeCustody());
        conversionSafe = address(new LifeCustody());
        address source = address(new MockDrandSource());
        WBox0Read genesis = new WBox0Read(address(this), address(pm), source, w, fitSafe);
        CoreV2Deployment.Config memory c = CoreV2Deployment.Config(
            DEPLOYER, address(pm), w, source, address(genesis), fitSafe, address(this), RoyaltyRelease.config());
        (factory,) = new M234DeploymentHarness().simulate(c, address(genesis));
        planner = factory.planner();
        registry = BoxRegistryV2(factory.registry());
        listings = ListingRegistry(factory.listingRegistry());
        release.factory = address(factory);
        release.registry = address(registry);
        release.listingRegistry = address(listings);
        release.poolManager = address(pm);
        release.weth = w;
        release.randomness = source;
        release.versionCodeHash = factory.versionCodeHash();
        for (uint256 i; i < 24; ++i) {
            release.implementations[i] = factory.implementation(i);
        }
    }

    /// @notice Anyone may simulate 6/8/18-decimal draws, reverse delivery, cancel, return and current-owner claims.
    function itemLife(uint8 decimals) external {
        _itemLife(decimals, 5, 6, 6400 + decimals, true);
        // Transfer the earned NFT to an actual contract, then a delegated wallet; neither is classified for payout.
        RehearsalItemOwner owner = new RehearsalItemOwner();
        BoxCollectionV2 collection = BoxCollectionV2(box.collection());
        vm.prank(BOB);
        collection.transferFrom(BOB, address(owner), firstItem);
        _fundLive(15000);
        _compareItems(32);
        uint256[] memory ids = new uint256[](1);
        ids[0] = firstItem;
        vm.prank(address(owner));
        uint256 expected = itemModel.claim(ids, BOB);
        uint256 beforeP = _balance(BOB);
        assertEq(owner.claim(items, firstItem, BOB), expected);
        itemPaid += expected;
        assertEq(_balance(BOB) - beforeP, expected);
        owner.transferItem(collection, firstItem, BOB);
        vm.etch(BOB, abi.encodePacked(hex"ef0100", address(owner)));
        _fundLive(15000);
        _claimItem(firstItem, BOB);
        _state();
    }

    /// @notice Anyone simulates exact seeded ERC-20 redemption and independent failed-seed return.
    function pileLife(uint8 decimals) external {
        _open(5, decimals, 1, 3);
        _trade(true, box.raise() / 10);
        _fillTracked();
        _collect(0);
        box.graduate();
        receiver.collect(address(0));
        PileVaultV2 pile = PileVaultV2(payable(box.vault()));
        uint256 amount = token.balanceOf(address(buyer)) / 3;
        uint256 supply = token.totalSupply();
        uint256 balance = HostileToken(box.q()).balanceOf(address(pile));
        uint256 quote = pile.quoteRedeem(amount);
        assertEq(quote, balance * amount / supply);
        vm.startPrank(address(buyer));
        token.approve(address(pile), amount);
        uint256 beforeP = _balance(address(buyer));
        assertEq(pile.redeem(amount, quote, address(buyer)), quote);
        vm.stopPrank();
        assertEq(_balance(address(buyer)) - beforeP, quote);
        assertEq(token.totalSupply(), supply - amount);
        assertEq(HostileToken(box.q()).balanceOf(address(pile)) + quote, balance);
    }

    /// @notice Foreign royalties refuse receiver custody; independent P gifts follow phase accounting.
    function royaltyLife() external {
        _open(3, 6, 1, 3);
        HostileToken foreign = new HostileToken("Foreign rehearsal royalty", "ROY", 8);
        foreign.mint(address(this), 1501);
        foreign.approve(address(receiver), 1501);
        vm.expectRevert(); receiver.fundRoyalty(address(foreign), 1501);
        assertEq(foreign.balanceOf(address(this)), 1501);
        // Independent P donation; no conversion or exchange is simulated.
        HostileToken p = HostileToken(box.q());
        p.mint(conversionSafe, 1501);
        vm.startPrank(conversionSafe);
        p.approve(address(receiver), 1501);
        receiver.fundRoyalty(box.q(), 1501);
        vm.stopPrank();
        assertEq(receiver.royaltyHeldP(), 1501);
        assertEq(p.balanceOf(conversionSafe), 0);
        vm.warp(box.deadline());
        box.fail();
        assertEq(receiver.royaltyHeldP(), 0);
        uint256 owed = receiver.fitOwed();
        (uint256 beforePot,) = box.claimState();
        p.mint(conversionSafe, 47);
        vm.startPrank(conversionSafe);
        p.approve(address(receiver), 47);
        receiver.fundRoyalty(box.q(), 47);
        vm.stopPrank();
        assertEq(receiver.fitOwed(), owed);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(pot, beforePot + 47);
        assertEq(box.quoteClaim(left), pot);
    }
}
