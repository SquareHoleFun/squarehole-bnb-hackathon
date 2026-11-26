// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Release-wide, permanent fee-action admissions. The lister role follows ListingRegistry.
/// No custody, approvals, execution, upgrades or mutable module slots live in the directory.
contract FeeModuleDirectoryV21 {
    struct Record { address module; bytes32 codeHash; uint64 readyAt; bool withdrawn; }
    Record[] private _records;
    uint256 private _initialWithdrawn;
    uint256 private immutable _initialCount;
    uint256 private immutable _initialReadyAt;
    mapping(address => bool) private _registered;
    /// @notice Anyone reads the current admission authority; no money moves.
    address public lister;
    /// @notice Anyone reads the proposed authority; acceptance is required.
    address public pendingLister;
    /// @notice Anyone reads the first renunciation step.
    bool public renouncePending;
    /// @notice Anyone reads the permanent renunciation flag.
    bool public renounced;
    /// @notice Anyone reads the one-day notice for every registration, including release modules.
    uint256 public constant DELAY = 1 days;
    error NotLister();
    error InvalidModule();
    error UnavailableModule(uint32 id);
    event Registered(uint32 indexed id, address indexed module, bytes32 codeHash, uint64 readyAt);
    event Withdrawn(uint32 indexed id);
    event ListerProposed(address indexed previous, address indexed proposed);
    event ListerChanged(address indexed previous, address indexed current);
    event RenounceProposed(address indexed lister);
    event Renounced(address indexed previous);

    /// @notice Deployer fixes the initial lister (the release's authorised Safe); no funds accepted.
    constructor(address lister_, address[] memory initial) {
        if (lister_ == address(0)) revert NotLister();
        if (initial.length > 4) revert InvalidModule();
        _initialCount = initial.length;
        _initialReadyAt = block.timestamp + DELAY;
        lister = lister_;
        for (uint256 i; i < initial.length; ++i) _register(initial[i]);
    }
    modifier onlyLister() {
        if (renounced || msg.sender != lister) revert NotLister();
        _;
    }
    /// @notice Lister only. Adds one permanent codehash-pinned row; never replaces or reactivates a row.
    /// Admission scans instruction boundaries, not PUSH data. Action code cannot write receiver state,
    /// delegate, deploy or destroy code. CALL is allowed for asset/route operations in the bounded action.
    function register(address module) external onlyLister returns (uint32 id) { return _register(module); }
    function _register(address module) private returns (uint32 id) {
        if (_registered[module] || _records.length >= type(uint32).max) revert InvalidModule();
        _checkCode(module.code);
        id = uint32(_records.length);
        uint64 readyAt = uint64(block.timestamp + DELAY);
        _registered[module] = true;
        _records.push(Record(module, module.codehash, readyAt, false));
        emit Registered(id, module, module.codehash, readyAt);
    }
    /// @notice Lister only. Permanently removes selection by new boxes; existing box snapshots are untouched.
    function withdraw(uint32 id) external onlyLister {
        if (id >= _records.length || _records[id].withdrawn) revert UnavailableModule(id);
        _records[id].withdrawn = true;
        if (id < _initialCount) _initialWithdrawn |= uint256(1) << id;
        emit Withdrawn(id);
    }
    /// @notice Anyone checks initial-row availability. The receiver constructor authenticates its permanent pair;
    /// factory proofs separately check that immutable address's live hash. No execution uses this read.
    function initialSelectable(uint32 id) external view returns (bool) {
        return id < _initialCount && block.timestamp >= _initialReadyAt && (_initialWithdrawn & (uint256(1) << id)) == 0;
    }
    /// @notice Anyone, including the factory, resolves an active mature row and verifies the live codehash.
    function resolve(uint32 id) external view returns (address module, bytes32 codeHash) {
        if (id >= _records.length) revert UnavailableModule(id);
        Record memory r = _records[id];
        if (r.withdrawn || block.timestamp < r.readyAt || r.module.codehash != r.codeHash) {
            revert UnavailableModule(id);
        }
        return (r.module, r.codeHash);
    }
    /// @notice Anyone reads the permanent snapshot, including withdrawn/immature rows; no admission implied.
    function record(uint32 id) external view returns (address, bytes32, uint64, bool) {
        if (id >= _records.length) revert UnavailableModule(id);
        Record memory r = _records[id];
        return (r.module, r.codeHash, r.readyAt, r.withdrawn);
    }
    /// @notice Anyone reads the add-only record count; no funds move.
    function count() external view returns (uint256) { return _records.length; }
    /// @notice Lister only; nominate a successor, cancelling pending renunciation.
    function proposeLister(address next) external onlyLister {
        pendingLister = next; renouncePending = false;
        emit ListerProposed(lister, next);
    }
    /// @notice Proposed nonzero successor only; accepts the role, never changes any existing box.
    function acceptLister() external {
        if (renounced || msg.sender != pendingLister || pendingLister == address(0)) revert NotLister();
        address previous = lister;
        lister = msg.sender; pendingLister = address(0); renouncePending = false;
        emit ListerChanged(previous, msg.sender);
    }
    /// @notice Lister only; first step of permanent role renunciation.
    function proposeRenounce() external onlyLister {
        pendingLister = address(0); renouncePending = true;
        emit RenounceProposed(lister);
    }
    /// @notice Lister only after proposing; permanently stops further registration and withdrawal.
    function renounce() external onlyLister {
        if (!renouncePending) revert NotLister();
        address previous = lister;
        lister = address(0); pendingLister = address(0); renouncePending = false; renounced = true;
        emit Renounced(previous);
    }
    function _checkCode(bytes memory code) private pure {
        uint256 end = code.length;
        if (end == 0 || end > 22_118 || code[0] == 0xef) revert InvalidModule();
        // The pinned compiler's fixed metadata contains no JUMPDEST and follows INVALID.
        // Only this exact suffix is exempted; arbitrary CBOR or user-supplied length fields are not trusted.
        bytes memory metadata = hex"fea164736f6c634300081a000a";
        if (end >= metadata.length) {
            bool same = true;
            for (uint256 i; i < metadata.length; ++i) {
                if (code[end - metadata.length + i] != metadata[i]) same = false;
            }
            if (same) end -= metadata.length;
        }
        for (uint256 pc; pc < end; ++pc) {
            uint8 op = uint8(code[pc]);
            if (op == 0x55 || op == 0x5c || op == 0x5d || op == 0xb3 || op == 0xf0
                || op == 0xf2 || op == 0xf4 || op == 0xf5 || op == 0xff) revert InvalidModule();
            if (op >= 0x60 && op <= 0x7f) {
                pc += op - 0x5f;
                if (pc >= end) revert InvalidModule();
            }
        }
    }
}
