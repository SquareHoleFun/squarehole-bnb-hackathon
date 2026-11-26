// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST-ONLY stand-in for v2 FIT, now used only by `ExistingHookNativeEth.t.sol` (the first-generation hook
/// with native ETH). The T14 pool and route suites and the T13 buy-back suites run on the real `FitToken`
/// (`V2SystemKit`, `MisfitsV2Deployer`). It has the properties the T14 route proof first depended on: a plain
/// 18-decimal ERC-20, the whole supply of 1,000,000,000 FIT minted once in the constructor, no mint function, no
/// owner, no pause, no transfer fee, and direct sends to the token contract itself refused (F24 (d)). `burn` destroys
/// the caller's own balance only.
contract FitStandIn {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error SendToTokenRefused();
    error InsufficientBalance();
    error InsufficientAllowance();

    string public constant name = "FIT (T14 test stand-in)";
    string public constant symbol = "FIT";
    uint8 public constant decimals = 18;
    uint256 public constant GENESIS_SUPPLY = 1_000_000_000e18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address genesisHolder) {
        totalSupply = GENESIS_SUPPLY;
        balanceOf[genesisHolder] = GENESIS_SUPPLY;
        emit Transfer(address(0), genesisHolder, GENESIS_SUPPLY);
    }

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
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    /// @notice A true supply reduction of the caller's own balance.
    function burn(uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function _move(address from, address to, uint256 amount) private {
        if (to == address(this)) revert SendToTokenRefused();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
