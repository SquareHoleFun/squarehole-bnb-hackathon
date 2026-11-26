// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxSupplyFloor, IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU2ClaudeBase} from "./AuditU2ClaudeBase.sol";

/// @notice U2's token T on the factory's box 0 (P2.5, P2.6; IBoxToken.sol:17-28; BoxToken.sol:8-21, :103-152; BC-004,
/// BC-005, BC-043, BC-055): totalSupply + totalBurned == 1e27 always; supply only falls, by `burn` of the caller's own
/// balance and never below the vault's floor E + n; Σ balances == totalSupply (the ghost ledger's holders); a send to
/// the vault (except the vault's own pull) or to T reverts whatever the amount; nothing else is refused; zero amounts
/// pass; a max allowance is never decremented. The floor's value comes from the real vault except in the fuzz that
/// sets it with `vm.mockCall` (a stand-in for the vault's answer: the property is how T treats it).
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeTokenTest is AuditU2ClaudeBase {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public override {
        super.setUp();
        _toBonding();
        _ghostAddOutside(DEAD);
    }

    function testFuzz_AUDIT_U2_tTransfersConserveAndRefuseOnlyTheVaultAndT(uint256 amtSeed, uint8 toKind, uint8 how)
        public
    {
        address from = eoa[0];
        address[11] memory tos = [
            eoa[1],
            a.vault,
            a.token,
            a.coordinator,
            a.hook,
            a.receiver,
            a.launchRouter,
            DEAD,
            address(pm),
            a.itemStream,
            address(0)
        ];
        address to = tos[toKind % tos.length];
        uint256 bal = token.balanceOf(from);
        uint256 amount = amtSeed % 7 == 0 ? bal + 1 + (amtSeed >> 8) % 1e18 : bound(amtSeed, 0, bal);
        uint256 mode = how % 3;
        address spender = eoa[2];
        uint256 allowance0;
        if (mode != 0) {
            allowance0 = mode == 2 ? type(uint256).max : amount + (amtSeed >> 128) % 1e20;
            vm.prank(from);
            token.approve(spender, allowance0);
        }
        uint256 supply0 = token.totalSupply();
        uint256 to0 = to == address(0) ? 0 : token.balanceOf(to);
        bytes memory expected;
        if (to == address(0)) {
            expected = abi.encodeWithSelector(IBoxToken.TransferToZeroAddress.selector);
        } else if (to == a.vault || to == a.token) {
            expected = abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, to);
        } else if (amount > bal) {
            expected = abi.encodeWithSelector(IBoxToken.InsufficientBalance.selector, bal, amount);
        }
        if (expected.length != 0) {
            vm.expectRevert(expected);
            _send(mode, from, spender, to, amount);
            assertEq(token.balanceOf(from), bal, "a refused send moves nothing");
            if (to != address(0)) assertEq(token.balanceOf(to), to0);
        } else {
            _send(mode, from, spender, to, amount);
            assertEq(token.balanceOf(from), from == to ? bal : bal - amount, "the sender's balance falls by the amount");
            assertEq(token.balanceOf(to), from == to ? to0 : to0 + amount, "the recipient's rises by it");
            if (mode == 1) assertEq(token.allowance(from, spender), allowance0 - amount, "a finite allowance: exact");
            if (mode == 2) assertEq(token.allowance(from, spender), type(uint256).max, "max is never decremented");
            if (_ghostIsSystem[to]) _noteTIn(TIn.Direct, amount);
        }
        assertEq(token.totalSupply(), supply0, "transfers never change the supply");
        _assertGhostLedger();
    }

    function _send(uint256 mode, address from, address spender, address to, uint256 amount) internal {
        if (mode == 0) {
            vm.prank(from);
            token.transfer(to, amount);
        } else {
            vm.prank(spender);
            token.transferFrom(from, to, amount);
        }
    }

    /// @notice The vault's own pull (a take on the curve) is the one way into the vault; the same move by any other
    /// spender is refused, and a zero-amount `transferFrom` of address(0) too (its event would read as a mint).
    function testProperty_AUDIT_U2_onlyTheVaultsOwnPullEntersTheVault() public {
        uint256 v0 = token.balanceOf(a.vault);
        _take(eoa[0], 1);
        assertGt(token.balanceOf(a.vault), v0, "the vault pulled the take's principal");
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal(), "and holds exactly E");
        vm.prank(eoa[0]);
        token.approve(eoa[1], type(uint256).max);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transferFrom(eoa[0], a.vault, 1);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transferFrom(eoa[0], a.vault, 0);
        vm.prank(eoa[1]);
        vm.expectRevert(IBoxToken.TransferFromZeroAddress.selector);
        token.transferFrom(address(0), eoa[1], 0);
        vm.prank(eoa[1]);
        vm.expectRevert(IBoxToken.ApproveToZeroAddress.selector);
        token.approve(address(0), 1);
        // Zero amounts pass everywhere else, with the standard event.
        vm.expectEmit(a.token);
        emit IBoxToken.Transfer(eoa[1], eoa[2], 0);
        vm.prank(eoa[1]);
        assertTrue(token.transfer(eoa[2], 0));
        _assertGhostLedger();
    }

    /// @notice BC-005: a burn that would leave totalSupply below the vault's floor reverts `BurnBelowSupplyFloor` and
    /// changes nothing; any other burn of the caller's own T lowers supply by exactly its amount. The floor is set by
    /// `vm.mockCall` on the vault's `supplyFloor()` (the real floor E + n is far below box 0's supply); a vault that
    /// cannot answer stops every burn.
    function testFuzz_AUDIT_U2_burnRespectsTheVaultsFloor(uint256 amtSeed, uint256 floorSeed) public {
        address who = eoa[1];
        uint256 bal = token.balanceOf(who);
        uint256 amount = bound(amtSeed, 0, bal);
        uint256 supply = token.totalSupply();
        uint256 floor = bound(floorSeed, 0, supply);
        vm.mockCall(a.vault, abi.encodeWithSelector(IBoxSupplyFloor.supplyFloor.selector), abi.encode(floor));
        uint256 burned0 = token.totalBurned();
        if (supply - amount < floor) {
            vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, supply - amount, floor));
            vm.prank(who);
            token.burn(amount);
            assertEq(token.totalSupply(), supply, "a refused burn changes nothing");
            assertEq(token.balanceOf(who), bal);
        } else {
            _burnT(who, amount);
            assertEq(token.totalSupply(), supply - amount, "supply falls by exactly the amount");
            assertEq(token.totalBurned(), burned0 + amount);
            assertEq(token.balanceOf(who), bal - amount, "of the caller's own balance");
        }
        vm.clearMockedCalls();
        vm.mockCallRevert(a.vault, abi.encodeWithSelector(IBoxSupplyFloor.supplyFloor.selector), "floor unavailable");
        vm.prank(eoa[0]);
        vm.expectRevert(bytes("floor unavailable"));
        token.burn(1);
        vm.clearMockedCalls();
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        _assertGhostLedger();
    }

    /// @notice The real floor is E + n (BoxVault.sol:280-282) and a holder's burn of its whole balance passes it.
    function testProperty_AUDIT_U2_realFloorIsEscrowPlusInsideAndHolderBurnsPass() public {
        _take(eoa[3], 2);
        assertEq(vault.supplyFloor(), vault.escrowPrincipal() + vault.inside());
        assertGt(vault.escrowPrincipal(), 0);
        uint256 bal = token.balanceOf(eoa[3]);
        uint256 supply = token.totalSupply();
        _burnT(eoa[3], bal);
        assertEq(token.totalSupply(), supply - bal);
        assertGe(token.totalSupply(), vault.supplyFloor());
        _assertGhostLedger();
    }

    /// @notice X02 across box 0's scripted life: after every phase supply + burned == 1e27, supply never rose, and the
    /// system and the outside holders hold every unit of it.
    function testProperty_AUDIT_U2_supplyOnlyFallsAcrossTheLife() public {
        uint256 last = token.totalSupply();
        for (uint8 p = uint8(AuditPhase.Closed); p <= uint8(AuditPhase.Terminal); ++p) {
            _toPhase(AuditPhase(p));
            uint256 now_ = token.totalSupply();
            assertLe(now_, last, "supply never rises");
            assertEq(now_ + token.totalBurned(), BoxSpecV1.ISSUANCE);
            assertGe(now_, vault.supplyFloor(), "never below the floor");
            last = now_;
            _assertGhostLedger();
        }
        // Terminal mode's cancel returns principal T (no new T): the supply is unchanged by it.
        uint256 before = token.totalSupply();
        assertGt(_cancelDraw(eoa[4], drawC), 0);
        assertEq(token.totalSupply(), before);
        assertGt(ghostTOut(TOut.Cancel), 0);
        _assertGhostLedger();
    }
}
