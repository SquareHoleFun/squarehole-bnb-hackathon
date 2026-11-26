// From the offline Recorder.t.sol --json output; never calls an RPC.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, decodeEventLog, parseAbi, parseAbiParameters } from 'viem';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const named = parseAbi(['event log_named_bytes(string key, bytes val)']);
const fixture = {};
for (const suite of Object.values(input)) for (const test of Object.values(suite.test_results)) {
  if (test.status !== 'Success') throw new Error('recording failed');
  for (const log of test.logs) {
    let value;
    try { value = decodeEventLog({ abi: named, topics: log.topics, data: log.data }).args; } catch { continue; }
    const { key, val } = value;
    if (key.endsWith('Logs')) fixture[key] = decodeAbiParameters(parseAbiParameters('(bytes32[] topics,bytes data,address emitter)[]'), val)[0];
    else if (key === 'wiring') {
      const values = decodeAbiParameters(parseAbiParameters('address,address,address,address,address,address,address'), val);
      fixture[key] = Object.fromEntries(['router', 'receiver', 'p', 'weth', 'other', 'handler', 'settlement'].map((name, i) => [name, values[i]]));
    } else if (['unregistered', 'registered', 'afterSale', 'afterInKind'].includes(key)) {
      const values = decodeAbiParameters(parseAbiParameters('address,uint256,uint256,uint256,bool'), val);
      fixture[key] = Object.fromEntries(['coin', 'lot', 'balance', 'oldestUnsoldAt', 'registered'].map((name, i) => [name, values[i]]));
    } else {
      const values = decodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256,bool,bytes'), val);
      fixture[key] = Object.fromEntries(['pot', 'tLeft', 'coinsT', 'pendingP', 'ok', 'quote'].map((name, i) => [name, values[i]]));
    }
  }
}
if (Object.keys(fixture).length !== 18) throw new Error(`expected 18 records, got ${Object.keys(fixture).length}`);
const json = JSON.stringify(fixture, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n';
const target = new URL('./recorded.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== json) throw new Error('recorded fixture drift');
} else writeFileSync(target, json);
