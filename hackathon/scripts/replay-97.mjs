#!/usr/bin/env node
/**
 * Replays SH-260's plain-chain rehearsal (an anvil state dump of chain 97, blocks and transactions included) onto a
 * FRESH local anvil, block by block with the original timestamps, so the local chain keeps every historical state
 * (a dump loaded with --load-state has only the last one, and the indexer reads at older block hashes: listings and box
 * creations). Each transaction is sent again from its original sender by anvil's impersonation, with its original
 * nonce order, calldata, value and gas; contract addresses come out the same. Code the rehearsal planted without a
 * transaction is planted again first. Loopback only.
 *
 *   node hackathon/scripts/replay-97.mjs <dump.json> http://127.0.0.1:8572
 *
 * Prints one JSON line: blocks and transactions replayed, failures, and the replayed chain's log count from block 0.
 */
import { readFileSync } from 'node:fs';

const [dumpPath, url] = process.argv.slice(2);
if (!dumpPath || !url || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
  process.stderr.write('usage: replay-97.mjs <dump.json> http://127.0.0.1:<port> (a local chain only)\n');
  process.exit(2);
}
let id = 0;
async function rpc(method, params = []) {
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
if (BigInt(await rpc('eth_chainId')) !== 97n) throw new Error('the local chain is not chain 97');
if (BigInt(await rpc('eth_blockNumber')) !== 0n) throw new Error('the local chain must be fresh (block 0)');
const blocks = [...dump.blocks].sort((a, b) => Number(BigInt(a.header.number) - BigInt(b.header.number)));
const senders = new Set();
const receipts = new Map(dump.transactions.map((t) => [t.info.transaction_hash.toLowerCase(), t]));
const senderOf = (entry) => (entry.impersonated_sender ?? receipts.get(String(entry.transaction.hash).toLowerCase())?.info.from ?? '').toLowerCase();
for (const block of blocks) for (const entry of block.transactions) senders.add(senderOf(entry));
senders.delete('');
// The original senders' balances at genesis are not in the dump; each gets enough for every send it makes.
for (const sender of senders) {
  await rpc('anvil_setBalance', [sender, '0x3635c9adc5dea00000']); // 1,000 of the native coin, local only
  await rpc('anvil_impersonateAccount', [sender]);
}
// Code the rehearsal planted without a transaction (its WBNB stand-in at the testnet's WBNB address): every account of
// the dump with code that no transaction created and the fresh chain does not hold already.
const created = new Set();
for (const t of dump.transactions) {
  if (t.info.contract_address) created.add(t.info.contract_address.toLowerCase());
  for (const node of t.info.traces ?? []) if (['CREATE', 'CREATE2'].includes(node.trace?.kind)) created.add(String(node.trace.address).toLowerCase());
}
const planted = [];
for (const [address, account] of Object.entries(dump.accounts)) {
  if (!account.code || account.code === '0x' || created.has(address.toLowerCase())) continue;
  if ((await rpc('eth_getCode', [address, 'latest'])) !== '0x') continue;
  await rpc('anvil_setCode', [address, account.code]);
  planted.push(address);
}
let sent = 0, failed = 0;
const failures = [];
for (const block of blocks) {
  const number = BigInt(block.header.number);
  if (number === 0n) continue;
  const hashes = [];
  for (const [i, entry] of block.transactions.entries()) {
    const tx = entry.transaction;
    const from = senderOf(entry);
    if (!from) throw new Error(`block ${number}: transaction ${i} has no sender`);
    hashes.push(await rpc('eth_sendTransaction', [{ from, ...(tx.to ? { to: tx.to } : {}), value: tx.value ?? '0x0',
      data: tx.input ?? tx.data ?? '0x', gas: tx.gas ?? tx.gasLimit, ...(tx.gasPrice ? { gasPrice: tx.gasPrice } : {
        maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }) }]));
  }
  await rpc('evm_mine', [Number(BigInt(block.header.timestamp))]);
  for (const hash of hashes) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    sent += 1;
    if (!receipt || receipt.status !== '0x1') { failed += 1; failures.push(String(number)); }
  }
}
const logs = await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }]);
process.stdout.write(`${JSON.stringify({ planted, blocks: blocks.length - 1, transactions: sent, failed, failedBlocks: failures.slice(0, 20),
  head: BigInt(await rpc('eth_blockNumber')).toString(), logs: logs.length })}\n`);
