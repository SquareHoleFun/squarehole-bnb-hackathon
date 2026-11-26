/**
 * Strict mock vs live manifests (v2 docs/07 "Two manifests"; GOV-02 "Unresolved money-moving gates fail deployment
 * validation; mock intent cannot become live"; SH-V2-T03).
 *
 * - A **mock intent** mirrors v2's `schemas/intent.schema.json` exactly (environment mock/local, `liveReady: false`,
 *   chain 31337, Q `mock:Q` with no address, every money choice UNRESOLVED). It is never a transaction and never live.
 * - A **live manifest** (`squarehole.core-deployment/v2`) is a record of real contracts on a real chain. It carries
 *   `eth_getCode` evidence for every address it names, binds the intent hash, embeds its policies and lists all 14
 *   gates. No mock id, demo chain, null or zero address can appear in it.
 * - **Live-ready** (`liveReady: true`) is production only, and needs every gate CLOSED by an accepted ADR, approved
 *   policies with no UNRESOLVED field, finalized evidence matching reviewed bytecode, v2's release evidence and an
 *   explicit human authorization. A testnet record is never live-ready.
 *
 * Nothing here turns one kind into the other: there is no promotion function.
 */
import { z } from 'zod';
import { DataValidationError, CoreModelError } from '../errors';
import type { GuardIssue } from '../guards';
import { isAddress, isZeroAddress } from '../ids';
import type { SafeParseResult } from '../schemas';
import {
  addressField,
  chainIdField,
  isoTimestampField,
  isRecord,
  parseWith,
  rawAmountField,
  reportIssues,
  safeParseWith,
  textField,
} from '../validation';
import { CORE_GATE_IDS, coreGate, gateIdField, gateRecordSchema, refField, type GateId } from './gates';
import { CORE_CHAIN_IDS, isAssetId, parseAssetId, parseCollectionId, type ParsedAssetId } from './ids';
import { feePolicySchema, quotePolicySchema, unresolvedPolicyFields, vaultPolicySchema } from './policy';

export const INTENT_SCHEMA_VERSION = '2.0';
export const LIVE_MANIFEST_SCHEMA = 'squarehole.core-deployment/v2';
/** keccak256 of empty bytecode: the code hash of an address with no contract. */
export const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
/** P01 / F10(c): one billion FIT with 18 decimals, issued once. */
export const GENESIS_FIT_RAW = '1000000000000000000000000000';
/**
 * The edition size N of The Misfits: 4,200 (F35, "confirmed: 4,200 in total"; `MisfitsCollection.MISFITS_COUNT`).
 * It overrides v2 C03's 10,000 for every real deployment record (docs/v2/CONFLICTS.md).
 */
export const MISFITS_COUNT = 4_200;
/**
 * v2 C03 as v2's own intent schema states it (`schemas/intent.schema.json`: collection.count const 10,000,
 * revenue.slotWeights "equal/10000"). The mock intent mirrors that schema exactly and is never a deployment, so it
 * keeps v2's example; the differential test holds it to the schema.
 */
export const V2_INTENT_MISFITS_COUNT = 10_000;
export const LIVE_TESTNET_CHAIN_IDS: readonly number[] = Object.freeze([CORE_CHAIN_IDS.sepolia]);
export const PRODUCTION_CHAIN_ID = CORE_CHAIN_IDS.ethereum;

// --- Mock intent --------------------------------------------------------------------------------------------------

const mockIntentShape = z.strictObject({
  schemaVersion: z.literal(INTENT_SCHEMA_VERSION),
  environment: z.enum(['mock', 'local']),
  liveReady: z.literal(false),
  chainId: z.literal(CORE_CHAIN_IDS.localDemo),
  token: z.strictObject({
    name: z.literal('FIT'),
    symbol: z.literal('FIT'),
    initialSupplyRaw: z.literal(GENESIS_FIT_RAW),
    decimals: z.literal(18),
    mintAfterInitialization: z.literal(false),
  }),
  collection: z.strictObject({
    name: z.literal('The Misfits'),
    count: z.literal(V2_INTENT_MISFITS_COUNT),
    createdAt: z.literal('graduation'),
    financialWeight: z.literal('equal'),
    rarityAffectsPrincipal: z.literal(false),
  }),
  q: z.strictObject({
    assetId: z.literal('mock:Q'),
    address: z.null(),
    decimals: z.number().int().min(0).max(36),
    productionCandidate: z.string().nullable(),
  }),
  launch: z.strictObject({
    marketFromStart: z.literal('FIT/Q'),
    targetETHReference: z.literal('4.206980085'),
    targetQRaw: z.null(),
    referencePolicy: z.literal('PROPOSED_FREEZE_AT_LAUNCH'),
    allocationStatus: z.literal('UNAPPROVED'),
  }),
  vault: z.strictObject({
    mechanism: z.literal('LOCK_RELEASE'),
    formula: z.literal('(S-E)/n'),
    surplus: z.literal('PERMANENTLY_STUCK'),
    emptyPolicy: z.literal('UNRESOLVED'),
    donationPolicy: z.literal('UNRESOLVED'),
    selectionPolicy: z.literal('UNRESOLVED'),
  }),
  revenue: z.strictObject({
    slotWeights: z.literal('equal/10000'),
    inside: z.literal('BURN_FUNDED_FIT'),
    outside: z.literal('HISTORICAL_OWNER_CLAIM'),
    rateStatus: z.literal('UNAPPROVED'),
    delayedQPolicy: z.literal('UNRESOLVED'),
  }),
  // Stricter than the schema's ^G[0-9]{2}$: only the 14 gates v2 defines.
  openGates: z
    .array(gateIdField)
    .min(1)
    .refine((gates) => new Set(gates).size === gates.length, 'gates must be unique'),
});

export type MockIntentManifest = Readonly<z.output<typeof mockIntentShape>>;

export const parseMockIntent = (input: unknown): MockIntentManifest => parseWith(mockIntentShape, input, 'mock intent');
export const safeParseMockIntent = (input: unknown): SafeParseResult<MockIntentManifest> => safeParseWith(mockIntentShape, input);

// --- Live deployment manifest ------------------------------------------------------------------------------------

const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex value');
const assetIdField = z.string().refine(isAssetId, 'must be a CAIP-19 asset id or mock:<name>');
const nullableRef = refField.nullable();

const evidenceSchema = z.strictObject({
  chainId: chainIdField,
  address: addressField,
  /** How the code hash was observed: keccak256 of eth_getCode at `block`. */
  method: z.literal('eth_getCode'),
  codeHash: hash32,
  /** The reviewed build's runtime code hash, when known. Required for production. */
  expectedCodeHash: hash32.nullable(),
  block: z.strictObject({ number: rawAmountField, hash: hash32 }),
  finality: z.enum(['confirmed', 'finalized']),
});

/** The v2 components that must exist on chain (v2 docs/07). Several roles may share one contract. */
const contractsSchema = z.strictObject({
  fit: addressField,
  misfits: addressField,
  vault: addressField,
  escrow: addressField,
  launchCoordinator: addressField.optional(),
  marketAdapter: addressField.optional(),
  revenueAccounting: addressField.optional(),
  revenueProcessor: addressField.optional(),
  registry: addressField.optional(),
});

const releaseSchema = z.strictObject({
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character git commit').nullable(),
  licenseReport: nullableRef,
  externalRoutes: nullableRef,
  feeIncidenceTable: nullableRef,
  mintGasReport: nullableRef,
  permissionGraph: nullableRef,
  securityReview: nullableRef,
  recoveryRunbook: nullableRef,
});

const liveShape = z.strictObject({
  schema: z.literal(LIVE_MANIFEST_SCHEMA),
  environment: z.enum(['testnet', 'production']),
  liveReady: z.boolean(),
  chainId: chainIdField,
  /** Hash of the accepted intent this deployment implements. */
  intentHash: hash32,
  assets: z.strictObject({
    fit: z.strictObject({
      assetId: assetIdField,
      decimals: z.number().int().min(0).max(36),
      symbol: textField({ min: 1, max: 32, innerSpaces: false, newlines: false }),
      initialSupplyRaw: rawAmountField,
    }),
    q: z.strictObject({
      assetId: assetIdField,
      decimals: z.number().int().min(0).max(36),
      symbol: textField({ min: 1, max: 32, innerSpaces: false, newlines: false }),
    }),
  }),
  collection: z.strictObject({ collectionId: z.string(), count: z.number().int() }),
  contracts: contractsSchema,
  evidence: z.array(evidenceSchema).min(1),
  policies: z.strictObject({ fee: feePolicySchema, quote: quotePolicySchema, vault: vaultPolicySchema }),
  gates: z.array(gateRecordSchema),
  release: releaseSchema,
  authorization: z
    .strictObject({
      by: textField({ min: 1, max: 80, innerSpaces: true, newlines: false }),
      at: isoTimestampField,
      scope: z.literal('production'),
      ref: refField,
    })
    .nullable(),
});

type LiveShape = z.output<typeof liveShape>;
declare const liveReadyBrand: unique symbol;

export type LiveDeploymentManifest = Readonly<LiveShape>;
/** Only `requireLiveReady` / `isLiveReady` produce this type. */
export type LiveReadyManifest = LiveDeploymentManifest & {
  readonly environment: 'production';
  readonly liveReady: true;
  readonly authorization: NonNullable<LiveShape['authorization']>;
  readonly [liveReadyBrand]: true;
};

/** v2 examples/deployment.required-fields.json, item by item, and where a live manifest records each. */
export const RELEASE_EVIDENCE_ITEMS: readonly { readonly v2: string; readonly fields: readonly string[] }[] = Object.freeze([
  { v2: 'Accepted intent hash and all blocking ADRs', fields: ['intentHash', 'gates'] },
  { v2: 'Exact chain/Q/current wrapper verified', fields: ['chainId', 'assets.q', 'evidence'] },
  { v2: 'Source commit, license, dependency and bytecode hashes', fields: ['release.sourceCommit', 'release.licenseReport', 'evidence.expectedCodeHash'] },
  { v2: 'Actual pre/post-graduation external routes', fields: ['release.externalRoutes'] },
  { v2: 'Final fee-incidence and ownership table', fields: ['release.feeIncidenceTable', 'policies.fee'] },
  { v2: 'Real collection mint/graduation gas and events', fields: ['release.mintGasReport'] },
  { v2: 'All role/upgrade/custody powers', fields: ['release.permissionGraph', 'policies.vault.privileges'] },
  { v2: 'Independent security review scope and resolved findings', fields: ['release.securityReview'] },
  { v2: 'Recovery/incident runbook and minimal UI', fields: ['release.recoveryRunbook'] },
  { v2: 'Explicit human deployment authorization', fields: ['authorization'] },
]);

// --- Live guards (total: zod runs them after continuable format issues) -------------------------------------------

type Path = (string | number)[];
type Add = (path: Path, message: string) => void;

const lower = (value: unknown): string | null => (isAddress(value) ? value.toLowerCase() : null);
const safely = <T>(parse: () => T): T | null => {
  try {
    return parse();
  } catch {
    return null;
  }
};

/** Any `mock:` string anywhere in a live manifest is a mock leak. */
function mockLeaks(value: unknown, path: Path, add: Add): void {
  if (typeof value === 'string') {
    if (value.startsWith('mock:')) add(path, `mock data (${value.slice(0, 40)}) can never be part of a live manifest`);
    return;
  }
  if (Array.isArray(value)) value.forEach((item, index) => mockLeaks(item, [...path, index], add));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) mockLeaks(item, [...path, key], add);
}

function chainIssues(m: LiveShape, add: Add): void {
  if (m.chainId === CORE_CHAIN_IDS.localDemo) add(['chainId'], 'the demo chain 31337 is never live');
  if (m.environment === 'testnet' && !LIVE_TESTNET_CHAIN_IDS.includes(m.chainId)) add(['chainId'], `a testnet record must be on ${LIVE_TESTNET_CHAIN_IDS.join(', ')}`);
  if (m.environment === 'production' && m.chainId !== PRODUCTION_CHAIN_ID) add(['chainId'], 'production is Ethereum mainnet (chain 1; F02, ADR-0002)');
  if (m.environment === 'testnet' && m.liveReady) add(['liveReady'], 'a testnet record is never live-ready');
  if (m.environment === 'production' && !m.liveReady) add(['liveReady'], 'a production record exists only as a live-ready release');
  if (/^0x0{64}$/.test(m.intentHash)) add(['intentHash'], 'the intent hash cannot be zero');
}

/** Checks FIT, Q and the collection against the contracts and chain; returns the parsed Q for the evidence check. */
function assetIssues(m: LiveShape, add: Add): ParsedAssetId | null {
  const fit = safely(() => parseAssetId(m.assets.fit.assetId));
  const q = safely(() => parseAssetId(m.assets.q.assetId));
  const collection = safely(() => parseCollectionId(m.collection.collectionId));
  if (fit && (fit.kind !== 'erc20' || fit.chainId !== m.chainId || fit.address !== lower(m.contracts.fit))) {
    add(['assets', 'fit', 'assetId'], 'FIT must be the ERC-20 at contracts.fit on this chain');
  }
  if (m.assets.fit.decimals !== 18) add(['assets', 'fit', 'decimals'], 'FIT has 18 decimals');
  if (m.assets.fit.initialSupplyRaw !== GENESIS_FIT_RAW) add(['assets', 'fit', 'initialSupplyRaw'], `FIT is issued once: ${GENESIS_FIT_RAW} raw`);
  if (q && (q.kind === 'mock' || q.chainId !== m.chainId)) add(['assets', 'q', 'assetId'], 'Q must be a real asset on this chain');
  if (q?.kind === 'native' && m.assets.q.decimals !== 18) add(['assets', 'q', 'decimals'], 'native ETH has 18 decimals');
  if (!collection) add(['collection', 'collectionId'], 'must be a CAIP-19 erc721 collection id');
  else if (collection.chainId !== m.chainId || collection.address !== lower(m.contracts.misfits)) {
    add(['collection', 'collectionId'], 'the collection must be contracts.misfits on this chain');
  }
  if (m.collection.count !== MISFITS_COUNT) add(['collection', 'count'], `The Misfits has exactly ${MISFITS_COUNT} (F35)`);
  return q;
}

function evidenceIssues(m: LiveShape, q: ParsedAssetId | null, add: Add): void {
  const needed = new Set<string>();
  for (const [role, value] of Object.entries(m.contracts)) {
    if (value === undefined) continue;
    if (isZeroAddress(value)) add(['contracts', role], 'the zero address is not a contract');
    else if (lower(value)) needed.add(value.toLowerCase());
  }
  if (q?.kind === 'erc20') needed.add(q.address);
  const seen = new Set<string>();
  const production = m.environment === 'production';
  m.evidence.forEach((entry, index) => {
    const address = entry.address.toLowerCase();
    if (seen.has(address)) add(['evidence', index, 'address'], 'duplicate evidence for this address');
    seen.add(address);
    if (!needed.has(address)) add(['evidence', index, 'address'], 'evidence for an address the manifest does not use');
    if (entry.chainId !== m.chainId) add(['evidence', index, 'chainId'], 'evidence must come from the manifest chain');
    if (entry.codeHash.toLowerCase() === EMPTY_CODE_HASH || /^0x0{64}$/.test(entry.codeHash)) add(['evidence', index, 'codeHash'], 'no contract code at this address');
    if (entry.expectedCodeHash !== null && entry.expectedCodeHash.toLowerCase() !== entry.codeHash.toLowerCase()) {
      add(['evidence', index, 'expectedCodeHash'], 'the code on chain differs from the reviewed build');
    }
    if (production && entry.finality !== 'finalized') add(['evidence', index, 'finality'], 'production evidence must be finalized');
    if (production && entry.expectedCodeHash === null) add(['evidence', index, 'expectedCodeHash'], 'production evidence must match the reviewed bytecode');
  });
  for (const address of needed) if (!seen.has(address)) add(['evidence'], `no chain evidence for ${address}`);
}

function gateIssues(m: LiveShape, add: Add): void {
  for (const id of CORE_GATE_IDS) {
    const count = m.gates.filter((gate) => gate.id === id).length;
    if (count === 0) add(['gates'], `missing ${id}`);
    if (count > 1) add(['gates'], `${id} is listed ${count} times`);
  }
}

function liveReadyIssues(m: LiveShape, add: Add): void {
  if (!m.liveReady) return;
  m.gates.forEach((gate, index) => {
    if (gate.status !== 'CLOSED') {
      const kind = coreGate(gate.id).moneyMoving ? 'a money-moving gate' : 'a release gate';
      add(['gates', index], `${gate.id} is ${gate.status}: ${kind}; live-ready needs every gate closed by an accepted ADR (GOV-02)`);
    }
  });
  for (const key of ['fee', 'quote', 'vault'] as const) {
    const policy = m.policies[key];
    if (policy.status !== 'approved') add(['policies', key], `the ${key} policy is ${policy.status}, not approved`);
    for (const field of unresolvedPolicyFields(policy)) add(['policies', key, ...field.split('.')], 'still UNRESOLVED');
  }
  for (const [key, value] of Object.entries(m.release)) if (value === null) add(['release', key], 'required release evidence is missing');
  if (m.authorization === null) add(['authorization'], 'explicit human deployment authorization is missing');
}

const liveSchema = liveShape
  .superRefine((manifest, ctx) => {
    const issues: GuardIssue[] = [];
    const add: Add = (path, message) => {
      issues.push({ path, message });
    };
    mockLeaks(manifest, [], add);
    chainIssues(manifest, add);
    evidenceIssues(manifest, assetIssues(manifest, add), add);
    gateIssues(manifest, add);
    liveReadyIssues(manifest, add);
    reportIssues(ctx, issues);
  })
  .transform((manifest) => manifest as LiveDeploymentManifest);

export const parseLiveManifest = (input: unknown): LiveDeploymentManifest => parseWith(liveSchema, input, 'live deployment manifest');
export const safeParseLiveManifest = (input: unknown): SafeParseResult<LiveDeploymentManifest> => safeParseWith(liveSchema, input);

// --- Live-ready ---------------------------------------------------------------------------------------------------

/**
 * Why a live manifest is not live-ready (empty = live-ready). The record is parsed again first: the type is
 * structural, so an object that never went through `parseLiveManifest`, or was edited after it, must not reach the
 * live-ready brand without the schema's rules (mock leaks, release evidence, UNRESOLVED fields, finalized and reviewed
 * evidence).
 */
export function liveReadyBlockers(manifest: LiveDeploymentManifest): string[] {
  const blockers: string[] = [];
  const reparsed = safeParseLiveManifest(manifest);
  if (!reparsed.ok) blockers.push(...reparsed.issues.map((issue) => `invalid live manifest at ${issue.path || '(root)'}: ${issue.message}`));
  if (manifest.environment !== 'production') blockers.push(`environment is ${manifest.environment}`);
  if (!manifest.liveReady) blockers.push('liveReady is false');
  const open: GateId[] = manifest.gates.filter((gate) => gate.status !== 'CLOSED').map((gate) => gate.id);
  if (open.length > 0) blockers.push(`gates not closed: ${open.join(', ')}`);
  for (const key of ['fee', 'quote', 'vault'] as const) {
    if (manifest.policies[key].status !== 'approved') blockers.push(`${key} policy is ${manifest.policies[key].status}`);
  }
  if (manifest.authorization === null) blockers.push('no human authorization');
  return blockers;
}

export function isLiveReady(manifest: LiveDeploymentManifest): manifest is LiveReadyManifest {
  return liveReadyBlockers(manifest).length === 0;
}

/** The only way to a `LiveReadyManifest`. Throws `CoreModelError('not_live')` naming every blocker. */
export function requireLiveReady(manifest: LiveDeploymentManifest): LiveReadyManifest {
  const blockers = liveReadyBlockers(manifest);
  if (blockers.length > 0) throw new CoreModelError('not_live', `Not live-ready: ${blockers.join('; ')}`);
  return manifest as LiveReadyManifest;
}

// --- Either kind --------------------------------------------------------------------------------------------------

export type CoreManifest = { readonly kind: 'mock'; readonly manifest: MockIntentManifest } | { readonly kind: 'live'; readonly manifest: LiveDeploymentManifest };

/**
 * Classifies by the one field each kind has (`schemaVersion` for an intent, `schema` for a live record) and parses
 * strictly. A document with both, neither, or a field of the other kind is rejected.
 */
export function parseCoreManifest(input: unknown): CoreManifest {
  const reject = (message: string): never => {
    throw new DataValidationError('core manifest', [{ path: '', message }]);
  };
  if (!isRecord(input)) return reject('expected an object');
  const intent = 'schemaVersion' in input;
  const live = 'schema' in input;
  if (intent === live) return reject('a manifest is either a mock intent (schemaVersion) or a live record (schema), never both or neither');
  return intent ? { kind: 'mock', manifest: parseMockIntent(input) } : { kind: 'live', manifest: parseLiveManifest(input) };
}
