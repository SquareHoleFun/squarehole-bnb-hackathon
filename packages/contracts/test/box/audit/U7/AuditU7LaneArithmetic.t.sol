// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU7LaneBase, IBoxVault, BoxSpecV1} from "./AuditU7LaneBase.sol";
import {BoxTokenBase} from "../../../../src/box/BoxToken.sol";

/// @notice Arithmetic callee fixture: precisely BoxTokenBase with a parameterized one-time issuance (its documented
/// test seam, BoxToken.sol:23-24). No transfer, fee or burn overrides. The factory's production issuance is 1e27.
contract AuditU7LaneSupplyToken is BoxTokenBase {
    constructor(uint256 s, address owner, address v) BoxTokenBase(s, "Boundary", "BOUND", owner, v) {}
}

/// @notice VLT-08/12, BC-006 and F23 fee arithmetic. Factory-built vault/tickets/collection/stream remain unchanged.
/// ONLY the token callee's issuance and initial balances are replaced, before any conversion, to reach supplies that
/// production cannot issue. Pool operations are deliberately not used after this substitution.
abstract contract AuditU7LaneArithmetic is AuditU7LaneBase {
    function _issuance() internal pure virtual returns (uint256) {
        return type(uint256).max;
    }

    function setUp() public virtual override {
        super.setUp();
        uint256 supply = _issuance();
        AuditU7LaneSupplyToken t = new AuditU7LaneSupplyToken(supply, eoa[0], a.vault);
        vm.etch(a.token, address(t).code);
        // BoxTokenBase: slot 0 supply, slot 1 balance mapping. Clear the factory bootstrap distribution.
        vm.store(a.token, bytes32(0), bytes32(supply));
        for (uint256 i; i < _ghostSystem.length; ++i) {
            vm.store(a.token, keccak256(abi.encode(_ghostSystem[i], uint256(1))), bytes32(0));
        }
        vm.store(a.token, keccak256(abi.encode(eoa[0], uint256(1))), bytes32(supply));
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(eoa[0]), supply);
        assertEq(token.balanceOf(a.vault), 0);
        _warpTo(hook.windowEndsAt());
        _approveT(eoa[0], a.tickets);
    }

    function testFuzz_AUDIT_U7_extremeQuotesAndRoundTrip(uint256 seed) public {
        uint256 k = 1 + seed % (editionSize < 64 ? editionSize / 2 : 32);
        _roundTrip(k);
    }

    function testProperty_AUDIT_U7_largeProductAndLastItem() public {
        uint256 k = editionSize - 1;
        assertEq(vault.quoteWithdraw(k), _ceil(_issuance(), k, editionSize));
        vm.expectRevert(IBoxVault.LastItem.selector);
        vault.quoteWithdraw(editionSize);
        _roundTrip(editionSize / 2);
    }

    function testProperty_AUDIT_U7_extremePickFeeAndReturn() public {
        vm.prank(eoa[0]);
        tickets.take(1, type(uint256).max, block.timestamp);
        // Synthetic issuance fixture: enter the vault gate through its coordinator authority, without trading
        // against the now intentionally substituted token distribution. Mainnet graduation is tested separately.
        vm.prank(a.coordinator);
        vault.openGate();
        vm.prank(a.tickets);
        vault.deliverTicket(1, eoa[0]);
        _publish(1);
        _returnItem(eoa[0], 1);
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 p = _ceil(s - e, 1, vault.inside());
        (uint256 paid, uint256 f) = _pick(eoa[0], 1);
        assertEq(paid, p);
        assertEq(f, _fee(p, 2500));
        assertEq(vault.escrowPrincipal(), e + p);
        assertEq(token.totalSupply(), s - f);
        uint256 r = _floor(s - f - e - p, 1, vault.inside());
        (uint256 released, uint256 rf) = _returnItem(eoa[0], 1);
        assertEq(released, r);
        assertEq(rf, _fee(r, 500));
        assertLe(released, paid);
        assertEq(vault.escrowPrincipal(), e + p - r);
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
        assertEq(token.totalSupply(), s - f - rf);
    }

    function testProperty_AUDIT_U7_actualLastItemRefusesTake() public {
        while (vault.inside() > 1) {
            uint256 k = vault.inside() / 2;
            vm.prank(eoa[0]);
            tickets.take(k, type(uint256).max, block.timestamp);
        }
        assertEq(vault.inside(), 1);
        assertEq(vault.pendingTickets(), editionSize - 1);
        assertEq(collection.balanceOf(a.vault), editionSize);
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
        assertLe(vault.escrowPrincipal(), token.totalSupply() - 1);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.LastItem.selector);
        tickets.take(1, type(uint256).max, block.timestamp);
    }

    function _roundTrip(uint256 k) private {
        uint256 s = token.totalSupply();
        uint256 p = _ceil(s, k, editionSize);
        assertEq(vault.quoteWithdraw(k), p);
        vm.prank(eoa[0]);
        uint256 first = tickets.take(k, type(uint256).max, block.timestamp);
        uint256 f = _fee(p, 100);
        assertEq(vault.escrowPrincipal(), p);
        assertEq(token.totalSupply(), s - f);
        assertEq(token.balanceOf(a.vault), p);
        uint256 n = editionSize - k;
        uint256 active = s - f - p;
        uint256 r = _floor(active, k, n);
        assertEq(vault.quoteReturn(k), r);
        assertGe(p, _ceil(active, k, n), "512-bit solvency via quotient/remainder");
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = first + i;
        }
        vm.prank(eoa[0]);
        (uint256 released, uint256 rf) = tickets.handBack(ids, 0, block.timestamp);
        assertEq(released, r);
        assertEq(rf, _fee(r, 500));
        assertLe(released, p, "box never releases more than it locked");
        assertEq(vault.escrowPrincipal(), p - r);
        assertEq(token.totalSupply(), s - f - rf);
        assertEq(token.balanceOf(a.vault), p - r);
        assertEq(token.balanceOf(eoa[0]), s - f - rf - (p - r));
        assertEq(vault.inside(), editionSize);
        assertLe(vault.escrowPrincipal(), token.totalSupply() - editionSize);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneArithmetic10000 is AuditU7LaneArithmetic {
    function _auditN() internal pure override returns (uint256) {
        return 10_000;
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneArithmetic4200 is AuditU7LaneArithmetic {
    function _auditN() internal pure override returns (uint256) {
        return 4200;
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneArithmeticDust is AuditU7LaneArithmetic {
    function _auditN() internal pure override returns (uint256) {
        return 32;
    }

    function _issuance() internal pure override returns (uint256) {
        return 4003;
    }

    function _auditSpec() internal view override returns (BoxSpecV1.BoxSpec memory s) {
        s = super._auditSpec();
        // The fixture's decorative specials count exceeds 32; it has no on-chain vault/collection behaviour.
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_EDITION_SPECIALS) {
                (string memory label,) = abi.decode(s.addOns[i].params, (string, uint32));
                s.addOns[i].params = abi.encode(label, uint32(1));
            }
        }
    }
}
