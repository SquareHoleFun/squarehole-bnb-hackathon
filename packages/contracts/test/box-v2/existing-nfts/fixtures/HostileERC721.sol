// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface FixtureReceiver {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data) external returns (bytes4);
}

/// @notice Local adversarial collection for E-02 and subsequent custody tests. Setters model issuer powers.
/// @dev Probe selectors use fallback so tests can produce ABI-invalid replies without Solidity decoding them.
contract HostileERC721 {
    enum ReplyMode {
        Default,
        Return,
        Revert,
        BurnGas,
        WriteState,
        Callback
    }
    enum TransferMode {
        Normal,
        Revert,
        BurnGas,
        NoOp,
        MissingReceipt,
        DuplicateReceipt,
        WrongOperator,
        WrongFrom,
        WrongId,
        CallbackWithoutTransfer,
        Reenter,
        HugeReturn,
        HugeRevert
    }

    struct Reply {
        ReplyMode mode;
        uint256 word;
        uint256 size;
    }

    mapping(bytes32 => Reply) private replies;
    mapping(uint256 => address) private owners;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => bool) public locks;
    mapping(uint256 => TransferMode) public transferModes;
    bool public supports5192;
    bool public paused;
    uint256 public mutations;
    address public callbackTarget;
    bytes public callbackData;
    uint256 public metadataRevision;
    bool public metadataReverts;
    uint256 public metadataSize = 32;

    function setReply(bytes calldata data, ReplyMode mode, uint256 word, uint256 size) external {
        replies[keccak256(data)] = Reply(mode, word, size);
    }

    function setSupports5192(bool value) external {
        supports5192 = value;
    }

    function setLocked(uint256 id, bool value) external {
        locks[id] = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setTransferMode(uint256 id, TransferMode mode) external {
        transferModes[id] = mode;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function setMetadata(uint256 revision, bool reverts_, uint256 size) external {
        metadataRevision = revision;
        metadataReverts = reverts_;
        metadataSize = size;
    }

    function mint(address to, uint256 id) external {
        require(to != address(0) && owners[id] == address(0), "mint");
        owners[id] = to;
    }

    function seize(uint256 id, address to) external {
        require(owners[id] != address(0), "missing");
        owners[id] = to;
    }

    function burn(uint256 id) external {
        require(owners[id] != address(0), "missing");
        delete owners[id];
    }

    function actualOwner(uint256 id) external view returns (address) {
        return owners[id];
    }

    function approve(address to, uint256 id) external {
        address owner = owners[id];
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "approve");
        getApproved[id] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) external {
        _transfer(from, to, id, false, "");
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        _transfer(from, to, id, true, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external {
        _transfer(from, to, id, true, data);
    }

    /// @notice Send an unsolicited/spoofed receipt independently of any ownership movement.
    function spoofReceipt(address to, address operator, address from, uint256 id) external {
        _receipt(to, operator, from, id, "");
    }

    function _transfer(address from, address to, uint256 id, bool safe, bytes memory data) private {
        require(!paused && !locks[id], "restricted");
        require(to != address(0) && from == owners[id], "owner");
        require(msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender], "approval");
        TransferMode mode = transferModes[id];
        if (mode == TransferMode.Revert) revert("transfer");
        if (mode == TransferMode.BurnGas) _burnGas();
        if (mode == TransferMode.HugeRevert) _raw(0, 65_536, true);
        if (mode == TransferMode.NoOp) return;
        if (mode != TransferMode.CallbackWithoutTransfer) {
            owners[id] = to;
            delete getApproved[id];
        }
        if (mode == TransferMode.Reenter) {
            (bool ok,) = callbackTarget.call(callbackData);
            require(ok, "reentry");
        }
        if (safe && to.code.length != 0 && mode != TransferMode.MissingReceipt) {
            _receipt(
                to,
                mode == TransferMode.WrongOperator ? address(0) : msg.sender,
                mode == TransferMode.WrongFrom ? address(0) : from,
                mode == TransferMode.WrongId ? id ^ 1 : id,
                data
            );
            if (mode == TransferMode.DuplicateReceipt) _receipt(to, msg.sender, from, id, data);
        }
        if (mode == TransferMode.HugeReturn) _raw(0, 65_536, false);
    }

    function _receipt(address to, address operator, address from, uint256 id, bytes memory data) private {
        require(FixtureReceiver(to).onERC721Received(operator, from, id, data) == 0x150b7a02, "receipt");
    }

    fallback() external {
        Reply memory reply = replies[keccak256(msg.data)];
        if (reply.mode == ReplyMode.Return) _raw(reply.word, reply.size, false);
        if (reply.mode == ReplyMode.Revert) _raw(reply.word, reply.size, true);
        if (reply.mode == ReplyMode.BurnGas) _burnGas();
        if (reply.mode == ReplyMode.WriteState) {
            ++mutations;
            _raw(reply.word, reply.size, false);
        }
        if (reply.mode == ReplyMode.Callback) {
            (bool ok,) = callbackTarget.call{gas: 16_000}(callbackData);
            // An ordinary CALL would let the callback write. Under STATICCALL it must fail.
            require(!ok, "mutation escaped");
            _raw(reply.word, reply.size, false);
        }
        if (msg.sig == 0x01ffc9a7) {
            bytes4 interfaceId = abi.decode(msg.data[4:], (bytes4));
            bool supported =
                interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || (interfaceId == 0xb45a3c0e && supports5192);
            _raw(supported ? 1 : 0, 32, false);
        }
        if (msg.sig == bytes4(keccak256("locked(uint256)"))) {
            _raw(locks[abi.decode(msg.data[4:], (uint256))] ? 1 : 0, 32, false);
        }
        if (msg.sig == 0x6352211e) {
            address owner = owners[abi.decode(msg.data[4:], (uint256))];
            require(owner != address(0), "missing");
            _raw(uint160(owner), 32, false);
        }
        if (msg.sig == 0xc87b56dd || msg.sig == 0x06fdde03 || msg.sig == 0x95d89b41) {
            require(!metadataReverts, "metadata");
            // Intentionally hostile, raw metadata; no custody/financial path may rely on its ABI.
            _raw(metadataRevision, metadataSize, false);
        }
        revert("absent");
    }

    function _raw(uint256 word, uint256 size, bool fail) private pure {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, word)
            if fail { revert(ptr, size) }
            return(ptr, size)
        }
    }

    function _burnGas() private pure {
        assembly { for {} 1 {} {} }
    }
}

/// @notice Code changes behind a stable address, modelling an issuer-controlled proxy upgrade.
contract UpgradeableFixture {
    address public implementation;

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function upgradeTo(address next) external {
        implementation = next;
    }

    fallback() external {
        address target = implementation;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// @notice Requires a full, bounded stipend at *each* selector, including the optional validator query.
contract GasWindowERC721 {
    uint256 private immutable minimum;
    uint256 private immutable maximum;

    constructor(uint256 min_, uint256 max_) {
        minimum = min_;
        maximum = max_;
    }

    fallback() external {
        uint256 atEntry = gasleft();
        // INVALID exhausts the stipend. An optional validator failure can be missed, so on a bad window
        // return a nonempty word instead: that must trigger validator refusal too.
        if (atEntry < minimum || atEntry > maximum) {
            if (msg.sig == bytes4(keccak256("getTransferValidator()"))) {
                assembly {
                    mstore(0, 1)
                    return(0, 32)
                }
            }
            assembly { invalid() }
        }
        if (msg.sig == bytes4(keccak256("getTransferValidator()"))) {
            assembly { return(0, 0) }
        }
        if (msg.sig == bytes4(keccak256("locked(uint256)"))) {
            assembly {
                mstore(0, 0)
                return(0, 32)
            }
        }
        if (msg.sig == 0x6352211e) {
            assembly {
                mstore(0, 0xbeef)
                return(0, 32)
            }
        }
        bytes4 interfaceId = abi.decode(msg.data[4:], (bytes4));
        uint256 word = interfaceId == 0xffffffff ? 0 : 1;
        assembly {
            mstore(0, word)
            return(0, 32)
        }
    }
}
