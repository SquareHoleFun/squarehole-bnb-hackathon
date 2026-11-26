// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Catalog CID expectations; scripts/ipfs/public-examples.test.mjs pins these to catalog.json.
// Inline test data keeps Forge's filesystem permissions unchanged.
library BentCansCatalog {
    function cid(uint256 id) internal pure returns (string memory) {
        return id % 2 == 1
            ? "bafkreib7jmc63qhwl4nfoi4vc3aw6gpbljdvtytpppjklhk6q2k6emgktu"
            : "bafkreibecmifhom6tctpkkjxywcpxajt6dawjhwfz65cix4i6tpuqls5yi";
    }
}
