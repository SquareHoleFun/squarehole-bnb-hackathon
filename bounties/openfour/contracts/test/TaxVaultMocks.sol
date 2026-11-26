// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

// Test helpers for PileTaxVault's own unit tests. Not part of the template.

/// @dev A token with OpenFour's `vault()` getter; the whole supply goes to the deployer.
contract MockVaultToken is ERC20 {
    address public vault;

    constructor(address vault_, uint256 supply) ERC20("Mock Launch", "MLT") {
        vault = vault_;
        _mint(msg.sender, supply);
    }
}

/// @dev A quote coin that burns 1% of every transfer (fee on transfer).
contract MockFeeQuote is ERC20 {
    constructor() ERC20("Fee Quote", "FEEQ") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount / 100;
        super._transfer(from, to, amount - fee);
        if (fee != 0) _burn(from, fee);
    }
}

/// @dev A 6-decimal coin: the scripts must refuse it as a quote coin.
contract MockQuote6 is ERC20 {
    constructor() ERC20("Six Decimals", "SIX") {
        _mint(msg.sender, 1_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @dev A quote coin whose `deposit()` takes native coin and mints nothing: a clone must not count it as wrapping.
contract MockFakeWrap is ERC20 {
    constructor() ERC20("Fake Wrap", "FWRAP") {
        _mint(msg.sender, 1_000_000e18);
    }

    function deposit() external payable {}
}

/// @dev Makes EIP-1167 clones, as ForwardVault does with `Clones.clone`.
contract CloneMaker {
    event Cloned(address clone);

    function clone(address implementation) external returns (address c) {
        c = Clones.clone(implementation);
        emit Cloned(c);
    }
}
