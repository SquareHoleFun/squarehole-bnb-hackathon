import { readFileSync } from 'node:fs';
import { fromRlp, keccak256, toRlp, type Hex } from 'viem';

// RPC names after requestsHash follow EIP-7928 and EIP-7843; provider spelling needs live confirmation.
export const headerFields = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot',
  'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce',
  'baseFeePerGas', 'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash',
  'blockAccessListHash', 'slotNumber'] as const;
export const integerFields = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas',
  'blobGasUsed', 'excessBlobGas', 'slotNumber']);
const text = readFileSync(new URL('../../../contracts/test/box/backup/HeaderVectors.sol', import.meta.url), 'utf8');
export function vector(name: 'MAINNET' | 'SEPOLIA') {
  const raw = `0x${text.match(new RegExp(`${name} = hex"([a-f0-9]+)"`))?.[1]}` as Hex;
  const hash = text.match(new RegExp(`${name}_HASH = (0x[a-f0-9]+)`))?.[1] as Hex;
  const fields = fromRlp(raw, 'hex') as Hex[];
  const block: Record<string, unknown> = { hash, transactions: [], uncles: [], size: '0x1', totalDifficulty: '0x0' };
  fields.forEach((value, i) => {
    const field = headerFields[i];
    if (!field) throw new Error('unnamed vector field');
    block[field] = integerFields.has(field) ? `0x${BigInt(value === '0x' ? '0x0' : value).toString(16)}` : value;
  });
  return { raw, hash, block, fields };
}
export function fakeHeader(number: bigint, timestamp: bigint, baseFee = 1n) {
  const { fields } = vector('MAINNET');
  const bytes = (n: bigint): Hex => n === 0n ? '0x' : `0x${n.toString(16).padStart(n.toString(16).length + n.toString(16).length % 2, '0')}`;
  fields[8] = bytes(number); fields[11] = bytes(timestamp); fields[15] = bytes(baseFee);
  const raw = toRlp(fields);
  const block = { ...vector('MAINNET').block, number: `0x${number.toString(16)}`, timestamp: `0x${timestamp.toString(16)}`,
    baseFeePerGas: `0x${baseFee.toString(16)}`, hash: keccak256(raw) };
  return { raw, block };
}
