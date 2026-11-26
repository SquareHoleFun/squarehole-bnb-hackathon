// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice TEST ONLY: hostile ETH recipient / stream notification callee, etched only where explicitly stated.
contract AuditU4LaneHostile {
    bool private immutable exhaust;

    constructor(bool exhaust_) {
        exhaust = exhaust_;
    }

    fallback() external payable {
        if (exhaust) {
            assembly { for {} 1 {} {} }
        }
        revert("callee refuses");
    }
}

/// @notice TEST ONLY: records actual forwarded gas and probes the receiver's hot and cold halves mid-collect.
contract AuditU4LaneStreamProbe {
    address private immutable receiver;
    event Observed(uint256 gasAtEntry, uint256 amount, bytes hotFailure, bytes coldFailure, bytes noteFailure);

    constructor(address receiver_) {
        receiver = receiver_;
    }

    function onStreamFunds(uint256 amount) external {
        uint256 entered = gasleft();
        (bool h, bytes memory hot) = receiver.call(abi.encodeWithSignature("fundDepth()"));
        (bool c, bytes memory cold) = receiver.call(abi.encodeWithSignature("acceptCreatorPayee()"));
        (bool n, bytes memory note) = receiver.call(abi.encodeWithSignature("noteModuleFees(uint256,uint256)", 1, 1));
        require(!h && !c && !n, "reentry accepted");
        emit Observed(entered, amount, hot, cold, note);
    }
}

/// @notice TEST ONLY: models marketplaces that use Solidity transfer/send, including zero-value transfers.
contract AuditU4LaneStipendPayer {
    function pay(address payable to, uint256 amount) external {
        to.transfer(amount);
    }
}
