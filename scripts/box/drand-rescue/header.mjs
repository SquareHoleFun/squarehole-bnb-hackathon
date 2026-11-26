import { viem } from './deps.mjs';
import { Failure, hex, same } from './chain.mjs';

const fields = [
  'parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom',
  'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce',
  'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash',
];
const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas',
  'blobGasUsed', 'excessBlobGas']);
const known = new Set([...fields, 'hash', 'size', 'totalDifficulty', 'transactions', 'uncles', 'withdrawals']);
const bytes = value => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/i.test(value);
function encode(block) {
  if (Object.keys(block).some(name => !known.has(name))) throw new Error();
  let ended = false;
  const values = [];
  for (const [i, name] of fields.entries()) {
    const value = block[name];
    if (value == null) {
      if (i < 15) throw new Error();
      ended = true;
      continue;
    }
    if (ended) throw new Error();
    if (integers.has(name)) {
      if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value)) throw new Error();
      const n = BigInt(value);
      values.push(n === 0n ? '0x' : viem.toHex(n));
    } else {
      if (!bytes(value)) throw new Error();
      values.push(value);
    }
  }
  return viem.toRlp(values);
}
/** A raw header or a known field layout must prove the requested block's hash. Provider text stays private. */
export async function checkedHeader(conn, number) {
  try {
    const block = await conn.rpc('eth_getBlockByNumber', [hex(number), false]);
    if (!block || BigInt(block.number) !== number || !viem.isHash(block.hash)) throw new Error();
    let raw;
    try { raw = await conn.rpc('debug_getRawHeader', [hex(number)]); }
    catch { raw = undefined; }
    const header = raw === undefined ? encode(block) : raw;
    if (!bytes(header) || !same(viem.keccak256(header), block.hash)) throw new Error();
    return { header, path: raw === undefined ? 'fields' : 'raw' };
  } catch { throw new Failure('backup header refused'); }
}
export async function blockHeader(conn, number) {
  return (await checkedHeader(conn, number)).header;
}
