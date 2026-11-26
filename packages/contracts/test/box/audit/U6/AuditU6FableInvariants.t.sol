// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU6FableChecks} from "./AuditU6FableChecks.sol";

/// The three invariants, checked after every call of a campaign.
abstract contract AuditU6FableInvariantSet is AuditU6FableChecks {
    function invariant_AUDIT_U6_placeholdersAndPendingTickets() public view {
        _checkPlaceholdersAndPendingTickets();
    }

    function invariant_AUDIT_U6_drawOrderAndItems() public {
        _checkDrawOrderAndItems();
    }

    function invariant_AUDIT_U6_ledgerAndRules() public view {
        _checkLedgerAndRules();
    }
}

/// From graduation (the word requested on r0, five placeholders): the draw life with drand and the backup.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableGraduatedInvariants is AuditU6FableInvariantSet {
    function _startPhase() internal override {
        _toGraduated();
    }
}

/// From the curve (bonding, five placeholders): takes, hand-backs, transfers and approvals, then the close, graduation
/// (the poke failing or not), the word and the draws.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableCurveInvariants is AuditU6FableInvariantSet {
    function _startPhase() internal override {
        _toBonding();
    }
}
