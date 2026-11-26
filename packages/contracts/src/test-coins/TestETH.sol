// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestCoin} from "./TestCoins.sol";

/// @notice Worthless Sepolia alpha coin: one initial issuance, then only a capped faucet.
/// The owner manages faucet admission and open phases only; no administrative mint, pause, freeze or seizure.
contract TestETH is TestCoin {
    uint256 public constant DRIP_AMOUNT = 1e18;
    uint256 public constant COOLDOWN = 1 days;
    uint256 public constant DAILY_CAP = 500e18;
    uint256 public constant MAX_ADMITTER_PER_DAY = 50;
    uint256 private constant MAX_BATCH_SIZE = 200;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public admitted;
    bool public open;

    /// @notice Address cooldown deadline (0 before its first drip). Also check dailyRemaining().
    mapping(address => uint256) public nextDripAt;
    uint256 private _day;
    uint256 private _dripped;

    address public admitter;
    uint256 public admitterPerDay;
    uint256 private _admitterDay;
    uint256 private _admitterCount;

    error CooldownActive(uint256 nextDripAt);
    error DailyCapReached();
    error NotAdmitted();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error TooManyAddresses();
    error NotAdmitter();
    error InvalidAdmitterLimit();
    error AdmitterDailyCapReached();

    event Drip(address indexed recipient, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdmissionChanged(address indexed account, bool admitted);
    event OpenChanged(bool open);
    event AdmitterChanged(address indexed account, uint256 perDay);

    /// @notice The base permits only Sepolia (11155111) and local (31337) deployment, to a nonzero recipient.
    /// The recipient owns admission; the faucet starts closed with nobody admitted, including the owner.
    constructor(address recipient) TestCoin("Test ETH", "tETH", 18, recipient, 1_000_000e18) {
        owner = recipient;
        emit OwnershipTransferred(address(0), recipient);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Nominate a nonzero successor. The current owner retains authority until acceptance.
    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        admitter = address(0);
        admitterPerDay = 0;
        emit AdmitterChanged(address(0), 0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    /// @notice Set a single-address admitter, capped at 50 admissions per UTC day; (0, 0) clears it.
    /// A nonzero account with zero quota is paused. Changes never reset the current day's usage.
    function setAdmitter(address account, uint256 perDay) external onlyOwner {
        if (perDay > MAX_ADMITTER_PER_DAY || (account == address(0) && perDay != 0)) {
            revert InvalidAdmitterLimit();
        }
        admitter = account;
        admitterPerDay = perDay;
        emit AdmitterChanged(account, perDay);
    }

    /// @notice Admit one wallet without minting or changing its cooldown. Existing admissions are silent no-ops
    /// and cost no quota, even at the cap. Removal followed by readmission consumes another admission.
    function admitOne(address account) external {
        if (msg.sender != admitter || msg.sender == address(0)) revert NotAdmitter();
        if (account == address(0)) revert ZeroAddress();
        if (admitted[account]) return;
        uint256 today = block.timestamp / 1 days;
        if (_admitterDay != today) {
            _admitterDay = today;
            _admitterCount = 0;
        }
        if (_admitterCount >= admitterPerDay) revert AdmitterDailyCapReached();
        ++_admitterCount;
        admitted[account] = true;
        emit AdmissionChanged(account, true);
    }

    /// @notice Admit a wave of at most 200 addresses without changing any cooldown or balance.
    function admit(address[] calldata accounts) external onlyOwner {
        if (accounts.length > MAX_BATCH_SIZE) revert TooManyAddresses();
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (!admitted[account]) {
                admitted[account] = true;
                emit AdmissionChanged(account, true);
            }
        }
    }

    /// @notice Remove faucet admission only; existing coins remain freely transferable.
    function remove(address[] calldata accounts) external onlyOwner {
        if (accounts.length > MAX_BATCH_SIZE) revert TooManyAddresses();
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            if (admitted[account]) {
                admitted[account] = false;
                emit AdmissionChanged(account, false);
            }
        }
    }

    /// @notice Open or close the public phase without changing admissions or faucet limits.
    function setOpen(bool value) external onlyOwner {
        if (open != value) {
            open = value;
            emit OpenChanged(value);
        }
    }

    /// @notice Mint one drip to the caller, subject to its rolling cooldown and the shared UTC-day cap.
    function drip() external {
        if (!open && !admitted[msg.sender]) revert NotAdmitted();
        uint256 next = nextDripAt[msg.sender];
        if (block.timestamp < next) revert CooldownActive(next);
        uint256 today = block.timestamp / 1 days;
        if (_day != today) {
            _day = today;
            _dripped = 0;
        }
        if (_dripped + DRIP_AMOUNT > DAILY_CAP) revert DailyCapReached();
        nextDripAt[msg.sender] = block.timestamp + COOLDOWN;
        _dripped += DRIP_AMOUNT;
        _mint(msg.sender, DRIP_AMOUNT);
        emit Drip(msg.sender, DRIP_AMOUNT);
    }

    /// @notice Raw units available in the current UTC day, including before that day's first drip.
    function dailyRemaining() external view returns (uint256) {
        return _day == block.timestamp / 1 days ? DAILY_CAP - _dripped : DAILY_CAP;
    }
}
