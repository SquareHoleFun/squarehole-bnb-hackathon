// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditSysChecks} from "./AuditSysChecks.sol";

/// @title AuditSysInvariants
/// @notice TEST ONLY (SH-AUDIT-B0 round 2). The public face of the system campaign: one `invariant_AUDIT_SYS_*` per
/// check of `AuditSysChecks` (plan § 3.1 X01-X20; X14, X17 and X18 inside the actions' oracles, reported by
/// `everyActionAsTheRules`) and the closing driver as `afterInvariant` (X06, X12, X21). The three shards inherit it; the
/// accepted pins inherit the checks only, so they carry no invariant campaign of their own.
abstract contract AuditSysInvariants is AuditSysChecks {
    function invariant_AUDIT_SYS_X01_ethConservation() public view {
        _checkX01_ethConservation();
    }

    function invariant_AUDIT_SYS_X02_tSupply() public view {
        _checkX02_tSupply();
    }

    function invariant_AUDIT_SYS_X03_items() public view {
        _checkX03_items();
    }

    function invariant_AUDIT_SYS_X04_tickets() public view {
        _checkX04_tickets();
    }

    function invariant_AUDIT_SYS_X05_phases() public view {
        _checkX05_phases();
    }

    function invariant_AUDIT_SYS_X06_graduationOnce() public view {
        _checkX06_graduationOnce();
    }

    function invariant_AUDIT_SYS_X07_platformCap() public view {
        _checkX07_platformCap();
    }

    function invariant_AUDIT_SYS_X08_beforeGraduation() public view {
        _checkX08_beforeGraduation();
    }

    function invariant_AUDIT_SYS_X09_claimsMatchLedgers() public view {
        _checkX09_claimsMatchLedgers();
    }

    function invariant_AUDIT_SYS_X10_stream() public {
        _checkX10_stream();
    }

    function invariant_AUDIT_SYS_X11_words() public view {
        _checkX11_words();
    }

    function invariant_AUDIT_SYS_X12_neverStuck() public {
        _checkX12_neverStuck();
    }

    function invariant_AUDIT_SYS_X13_order() public view {
        _checkX13_order();
    }

    function invariant_AUDIT_SYS_X15_vaultSolvency() public view {
        _checkX15_vaultSolvency();
    }

    function invariant_AUDIT_SYS_X16_pool() public view {
        _checkX16_pool();
    }

    function invariant_AUDIT_SYS_X19X20_deliveriesAndReward() public view {
        _checkX19X20_deliveriesAndReward();
    }

    function invariant_AUDIT_SYS_everyActionAsTheRules() public view {
        _checkeveryActionAsTheRules();
    }

    function afterInvariant() external {
        _afterRun();
    }
}
