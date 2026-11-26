import { createRequire } from 'node:module';

// Reuse the repository's locked packages; no install and no new dependency.
const require = createRequire(new URL('../../packages/burn-bot/package.json', import.meta.url));
export const { z } = require('zod');
export const { parseAbi, encodeFunctionData, decodeFunctionResult, encodeAbiParameters, decodeAbiParameters,
  encodePacked, decodeEventLog, toEventSelector, toFunctionSelector, keccak256, toHex, isAddress } = require('viem');
export const ZERO = `0x${'0'.repeat(40)}`;
export const WORD_ZERO = `0x${'0'.repeat(64)}`;
export const WEEK = 604800n;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const PROBE_AMOUNT = 10000n;
export const BURN_SELECTOR = '0x42966c68';
export const CEILING = (1n << 160n) - 1n - (((1n << 160n) - 1n) >> 16n);
export const ERC1820 = '0x1820a4b7618bde71dce8cdc73aab6c95905fad24';
export const CLASS = { STABLE: 3, STOCK: 4, OTHER: 5 };
export class Refusal extends Error {}
export function need(ok, reason) { if (!ok) throw new Refusal(reason); }
export const ceil = (n, d) => { need(n >= 0n && d > 0n, 'invalid ratio'); return (n + d - 1n) / d; };
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const plain = value => JSON.parse(json(value));
export const lower = address => address.toLowerCase();
export function abiCall(signature, args = []) {
  const abi = parseAbi([signature]);
  const name = abi[0].name;
  return { abi, name, data: encodeFunctionData({ abi, functionName: name, args }) };
}
export function word(data, exact = true) {
  need(typeof data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(data) && (exact ? data.length === 66 : data.length >= 66), 'malformed word');
  return BigInt(data.slice(0, 66));
}
export function addressWord(data) { const n = word(data); need(n < 1n << 160n, 'malformed address'); return `0x${n.toString(16).padStart(40, '0')}`; }
export function cloneCode(target) { return `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`; }

export const registryAbi = parseAbi([
  'function add(address token,uint8 class,uint256 raise) returns (uint32)',
  'function addWithBurn(address token,uint8 class,uint256 raise,bytes4 selector) returns (uint32)',
  'function listing(uint32 id) view returns ((uint32 id,address token,uint8 decimals,uint8 class,uint8 kind,uint64 listedAt,uint256 raise,(uint256 bootstrapQ,uint256 batchMinQ,uint256 tipMaxQ,uint256 swapStepMinQ) q))',
]);
