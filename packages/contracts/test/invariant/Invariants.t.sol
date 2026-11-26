// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console} from "forge-std/console.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {Fixture} from "../utils/Fixture.sol";
import {Handler} from "./Handler.sol";

/// @notice The checks behind every invariant: ECO-01, 02, 03, 05, 06, 08, 10, 11, 12, 15, 16 and the reference
/// model's identities (square-hole-handoff/reference/fee_policy_model.py `assert_invariants`), for either launch
/// template, with fee funds held as Uniswap v4 ERC-6909 claims (ADR-0011).
abstract contract InvariantChecks is Fixture {
    Handler internal handler;
    string internal suiteLabel;

    function _setUpHandler(IRewardLedger.PayoutAsset payout, bool fungibleTemplate) internal {
        if (fungibleTemplate) _deployFungible(payout, 1e9);
        else _deploy(payout, 1e6, 1_000);
        handler = new Handler(
            Handler.Wiring({
                token: tt,
                mirror: mirror,
                unit: UNIT,
                ledger: ledger,
                collector: collector,
                quote: quote,
                funder: funder,
                launcher: launcher,
                hook: hook,
                converter: converter
            })
        );
    }

    /// Model: supply == initial − burned. ECO-11: economic burns (and only they) reduce totalSupply.
    function _checkSupply() internal view {
        assertEq(tt.totalSupply(), tt.initialSupply() - collector.totalTBurned(), "supply");
    }

    /// ECO-01: native F_T = burned + pending burn, and the pending part is really held (as claims). The collector's
    /// receipt counter equals the T the handler actually delivered through the fee source (external truth).
    function _checkFeeT() internal view {
        assertEq(collector.totalTReceived(), handler.ghostTIn(), "fee T received == T delivered");
        assertEq(collector.totalTReceived(), collector.totalTBurned() + collector.pendingBurnT(), "fee T");
        assertGe(_claims(address(collector), address(tt)), collector.pendingBurnT(), "fee T held as claims");
    }

    /// ECO-03 / ECO-10 / model: Q received == protocol + holders + remainder (1:2 exactly); protocol Q is paid or
    /// pending; holders' Q went to the ledger; nothing owed is missing from either contract.
    function _checkQ() internal view {
        assertEq(collector.totalQReceived(), handler.ghostQIn(), "fee Q received == Q delivered");
        assertEq(
            collector.totalQReceived(),
            collector.totalQProtocol() + collector.totalQHolders() + collector.qRemainder(),
            "F_Q identity"
        );
        assertLt(collector.qRemainder(), 3);
        assertEq(collector.totalQHolders(), 2 * collector.totalQProtocol(), "1:2 split");
        assertEq(collector.totalQProtocol(), collector.totalQToTreasury() + collector.protocolQPending());
        assertEq(collector.totalQHolders(), ledger.totalHolderQReceived(), "holder Q reached the ledger");
        assertGe(_claims(address(collector), address(quote)), collector.protocolQPending() + collector.qRemainder());
        assertGe(quote.balanceOf(treasury), collector.totalQToTreasury());
    }

    /// Model: q_holders == deferred + Σ pending (exact). On chain Σ claimable + bootstrap + claimed never exceeds
    /// holder Q received and falls short by at most one wei per account plus one (ECO-08, ECO-15).
    function _checkHolderQ() internal view {
        uint256 sum = ledger.bootstrapQ() + ledger.totalClaimed();
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            sum += ledger.claimable(handler.actorAt(i));
        }
        uint256 received = ledger.totalHolderQReceived();
        assertLe(sum, received, "over-allocated");
        assertLe(received - sum, n + 1, "dust above bound");
        assertEq(received, ledger.totalHolderQIndexed() + ledger.bootstrapQ());
        assertEq(ledger.bootstrapQ(), handler.ghostBootstrap(), "bootstrap follows the deferred rule");
        assertGe(_claims(address(ledger), address(quote)), received - ledger.totalClaimed(), "ledger solvent");
    }

    /// Custody: every Q and T claim of the launch's contracts (and anything swept to the treasury as claims) is
    /// backed by the PoolManager's real balance (v4 guarantees it after every unlock; asserted here end to end).
    function _checkCustodyBacked() internal view {
        uint256 qClaims = _claims(address(collector), address(quote)) + _claims(address(ledger), address(quote))
            + _claims(treasury, address(quote)) + _claims(converter, address(quote));
        assertGe(quote.balanceOf(poolManager), qClaims, "Q claims backed");
        uint256 tClaims = _claims(address(collector), address(tt)) + _claims(treasury, address(tt));
        assertGe(tt.balanceOf(poolManager), tClaims, "T claims backed");
        assertEq(_claims(hook, address(quote)) + _claims(hook, address(tt)), 0, "fee source keeps no claims");
    }

    /// ECO-05, ECO-09: every account's entitlement (claimed + claimable) equals the ghost's direct pro-rata split
    /// at each fee event over the balances held at that event, within one wei.
    function _checkEntitlements() internal view {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            assertLe(handler.entitlementError(handler.actorAt(i)), 1, "entitlement vs ghost");
        }
    }

    /// Eligible supply == totalSupply − Σ excluded balances == Σ actor balances.
    function _checkEligibleSupply() internal view {
        assertEq(ledger.eligibleSupply(), tt.totalSupply() - _excludedBalance(), "eligible supply");
        uint256 actorsSum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            actorsSum += tt.balanceOf(handler.actorAt(i));
        }
        assertEq(ledger.eligibleSupply(), actorsSum);
    }

    /// ECO-12: excluded roles never accrue, even while holding T.
    function _checkExcluded() internal view {
        address[9] memory ex = ledger.excludedAccounts();
        for (uint256 i; i < ex.length; ++i) {
            if (ex[i] == address(0)) continue;
            assertEq(ledger.claimable(ex[i]), 0);
            (uint256 cp, uint256 accruedScaled) = ledger.accountState(ex[i]);
            assertEq(cp, 0);
            assertEq(accruedScaled, 0);
        }
    }

    /// ECO-06 (collection template): the mirror never creates supply: NFTs ≤ whole units per account and in total;
    /// Σ NFT balances equals the mirror's totalSupply. The collector holds no NFT here because fee paths never
    /// materialize one (it is a skip-NFT contract and fee T reaches it only to be burned in the same call).
    function _checkNfts() internal view {
        if (!isCollection) return;
        uint256 nftSum;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actorAt(i);
            assertLe(mirror.balanceOf(a) * UNIT, tt.balanceOf(a));
            nftSum += mirror.balanceOf(a);
        }
        address[6] memory others = [launcher, poolManager, treasury, address(collector), address(ledger), hook];
        for (uint256 i; i < others.length; ++i) {
            assertLe(mirror.balanceOf(others[i]) * UNIT, tt.balanceOf(others[i]));
            nftSum += mirror.balanceOf(others[i]);
        }
        assertEq(nftSum, mirror.totalSupply(), "NFT supply");
        assertLe(mirror.totalSupply() * UNIT, tt.totalSupply());
        assertEq(mirror.balanceOf(address(collector)), 0, "fee paths never materialize NFTs");
    }

    /// ECO-02 / ECO-16: the fee paths leave no standing allowance (ERC-20 or ERC-6909); no ETH is ever stuck in T.
    function _checkAllowances() internal view {
        assertEq(tt.allowance(hook, address(collector)), 0);
        assertEq(quote.allowance(hook, address(collector)), 0);
        assertEq(pm.allowance(hook, address(collector), _id(address(tt))), 0);
        assertEq(pm.allowance(hook, address(collector), _id(address(quote))), 0);
        assertEq(pm.allowance(address(collector), address(ledger), _id(address(quote))), 0);
        assertEq(address(tt).balance, 0);
    }

    function _checkAll() internal view {
        _checkSupply();
        _checkFeeT();
        _checkQ();
        _checkHolderQ();
        _checkCustodyBacked();
        _checkEntitlements();
        _checkEligibleSupply();
        _checkExcluded();
        _checkNfts();
        _checkAllowances();
    }

    /// @dev Path-coverage counters of the current run, in a fixed order (names in `_counterName`).
    function _counters() internal view returns (uint256[14] memory c) {
        c[0] = handler.ghostFeeEvents();
        c[1] = handler.countAllocations();
        c[2] = handler.countDeferrals();
        c[3] = handler.countFlashReverts();
        c[4] = handler.countReleases();
        c[5] = handler.countFlashOps();
        c[6] = handler.countDustFees();
        c[7] = handler.countBurns();
        c[8] = handler.countClaimsPaid();
        c[9] = handler.countNftMoves();
        c[10] = handler.countCrossings();
        c[11] = handler.countSweeps();
        c[12] = handler.countExits();
        c[13] = handler.ghostMaxEntitlementError();
    }

    function _counterName(uint256 i) internal pure returns (string memory) {
        string[14] memory names = [
            "feeEvents",
            "allocations",
            "zeroSupplyDeferrals",
            "flashReverts",
            "releases",
            "flashOps",
            "dustFees",
            "burns",
            "claimsPaid",
            "nftMoves",
            "crossings",
            "sweeps",
            "exits",
            "maxErrWei"
        ];
        return names[i];
    }

    function _format(uint256[14] memory c) internal pure returns (string memory line) {
        for (uint256 i; i < c.length; ++i) {
            line = string.concat(line, i == 0 ? "" : " ", _counterName(i), "=", vm.toString(c[i]));
        }
    }

    function _coverageLine() internal view returns (string memory) {
        return _format(_counters());
    }
}

/// @notice Fuzzed stateful campaign (seeded by [fuzz] seed in foundry.toml).
abstract contract InvariantBase is InvariantChecks {
    function _setUpInvariant(IRewardLedger.PayoutAsset payout, bool fungibleTemplate, string memory label) internal {
        _setUpHandler(payout, fungibleTemplate);
        suiteLabel = label;
        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = Handler.transferFractional.selector;
        selectors[1] = Handler.transferWholeUnits.selector;
        selectors[2] = Handler.transferCrossingThreshold.selector;
        selectors[3] = Handler.transferNft.selector;
        selectors[4] = Handler.transferFromWithAllowance.selector;
        selectors[5] = Handler.toggleSkipNft.selector;
        selectors[6] = Handler.feeEvent.selector;
        selectors[7] = Handler.processFees.selector;
        selectors[8] = Handler.claim.selector;
        selectors[9] = Handler.donateToCollector.selector;
        selectors[10] = Handler.donateToLedger.selector;
        selectors[11] = Handler.sweep.selector;
        selectors[12] = Handler.everyoneExits.selector;
        selectors[13] = Handler.feeEvent.selector; // weight fee events ×2
        selectors[14] = Handler.flashFeeEvent.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_supplyIsInitialMinusFeeBurns() public view {
        _checkSupply();
    }

    function invariant_feeTReconciles() public view {
        _checkFeeT();
    }

    function invariant_qReconciles() public view {
        _checkQ();
    }

    function invariant_holderQNeverOverAllocatedDustBounded() public view {
        _checkHolderQ();
    }

    function invariant_custodyClaimsBacked() public view {
        _checkCustodyBacked();
    }

    function invariant_entitlementsMatchGhost() public view {
        _checkEntitlements();
    }

    function invariant_eligibleSupplyTracked() public view {
        _checkEligibleSupply();
    }

    function invariant_excludedNeverAccrue() public view {
        _checkExcluded();
    }

    function invariant_nftRepresentationConsistent() public view {
        _checkNfts();
    }

    function invariant_noStandingAllowancesOrEth() public view {
        _checkAllowances();
    }

    /// @dev Runs after every run; forge prints the logs of the final run only (-vv), so by default this line
    /// describes ONE run of the campaign. With SH_INVARIANT_AGGREGATE=true the counters are also summed across
    /// runs in process environment variables (EVM state is reset between runs, the environment is not; maxErrWei
    /// becomes the maximum), and the final line is the whole-campaign aggregate. forge calls this hook once more
    /// than `runs` (it re-executes one run to show its logs), so the aggregate counts about one run twice
    /// (~0.4% at 256 runs). Measurement only; run one suite at a time in that mode, e.g.
    /// `SH_INVARIANT_AGGREGATE=true forge test --match-contract InvariantsPayoutQ -vv`.
    function afterInvariant() external {
        if (!vm.envOr("SH_INVARIANT_AGGREGATE", false)) {
            console.log(string.concat("COVERAGE(one run of the campaign) ", _coverageLine()));
            return;
        }
        uint256[14] memory c = _counters();
        string memory prefix = string.concat("SH_INVARIANT_AGGREGATE_", suiteLabel, "_");
        uint256 runs = vm.envOr(string.concat(prefix, "runs"), uint256(0)) + 1;
        vm.setEnv(string.concat(prefix, "runs"), vm.toString(runs));
        for (uint256 i; i < c.length; ++i) {
            string memory key = string.concat(prefix, _counterName(i));
            uint256 previous = vm.envOr(key, uint256(0));
            c[i] = i == 13 ? (previous > c[i] ? previous : c[i]) : previous + c[i];
            vm.setEnv(key, vm.toString(c[i]));
        }
        console.log(string.concat("COVERAGE(aggregate of ", vm.toString(runs), " runs) ", _format(c)));
    }
}

contract InvariantsPayoutQ is InvariantBase {
    function setUp() public {
        _setUpInvariant(IRewardLedger.PayoutAsset.Q, false, "Q");
    }
}

contract InvariantsPayoutT is InvariantBase {
    function setUp() public {
        _setUpInvariant(IRewardLedger.PayoutAsset.T, false, "T");
    }
}

contract InvariantsFungiblePayoutQ is InvariantBase {
    function setUp() public {
        _setUpInvariant(IRewardLedger.PayoutAsset.Q, true, "FQ");
    }
}

contract InvariantsFungiblePayoutT is InvariantBase {
    function setUp() public {
        _setUpInvariant(IRewardLedger.PayoutAsset.T, true, "FT");
    }
}

/// @notice Deterministic 1,000-call handler sequences (arguments derived from keccak256 of the label and step,
/// no randomness), checking every invariant after each call and reporting aggregate path coverage. Gas metering
/// is paused: this is a correctness test and a sequence costs more than the per-test gas limit (NFT sync).
contract HandlerSequenceTest is InvariantChecks {
    uint256 internal constant STEPS = 1_000;

    function test_deterministicSequence_payoutQ_1() public {
        _setUpHandler(IRewardLedger.PayoutAsset.Q, false);
        _run("Q1");
    }

    function test_deterministicSequence_payoutQ_2() public {
        _setUpHandler(IRewardLedger.PayoutAsset.Q, false);
        _run("Q2");
    }

    function test_deterministicSequence_payoutT_1() public {
        _setUpHandler(IRewardLedger.PayoutAsset.T, false);
        _run("T1");
    }

    function test_deterministicSequence_payoutT_2() public {
        _setUpHandler(IRewardLedger.PayoutAsset.T, false);
        _run("T2");
    }

    function test_deterministicSequence_fungiblePayoutQ() public {
        _setUpHandler(IRewardLedger.PayoutAsset.Q, true);
        _run("FQ1");
    }

    function test_deterministicSequence_fungiblePayoutT() public {
        _setUpHandler(IRewardLedger.PayoutAsset.T, true);
        _run("FT1");
    }

    function _run(string memory label) internal {
        vm.pauseGasMetering();
        for (uint256 i; i < STEPS; ++i) {
            uint256 r = uint256(keccak256(abi.encode(label, i)));
            uint256 a1 = uint256(keccak256(abi.encode(r, 1)));
            uint256 a2 = uint256(keccak256(abi.encode(r, 2)));
            uint256 a3 = uint256(keccak256(abi.encode(r, 3)));
            uint256 a4 = uint256(keccak256(abi.encode(r, 4)));
            uint256 a5 = uint256(keccak256(abi.encode(r, 5)));
            uint256 op = r % 16;
            if (op == 0) handler.transferFractional(a1, a2, a3);
            else if (op == 1) handler.transferWholeUnits(a1, a2, a3);
            else if (op == 2) handler.transferCrossingThreshold(a1, a2);
            else if (op == 3) handler.transferNft(a1, a2, a3, a3 % 2 == 0);
            else if (op == 4) handler.transferFromWithAllowance(a1, a2, a3);
            else if (op == 5) handler.toggleSkipNft(a1, a2 % 2 == 0);
            else if (op <= 7) handler.feeEvent(a1, a2);
            else if (op == 8) handler.processFees();
            else if (op <= 10) handler.claim(a1, a2);
            else if (op == 11) handler.donateToCollector(a1, a2, a3);
            else if (op == 12) handler.donateToLedger(a1);
            else if (op == 13) handler.sweep(a1);
            else if (op == 14) handler.everyoneExits(a1); // acts on 1 call in 16: about 1 in 256 steps
            else handler.flashFeeEvent(a1, a2, a3, a4, a5);
            _checkAll();
        }
        console.log(string.concat("SEQUENCE ", label, " steps=", vm.toString(STEPS), " ", _coverageLine()));
    }
}
