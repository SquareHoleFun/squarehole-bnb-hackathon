// Writes abi/*.json for a launch page: our three contracts (from Hardhat's artifacts) and the OpenFour calls a page
// makes (Core, Tools, Vault, ERC-20; the human-readable fragments the kit's own scripts use).
// usage: npx hardhat compile && node scripts/export-abi.js
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { ABI } = require("../lib/openfour");
const { artifact } = require("../lib/pile-preset");

const dir = path.resolve(__dirname, "..", "abi");
fs.mkdirSync(dir, { recursive: true });
const write = (name, abi) => {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  console.log(`abi/${name}.json`);
};
for (const name of ["PileTaxVault", "PileTradeModule", "PilePresetValidator", "FeeRules", "RulesTaxVault", "RuleSplitter"]) write(name, artifact(name).abi);
for (const [name, frags] of Object.entries({ OpenFourCore: ABI.core, OpenFourTools: ABI.tools, OpenFourVault: ABI.vault, ERC20: ABI.erc20 })) {
  write(name, JSON.parse(new ethers.Interface(frags).formatJson()));
}
