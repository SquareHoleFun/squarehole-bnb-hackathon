// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../../fee-modules/ReceiverDeploy.sol";
import {M244Base} from "../../m2-44/Fixture.sol";
import {GasBudget} from "../GasBudget.sol";

/// Cold accounts AND storage, gross call cost plus intrinsic/calldata floor, no refund discount.
/// EOA envelope only: Safe/7702/router envelopes and arbitrary issuer code need their own budget.
abstract contract M260Measure is M244Base {
    function setUp() public virtual override {
        super.setUp();
        // Refuse accidentally selected alternate v4 compiler-profile artifacts in gas fixtures.
        // Integrated joint-review fixes, measured by SH-V2-INT-PINS on the release profile.
        assertEq(release.implementations[0].code.length, 22064);
        assertEq(release.implementations[2].code.length, 21670);
        assertEq(release.implementations[5].code.length, 17646); // RC7: additive allocation cursor view
        assertEq(release.implementations[17].code.length, 9107);
        assertEq(release.implementations[19].code.length, 3690);
        assertEq(release.implementations[20].code.length, 5809); // constant-work current supply read
        assertEq(release.implementations[21].code.length, 19229); // RC6-CREATION-GAS immutable seed/prices
    }
    function _cold() internal {
        for (uint256 i; i < 24; ++i) {
            address implementation = release.implementations[i];
            if (implementation != address(0)) {
                vm.cool(implementation);
                // Fixed constructor-created helpers (receiver/coordinator/shop/tickets/vault).
                address helper = vm.computeCreateAddress(implementation, 1);
                if (helper.code.length != 0) vm.cool(helper);
                if (i == 5) ReceiverDeploy.cool(implementation);
            }
            if (address(box) != address(0)) {
                address part = box.roleAddress(i);
                if (part != address(0)) vm.cool(part);
            }
        }
        vm.cool(address(pm));
        if (address(box) != address(0)) {
            address p = box.q();
            if (p != address(0)) vm.cool(p);
            vm.cool(address(box));
        }
        if (address(nft) != address(0)) vm.cool(address(nft));
    }

    function _measure(string memory name, address target, address caller, bytes memory data, uint256 ceiling)
        internal returns (bytes memory result, uint256 used)
    {
        _cold(); vm.cool(target);
        vm.prank(caller);
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = target.call{gas: ceiling}(data);
        uint256 delta = beforeGas - gasleft();
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        used = GasBudget.transaction(delta, data);
        emit log_named_uint(name, used);
        assertLt(used, ceiling, name);
        return (ret, used);
    }
}
