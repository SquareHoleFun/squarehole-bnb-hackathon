// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxRegistry} from "../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {CoreBox0Kit, CoreBoxAddresses, CoreImpls} from "../conformance/core/CoreBox0Kit.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {ClaimsDuster} from "./BoxS7Base.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice Box 0 through factory v1, then its life (slice S7's built provider): BC-026's graduation with the real S3
/// vault and tickets and S8's per-Misfit stream at N 69 and 10,000 (the core harness builds 4,269; S6 used stand-ins),
/// BC-066's placeholders taken and handed back during the curve, and BC-011's dust at every predicted address, which
/// neither blocks the creation nor the life after it. `CoreBox0Kit` deploys the version with the script's steps and
/// creates box 0 with createBox.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1LifeTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    CoreBox0Kit internal kit;
    bytes internal _fixtureEncoded;

    function setUp() public {
        _fixtureEncoded = vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]");
        kit = new CoreBox0Kit();
        kit.setUpWorld();
    }

    /// @dev Box 0's fixture as it is (with its per-item stream since the S7 × S8 integration).
    function _spec() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(_fixtureEncoded, (BoxSpecV1.BoxSpec));
    }

    /// BC-026 (S7's built provider): box 0 at N 69 and at N 10,000, built by the factory with the real S3 vault and
    /// tickets and S8's stream, closes in its filling swap and graduates with every poke succeeding: the receiver
    /// settles, the tickets request their graduation word from the pinned source, FIT's executor reads box 0 as
    /// graduated, the stream starts, the vault's gate opens; all N stay the vault's or the placeholder holders', and the
    /// stream counts exactly the vault's outside slots.
    function test_BC026_graduationAtN69And10000ThroughTheFactory() public {
        uint32[2] memory ns = [uint32(69), 10_000];
        for (uint256 i; i < ns.length; ++i) {
            uint256 snap = vm.snapshotState();
            BoxSpecV1.BoxSpec memory s = _spec();
            s.n = ns[i];
            kit.build(s);
            kit.toGraduated();
            CoreBoxAddresses memory a = kit.addresses();
            assertEq(kit.pokeFailures(), 0, "every poke succeeded");
            assertTrue(BoxCoordinator(a.coordinator).graduated(), "graduated");
            assertTrue(BoxVault(a.vault).gateOpen(), "the vault's gate opened");
            assertGt(BoxTickets(a.tickets).status().wordRequestedAt, 0, "the tickets requested their word");
            IBoxItemStream st = IBoxItemStream(a.itemStream);
            assertTrue(st.started(), "the stream started at graduation (the coordinator's poke)");
            assertEq(st.collectionSize(), ns[i], "the stream's N");
            assertEq(st.outsideCount(), ns[i] - BoxVault(a.vault).inside(), "m = N - n");
            assertEq(BoxCollection(a.collection).totalSupply(), ns[i], "N items");
            assertEq(
                BoxVault(a.vault).inside() + BoxVault(a.vault).outside(),
                ns[i],
                "every item inside or outside the vault"
            );
            assertEq(BoxRegistry(kit.impls().registry).boxCount(), 1);
            vm.revertToState(snap);
        }
    }

    /// BC-066 (version 1, box 0): the placeholders add-on works on the factory's box 0 as today: from the open a holder
    /// takes placeholders against T during the curve and hands one back (its fee burned unless waived), the vault
    /// counting each; nothing is delivered before graduation.
    function test_BC066_box0sPlaceholdersAreTakenAndHandedBackDuringTheCurve() public {
        kit.build(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        address alice = makeAddr("s7.life.alice");
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        kit.buy(alice, 1 ether, 0);
        BoxTickets t = BoxTickets(a.tickets);
        vm.startPrank(alice);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        uint256 first = t.take(2, type(uint256).max, block.timestamp);
        assertEq(BoxVault(a.vault).pendingTickets(), 2, "two placeholders out");
        uint256 tBefore = BoxToken(a.token).balanceOf(alice);
        uint256[] memory back = new uint256[](1);
        back[0] = first;
        (uint256 principal, uint256 fee) = t.handBack(back, 0, block.timestamp);
        vm.stopPrank();
        assertEq(BoxVault(a.vault).pendingTickets(), 1, "one handed back");
        assertEq(BoxToken(a.token).balanceOf(alice), tBefore + principal - fee, "its T back, less the fee");
        assertFalse(BoxVault(a.vault).gateOpen(), "nothing delivered before graduation");
        assertEq(BoxVault(a.vault).shelfCount(), 0);
    }

    /// BC-011: 1 wei of ETH and of ETH claims (ERC-6909 on the PoolManager) sent beforehand to every address box 0 will
    /// have neither blocks createBox nor its life: every balance is compared with its earlier value (FitPoolGenesis's
    /// rule), the dust stays where it was sent, and no ledger counts it (the launch router's tax, the coordinator's D6
    /// reserve).
    function test_BC011_dustAtEveryPredictedAddressBlocksNothing() public {
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        address[12] memory targets = [
            a.coordinator,
            a.token,
            a.collection,
            a.vault,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.executor,
            a.table,
            a.itemStream
        ];
        ClaimsDuster duster = new ClaimsDuster(IPoolManager(a.poolManager));
        vm.deal(address(this), 1 ether);
        for (uint256 i; i < targets.length; ++i) {
            (bool ok,) = payable(targets[i]).call{value: 1}("");
            assertTrue(ok, "ETH to a codeless address");
            duster.dust{value: 1}(targets[i], 1);
            assertEq(IPoolManager(a.poolManager).balanceOf(targets[i], 0), 1, "1 wei of ETH claims");
        }
        // ETH forced into the factory too (it has no receive): its own balance check compares with the earlier value.
        vm.deal(address(kit.factory()), 1);
        kit.create();
        assertEq(address(kit.factory()).balance, 1, "the factory kept exactly what it held before");
        assertEq(BoxLaunchRouter(payable(a.launchRouter)).totalTaxCollected(), 0, "the router counts no dust as tax");
        assertEq(a.launchRouter.balance, 1, "the dust stays");
        assertEq(BoxCoordinator(a.coordinator).reserve(), 0, "the D6 reserve counts no dust");
        assertEq(BoxRegistry(kit.impls().registry).boxCount(), 1, "box 0 recorded");
        kit.toGraduated();
        assertEq(kit.pokeFailures(), 0, "the life runs as without dust");
        assertTrue(BoxCoordinator(a.coordinator).graduated());
    }

    /// BC-123 (S7's built provider: S3's vault beside S4's hook on one box): on the factory's box 0 after graduation,
    /// FIT's executor's 1-hour average built from real pokes, depth on both sides (the 2/15 a busy box gathers, given
    /// here as a fundDepth() gift and the hook's T claims from a real buy), `deepen()` pairs and locks (F77) and moves
    /// T only from the hook's claims into the pool: T's supply, the vault's escrow and both vault quotes are the same
    /// before and after the add.
    function test_BC123_vaultQuotesUnmovedByADepthAddOnTheFactorysBox0() public {
        kit.build(_spec());
        kit.toGraduated();
        CoreBoxAddresses memory a = kit.addresses();
        _giveDepthBothSides(a);
        _buildTheAverage(a);
        BoxVault v = BoxVault(a.vault);
        uint256[5] memory before = [
            BoxToken(a.token).totalSupply(),
            v.quoteWithdraw(1),
            v.quoteReturn(1),
            v.escrowPrincipal(),
            BoxToken(a.token).balanceOf(a.vault)
        ];
        (DepthKind kind, DeepenSkip skip,, uint256 tUsed,) = BoxHook(a.hook).deepen(makeAddr("s7.life.keeper"));
        assertEq(uint256(skip), uint256(DeepenSkip.None), "the add ran");
        assertEq(uint256(kind), uint256(DepthKind.Pair), "box 0 pairs and locks (F77)");
        assertGt(tUsed, 0, "T from the hook's claims into the pool");
        assertEq(BoxToken(a.token).totalSupply(), before[0], "no T minted or burned by an add");
        assertEq(v.quoteWithdraw(1), before[1], "the withdraw quote is the same");
        assertEq(v.quoteReturn(1), before[2], "the return quote is the same");
        assertEq(v.escrowPrincipal(), before[3], "the escrow is untouched");
        assertEq(BoxToken(a.token).balanceOf(a.vault), before[4], "nothing reaches the vault");
    }

    /// @dev The hook's T side: a real buy's T deposited as the hook's claims; its Q side: a fundDepth() gift.
    function _giveDepthBothSides(CoreBoxAddresses memory a) internal {
        address bob = makeAddr("s7.life.bob");
        uint256 t = kit.buy(bob, 2 ether, 0);
        new ClaimsFunder(IPoolManager(a.poolManager)).deposit(a.token, bob, t, a.hook);
        vm.deal(address(this), 2 ether);
        BoxReceiverDepth(a.receiver).fundDepth{value: 2 ether}();
    }

    /// @dev FIT's executor's average: its sample walks at most 100 ticks per observation (one per block) to the price,
    /// then an hour of checkpoints (13 pokes, 25 blocks and 300 s apart; past the 300-block depth cooldown too).
    function _buildTheAverage(CoreBoxAddresses memory a) internal {
        PoolKey memory key = kit.poolKey();
        FitBuybackExecutor exe = FitBuybackExecutor(payable(a.executor));
        (, int24 spot,,) = IPoolManager(a.poolManager).getSlot0(key.toId());
        for (uint256 i; i < 1_000 && exe.latestSampleTick() != spot; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            exe.poke();
        }
        assertEq(exe.latestSampleTick(), spot, "the sample reached the price");
        for (uint256 i; i < 13; ++i) {
            vm.roll(block.number + 25);
            vm.warp(block.timestamp + 300);
            exe.poke();
        }
        (bool ready,,) = exe.twap();
        assertTrue(ready, "the 1-hour average is ready");
    }

    receive() external payable {}
}

interface BoxReceiverDepth {
    function fundDepth() external payable;
}
