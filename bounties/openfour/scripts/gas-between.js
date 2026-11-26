// usage: node scripts/gas-between.js <rpc> <fromBlock> <toBlock>
// Counts the transactions in blocks (from, to] and sums their gasUsed; prints the cost at the testnet's 0.05 gwei.
"use strict";
const { ethers } = require("ethers");

async function main() {
  const [rpc, from, to] = process.argv.slice(2);
  const provider = new ethers.JsonRpcProvider(rpc);
  let n = 0;
  let gas = 0n;
  for (let b = BigInt(from) + 1n; b <= BigInt(to); b++) {
    const block = await provider.getBlock(b);
    for (const h of block.transactions) {
      const r = await provider.getTransactionReceipt(h);
      n += 1;
      gas += r.gasUsed;
    }
  }
  const wei = gas * 50_000_000n; // 0.05 gwei, the price the kit sends with on chain 97
  console.log(`${n} transactions, ${gas} gas, ${ethers.formatEther(wei)} BNB at 0.05 gwei`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
