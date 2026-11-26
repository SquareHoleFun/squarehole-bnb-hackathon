// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ICoreV2Safe {
    function masterCopy() external view returns (address);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function VERSION() external view returns (string memory);
    function getModulesPaginated(address start, uint256 count) external view returns (address[] memory, address);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/// @notice Deploy-time Safe attestation. Anyone may read; only the three pinned addresses are admitted.
library CoreV2SafeChecks {
    struct SafePin {
        address account;
        address[] owners;
        uint256 threshold;
        string version;
        bytes32 codeHash;
        address singleton;
        bytes32 singletonCodeHash;
        address guard;
        address handler;
    }
    error WrongSafe(address expected, address actual);
    error UnsafeSafe(address safe);
    bytes32 private constant GUARD_SLOT = keccak256("guard_manager.guard.address");
    bytes32 private constant HANDLER_SLOT = keccak256("fallback_manager.handler.address");

    /// @notice Internal deployment caller checks identity, exact owner set, threshold, version and disabled modules.
    /// The reviewed proxy runtime is checked before trusting any delegated view. Its pin belongs to the
    /// same chain/singleton/version review; observing a hash from the proposed account is not a pin.
    /// Guard and fallback-handler addresses must match the reviewed setup; nonzero entries need code.
    function read(
        address account,
        address pinned,
        address[] memory expected,
        uint256 threshold,
        string memory version,
        address singleton,
        bytes32 singletonCodeHash,
        address expectedGuard,
        address expectedHandler,
        bytes32 proxyCodeHash
    ) internal view returns (SafePin memory s) {
        if (account == address(0) || account != pinned) revert WrongSafe(pinned, account);
        if (proxyCodeHash == bytes32(0) || account.code.length == 0 || account.codehash != proxyCodeHash) {
            revert UnsafeSafe(account);
        }
        ICoreV2Safe safe = ICoreV2Safe(account);
        address observedSingleton = safe.masterCopy();
        if (observedSingleton != singleton || singleton.code.length == 0 || singleton.codehash != singletonCodeHash) {
            revert UnsafeSafe(account);
        }
        s = SafePin(
            account,
            safe.getOwners(),
            safe.getThreshold(),
            safe.VERSION(),
            account.codehash,
            observedSingleton,
            singleton.codehash,
            abi.decode(safe.getStorageAt(uint256(GUARD_SLOT), 1), (address)),
            abi.decode(safe.getStorageAt(uint256(HANDLER_SLOT), 1), (address))
        );
        if (
            s.threshold != threshold || s.owners.length != expected.length
                || keccak256(bytes(s.version)) != keccak256(bytes(version))
                || (keccak256(bytes(version)) != keccak256("1.4.1") && keccak256(bytes(version)) != keccak256("1.5.0"))
                || keccak256(bytes(ICoreV2Safe(singleton).VERSION())) != keccak256(bytes(version))
        ) revert UnsafeSafe(account);
        for (uint256 i; i < expected.length; ++i) {
            if (expected[i] == address(0) || expected[i] == address(1)) revert UnsafeSafe(account);
            uint256 matches;
            for (uint256 j; j < expected.length; ++j) {
                if (s.owners[j] == expected[i]) ++matches;
            }
            if (matches != 1) revert UnsafeSafe(account);
            for (uint256 j; j < i; ++j) {
                if (expected[i] == expected[j]) revert UnsafeSafe(account);
            }
        }
        (address[] memory modules, address next) = safe.getModulesPaginated(address(1), 1);
        if (
            modules.length != 0 || next != address(1) || s.guard != expectedGuard || s.handler != expectedHandler
                || (s.guard != address(0) && s.guard.code.length == 0)
                || (s.handler != address(0) && s.handler.code.length == 0)
        ) {
            revert UnsafeSafe(account);
        }
    }
}
