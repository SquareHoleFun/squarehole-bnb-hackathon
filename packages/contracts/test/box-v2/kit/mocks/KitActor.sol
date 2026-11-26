// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The kit's driver: the test contract that deployed the kit (`MockListingRegistry.kitDriver`).
interface IKitDriven {
    function kitDriver() external view returns (address);
}

/// @title KitActor
/// @notice TEST ONLY (M1-03). The test's hand inside a mock that pays: a sequence of calls made as this contract in one
/// frame, as a real depositor or converter makes them (`openDeposit`, an ERC-6909 transfer as owner, `deposit`; or
/// `openIntake`, a transfer, `converterProceeds`). Foundry clears transient storage between a test's top-level calls,
/// so a snapshot taken in one pranked call is gone in the next. A revert bubbles with its data. Not a rule of
/// ADR-0017: no frozen interface has it, and no real part has such an entry point. So only the kit's driver (the test
/// contract that deployed the kit) may call it: a hostile contract in a test can never make a mock part call as
/// itself and pass a proof the real part would refuse. A hostile-caller test calls the mock directly, never `act`.
abstract contract KitActor {
    /// `act` from anyone but the kit's driver (the test contract that deployed the kit).
    error NotKitDriver(address caller);

    function act(address[] calldata targets, bytes[] calldata data) external returns (bytes[] memory results) {
        if (msg.sender != _kitDriver()) revert NotKitDriver(msg.sender);
        results = new bytes[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call(data[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            results[i] = ret;
        }
    }

    /// The only caller `act` takes.
    function _kitDriver() internal view virtual returns (address);
}
