import { keccak256, parseAbi } from 'viem';

const abi = parseAbi([
  'function receiverCode() view returns (address views, address callback, address directory)',
  'function feeModule(uint8 choice) view returns (address module, bytes32 codeHash)',
]);

/** Read fixed shared release addresses and their live hashes at one manifest block. */
export async function readReceiverParts(client, receiver, blockNumber) {
  const shared = await client.readContract({ address: receiver, abi, functionName: 'receiverCode', blockNumber });
  const parts = {};
  async function part(name, address, expected) {
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === '0x') throw new Error(`missing receiver ${name} part ${address}`);
    if ((code.length - 2) / 2 > 22_118) throw new Error(`oversized receiver ${name} part ${address}`);
    const codeHash = keccak256(code);
    if (expected && codeHash !== expected) throw new Error(`changed receiver ${name} part ${address}`);
    return { address, codeHash };
  }
  for (const [i, name] of ['views', 'callback', 'directory'].entries()) parts[name] = await part(name, shared[i]);
  const modules = [];
  for (const choice of [6, 7, 8, 9]) {
    const [address, hash] = await client.readContract({ address: receiver, abi, functionName: 'feeModule', args: [choice], blockNumber });
    modules.push({ choice, ...await part(`module ${choice}`, address, hash) });
  }
  return { receiver, blockNumber: blockNumber.toString(), ...parts, modules };
}
