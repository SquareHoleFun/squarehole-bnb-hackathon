// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Plain 18-decimal ERC-20 used as Q in tests (mintable by anyone; test-only).
contract MockERC20 {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    /// @dev Test-only: e.g. 6 for a USDC stand-in. Square Hole contracts never read decimals.
    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external virtual returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        return true;
    }

    function _spend(address from, uint256 amount) internal {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice USDT-style token whose transfer functions return nothing.
contract NoReturnERC20 is MockERC20("NoReturn", "NR") {
    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        assembly {
            return(0, 0)
        }
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        assembly {
            return(0, 0)
        }
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        assembly {
            return(0, 0)
        }
    }
}

/// @notice Token that moves nothing and returns false from transfers.
contract FalseReturnERC20 is MockERC20("FalseReturn", "FR") {
    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @notice Token that burns 1% of every transfer (unsupported as Q; must be rejected, not mis-accounted).
contract FeeOnTransferERC20 is MockERC20("FeeOnTransfer", "FOT") {
    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// @notice Token that can refuse transfers to one address (models issuer denylists, e.g. a blocked treasury).
contract DenylistERC20 is MockERC20("Denylist", "DNY") {
    address public denied;

    function setDenied(address account) external {
        denied = account;
    }

    function _move(address from, address to, uint256 amount) internal override {
        require(to != denied && from != denied, "denied");
        super._move(from, to, amount);
    }
}

/// @notice Token that calls back into `target` with `data` on every transfer (hostile quote contract).
contract ReentrantERC20 is MockERC20("Reentrant", "RE") {
    address public target;
    bytes public data;
    bool public lastCallSucceeded;
    bytes public lastRevertData;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function _move(address from, address to, uint256 amount) internal override {
        super._move(from, to, amount);
        address t = target;
        if (t != address(0)) {
            target = address(0);
            (bool ok, bytes memory ret) = t.call(data);
            lastCallSucceeded = ok;
            lastRevertData = ret;
        }
    }
}
