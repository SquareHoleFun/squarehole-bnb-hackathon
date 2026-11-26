// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M363Base} from "../../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";

/// No production runtime substitutions. All core parts, checks and the PM are the release artifacts.
abstract contract FinalAccessFixture is M363Base {
    address internal constant OUTSIDER = address(0xFA11);

    // Plain, holders token, open art, hidden items, mixed Items/Holders, zero-seed pile.
    // Shop and nonzero-seed gate checks use their separately named production fixtures.
    function _family(uint256 family) internal view returns (BoxSpec memory s) {
        if (family < 2) {
            s = _menu(1, 2);
            if (family == 1) s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        } else if (family == 2) {
            s = _items(1, 2);
        } else if (family < 5) {
            s = _hiddenSpec();
            s.buyers.a = Branch(1, 8, "", abi.encode(uint8(1)));
            s.sellers.a = family == 3 ? Branch(1, 8, "", abi.encode(uint8(2))) : Branch(1, 6, "", abi.encode(uint8(1)));
        } else {
            s = _pile(address(0), 0);
        }
    }

    function _refuse(address target, address caller, bytes memory data) internal returns (bytes memory reason) {
        vm.prank(caller);
        (bool ok, bytes memory ret) = target.call(data);
        assertFalse(ok, "restricted or removed member must refuse");
        return ret;
    }
}
