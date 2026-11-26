// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal ERC-20 base for local anvil fixtures, including the guarded local Sepolia twin.
/// Public networks must use real coins; these permissionless faucets have no value or issuer guarantees.
abstract contract LocalERC20 {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}

/// @notice WETH9 behaviour (deposit / withdraw 1:1 against ETH, 18 decimals) for the local anvil chain only.
contract LocalWETH9 is LocalERC20 {
    string public constant name = "Wrapped Ether (local mock)";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer");
    }
}

/// @notice Local test funds only. Anyone may mint to any recipient; never a public-network asset.
abstract contract LocalPriceCoin is LocalERC20 {
    /// @notice Any local test actor may mint valueless fixture funds. No backing or production supply is represented.
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice A 6-decimal USDC stand-in for local anvil only.
contract LocalUSDC is LocalPriceCoin {
    string public constant name = "USD Coin (local mock)";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

}

/// @notice An 18-decimal LINK stand-in for local anvil only.
contract LocalLINK is LocalPriceCoin {
    string public constant name = "Chainlink (local mock)";
    string public constant symbol = "LINK";
    uint8 public constant decimals = 18;
}

/// @notice An 8-decimal WBTC stand-in for local anvil only.
contract LocalWBTC is LocalPriceCoin {
    string public constant name = "Wrapped Bitcoin (local mock)";
    string public constant symbol = "WBTC";
    uint8 public constant decimals = 8;
}

/// @notice Local-only issuer double shared by both stocks. No real Ondo identity or backing is represented.
contract LocalStockControls {
    /// @notice Anyone may read the fixed local issuer; only this address may change restrictions.
    address public immutable issuer;
    /// @notice Anyone may read the shared pause flag; it blocks transfers of both local stocks.
    bool public paused;
    /// @notice Anyone may read address freezes; they apply to both local stocks, including their pools.
    mapping(address => bool) public frozen;
    event Paused(bool paused);
    event Frozen(address indexed account, bool frozen);

    constructor(address issuer_) {
        require(issuer_ != address(0), "local issuer required");
        issuer = issuer_;
    }

    /// @notice Only the fixed local issuer may pause/resume both stocks. Does not move or confiscate funds.
    function setPaused(bool value) external {
        require(msg.sender == issuer, "local issuer only");
        paused = value;
        emit Paused(value);
    }

    /// @notice Only the fixed local issuer may freeze/unfreeze an address across both stocks.
    function setFrozen(address account, bool value) external {
        require(msg.sender == issuer, "local issuer only");
        frozen[account] = value;
        emit Frozen(account, value);
    }
}

/// @notice Local stock faucet with a shared issuer's pause/freeze powers; no securities or real reserves.
abstract contract LocalStockCoin is LocalPriceCoin {
    /// @notice Anyone may read the immutable local restriction controller.
    LocalStockControls public immutable controls;
    uint8 public constant decimals = 18;

    constructor(LocalStockControls controls_) { controls = controls_; }

    /// @dev Required reads; any refusal rolls back the entire transfer, including allowance consumption.
    function _move(address from, address to, uint256 amount) internal override {
        require(!controls.paused(), "local coin paused");
        require(!controls.frozen(from) && !controls.frozen(to) && !controls.frozen(msg.sender), "local address frozen");
        super._move(from, to, amount);
    }
}

/// @notice An 18-decimal NVDAon stand-in for local anvil only; permissionless test minting has no backing.
contract LocalNVDAon is LocalStockCoin {
    string public constant name = "NVIDIA Ondo (local mock)";
    string public constant symbol = "NVDAon";
    constructor(LocalStockControls controls_) LocalStockCoin(controls_) {}
}

/// @notice An 18-decimal AAPLon stand-in for local anvil only; permissionless test minting has no backing.
contract LocalAAPLon is LocalStockCoin {
    string public constant name = "Apple Ondo (local mock)";
    string public constant symbol = "AAPLon";
    constructor(LocalStockControls controls_) LocalStockCoin(controls_) {}
}

/// @notice Local-only stand-in for gold-backed PAXG, with its 18 decimals. This faucet holds no gold.
contract LocalPAXG is LocalPriceCoin {
    string public constant name = "Paxos Gold (local mock)";
    string public constant symbol = "PAXG";
    uint8 public constant decimals = 18;
}

/// @notice Local-only stand-in for gold-backed XAUt, with its 6 decimals. This faucet holds no gold.
contract LocalXAUt is LocalPriceCoin {
    string public constant name = "Tether Gold (local mock)";
    string public constant symbol = "XAUt";
    uint8 public constant decimals = 6;
}
