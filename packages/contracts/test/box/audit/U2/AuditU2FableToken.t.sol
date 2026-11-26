// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {AuditU2FableBase} from "./AuditU2FableBase.sol";

/// @title AuditU2FableTokenTest
/// @notice SH-AUDIT-B0-U2-F, the box token T of the factory's box 0: P2.5 (supply identity, no mint, the vault floor,
/// refused sends, Σ balances) and P2.6 (the bootstrap's T burned at creation; no creator buy), BC-004, BC-005, BC-043,
/// BC-055, IBoxToken.sol:27.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableTokenTest is AuditU2FableBase {
    /// P2.6 / BC-004: one issuance of 1e27 to the coordinator; the bootstrap's T (bought from the curve) was burned in
    /// the creation transaction; no externally owned account held T at creation; the identity holds.
    function testProperty_AUDIT_U2_bootstrapTBurnedInTheCreationTransaction() public view {
        assertEq(token.ISSUANCE(), 1e27);
        assertEq(token.initialSupply(), 1e27);
        assertEq(token.initialHolder(), a.coordinator);
        assertEq(token.decimals(), 18);
        assertEq(token.vault(), a.vault);
        assertGt(token.totalBurned(), 0, "the bootstrap's T was burned");
        assertEq(token.totalBurned(), curve.curveT - token.balanceOf(address(pm)), "it came out of the curve");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        assertEq(token.balanceOf(address(kit)), 0, "the creator holds none");
        assertEq(token.balanceOf(address(this)), 0);
        for (uint256 i; i < 8; ++i) {
            assertEq(token.balanceOf(eoa[i]), 0, "no EOA held T at creation");
        }
        assertEq(token.balanceOf(a.coordinator) + token.balanceOf(address(pm)), token.totalSupply(), "two holders");
        assertEq(coordinator.creatorBuyAmount(), 0, "BC-116: box 0 has no creator buy");
        assertFalse(launchRouter.creatorBought());
    }

    /// P2.5 / BC-043 / BC-055 / F24 (d): a transfer to the vault reverts unless the vault itself is the caller; a
    /// transfer to T's own address always reverts; transfers to or from address(0) revert; `approve` to address(0)
    /// reverts; zero-amount transfers pass; a maximal allowance is never decremented, a finite one is; T sent to the
    /// coordinator, the receiver, the hook or the router passes and changes no quote.
    function testProperty_AUDIT_U2_refusedAndHarmlessSends() public {
        _toWindow();
        address holder = eoa[0];
        uint256 bal = token.balanceOf(holder);
        assertGt(bal, 0);
        vm.startPrank(holder);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transfer(a.vault, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.token));
        token.transfer(a.token, 1);
        vm.expectRevert(IBoxToken.TransferToZeroAddress.selector);
        token.transfer(address(0), 1);
        vm.expectRevert(IBoxToken.ApproveToZeroAddress.selector);
        token.approve(address(0), 1);
        assertTrue(token.transfer(eoa[1], 0), "a zero-amount transfer passes");
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.InsufficientBalance.selector, bal, bal + 1));
        token.transfer(eoa[1], bal + 1);
        token.approve(eoa[2], type(uint256).max);
        token.approve(eoa[3], 5);
        vm.stopPrank();
        vm.prank(eoa[2]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transferFrom(holder, a.vault, 1);
        vm.prank(eoa[2]);
        assertTrue(token.transferFrom(holder, eoa[2], 1));
        assertEq(token.allowance(holder, eoa[2]), type(uint256).max, "a maximal allowance is never decremented");
        vm.prank(eoa[3]);
        assertTrue(token.transferFrom(holder, eoa[3], 2));
        assertEq(token.allowance(holder, eoa[3]), 3, "a finite one is");
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.InsufficientAllowance.selector, 3, 4));
        token.transferFrom(holder, eoa[3], 4);
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxToken.TransferFromZeroAddress.selector);
        token.transferFrom(address(0), eoa[3], 0);
        // The vault's own pull is the one allowed send to the vault.
        vm.prank(holder);
        token.approve(a.vault, type(uint256).max);
        uint256 v0 = token.balanceOf(a.vault);
        vm.prank(a.vault);
        assertTrue(token.transferFrom(holder, a.vault, 3), "the vault's own pull");
        assertEq(token.balanceOf(a.vault), v0 + 3);
        // Sends to the box's other contracts pass and change no quote (the router's quote is the step's rule).
        (uint256 tax0,) = launchRouter.quote(1 ether);
        address[4] memory others = [a.coordinator, a.receiver, a.hook, a.launchRouter];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(holder);
            assertTrue(token.transfer(others[i], 1));
        }
        (uint256 tax1,) = launchRouter.quote(1 ether);
        assertEq(tax1, tax0);
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
    }

    /// P2.5 / BC-005 / VLT-11: no burn takes totalSupply below the vault's floor E + n. At creation E is 0 and n is N:
    /// with every unit of T in one hand (a stand-in move: the pool's and the coordinator's T pranked to eoa[0], which
    /// no code path does) a burn down to exactly N raw units passes and one more unit is refused BurnBelowSupplyFloor,
    /// changing nothing. The floor's reading is E + n after placeholders raised E.
    function testProperty_AUDIT_U2_burnNeverBelowTheSupplyFloor() public {
        assertEq(vault.supplyFloor(), editionSize, "E = 0, n = N");
        uint256 poolT = token.balanceOf(address(pm));
        uint256 shareT = token.balanceOf(a.coordinator);
        vm.prank(address(pm));
        token.transfer(eoa[0], poolT);
        vm.prank(a.coordinator);
        token.transfer(eoa[0], shareT);
        uint256 supply = token.totalSupply();
        assertEq(token.balanceOf(eoa[0]), supply, "one hand");
        uint256 floor = vault.supplyFloor();
        vm.prank(eoa[0]);
        token.burn(supply - floor);
        assertEq(token.totalSupply(), floor, "exactly the floor");
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, floor - 1, floor));
        token.burn(1);
        assertEq(token.totalSupply(), floor);
        assertEq(token.balanceOf(eoa[0]), floor);
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.InsufficientBalance.selector, floor, floor + 1));
        token.burn(floor + 1);
    }

    /// BC-005 with escrow: after placeholders were taken the floor is E + n, read from the vault; a holder's burn of
    /// its whole balance passes (far above the floor) and the identity holds.
    function testProperty_AUDIT_U2_supplyFloorIsEscrowPlusInside() public {
        _toBonding();
        assertGt(vault.escrowPrincipal(), 0, "placeholders raised E");
        assertEq(vault.supplyFloor(), vault.escrowPrincipal() + vault.inside());
        uint256 bal = token.balanceOf(eoa[1]);
        _burnT(eoa[1], bal);
        assertEq(token.balanceOf(eoa[1]), 0);
        assertGe(token.totalSupply(), vault.supplyFloor());
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        _assertGhostLedger();
    }

    /// P2.5 / IBoxToken.sol:27: under random transfers and burns among every outside holder, totalSupply +
    /// totalBurned == 1e27, Σ balances == totalSupply (the ghost ledger's holders), and the supply never rises.
    function testFuzz_AUDIT_U2_supplyIdentityUnderTransfersAndBurns(uint256 seed, uint8 steps) public {
        _toBonding();
        address[10] memory h =
            [eoa[0], eoa[1], eoa[2], eoa[3], eoa[4], eoa[5], eoa[6], eoa[7], address(contractDrawer), eoa7702];
        uint256 supply = token.totalSupply();
        for (uint256 i; i < uint256(steps) % 24 + 1; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address from = h[r % 10];
            uint256 bal = token.balanceOf(from);
            if (bal == 0) continue;
            uint256 amount = (r >> 8) % (bal + 1);
            if ((r >> 4) % 3 == 0) {
                _burnT(from, amount);
            } else {
                _transferT(from, h[(r >> 16) % 10], amount);
            }
            assertLe(token.totalSupply(), supply, "the supply never rises");
            supply = token.totalSupply();
            assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        }
        _assertGhostLedger();
    }

    /// P2.5 / F72 (2) / F23 C2: T has no mint, burnFrom, pause or rescue entry point (unknown selectors revert: no
    /// fallback), its name, symbol, decimals and vault are fixed, and over a whole life of box 0 (to terminal mode)
    /// the identity holds and the supply only fell.
    function testProperty_AUDIT_U2_noMintPathOverAWholeLife() public {
        string[6] memory sigs = [
            "mint(address,uint256)",
            "burnFrom(address,uint256)",
            "pause()",
            "rescue(address,uint256)",
            "setVault(address)",
            "transferOwnership(address)"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            (bool ok,) = a.token.call(abi.encodeWithSignature(sigs[i], address(this), uint256(1)));
            assertFalse(ok, sigs[i]);
        }
        (bool okEth,) = a.token.call{value: 1}("");
        assertFalse(okEth, "no receive");
        string memory name = token.name();
        string memory symbol = token.symbol();
        uint256 supply0 = token.totalSupply();
        _toTerminal();
        assertEq(token.name(), name);
        assertEq(token.symbol(), symbol);
        assertEq(token.decimals(), 18);
        assertEq(token.vault(), a.vault);
        assertLe(token.totalSupply(), supply0, "the supply only falls");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        assertGe(token.totalSupply(), vault.supplyFloor());
        _assertGhostLedger();
    }

    /// BC-055: standard events on transfer, approve and burn (a burn is a Transfer to address(0)).
    function testProperty_AUDIT_U2_standardEvents() public {
        _toWindow();
        address holder = eoa[0];
        vm.expectEmit(true, true, true, true, a.token);
        emit IBoxToken.Transfer(holder, eoa[1], 7);
        vm.prank(holder);
        token.transfer(eoa[1], 7);
        vm.expectEmit(true, true, true, true, a.token);
        emit IBoxToken.Approval(holder, eoa[2], 9);
        vm.prank(holder);
        token.approve(eoa[2], 9);
        vm.expectEmit(true, true, true, true, a.token);
        emit IBoxToken.Transfer(holder, address(0), 5);
        vm.prank(holder);
        token.burn(5);
    }
}
