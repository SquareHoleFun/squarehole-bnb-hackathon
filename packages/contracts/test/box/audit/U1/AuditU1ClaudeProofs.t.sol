// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU1ClaudeKitBase} from "./AuditU1ClaudeBase.sol";

/// @title AuditU1ClaudeProofsTest
/// @notice SH-AUDIT-B0 U1 proof tests (Claude, Opus): each passes while the defect it pins exists and fails once the
/// code is corrected (plan § 1.1). osaka.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeProofsTest is AuditU1ClaudeKitBase {
    // W3-U1-1, accepted as built (FQ-32, F147): template 0 writes FeeHandling without the add-on; texts narrowed.
    /// @notice Proof 01 (low): box 0 created from a template-0 spec WITHOUT the royalties add-on still tells marketplaces
    /// it implements ERC-2981 and names a FeeHandling royalty destination.
    ///
    /// **Property and source.** `IBoxCollection.supportsInterface` (src/box/interfaces/IBoxCollection.sol:113): "True for
    /// ... 0x2a55205a only with the royalties add-on"; `IBoxCollection.royaltyDestination` (:141): "The add-on's
    /// destination; `None` without the add-on"; BoxCloneArgs.CollectionArgs (src/box/libraries/BoxCloneArgs.sol:59):
    /// the router "or zero (Creator, or no royalties add-on)"; the S3 kit builds such a collection with destination 0
    /// (test/box/items/BoxItemsBase.sol:192-201) and BoxItemsConformance checks "no add-on: ERC-2981 unset"
    /// (test/box/items/BoxItemsConformance.t.sol:692-697). Template 0 accepts the royalties add-on as optional
    /// (BoxFactoryV1Planner.sol:41 "royalties, when present, to box 0's fee handling"; `_template0Field` :415-418
    /// refuses only a destination other than 0 or FeeHandling).
    ///
    /// **Expected.** Without the add-on the factory's box 0 collection answers `royaltyDestination() == None` and
    /// `supportsInterface(0x2a55205a) == false`.
    ///
    /// **Observed.** The planner writes the collection's royalty-destination byte as FeeHandling unconditionally
    /// (`_collectionArgs`, BoxFactoryV1Planner.sol:338, `royaltyDestination: BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING`),
    /// so BoxCollection.sol:155 (`royaltyDestination() != None`) answers ERC-2981 support and `royaltyDestination()`
    /// answers FeeHandling, while `royaltyBps()` is 0, `royaltyRouter()` is address(0), no royalty router exists and
    /// `royaltyInfo` returns (address(0), 0). The receiver's royalty byte is FeeHandling the same way (:284; its view
    /// has no documented meaning without the add-on). The factory's re-reads do not read the destination
    /// (BoxFactoryV1.sol:543-556), so createBox succeeds. No value moves: `royaltyInfo` asks no royalty.
    ///
    /// **Steps.** The audit world's box 0 spec (N 1,969, mainnet Safe and raise) with add-on 4 dropped; `refusal()` is
    /// empty (template 0); createBox; read the collection's views.
    ///
    /// **Amounts.** None move: royaltyInfo(1, 1 ether) = (address(0), 0).
    ///
    /// **Fix direction (not applied).** Write the destination byte from the add-on (0 without it), as BoxItemsBase does.
    function testAccepted_AUDIT_U1_01_noRoyaltiesAddOnStillClaimsErc2981() public {
        BoxSpecV1.BoxSpec memory s = _spec();
        _dropAddOn(s, BoxSpecV1.ADD_ON_ROYALTIES);
        assertEq(factory.refusal(s, address(kit)).length, 0, "template 0 without the royalties add-on");
        kit.prepare(s);
        kit.create();
        CoreBoxAddresses memory a = kit.addresses();
        BoxCollection col = BoxCollection(a.collection);
        assertEq(a.royaltyRouter, address(0), "no royalty router planned");
        assertEq(factory.box0Addresses().royaltyRouter.code.length, 0, "and none created at nonce 10");
        assertEq(col.royaltyBps(), 0, "rate 0");
        assertEq(col.royaltyRouter(), address(0), "no router named");
        (address to, uint256 amount) = col.royaltyInfo(1, 1 ether);
        assertEq(to, address(0), "royaltyInfo names nobody");
        assertEq(amount, 0, "and asks nothing");
        // The defect: the views disagree with IBoxCollection.sol:113 and :141.
        assertEq(
            uint8(col.royaltyDestination()), uint8(RoyaltyDestination.FeeHandling), "observed: FeeHandling, not None"
        );
        assertTrue(col.supportsInterface(0x2a55205a), "observed: ERC-2981 claimed without the add-on");
        assertEq(
            uint8(BoxReceiver(payable(a.receiver)).royaltyDestination()),
            uint8(RoyaltyDestination.FeeHandling),
            "the receiver's byte too"
        );
    }

    // W3-U1-2, accepted as built (FQ-33, F147): no Ethereum call comes from address(0); the NatSpec now says so.
    /// @notice Proof 02 (note): box 0's collection lets `msg.sender == address(0)` unlock an item's reveal, though its
    /// reveal unlocker is zero ("nobody") and its triggers lack REVEAL_ON_UNLOCK.
    ///
    /// **Property and source.** `IBoxCollection.unlockReveal` (src/box/interfaces/IBoxCollection.sol:189): "The reveal
    /// unlocker only (zero: nobody), only with REVEAL_ON_UNLOCK; idempotent"; BoxCollection.sol:299 ("unlocker 0 =>
    /// nobody"); BC-010 ("no function is gated on msg.sender except to one fixed contract set at creation"). Box 0's
    /// planner writes no unlocker and REVEAL_ON_EXIT only (BoxFactoryV1Planner.sol:330, :336; re-read by the factory,
    /// BoxFactoryV1.sol:550-551).
    ///
    /// **Expected.** On box 0 `unlockReveal` refuses every sender (`NotRevealUnlocker`), and in any case it does
    /// nothing without REVEAL_ON_UNLOCK.
    ///
    /// **Observed.** BoxCollection.sol:299 compares `msg.sender != revealUnlocker()` only: with the unlocker zero, a
    /// call from address(0) passes; the code checks neither for a zero unlocker (as the receiver does for its module and
    /// payee, BoxReceiver.sol:1021, :361) nor for the REVEAL_ON_UNLOCK trigger the interface names. The call sets the
    /// item's `_UNLOCKED` flag (`revealState(id).unlocked` reads true) and emits `RevealUnlocked`; nothing else changes:
    /// `_revealable` (:650-653) counts the flag only with REVEAL_ON_UNLOCK, so the item is no more revealable, and its
    /// later reveal (on exit) still works.
    ///
    /// **Reachability.** None on Ethereum mainnet or Sepolia: no transaction or call has msg.sender == address(0) (no
    /// key, no code at it; system calls come from 0xff..fe). Found by the deep BC-010 campaign (FOUNDRY_PROFILE=deep,
    /// `--fuzz-seed 0x5348423132`), whose probes then still listed address(0) as a pranked caller; the zero-sender
    /// sweep (`testProperty_AUDIT_U1_zeroSenderSweep`) shows it is the only such case.
    ///
    /// **Steps.** Create box 0; `vm.prank(address(0))`; `collection.unlockReveal(1)`; read `revealState(1)`.
    ///
    /// **Amounts.** None.
    function testAccepted_AUDIT_U1_02_zeroUnlockerAcceptsTheZeroSender() public {
        CoreBoxAddresses memory a = _create();
        BoxCollection col = BoxCollection(a.collection);
        assertEq(col.revealUnlocker(), address(0), "box 0 has no unlocker");
        assertEq(col.revealTriggers(), 1, "reveal on exit only");
        vm.prank(makeAddr("u1.anyone"));
        vm.expectRevert(abi.encodeWithSignature("NotRevealUnlocker(address)", makeAddr("u1.anyone")));
        col.unlockReveal(1);
        (, bool unlockedBefore,, bool revealableBefore) = col.revealState(1);
        assertFalse(unlockedBefore);
        vm.prank(address(0));
        col.unlockReveal(1);
        (bool left, bool unlocked, bool revealed, bool revealable) = col.revealState(1);
        assertTrue(unlocked, "observed: the zero sender unlocked item 1");
        assertFalse(left || revealed, "item 1 is still in the vault, hidden");
        assertEq(revealable, revealableBefore, "and no more revealable than before (no REVEAL_ON_UNLOCK)");
    }

    function _dropAddOn(BoxSpecV1.BoxSpec memory s, uint16 id) internal pure {
        uint256 kept;
        BoxSpecV1.AddOn[] memory l = new BoxSpecV1.AddOn[](s.addOns.length);
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != id) l[kept++] = s.addOns[i];
        }
        assembly ("memory-safe") {
            mstore(l, kept)
        }
        s.addOns = l;
    }
}
