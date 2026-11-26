// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UniqueArtTestBase} from "./UniqueArtFixture.sol";
import {RentFreeRevealFixture} from "./rent-free.sol";
import {BagHoldersRevealFixture} from "./bag-holders.sol";
import {LinkMarinesV2RevealFixture} from "./link-marines-v2.sol";
import {ExitLiquidityRevealFixture} from "./exit-liquidity.sol";

contract RentFreeUniqueArtTest is UniqueArtTestBase {
    function _data() internal override returns (bytes memory) { return _fixtureCode("rent-free.sol:RentFreeRevealFixture"); }
}
contract BagHoldersUniqueArtTest is UniqueArtTestBase {
    function _data() internal override returns (bytes memory) { return _fixtureCode("bag-holders.sol:BagHoldersRevealFixture"); }
}
contract LinkMarinesUniqueArtTest is UniqueArtTestBase {
    function _data() internal override returns (bytes memory) { return _fixtureCode("link-marines-v2.sol:LinkMarinesV2RevealFixture"); }
}
contract ExitLiquidityUniqueArtTest is UniqueArtTestBase {
    function _data() internal override returns (bytes memory) { return _fixtureCode("exit-liquidity.sol:ExitLiquidityRevealFixture"); }
}
