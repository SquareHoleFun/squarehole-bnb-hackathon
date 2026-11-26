// Read-only: what gas price does the network actually mine? Reads eth_gasPrice and the lowest gas price paid by
// transactions in the last N blocks (default 200), and counts how many paid below 0.1 gwei and at exactly 0.05 gwei.
// usage: node scripts/gas-floor.js [rpc] [blocks]
"use strict";
const { ethers } = require("ethers");

async function main() {
  const rpc = process.argv[2] || "https://bsc-testnet-rpc.publicnode.com";
  const n = Number(process.argv[3] || "200");
  const provider = new ethers.JsonRpcProvider(rpc);
  const head = await provider.getBlockNumber();
  const suggested = BigInt(await provider.send("eth_gasPrice", []));
  let min = null;
  let txs = 0;
  let below01 = 0;
  let at005 = 0;
  for (let b = head - n + 1; b <= head; b++) {
    const block = await provider.getBlock(b, true);
    for (const tx of block.prefetchedTransactions) {
      const price = tx.gasPrice;
      if (price === 0n) continue; // system transactions of the validators
      txs += 1;
      if (min === null || price < min) min = price;
      if (price < 100_000_000n) below01 += 1;
      if (price === 50_000_000n) at005 += 1;
    }
  }
  console.log(JSON.stringify({
    rpc, blocks: `${head - n + 1}..${head}`, eth_gasPrice_gwei: ethers.formatUnits(suggested, 9),
    paidTransactions: txs, lowestPaid_gwei: min === null ? null : ethers.formatUnits(min, 9),
    paidBelow0_1gwei: below01, paidExactly0_05gwei: at005,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
