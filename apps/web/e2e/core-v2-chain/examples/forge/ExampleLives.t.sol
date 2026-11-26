// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11WDeploymentFixture} from "test/box-v2/m1-64/CQ11WDeployment.t.sol";
import {CoreV2LocalActions} from "script/local/CoreV2LocalActions.sol";
import {LocalPriceCoin, LocalUSDC, LocalLINK, LocalNVDAon, LocalStockControls} from "script/local/LocalQuoteMocks.sol";
import {BoxSpec, AddOn} from "src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "src/box-v2/interfaces/RecipeTypes.sol";
import {BoxCoordinatorV2} from "src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "src/box-v2/BoxTokenV2.sol";
import {BoxCollectionV2} from "src/box-v2/BoxCollectionV2.sol";
import {BoxVaultV2} from "src/box-v2/BoxVaultV2.sol";
import {BoxFactoryV2Parts} from "src/box-v2/BoxFactoryV2Parts.sol";
import {BoxClones} from "src/box/libraries/BoxClones.sol";
import {IBoxHookV2, ProtocolSkip} from "src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2, FeeBatchV2, ItemFundingV2} from "src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxRoyaltyRouterV2} from "src/box-v2/interfaces/IBoxPeripheryV2.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IHolderLedgerV2} from "src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IItemLedgerV2} from "src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxReceiverPileV21} from "src/box-v2/interfaces/IBoxReceiverPileV21.sol";
import {IBoxReceiverEatV21} from "src/box-v2/interfaces/IBoxReceiverEatV21.sol";
import {IBoxReceiverPayInTV21} from "src/box-v2/interfaces/IBoxReceiverPayInTV21.sol";
import {ItemLedgerV2} from "src/box-v2/ItemLedgerV2.sol";
import {IPileVaultV2} from "src/box-v2/interfaces/IPileVaultV2.sol";
import {IListingRegistry, ListingClass} from "src/box-v2/interfaces/IListingRegistry.sol";
import {ChunkPart} from "src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {SparseBoxTree} from "test/box/items/BoxItemsKit.sol";
import {PriceLimitSwapper} from "test/research/hookgas/HookGasKit.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
// The inherited fixture loads this by artifact name. Include it in a clean,
// isolated build instead of relying on the contract owner's existing output.
import {PoolManager} from "v4-core/src/PoolManager.sol";

import {TestCoin, TestFrog, TestGold} from "src/test-coins/TestCoins.sol";
import {IListingBurnV21} from "src/box-v2/interfaces/IListingBurnV21.sol";
import {BoxTicketsV2} from "src/box-v2/BoxTicketsV2.sol";
import {IDrandSource} from "src/box/interfaces/IDrandSource.sol";
import {ItemReveal} from "src/box/interfaces/BoxTypes.sol";

/// @notice Listener-free verification of registry recipes. Does not certify browser behavior.
contract ExampleLivesTest is CQ11WDeploymentFixture, CoreV2LocalActions {
    address private constant OWNER = address(0xA11CE);
    address private constant OTHER = address(0xB0B);

    function test_frogKiln() public { _life("frog-kiln"); }

    function test_paperCertificates() public { _life("paper-certificates"); }

    function test_exitLiquidity() public {
        _life("exit-liquidity");
    }

    function test_gpuPoor() public {
        _life("gpu-poor");
    }

    function test_gasGuzzlers() public {
        _life("gas-guzzlers");
    }

    function test_stakingSnails() public {
        _life("staking-snails");
    }

    function test_rentFree() public {
        _life("rent-free");
    }

    function test_bagHolders() public {
        _life("bag-holders");
    }

    function test_dragonsHoard() public { _life("dragons-hoard"); }

    function test_linkMarines() public {
        _life("link-marines");
    }

    /// @notice Link Marines version 2 (F151), created from its kit's own download: rations in LINK on both fee sides.
    function test_linkMarinesV2() public {
        _rationsLife("link-marines-v2");
    }

    function test_gpuPoorMiners() public {
        _life("gpu-poor-miners");
    }

    function test_oneDollar() public {
        _life("one-dollar");
    }

    function test_rugRugs() public {
        _life("rug-rugs");
    }

    function _beforeLocalTransaction() internal override {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
    }

    function _raw(string memory json, string memory key) private pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _is(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _branch(string memory json, string memory side) private pure returns (Branch memory) {
        string memory prefix = string.concat(".fees.", side);
        string memory choice = vm.parseJsonString(json, string.concat(prefix, ".choice"));
        if (_is(choice, "pile")) return Branch(1, 7, "", "");
        // v2.1 step 1: AsPaid/Eat eats the price coin; step 2: BuyT/Holders (currency T = 2) and BuyT/Items pay in T.
        if (_is(choice, "eat")) return Branch(1, 1, "", "");
        if (_is(choice, "holders-t")) return Branch(2, 6, "", abi.encode(uint8(2)));
        if (_is(choice, "items-t")) return Branch(2, 8, "", abi.encode(_inside(json, prefix)));
        if (_is(choice, "burn")) return Branch(2, 1, "", "");
        if (_is(choice, "keep")) return Branch(1, 2, "", "");
        if (_is(choice, "grow")) return Branch(1, 4, "", "");
        if (_is(choice, "holders")) return Branch(1, 6, "", abi.encode(uint8(1)));
        require(_is(choice, "items"), "unknown fee choice");
        return Branch(1, 8, "", abi.encode(_inside(json, prefix)));
    }

    /// @dev An items side's rule for items still in the vault (registry ITEMS_INSIDE_POLICIES): Keep 1, Burn 2, and
    /// v2.1 step 5's Depth 3, the share going to the box's own pool.
    function _inside(string memory json, string memory prefix) private pure returns (uint8) {
        string memory inside = vm.parseJsonString(json, string.concat(prefix, ".inside"));
        if (_is(inside, "burn")) return 2;
        if (_is(inside, "depth")) return 3;
        require(_is(inside, "keep"), "unknown inside policy");
        return 1;
    }

    function _price(BoxSpec memory s, string memory symbol) private {
        if (_is(symbol, "ETH")) return;
        if (_is(symbol, "TEST_FROG") || _is(symbol, "TEST_GOLD")) {
            bool frog = _is(symbol, "TEST_FROG");
            TestCoin testCoin = frog ? TestCoin(address(new TestFrog(address(this), s.raise * 20)))
                : TestCoin(address(new TestGold(address(this), s.raise * 20)));
            IListingRegistry registry = IListingRegistry(localFactory.listingRegistry());
            testCoin.transfer(address(platform), 10_000);
            testCoin.transfer(OWNER, s.raise * 10);
            vm.startPrank(address(platform));
            testCoin.approve(address(registry), 10_000);
            s.pricing.listingId = frog
                ? IListingBurnV21(address(registry)).addWithBurn(address(testCoin), ListingClass.OTHER, s.raise, TestFrog.burn.selector)
                : registry.add(address(testCoin), ListingClass.OTHER, s.raise);
            vm.stopPrank();
            s.pricing.token = address(testCoin);
            assertEq(testCoin.symbol(), frog ? "tFROG" : "tGOLD");
            return;
        }
        LocalPriceCoin coin = _is(symbol, "USDC")
            ? LocalPriceCoin(address(new LocalUSDC()))
            : _is(symbol, "LINK")
                ? LocalPriceCoin(address(new LocalLINK()))
                : LocalPriceCoin(address(new LocalNVDAon(new LocalStockControls(DEPLOYER))));
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        coin.mint(address(platform), 10_000);
        vm.startPrank(address(platform));
        coin.approve(address(listings), 10_000);
        s.pricing.listingId = listings.add(
            address(coin),
            _is(symbol, "USDC") ? ListingClass.STABLE : _is(symbol, "NVDAon") ? ListingClass.STOCK : ListingClass.OTHER,
            s.raise
        );
        vm.stopPrank();
        s.pricing.token = address(coin);
        coin.mint(OWNER, s.raise * 10);
    }

    function _spec(string memory json) private returns (BoxSpec memory s) {
        if (_is(vm.parseJsonString(json, ".contents.art.mode"), "hidden")) {
            string memory directory = _hiddenDirectory(vm.parseJsonString(json, ".id"));
            string memory saved = vm.readFile(string.concat(directory, "/contract.json"));
            s = abi.decode(vm.parseJsonBytes(saved, ".encoded"), (BoxSpec));
            assertEq(s.n, _raw(json, ".contents.size"));
            assertEq(s.tokenName, vm.parseJsonString(json, ".name"));
            assertEq(s.tokenSymbol, vm.parseJsonString(json, ".ticker"));
            assertEq(s.raise, _raw(json, ".raise.amount"));
            s.marketplaceOwner = OWNER;
            _price(s, vm.parseJsonString(json, ".priceCoin.symbol"));
            return s;
        }
        bool collection = _is(vm.parseJsonString(json, ".contents.kind"), "collection");
        s = _localSpec(collection ? 4 : 3);
        s.tokenName = vm.parseJsonString(json, ".name");
        s.tokenSymbol = vm.parseJsonString(json, ".ticker");
        s.raise = _raw(json, ".raise.amount");
        s.creatorBuy = 0;
        s.deadlineDays = uint16(_raw(json, ".deadline.days"));
        s.buyers.a = _branch(json, "buyers");
        s.sellers.a = _branch(json, "sellers");
        s.creatorFeeRecipient = s.buyers.a.dest == 2 || s.sellers.a.dest == 2 ? OWNER : address(0);
        s.coverSha256 = sha256(
            vm.readFileBinary(
                string.concat(vm.envString("SH_EXAMPLES_CONTRACTS_ROOT"), "/../../", vm.parseJsonString(json, ".logo"))
            )
        );
        _price(s, vm.parseJsonString(json, ".priceCoin.symbol"));
        if (collection) {
            s.n = uint32(_raw(json, ".contents.size"));
            s.collectionName = s.tokenName;
            s.collectionSymbol = s.tokenSymbol;
            s.marketplaceOwner = OWNER;
            s.pickFeeBps = uint16(_raw(json, ".contents.pickFeeBps"));
            s.collectionCoverSha256 = sha256(
                vm.readFileBinary(
                    string.concat(
                        vm.envString("SH_EXAMPLES_CONTRACTS_ROOT"),
                        "/../../",
                        vm.parseJsonString(json, ".contents.art.source")
                    )
                )
            );
            (uint256 depth, uint256[] memory positions, bytes32[] memory leaves) = _tree(s);
            s.revealRoot = SparseBoxTree.root(depth, positions, leaves);
            uint256 bps = _raw(json, ".royalties.bps");
            if (bps != 0) {
                // R53 G-J (F138): royalties are booked like the buyers' fees; destination 1 is the only one.
                assertEq(vm.parseJsonString(json, ".royalties.destination"), "fees");
                s.addOns = new AddOn[](1);
                s.addOns[0] = AddOn(4, abi.encode(uint16(bps), uint8(1)));
                s.creatorFeeRecipient = OWNER;
            }
        }
        if (_is(vm.parseJsonString(json, ".contents.kind"), "pile")) {
            s.boxType = 5;
            assertEq(vm.parseJsonString(json, ".contents.seed.symbol"), vm.parseJsonString(json, ".priceCoin.symbol"));
            s.contentsParams = vm.keyExistsJson(json, ".contents.leaveBehindBps")
                ? abi.encode(s.pricing.token, _raw(json, ".contents.seed.amount"), uint16(_raw(json, ".contents.leaveBehindBps")))
                : abi.encode(s.pricing.token, _raw(json, ".contents.seed.amount"));
        }
    }

    function _tree(BoxSpec memory s)
        private
        pure
        returns (uint256 depth, uint256[] memory positions, bytes32[] memory leaves)
    {
        while (1 << depth < s.n) ++depth;
        positions = new uint256[](s.n);
        leaves = new bytes32[](s.n);
        for (uint256 i; i < s.n; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, s.collectionCoverSha256, 0, 0, 0);
        }
    }

    function _create(BoxSpec memory s) private returns (BoxCoordinatorV2 b) {
        b = _createLoaded(s);
        if (s.boxType == 1 && s.artMode == 1) {
            (uint256 depth, uint256[] memory positions, bytes32[] memory leaves) = _tree(s);
            BoxCollectionV2(b.collection())
                .reveal(1, 0, s.collectionCoverSha256, 0, 0, 0, SparseBoxTree.proof(depth, 0, positions, leaves));
        }
    }

    /// @dev Salts, the exact creation payment, createBox, then the committed chunks or the pile seed: the gate opens.
    function _createLoaded(BoxSpec memory s) private returns (BoxCoordinatorV2 b) {
        bytes32 cs;
        bytes32 hs;
        address predicted;
        bytes32 initHash;
        for (uint256 i;; ++i) {
            address t;
            cs = bytes32(i);
            (predicted, t, initHash) = localFactory.predictBox(OWNER, s, cs);
            if (t > s.pricing.token && t < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i);
            address h = BoxClones.predict(predicted, hs, initHash);
            if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break;
        }
        uint256 value = localFactory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ;
        if (s.pricing.token != address(0)) {
            LocalPriceCoin(s.pricing.token).approve(address(localFactory), value);
            value = 0;
        }
        b = BoxCoordinatorV2(_createLocalBox(s, cs, hs, value));
        if (s.boxType == 1) {
            b.loadChunk(ChunkPart.Table, s.metadataTable, 0);
            BoxFactoryV2Parts.Box memory empty;
            (, bytes memory texts) = localFactory.planner().parts().partArgs(empty, s);
            if (texts.length != 0) b.loadChunk(ChunkPart.Texts, texts, 0);
        }
        if (s.boxType == 5) {
            (address asset, uint256 amount) = abi.decode(s.contentsParams, (address, uint256));
            if (asset == address(0)) IPileVaultV2(b.vault()).loadSeed{value: amount}();
            else { LocalPriceCoin(asset).approve(b.vault(), amount); IPileVaultV2(b.vault()).loadSeed(); }
        }
        assertTrue(b.gateOpen());
        assertEq(b.specHash(), keccak256(abi.encode(s)));
    }

    function _life(string memory id) internal {
        (localFactory,) = _run();
        vm.warp(block.timestamp + 1 days); // Release actions become selectable at the fixed directory delay.
        localActor = OWNER;
        localSwapper = new PriceLimitSwapper(IPoolManager(manager));
        vm.deal(OWNER, 200 ether);
        string memory json = _row(id);
        BoxSpec memory s = _spec(json);
        vm.startPrank(OWNER);
        BoxCoordinatorV2 b = _create(s);
        vm.warp(b.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        _tradeLocal(b);
        IBoxReceiverV2 receiver = IBoxReceiverV2(b.receiver());
        FeeBatchV2 memory fees = receiver.collect(address(0));
        emit log_string(string.concat("REPLAY_ID|", id));
        emit log_string(string.concat("REPLAY_CARRY|", vm.toString(fees.buyersP % 15), "|", vm.toString(fees.sellersP % 15)));
        if (_is(vm.parseJsonString(json, ".life"), "failure")) {
            _failure(b);
        } else {
            _fillLocal(b);
            _beforeLocalTransaction();
            receiver.collect(address(0)); // Match the browser: collect all outstanding fees before graduation.
            _capture(b, "before");
            vm.recordLogs();
            b.graduate();
            _captureLogs();
            _capture(b, "after");
            assertTrue(b.graduated());
            assertFalse(b.failed());
            _tradeLocal(b);
            // F137: the sale's T fee reaches the sellers' side only through the public sellFees step.
            uint256 sellerBatch = IBoxHookV2(b.hook()).currentTradeBatch(false);
            _sellLocalFees(b);
            receiver.collect(address(0));
            _properties(b, s, json, sellerBatch);
        }
        _safe(receiver, s.pricing.token);
        vm.stopPrank();
    }

    /// @dev The registry row, which must be a current contract recipe: ready, or pending only on a site step
    /// (registry.mjs SITE_STEPS: FE12).
    function _row(string memory id) private view returns (string memory json) {
        json = vm.readFile(
            string.concat(vm.envString("SH_EXAMPLES_CONTRACTS_ROOT"), "/../box-spec/examples/v2/", id, ".json")
        );
        string memory status = vm.parseJsonString(json, ".status");
        assertTrue(
            _is(status, "ready") || (_is(status, "pending") && _is(vm.parseJsonString(json, ".pendingStep"), "FE12")),
            "example recipe is not a current contract recipe"
        );
    }

    /// @dev A kit life's run-owned folder (prepare-hidden.mjs): a hidden kit's private art, or an open kit's download.
    /// A caller's own SH_HIDDEN_KITS index must name a folder for every kit life the run includes.
    function _hiddenDirectory(string memory id) private view returns (string memory) {
        string memory root = string.concat(vm.envString("SH_EXAMPLES_CONTRACTS_ROOT"), "/../../");
        string memory index = vm.readFile(string.concat(root, vm.envString("SH_HIDDEN_KITS")));
        string memory key = string.concat("['", id, "']");
        require(
            vm.keyExistsJson(index, key),
            string.concat("SH_HIDDEN_KITS names no folder for ", id, "; an index from prepare-hidden.mjs has one")
        );
        return string.concat(root, vm.parseJsonString(index, key));
    }

    function _localReveal(string memory directory, uint256 id) private view returns (ItemReveal memory r) {
        string memory saved = vm.readFile(string.concat(directory, "/reveal.json"));
        string memory key = string.concat(".items[", vm.toString(id - 1), "]");
        r.traitsPacked = uint128(_raw(saved, string.concat(key, ".traitsPacked")));
        r.imageHash = vm.parseJsonBytes32(saved, string.concat(key, ".imageSha256"));
        r.avatarHash = vm.parseJsonBytes32(saved, string.concat(key, ".avatarSha256"));
        r.modelHash = vm.parseJsonBytes32(saved, string.concat(key, ".modelSha256"));
        r.salt = vm.parseJsonBytes32(saved, string.concat(key, ".salt"));
        string memory proofs = vm.readFile(string.concat(directory, "/proofs.json"));
        r.proof = vm.parseJsonBytes32Array(proofs, string.concat("['", vm.toString(id), "']"));
        assertEq(r.imageHash, sha256(vm.readFileBinary(string.concat(directory, "/items/", vm.toString(id), ".png"))));
    }

    /// @dev The revealed item's tokenJSON holds exactly its own attributes (the private folder's `attributes.json`).
    function _assertAttributes(string memory json, string memory directory, uint256 id) private view {
        _assertTraits(json, vm.readFile(string.concat(directory, "/attributes.json")), id);
    }

    /// @dev `json` holds each of item `id`'s attribute pairs in `expected` (an `attributes.json`) exactly once, and no
    /// other attribute.
    function _assertTraits(string memory json, string memory expected, uint256 id) private pure {
        string[] memory pairs = vm.parseJsonStringArray(expected, string.concat("['", vm.toString(id), "']"));
        assertGt(pairs.length, 0);
        for (uint256 i; i < pairs.length; ++i) {
            assertEq(_count(json, pairs[i]), 1, pairs[i]);
        }
        assertEq(_count(json, '"trait_type"'), pairs.length);
    }

    /// @dev How many times `needle` occurs in `haystack`, counted by Forge's own split instead of an EVM byte loop (all
    /// 420 marines are checked). The needles here, a quoted key and whole `{...}` attribute objects, cannot overlap.
    function _count(string memory haystack, string memory needle) private pure returns (uint256) {
        if (bytes(needle).length == 0) return 0;
        return vm.split(haystack, needle).length - 1;
    }

    function _hiddenRoundTrip(BoxCoordinatorV2 b, string memory id) private returns (uint256 itemId) {
        BoxVaultV2 vault = BoxVaultV2(b.vault());
        BoxTicketsV2 tickets = BoxTicketsV2(b.tickets());
        BoxTokenV2 token = BoxTokenV2(b.token());
        BoxCollectionV2 collection = BoxCollectionV2(b.collection());
        token.approve(address(tickets), type(uint256).max);
        uint256 supply = token.totalSupply();
        (uint256 principal, uint256 fee) = vault.quoteTake(1);
        uint256 before = token.balanceOf(OWNER);
        uint256 draw = tickets.draw{value: 1 ether}(principal + fee, block.timestamp);
        assertEq(before - token.balanceOf(OWNER), principal + fee);
        assertEq(token.totalSupply(), supply - fee);
        // Only the external beacon answer is stubbed. Request, queue, selection, proof and custody are real contracts.
        vm.mockCall(b.randomness(), abi.encodeCall(IDrandSource.wordOf, (address(tickets), draw)),
            abi.encode(keccak256("hidden kit offline beacon"), uint64(block.timestamp)));
        assertEq(tickets.settle(1), 1);
        itemId = tickets.drawTicket(draw).itemId;
        assertFalse(collection.isRevealed(itemId));
        ItemReveal memory reveal = _localReveal(_hiddenDirectory(id), itemId);
        bytes32 original = reveal.salt;
        reveal.salt = bytes32(uint256(original) ^ 1);
        vm.expectRevert(abi.encodeWithSignature("InvalidProof(uint256)", itemId));
        tickets.openDraw(draw, OWNER, reveal);
        assertFalse(collection.isRevealed(itemId));
        reveal.salt = original;
        assertEq(tickets.openDraw(draw, OWNER, reveal), itemId);
        assertTrue(collection.isRevealed(itemId));
        // SH-AI-PLAN fix round 1: hidden art's sorted table and the item's packed traits render its own attributes.
        _assertAttributes(collection.tokenJSON(itemId), _hiddenDirectory(id), itemId);
        assertEq(collection.ownerOf(itemId), OWNER);
        collection.approve(address(vault), itemId);
        uint256 quote = vault.quoteReturn(1);
        uint256 returnFee = (quote * vault.returnFeeBps() + 9_999) / 10_000;
        quote -= returnFee;
        before = token.balanceOf(OWNER);
        supply = token.totalSupply();
        vault.returnItem(itemId, quote, block.timestamp);
        assertEq(token.balanceOf(OWNER) - before, quote);
        assertEq(token.totalSupply(), supply - returnFee, "return burns only its fee");
        assertEq(collection.ownerOf(itemId), address(vault));
        // Take the now-revealed item again so the same life can prove its outside fee claim.
        token.approve(address(vault), type(uint256).max);
        vault.withdraw(itemId, type(uint256).max, block.timestamp);
        assertEq(collection.ownerOf(itemId), OWNER);
    }

    function _money(address p, address owner) private view returns (uint256) {
        return p == address(0) ? owner.balance : LocalPriceCoin(p).balanceOf(owner);
    }

    // Raw EVM reads/receipt logs, consumed by the SAME JS helpers as Playwright.
    // No hand-authored balances and no RPC listener are needed for this replay.
    function _readCapture(string memory phase, address target, bytes memory data) private {
        (bool ok, bytes memory result) = target.staticcall(data);
        require(ok, "replay read failed");
        emit log_string(string.concat("REPLAY_READ|", phase, "|", vm.toString(target), "|", vm.toString(data), "|", vm.toString(result)));
    }

    function _capture(BoxCoordinatorV2 b, string memory phase) private {
        string[12] memory getters = ["fitOwed()", "platformOwed()", "poolHeldP()", "growHeldP()", "creatorP()", "buyBackP()", "itemsHeldP()", "royaltyHeldP()", "poolManager()", "FIT_SAFE()", "PLATFORM_SAFE()", "launchRouter()"];
        for (uint256 i; i < getters.length; ++i) _readCapture(phase, b.receiver(), abi.encodeWithSignature(getters[i]));
        _readCapture(phase, b.receiver(), abi.encodeWithSignature("pilePendingP()"));
        _readCapture(phase, b.receiver(), abi.encodeWithSignature("eatPendingP()"));
        _readCapture(phase, b.receiver(), abi.encodeWithSignature("rewardsPendingP()"));
        _readCapture(phase, b.receiver(), abi.encodeWithSignature("booked(address)", b.q()));
        IBoxHookV2 h = IBoxHookV2(b.hook());
        string[7] memory hooks = ["curve()", "poolId()", "reserveMinted()", "deepenTipCap()", "pairedLiquidity()", "saleFeesPending()", "q()"];
        for (uint256 i; i < hooks.length; ++i) _readCapture(phase, address(h), abi.encodeWithSignature(hooks[i]));
        address[5] memory owners = [address(h), b.receiver(), b.roleAddress(17), b.roleAddress(16), address(b)];
        for (uint256 i; i < owners.length; ++i) _readCapture(phase, manager, abi.encodeWithSignature("balanceOf(address,uint256)", owners[i], uint256(uint160(b.q()))));
        bytes32 slot = keccak256(abi.encode(PoolId.unwrap(h.poolId()), uint256(6)));
        _readCapture(phase, manager, abi.encodeWithSignature("extsload(bytes32)", slot));
        _readCapture(phase, address(b), abi.encodeWithSignature("claimState()"));
        _readCapture(phase, address(b), abi.encodeWithSignature("q()"));
        _readCapture(phase, b.token(), abi.encodeWithSignature("balanceOf(address)", address(b)));
        emit log_string(string.concat("REPLAY_BALANCE|", phase, "|", vm.toString(b.q()), "|", vm.toString(OWNER), "|", vm.toString(_money(b.q(), OWNER))));
        emit log_string(string.concat("REPLAY_BALANCE|", phase, "|", vm.toString(b.q()), "|", vm.toString(b.launchRouter()), "|", vm.toString(_money(b.q(), b.launchRouter()))));
        if (keccak256(bytes(phase)) == keccak256("before")) {
            _captureBox(b);
        }
    }

    function _captureBox(BoxCoordinatorV2 b) private {
        bytes memory addresses = abi.encode(address(b), b.token(), b.hook(), b.receiver(), b.roleAddress(17), b.roleAddress(16));
        emit log_string(string.concat("REPLAY_BOX|", vm.toString(bytes.concat(addresses, abi.encode(b.q(), b.raise(), OWNER)))));
    }

    function _captureLogs() private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            emit log_string(string.concat("REPLAY_LOG|", vm.toString(abi.encode(logs[i].emitter, logs[i].topics, logs[i].data))));
        }
    }

    function _safe(IBoxReceiverV2 receiver, address p) private {
        uint256 due = receiver.fitOwed();
        uint256 before = _money(p, receiver.FIT_SAFE());
        assertGt(due, 0);
        receiver.payFit();
        assertEq(_money(p, receiver.FIT_SAFE()) - before, due);
        due = receiver.platformOwed();
        before = _money(p, receiver.PLATFORM_SAFE());
        assertGt(due, 0);
        receiver.payPlatform();
        assertEq(_money(p, receiver.PLATFORM_SAFE()) - before, due);
    }

    function _failure(BoxCoordinatorV2 b) private {
        BoxTokenV2 t = BoxTokenV2(b.token());
        t.transfer(OTHER, t.balanceOf(OWNER) / 3);
        vm.warp(b.deadline());
        vm.roll(block.number + 1);
        _capture(b, "before");
        vm.recordLogs();
        b.fail();
        _captureLogs();
        _capture(b, "after");
        (uint256 initial, uint256 left) = b.claimState();
        assertEq(left, t.balanceOf(OWNER) + t.balanceOf(OTHER));
        uint256 total;
        for (uint256 i; i < 2; ++i) {
            address owner = i == 0 ? OWNER : OTHER;
            vm.stopPrank();
            vm.startPrank(owner);
            (uint256 pot, uint256 outstanding) = b.claimState();
            uint256 amount = t.balanceOf(owner);
            uint256 quote = pot * amount / outstanding;
            assertEq(b.quoteClaim(amount), quote);
            t.approve(address(b), amount);
            uint256 before = _money(b.q(), owner);
            uint256 supply = t.totalSupply();
            b.claim(amount, owner);
            assertEq(_money(b.q(), owner) - before, quote);
            assertEq(t.totalSupply(), supply - amount);
            total += quote;
        }
        assertEq(total, initial);
        (uint256 remaining, uint256 outstanding) = b.claimState();
        assertEq(remaining, 0);
        assertEq(outstanding, 0);
        vm.stopPrank();
        vm.startPrank(OWNER);
    }

    function _rewardsReady(IBoxReceiverPayInTV21 rewards, uint256 minimum) private view returns (bool) {
        (uint256 holders, uint256 buyersItems, uint256 sellersItems) = rewards.rewardsPendingByKind();
        return holders >= minimum || buyersItems >= minimum || sellersItems >= minimum;
    }

    function _hasProperty(string memory json, string memory property) private pure returns (bool) {
        string[] memory properties = vm.parseJsonStringArray(json, ".properties");
        for (uint256 i; i < properties.length; ++i) if (_is(properties[i], property)) return true;
        return false;
    }

    /// @dev `sellerBatch`: the first graduated sale's batch, whose fee the public step sold (0 without batches).
    function _properties(BoxCoordinatorV2 b, BoxSpec memory s, string memory json, uint256 sellerBatch) private {
        IBoxReceiverV2 receiver = IBoxReceiverV2(b.receiver());
        BoxTokenV2 t = BoxTokenV2(b.token());
        bool itemsInT = (s.buyers.a.dest == 8 && s.buyers.a.leg == 2) || (s.sellers.a.dest == 8 && s.sellers.a.leg == 2);
        uint256 itemId = s.artMode == 2 ? _hiddenRoundTrip(b, vm.parseJsonString(json, ".id")) : 1;
        if (s.boxType == 1 && itemsInT) {
            if (s.artMode != 2) _withdrawLocalItem(b);
            // v2.1 step 2: the fees wait as P until a purchase reaches the step minimum; it buys T for the items.
            uint256 minimum = localFactory.boxQParameters(s.pricing.listingId, s.raise).swapStepMinQ;
            IBoxReceiverPayInTV21 rewards = IBoxReceiverPayInTV21(address(receiver));
            for (uint256 i; i < 32 && !_rewardsReady(rewards, minimum); ++i) {
                _tradeLocal(b);
                _sellLocalFees(b);
                receiver.collect(address(0));
            }
            assertTrue(_rewardsReady(rewards, minimum));
            uint256 supplyBefore = t.totalSupply();
            ItemLedgerV2 ledger = ItemLedgerV2(b.roleAddress(16));
            uint256 outside;
            uint256 stash;
            // A buyers' Burn can take the first buyBack step. Keep stepping until the item side is actually paid.
            for (uint256 step; step < 8 && outside + stash == 0; ++step) {
                _beforeLocalTransaction();
                receiver.buyBack(address(0));
                ledger.sync(32);
                (outside, stash) = ledger.itemCreditT(itemId);
            }
            assertGt(outside + stash, 0, "the item side must execute before claiming");
            if (s.artMode == 2) assertLt(t.totalSupply(), supplyBefore, "inside item share burns box tokens");
            uint256 before = t.balanceOf(OWNER);
            uint256[] memory ids = new uint256[](1);
            ids[0] = itemId;
            ledger.claimT(ids, OWNER);
            assertGt(outside + stash, 0);
            assertEq(t.balanceOf(OWNER) - before, outside + stash);
        } else if (s.boxType == 1 && (s.buyers.a.dest == 8 || s.sellers.a.dest == 8)) {
            _withdrawLocalItem(b);
            _tradeLocal(b);
            _sellLocalFees(b);
            receiver.collect(address(0));
            IItemLedgerV2 ledger = IItemLedgerV2(b.roleAddress(16));
            ledger.sync(32);
            (uint256 outside, uint256 stash) = ledger.itemCredit(1);
            uint256 before = _money(b.q(), OWNER);
            uint256[] memory ids = new uint256[](1);
            ids[0] = 1;
            ledger.claim(ids, OWNER);
            assertGt(outside + stash, 0);
            assertEq(_money(b.q(), OWNER) - before, outside + stash);
        }
        if (_hasProperty(json, "supply-burn") && !(s.artMode == 2 && s.buyers.a.leg == 1)) {
            assertGt(receiver.buyBackP(), 0);
            uint256 minimum = localFactory.boxQParameters(s.pricing.listingId, s.raise).swapStepMinQ;
            for (uint256 i; i < 32 && receiver.buyBackP() < minimum; ++i) {
                _tradeLocal(b);
                _sellLocalFees(b);
                receiver.collect(address(0));
            }
            assertGe(receiver.buyBackP(), minimum);
            uint256 supply = t.totalSupply();
            _beforeLocalTransaction();
            receiver.buyBack(address(0));
            assertLt(t.totalSupply(), supply);
        }
        if ((s.buyers.a.leg == 1 && s.buyers.a.dest == 1) || (s.sellers.a.leg == 1 && s.sellers.a.dest == 1)) {
            // v2.1 step 1: after graduation anyone eats the pending price coin; an unchecked coin is locked at 0xdEaD.
            IBoxReceiverEatV21 eat = IBoxReceiverEatV21(address(receiver));
            uint256 pending = eat.eatPendingP();
            assertGt(pending, 0);
            uint256 dead = _money(b.q(), address(0xdEaD));
            bool checkedFrog = _is(vm.parseJsonString(json, ".priceCoin.symbol"), "TEST_FROG");
            uint256 supply = checkedFrog ? TestCoin(b.q()).totalSupply() : 0;
            _beforeLocalTransaction();
            assertEq(eat.eatPriceCoin(), pending);
            assertEq(eat.eatPendingP(), 0);
            assertEq(eat.eatenP(), pending);
            if (checkedFrog) {
                assertEq(eat.priceBurnSelector(), TestFrog.burn.selector);
                assertEq(TestCoin(b.q()).totalSupply(), supply - pending);
                assertEq(_money(b.q(), address(0xdEaD)), dead);
            } else {
                assertEq(eat.priceBurnSelector(), bytes4(0));
                assertEq(_money(b.q(), address(0xdEaD)) - dead, pending);
            }
        }
        if (s.buyers.a.dest == 4 || s.sellers.a.dest == 4) {
            IBoxHookV2 h = IBoxHookV2(b.hook());
            uint128 liquidity = h.pairedLiquidity();
            _beforeLocalTransaction();
            h.deepen(address(0));
            assertGt(h.pairedLiquidity(), liquidity);
        }
        if (s.buyers.a.dest == 6) {
            IHolderLedgerV2 ledger = IHolderLedgerV2(b.roleAddress(17));
            // F137 burns sale fees before graduation, so seller batch 2 is empty: claim the first graduated sale's.
            uint256 batch = s.sellers.a.dest == 6 ? sellerBatch : sellerBatch - 1;
            ledger.settleBatch(batch, 64);
            uint256 quote = ledger.claimable(batch, OWNER);
            uint256 before = _money(b.q(), OWNER);
            assertGt(quote, 0);
            ledger.claim(batch, OWNER);
            assertEq(_money(b.q(), OWNER) - before, quote);
        }
        if (s.addOns.length > 0 && s.addOns[0].id == 4) {
            // Split like a buyers' fee (2:1:2:10); the side's carry or dust absorbs the remainder below 15 wei.
            uint256[3] memory before = [receiver.fitOwed(), receiver.platformOwed(), receiver.creatorP()];
            receiver.fundRoyalty{value: 0.025 ether}(address(0), 0.025 ether);
            uint256 unit = receiver.platformOwed() - before[1];
            assertApproxEqAbs(15 * unit, 0.025 ether, 14);
            assertEq(receiver.fitOwed() - before[0], 2 * unit);
            assertEq(receiver.creatorP() - before[2], s.buyers.a.dest == 2 ? 10 * unit : 0);
        }
        if (s.creatorFeeRecipient != address(0)) {
            uint256 quote = receiver.creatorP();
            uint256 before = _money(b.q(), OWNER);
            assertGt(quote, 0);
            receiver.claimCreator(b.q(), OWNER);
            assertEq(_money(b.q(), OWNER) - before, quote);
        }
        if (s.boxType == 5) {
            IPileVaultV2 pile = IPileVaultV2(b.vault());
            (address asset,) = abi.decode(s.contentsParams, (address, uint256));
            uint256 moved;
            if (s.buyers.a.dest == 7 || s.sellers.a.dest == 7) {
                IBoxReceiverPileV21 fees = IBoxReceiverPileV21(address(receiver));
                moved = fees.pilePendingP(); assertGt(moved, 0);
                assertEq(_money(asset, address(pile)), _raw(json, ".contents.seed.amount"));
                assertEq(fees.moveToPile(), moved); assertEq(fees.pilePendingP(), 0);
                assertEq(_money(asset, address(pile)), _raw(json, ".contents.seed.amount") + moved);
            }
            uint256 supply = t.totalSupply();
            uint256 amount = t.balanceOf(OWNER) / 4;
            uint256 quote = _money(asset, address(pile)) * amount / supply;
            if (s.contentsParams.length == 96) {
                (,, uint16 leave) = abi.decode(s.contentsParams, (address, uint256, uint16));
                quote = quote * (10_000 - leave) / 10_000;
            }
            uint256 pileBefore = _money(asset, address(pile));
            assertEq(pile.quoteRedeem(amount), quote);
            t.approve(address(pile), amount);
            uint256 before = _money(asset, OWNER);
            pile.redeem(amount, quote, OWNER);
            assertEq(_money(asset, OWNER) - before, quote);
            assertEq(t.totalSupply(), supply - amount);
            assertEq(_money(asset, address(pile)), pileBefore - quote);
        }
    }

    // ── Link Marines version 2 (F151): the marines' rations in LINK, the inside shares to the box's own pool ─────────

    uint256 private constant MARINES = 420;

    /// @dev The receiver's books, and the P claims held by the hook (the box's own pool depth), the item ledger and
    /// the receiver itself; `receipts` is the receiver's last item funding receipt.
    struct Books {
        uint256 booked;
        uint256 fit;
        uint256 platform;
        uint256 pool;
        uint256 creator;
        uint256 buyBack;
        uint256 held;
        uint256 royalty;
        uint256 hook;
        uint256 ledger;
        uint256 receiverClaims;
        uint256 receipts;
    }

    /// @dev Marine 1's share of the receipts funded while it was out of the vault, the item ledger's rounding from
    /// dividing each receipt by 420, and the fee sides that funded them (bit 1 buyers, bit 2 sellers).
    struct Rations {
        uint256 credit;
        uint256 residue;
        uint256 sides;
    }

    /// @dev F151's recipe: 420 marines priced in LINK; on both fee sides the box's 10 of 15 parts go equally to the
    /// marines in LINK and their owners claim them; the share of marines still inside goes to the box's own pool
    /// (v2.1 step 5, Depth); 2.5% royalties are booked like the buyers' fees. The box is created from its kit's own
    /// download, and every marine is revealed from that download's list.
    function _rationsLife(string memory id) internal {
        (localFactory,) = _run();
        vm.warp(block.timestamp + 1 days); // Release actions become selectable at the fixed directory delay.
        localActor = OWNER;
        localSwapper = new PriceLimitSwapper(IPoolManager(manager));
        vm.deal(OWNER, 200 ether);
        string memory json = _row(id);
        string memory directory = _hiddenDirectory(id);
        string memory download = vm.readFile(string.concat(directory, "/download.json"));
        BoxSpec memory s = _kitSpec(json, download);
        vm.startPrank(OWNER);
        BoxCoordinatorV2 b = _createLoaded(s);
        _openReveals(b, s, download, directory);
        _rationsBeforeGraduation(b, id);
        _rationsAtGraduation(b);
        Rations memory owed = _rationsAfterGraduation(b);
        Rations memory royalty = _royaltyRations(b, json);
        owed.credit += royalty.credit;
        owed.residue += royalty.residue;
        _claimRations(b, owed);
        _poolGrows(b);
        assertEq(IBoxReceiverV2(b.receiver()).creatorP(), 0, "no fee or royalty goes to the creator");
        _safe(IBoxReceiverV2(b.receiver()), s.pricing.token);
        vm.stopPrank();
    }

    /// @dev The kit's own download (prepare-hidden.mjs: the kit tooling's Download BoxSpec bytes, read by the
    /// reviewed open reveal reader), checked against the registry row, then bound as Create binds a loaded kit: the
    /// local LINK listing at the row's raise, and the creator's own address as owner and payee.
    function _kitSpec(string memory json, string memory download) private returns (BoxSpec memory s) {
        s = abi.decode(vm.parseJsonBytes(download, ".encoded"), (BoxSpec));
        assertEq(keccak256(abi.encode(s)), vm.parseJsonBytes32(download, ".specHash"));
        assertEq(s.revealRoot, vm.parseJsonBytes32(download, ".revealRoot"));
        assertEq(s.revealListId, vm.parseJsonBytes32(download, ".revealListId"));
        _assertKitContents(s, json);
        _assertKitBranch(s.buyers.a, s.buyers.split, json, "buyers");
        _assertKitBranch(s.sellers.a, s.sellers.split, json, "sellers");
        _assertKitRoyalty(s, json);
        s.raise = _raw(json, ".raise.amount");
        s.marketplaceOwner = OWNER;
        s.creatorFeeRecipient = OWNER;
        _price(s, vm.parseJsonString(json, ".priceCoin.symbol"));
        assertEq(LocalPriceCoinSymbol(s.pricing.token).symbol(), "LINK");
    }

    function _assertKitContents(BoxSpec memory s, string memory json) private pure {
        assertEq(s.tokenName, vm.parseJsonString(json, ".name"));
        assertEq(s.tokenSymbol, vm.parseJsonString(json, ".ticker"));
        assertEq(uint256(s.boxType), 1);
        assertEq(uint256(s.n), _raw(json, ".contents.size"));
        assertEq(uint256(s.n), MARINES);
        assertEq(uint256(s.firstId), 1);
        assertEq(uint256(s.artMode), 1);
        assertEq(uint256(s.pickFeeBps), _raw(json, ".contents.pickFeeBps"));
        assertEq(uint256(s.deadlineDays), _raw(json, ".deadline.days"));
        assertEq(s.creatorBuy, 0);
    }

    /// @dev One fee side as the row names it: To items in the price coin with Depth (destination parameter 3).
    function _assertKitBranch(Branch memory actual, uint8 split, string memory json, string memory side) private pure {
        bytes32 expected = keccak256(abi.encode(_branch(json, side)));
        assertEq(keccak256(abi.encode(actual)), expected, side);
        assertEq(uint256(split), 1);
    }

    /// @dev R53 G-J (F138): royalties are booked like the buyers' fees; destination 1 is the only one.
    function _assertKitRoyalty(BoxSpec memory s, string memory json) private pure {
        uint256 royalties;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != 4) continue;
            (uint16 bps, uint8 destination) = abi.decode(s.addOns[i].params, (uint16, uint8));
            assertEq(uint256(bps), _raw(json, ".royalties.bps"));
            assertEq(uint256(destination), 1);
            ++royalties;
        }
        assertEq(royalties, 1);
        assertEq(vm.parseJsonString(json, ".royalties.destination"), "fees");
    }

    /// @dev Every marine revealed from the download's own reveal list, as the creator does after creation
    /// (open-reveals.json in the launch pack): each call was prepared from the list by the reviewed open reveal tools,
    /// and the created collection commits its root, so the list is this box's own. Then, for every marine, its call
    /// is refused a second time and the committed table shows its own Variant, Rank and Squad in tokenJSON.
    function _openReveals(BoxCoordinatorV2 b, BoxSpec memory s, string memory download, string memory directory)
        private
    {
        BoxCollectionV2 c = BoxCollectionV2(b.collection());
        assertEq(c.revealRoot(), s.revealRoot, "the download's reveal list is this box's own");
        assertEq(c.revealedCount(), 0);
        bytes[] memory calls = vm.parseJsonBytesArray(download, ".calls");
        _revealAll(c, calls, vm.parseJsonBytes32Array(download, ".images"));
        assertEq(c.revealedCount(), MARINES);
        // Read once: the attributes of all 420 marines, as the kit assigned them.
        string memory attributes = vm.readFile(string.concat(directory, "/attributes.json"));
        for (uint256 id = 1; id <= MARINES; ++id) {
            (bool again,) = address(c).call(calls[id - 1]);
            assertFalse(again, "a marine is revealed once");
            _assertTraits(c.tokenJSON(id), attributes, id);
        }
        assertEq(c.revealedCount(), MARINES);
    }

    function _revealAll(BoxCollectionV2 c, bytes[] memory calls, bytes32[] memory images) private {
        assertEq(calls.length, MARINES);
        assertEq(images.length, MARINES);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = address(c).call(calls[i]);
            assertTrue(ok, "a prepared open reveal reverted");
            _assertRevealed(c, i + 1, images[i]);
        }
    }

    function _assertRevealed(BoxCollectionV2 c, uint256 id, bytes32 image) private view {
        (bool revealed,, bytes32 shown,) = c.traitsOf(id);
        assertTrue(revealed);
        assertEq(shown, image);
    }

    /// @dev Before graduation every marine is inside: each fee's pool parts and the marines' rations wait in the box.
    function _rationsBeforeGraduation(BoxCoordinatorV2 b, string memory id) private {
        uint256 start = b.effectiveOpenAt() + 384;
        if (block.timestamp < start) vm.warp(start);
        vm.roll(block.number + 1);
        IBoxReceiverV2 receiver = IBoxReceiverV2(b.receiver());
        _tradeLocal(b);
        Books memory a = _books(b);
        FeeBatchV2 memory fees = receiver.collect(address(0));
        _heldRations(b, a, fees.buyersP + fees.sellersP);
        emit log_string(string.concat("REPLAY_ID|", id));
        emit log_string(string.concat("REPLAY_CARRY|", vm.toString(fees.buyersP % 15), "|", vm.toString(fees.sellersP % 15)));
        _fillLocal(b);
        _beforeLocalTransaction();
        a = _books(b);
        fees = receiver.collect(address(0)); // Match the browser: collect all outstanding fees before graduation.
        _heldRations(b, a, fees.buyersP + fees.sellersP);
        assertGt(receiver.itemsHeldP(), 0, "the rations wait for graduation");
    }

    /// @dev Graduation, replayed through the browser suite's accounting: every marine is still inside, so both sides'
    /// held rations, their remainders included, go to the box's own pool with its held parts, and no marine is paid.
    function _rationsAtGraduation(BoxCoordinatorV2 b) private {
        Books memory a = _books(b);
        _capture(b, "before");
        vm.recordLogs();
        b.graduate();
        _captureLogs();
        _capture(b, "after");
        assertTrue(b.graduated());
        assertFalse(b.failed());
        Books memory z = _books(b);
        assertEq(z.held + z.pool, 0, "nothing waits in the box after graduation");
        assertEq(z.receipts, a.receipts + 2, "each side publishes its one release receipt");
        uint256 released;
        for (uint256 i = a.receipts + 1; i <= z.receipts; ++i) {
            ItemFundingV2 memory f = IBoxReceiverItemsV2(b.receiver()).itemFunding(i);
            assertEq(uint256(f.source), 3);
            assertEq(uint256(f.side), i - a.receipts);
            assertEq(uint256(f.insideCount), MARINES);
            assertEq(f.ledgerP, 0, "no marine is paid at graduation");
            released += f.choiceP;
        }
        assertEq(released, a.held, "both sides' held rations are released");
        assertEq(z.ledger, a.ledger);
        assertEq(a.booked - z.booked, a.held + a.pool, "the held rations and pool parts leave the books");
        assertGe(z.hook - a.hook, a.held + a.pool, "and reach the box's own pool");
        assertEq(z.fit, a.fit);
        assertEq(z.platform, a.platform);
    }

    /// @dev After graduation, first with every marine inside, then with marine 1 out of the vault: both sides' fees
    /// pay the marines, marine 1's share waits in the item ledger and the rest goes to the box's own pool.
    function _rationsAfterGraduation(BoxCoordinatorV2 b) private returns (Rations memory owed) {
        _tradeLocal(b);
        _sellLocalFees(b);
        // All 420 inside: each receipt's whole share goes to the pool but its rounding, which the ledger keeps.
        owed.residue = _collectRations(b, MARINES).residue;
        _withdrawLocalItem(b);
        assertEq(BoxCollectionV2(b.collection()).ownerOf(1), OWNER);
        assertEq(BoxVaultV2(b.vault()).inside(), MARINES - 1);
        for (uint256 i; i < 8 && owed.sides != 6; ++i) {
            _tradeLocal(b);
            _sellLocalFees(b);
            Rations memory r = _collectRations(b, MARINES - 1);
            owed.credit += r.credit;
            owed.residue += r.residue;
            owed.sides |= r.sides;
        }
        assertEq(owed.sides, 6, "both fee sides pay the marines");
        assertGt(owed.credit, 0);
    }

    function _collectRations(BoxCoordinatorV2 b, uint256 inside) private returns (Rations memory) {
        Books memory a = _books(b);
        _beforeLocalTransaction();
        FeeBatchV2 memory fees = IBoxReceiverV2(b.receiver()).collect(address(0));
        return _rations(b, a, fees.buyersP + fees.sellersP, inside);
    }

    /// @dev 2.5% royalties into the fee handling: a marketplace pays LINK to the collection's royalty receiver, the
    /// box's inbox; anyone delivers it to the receiver, which books it like a buyers' fee, rations included.
    function _royaltyRations(BoxCoordinatorV2 b, string memory json) private returns (Rations memory r) {
        // A sale of marine 1 at 100 LINK.
        (address inbox, uint256 royalty) = BoxCollectionV2(b.collection()).royaltyInfo(1, 100 ether);
        assertEq(royalty, 100 ether * _raw(json, ".royalties.bps") / 10_000);
        assertEq(inbox, b.roleAddress(8));
        _beforeLocalTransaction();
        LocalPriceCoin(b.q()).transfer(inbox, royalty);
        Books memory a = _books(b);
        _beforeLocalTransaction();
        assertEq(IBoxRoyaltyRouterV2(payable(inbox)).sweepPriceCoin(), royalty);
        assertEq(LocalPriceCoin(b.q()).balanceOf(inbox), 0);
        r = _rations(b, a, royalty, MARINES - 1);
        assertEq(r.sides, 2, "a royalty is booked on the buyers' side");
    }

    /// @dev Marine 1's owner claims its rations in LINK: exactly its equal share of every receipt since it left the
    /// vault. The rounding the ledger kept then goes to the box's own pool, and the ledger holds nothing back.
    function _claimRations(BoxCoordinatorV2 b, Rations memory owed) private {
        ItemLedgerV2 ledger = _syncedLedger(b);
        (uint256 outside, uint256 stash) = ledger.itemCredit(1);
        assertEq(stash, 0, "Depth keeps no inside stash");
        assertEq(outside, owed.credit, "marine 1's equal share of each receipt since it left the vault");
        uint256 before = _money(b.q(), OWNER);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        _beforeLocalTransaction();
        ledger.claim(ids, OWNER);
        assertEq(_money(b.q(), OWNER) - before, outside, "its owner claims it in LINK");
        (outside, stash) = ledger.itemCredit(1);
        assertEq(outside + stash, 0);
        _flushRations(b, ledger, owed.residue);
    }

    function _syncedLedger(BoxCoordinatorV2 b) private returns (ItemLedgerV2 ledger) {
        ledger = ItemLedgerV2(b.roleAddress(16));
        uint256 receipts = IBoxReceiverItemsV2(b.receiver()).itemFundingCount();
        uint256 lifecycle = BoxVaultV2(b.vault()).itemLifecycleCount();
        for (uint256 i; i < 16 && (ledger.fundingCursor() != receipts || ledger.lifecycleCursor() != lifecycle); ++i) {
            _beforeLocalTransaction();
            ledger.sync(32);
        }
        assertEq(ledger.fundingCursor(), receipts);
        assertEq(ledger.lifecycleCursor(), lifecycle);
    }

    /// @dev The rounding from dividing each receipt by 420 goes to the box's own pool; nothing stays in the ledger.
    function _flushRations(BoxCoordinatorV2 b, ItemLedgerV2 ledger, uint256 residue) private {
        IPoolManager pm = IPoolManager(manager);
        uint256 p = uint160(b.q());
        uint256 depth = pm.balanceOf(b.hook(), p);
        _beforeLocalTransaction();
        assertEq(ledger.flushResidue(), residue, "the rounding from dividing by 420");
        assertEq(pm.balanceOf(b.hook(), p) - depth, residue, "goes to the box's own pool");
        assertEq(pm.balanceOf(address(ledger), p), 0, "every ration was claimed or went to the pool");
    }

    /// @dev What reached the hook (the pool's parts, the inside marines' shares, the rounding) is the box's depth
    /// budget; anyone's deepen adds it to the box's own pool.
    function _poolGrows(BoxCoordinatorV2 b) private {
        IBoxHookV2 h = IBoxHookV2(b.hook());
        assertGt(h.depthBudget(), 0);
        uint128 liquidity = h.pairedLiquidity();
        _beforeLocalTransaction();
        (ProtocolSkip skip, uint256 qUsed,,) = h.deepen(address(0));
        assertEq(uint256(skip), uint256(ProtocolSkip.None));
        assertGt(qUsed, 0);
        assertGt(h.pairedLiquidity(), liquidity, "the box's own pool is deeper");
    }

    function _books(BoxCoordinatorV2 b) private view returns (Books memory k) {
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        address p = b.q();
        k.booked = r.booked(p);
        k.fit = r.fitOwed();
        k.platform = r.platformOwed();
        k.pool = r.poolHeldP();
        k.creator = r.creatorP();
        k.buyBack = r.buyBackP();
        k.held = r.itemsHeldP();
        k.royalty = r.royaltyHeldP();
        k.receipts = IBoxReceiverItemsV2(address(r)).itemFundingCount();
        _claims(b, k);
    }

    /// @dev The P claims of the hook (the box's own pool depth), the item ledger and the receiver.
    function _claims(BoxCoordinatorV2 b, Books memory k) private view {
        IPoolManager pm = IPoolManager(manager);
        uint256 p = uint160(b.q());
        k.hook = pm.balanceOf(b.hook(), p);
        k.ledger = pm.balanceOf(b.roleAddress(16), p);
        k.receiverClaims = pm.balanceOf(b.receiver(), p);
    }

    /// @dev A fee intake before graduation: each source splits 2:1:2:10; the pool's 2 parts and the marines' 10 wait
    /// in the box, its rounding dust goes to the pool, and no marine is paid.
    function _heldRations(BoxCoordinatorV2 b, Books memory a, uint256 amount) private view {
        Books memory z = _books(b);
        uint256 unit = z.platform - a.platform;
        assertGt(unit, 0);
        assertEq(z.fit - a.fit, 2 * unit, "2 parts to FIT");
        assertEq(z.pool - a.pool, 2 * unit, "the pool's 2 parts wait in the box");
        assertEq(z.held - a.held, 10 * unit, "the marines' 10 parts wait in the box");
        assertEq(z.booked - a.booked, 15 * unit);
        assertEq(z.hook - a.hook, amount - 15 * unit, "rounding dust goes to the pool");
        assertEq(z.receipts, a.receipts, "no marine is paid before graduation");
        assertEq(z.ledger, a.ledger);
        assertEq(z.creator + z.buyBack + z.royalty, a.creator + a.buyBack + a.royalty);
        assertGe(z.receiverClaims, z.booked);
    }

    /// @dev A fee intake after graduation (a collect, or a delivered royalty): each source splits 2:1:2:10 and nothing
    /// is held. Under Depth a receipt leaves floor(S/420) in the item ledger for each marine outside the vault, plus
    /// the rounding S%420, and sends the inside marines' shares to the box's own pool, with its 2 parts and the dust.
    function _rations(BoxCoordinatorV2 b, Books memory a, uint256 amount, uint256 inside)
        private
        view
        returns (Rations memory r)
    {
        Intake memory k;
        (k.a, k.z, k.amount, k.inside) = (a, _books(b), amount, inside);
        k.unit = k.z.platform - a.platform;
        _assertLiveSplit(k);
        IBoxReceiverItemsV2 receipts = IBoxReceiverItemsV2(b.receiver());
        for (uint256 i = a.receipts + 1; i <= k.z.receipts; ++i) _tallyReceipt(receipts.itemFunding(i), k, r);
        _assertLiveTotals(k);
    }

    /// @dev One post-graduation intake: the books before and after, the P it brought, the marines inside, its 15-part
    /// unit, and what its receipts add up to (the marines' parts, the inside shares, the item ledger's part).
    struct Intake {
        Books a;
        Books z;
        uint256 amount;
        uint256 inside;
        uint256 unit;
        uint256 choices;
        uint256 pooled;
        uint256 paid;
    }

    function _assertLiveSplit(Intake memory k) private pure {
        assertGt(k.unit, 0);
        assertEq(k.z.fit - k.a.fit, 2 * k.unit, "2 parts to FIT");
        assertEq(k.z.booked - k.a.booked, 3 * k.unit, "only the Safes' 3 parts stay booked");
        assertEq(k.z.pool + k.z.held + k.z.royalty, 0, "nothing waits in the box after graduation");
        assertEq(k.z.creator, k.a.creator);
        assertEq(k.z.buyBack, k.a.buyBack);
    }

    function _tallyReceipt(ItemFundingV2 memory f, Intake memory k, Rations memory r) private pure {
        assertTrue(f.source == 1 || f.source == 2);
        assertEq(uint256(f.insideCount), k.inside);
        uint256 u = f.choiceP / MARINES;
        // Every receipt of either side proves its own inside share: a side whose receipts were too small to give each
        // marine a unit would otherwise pass on the other side's pooled shares.
        if (k.inside != 0) assertGt(u, 0, "each side's receipt sends an inside share to the pool");
        assertEq(f.ledgerP, f.choiceP - k.inside * u, "Depth: the inside marines' shares never reach the item ledger");
        k.choices += f.choiceP;
        k.pooled += k.inside * u;
        k.paid += f.ledgerP;
        if (k.inside < MARINES) r.credit += u;
        r.residue += f.choiceP % MARINES;
        r.sides |= uint256(1) << f.side;
    }

    function _assertLiveTotals(Intake memory k) private pure {
        assertEq(k.choices, 10 * k.unit, "the marines get 10 of 15 parts");
        assertGt(k.pooled, 0);
        assertEq(k.z.ledger - k.a.ledger, k.paid);
        assertEq(k.z.hook - k.a.hook, 2 * k.unit + k.pooled + k.amount - 15 * k.unit, "the pool gets its parts, the inside shares, the dust");
        assertGe(k.z.receiverClaims, k.z.booked);
    }
}

/// @notice Local fixture metadata only.
interface LocalPriceCoinSymbol {
    function symbol() external view returns (string memory);
}
