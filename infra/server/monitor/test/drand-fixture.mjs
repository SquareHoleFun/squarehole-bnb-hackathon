import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { boxCoordinatorAbi } from '../../../../packages/chain/src/abi/boxCoordinator.ts';
import { boxTicketsAbi } from '../../../../packages/chain/src/abi/boxTickets.ts';
import { boxVaultAbi } from '../../../../packages/chain/src/abi/boxVault.ts';
import { drandSourceAbi } from '../../../../packages/chain/src/abi/drandSource.ts';
import { registryV2Abi, vaultV2Abi } from '../../../../packages/chain/src/core/v2/abi-v2.ts';
import { options } from './support.mjs';
export const viem = createRequire(new URL('../../../../packages/indexer/package.json', import.meta.url))('viem');
export const failureAbi = viem.parseAbi(['function failureWindowEnds() view returns (uint256)']);
export const backedAbi = viem.parseAbi(['function DRAND() view returns (address)',
  'function backupOf(uint256 round) view returns (uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix)']);
export const ABIS = { tickets: boxCoordinatorAbi, status: boxTicketsAbi, source: boxTicketsAbi, vault: boxTicketsAbi,
  gateOpenedAt: boxVaultAbi, failureWindowEnds: failureAbi, boxCount: registryV2Abi, roleOf: registryV2Abi,
  requestOf: drandSourceAbi, wordOf: drandSourceAbi, DRAND: backedAbi, backupOf: backedAbi };
export { vaultV2Abi };
export const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/drand/state.json', import.meta.url), 'utf8'));
export const AT = 1792576800n;
export const hex = x => `0x${BigInt(x).toString(16)}`;
export const word = x => `0x${BigInt(x).toString(16).padStart(64, '0')}`;
export const configInput = f => ({ ...options, keeperIdentity: `${options.keeperIdentity.slice(0, -2)}:${f.registry}:${f.coordinator}` });
export const env = { SH_MONITOR_RPC_URL: 'https://rpc.invalid/FAKE_RPC_SECRET', SH_MONITOR_HEARTBEAT_URL: 'https://heartbeat.invalid/FAKE_HEARTBEAT_SECRET' };
export function rpcFixture(f = fixture()) {
  const h = { f, calls: [], posts: [], elapsed: 0, step: 0, fault: null, status: 200, estimate: f.estimates.osaka };
  const selectors = Object.fromEntries(Object.entries(ABIS).map(([name, abi]) => [viem.toFunctionSelector(abi.find(x => x.type === 'function' && x.name === name)), name]));
  h.request = async (url, init) => {
    if (url !== env.SH_MONITOR_RPC_URL || init.method !== 'POST') throw new Error('unexpected request');
    const payload = JSON.parse(init.body), calls = Array.isArray(payload) ? payload : [payload];
    h.posts.push({ payload, at: h.elapsed }); h.elapsed += h.step;
    const replies = calls.map(call => {
      h.calls.push(call);
      const { method, params, id } = call;
      let result, name, args;
      if (method === 'eth_chainId') result = '0xaa36a7';
      else if (method === 'eth_blockNumber') result = hex(f.rpc.latestBlock);
      else if (method === 'eth_getBlockByNumber') result = { number: hex(f.rpc.block), timestamp: hex(f.rpc.timestamp) };
      else if (method === 'eth_getBalance') result = hex(f.rpc.balanceWei);
      else if (method === 'eth_getCode') result = f.code;
      else if (method === 'eth_estimateGas') result = hex(params[0].to.toLowerCase().endsWith('dead') ? f.estimates.baseline : h.estimate);
      else if (method === 'eth_call') {
        name = selectors[params[0].data.slice(0, 10)];
        if (!name) throw new Error('unknown selector');
        args = viem.decodeFunctionData({ abi: ABIS[name], data: params[0].data }).args ?? [];
        const t = f.consumers.find(t => t.address.toLowerCase() === params[0].to.toLowerCase() || t.vault.toLowerCase() === params[0].to.toLowerCase());
        let value;
        if (name === 'tickets') value = f.box0 ?? f.consumers[0].address;
        else if (name === 'boxCount') value = BigInt(f.roles.length);
        else if (name === 'roleOf') { if (args[1] !== 7n) throw new Error('wrong role'); value = f.roles[Number(args[0])]; }
        else if (name === 'DRAND' || name === 'backupOf') {
          const owner = f.consumers.find(t => t.version === 1 && t.source.toLowerCase() === params[0].to.toLowerCase());
          if (name === 'DRAND') value = owner.drand;
          else {
            const b = owner.backups[String(args[0])];
            value = [BigInt(b.startedAt), BigInt(b.targetBlock), BigInt(b.fixedAt), word(b.mix)];
          }
        }
        else if (name === 'status') value = Object.fromEntries(Object.entries(t.status).map(([k, v]) => [k, BigInt(v)]));
        else if (['source', 'vault'].includes(name)) value = t[name];
        else if (['gateOpenedAt', 'failureWindowEnds'].includes(name)) value = BigInt(t[name]);
        else {
          const owner = f.consumers.find(t => t.address.toLowerCase() === args[0].toLowerCase());
          if (owner.source.toLowerCase() !== params[0].to.toLowerCase()) throw new Error('wrong source');
          const k = owner.keys.find(k => BigInt(k.key) === args[1]);
          value = name === 'requestOf' ? [BigInt(k?.requestedAt ?? 0), BigInt(k?.round ?? 0)]
            : [word(k?.[params[1] === 'latest' ? 'latestWord' : 'word'] ?? 0), BigInt(k?.[params[1] === 'latest' ? 'latestReadyAt' : 'readyAt'] ?? 0)];
        }
        result = viem.encodeFunctionResult({ abi: ABIS[name], functionName: name, result: value });
      } else throw new Error('unexpected method');
      return h.fault?.({ call, name, args, result }) ?? { jsonrpc: '2.0', id, result };
    }).reverse().filter(x => x !== 'omit');
    return { status: h.status, body: JSON.stringify(Array.isArray(payload) ? replies : replies[0]) };
  };
  return h;
}
