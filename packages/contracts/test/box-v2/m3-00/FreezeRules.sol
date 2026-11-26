// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BoxType, PileParams} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ItemsDestParams} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @dev Executable S1/S5 rules. Listing result and disjoint authenticated balances are supplied inputs,
/// not substitutes for release-pinned factory/registry reads in production.
contract FreezeRules {
    /// @notice Anyone checks the canonical policy; no funds move.
    function items(BoxType kind,bytes calldata data) external pure returns (uint8 policy) {
        require(kind == BoxType.NEW_COLLECTION && data.length == 32,"items");
        ItemsDestParams memory p = abi.decode(data,(ItemsDestParams)); policy = p.insidePolicy;
        require((policy >= 1 && policy <= 3) && keccak256(data) == keccak256(abi.encode(p)),"canonical");
    }
    /// @notice Anyone checks parameters against supplied listing and T identities; no funds move.
    function pile(bytes calldata data,address t,bool listed) external pure returns (address asset,uint256 seed) {
        require(data.length == 64 && listed,"pile"); PileParams memory p = abi.decode(data,(PileParams));
        require(p.asset != t && keccak256(data) == keccak256(abi.encode(p)),"asset/canonical");
        return (p.asset,p.seedAmount);
    }
    /// @notice Anyone computes tLeft from disjoint post-burn custody inputs; no funds move.
    function outstanding(BoxType kind,uint256 supply,uint256 hBase,uint256 liquid,uint256 claims,
        uint256 k,uint256 vaultBalance,uint256 closedResidue) external pure returns (uint256)
    {
        uint256 pileT = kind == BoxType.PILE ? liquid+claims : 0;
        uint256 clipped = kind == BoxType.NEW_COLLECTION ? (k < vaultBalance ? k : vaultBalance) : 0;
        return supply-hBase-pileT-clipped-closedResidue;
    }
}

/// @dev Failure arithmetic reference; input tLeft is frozen once AFTER burns by the S5 formula above.
/// Models only both-Items fee sides: all held choices plus D6's 10/15 and base 2/15 go to the pot.
/// claim()'s t input stands for exact caller-only T transfer/burn; paid counters stand for real P payout.
contract FailureModel {
    address public immutable creator = msg.sender;
    uint8 public immutable cause;
    uint256 public pot;
    uint256 public fit;
    uint256 public platform;
    uint256 public tLeft;
    uint256 public fixedCreator;
    uint256 public paid;
    bool private paused;
    constructor(uint256 principal,uint256 held,uint256 d6,uint256 outstanding,uint8 why) {
        require(why >= 1 && why <= 3,"cause"); cause = why; uint256 u = d6/15;
        pot = principal+held+12*u+d6%15; fit = 2*u; platform = u; tLeft = outstanding;
        if (outstanding == 0) fixedCreator = pot;
    }
    /// @notice Driver alone simulates a refused payout.
    function pause(bool value) external { require(msg.sender == creator,"driver"); paused = value; }
    /// @notice Driver supplies late receiver P, belonging to the holder pot.
    function receiverLate(uint256 amount) external { require(msg.sender == creator,"driver"); pot += amount; }
    /// @notice Driver supplies direct pot P; it remains even after the last claim.
    function directLate(uint256 amount) external {
        require(msg.sender == creator,"driver"); pot += amount;
    }
    /// @notice Holder supplies own counted T; only creator claims the fixed zero-buyer amount. No expiry.
    function claim(uint256 t) external returns (uint256 p) {
        if (tLeft == 0) {
            require(t == 0 && msg.sender == creator && fixedCreator != 0,"creator"); p = fixedCreator; fixedCreator = 0;
        } else {
            require(t != 0 && t <= tLeft,"amount"); p = t == tLeft ? pot : FullMath.mulDiv(pot,t,tLeft); tLeft -= t;
        }
        pot -= p; paid += p; require(!paused,"payout");
    }
}
