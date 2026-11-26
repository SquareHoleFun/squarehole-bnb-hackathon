/**
 * TA-22: an in-memory chain for the real Create's tests (create-send.test.ts, useCreateSend.test.tsx): it answers the
 * run's reads and applies what the recording wallet sends (a factory, a coordinator, a pile, ERC-20s). SH-SHOP-CREATE:
 * also a shop (its seed pull and its starter loader, which pulls each page's items into the shop) and the starter items'
 * ERC-721 collections (owners and single-item approvals).
 */
import { ContractFunctionRevertedError, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, toHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { vi, type Mock } from 'vitest';
import type { Eip1193Request, Eip1193RequestArguments } from '@squarehole/chain/write';
import { submitCreateWriteV2 } from '@squarehole/chain/write';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';
import { coordinatorV2Abi, shopConfigV2, shopVaultV2Abi, starterSetLoaderV2Abi, type CreateSendPlanV2 } from '../../../../../../../packages/chain/src/core/v2';
import type { CreateChainV2, CreateReadsV2, CreateRunV2, LabelCtxV2 } from '../create-send';
import { OWNER } from '../../test-support/fixtures';
import { CONFIGURATIONS } from './example-configurations';
import { inputV2Of } from './v2-fixtures';
import { buildSpecV2, pileSeedOf, recipeCtx } from '../model';
import { ChunkPart, encodeBoxSpecV2, type BoxSpecV2 } from '../spec-types';

export const addr = (n: bigint) => getAddress(toHex(n, { size: 20 }));
export const CHAIN: CreateChainV2 = { chainId: 31337, factory: addr(0xfac7n), listingRegistry: addr(0x1157n), coordinatorImplementation: addr(0xc0den), maxTxGas: 16_777_216n };
export const COORDINATOR = addr(0xc00dn);
export const VAULT = addr(0x7a017n);
/** A shop's starter loader (role 19) and the created box's receiver. */
export const LOADER = addr(0x10adn);
export const RECEIVER = addr(0x7ece17en);
const NFT = parseAbi(['function approve(address to, uint256 id)', 'function ownerOf(uint256 id) view returns (address)']);
const FUND_SEED = encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'fundSeed' }).toLowerCase();
export const Q = 1_000_000n;
export const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

export interface Fake {
  readonly reads: CreateReadsV2;
  readonly wallet: Mock<Eip1193Request>;
  readonly sent: { to: Address; data: Hex; value: bigint }[];
  readonly state: {
    created: boolean; allowances: Map<string, bigint>; loaded: Map<number, bigint>; gateHeld: boolean; listingRaise: bigint; otherSpec: boolean;
    /** A shop's seed pulled; its starter loader's count. */
    seedReady: boolean; starterLoaded: number;
    /** ERC-721 owners and single-item approvals, by `collection:id` (lower case); an unknown item is OWNER's. */
    owners: Map<string, Address>; approved: Map<string, Address>;
    /** Items the collection no longer has: their `ownerOf` and `getApproved` revert, as an ERC-721's do for a burned id. */
    burned: Set<string>;
  };
  readonly txs: Map<Hex, 'success' | 'reverted' | 'pending'>;
  rejectNext: boolean;
  revertNext: boolean;
  holdNext: boolean;
}

/** A chain that answers the run's reads and applies the wallet's sends (a factory, a coordinator, a pile, ERC-20s). */
export function fakeChain(spec: BoxSpecV2): Fake {
  const priceToken = spec.pricing.token;
  const token = toHex(BigInt(priceToken) + 1n, { size: 20 }) as Address;
  const counts = new Map<number, bigint>([[ChunkPart.Table, BigInt(Math.ceil((spec.metadataTable.length - 2) / 2 / 8192))], [ChunkPart.Texts, 0n]]);
  const shop = spec.boxType === 4;
  const state = { created: false, allowances: new Map<string, bigint>(), loaded: new Map<number, bigint>([[1, 0n], [2, 0n]]), gateHeld: spec.boxType === 5 || shop, listingRaise: spec.raise, otherSpec: false,
    seedReady: false, starterLoaded: 0, owners: new Map<string, Address>(), approved: new Map<string, Address>(), burned: new Set<string>() };
  // A shop's listed collections: the ERC-721s its starter items are approved and pulled on.
  const collections = new Set(shop ? shopConfigV2(spec.contentsParams).collections.map((c) => c.toLowerCase()) : []);
  const item = (collection: string, id: unknown) => `${collection.toLowerCase()}:${String(id)}`;
  const txs = new Map<Hex, 'success' | 'reverted' | 'pending'>();
  const sent: Fake['sent'] = [];
  const key = (coin: string, owner: string, spender: string) => `${coin}:${owner}:${spender}`.toLowerCase();
  const fake: Fake = {
    state, txs, sent, rejectNext: false, revertNext: false, holdNext: false,
    reads: {
      feeReader: TEST_FEE_READER,
      chainId: async () => CHAIN.chainId,
      blockNumber: async () => 100n,
      blockGasLimit: async () => 60_000_000n,
      code: async (address) => (address.toLowerCase() === COORDINATOR.toLowerCase() && state.created ? '0x01' : '0x'),
      estimateGas: async () => 1_000_000n,
      receipt: async (hash) => { const s = txs.get(hash); return s === undefined || s === 'pending' ? null : s; },
      known: async (hash) => txs.has(hash),
      wait: async (hash) => { const s = txs.get(hash); if (s === 'pending') { txs.set(hash, 'success'); return 'success'; } return s ?? 'reverted'; },
      read: async (address: Address, _abi: Abi, fn: string, args: readonly unknown[] = []) => {
        if (collections.has(address.toLowerCase())) {
          if (fn === 'ownerOf') {
            if (state.burned.has(item(address, args[0]))) throw new ContractFunctionRevertedError({ abi: NFT, functionName: 'ownerOf', message: 'NOT_MINTED' });
            return state.owners.get(item(address, args[0])) ?? OWNER;
          }
          if (fn === 'getApproved') {
            if (state.burned.has(item(address, args[0]))) throw new ContractFunctionRevertedError({ abi: NFT, functionName: 'getApproved', message: 'NOT_MINTED' });
            return state.approved.get(item(address, args[0])) ?? zeroAddress;
          }
          if (fn === 'isApprovedForAll') return false;
          throw new Error(`unexpected collection read ${fn}`);
        }
        switch (fn) {
          case 'CHUNK_MAX': return 8192n;
          case 'listingRegistry': return CHAIN.listingRegistry;
          case 'listing': return { token: priceToken, raise: state.listingRaise };
          case 'refusal': return '0x';
          case 'boxQParameters': return { bootstrapQ: Q };
          case 'tokenAddressLimit': return toHex(BigInt(args[0] as string) + ((1n << 160n) - BigInt(args[0] as string)) / 2n, { size: 20 });
          case 'predictBox': return [COORDINATOR, token, keccak256('0x1234')];
          case 'allowance': return state.allowances.get(key(address, args[0] as string, args[1] as string)) ?? 0n;
          case 'creator': return OWNER;
          case 'specHash': return state.otherSpec ? keccak256('0x00') : keccak256(encodeBoxSpecV2(spec));
          case 'factory': return CHAIN.factory;
          case 'token': return token;
          case 'roleAddress': return VAULT;
          case 'starterSetLoader': return spec.boxType === 5 ? VAULT : LOADER;
          case 'receiver': return RECEIVER;
          case 'progress': return [state.starterLoaded, `0x${'00'.repeat(32)}`, !state.gateHeld];
          case 'chunkState': return [`0x${'00'.repeat(32)}`, state.loaded.get(args[0] as number) ?? 0n, counts.get(args[0] as number) ?? 0n];
          case 'starterSetPending': return state.gateHeld;
          case 'asset': return spec.boxType === 5 ? (pileAsset(spec)) : zeroAddress;
          case 'seedAmount': return pileAmount(spec);
          case 'seeder': return OWNER;
          case 'seedReady': return state.seedReady;
          default: throw new Error(`unexpected read ${fn}`);
        }
      },
    },
    wallet: vi.fn<Eip1193Request>(async ({ method, params }: Eip1193RequestArguments) => {
      if (method === 'eth_chainId') return toHex(CHAIN.chainId);
      if (method === 'eth_accounts') return [OWNER];
      if (method !== 'eth_sendTransaction') throw new Error(method);
      if (fake.rejectNext) { fake.rejectNext = false; throw Object.assign(new Error('User rejected'), { code: 4001 }); }
      const tx = ((params as readonly unknown[] | undefined)?.[0] ?? {}) as { to: Address; data: Hex; value: Hex };
      const call = { to: tx.to, data: tx.data, value: BigInt(tx.value) };
      sent.push(call);
      const hash = keccak256(toHex(sent.length, { size: 32 }));
      if (fake.revertNext) { fake.revertNext = false; txs.set(hash, 'reverted'); return hash; }
      const to = call.to.toLowerCase();
      if (to === CHAIN.factory.toLowerCase()) state.created = true;
      else if (to === COORDINATOR.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: coordinatorV2Abi, data: call.data }) as { args: readonly [number] };
        state.loaded.set(args[0], (state.loaded.get(args[0]) ?? 0n) + 1n);
      } else if (to === VAULT.toLowerCase() && shop) {
        if (call.data.toLowerCase() === FUND_SEED) state.seedReady = true;
      } else if (to === VAULT.toLowerCase()) state.gateHeld = false;
      else if (to === LOADER.toLowerCase()) {
        // StarterSetLoaderV2: a page pulls each item from OWNER (approved to the shop) into the shop; complete opens the gate.
        const decoded = decodeFunctionData({ abi: starterSetLoaderV2Abi, data: call.data });
        if (decoded.functionName === 'complete') { if (!state.seedReady) throw new Error('complete before the seed'); state.gateHeld = false; }
        else {
          const [pageCollections, ids] = decoded.args as unknown as readonly [readonly Address[], readonly bigint[]];
          ids.forEach((id, i) => {
            const key = item(pageCollections[i] ?? zeroAddress, id);
            if ((state.owners.get(key) ?? OWNER) !== OWNER || state.approved.get(key) !== VAULT) throw new Error(`starter ${key} not approved`);
            state.owners.set(key, VAULT); state.approved.delete(key);
          });
          state.starterLoaded += ids.length;
        }
      } else if (collections.has(to)) {
        const { args } = decodeFunctionData({ abi: NFT, data: call.data }) as { args: readonly [Address, bigint] };
        state.approved.set(item(to, args[1]), args[0]);
      } else {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: call.data }) as { args: readonly [Address, bigint] };
        state.allowances.set(key(call.to, OWNER, args[0]), args[1]);
      }
      txs.set(hash, fake.holdNext ? 'pending' : 'success');
      fake.holdNext = false;
      return hash;
    }),
  };
  return fake;
}
export const pileAsset = (spec: BoxSpecV2) => `0x${spec.contentsParams.slice(26, 66)}` as Address;
export const pileAmount = (spec: BoxSpecV2) => BigInt(`0x${spec.contentsParams.slice(66, 130)}`);

export function setup(id: string, patch: Parameters<typeof inputV2Of>[1] = {}, form: Parameters<typeof inputV2Of>[2] = {}) {
  const input = inputV2Of(config(id), patch, form);
  const spec = buildSpecV2(input);
  const ctx: LabelCtxV2 = { pricing: recipeCtx(input).pricing, seed: pileSeedOf(input)?.listing ?? null, ticker: input.form.ticker };
  const fake = fakeChain(spec);
  let stored: CreateRunV2 | null = null;
  // SH-218 rail 2: the Create switches' last check the executor asks (none off unless a test switches some).
  const createOptionsCheck = vi.fn<(plan: CreateSendPlanV2) => Promise<void>>(async () => undefined);
  const hooks = (stop: () => boolean = () => false) => ({ reads: fake.reads, chain: CHAIN, ctx,
    submit: (options: Parameters<typeof submitCreateWriteV2>[0] extends infer O ? Omit<O, 'wallet' | 'createOptionsCheck'> : never) => submitCreateWriteV2({ ...options, wallet: fake.wallet, createOptionsCheck }),
    onRun: (run: CreateRunV2) => { stored = run; }, onProgress: vi.fn(), stopped: stop });
  return { spec, ctx, fake, hooks, stored: () => stored, createOptionsCheck };
}
export const kinds = (fake: Fake) => fake.sent.map((call) => {
  if (call.to.toLowerCase() === CHAIN.factory.toLowerCase()) return 'createBox';
  if (call.to.toLowerCase() === COORDINATOR.toLowerCase()) return 'loadChunk';
  if (call.to.toLowerCase() === VAULT.toLowerCase()) return call.data.toLowerCase() === FUND_SEED ? 'fundSeed' : 'loadSeed';
  if (call.to.toLowerCase() === LOADER.toLowerCase()) return decodeFunctionData({ abi: starterSetLoaderV2Abi, data: call.data }).functionName === 'complete' ? 'complete' : 'loadStarter';
  return 'approve';
});
/** The ERC-721 `approve(to, id)` a call makes, or null (the same selector as ERC-20's: told apart by its target). */
export const nftApproval = (call: { readonly data: Hex }) => decodeFunctionData({ abi: NFT, data: call.data }).args as readonly [Address, bigint];
