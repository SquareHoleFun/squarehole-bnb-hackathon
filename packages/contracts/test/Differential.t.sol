// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {Fixture} from "./utils/Fixture.sol";

/// @notice Replays the reference-model vectors from script-py/gen_vectors.py (square-hole-handoff/reference/
/// fee_policy_model.py, exact Fractions) against the contracts, once per launch template: the DN404 collection
/// (N NFTs at ratio r) and the fungible ERC-20 (N x r whole tokens; a whole-NFT step is a plain transfer of one unit). After every step: balances, eligible supply,
/// supply, burned T, Q received and the protocol share must match exactly, and each account's cumulative
/// entitlement (claimed + claimable) is checked twice (ADR-0010 "Rounding and dust policy"):
/// - primary, every vector and step: within 1 wei of `expCumulativeInt`, the floor of a second, unmodified model
///   instance fed the collector's integer split (X = q + carry; 3⌊X/3⌋ recognised, X mod 3 carried), so the only
///   remaining differences are the ledger's index and claim flooring;
/// - secondary: within the vector's `expBound` of `expCumulative`, the model fed the raw receipts (1 wei when every
///   Q receipt is a multiple of 3; otherwise 1 + 2 × fee events, from the collector's carry of < 3 wei).
contract DifferentialTest is Fixture {
    uint256 internal constant OP_TRANSFER = 0;
    uint256 internal constant OP_NFT = 1;
    uint256 internal constant OP_FEE = 2;
    uint256 internal constant OP_CLAIM_Q = 3;
    uint256 internal constant OP_CLAIM_T = 4;
    uint256 internal constant OP_DONATE_T = 5;
    uint256 internal constant OP_SWEEP_T = 6;
    uint256 internal constant OP_PROCESS = 7;
    /// @dev OP_FEE with opB == FEE_DEFER leaves the burn pending until a later OP_PROCESS.
    uint256 internal constant FEE_DEFER = 1;
    uint256 internal constant INT_BOUND = 1;

    struct Vector {
        uint256 steps;
        uint256[] kind;
        uint256[] a;
        uint256[] b;
        string[] amount;
        string[] t;
        string[] q;
        string[] balances;
        string[] cumulative;
        string[] cumulativeInt;
        string[] supply;
        string[] burned;
        string[] qReceived;
        string[] protocolFloor;
        uint256[] bound;
    }

    address[6] internal party;
    uint256[4] internal claimed;
    uint256 internal vectorUnit;
    uint256 internal maxError;
    uint256 internal maxErrorInt;

    function test_vector_spec05WorkedExample() public {
        _replay("spec05-worked-example", false);
        assertEq(maxError, 0, "the worked example is exact");
        assertEq(maxErrorInt, 0);
    }

    function test_vector_zeroEligibleBootstrap() public {
        _replay("model-zero-eligible-bootstrap", false);
        assertEq(maxError, 0);
        assertEq(maxErrorInt, 0);
    }

    function test_vector_randomQMultipleOf3() public {
        _replay("random-q-multiple-of-3-seed42", false);
    }

    function test_vector_randomAnyQ() public {
        _replay("random-any-q-seed7", false);
    }

    function test_vector_randomPayoutT() public {
        _replay("random-payout-t-seed11", false);
    }

    function test_vector_dust() public {
        _replay("dust-seed5", false);
    }

    /// Custody flows: T donations to the collector (never burned, swept to the treasury), a second excluded role
    /// (the pool manager) as counterparty, and fee burns deferred to a later processFees.
    function test_vector_custody() public {
        _replay("custody-seed13", false);
    }

    function test_vectorFungible_spec05WorkedExample() public {
        _replay("spec05-worked-example", true);
        assertEq(maxError, 0, "the worked example is exact");
        assertEq(maxErrorInt, 0);
    }

    function test_vectorFungible_zeroEligibleBootstrap() public {
        _replay("model-zero-eligible-bootstrap", true);
        assertEq(maxError, 0);
        assertEq(maxErrorInt, 0);
    }

    function test_vectorFungible_randomQMultipleOf3() public {
        _replay("random-q-multiple-of-3-seed42", true);
    }

    function test_vectorFungible_randomAnyQ() public {
        _replay("random-any-q-seed7", true);
    }

    function test_vectorFungible_randomPayoutT() public {
        _replay("random-payout-t-seed11", true);
    }

    function test_vectorFungible_dust() public {
        _replay("dust-seed5", true);
    }

    function test_vectorFungible_custody() public {
        _replay("custody-seed13", true);
    }

    function _replay(string memory name, bool fungibleTemplate) internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/", name, ".json"));
        bool payoutT = vm.parseJsonBool(json, ".payoutT");
        IRewardLedger.PayoutAsset payout = payoutT ? IRewardLedger.PayoutAsset.T : IRewardLedger.PayoutAsset.Q;
        uint256 r = vm.parseUint(vm.parseJsonString(json, ".fractionsPerNft"));
        uint256 n = vm.parseUint(vm.parseJsonString(json, ".collectionSize"));
        vectorUnit = vm.parseUint(vm.parseJsonString(json, ".unit"));
        // F10: the supply is always 1e27 raw; one NFT is 1e27 / N (exact), r = 1e9 / N when an integer, else 0.
        assertEq(vectorUnit * n, 1e27, "vector unit = 1e27 / N, exact");
        assertEq(r, 1e9 % n == 0 ? 1e9 / n : 0, "vector r");
        if (fungibleTemplate) _deployFungible(payout, 1e9);
        else _deploy(payout, r, n);
        if (!fungibleTemplate) {
            assertEq(UNIT, vectorUnit, "on-chain unit");
            assertEq(token.fractionsPerNft(), r, "on-chain r");
        }
        assertEq(tt.initialSupply(), 1e27);
        _etch7702(carol, address(0x7702)); // carol: EIP-7702 EOA (receives NFTs)
        _etchContract(dave); // dave: contract holder (skips NFTs)
        party = [alice, bob, carol, dave, launcher, poolManager];
        assertEq(vm.parseJsonUint(json, ".numAccounts"), 4);

        Vector memory v = _parse(json);
        for (uint256 s; s < v.steps; ++s) {
            _execute(v, s);
            _check(v, s);
        }
        console.log("vector", name, fungibleTemplate ? "(fungible template)" : "(collection template)");
        console.log("  steps", v.steps);
        console.log("  max |onchain - floor(integer-split model)| wei", maxErrorInt);
        console.log("  max |onchain - floor(raw model)| wei", maxError);
        console.log("  final raw-model bound wei", v.bound[v.steps - 1]);
    }

    function _parse(string memory json) internal pure returns (Vector memory v) {
        v.steps = vm.parseJsonUint(json, ".steps");
        v.kind = vm.parseJsonUintArray(json, ".opKind");
        v.a = vm.parseJsonUintArray(json, ".opA");
        v.b = vm.parseJsonUintArray(json, ".opB");
        v.amount = vm.parseJsonStringArray(json, ".opAmount");
        v.t = vm.parseJsonStringArray(json, ".opT");
        v.q = vm.parseJsonStringArray(json, ".opQ");
        v.balances = vm.parseJsonStringArray(json, ".expBalances");
        v.cumulative = vm.parseJsonStringArray(json, ".expCumulative");
        v.cumulativeInt = vm.parseJsonStringArray(json, ".expCumulativeInt");
        v.supply = vm.parseJsonStringArray(json, ".expSupply");
        v.burned = vm.parseJsonStringArray(json, ".expBurned");
        v.qReceived = vm.parseJsonStringArray(json, ".expQReceived");
        v.protocolFloor = vm.parseJsonStringArray(json, ".expProtocolFloor");
        v.bound = vm.parseJsonUintArray(json, ".expBound");
    }

    function _execute(Vector memory v, uint256 s) internal {
        uint256 kind = v.kind[s];
        address from = party[v.a[s]];
        if (kind == OP_TRANSFER) {
            vm.prank(from);
            tt.transfer(party[v.b[s]], vm.parseUint(v.amount[s]));
        } else if (kind == OP_NFT) {
            if (isCollection) {
                assertGe(mirror.balanceOf(from), 1, "vector expects an NFT here");
                uint256 id = token.ownedIds(from, 0, 1)[0];
                vm.prank(from);
                mirror.transferFrom(from, party[v.b[s]], id);
            } else {
                // Fungible template: the same economic move, one unit (r whole tokens) as a plain transfer.
                vm.prank(from);
                tt.transfer(party[v.b[s]], vectorUnit);
            }
        } else if (kind == OP_FEE) {
            _feeEvent(vm.parseUint(v.t[s]), vm.parseUint(v.q[s]));
            // The model burns at recognition; a deferred burn is reconciled through pendingBurnT in _check.
            if (v.b[s] != FEE_DEFER) collector.processFees();
        } else if (kind == OP_CLAIM_Q) {
            vm.prank(from);
            claimed[v.a[s]] += ledger.claim(from);
        } else if (kind == OP_CLAIM_T) {
            vm.prank(converter);
            claimed[v.a[s]] += ledger.claimFor(from, type(uint256).max);
            _buy(from, vm.parseUint(v.amount[s])); // payout T comes from the market, never minted or burned
        } else if (kind == OP_DONATE_T) {
            vm.prank(from);
            tt.transfer(address(collector), vm.parseUint(v.amount[s])); // never a fee event, never burned
        } else if (kind == OP_SWEEP_T) {
            assertEq(collector.sweepUnaccounted(address(tt)), vm.parseUint(v.amount[s]), "swept donations");
        } else if (kind == OP_PROCESS) {
            collector.processFees();
        } else {
            revert("unknown op");
        }
    }

    function _check(Vector memory v, uint256 s) internal {
        uint256 pendingBurn = collector.pendingBurnT();
        assertEq(tt.totalSupply() - pendingBurn, vm.parseUint(v.supply[s]), "supply");
        assertEq(collector.totalTBurned() + pendingBurn, vm.parseUint(v.burned[s]), "burned");
        assertEq(collector.totalQReceived(), vm.parseUint(v.qReceived[s]), "Q received");
        assertEq(collector.totalQProtocol(), vm.parseUint(v.protocolFloor[s]), "protocol share");
        uint256 eligible;
        for (uint256 i; i < 4; ++i) {
            uint256 balance = tt.balanceOf(party[i]);
            assertEq(balance, vm.parseUint(v.balances[s * 4 + i]), "balance");
            eligible += balance;
            uint256 onchain = claimed[i] + ledger.claimable(party[i]);
            uint256 errInt = _absDiff(onchain, vm.parseUint(v.cumulativeInt[s * 4 + i]));
            if (errInt > maxErrorInt) maxErrorInt = errInt;
            assertLe(errInt, INT_BOUND, "entitlement vs integer-split model");
            uint256 err = _absDiff(onchain, vm.parseUint(v.cumulative[s * 4 + i]));
            if (err > maxError) maxError = err;
            assertLe(err, v.bound[s], "entitlement vs raw model outside documented bound");
        }
        assertEq(ledger.eligibleSupply(), eligible, "eligible supply = the four accounts");
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
