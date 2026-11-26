// Rehearsal check: counts the signer's transactions to one contract with one function, from a block on, and compares
// with the number of intended actions.
// usage: node scripts/count-calls.js <rpc> <records folder> <signer> <from block> <core|preset-pile|tax-pile> "<function signature>" <expected>
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

async function main() {
  const [rpc, dir, signer, from, target, signature, expected] = process.argv.slice(2);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const to = { core: () => read("fork-deployment.json").addresses.core, "preset-pile": () => read("launch-preset.json").pile, "tax-pile": () => read("launch-tax.json").pile }[target]();
  const selector = ethers.id(signature).slice(0, 10);
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const last = await provider.getBlockNumber();
  let n = 0;
  for (let b = Number(from); b <= last; b++) {
    const block = await provider.getBlock(b, true);
    for (const tx of block.prefetchedTransactions) {
      if (tx.from === ethers.getAddress(signer) && tx.to === to && tx.data.startsWith(selector)) n += 1;
    }
  }
  console.log(`== on chain, blocks ${from}..${last}: ${n} x ${signature} to ${target} (intended ${expected})`);
  if (n !== Number(expected)) {
    console.error(`stopped: ${n} transactions, ${expected} intended`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
