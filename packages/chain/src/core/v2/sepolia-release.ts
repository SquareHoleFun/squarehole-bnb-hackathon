/**
 * SH-SEP-MANIFEST: the Sepolia writer of the shared manifest's v2 `releases` (the section the indexer and the CoW poster
 * load through `parseCoreManifestV2`). Offline and pure: it takes only the founder's public deploy outputs, never a key,
 * a forge cache file or an RPC:
 *
 * - the reviewed release plan (`squarehole.core-v2-release/2`, DeployCoreV2's saved simulation, VerifyCoreV2's input);
 * - the public contents of the broadcast run file (transaction hashes, created addresses, receipts, the run's own
 *   returned manifest);
 * - VerifyCoreV2's `forge script --json` output (its `ReleaseCodeVerified` event);
 * - the registry address the founder reports, and box 0's deployed v1 manifest (written after the v2 receipts).
 *
 * Every identity is cross-checked between those inputs, and the result is parsed by the same `parseCoreManifestV2` the
 * services use, so a file they would refuse is never produced. Chain reads at the evidence block are a separate,
 * optional step (sepolia-release-chain.ts).
 */
import { BUILD_PROFILE_MAINNET } from '@squarehole/box-spec';
import { decodeAbiParameters, getAddress, keccak256, toBytes, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { drandSourceOf } from '../drand-source';
import { parseCoreManifest, type DeployedCoreManifest } from '../../config/core-manifest';
import { parseCoreManifestV2, type DeployedCoreManifestV2, type ImplementationNameV2 } from './manifest-v2';

export const SEPOLIA_CHAIN_ID = 11_155_111;
export const RELEASE_PLAN_FORMAT = 'squarehole.core-v2-release/2';
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
export const RELEASE_CODE_VERIFIED_TOPIC: Hex = keccak256(toBytes('ReleaseCodeVerified(address,bytes32,uint256)'));
export const DIRECTORY_CODE_VERIFIED_TOPIC: Hex = keccak256(toBytes('DirectoryCodeVerified(address,uint256,bytes32)'));
const VERIFIED_PART_COUNT = 42n;

/** Factory slot → manifest implementation name (BoxFactoryV2.implementation(role); DeployCoreV2.s.sol). */
export const IMPLEMENTATION_SLOTS_V2: Readonly<Record<number, Exclude<ImplementationNameV2, 'hookExtension'>>> = Object.freeze({
  0: 'coordinator', 1: 'token', 2: 'hook', 3: 'vault', 4: 'collection', 5: 'receiver', 6: 'launchRouter', 7: 'tickets',
  8: 'royaltyRouter', 16: 'itemLedger', 17: 'holderLedger', 19: 'starterSetLoader', 20: 'tokenLedger', 21: 'shopVault', 22: 'pileVault',
});

/** The inventory name (`partNames`) each manifest identity must carry. */
const PART_OF: Readonly<Record<ImplementationNameV2 | 'factory' | 'registry' | 'listingRegistry' | 'checks' | 'planner' | 'royaltyCowHandler', string>> = Object.freeze({
  factory: 'BoxFactoryV2', registry: 'BoxRegistryV2', listingRegistry: 'ListingRegistry', checks: 'BoxFactoryV2Checks',
  planner: 'BoxFactoryV2Planner', royaltyCowHandler: 'RoyaltyCowHandler', hookExtension: 'BoxHookV2Extension',
  coordinator: 'BoxCoordinatorV2', token: 'BoxTokenV2', hook: 'BoxHookV2', vault: 'BoxVaultV2', collection: 'BoxCollectionV2',
  receiver: 'BoxReceiverV2', launchRouter: 'BoxLaunchRouterV2', tickets: 'BoxTicketsV2', royaltyRouter: 'BoxRoyaltyRouterV2',
  itemLedger: 'ItemLedgerV2', holderLedger: 'HolderLedgerV2', starterSetLoader: 'StarterSetLoaderV2', tokenLedger: 'BoxTokenV2Ledger',
  shopVault: 'ShopVaultV2', pileVault: 'PileVaultV2',
});

export class SepoliaReleaseError extends Error {
  override readonly name = 'SepoliaReleaseError';
}
const fail = (message: string): never => {
  throw new SepoliaReleaseError(message);
};

const anyAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte address');
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value');
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, 'must be a decimal integer');
const hexQuantity = z.string().regex(/^0x[0-9a-fA-F]{1,16}$/, 'must be a hex quantity');
const directoryTiming = z.strictObject({
  part: z.literal('29'), name: z.literal('FeeModuleDirectoryV21'), simulatedCreationTime: decimal,
});

const planSchema = z.looseObject({
  format: z.literal(RELEASE_PLAN_FORMAT),
  chainId: z.literal(String(SEPOLIA_CHAIN_ID)),
  status: z.enum(['local-simulation', 'broadcast-plan-awaiting-receipts']),
  observedBlock: decimal,
  factory: anyAddress, registry: anyAddress, listingRegistry: anyAddress, checks: anyAddress, planner: anyAddress,
  poolManager: anyAddress, weth: anyAddress, randomness: anyAddress, royaltyCowHandler: anyAddress, royaltyCowHandlerCodeHash: hash32,
  versionCodeHash: hash32,
  implementations: z.array(anyAddress).length(24), implementationCodeHashes: z.array(hash32).length(24),
  parts: z.array(anyAddress).length(42), partNames: z.array(z.string().min(1)).length(42), partCodeHashes: z.array(hash32).length(42),
  // Optional so reviewed format-2 plans saved before SH-V2-RELEASE-TIME remain valid inputs.
  timeDependentCodeHash: directoryTiming.optional(),
  box0: z.looseObject({ registry: anyAddress, coordinator: anyAddress }),
  safes: z.strictObject({ fit: z.record(z.string(), z.unknown()), platform: z.record(z.string(), z.unknown()) }),
  /** DeployCoreV2's snapshot of the native listing (row 0) right after the deploy. */
  listings: z.looseObject({ 0: z.looseObject({ id: z.literal('0'), token: z.literal(ZERO), decimals: z.literal('18'), raise: decimal }) }),
});
export type ReleasePlanV2 = z.output<typeof planSchema>;

const created = z.looseObject({ address: anyAddress, contractName: z.string().nullable().optional() });
const runSchema = z.looseObject({
  chain: z.literal(SEPOLIA_CHAIN_ID),
  transactions: z.array(z.looseObject({
    hash: hash32, contractName: z.string().nullable().optional(), contractAddress: anyAddress.nullable().optional(),
    transaction: z.looseObject({ from: anyAddress }), additionalContracts: z.array(created).optional(),
  })).min(1),
  receipts: z.array(z.looseObject({ transactionHash: hash32, status: z.string(), blockNumber: hexQuantity, blockHash: hash32.optional() })),
  pending: z.array(z.unknown()).optional(),
  returns: z.looseObject({ manifest: z.looseObject({ value: z.string() }) }),
});
export type BroadcastRunV2 = z.output<typeof runSchema>;

const issues = (error: z.ZodError, label: string): string =>
  `${label}: ${error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`;

function parseWith<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(issues(parsed.error, label));
  return (parsed as { data: T }).data;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The only fields in which the broadcast's own returned manifest may differ from the reviewed plan: the simulation's
 * label and block. Part 29's hash and simulated time have a separate event-gated exception below.
 * Every other field (identities, which depend on the nonce, code hashes, Safe pins, CoW addresses,
 * the royalty lot and the native listing snapshot) must be equal.
 */
const RUN_ONLY_FIELDS: ReadonlySet<string> = new Set(['status', 'observedBlock']);
/** v2 is the default (mainnet) build on Sepolia too: v1's 1/10 rehearsal profile never scales it (sepolia-core-v2.md § 2). */
export const RELEASE_RAISE_WEI: bigint = BUILD_PROFILE_MAINNET.values.RAISE;
const canonical = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => {
  if (typeof v === 'string') return v.toLowerCase();
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
  return v;
});

/** The forge `--json` output of VerifyCoreV2: one JSON line with `success` and `raw_logs` (other lines are ignored). */
export function verifiedRelease(verifyOutput: string): {
  readonly factory: Address;
  readonly versionCodeHash: Hex;
  readonly directory?: { readonly address: Address; readonly creationTime: bigint; readonly codeHash: Hex };
} {
  const results = verifyOutput.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === 'object' && 'success' in value ? [value as { success: unknown; raw_logs?: unknown }] : [];
    } catch {
      return [];
    }
  });
  if (results.length !== 1) fail(`VerifyCoreV2 output: expected one forge --json result line, found ${results.length}`);
  const result = results[0] as { success: unknown; raw_logs?: unknown };
  if (result.success !== true) fail('VerifyCoreV2 output: the script did not succeed');
  const logs = Array.isArray(result.raw_logs) ? (result.raw_logs as { topics?: unknown; data?: unknown }[]) : [];
  const events = logs.filter((log) => Array.isArray(log.topics) && typeof log.topics[0] === 'string' && same(log.topics[0], RELEASE_CODE_VERIFIED_TOPIC));
  if (events.length !== 1) fail(`VerifyCoreV2 output: expected one ReleaseCodeVerified event, found ${events.length}`);
  const [factory, versionCodeHash, parts] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
    (events[0] as { data: Hex }).data,
  );
  if (parts !== VERIFIED_PART_COUNT) fail(`VerifyCoreV2 output: ${parts} parts verified, not ${VERIFIED_PART_COUNT}`);
  const directories = logs.filter((log) => Array.isArray(log.topics) && typeof log.topics[0] === 'string' && same(log.topics[0], DIRECTORY_CODE_VERIFIED_TOPIC));
  if (directories.length > 1) fail('VerifyCoreV2 output: expected at most one DirectoryCodeVerified event');
  let directory;
  if (directories.length === 1) {
    try {
      const [address, creationTime, codeHash] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
        (directories[0] as { data: Hex }).data,
      );
      if (same(address, ZERO) || same(codeHash, ZERO_HASH)) fail('empty directory identity');
      directory = { address, creationTime, codeHash: codeHash.toLowerCase() as Hex };
    } catch {
      fail('VerifyCoreV2 output: invalid DirectoryCodeVerified event');
    }
  }
  return { factory, versionCodeHash: versionCodeHash.toLowerCase() as Hex, ...(directory ? { directory } : {}) };
}

export interface ControlProof {
  /** The 1000000000000-wei transfer into the Safe and the Safe transaction sending it out (runbook § 0). */
  readonly inTx: Hex;
  readonly outTx: Hex;
}

export interface SepoliaReleaseInputs {
  /** Box 0's deployed v1 manifest for Sepolia; any `releases` already in it are kept unless this registry's is replaced. */
  readonly v1Manifest: unknown;
  readonly plan: unknown;
  readonly run: unknown;
  readonly verifyOutput: string;
  /** The registry address the founder reports. */
  readonly registry: string;
  readonly controlProofs?: { readonly fit?: ControlProof; readonly platform?: ControlProof };
  /** Replace an existing release with this registry (a re-run after a correction); without it a different one is refused. */
  readonly replace?: boolean;
}

export interface SepoliaReleaseReport {
  readonly startBlock: bigint;
  readonly lastBlock: bigint;
  readonly transactions: number;
  readonly deployer: Address;
  /** Contracts the run created that are not release parts (e.g. the shop's burner child). */
  readonly extraCreated: readonly Address[];
  readonly replaced: boolean;
}

export interface SepoliaReleaseResult {
  /** The file to write: the v1 envelope unchanged plus `releases`. */
  readonly json: Record<string, unknown>;
  readonly manifest: DeployedCoreManifestV2;
  readonly report: SepoliaReleaseReport;
}

function v1Envelope(input: unknown): { v1Json: Record<string, unknown>; v1: DeployedCoreManifest; existing: unknown[] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('v1 manifest: not an object');
  const { releases, ...v1Json } = input as Record<string, unknown>;
  const parsed = parseCoreManifest(v1Json);
  if (parsed.status !== 'deployed') fail('v1 manifest: core v1 is not deployed (awaiting-broadcast): write it with write-core-manifest.mjs after box 0');
  const v1 = parsed as DeployedCoreManifest;
  if (v1.chainId !== SEPOLIA_CHAIN_ID || v1.network !== 'sepolia') fail(`v1 manifest: chain ${v1.chainId} (${v1.network}), not Sepolia`);
  if (releases !== undefined && !Array.isArray(releases)) fail('v1 manifest: releases is not a list');
  return { v1Json, v1, existing: (releases as unknown[] | undefined) ?? [] };
}

function partsOf(plan: ReleasePlanV2): Map<string, { address: Address; codeHash: Hex }> {
  const byName = new Map<string, { address: Address; codeHash: Hex }>();
  const addresses = new Set<string>();
  plan.parts.forEach((address, i) => {
    const name = plan.partNames[i] as string;
    const codeHash = (plan.partCodeHashes[i] as string).toLowerCase() as Hex;
    if (same(address, ZERO) || codeHash === ZERO_HASH) fail(`plan: part ${name} has no address or code hash`);
    if (byName.has(name)) fail(`plan: part name ${name} listed twice`);
    if (addresses.has(address.toLowerCase())) fail(`plan: part address ${address} listed twice`);
    byName.set(name, { address: getAddress(address), codeHash });
    addresses.add(address.toLowerCase());
  });
  return byName;
}

function implementationsOf(plan: ReleasePlanV2, part: (name: string) => { address: Address; codeHash: Hex }) {
  const implementations: Record<string, { address: Address; codeHash: Hex }> = {};
  for (let slot = 0; slot < 24; slot++) {
    const address = plan.implementations[slot] as string;
    const codeHash = (plan.implementationCodeHashes[slot] as string).toLowerCase();
    const name = IMPLEMENTATION_SLOTS_V2[slot];
    if (name === undefined) {
      if (!same(address, ZERO) || codeHash !== ZERO_HASH) fail(`plan: unused implementation slot ${slot} is not zero`);
      continue;
    }
    const expected = part(PART_OF[name]);
    if (!same(address, expected.address) || codeHash !== expected.codeHash) fail(`plan: slot ${slot} (${name}) differs from part ${PART_OF[name]}`);
    implementations[name] = expected;
  }
  implementations.hookExtension = part(PART_OF.hookExtension);
  return implementations;
}

/**
 * The run file's `returns.manifest.value`. Forge records a returned string with its quotes and backslashes escaped and
 * no outer quotes (`{\"box0\":…}`, as in the fork rehearsal's dry-run broadcast file), so it is read as the body of a
 * JSON string first; a plain JSON object is accepted too.
 */
export function returnedManifest(value: string): Record<string, unknown> {
  for (const read of [() => JSON.parse(JSON.parse(`"${value}"`) as string) as unknown, () => JSON.parse(value) as unknown]) {
    try {
      const parsed = read();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the other form
    }
  }
  return fail('run: the returned manifest is not JSON');
}

function receiptsOf(run: BroadcastRunV2, plan: ReleasePlanV2, parts: Map<string, { address: Address }>, directoryVerified: boolean) {
  if ((run.pending ?? []).length !== 0) fail(`run: ${(run.pending ?? []).length} transaction(s) still pending: reconcile before writing`);
  const receipts = new Map(run.receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
  if (receipts.size !== run.receipts.length || run.receipts.length !== run.transactions.length) {
    fail(`run: ${run.transactions.length} transactions but ${run.receipts.length} receipts`);
  }
  const deployers = new Set(run.transactions.map((t) => t.transaction.from.toLowerCase()));
  if (deployers.size !== 1) fail('run: transactions come from more than one sender');
  const createdBy = new Set<string>();
  let first: bigint | null = null;
  let last = 0n;
  for (const t of run.transactions) {
    const receipt = receipts.get(t.hash.toLowerCase());
    if (!receipt) return fail(`run: no receipt for ${t.hash}`);
    if (receipt.status !== '0x1' && receipt.status !== '1') fail(`run: ${t.hash} (${t.contractName ?? 'call'}) has status ${receipt.status}`);
    const block = BigInt(receipt.blockNumber);
    first = first === null || block < first ? block : first;
    last = block > last ? block : last;
    if (t.contractAddress) createdBy.add(t.contractAddress.toLowerCase());
    for (const child of t.additionalContracts ?? []) createdBy.add(child.address.toLowerCase());
  }
  const partAddresses = new Set([...parts.values()].map((p) => p.address.toLowerCase()));
  const missing = [...parts.entries()].filter(([, p]) => !createdBy.has(p.address.toLowerCase())).map(([name]) => name);
  if (missing.length) fail(`run: the broadcast did not create ${missing.join(', ')}`);
  const startBlock = first as bigint;
  if (startBlock <= BigInt(plan.observedBlock)) fail(`run: first receipt block ${startBlock} is not after the plan's observed block ${plan.observedBlock}`);
  const returned = returnedManifest(run.returns.manifest.value);
  const fields = [...new Set([...Object.keys(plan), ...Object.keys(returned)])].filter((f) => !RUN_ONLY_FIELDS.has(f)).sort();
  for (const field of fields) {
    if (directoryVerified && field === 'partCodeHashes') {
      const returnedHashes = parseWith(z.array(hash32).length(42), returned[field], 'run: partCodeHashes');
      if (returnedHashes.every((hash, i) => i === 29 || same(hash, plan.partCodeHashes[i] as string))) continue;
    }
    if (directoryVerified && field === 'timeDependentCodeHash' && plan.timeDependentCodeHash !== undefined) {
      // Both annotations must still name exactly part 29. Only their simulated clock time may differ.
      parseWith(directoryTiming, returned[field], 'run: timeDependentCodeHash');
      continue;
    }
    if (canonical(returned[field]) !== canonical((plan as Record<string, unknown>)[field])) {
      fail(`run: the broadcast's own manifest differs from the reviewed plan in ${field} (a changed nonce or input needs a fresh review)`);
    }
  }
  const extraCreated = [...createdBy].filter((a) => !partAddresses.has(a)).map((a) => getAddress(a));
  return { startBlock, last, deployer: getAddress([...deployers][0] as string), extraCreated };
}

function proofText(proof: ControlProof | undefined, fallback: unknown): string {
  if (!proof) return typeof fallback === 'string' && fallback.length > 0 ? fallback : 'pending';
  for (const tx of [proof.inTx, proof.outTx]) if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) fail(`control proof: ${tx} is not a transaction hash`);
  return `sepolia 1000000000000 wei: in ${proof.inTx.toLowerCase()}, out ${proof.outTx.toLowerCase()}`;
}

/** Builds and validates the Sepolia manifest with this release. Throws `SepoliaReleaseError` or `ChainConfigError`. */
export function buildSepoliaRelease(inputs: SepoliaReleaseInputs): SepoliaReleaseResult {
  const { v1Json, v1, existing } = v1Envelope(inputs.v1Manifest);
  const plan = parseWith(planSchema, inputs.plan, 'plan');
  const run = parseWith(runSchema, inputs.run, 'run');
  const parts = partsOf(plan);
  const part = (name: string) => parts.get(name) ?? fail(`plan: no part ${name}`);
  if (plan.partNames[29] !== 'FeeModuleDirectoryV21') fail('plan: part 29 is not FeeModuleDirectoryV21');
  for (const key of ['factory', 'registry', 'listingRegistry', 'checks', 'planner', 'royaltyCowHandler'] as const) {
    if (!same(plan[key], part(PART_OF[key]).address)) fail(`plan: ${key} ${plan[key]} is not part ${PART_OF[key]}`);
  }
  if (plan.royaltyCowHandlerCodeHash.toLowerCase() !== part(PART_OF.royaltyCowHandler).codeHash) fail('plan: royaltyCowHandlerCodeHash differs from its part');
  if (!anyAddress.safeParse(inputs.registry).success || !same(inputs.registry, plan.registry)) {
    fail(`registry: the founder's ${inputs.registry} is not the plan's ${plan.registry}`);
  }
  const implementations = implementationsOf(plan, part);
  if (BigInt(plan.listings[0].raise) !== RELEASE_RAISE_WEI) {
    fail(`plan: the native listing's raise is ${plan.listings[0].raise} wei, not the release build's ${RELEASE_RAISE_WEI} (built with FOUNDRY_PROFILE=rehearsal? unset it, simulate and review again)`);
  }

  const v1Registry = v1.versions.find((v) => v.version === 1)?.registry.address ?? '';
  if (!same(plan.box0.registry, v1Registry)) fail(`plan: box 0's registry ${plan.box0.registry} is not the v1 manifest's ${v1Registry}`);
  for (const key of ['poolManager', 'weth', 'randomness'] as const) {
    const source = key === 'randomness' ? drandSourceOf(v1) : v1.chain[key];
    if (!same(plan[key], source.address)) fail(`plan: ${key} ${plan[key]} differs from the v1 manifest's ${source.address}`);
  }
  if (!same(String(plan.safes.platform.address), v1.chain.platformSafe.address)) {
    fail(`plan: platform Safe ${String(plan.safes.platform.address)} is not box 0's ${v1.chain.platformSafe.address}`);
  }

  const verified = verifiedRelease(inputs.verifyOutput);
  if (!same(verified.factory, plan.factory) || verified.versionCodeHash !== plan.versionCodeHash.toLowerCase()) {
    fail(`VerifyCoreV2 output: verified factory ${verified.factory} / ${verified.versionCodeHash}, not the plan's`);
  }
  const directory = part('FeeModuleDirectoryV21');
  if (verified.directory && !same(verified.directory.address, directory.address)) {
    fail('VerifyCoreV2 output: verified directory address differs from part 29');
  }
  // This is the verifier's claimed chain hash. The online writer MUST check it at the evidence block before writing.
  const feeModuleDirectory = { ...directory, codeHash: verified.directory?.codeHash ?? directory.codeHash };
  const receipts = receiptsOf(run, plan, parts, verified.directory !== undefined);
  // Every part must exist at the evidence block the chain check (and every service) reads, so the last receipt counts.
  if (receipts.last > BigInt(v1.evidence.block.number)) {
    fail(`v1 manifest: evidence block ${v1.evidence.block.number} is before the last v2 receipt (block ${receipts.last}): rewrite it with write-core-manifest.mjs after the deploy`);
  }

  const safes = Object.fromEntries((['fit', 'platform'] as const).map((role) => {
    const pin = plan.safes[role];
    return [role, { ...pin, controlTransferProof: proofText(inputs.controlProofs?.[role], pin.controlTransferProof) }];
  }));
  const release = {
    version: 2,
    factory: part(PART_OF.factory),
    registry: part(PART_OF.registry),
    listingRegistry: part(PART_OF.listingRegistry),
    feeModuleDirectory,
    safes,
    startBlock: receipts.startBlock.toString(),
    implementations,
    versionCodeHash: plan.versionCodeHash.toLowerCase(),
  };
  const others = existing.filter((r) => !(r && typeof r === 'object' && same(String((r as { registry?: { address?: unknown } }).registry?.address ?? ''), plan.registry)));
  const replaced = others.length !== existing.length;
  if (replaced && !inputs.replace) fail(`v1 manifest: it already lists a release with registry ${plan.registry}; pass replace to rewrite it`);
  const json = { ...v1Json, releases: [...others, release] };
  const manifest = parseCoreManifestV2(json);
  return {
    json,
    manifest,
    report: { startBlock: receipts.startBlock, lastBlock: receipts.last, transactions: run.transactions.length, deployer: receipts.deployer, extraCreated: receipts.extraCreated, replaced },
  };
}
