// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {EatLife} from "./Lifecycle.t.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxReceiverV2Args} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";

contract EatGasProbe is BoxReceiverV2 {
    constructor(IPoolManager pm, address c, address f, address p, address x) BoxReceiverV2(pm, c, f, p, ReceiverDeploy.code(pm)) {}
    function caps() external pure returns (uint256, uint256) { return (EAT_GAS, EAT_RESERVE_GAS); }
    // Test-only instrumentation; production callback and its full exactness checks remain inherited.
    function measured(uint256 cap) external locked returns (uint256 used) {
        _prepare();
        uint256 amount = _eatPendingP;
        _eatPendingP = 0;
        uint256 before_ = gasleft();
        require(_tryUnlock(EAT_PRICE, _priceCoin(), address(0xdEaD), amount, cap), "eat probe refused");
        used = before_ - gasleft();
    }
}
contract EatGasTest is EatLife {
    function _cold(address probe) internal {
        address[48] memory parts;
        for (uint256 i; i < 24; ++i) {
            parts[i] = box.roleAddress(i); parts[i + 24] = origin.roleAddress(i);
        }
        for (uint256 i; i < 24; ++i) {
            address impl = release.implementations[i];
            if (impl == address(0)) continue;
            address child = vm.computeCreateAddress(impl, 1);
            if (child.code.length != 0) vm.cool(child);
            if (i == 5) ReceiverDeploy.cool(impl);
            vm.cool(impl);
        }
        for (uint256 i; i < 48; ++i) if (parts[i] != address(0)) vm.cool(parts[i]);
        ReceiverDeploy.cool(probe);
        vm.cool(probe); vm.cool(address(0xdEaD)); vm.cool(address(pm));
    }
    function test_EAT18_coldLinkedBurnTwiceMargin() public { _measure(true, false); }
    function test_EAT18_coldFirstEligibleBurnTwiceMargin() public { _measure(true, true); }
    function test_EAT18_coldFirstEligibleDeadWalletTwiceMargin() public { _measure(false, true); }
    function test_EAT18_coldLongHistoryDeadWalletTwiceMargin() public { _measure(false, false); }
    function _measure(bool burn, bool first) internal {
        // V21-MONEY-01: creation refuses an unchecked box coin, so this ledger T's eater is always checked. The lock
        // cases clear the snapshot selector in the probe's runtime below: the first-eligible and long-history
        // dead-wallet locks stay measured as the heaviest history-writing-token bound for EAT_GAS.
        _linkedEat(true, first); _fill(); box.graduate(); receiver.collect(address(0));
        if (first) assertEq(BoxTokenV2Ledger(address(price)).holderCount(), 0);
        if (!first) {
            vm.pauseGasMetering();
            for (uint256 i; i < 512; ++i) {
                vm.prank(address(buyer)); price.transfer(address(0xdEaD), 1);
                // Test setup builds real history; production can never act as the dead wallet.
                vm.prank(address(0xdEaD)); price.transfer(address(buyer), 1);
            }
            vm.resumeGasMetering();
        }
        EatGasProbe code = new EatGasProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(code))[i];
        if (!burn) for (uint256 i; i < 4; ++i) runtime[BoxClones.ARGS_OFFSET + BoxReceiverV2Args.LENGTH + i] = 0;
        vm.etch(address(receiver), runtime);
        EatGasProbe probe = EatGasProbe(address(receiver));
        assertEq(eat.priceBurnSelector(), burn ? BURN : bytes4(0), "measured mode");
        (uint256 cap,) = probe.caps();
        uint256 amount = eat.eatPendingP(); uint256 supply = price.totalSupply();
        uint256 snapshot = vm.snapshotState(); _cold(address(code));
        uint256 used = probe.measured(6_000_000);
        emit log_named_uint(burn ? "cold checked P burn unlock" : "cold P lock unlock", used);
        assertLe(used * 2, cap, "twice strict complete unlock bound");
        assertEq(price.totalSupply(), burn ? supply - amount : supply);
        assertTrue(vm.revertToState(snapshot)); _cold(address(code));
        probe.measured(cap / 2);
        assertEq(price.totalSupply(), burn ? supply - amount : supply);
    }
}
