// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @notice Unbacked test stand-ins with one issuance to the explicitly supplied founder recipient.
/// No faucet, later mint, upgrade, tax or issuer affiliation. Deployable only on Sepolia, BNB Chain testnet (97) or
/// local test chains.
abstract contract TestCoin is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address recipient, uint256 supply)
        ERC20(name_, symbol_)
    {
        require(block.chainid == 11_155_111 || block.chainid == 31337 || block.chainid == 97, "testnet only");
        require(recipient != address(0) && supply > 0, "recipient and supply");
        _decimals = decimals_;
        _mint(recipient, supply);
    }

    function decimals() public view override returns (uint8) { return _decimals; }
}

contract TestLINK is TestCoin {
    constructor(address recipient, uint256 supply) TestCoin("Test LINK", "tLINK", 18, recipient, supply) {}
}

contract TestUSDC is TestCoin {
    constructor(address recipient, uint256 supply) TestCoin("Test USDC", "tUSDC", 6, recipient, supply) {}
}

/// @notice Stock-like test denomination; no share, custody, redemption or issuer rights.
contract TestNVDA is TestCoin {
    constructor(address recipient, uint256 supply) TestCoin("Test NVDA", "tNVDA", 18, recipient, supply) {}
}

contract TestPEPE is TestCoin {
    constructor(address recipient, uint256 supply) TestCoin("Test PEPE", "tPEPE", 18, recipient, supply) {}
}

contract TestFrog is TestCoin {
    constructor(address recipient, uint256 supply) TestCoin("Test Frog", "tFROG", 18, recipient, supply) {}

    /// @notice Burns exactly the caller's raw units and total supply; no allowance or third-party burn.
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}

/// @notice Gold-like test denomination with explicit issuer-style pause/freeze failure modes, no gold backing.
/// The initial recipient alone controls pause/freeze. No confiscation, wiping, upgrade or later issuance.
contract TestGold is TestCoin {
    address public immutable owner;
    bool public paused;
    mapping(address => bool) public isFrozen;
    event PauseChanged(bool paused);
    event FreezeChanged(address indexed account, bool frozen);

    constructor(address recipient, uint256 supply) TestCoin("Test Gold", "tGOLD", 18, recipient, supply) {
        owner = recipient;
    }

    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }

    function pause() external onlyOwner { paused = true; emit PauseChanged(true); }
    function unpause() external onlyOwner { paused = false; emit PauseChanged(false); }
    function freeze(address account) external onlyOwner { isFrozen[account] = true; emit FreezeChanged(account, true); }
    function unfreeze(address account) external onlyOwner { isFrozen[account] = false; emit FreezeChanged(account, false); }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused && !isFrozen[from] && !isFrozen[to] && !isFrozen[msg.sender], "paused or frozen");
        super._update(from, to, value);
    }

    function _approve(address holder, address spender, uint256 value, bool emitEvent) internal override {
        require(!paused && !isFrozen[holder] && !isFrozen[spender], "paused or frozen");
        super._approve(holder, spender, value, emitEvent);
    }
}
