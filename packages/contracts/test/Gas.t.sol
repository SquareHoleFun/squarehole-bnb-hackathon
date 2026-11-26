// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DN404} from "dn404/DN404.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {Fixture} from "./utils/Fixture.sol";

/// @notice Unmodified DN404 at the pin (default Permit2 and skip-NFT behaviour): the baseline for overhead. Its unit
/// is set to SquareHoleToken's (F10: 1e27 / N raw), so both tokens move the same raw amounts per NFT.
contract PlainDN404 is DN404 {
    uint256 internal immutable _plainUnit;

    constructor(uint256 supply, address holder, uint256 unit_) {
        _plainUnit = unit_;
        _initializeDN404(supply, holder, address(new DN404Mirror(msg.sender)));
    }

    function _unit() internal view override returns (uint256) {
        return _plainUnit;
    }

    function name() public pure override returns (string memory) {
        return "Plain";
    }

    function symbol() public pure override returns (string memory) {
        return "PLN";
    }

    function _tokenURI(uint256) internal pure override returns (string memory) {
        return "";
    }

    function ownedIds(address owner, uint256 begin, uint256 end) external view returns (uint256[] memory) {
        return _ownedIds(owner, begin, end);
    }
}

/// @notice Gas of the SH-B1 operations for SquareHoleToken and the unmodified DN404 baseline from identical
/// holder states. Run with `forge test --match-contract GasTest --isolate`: every call is its own transaction
/// (cold storage, 21k intrinsic included), the method of ADR-0006's table. Results: snapshots/*.json.
/// Ledger states: `steady` = no fee event since the parties' last checkpoint (the ledger only reads);
/// `firstAccrual` = a fee event since, and the parties have never accrued (checkpoint and entitlement slots go
/// from zero to non-zero); `repeatAccrual` = a fee event since, and both slots are already non-zero.
contract GasTest is Fixture {
    PlainDN404 internal plain;
    DN404Mirror internal plainMirror;
    address internal fresh = makeAddr("fresh");

    function setUp() public {
        // F10: N = 10,000 (The Misfits' size), one NFT = 1e23 raw = 100,000 tokens; the baseline uses the same unit.
        _deploy(IRewardLedger.PayoutAsset.Q, 0, 10_000);
        plain = new PlainDN404(10_000 * UNIT, launcher, UNIT);
        plainMirror = DN404Mirror(payable(plain.mirrorERC721()));
        // Identical holder state in both tokens: alice 5.5 units, bob 2.2 units, carol 1 unit, and 1,000 units of
        // pool reserves in the (excluded, skip-NFT) pool manager.
        vm.startPrank(launcher);
        token.transfer(alice, 5 * UNIT + UNIT / 2);
        token.transfer(bob, 2 * UNIT + UNIT / 5);
        token.transfer(carol, UNIT);
        token.transfer(poolManager, 1_000 * UNIT);
        plain.transfer(alice, 5 * UNIT + UNIT / 2);
        plain.transfer(bob, 2 * UNIT + UNIT / 5);
        plain.transfer(carol, UNIT);
        plain.transfer(poolManager, 1_000 * UNIT);
        vm.stopPrank();
    }

    function test_gas_baselinePlainDN404() public {
        _measureAll(false, "baseline");
    }

    function test_gas_steady() public {
        _measureAll(true, "steady");
    }

    function test_gas_firstAccrual() public {
        _feeEvent(0, 3e18);
        _measureAll(true, "firstAccrual");
    }

    function test_gas_repeatAccrual() public {
        _feeEvent(0, 3e18);
        address[3] memory holders = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(holders[i]);
            token.transfer(holders[i], 0); // settles: checkpoint and entitlement become non-zero
        }
        _feeEvent(0, 3e18);
        _measureAll(true, "repeatAccrual");
    }

    function _measureAll(bool squareHole, string memory state) internal {
        uint256 snap = vm.snapshotState();
        for (uint256 op; op < 8; ++op) {
            _op(squareHole, op, state);
            vm.revertToState(snap);
        }
    }

    function _op(bool sh, uint256 op, string memory state) internal {
        DN404 t = sh ? DN404(payable(address(token))) : DN404(payable(address(plain)));
        string memory group = sh ? "SquareHole" : "PlainDN404";
        if (op == 0) {
            // Fractional transfer between holders, no NFT change (5.5 → 5.4, 2.2 → 2.3).
            vm.prank(alice);
            t.transfer(bob, UNIT / 10);
            vm.snapshotGasLastCall(group, string.concat(state, "_fractionalTransfer"));
        } else if (op == 1) {
            // Buy-size transfer from skip-NFT inventory to a new wallet: materializes 1 NFT.
            vm.prank(launcher);
            t.transfer(fresh, UNIT);
            vm.snapshotGasLastCall(group, string.concat(state, "_buy1UnitNewWallet"));
        } else if (op == 2) {
            vm.prank(launcher);
            t.transfer(fresh, 10 * UNIT);
            vm.snapshotGasLastCall(group, string.concat(state, "_buy10UnitsNewWallet"));
        } else if (op == 3) {
            // Existing holder crosses a unit boundary (2.2 → 3.0 mints one NFT).
            vm.prank(launcher);
            t.transfer(bob, 4 * UNIT / 5);
            vm.snapshotGasLastCall(group, string.concat(state, "_buyCrossesBoundary"));
        } else if (op == 4) {
            // Whole NFT through the mirror between existing holders.
            DN404Mirror m = sh ? mirror : plainMirror;
            uint256 id = sh ? token.ownedIds(alice, 0, 1)[0] : plain.ownedIds(alice, 0, 1)[0];
            vm.prank(alice);
            m.transferFrom(alice, carol, id);
            vm.snapshotGasLastCall(group, string.concat(state, "_mirrorTransferFrom"));
        } else if (op == 5) {
            // Sell one unit into skip-NFT inventory (burns one NFT).
            vm.prank(alice);
            t.transfer(launcher, UNIT);
            vm.snapshotGasLastCall(group, string.concat(state, "_sell1Unit"));
        } else if (op == 6) {
            // PoolManager.take of one unit to a new wallet (mints 1 NFT; adds to the ledger's transient outflow).
            vm.prank(poolManager);
            t.transfer(fresh, UNIT);
            vm.snapshotGasLastCall(group, string.concat(state, "_poolTake1UnitNewWallet"));
        } else {
            // Settle one unit into the pool manager (burns one NFT; reads the transient outflow).
            vm.prank(alice);
            t.transfer(poolManager, UNIT);
            vm.snapshotGasLastCall(group, string.concat(state, "_poolSettle1Unit"));
        }
    }

    function test_gas_feePathAndClaim() public {
        _prepareFee(30 * UNIT, 3e18);
        vm.prank(hook);
        collector.receiveFees(30 * UNIT, 3e18);
        vm.snapshotGasLastCall("SquareHole", "receiveFees_T_and_Q");

        _prepareFee(0, 3e18);
        vm.prank(hook);
        collector.receiveFees(0, 3e18);
        vm.snapshotGasLastCall("SquareHole", "receiveFees_Q_only");

        collector.processFees();
        vm.snapshotGasLastCall("SquareHole", "processFees_burnT_payProtocolQ");

        // Steady-state receipt: the collector's counters are already non-zero.
        _prepareFee(30 * UNIT, 3e18);
        vm.prank(hook);
        collector.receiveFees(30 * UNIT, 3e18);
        vm.snapshotGasLastCall("SquareHole", "receiveFees_T_and_Q_repeat");

        collector.processFees();
        vm.snapshotGasLastCall("SquareHole", "processFees_repeat");

        vm.prank(alice);
        ledger.claim(alice);
        vm.snapshotGasLastCall("SquareHole", "claim_first");

        _feeEvent(0, 3e18);
        vm.prank(alice);
        ledger.claim(alice);
        vm.snapshotGasLastCall("SquareHole", "claim_repeat");
    }
}
