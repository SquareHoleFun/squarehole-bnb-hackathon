// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC6909} from "v4-core/src/ERC6909.sol";
import {IERC6909Claims} from "v4-core/src/interfaces/external/IERC6909Claims.sol";

/// @dev TEST ONLY: unrestricted mint; proves claim movement, not PoolManager backing.
contract M3Claims is ERC6909 {
    function mint(address to, uint256 id, uint256 amount) external { _mint(to, id, amount); }
}

/// @dev TEST ONLY proposed receipt fixture, NOT a frozen receiver ABI. Amounts are already net P.
contract FundingMock {
    struct Receipt { uint8 side; uint256 netP; }
    mapping(uint256 => Receipt) public receipts;
    uint256 public count;
    uint256 public funded;
    address public immutable controller = msg.sender;
    IERC6909Claims public immutable claims;
    address public immutable ledger;
    uint256 public immutable currency;
    constructor(IERC6909Claims c, address p, address l) {
        require(l != address(0), "ledger"); claims = c; currency = uint160(p); ledger = l;
    }
    /// @notice Fixture controller only: transfer net P claims, then commit one receipt; never call ledger code.
    /// @dev Driver supplies amounts AFTER reserve/tip/carry and handles graduation/failure routing separately.
    /// Side 0 is buyers, 1 sellers; this fixture assigns no wire id to the unfrozen inside policy.
    function publish(uint256 seq, uint8 side, uint256 netP) external {
        require(msg.sender == controller, "controller");
        require(seq == count + 1 && side < 2, "record");
        require(claims.transfer(ledger, currency, netP), "claims");
        receipts[seq] = Receipt(side, netP); count = seq; funded += netP;
    }
}
