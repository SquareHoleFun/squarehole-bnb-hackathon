// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HostileToken} from "../kit/HostileToken.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @dev Native/ERC-20 seed custody reference; completion counter abstracts the authenticated starter gate.
contract PileModel {
    HostileToken public immutable asset;
    HostileToken public immutable t;
    address public immutable seeder = msg.sender;
    uint256 public immutable seed;
    uint256 public notifications;
    uint256 public excludedT;
    bool public loaded;
    bool public graduated;
    bool public failed;
    bool public returned;
    bool private locked;
    constructor(HostileToken a, HostileToken token, uint256 amount) {
        require(a != token); asset = a; t = token; seed = amount; loaded = amount == 0;
    }
    modifier lock() { require(!locked, "reentry"); locked = true; _; locked = false; }
    /// @notice Anyone triggers exact ERC-20 pull from recorded seeder; native value is seeder-only.
    function load() external payable lock {
        require(!loaded && !failed && !graduated, "phase");
        if (address(asset) == address(0)) require(msg.sender == seeder && msg.value == seed, "native seed");
        else {
            require(msg.value == 0, "value");
            uint256 before_ = asset.balanceOf(address(this)); uint256 fromBefore = asset.balanceOf(seeder);
            require(asset.transferFrom(seeder, address(this), seed));
            require(asset.balanceOf(address(this)) == before_ + seed && asset.balanceOf(seeder) + seed == fromBefore, "exact");
        }
        loaded = true; ++notifications; // Model for role 19's once-only starterSetLoaded notice.
    }
    /// @notice Coordinator stand-in (seeder/driver) alone enables redemption after loading, once.
    function graduate() external {
        require(msg.sender == seeder && loaded && !failed && !graduated, "phase"); graduated = true;
    }
    /// @notice Caller spends its approved T; pay the chosen nonzero non-vault recipient atomically.
    function redeem(uint256 amount, uint256 minOut, address to) external lock returns (uint256 out) {
        require(graduated && !failed && amount != 0 && to != address(0) && to != address(this), "redeem");
        uint256 balance = _balance();
        out = FullMath.mulDiv(balance, amount, t.totalSupply()); require(out >= minOut, "minimum");
        uint256 oldT = t.balanceOf(address(this));
        require(t.transferFrom(msg.sender, address(this), amount));
        require(t.balanceOf(address(this)) == oldT + amount, "T receipt"); t.burn(amount);
        _pay(to, out);
        require(_balance() + out == balance, "exact");
    }
    /// @notice Coordinator stand-in alone marks failure without calling the seed token.
    function fail() external {
        require(msg.sender == seeder && !graduated && !failed, "phase");
        failed = true; excludedT = t.balanceOf(address(this)); // Trusted own T only; never calls the seed asset.
    }
    /// @notice Anyone returns only received seed to its recorded seeder, once; refusal preserves retry.
    function returnSeed() external lock {
        require(failed && !returned, "phase"); returned = true;
        _pay(seeder, loaded ? seed : 0);
    }
    function _balance() private view returns (uint256) {
        return address(asset) == address(0) ? address(this).balance : asset.balanceOf(address(this));
    }
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeVault = _balance();
        if (address(asset) == address(0)) { (bool ok,) = to.call{value:amount}(""); require(ok, "native payout"); }
        else {
            uint256 beforeTo = asset.balanceOf(to); require(asset.transfer(to, amount));
            require(asset.balanceOf(to) == beforeTo + amount, "exact");
        }
        require(_balance() + amount == beforeVault, "exact");
    }
}
