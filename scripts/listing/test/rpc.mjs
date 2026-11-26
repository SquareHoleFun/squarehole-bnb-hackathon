import { createRequire } from 'node:module';
const { parseAbi, encodeFunctionResult, decodeFunctionData, encodeErrorResult, keccak256, toFunctionSelector } =
  createRequire(new URL('../../../packages/burn-bot/package.json', import.meta.url))('viem');

export const A = n => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
export const H = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
export const [PLAIN, FEE, REBASE, PAUSED, BLACKLIST, BURN] = [101, 102, 103, 104, 105, 106].map(A);
export const CODE = '0x60006000';
export const pin = n => ({ address: A(n), codeHash: keccak256(CODE) });
export const WEEK = 604800n;
export function input() {
  return {
    chainId: '1', rpcEnv: 'LISTING_RPC', registry: pin(1), safe: A(2), multiSend: pin(3), weth: A(4),
    tokens: [PLAIN, FEE, REBASE, PAUSED, BLACKLIST, BURN].map(token => ({ token, class: 'OTHER',
      ...(token === BURN ? { burnSelector: '0x42966c68' } : {}) })),
    referenceAmount: '1000000000000000000', scanFromBlock: '0', logChunk: '1000', bridges: [],
    market: { v2: { factory: pin(20) }, v3: { factory: pin(21), quoter: pin(22), router: pin(23), fees: ['3000'] },
      v4: { manager: pin(24), stateView: pin(25), quoter: pin(26), router: pin(27), permit2: pin(28), fromBlock: '0' } },
    routePolicy: { maxDailyInput: '1000000000000000000', slippageBps: '50', quoteLifetime: '300' },
  };
}
const abi = parseAbi([
  'function lister() view returns (address)', 'function renounced() view returns (bool)',
  'function weth() view returns (address)', 'function boxRegistry() view returns (address)',
  'function listingCount() view returns (uint32)',
  'function setRoyaltyLot(uint32,uint256)',
  'function poolManager() view returns (address)',
  'function listing(uint32) view returns ((uint32 id,address token,uint8 decimals,uint8 class,uint8 kind,uint64 listedAt,uint256 raise,(uint256 bootstrapQ,uint256 batchMinQ,uint256 tipMaxQ,uint256 swapStepMinQ) q))',
  'function newestListingOf(address) view returns (bool,uint32)', 'function checkLayout(uint256) view',
  'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function initialHolder() view returns (address)',
  'function owner() view returns (address)', 'function paused() view returns (bool)',
  'function hasRole(bytes32,address) view returns (bool)', 'function totalSupply() view returns (uint256)',
  'function getPair(address,address) view returns (address)', 'function getPool(address,address,uint24) view returns (address)',
  'function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)',
  'function fee() view returns (uint24)', 'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)',
  'function multiSend(bytes) payable', 'function add(address,uint8,uint256) returns (uint32)',
  'function addWithBurn(address,uint8,uint256,bytes4) returns (uint32)',
  'function approve(address,uint256) returns (bool)',
  'function getInterfaceImplementer(address,bytes32) view returns (address)',
  'error ListingRefused(uint8)', 'error BurnRefused()',
]);
export const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const features = {
  [FEE]: ['setFee(uint256)'], [REBASE]: ['rebase(uint256,uint256)'],
  [A(80)]: ['pause()', 'unpause()', 'owner()', 'paused()'], [BLACKLIST]: ['blacklist(address)', 'isBlacklisted(address)'],
  [BURN]: ['burn(uint256)'],
};
function tokenCode(token) { return `0x${(features[token] ?? []).map(s => `63${toFunctionSelector(s).slice(2)}50`).join('')}6000`; }

/** RPC double models admission failures; it never opens a socket or starts an EVM listener. */
export function fakeRpc() {
  const rpc = {
    requests: [], chainId: '0x1', overrides: true, funded: true, badBurn: false, reorg: false,
    lister: A(2), listed: new Set(), noCode: new Set(), decimals: new Map(), finalizedReads: 0,
    async request(method, params) {
      this.requests.push({ method, params });
      if (method === 'eth_chainId') return this.chainId;
      if (method === 'eth_getBlockByNumber') {
        const number = ['finalized', 'latest'].includes(params[0]) ? 1000n : BigInt(params[0]);
        if (number === 1000n) this.finalizedReads++;
        return { number: `0x${number.toString(16)}`, hash: H(number + (this.reorg && this.finalizedReads > 1 ? 1n : 0n)),
          timestamp: `0x${(1000000n + number * 1008n).toString(16)}` };
      }
      if (method === 'eth_getCode') {
        const address = params[0];
        if (this.noCode.has(address) || address.toLowerCase() === '0x1820a4b7618bde71dce8cdc73aab6c95905fad24') return '0x';
        if ([PLAIN, FEE, REBASE, PAUSED, BLACKLIST, BURN, A(80)].includes(address)) return tokenCode(address);
        return CODE;
      }
      if (method === 'eth_getStorageAt') {
        if (params[0] === PAUSED && params[1] === IMPL_SLOT) return H(80);
        if (params[0] === PAUSED && params[1] === ADMIN_SLOT) return H(81);
        return H(0);
      }
      if (method === 'eth_getLogs') return [];
      if (method !== 'eth_call') throw new Error('non-read RPC refused by double');
      const call = params[0], to = call.to.toLowerCase();
      if (params[2] && call.data === '0x') {
        if (!this.overrides) throw Object.assign(new Error('fake unsupported override'), { code: -32602 });
        const code = params[2][A(2)]?.code;
        if (!code?.startsWith('0x7f') || !code.endsWith('5f5260205ff3')) throw new Error('invalid capability probe');
        return `0x${code.slice(4, 68)}`;
      }
      const { functionName: fn, args = [] } = decodeFunctionData({ abi, data: call.data });
      if (fn === 'multiSend') {
        if (!this.overrides) throw Object.assign(new Error('fake unsupported override'), { code: -32602 });
        if (!params[2]?.[A(2)]?.code) throw new Error('missing override');
        const calls = unpack(args[0]);
        let nextId = 1;
        let lastId;
        for (const c of calls) {
          const decoded = decodeFunctionData({ abi, data: c.data });
          if (decoded.functionName === 'approve') continue;
          if (decoded.functionName === 'setRoyaltyLot') {
            if (decoded.args[0] !== lastId || decoded.args[1] === 0n) throw new Error('wrong lot listing ID');
            continue;
          }
          lastId = nextId++;
          const token = decoded.args[0].toLowerCase();
          let reason;
          if (token === FEE || token === REBASE) reason = 3;
          if (token === PAUSED || token === BLACKLIST) reason = 5;
          if (reason) throw Object.assign(new Error('fake token refusal'), {
            code: 3, data: encodeErrorResult({ abi, errorName: 'ListingRefused', args: [reason] }),
          });
          if (decoded.functionName === 'addWithBurn' && this.badBurn) throw Object.assign(new Error('fake burn refusal'), {
            code: 3, data: encodeErrorResult({ abi, errorName: 'BurnRefused' }),
          });
        }
        return '0x';
      }
      let result;
      const tokenIndex = BigInt(to) - 1000n;
      switch (fn) {
        case 'listingCount': result = 1; break;
        case 'lister': result = this.lister; break;
        case 'renounced': result = false; break;
        case 'weth': result = A(4); break;
        case 'boxRegistry': result = A(5); break;
        case 'poolManager': result = A(24); break;
        case 'listing': result = { id: 0, token: A(0), decimals: 18, class: 1, kind: 1, listedAt: 1n,
          raise: 4206980085000000000n, q: { bootstrapQ: 1n, batchMinQ: 1n, tipMaxQ: 1n, swapStepMinQ: 1n } }; break;
        case 'newestListingOf': result = [this.listed.has(args[0].toLowerCase()), 1]; break;
        case 'checkLayout': return '0x';
        case 'decimals': if (this.decimals.has(to)) return this.decimals.get(to); result = 18; break;
        case 'balanceOf': result = this.funded ? 10000n : 0n; break;
        case 'allowance': result = 0n; break;
        case 'initialHolder': throw Object.assign(new Error('absent function'), { code: 3, data: '0x' });
        case 'owner': result = to === PAUSED ? A(81) : A(0); break;
        case 'paused': result = to === PAUSED; break;
        case 'totalSupply': result = 100000000000000000000000n; break;
        case 'getPair': result = A(0); break;
        case 'getPool': {
          const tokens = args.slice(0, 2).map(a => a.toLowerCase());
          const candidate = tokens.find(a => [PLAIN, FEE, REBASE, PAUSED, BLACKLIST, BURN].includes(a));
          result = candidate && tokens.includes(A(4)) ? A(BigInt(candidate) + 1000n) : A(0); break;
        }
        case 'factory': result = A(21); break;
        case 'token0': result = A(4); break;
        case 'token1': result = A(tokenIndex); break;
        case 'fee': result = 3000; break;
        case 'liquidity': result = 1000000000000000000000000n; break;
        case 'slot0': result = [2n ** 96n, 0, 0, 1, 1, 0, true]; break;
        case 'quoteExactInput': result = [args[1] * 997n / 1000n, [], [], 100000n]; break;
        case 'getInterfaceImplementer': result = A(0); break;
        default: throw Object.assign(new Error('absent getter'), { code: 3, data: '0x' });
      }
      return encodeFunctionResult({ abi, functionName: fn, result });
    },
  };
  return rpc;
}

export function unpack(packed) {
  let data = packed.slice(2); const result = [];
  while (data.length) {
    const size = parseInt(data.slice(106, 170), 16);
    result.push({ operation: data.slice(0, 2), to: `0x${data.slice(2, 42)}`, value: BigInt(`0x${data.slice(42, 106)}`), data: `0x${data.slice(170, 170 + size * 2)}` });
    data = data.slice(170 + size * 2);
  }
  return result;
}
