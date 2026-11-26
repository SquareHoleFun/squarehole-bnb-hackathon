require("@nomicfoundation/hardhat-toolbox");

// The compile settings of the OpenFour starter (developer/startup/hardhat.config.js): solc 0.8.24, optimizer 200, viaIR.
// No account holds a key here: tests run against a local anvil fork of BSC Testnet (its accounts are unlocked or
// impersonated), and the scripts that send real transactions take their signer from scripts/signer-preload.js.
const LOCAL_FORK = process.env.LOCAL_FORK_URL || "http://127.0.0.1:8580";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    localfork: {
      url: LOCAL_FORK,
      chainId: 97,
      timeout: 600_000,
    },
  },
  mocha: {
    timeout: 900_000,
  },
};
