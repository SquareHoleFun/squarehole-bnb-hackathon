// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PileModel} from "../../m3-00/PileModel.sol";
import {HostileToken} from "../HostileToken.sol";

/// @dev TEST ONLY: shared ERC-20 fixture; inherited model is M3-00's custody spike, not a real vault.
abstract contract PileKit is Test {
    HostileToken internal asset;
    HostileToken internal token;
    PileModel internal pile;
    /// @dev Test contract is the recorded seeder. No M2 seed/native convention is assumed.
    function makePile(uint8 decimals_, uint256 seed, uint256 supply) internal {
        require(decimals_ == 6 || decimals_ == 8 || decimals_ == 18, "decimals");
        asset = new HostileToken("Pile seed", "SEED", decimals_);
        token = new HostileToken("Own coin", "T", 18);
        pile = new PileModel(asset, token, seed);
        asset.mint(address(this), seed); token.mint(address(this), supply);
        asset.approve(address(pile), seed); token.approve(address(pile), supply);
        assertEq(asset.decimals(), decimals_);
    }
    /// @dev Explicit per-holder expectations plus remaining pile and pre-next-burn supply.
    function expectCustody(
        uint256 remaining, uint256 supply, address a, uint256 aPaid, address b, uint256 bPaid
    ) internal view {
        assertTrue(a != b, "distinct holders");
        assertEq(asset.balanceOf(address(pile)), remaining, "pile asset");
        assertEq(token.totalSupply(), supply, "T supply");
        assertEq(asset.balanceOf(a), aPaid, "first holder");
        assertEq(asset.balanceOf(b), bPaid, "second holder");
    }
}
