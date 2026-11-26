// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeCollector} from "../FeeCollector.sol";
import {RewardLedger} from "../RewardLedger.sol";
import {SquareHoleFungibleToken} from "../SquareHoleFungibleToken.sol";
import {SquareHoleToken} from "../SquareHoleToken.sol";
import {CreateAddress} from "../libraries/CreateAddress.sol";

/// @notice Shared part of the per-launch deployers. The launcher's own code cannot hold the creation code of every
/// per-launch contract (EIP-170), so each deployer holds one or two and creates them with plain CREATE, callable only
/// by the immutable launcher. The launcher predicts the addresses from `nextNonce` (this contract's CREATE nonce)
/// before deploying, and every deployer checks that the created address equals the prediction.
/// @dev No other function exists: no arbitrary creation code, no calls, no funds.
abstract contract LaunchDeployerBase {
    error NotLauncher();
    error ZeroAddress();
    error UnexpectedAddress(address expected, address created);

    address public immutable launcher;
    /// @notice This contract's CREATE nonce (contracts start at 1, EIP-161); the next deployment lands at
    /// `predict(0)`.
    uint256 public nextNonce = 1;

    constructor(address launcher_) {
        if (launcher_ == address(0)) revert ZeroAddress();
        launcher = launcher_;
    }

    modifier onlyLauncher() {
        if (msg.sender != launcher) revert NotLauncher();
        _;
    }

    /// @notice Address of the deployment `offset` positions after the next one.
    function predict(uint256 offset) public view returns (address) {
        return CreateAddress.compute(address(this), nextNonce + offset);
    }

    function _check(address created) internal {
        address expected = predict(0);
        if (created != expected) revert UnexpectedAddress(expected, created);
        ++nextNonce;
    }
}

/// @notice Deploys a launch's RewardLedger and FeeCollector.
contract CoreDeployer is LaunchDeployerBase {
    constructor(address launcher_) LaunchDeployerBase(launcher_) {}

    function deployLedger(RewardLedger.Config calldata config) external onlyLauncher returns (address ledger) {
        ledger = address(new RewardLedger(config));
        _check(ledger);
    }

    function deployCollector(
        address token,
        address quote,
        address ledger,
        address treasury,
        address feeSource,
        address poolManager
    ) external onlyLauncher returns (address collector) {
        collector = address(new FeeCollector(token, quote, ledger, treasury, feeSource, poolManager));
        _check(collector);
    }
}

/// @notice Deploys the DN404 collection template (T + its mirror as T's first CREATE).
contract CollectionTokenDeployer is LaunchDeployerBase {
    constructor(address launcher_) LaunchDeployerBase(launcher_) {}

    function deploy(SquareHoleToken.LaunchTerms calldata terms) external onlyLauncher returns (address token) {
        token = address(new SquareHoleToken(terms));
        _check(token);
    }
}

/// @notice Deploys the plain ERC-20 template.
contract FungibleTokenDeployer is LaunchDeployerBase {
    constructor(address launcher_) LaunchDeployerBase(launcher_) {}

    function deploy(SquareHoleFungibleToken.LaunchTerms calldata terms) external onlyLauncher returns (address token) {
        token = address(new SquareHoleFungibleToken(terms));
        _check(token);
    }
}
