// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {ClaimsDuster} from "../../s7/BoxS7Base.sol";
import {AuditU1FablePreWorld} from "./AuditU1FableBase.sol";

/// @notice SH-AUDIT-B0 U1 (Fable), L1 P1.2: ETH and ETH claims sent in advance to every address the factory fixed
/// for box 0 (and to the factory, planner and registry) change no check, no record and no quote of the creation, and
/// end where each contract's documented rule for unrequested ETH puts them (BC-011 "dust"; BoxFactoryV1.sol:240-244;
/// BoxLaunchRouter.sol:193-195 "forced ETH is swept with the tax"; BoxReceiver.sol:289-294 "takes this contract's
/// whole ETH balance"; FitBuybackExecutor.sol:319-320 "budget == balance"; BoxCoordinator.sol:276-283 "claims nobody
/// minted as the reserve: a gift"; BoxRoyaltyRouter.sol:57-60 flush "all its ETH"). Where no rule exists the ETH stays
/// where it was forced (the evidence's question 1 for the founder).
/// forge-config: default.evm_version = "osaka"
contract AuditU1FablePrefundTest is AuditU1FablePreWorld {
    ClaimsDuster internal duster;

    function setUp() public override {
        super.setUp();
        duster = new ClaimsDuster(pm);
    }

    /// @dev The fifteen addresses that exist or will exist around the creation.
    function _prefundList() internal view returns (address[15] memory list) {
        address[12] memory p = _predictedList();
        for (uint256 i; i < 12; ++i) {
            list[i] = p[i];
        }
        list[12] = address(factory);
        list[13] = address(registry);
        list[14] = address(planner);
    }

    function _prefund(uint256 amount) internal {
        address[15] memory list = _prefundList();
        vm.deal(address(this), 40 * amount + 1 ether);
        for (uint256 i; i < list.length; ++i) {
            vm.deal(list[i], list[i].balance + amount);
            duster.dust{value: amount}(list[i], amount);
            assertEq(pm.balanceOf(list[i], 0), amount, "dusted claims");
        }
    }

    /// P1.2 (fuzzed amount, 1 wei to 100 ETH): with ETH and ETH claims at every one of the fifteen addresses the
    /// creation succeeds, its record (template id, spec hash, record hash, code hashes, addresses), its open and the
    /// vault's quotes are exactly a clean creation's; afterwards every prefunded balance and claim is still there
    /// (the creation reads none of them), the factory kept exactly what it held, the router counts no tax and the
    /// coordinator no reserve.
    function testFuzz_AUDIT_U1_prefundedAddressesChangeNoCreationCheck(uint256 seed) public {
        uint256 amount = bound(seed, 1, 100 ether);
        // The clean creation, for comparison.
        uint256 snap = vm.snapshotState();
        _createNow();
        Facts memory clean = _facts(); // memory: a state revert restores this contract's storage too
        vm.revertToState(snap);
        _prefund(amount);
        _createNow();
        Facts memory f = _facts();
        assertEq(f.templateId, clean.templateId, "template id");
        assertEq(f.specHash, clean.specHash, "spec hash");
        assertEq(f.recordHash, clean.recordHash, "record hash (addresses and code hashes)");
        assertEq(f.open, clean.open, "open");
        assertEq(f.quoteWithdraw, clean.quoteWithdraw, "withdraw quote");
        assertEq(f.quoteTake, clean.quoteTake, "take quote");
        assertEq(f.quoteTakeFee, clean.quoteTakeFee, "take fee");
        assertEq(f.poolShare, clean.poolShare, "pool share");
        address[15] memory list = _prefundList();
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].balance, amount, "the prefunded ETH is still there");
            assertEq(pm.balanceOf(list[i], 0), amount, "the prefunded claims are still there");
        }
        assertEq(launchRouter.totalTaxCollected(), 0, "no tax counted");
        assertEq(coordinator.reserve(), 0, "no reserve counted");
        assertEq(executor.budget(), amount, "the executor's budget is its balance (M10)");
        assertEq(registry.boxCount(), 1);
    }

    struct Facts {
        bytes32 templateId;
        bytes32 specHash;
        bytes32 recordHash;
        uint256 open;
        uint256 quoteWithdraw;
        uint256 quoteTake;
        uint256 quoteTakeFee;
        uint256 poolShare;
    }

    function _facts() internal view returns (Facts memory f) {
        (,, f.templateId, f.specHash, f.recordHash) = registry.entry(0);
        f.open = hook.openAt();
        f.quoteWithdraw = vault.quoteWithdraw(1);
        (f.quoteTake, f.quoteTakeFee) = vault.quoteTake(1);
        f.poolShare = token.balanceOf(a.coordinator);
    }

    /// P1.2: where each prefund ends. At creation nothing moves. Then, by each contract's documented rule: the
    /// receiver's `fundDepth()` (anyone, no value) takes its whole balance as held depth before graduation (BC-107);
    /// the router keeps its ETH until `sweep()` after graduation, which settles the whole balance into the hook's depth
    /// budget; the royalty router's `flush()` after graduation sends its whole balance to the receiver's fees; the
    /// coordinator's claims beyond the reserve are forwarded to the receiver at graduation; the executor's balance is
    /// its budget. ETH forced at the coordinator, hook, vault, collection, tickets, stream, table, T, factory,
    /// registry and planner, and ETH claims at every address but the coordinator, receiver and hook, have no exit
    /// (pinned here as observed; they are the sender's own loss, the class the money review accepted for FIT (M25)
    /// and for the source's ETH (M27); question 1 of the evidence asks the founder to record them).
    function testProperty_AUDIT_U1_prefundsEndWhereTheRulesPutThem() public {
        uint256 amount = 0.25 ether;
        _prefund(amount);
        _createNow();
        // Before graduation: the receiver's intake rule.
        vm.prank(eoa[0]);
        receiver.fundDepth();
        assertEq(a.receiver.balance, 0, "fundDepth took the receiver's whole balance");
        (uint256 depthHeldQ,) = receiver.depthHeld();
        assertEq(depthHeldQ, amount, "held as depth until graduation (BC-107)");
        assertEq(pm.balanceOf(a.receiver, 0), 2 * amount, "the depth is claims at the receiver, beside the dust");
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        launchRouter.sweep();
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        royaltyRouter.flush();
        // Graduation and the life after it (the kit's driver sweeps the router and flushes a 0.1 ETH royalty).
        uint256 hookClaimsBefore = pm.balanceOf(a.hook, 0);
        kit.toGraduated();
        assertTrue(coordinator.graduated());
        assertEq(a.launchRouter.balance, 0, "swept: the router's prefund joined the tax into depth");
        assertGt(pm.balanceOf(a.hook, 0), hookClaimsBefore + amount, "the hook's depth budget grew by at least it");
        assertEq(a.royaltyRouter.balance, 0, "flushed: the royalty router's prefund went to the receiver's fees");
        assertEq(pm.balanceOf(a.coordinator, 0), 0, "the coordinator's gift claims were forwarded at graduation");
        assertEq(executor.budget(), a.executor.balance, "budget == balance");
        assertGe(executor.budget(), amount, "the prefund is budget (M10)");
        // No exit: ETH at the addresses without an intake, claims at the addresses that never use claims.
        address[11] memory stuck = [
            a.coordinator,
            a.hook,
            a.vault,
            a.collection,
            a.tickets,
            a.itemStream,
            a.table,
            a.token,
            address(factory),
            address(registry),
            address(planner)
        ];
        for (uint256 i; i < stuck.length; ++i) {
            assertEq(stuck[i].balance, amount, "no intake: the forced ETH stays");
        }
        address[12] memory stuckClaims = [
            a.vault,
            a.collection,
            a.tickets,
            a.itemStream,
            a.table,
            a.token,
            a.launchRouter,
            a.royaltyRouter,
            a.executor,
            address(factory),
            address(registry),
            address(planner)
        ];
        for (uint256 i; i < stuckClaims.length; ++i) {
            assertEq(pm.balanceOf(stuckClaims[i], 0), amount, "no claims path: the dusted claims stay");
        }
    }
}
