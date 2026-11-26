// Reproduce with the evidence's forge command, then pass its --json output here.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, decodeEventLog, parseAbi, parseAbiParameters, toEventSelector } from 'viem';

const captured = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const named = parseAbi(['event log_named_bytes(string key, bytes val)']);
const signatures = {
  holder: 'HolderPaid(uint256,address,address,uint256,uint256)',
  item: 'ItemPaid(uint256,address,address,uint256,uint256)',
  creator: 'CreatorClaimed(address,address,address,uint256)',
  failure: 'Claimed(address,address,uint256,uint256)',
  no_buyer: 'Claimed(address,address,uint256,uint256)',
};
const output = {};
for (const suite of Object.values(captured)) for (const result of Object.values(suite.test_results)) {
  if (result.status !== 'Success') throw new Error('fixture contract failed');
  for (const log of result.logs) {
    let value;
    try { value = decodeEventLog({ abi: named, topics: log.topics, data: log.data }).args; } catch { continue; }
    const [logs] = decodeAbiParameters(parseAbiParameters('(bytes32[] topics,bytes data,address emitter)[]'), value.val);
    const matches = logs.filter(l => l.topics[0] === toEventSelector(signatures[value.key]));
    if (matches.length !== 1) throw new Error(`missing or repeated ${value.key}`);
    const { emitter, topics, data } = matches[0];
    output[value.key] = { address: emitter.toLowerCase(), topics, data };
  }
}
if (Object.keys(output).length !== 5) throw new Error('missing payment fixtures');
const json = `${JSON.stringify(output, null, 2)}\n`;
const target = new URL('./events.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== json) throw new Error('event fixture drift');
} else writeFileSync(target, json);
