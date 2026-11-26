// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SquareHoleToken} from "../../src/SquareHoleToken.sol";

/// @notice Test-only subclass exposing DN404's internal mint paths so their checkpoints can be proven.
/// SquareHoleToken itself has no external mint.
contract SquareHoleTokenHarness is SquareHoleToken {
    constructor(LaunchTerms memory terms) SquareHoleToken(terms) {}

    function exposedMint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function exposedMintNext(address to, uint256 amount) external {
        _mintNext(to, amount);
    }

    function exposedBurn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Records every checkpoint call T makes, with T's balances at call time (proves "pre-change").
contract RecordingLedger {
    struct Call {
        address from;
        uint256 fromBalance;
        address to;
        uint256 toBalance;
        uint256 amount;
        uint256 tokenTotalSupplyAtCall;
    }

    address public immutable token;
    address public immutable feeCollector;
    address internal immutable _mirror;
    Call[] internal _calls;

    constructor(address token_, address feeCollector_) {
        token = token_;
        feeCollector = feeCollector_;
        _mirror =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), token_, bytes1(0x01))))));
    }

    function mirror() external view virtual returns (address) {
        return _mirror;
    }

    /// @dev T requires its initial holder to be excluded; this recorder treats every account as excluded.
    function isExcluded(address) external pure returns (bool) {
        return true;
    }

    function beforeBalanceChange(address from, uint256 fromBalance, address to, uint256 toBalance, uint256 amount)
        external
    {
        require(msg.sender == token, "not token");
        uint256 supply = token.code.length == 0 ? 0 : SquareHoleToken(payable(token)).totalSupply();
        _calls.push(Call(from, fromBalance, to, toBalance, amount, supply));
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }
}

/// @notice A ledger whose mirror prediction is wrong: T must refuse to launch against it.
contract WrongMirrorLedger is RecordingLedger {
    constructor(address token_, address feeCollector_) RecordingLedger(token_, feeCollector_) {}

    function mirror() external pure override returns (address) {
        return address(0xdead);
    }
}

/// @notice Minimal collector stub that satisfies T's wiring check and can burn its own inventory.
contract StubCollector {
    address public immutable token;
    address public immutable ledger;

    constructor(address token_, address ledger_) {
        token = token_;
        ledger = ledger_;
    }

    function burn(uint256 amount) external {
        SquareHoleToken(payable(token)).burnFeeInventory(amount);
    }
}
