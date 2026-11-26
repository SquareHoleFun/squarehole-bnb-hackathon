// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {S5M4Base} from "./S5M4Base.sol";
import {S5M4Kit} from "./S5M4Kit.sol";

/// @notice BC-138 on the S5.M4 kit's Standard boxes (every contract real, the version factory v1 deploys): what a box's
/// first steps write from zero, slot by slot. Only what no creation can fill: the module's own PoolManager claim
/// balances and its T balance (each holds value, so only value fills it) and receiver ledgers that book real claims
/// (the note slot beside a `moduleBack` ledger, once per side; a creator box's first owed creator Q and T). Nothing in
/// the module, the hook, the sampler, the coordinator or anywhere else; the steady steps write nothing from zero
/// (S5M4Gas). The creation pays the rest (`initialize`: the module's ledgers, the receiver's fee-note allowances).
contract S5M4FirstStepsTest is S5M4Base {
    struct Seen {
        uint256 pm;
        uint256 token;
        uint256 receiver;
    }

    function setUp() public {
        _setUpLocal();
        _createAll();
        a = k.addresses();
        _box0Graduated();
        _stdGraduated(D);
        _stdGraduated(C);
    }

    function test_BC138_theFirstStepsWriteFromZeroOnlyBalancesAndLedgersThatHoldValue() public {
        S5M4Kit.StdBox memory d = _std(D);
        S5M4Kit.StdBox memory c = _std(C);
        _fees(d);
        _fees(c);
        Seen memory s = _first(d, IBoxSwapModule.Action.BuyBurn);
        assertEq(s.pm, 2, "BuyBurn: the module's Q and T claim balances (its pull hands both sides)");
        assertEq(s.token, 1, "BuyBurn: the module's T balance (bought T, burned less 1 raw unit)");
        assertEq(s.receiver, 1, "BuyBurn: the receiver's Q note slot");
        k.roll(1);
        s = _first(d, IBoxSwapModule.Action.SellForFit);
        assertEq(s.pm + s.token, 0, "SellForFit after it: no balance new");
        assertEq(s.receiver, 1, "SellForFit: the receiver's T note slot");
        s = _first(c, IBoxSwapModule.Action.BuyForCreator);
        assertEq(s.pm, 2, "BuyForCreator: the module's Q and T claim balances");
        assertEq(s.token, 0, "BuyForCreator: no T taken (the creator's T is minted to the receiver as claims)");
        assertEq(s.receiver, 2, "BuyForCreator: the Q note slot and the creator's first owed T");
        k.roll(1);
        s = _first(c, IBoxSwapModule.Action.SellForCreator);
        assertEq(s.pm + s.token, 0, "SellForCreator after it: no balance new");
        assertEq(s.receiver, 2, "SellForCreator: the T note slot and the creator's first owed Q");
    }

    /// Fees on both sides through real trades, an hour of samples, one batch: every module ledger has a step's worth.
    function _fees(S5M4Kit.StdBox memory x) internal {
        _trade(x.key, x.token, 2 ether, 3);
        _hold(x.sampler, 300);
        BoxReceiver(payable(x.receiver)).collect(keeper);
    }

    /// One step, its slots written from zero sorted by account; any other account, or a PoolManager or T slot that is
    /// not one of the module's balances, fails.
    function _first(S5M4Kit.StdBox memory x, IBoxSwapModule.Action action) internal returns (Seen memory s) {
        vm.startStateDiffRecording();
        (IBoxSwapModule.Stop stop,,,) = BoxSwapModule(x.module).step(action, keeper);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.None), "fixture: it stepped");
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory w = acc[i].storageAccesses[j];
                if (!w.isWrite || w.reverted || w.previousValue != bytes32(0) || w.newValue == bytes32(0)) continue;
                _sort(x, w, s);
            }
        }
    }

    function _sort(S5M4Kit.StdBox memory x, VmSafe.StorageAccess memory w, Seen memory s) internal view {
        uint256 v = uint256(vm.load(w.account, w.slot));
        if (w.account == address(pm)) {
            assertTrue(
                v == _claims(x.module, address(0)) || v == _claims(x.module, x.token),
                "a PoolManager slot: the module's"
            );
            ++s.pm;
        } else if (w.account == x.token) {
            assertEq(v, BoxToken(x.token).balanceOf(x.module), "a T slot: the module's balance");
            ++s.token;
        } else if (w.account == x.receiver) {
            ++s.receiver;
        } else {
            revert(string.concat("a slot from zero elsewhere: ", vm.toString(w.account)));
        }
    }
}
