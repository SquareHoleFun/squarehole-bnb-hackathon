/**
 * TEST ONLY (SH-SEP-MANIFEST). The founder's public deploy outputs for the Sepolia v2 releases writer, made from the fork
 * simulation's public release manifest (fixtures/sepolia-fork-release-plan.json: DeployCoreV2 against an anvil fork of
 * Sepolia block 11,951,526, status `local-simulation`, copied verbatim). Everything else is synthesized here from that
 * plan: the broadcast run file's public shape (forge's run-latest.json fields: hashes, created addresses, children,
 * receipts, the returned manifest; never a real run file), VerifyCoreV2's `forge script --json` line, box 0's deployed
 * v1 manifest, and a chain whose reads agree with all of it. No key, no cache file, no network.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { labelAddress, labelHash } from '../../test-support';
import type { DeployedCoreManifestV2, ReleaseV2 } from '../manifest-v2';
import { EMPTY_CODE_HASH_V2, SAFE_EXECUTION_SUCCESS_TOPIC, SAFE_GUARD_SLOT, SAFE_HANDLER_SLOT, type ReleaseChainReads, type ReleaseView } from '../sepolia-release-chain';
import { IMPLEMENTATION_SLOTS_V2, RELEASE_CODE_VERIFIED_TOPIC } from '../sepolia-release';

export const FORK_PLAN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sepolia-fork-release-plan.json');
export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fresh copy of the fork plan (tests mutate their own copy). */
export const forkPlan = (): Json => JSON.parse(readFileSync(FORK_PLAN_PATH, 'utf8')) as Json;

/** The run starts 40 blocks after the plan's observed block; one receipt per block. */
export const RUN_START_OFFSET = 40n;
export const EVIDENCE_OFFSET = 200n;
const entry = (address: string, label: string) => ({ address: getAddress(address), codeHash: labelHash(`code:${label}`) });

/** Box 0's deployed v1 manifest on Sepolia: the fork's PoolManager, WETH, drand source, platform Safe and v1 registry. */
export function forkV1Manifest(plan: Json = forkPlan(), evidenceBlock: bigint = BigInt(plan.observedBlock) + EVIDENCE_OFFSET): Json {
  const v1 = (label: string) => entry(labelAddress(`sepolia-v1:${label}`), `v1:${label}`);
  return {
    schema: 'squarehole.core-deployment/v1',
    status: 'deployed',
    chainId: 11155111,
    network: 'sepolia',
    chain: {
      poolManager: entry(plan.poolManager, 'poolManager'),
      weth: entry(plan.weth, 'weth'),
      randomness: entry(plan.randomness, 'randomness'),
      platformSafe: { address: getAddress(plan.safes.platform.address), codeHash: plan.safes.platform.codeHash },
    },
    versions: [{
      version: 1,
      factory: v1('factory'),
      registry: entry(plan.box0.registry, 'v1:registry'),
      startBlock: String(BigInt(plan.observedBlock) - 1000n),
      implementations: Object.fromEntries(['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'].map((k) => [k, v1(k)])),
      versionCodeHash: labelHash('v1:version'),
      supportedTemplates: [labelHash('v1:template')],
    }],
    evidence: { block: { number: evidenceBlock.toString(), hash: labelHash(`block:${evidenceBlock}`) }, finality: 'finalized' },
    gitCommit: null,
  };
}

/** Children created inside a parent's constructor (forge lists them under `additionalContracts`). */
const CHILD_OF: Readonly<Record<string, string>> = { CoordinatorViews: 'BoxCoordinatorV2', VaultViews: 'BoxVaultV2', BoxTicketsV2Views: 'BoxTicketsV2', RoyaltyCowHandler: 'BoxRoyaltyRouterV2' };
const LIBRARIES = new Set(['FactoryChecksCurve', 'RewardAccountingV21', 'ReceiverShopV21', 'ReceiverRewardsV21', 'ReceiverPendingV21', 'ReceiverModuleCallV21', 'ReceiverBooksV21', 'FeeModuleProofV21']);
export const SHOP_BURNER = labelAddress('fork:ShopTBurnerV2');
export const FORK_DEPLOYER = getAddress('0x5583f846b0ddc80f49ea0e89c51520ba341c6658');

/** The broadcast run file's public contents for the plan: one transaction per non-child part (38), all mined. */
export function forkRun(plan: Json = forkPlan()): Json {
  const names: string[] = plan.partNames;
  const start = BigInt(plan.observedBlock) + RUN_START_OFFSET;
  const top = names.filter((name) => !(name in CHILD_OF));
  const addressOf = (name: string) => plan.parts[names.indexOf(name)] as string;
  const transactions = top.map((name, i) => ({
    hash: labelHash(`tx:${name}`),
    transactionType: LIBRARIES.has(name) ? 'CREATE2' : 'CREATE',
    contractName: name,
    contractAddress: addressOf(name).toLowerCase(),
    function: null,
    arguments: null,
    transaction: { from: FORK_DEPLOYER.toLowerCase(), gas: '0x1000000', nonce: toHex(6 + i), chainId: '0xaa36a7' },
    additionalContracts: [
      ...Object.entries(CHILD_OF).filter(([, parent]) => parent === name).map(([child]) => ({ transactionType: 'CREATE', contractName: child, address: addressOf(child).toLowerCase() })),
      ...(name === 'ShopVaultV2' ? [{ transactionType: 'CREATE', contractName: 'ShopTBurnerV2', address: SHOP_BURNER.toLowerCase() }] : []),
    ],
    isFixedGasLimit: false,
  }));
  const receipts = transactions.map((t, i) => ({
    status: '0x1',
    transactionHash: t.hash,
    blockNumber: toHex(start + BigInt(i)),
    blockHash: labelHash(`block:${start + BigInt(i)}`),
    contractAddress: t.transactionType === 'CREATE' ? t.contractAddress : null,
    from: t.transaction.from,
    gasUsed: '0x100000',
    logs: [],
  }));
  const returned = { ...plan, status: 'broadcast-plan-awaiting-receipts', observedBlock: String(start - 1n) };
  return {
    transactions, receipts, libraries: [], pending: [],
    // Forge's form of a returned string: quotes escaped, no outer quotes (as in the fork rehearsal's dry-run broadcast file).
    returns: { factory: { internal_type: 'address', value: plan.factory }, manifest: { internal_type: 'string', value: JSON.stringify(JSON.stringify(returned)).slice(1, -1) } },
    timestamp: 1792455602605, chain: 11155111, commit: 'fixture',
  };
}

/** VerifyCoreV2's `forge script --json` output: a log line, the result line with its event, a trailing line. */
export function forkVerifyOutput(plan: Json = forkPlan(), o: { readonly success?: boolean; readonly factory?: string; readonly parts?: bigint } = {}): string {
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }], [getAddress(o.factory ?? plan.factory), plan.versionCodeHash as Hex, o.parts ?? 42n]);
  const result = { logs: [], returns: {}, success: o.success ?? true, raw_logs: [{ address: labelAddress('verify-script'), topics: [RELEASE_CODE_VERIFIED_TOPIC], data }], gas_used: 1, labeled_addresses: {}, returned: '0x', address: null };
  return ['Compiling 1 files with Solc 0.8.26', JSON.stringify(result), ''].join('\n');
}

/** A chain whose reads agree with a built manifest at its evidence block; `override` changes single answers. */
export class FakeReleaseChain implements ReleaseChainReads {
  readonly codes = new Map<string, Hex>();
  readonly views = new Map<string, unknown>();
  readonly slots = new Map<string, Hex>();
  readonly receipts = new Map<string, Awaited<ReturnType<ReleaseChainReads['receipt']>>>();
  readonly seenBlocks = new Set<bigint>();
  chain = 11155111;

  constructor(readonly manifest: DeployedCoreManifestV2, readonly release: ReleaseV2) {
    const r = release;
    for (const e of [r.factory, r.registry, r.listingRegistry, r.feeModuleDirectory, ...Object.values(r.implementations)]) if (e) this.codes.set(e.address.toLowerCase(), e.codeHash);
    this.setView(r.factory.address, 'registry', [], r.registry.address);
    this.setView(r.factory.address, 'listingRegistry', [], r.listingRegistry.address);
    this.setView(r.factory.address, 'versionCodeHash', [], r.versionCodeHash);
    for (let slot = 0; slot < 24; slot++) {
      const name = IMPLEMENTATION_SLOTS_V2[slot];
      this.setView(r.factory.address, 'implementation', [BigInt(slot)], name ? r.implementations[name]?.address ?? '0x0000000000000000000000000000000000000000' : '0x0000000000000000000000000000000000000000');
    }
    this.setView(r.implementations.hook.address, 'extension', [], r.implementations.hookExtension.address);
    this.setView(r.implementations.receiver.address, 'FIT_SAFE', [], getAddress(r.safes.fit.address));
    this.setView(r.implementations.receiver.address, 'PLATFORM_SAFE', [], getAddress(r.safes.platform.address));
    for (const pin of [r.safes.fit, r.safes.platform]) {
      this.codes.set(pin.address, pin.codeHash);
      this.codes.set(pin.singleton, pin.singletonCodeHash);
      if (BigInt(pin.handler) !== 0n) this.codes.set(pin.handler, pin.handlerCodeHash);
      if (BigInt(pin.guard) !== 0n) this.codes.set(pin.guard, pin.guardCodeHash);
      this.slots.set(`${pin.address}:0x0`, `0x${pin.singleton.slice(2).padStart(64, '0')}`);
      this.slots.set(`${pin.address}:${SAFE_GUARD_SLOT}`, `0x${pin.guard.slice(2).padStart(64, '0')}`);
      this.slots.set(`${pin.address}:${SAFE_HANDLER_SLOT}`, `0x${pin.handler.slice(2).padStart(64, '0')}`);
      this.setView(pin.address, 'getOwners', [], pin.owners.map((o) => getAddress(o)));
      this.setView(pin.address, 'getThreshold', [], BigInt(pin.threshold));
      this.setView(pin.address, 'VERSION', [], pin.version);
      this.setView(pin.singleton, 'VERSION', [], pin.version);
      this.setView(pin.address, 'getModulesPaginated', ['0x0000000000000000000000000000000000000001', 10n], [[], '0x0000000000000000000000000000000000000001']);
    }
  }

  private key = (address: string, view: string, args: readonly unknown[]) => `${address.toLowerCase()}:${view}:${args.map(String).join(',').toLowerCase()}`;
  setView(address: string, view: ReleaseView, args: readonly unknown[], value: unknown): void {
    this.views.set(this.key(address, view, args), value);
  }
  /** Records a successful control-transfer pair for a Safe. */
  addControlProof(safe: Address, inTx: Hex, outTx: Hex, block: bigint): void {
    this.receipts.set(inTx, { status: 'success', to: safe, blockNumber: block, logs: [] });
    this.receipts.set(outTx, { status: 'success', to: safe, blockNumber: block + 1n, logs: [{ address: safe, topics: [SAFE_EXECUTION_SUCCESS_TOPIC, keccak256(outTx)] }] });
  }

  chainId = async () => this.chain;
  blockHash = async (n: bigint): Promise<Hex> => {
    this.seenBlocks.add(n);
    return labelHash(`block:${n}`);
  };
  codeHash = async (address: Address, n: bigint): Promise<Hex> => {
    this.seenBlocks.add(n);
    return this.codes.get(address.toLowerCase()) ?? EMPTY_CODE_HASH_V2;
  };
  call = async (address: Address, view: ReleaseView, args: readonly unknown[], n: bigint): Promise<unknown> => {
    this.seenBlocks.add(n);
    const key = this.key(address, view, args);
    if (!this.views.has(key)) throw new Error(`fake chain: no answer for ${key}`);
    return this.views.get(key);
  };
  storage = async (address: Address, slot: Hex, n: bigint): Promise<Hex> => {
    this.seenBlocks.add(n);
    return this.slots.get(`${address.toLowerCase()}:${slot}`) ?? `0x${'0'.repeat(64)}`;
  };
  receipt = async (hash: Hex) => this.receipts.get(hash) ?? null;
}
