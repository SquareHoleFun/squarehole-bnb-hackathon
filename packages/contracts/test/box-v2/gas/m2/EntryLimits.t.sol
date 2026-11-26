// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M260Measure} from "./Measure.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IHolderLedgerV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {HostileToken} from "../../kit/HostileToken.sol";
import {CQATrader} from "../../cq11-a/Fixture.sol";
import {GasBudget} from "../GasBudget.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// M263-MONEY-03/R02: ordinary transactions retain room after raising the optional notice cap.
/// Real factory/PM/parts; only optional ledger code is fault-injected. Assets and router are fixtures.
contract M260EntryLimitsTest is M260Measure {
    uint256 private constant OUTER_GAS = 5_000_000;
    uint256 private constant TX_CAP = 16_777_216;
    uint256 private constant BLOCK_LIMIT = 30_000_000;

    function test_entryLimitsNative() public { _matrix(0); }
    function test_entryLimits6Decimals() public { _matrix(6); }
    function test_entryLimits8Decimals() public { _matrix(8); }
    function test_entryLimits18Decimals() public { _matrix(18); }

    function _matrix(uint8 decimals) private {
        // Plain token; real ledger; reverting, exhausted and large-return-data ledger.
        for (uint256 mode; mode < 5; ++mode) {
            uint256 initial = vm.snapshotState();
            BoxSpec memory s = mode == 0 ? _menu(3, 3) : _holders();
            if (decimals != 0) {
                (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
                s.pricing = priced.pricing; s.raise = priced.raise;
            }
            s.creatorBuy = s.raise / 100;
            _start(s);
            ledger = IHolderLedgerV2(box.roleAddress(17));
            CQATrader trader = new CQATrader(pm);
            if (decimals == 0) vm.deal(address(trader), box.raise());
            else HostileToken(box.q()).mint(address(trader), box.raise());
            trader.trade(hook.poolKey(), true, -int256(box.raise() / 100), layout.sqrtPriceEndX96);
            if (mode != 0) { vm.prank(address(trader)); ledger.register(); }
            if (mode == 2) vm.etch(address(ledger), hex"60006000fd");
            if (mode == 3) vm.etch(address(ledger), hex"fe");
            if (mode == 4) vm.etch(address(ledger), hex"620100006000fd");
            emit log_named_uint("ledger mode", mode);
            _fourTrades(trader, mode != 0);
            // Repeat every swap kind after full-range graduation, restoring for failure claims below.
            uint256 live = vm.snapshotState();
            _fill(); box.graduate();
            _fourTrades(trader, mode != 0);
            assertTrue(vm.revertToState(live));
            _transfers();
            vm.warp(box.deadline()); box.fail();
            _failureClaim();
            assertTrue(vm.revertToState(initial));
        }
    }

    function _fourTrades(CQATrader trader, bool holders) private {
        for (uint256 kind; kind < 4; ++kind) {
            uint256 saved = vm.snapshotState();
            bool buy = kind < 2; bool exactOut = kind % 2 == 1;
            uint256 amount = buy ? (exactOut ? token.balanceOf(address(trader)) / 100 : box.raise() / 1000)
                : (exactOut ? box.raise() / 100000 : token.balanceOf(address(trader)) / 100);
            uint256 id = hook.currentTradeBatch(buy);
            uint256 beforeUnits = hook.tradeBatch(id).tradeUnits;
            uint256 beforeT = token.balanceOf(address(trader));
            uint256 supply = token.totalSupply();
            _bounded(string.concat(buy ? "bounded buy " : "bounded sale ", exactOut ? "exact out" : "exact in"),
                address(trader), address(this), abi.encodeCall(trader.trade, (hook.poolKey(), buy,
                    exactOut ? int256(amount) : -int256(amount), buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)));
            if (buy) assertGt(token.balanceOf(address(trader)), beforeT);
            else assertLt(token.balanceOf(address(trader)), beforeT);
            assertEq(token.totalSupply(), supply);
            if (holders) assertGt(hook.tradeBatch(id).tradeUnits, beforeUnits, "failed notice retains weight");
            else assertEq(id, 0, "plain trade has no holder path");
            assertTrue(vm.revertToState(saved));
        }
    }

    function _transfers() private {
        uint256 amount = token.balanceOf(CREATOR) / 4;
        uint256 beforeT = token.balanceOf(CREATOR);
        _bounded("bounded fresh-wallet transfer", address(token), CREATOR,
            abi.encodeCall(token.transfer, (ALICE, amount)));
        assertEq(token.balanceOf(ALICE), amount);
        assertEq(token.balanceOf(CREATOR), beforeT - amount);
        vm.prank(ALICE); token.approve(address(this), amount);
        _bounded("bounded transferFrom", address(token), address(this),
            abi.encodeCall(token.transferFrom, (ALICE, address(0xb0b), amount)));
        assertEq(token.balanceOf(ALICE), 0); assertEq(token.balanceOf(address(0xb0b)), amount);
    }

    function _failureClaim() private {
        uint256 amount = token.balanceOf(CREATOR);
        vm.prank(CREATOR); token.approve(address(box), amount);
        uint256 expected = box.quoteClaim(amount); assertGt(expected, 0);
        uint256 beforeP = _balance(ALICE);
        (uint256 pot, uint256 left) = box.claimState();
        _bounded("bounded failure claim", address(box), CREATOR, abi.encodeCall(box.claim, (amount, ALICE)));
        assertEq(_balance(ALICE) - beforeP, expected); assertEq(token.balanceOf(CREATOR), 0);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterLeft, left - amount); assertEq(afterPot, pot - expected);
    }

    function _bounded(string memory label, address target, address caller, bytes memory data) private {
        // RC7: only coordinator claims retain the additional 4M post-inbox reserve.
        uint256 limit = target == address(box) ? 9_000_000 : OUTER_GAS;
        (, uint256 used) = _measure(label, target, caller, data, limit);
        // Charge the entire gross total as execution, even on Amsterdam: conservative for EIP-7825.
        assertLt(used * 130 / 100 + 500_000, TX_CAP, "execution gas plus estimate margin");
        uint256 supplied = limit + GasBudget.intrinsic(data);
        assertLt(supplied, TX_CAP, "submitted transaction gas cap");
        assertLt(supplied * 115 / 100 * 110 / 100 + 5_000_000, BLOCK_LIMIT, "block room including state gas");
    }
}
