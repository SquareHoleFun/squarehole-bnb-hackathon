// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title MockTetherUSD (testnets only)
/// @notice "Test Tether USD (Square Hole mock)", symbol USDT-TEST: a clearly labelled TEST token for Sepolia and local
/// chains that reproduces mainnet USDT's integration quirks (docs/research/sepolia-infrastructure.md § 3.1, verified
/// against TetherToken's source and read-only mainnet calls), so Square Hole is exercised against them before any
/// production quote decision. It has no value, is not Tether's and carries no Tether branding. Independent MIT code.
/// Behaviour copied from mainnet USDT:
/// - `transfer`, `transferFrom` and `approve` return NO value (callers must accept empty return data);
/// - `approve` from one non-zero allowance to another non-zero allowance reverts (set 0 first);
/// - `decimals` is a uint256 equal to 6;
/// - a `type(uint256).max` allowance is never reduced by `transferFrom`;
/// - issuer powers held by `owner`: pause (blocks `transfer`/`transferFrom`, not `approve`), blacklist (blocks a
///   blacklisted SENDER: `transfer` from it and `transferFrom` of its funds; receiving is not blocked, as on mainnet),
///   destroying a blacklisted account's funds, and a transfer fee (`setParams`, capped below 20 bps and below 50
///   whole tokens, 0 by default; the fee goes to `owner`);
/// - short calldata reverts (mainnet's `onlyPayloadSize`; here Solidity 0.8's ABI decoder rejects it before any code
///   runs, with empty revert data).
/// Not copied: deprecation forwarding (`upgradedAddress`) and owner issuance. Supply comes only from the public,
/// capped faucet, so no account can mint more than FAUCET_MAX_PER_CALL per FAUCET_COOLDOWN and the faucet as a whole
/// never mints more than FAUCET_TOTAL_CAP.
/// @dev Owner powers exist to SIMULATE issuer actions in failure tests (ADR-0011 §9); scripts never use them.
contract MockTetherUSD {
    string public constant name = "Test Tether USD (Square Hole mock)";
    string public constant symbol = "USDT-TEST";
    uint256 public constant decimals = 6;
    uint256 public constant MAX_UINT = type(uint256).max;

    /// @notice Largest faucet mint per call: 10,000 USDT-TEST.
    uint256 public constant FAUCET_MAX_PER_CALL = 10_000e6;
    /// @notice Minimum time between two faucet mints to the same address.
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    /// @notice Lifetime cap of everything the faucet can ever mint: 1,000,000,000 USDT-TEST.
    uint256 public constant FAUCET_TOTAL_CAP = 1_000_000_000e6;
    /// @notice Mainnet caps of the transfer-fee parameters (strict upper bounds): < 20 bps, < 50 whole tokens.
    uint256 public constant MAX_BASIS_POINTS_EXCLUSIVE = 20;
    uint256 public constant MAX_FEE_TOKENS_EXCLUSIVE = 50;

    address public owner;
    bool public paused;
    uint256 public totalSupply;
    /// @notice Total minted by the faucet so far (≤ FAUCET_TOTAL_CAP).
    uint256 public faucetMinted;
    /// @notice Transfer fee in basis points (0 by default) and its cap in raw units.
    uint256 public basisPointsRate;
    uint256 public maximumFee;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlackListed;
    /// @notice Timestamp of an address's last faucet mint (0: never).
    mapping(address => uint256) public lastFaucetAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Pause();
    event Unpause();
    event AddedBlackList(address user);
    event RemovedBlackList(address user);
    event DestroyedBlackFunds(address blackListedUser, uint256 balance);
    event Params(uint256 feeBasisPoints, uint256 maxFee);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FaucetMint(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error Paused();
    error BlackListed(address account);
    error NotBlackListed(address account);
    error ApproveFromNonZero();
    error InsufficientBalance();
    error InsufficientAllowance();
    error FeeParamsTooHigh();
    error FaucetAmount(uint256 amount);
    error FaucetCooldown(uint256 availableAt);
    error FaucetExhausted();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    /// @param owner_ the account that can simulate the issuer's pause, blacklist and fee powers (the testnet deployer)
    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /*//////////////////////////////////////////////////////////////
                    ERC-20 SURFACE (NO RETURN VALUES)
    //////////////////////////////////////////////////////////////*/

    function transfer(address to, uint256 value) external whenNotPaused {
        if (isBlackListed[msg.sender]) revert BlackListed(msg.sender);
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external whenNotPaused {
        if (isBlackListed[from]) revert BlackListed(from);
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance();
        if (allowed < MAX_UINT) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
    }

    /// @dev Mainnet USDT: `require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))`. Not paused-gated.
    function approve(address spender, uint256 value) external {
        if (value != 0 && allowance[msg.sender][spender] != 0) revert ApproveFromNonZero();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    /// @notice Mainnet USDT view name for the blacklist.
    function getBlackListStatus(address account) external view returns (bool) {
        return isBlackListed[account];
    }

    /*//////////////////////////////////////////////////////////////
                          PUBLIC CAPPED FAUCET
    //////////////////////////////////////////////////////////////*/

    /// @notice Mints `amount` (1 … FAUCET_MAX_PER_CALL raw) test tokens to the caller, at most once per
    /// FAUCET_COOLDOWN per address, while the lifetime faucet cap allows. Worthless test tokens.
    function faucet(uint256 amount) external {
        if (amount == 0 || amount > FAUCET_MAX_PER_CALL) revert FaucetAmount(amount);
        if (isBlackListed[msg.sender]) revert BlackListed(msg.sender);
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        if (faucetMinted + amount > FAUCET_TOTAL_CAP) revert FaucetExhausted();
        lastFaucetAt[msg.sender] = block.timestamp;
        faucetMinted += amount;
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        emit FaucetMint(msg.sender, amount);
        emit Transfer(address(0), msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                  SIMULATED ISSUER POWERS (OWNER ONLY)
    //////////////////////////////////////////////////////////////*/

    function pause() external onlyOwner {
        paused = true;
        emit Pause();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpause();
    }

    function addBlackList(address account) external onlyOwner {
        isBlackListed[account] = true;
        emit AddedBlackList(account);
    }

    function removeBlackList(address account) external onlyOwner {
        isBlackListed[account] = false;
        emit RemovedBlackList(account);
    }

    /// @notice Mainnet USDT: the issuer can zero a blacklisted account's balance (supply shrinks).
    function destroyBlackFunds(address account) external onlyOwner {
        if (!isBlackListed[account]) revert NotBlackListed(account);
        uint256 funds = balanceOf[account];
        balanceOf[account] = 0;
        totalSupply -= funds;
        emit DestroyedBlackFunds(account, funds);
    }

    /// @notice Transfer fee: `newBasisPoints` < 20 and `newMaxFeeTokens` < 50 whole tokens (mainnet caps).
    function setParams(uint256 newBasisPoints, uint256 newMaxFeeTokens) external onlyOwner {
        if (newBasisPoints >= MAX_BASIS_POINTS_EXCLUSIVE || newMaxFeeTokens >= MAX_FEE_TOKENS_EXCLUSIVE) {
            revert FeeParamsTooHigh();
        }
        basisPointsRate = newBasisPoints;
        maximumFee = newMaxFeeTokens * 10 ** decimals;
        emit Params(basisPointsRate, maximumFee);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Mainnet USDT: the sender is debited `value`, the recipient credited `value − fee`, the fee credited to
    /// `owner`; fee = min(value × basisPointsRate / 10,000, maximumFee).
    function _move(address from, address to, uint256 value) private {
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance();
        uint256 fee = value * basisPointsRate / 10_000;
        if (fee > maximumFee) fee = maximumFee;
        uint256 sendAmount = value - fee;
        balanceOf[from] = balance - value;
        balanceOf[to] += sendAmount;
        if (fee != 0) {
            balanceOf[owner] += fee;
            emit Transfer(from, owner, fee);
        }
        emit Transfer(from, to, sendAmount);
    }
}
