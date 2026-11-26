// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ERC721} from "solmate/src/tokens/ERC721.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice Sepolia test asset, never a production listing. The fixed founder alone can mint; no transfer tax.
contract SepoliaTestToken is ERC20 {
    address public immutable owner;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_, decimals_)
    {
        require(block.chainid != 1 && owner_ != address(0), "testnet owner required");
        require(decimals_ == 6 || decimals_ == 8 || decimals_ == 18, "test decimals");
        owner = owner_;
    }

    /// @notice Only the recorded test owner supplies rehearsal balances. This power is disclosed on the coin sheet.
    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "owner only");
        _mint(to, amount);
    }
}

/// @notice Synthetic Sepolia shop stock. Only its fixed owner mints; no seizure, pause or upgrade.
contract SepoliaTestCollection is ERC721 {
    address public immutable owner;

    constructor(address owner_) ERC721("Rehearsal shop stock", "STOCK") {
        require(block.chainid != 1 && owner_ != address(0), "test owner/chain");
        owner = owner_;
    }

    function mint(address to, uint256 id) external {
        require(msg.sender == owner, "owner");
        _mint(to, id);
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }
}
