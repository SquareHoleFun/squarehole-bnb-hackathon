// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../../fee-modules/ReceiverDeploy.sol";

import {M340Base} from "../../m3-40/Fixture.sol";
import {GasBudget} from "../GasBudget.sol";
import {BoxHookV2} from "../../../../src/box-v2/BoxHookV2.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {SparseBoxTree} from "../../../box/items/BoxItemsKit.sol";

/// M360: real coordinator/PM/M3 parts; the inherited, explicitly named hook/checker S6 doubles remain.
/// Gross EOA transaction bounds include intrinsic/calldata floor; refunds never subsidize admission.
abstract contract M360Measure is M340Base {
    uint256 internal constant TX_LIMIT = 49_500_000;
    uint256 internal constant CUSTODY_LIMIT = 8_000_000;
    address internal constant ALICE = address(0xA360);
    address internal constant BOB = address(0xB360);

    function setUp() public virtual override {
        super.setUp();
        assertEq(release.implementations[0].code.length, 22064, "default coordinator profile");
        assertEq(release.implementations[5].code.length, 17646, "default receiver profile");
        assertEq(release.implementations[16].code.length, 16080, "default item ledger profile");
        assertEq(release.implementations[22].code.length, 7515, "default pile profile");
    }

    function _cold() internal {
        address[24] memory parts;
        for (uint256 i; i < 24; ++i) {
            if (address(box) != address(0)) parts[i] = box.roleAddress(i);
        }
        address extension = BoxHookV2(release.implementations[2]).extension();
        _coldRelease();
        for (uint256 i; i < 24; ++i) {
            address implementation = release.implementations[i];
            if (implementation != address(0)) {
                address helper = vm.computeCreateAddress(implementation, 1);
                if (helper.code.length != 0) vm.cool(helper);
                if (i == 5) ReceiverDeploy.cool(implementation);
                vm.cool(implementation);
            }
            if (parts[i] != address(0)) vm.cool(parts[i]);
        }
        vm.cool(extension);
        vm.cool(release.randomness);
        if (address(box) != address(0)) {
            address p = box.q();
            if (p != address(0)) vm.cool(p);
            vm.cool(address(box));
        }
        vm.cool(ALICE);
        vm.cool(BOB);
        vm.cool(CREATOR);
        vm.cool(address(pm));
    }

    function _measure(string memory label, address target, address caller, bytes memory data, uint256 limit)
        internal
        returns (bytes memory result, uint256 used)
    {
        return _measureValue(label, target, caller, data, 0, limit);
    }

    function _measureValue(
        string memory label,
        address target,
        address caller,
        bytes memory data,
        uint256 value,
        uint256 limit
    ) internal returns (bytes memory result, uint256 used) {
        require(limit <= TX_LIMIT, "transaction ceiling");
        // Calldata/intrinsic are paid before the top-level frame. Reserve them in the supplied limit too.
        uint256 executionLimit = limit - GasBudget.intrinsic(data);
        _cold();
        vm.cool(target);
        vm.prank(caller);
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = target.call{gas: executionLimit, value: value}(data);
        uint256 delta = beforeGas - gasleft();
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
        used = GasBudget.transaction(delta, data);
        emit log_named_uint(label, used);
        assertLt(used, limit, label);
        return (ret, used);
    }

    function _hiddenItems(uint8 keep, uint8 sell) internal view returns (BoxSpec memory s) {
        s = _hiddenSpec();
        s.n = 10;
        s.firstId = 1;
        (uint256[] memory positions, bytes32[] memory leaves) = _tree();
        s.revealRoot = SparseBoxTree.root(4, positions, leaves);
        s.buyers.a = Branch(1, 8, "", abi.encode(keep));
        s.sellers.a = Branch(1, 8, "", abi.encode(sell));
    }

    function _tree() internal pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10);
        leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0);
        }
    }

    function _proof(uint256 id) internal pure returns (ItemReveal memory r) {
        (uint256[] memory positions, bytes32[] memory leaves) = _tree();
        r.imageHash = bytes32(id);
        r.proof = SparseBoxTree.proof(4, id - 1, positions, leaves);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }
}
