// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC1820_REGISTRY} from "./M1_20cProbes.sol";

// TEST ONLY (M1-20-c red tests). Tokens the kit's `HostileToken` does not cover: a rebasing token, ERC-1820
// registrations, ERC-677, a token without name, symbol or decimals, and `initialHolder()` answers that must read as no
// box. Fees, blocklists, allowlists and odd decimals stay the kit's `HostileToken`.

/// @notice The ERC-1820 registry's two calls the tests use (EIP-1820).
interface IKitErc1820 {
    function setInterfaceImplementer(address account, bytes32 interfaceHash, address implementer) external;
    function getInterfaceImplementer(address account, bytes32 interfaceHash) external view returns (address);
}

/// @notice The ERC-1820 registry as EIP-1820 keeps it, for the calls above; a test etches it at `ERC1820_REGISTRY`.
contract KitErc1820Registry is IKitErc1820 {
    error NotAccount(address caller);

    mapping(address => mapping(bytes32 => address)) private _implementer;

    function setInterfaceImplementer(address account, bytes32 interfaceHash, address implementer) external {
        if (msg.sender != account) revert NotAccount(msg.sender);
        _implementer[account][interfaceHash] = implementer;
    }

    function getInterfaceImplementer(address account, bytes32 interfaceHash) external view returns (address) {
        return _implementer[account][interfaceHash];
    }
}

/// @notice An exact ERC-20 with a free `mint`; the base of the tokens below.
contract KitPlainToken {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    string private _name;
    string private _symbol;
    uint8 private immutable _decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        (_name, _symbol, _decimals) = (name_, symbol_, decimals_);
    }

    function name() external view virtual returns (string memory) {
        return _name;
    }

    function symbol() external view virtual returns (string memory) {
        return _symbol;
    }

    function decimals() external view virtual returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
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
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Name and symbol revert: the checks must not read them (listing by address, BC-155).
contract KitNamelessToken is KitPlainToken {
    constructor() KitPlainToken("", "", 18) {}

    function name() external pure override returns (string memory) {
        revert("no name");
    }

    function symbol() external pure override returns (string memory) {
        revert("no symbol");
    }
}

/// @notice `decimals()` reverts, as a token without it does.
contract KitNoDecimalsToken is KitPlainToken {
    constructor() KitPlainToken("No Decimals", "NODEC", 18) {}

    function decimals() external pure override returns (uint8) {
        revert("no decimals");
    }
}

/// @notice An exact token that registers itself at ERC-1820 for `interfaceHash` in its constructor, as an ERC-777
/// token does for `ERC777Token` (EIP-777).
contract KitRegisteredToken is KitPlainToken {
    constructor(bytes32 interfaceHash) KitPlainToken("Registered", "REG", 18) {
        IKitErc1820(ERC1820_REGISTRY).setInterfaceImplementer(address(this), interfaceHash, address(this));
    }
}

/// @notice LINK's ERC-677 `transferAndCall` beside exact ordinary transfers (BC-155: ERC-677 alone is no ground).
contract KitErc677Token is KitPlainToken {
    constructor() KitPlainToken("ChainLink Token", "LINK", 18) {}

    function transferAndCall(address to, uint256 amount, bytes calldata data) external returns (bool) {
        _move(msg.sender, to, amount);
        if (to.code.length != 0) {
            (bool ok,) =
                to.call(abi.encodeWithSignature("onTokenTransfer(address,uint256,bytes)", msg.sender, amount, data));
            require(ok, "onTokenTransfer");
        }
        return true;
    }
}

/// @notice A rebasing token as stETH keeps one: balances are shares times an index, so a transfer of `amount` moves the
/// shares it is worth, rounded down, and the receiver gets 1 raw unit less for any amount that is not a multiple of
/// `INDEX_X18` [I: gcd(1e18, 1e18 + 1) = 1].
contract KitRebasingToken {
    event Transfer(address indexed from, address indexed to, uint256 amount);

    uint256 public constant INDEX_X18 = 1e18 + 1;
    uint8 public constant decimals = 18;
    string public constant name = "Rebasing Ether";
    string public constant symbol = "rETH";
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function balanceOf(address account) external view returns (uint256) {
        return sharesOf[account] * INDEX_X18 / 1e18;
    }

    function totalSupply() external view returns (uint256) {
        return totalShares * INDEX_X18 / 1e18;
    }

    function mint(address to, uint256 amount) external {
        uint256 shares = amount * 1e18 / INDEX_X18;
        totalShares += shares;
        sharesOf[to] += shares;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 shares = amount * 1e18 / INDEX_X18;
        sharesOf[from] -= shares;
        sharesOf[to] += shares;
        emit Transfer(from, to, amount);
    }
}

/// @notice How a token answers `initialHolder()`.
enum HolderAnswer {
    /// One clean word: the claimed holder.
    CLEAN,
    /// It reverts.
    REVERTS,
    /// One word with bits above the address set.
    DIRTY,
    /// Two words: the claimed holder, then 0.
    LONG,
    /// It spins until its gas is gone.
    GAS_BOMB
}

/// @notice An exact token claiming `holder` as its `initialHolder()` in the way `answer` says. With `CLEAN` and a real
/// coordinator it is a counterfeit (BC-231): the coordinator's `token()` is another token.
contract KitHolderToken is KitPlainToken {
    address public immutable claimed;
    HolderAnswer public immutable answer;
    uint256 private _spin;

    constructor(address holder, HolderAnswer answer_) KitPlainToken("Counterfeit", "FAKE", 18) {
        (claimed, answer) = (holder, answer_);
    }

    function initialHolder() external view returns (address holder) {
        holder = claimed;
        HolderAnswer a = answer;
        if (a == HolderAnswer.REVERTS) revert("no holder");
        uint256 word = uint256(uint160(holder));
        if (a == HolderAnswer.DIRTY) {
            word |= uint256(1) << 160;
            assembly ("memory-safe") {
                mstore(0, word)
                return(0, 32)
            }
        }
        if (a == HolderAnswer.LONG) {
            assembly ("memory-safe") {
                mstore(0, word)
                mstore(32, 0)
                return(0, 64)
            }
        }
        if (a == HolderAnswer.GAS_BOMB) {
            uint256 s = _spin;
            assembly ("memory-safe") {
                for {} 1 {} { s := add(s, 1) }
            }
        }
    }
}
