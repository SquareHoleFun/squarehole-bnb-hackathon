// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {EatLife} from "./Lifecycle.t.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ListingClass, ListingKind} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxReceiverEatV21} from "../../../src/box-v2/interfaces/IBoxReceiverEatV21.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {GasBudget} from "../gas/GasBudget.sol";

/// V21-MONEY-01, real factory and production artifacts on both EVMs: eating a price coin must never hand another
/// box's holder fees to the dead address. A box coin is eaten only by its checked burn; ordinary coins still lock.
contract EatBoxTokenLockTest is EatLife {
    address internal constant DEAD = address(0xdEaD);
    address internal constant ALICE = address(0xA11CE);
    // Named by signature so this file compiles before the refusal exists.
    bytes4 internal constant REFUSED = bytes4(keccak256("BoxTokenNeedsCheckedBurn(address)"));

    /// Origin A graduates; two real wallets and this lister hold its T. `holders` gives A the history-writing ledger T.
    function _origin(bool holders) internal {
        BoxSpec memory first = _spec();
        if (holders) {
            first.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
            first.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        }
        _start(first); _fill(); box.graduate(); origin = box; price = token;
        assertEq(origin.roleAddress(17) != address(0), holders, "origin holder ledger as chosen");
        vm.startPrank(address(buyer));
        price.transfer(address(this), 10_000); price.transfer(CREATOR, 1000 ether); price.transfer(ALICE, 500 ether);
        vm.stopPrank();
        price.approve(address(listings), 10_000);
    }

    /// Box B priced in A's T; each named side eats, the other buys and burns B's own T.
    function _priced(uint32 id, bool buyersEat, bool sellersEat) internal view returns (BoxSpec memory s) {
        s = _menu(2, 2);
        if (buyersEat) s.buyers.a = Branch(1, 1, "", "");
        if (sellersEat) s.sellers.a = Branch(1, 1, "", "");
        s.pricing.token = address(price); s.pricing.listingId = id; s.raise = 100 ether;
    }

    /// Cold-release creation through the real factory, measured as FM16 measures it (transaction gas).
    function _createMeasured(BoxSpec memory s, string memory label) internal returns (BoxCoordinatorV2) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        bytes memory data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        _coldRelease(); vm.cool(s.pricing.token);
        vm.prank(CREATOR);
        uint256 before_ = gasleft();
        (bool ok, bytes memory ret) = address(factory).call(data);
        uint256 used = GasBudget.transaction(before_ - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        emit log_named_uint(label, used);
        (, address c,) = abi.decode(ret, (uint256, address, address));
        return BoxCoordinatorV2(c);
    }

    /// B buys and sells in A's T, graduates and collects; returns its pending eat amount, not yet eaten.
    function _graduateEater(BoxSpec memory s) internal returns (uint256 pending) {
        vm.prank(CREATOR); price.approve(address(factory), 1000 ether);
        box = _createMeasured(s, "box-coin eater creation gas");
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        eat = IBoxReceiverEatV21(address(receiver)); layout = BoxLayoutV2.curve(s.raise, false);
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        (, uint256 bought) = _buy(20 ether);
        buyer.swap(hook.poolKey(), false, bought / 4, layout.sqrtPriceStartX96);
        receiver.collect(address(0));
        _fill(); box.graduate(); receiver.collect(address(0));
        pending = eat.eatPendingP();
        assertGt(pending, 0, "eater holds pending price coin");
    }

    function _refusal() internal view returns (bytes memory) { return abi.encodeWithSelector(REFUSED, address(price)); }

    /// The reviewer's settlement: trade in A after B's action, close both batches, settle them completely.
    /// Real eligible holders and residue must hold each whole batch; the dead address earns nothing.
    function _originBatchesPayOnlyRealHolders() internal {
        IBoxHookV2 aHook = IBoxHookV2(origin.hook());
        IBoxReceiverV2 aReceiver = IBoxReceiverV2(origin.receiver());
        HolderLedgerV2 ledger = HolderLedgerV2(origin.roleAddress(17));
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(price));
        uint256[2] memory ids = [aHook.currentTradeBatch(true), aHook.currentTradeBatch(false)];
        (, uint256 bought) = buyer.swap(aHook.poolKey(), true, 4 ether, TickMath.MIN_SQRT_PRICE + 1);
        buyer.swap(aHook.poolKey(), false, bought / 2, TickMath.MAX_SQRT_PRICE - 1);
        for (uint256 round; round < 32 && !aReceiver.holderBatchClosed(ids[1]); ++round) {
            vm.roll(block.number + 1); vm.prank(address(aHook));
            (ProtocolSkip skip,,,) = aHook.sellFees();
            for (uint256 page; page < 16; ++page) aReceiver.collect(address(0));
            if (skip == ProtocolSkip.BelowMinimum && !aReceiver.holderBatchClosed(ids[1])) {
                (, uint256 extra) = buyer.swap(aHook.poolKey(), true, 4 ether, TickMath.MIN_SQRT_PRICE + 1);
                buyer.swap(aHook.poolKey(), false, extra / 2, TickMath.MAX_SQRT_PRICE - 1);
            }
        }
        uint256 checkpoint = history.holderCheckpoint();
        for (uint256 k; k < 2; ++k) {
            uint256 id = ids[k];
            assertTrue(aReceiver.holderBatchClosed(id), "origin batch closed by collect");
            uint256 funding = aReceiver.holderBatchPaid(id);
            assertGt(funding, 0, "origin batch funded");
            for (uint256 i; i < 16 && !ledger.settleBatch(id, 64); ++i) {}
            (bool complete,,, uint256 residue) = ledger.batchState(id);
            assertTrue(complete, "origin batch settled");
            uint256 credits;
            uint256 paid;
            for (uint256 h; h < history.holderCount(); ++h) {
                address holder = history.holderAt(h);
                if (holder == DEAD) continue;
                uint256 credit = ledger.claimable(id, holder);
                credits += credit;
                if (credit != 0) ++paid;
            }
            emit log_named_uint("origin batch funding", funding);
            emit log_named_uint("dead address credit", ledger.claimable(id, DEAD));
            assertEq(credits + residue, funding, "real holders plus residue hold the whole origin batch");
            assertEq(ledger.claimable(id, DEAD), 0, "dead address earns no origin holder fees");
            assertGe(paid, 2, "both real eligible wallets earn");
        }
        assertEq(history.eligibleBalanceAt(DEAD, checkpoint), 0, "dead address is no eligible origin holder");
    }

    /// The reviewer's scenario, end to end: A with Holders, its T listed through plain add, B eating it.
    /// Today B locks A's T at 0xdEaD, which then earns A's holder fees for good. Whatever the release admits,
    /// the origin's batches must pay only real holders; with the fix, B's creation is refused instead.
    function test_V21M01_reviewerScenarioDeadAddressEarnsNoOriginHolderFees() public {
        _origin(true);
        uint32 id = listings.add(address(price), ListingClass.OTHER, 100 ether);
        // This release's reverse proof accepts only the plain T implementation: its ledger T lists as a coin.
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.LISTED), "ledger T is an ordinary listing");
        assertEq(listings.checkedBurnSelector(address(price)), bytes4(0), "no checked burn recorded");
        BoxSpec memory s = _priced(id, false, true);
        bytes memory refusal = factory.refusal(s, CREATOR);
        if (refusal.length == 0) {
            uint256 pending = _graduateEater(s);
            assertEq(eat.priceBurnSelector(), bytes4(0), "admitted eater locks");
            assertEq(eat.eatPriceCoin(), pending);
            assertEq(price.balanceOf(DEAD), pending, "the lock reached the dead address");
        } else {
            assertEq(refusal, _refusal(), "creation refuses an unchecked box-coin eater");
        }
        _originBatchesPayOnlyRealHolders();
    }

    /// Either side, or both: the unchecked ledger T is refused by refusal(), createBox and predictBox alike,
    /// before any part exists, and A's holder history is untouched.
    function test_V21M01_uncheckedLedgerTokenEatRefusedOnEitherSide() public {
        _origin(true);
        uint32 id = listings.add(address(price), ListingClass.OTHER, 100 ether);
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(price));
        (uint256 holders, uint256 checkpoint) = (history.holderCount(), history.holderCheckpoint());
        vm.prank(CREATOR); price.approve(address(factory), 1000 ether);
        for (uint256 side; side < 3; ++side) {
            BoxSpec memory s = _priced(id, side != 1, side != 0);
            assertEq(factory.refusal(s, CREATOR), _refusal(), "refusal names the unchecked box coin");
            vm.expectRevert(_refusal());
            factory.predictBox(CREATOR, s, bytes32(0));
            uint256 boxes = registry.boxCount();
            vm.prank(CREATOR);
            vm.expectRevert(_refusal());
            factory.createBox(s, bytes32(0), bytes32(0));
            assertEq(registry.boxCount(), boxes, "nothing created");
        }
        assertEq(history.holderCount(), holders); assertEq(history.holderCheckpoint(), checkpoint);
        assertEq(history.eligibleBalanceAt(DEAD, checkpoint), 0);
    }

    /// A plain box coin (BOX_TOKEN kind) admitted with plain add() records no burn: an eater is refused.
    function test_V21M01_uncheckedPlainBoxTokenEatRefused() public {
        _origin(false);
        uint32 id = listings.add(address(price), ListingClass.STANDARD, 100 ether);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.BOX_TOKEN));
        BoxSpec memory s = _priced(id, true, true);
        assertEq(factory.refusal(s, CREATOR), _refusal(), "unchecked plain box coin refused");
        vm.prank(CREATOR);
        vm.expectRevert(_refusal());
        factory.createBox(s, bytes32(0), bytes32(0));
    }

    /// The same plain box coin admitted with addWithBurn() is eatable, and eating burns exactly the pending amount.
    function test_V21M01_checkedPlainBoxTokenBurnsExactly() public {
        _origin(false);
        uint32 id = listings.addWithBurn(address(price), ListingClass.STANDARD, 100 ether, BURN);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.BOX_TOKEN));
        BoxSpec memory s = _priced(id, true, true);
        assertEq(factory.refusal(s, CREATOR), "", "checked plain box coin admitted");
        uint256 pending = _graduateEater(s);
        assertEq(eat.priceBurnSelector(), BURN);
        uint256 supply = price.totalSupply();
        assertEq(eat.eatPriceCoin(), pending);
        assertEq(price.totalSupply(), supply - pending, "burned exactly");
        assertEq(eat.eatenP(), pending); assertEq(price.balanceOf(address(receiver)), 0);
        assertEq(price.balanceOf(DEAD), 0); _booked();
    }

    /// The admitted ledger path: addWithBurn, B eats by burning exactly, A's holder list and eligible supply do
    /// not move, and A's later batches pay only real holders.
    function test_V21M01_checkedLedgerTokenBurnsExactlyAndOriginHoldersKeepEverything() public {
        _origin(true);
        uint32 id = listings.addWithBurn(address(price), ListingClass.OTHER, 100 ether, BURN);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.LISTED));
        BoxSpec memory s = _priced(id, true, true);
        assertEq(factory.refusal(s, CREATOR), "", "checked ledger coin admitted");
        uint256 pending = _graduateEater(s);
        assertEq(eat.priceBurnSelector(), BURN);
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(price));
        uint256 holders = history.holderCount();
        uint256 eligible = history.eligibleSupplyAt(history.holderCheckpoint());
        (uint256 supply, uint256 managed) = (price.totalSupply(), price.balanceOf(address(pm)));
        assertEq(eat.eatPriceCoin(), pending);
        assertEq(price.totalSupply(), supply - pending, "burned exactly");
        assertEq(price.balanceOf(address(pm)), managed - pending, "redeemed exactly");
        assertEq(eat.eatenP(), pending); assertEq(price.balanceOf(address(receiver)), 0);
        assertEq(history.holderCount(), holders, "no holder enrolled");
        assertEq(history.eligibleSupplyAt(history.holderCheckpoint()), eligible, "eligible supply unchanged");
        assertEq(price.balanceOf(DEAD), 0); _booked();
        _originBatchesPayOnlyRealHolders();
    }

    /// Over-refusal guard: an ordinary listed coin keeps the documented lock.
    function test_V21M01_ordinaryCoinStillLocksAtTheDeadAddress() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(2, 2, 18);
        s.buyers.a = Branch(1, 1, "", ""); s.sellers.a = Branch(1, 1, "", "");
        assertEq(listings.checkedBurnSelector(address(p)), bytes4(0));
        assertEq(factory.refusal(s, CREATOR), "", "ordinary coin admitted");
        box = _createMeasured(s, "ordinary-coin eater creation gas");
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        eat = IBoxReceiverEatV21(address(receiver)); layout = BoxLayoutV2.curve(s.raise, false);
        buyer = new PoolDriver(pm); p.mint(address(buyer), s.raise * 10);
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        assertEq(eat.priceBurnSelector(), bytes4(0));
        _buy(s.raise / 5); receiver.collect(address(0));
        _fill(); box.graduate(); receiver.collect(address(0));
        uint256 pending = eat.eatPendingP(); assertGt(pending, 0);
        uint256 before_ = p.balanceOf(DEAD);
        assertEq(eat.eatPriceCoin(), pending);
        assertEq(p.balanceOf(DEAD) - before_, pending, "locked exactly"); _booked();
    }
}
