// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Test-only stand-in with mainnet USDT's quirks (docs/research/sepolia-infrastructure.md § 3.1): 6
/// decimals as a uint256, `transfer`/`transferFrom`/`approve` return nothing, `approve` from one non-zero allowance
/// to another reverts, a max allowance is never reduced, a blacklist blocks both directions, and a pause blocks
/// transfers. Independent MIT code; no Tether source or branding.
contract MockUSDT {
    string public constant name = "Square Hole Mock USDT (local test)";
    string public constant symbol = "mUSDT";
    uint256 public constant decimals = 6;
    uint256 public totalSupply;
    bool public paused;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlackListed;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlackListed(address account, bool listed) external {
        isBlackListed[account] = listed;
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "USDT: approve from non-zero");
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "USDT: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(!paused, "USDT: paused");
        require(!isBlackListed[from] && !isBlackListed[to], "USDT: blacklisted");
        require(balanceOf[from] >= amount, "USDT: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
