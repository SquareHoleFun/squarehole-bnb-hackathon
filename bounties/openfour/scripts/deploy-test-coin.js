// Rehearsal only (local fork): deploys a 6-decimal test coin so the rehearsal can show that a quote coin without 18
// decimals is refused before anything is signed. Prints its address on the last line.
// usage: node -r ./scripts/signer-preload.js scripts/deploy-test-coin.js --expect-signer 0x...
"use strict";

const { ethers } = require("ethers");
const { artifact } = require("../lib/pile-preset");
const { LOCAL, preflight, stop } = require("../lib/run");

async function main() {
  if (!LOCAL) stop("a test coin is for the local fork only", 2);
  const ctx = await preflight();
  const a = artifact("MockQuote6");
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, ctx.wallet).deploy({ gasPrice: ctx.gasPrice, type: 0 });
  await c.waitForDeployment();
  console.log(await c.getAddress());
}

main().catch((e) => stop(e.shortMessage || e.message || String(e)));
