// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Offline behavioral stand-ins, NOT Safe production implementations or deployment artifacts.
contract MockToken {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockSafe {
    address public immutable module;
    constructor(address module_) { module = module_; }
    function isModuleEnabled(address candidate) external view returns (bool) { return candidate == module; }
    function transferFromModule(address token, address to, uint256 amount) external {
        require(msg.sender == module, "module");
        require(MockToken(token).transfer(to, amount), "transfer");
    }
}

contract MockAllowance {
    address public immutable owner = msg.sender;
    struct Allowance { uint96 amount; uint96 spent; uint16 resetTimeMin; uint32 lastResetMin; uint16 nonce; }
    mapping(bytes32 => Allowance) private allowances;
    function slot(address safe, address delegate, address token) private pure returns (bytes32) {
        return keccak256(abi.encode(safe, delegate, token));
    }
    function setAllowance(address safe, address delegate, address token, uint96 amount) external {
        require(msg.sender == owner, "owner");
        allowances[slot(safe, delegate, token)] = Allowance(amount, 0, 10080, uint32(block.timestamp / 60), 0);
    }
    function getTokenAllowance(address safe, address delegate, address token) external view returns (uint256[5] memory) {
        Allowance memory a = allowances[slot(safe, delegate, token)];
        return [uint256(a.amount), uint256(a.spent), uint256(a.resetTimeMin), uint256(a.lastResetMin), uint256(a.nonce)];
    }
    function executeAllowanceTransfer(address safe, address token, address to, uint96 amount,
        address paymentToken, uint96 payment, address delegate, bytes calldata signature) external {
        require(msg.sender == delegate && signature.length == 0, "delegate");
        require(paymentToken == address(0) && payment == 0, "no fee");
        Allowance storage a = allowances[slot(safe, delegate, token)];
        require(a.resetTimeMin != 0, "missing allowance");
        uint256 minute = block.timestamp / 60;
        if (minute >= uint256(a.lastResetMin) + a.resetTimeMin) {
            a.lastResetMin += uint32(((minute - a.lastResetMin) / a.resetTimeMin) * a.resetTimeMin);
            a.spent = 0;
        }
        require(uint256(a.spent) + amount <= a.amount, "weekly cap");
        a.spent += amount;
        a.nonce++;
        MockSafe(safe).transferFromModule(token, to, amount);
    }
}
