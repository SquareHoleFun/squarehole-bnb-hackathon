// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What FIT asks the Misfits vault before every burn (v2 docs/03 "Rounding and boundaries", VLT-11).
/// @dev The vault answers `E + n`: the smallest FIT totalSupply that still leaves one raw FIT per Misfit inside
/// (A = S − E ≥ n). A burn that would take the supply below it is refused, so no burn can push a return quote to zero
/// or make a withdrawal free.
interface IFitSupplyFloor {
    /// @return floor The lowest totalSupply FIT may reach after a burn: tracked escrow principal E plus Misfits inside n.
    function supplyFloor() external view returns (uint256 floor);
}
