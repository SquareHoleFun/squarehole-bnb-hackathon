import { keccak256, toHex, toRlp, type Hex } from 'viem';

const fields = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom',
  'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas',
  'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash',
  // EIP-7928 and EIP-7843: pinned by the Sepolia vector; RPC spelling awaits provider confirmation.
  'blockAccessListHash', 'slotNumber'] as const;
const integers = new Set<string>(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas',
  'blobGasUsed', 'excessBlobGas', 'slotNumber']);
// These RPC envelope fields do not enter the header. Any other field requires an encoder review.
const known = new Set<string>([...fields, 'hash', 'transactions', 'uncles', 'size', 'totalDifficulty', 'withdrawals']);
interface HeaderRpc { request(args: { method: string; params: readonly unknown[] }): Promise<unknown>; }
export type BackupHeaderPath = 'raw' | 'fields';
const hex = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[a-f0-9]{2})*$/i.test(value);
const matches = (raw: unknown, hash: unknown): raw is Hex => hex(raw) && typeof hash === 'string'
  && /^0x[a-f0-9]{64}$/i.test(hash) && keccak256(raw).toLowerCase() === hash.toLowerCase();

/** Read an exact mined header; provider text and unrecognized fork formats become one fixed failure. */
export async function backupHeader(rpc: HeaderRpc, number: bigint, reportPath?: (path: BackupHeaderPath) => void): Promise<Hex> {
  try {
    const tag = toHex(number);
    let raw: unknown;
    try { raw = await rpc.request({ method: 'debug_getRawHeader', params: [tag] }); }
    catch { /* An unavailable debug method uses the standard block fields. */ }
    const block = await rpc.request({ method: 'eth_getBlockByNumber', params: [tag, false] }) as Record<string, unknown>;
    if (matches(raw, block.hash)) { reportPath?.('raw'); return raw; }
    if (Object.keys(block).some(name => !known.has(name))) throw new Error();
    const encoded: Hex[] = [];
    let gap = false;
    for (const field of fields) {
      const value = block[field];
      if (value === undefined || value === null) {
        if (encoded.length < 15) throw new Error();
        gap = true;
        continue;
      }
      if (gap || typeof value !== 'string') throw new Error();
      if (integers.has(field)) {
        if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error();
        const n = BigInt(value);
        const digits = n.toString(16);
        encoded.push(n === 0n ? '0x' : `0x${digits.padStart(digits.length + digits.length % 2, '0')}`);
      } else {
        if (!hex(value)) throw new Error();
        encoded.push(value);
      }
    }
    const header = toRlp(encoded);
    if (!matches(header, block.hash)) throw new Error();
    reportPath?.('fields');
    return header;
  } catch { throw new Error('backup header mismatch'); }
}
