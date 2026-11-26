/**
 * createLaunch writer (01-PRODUCT creation; ADR-0011 §4–§5). From the wizard's validated draft to one
 * `SquareHoleLauncher.createLaunch` call:
 * - Q is the draft's exact quote address; the template is the registry's newest active template for that address
 *   (`latestTemplateFor`), and it must be a template of the reviewed deployment manifest with identical fields.
 * - N and r follow F08 (r = 10^k, N × r ≤ 10^9) AND the template's real bound N ≤ `maxCollectionUnits(version)`
 *   (10,000 on the current templates; ADR-0011 §4), read from the chain, never assumed.
 * - No first buy, no value, no creator allocation: the launcher is not payable.
 * After the receipt, `PairCreated` is decoded and, at finality, the registry record is re-read at that block and
 * compared field by field with what was requested (name and symbol from the token itself: `PairCreated` does not
 * carry them). Only then is the launch a success.
 */
import {
  LAUNCH_TEXT_RULES,
  MAX_COLLECTION_FRACTIONS,
  formatTokenAmount,
  fractionsPerNftFromUnitRaw,
  isFractionTier,
  isRawAmount,
  textIssue,
  type Address,
  type LaunchDraft,
} from '@squarehole/domain';
import type { Hex } from 'viem';
import { squareHoleFungibleTokenAbi as launchTokenAbi } from '../abi/squareHoleFungibleToken';
import { squareHoleRegistryAbi as registryAbi } from '../abi/squareHoleRegistry';
import { createLaunchCall, type LaunchParams } from './calls';
import { templateForQuote, testnetMockDisclosure, type WriteDeployment, type WriteTemplate } from './deployment';
import { PrepareRefusal, type PreparedWrite, type VerifyOutcome, type WriteDetail } from './prepared';
import { appPairId, checkDeploymentWiring, eventsFrom, readContract, readRegistryPair, readRegistryTemplate, registryPairId, type RegistryPair } from './registry-reads';
import type { ChainReader, TxReceipt } from './rpc';

export interface CreateLaunchInput {
  readonly kind: 'token' | 'nft_collection';
  readonly name: string;
  readonly symbol: string;
  /** nft_collection: N whole NFTs; token: whole-token supply (1 … 10^9). */
  readonly units: bigint;
  /** nft_collection: r = 10^k (k = 0…9); token: 1. */
  readonly fractionsPerNft: bigint;
  /** Exact Q address (from the asset registry entry the wizard chose; never a symbol). */
  readonly quote: Address;
  readonly rewardSide: 'T' | 'Q';
  /** Collection metadata base URI; immutable. Empty unless the creator hosts metadata. */
  readonly baseURI: string;
  /** keccak-256 of the canonical metadata manifest (computed in the browser by the wizard). */
  readonly metadataManifestHash: Hex;
}

/** Launcher byte limits (SquareHoleLauncher.MAX_NAME_BYTES / MAX_SYMBOL_BYTES / MAX_BASE_URI_BYTES). */
export const LAUNCHER_LIMITS = Object.freeze({ nameBytes: 64, symbolBytes: 32, baseURIBytes: 512 });
export const MAX_WHOLE_SUPPLY = 1_000_000_000n;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Problems with an input before anything is read from the chain (the template bound is checked in `prepare`). */
export function createLaunchInputIssues(input: CreateLaunchInput): string[] {
  const issues: string[] = [];
  const name = textIssue(input.name, LAUNCH_TEXT_RULES.name);
  const symbol = textIssue(input.symbol, LAUNCH_TEXT_RULES.symbol);
  if (name) issues.push(`name ${name}`);
  if (symbol) issues.push(`symbol ${symbol}`);
  if (utf8Bytes(input.name) > LAUNCHER_LIMITS.nameBytes) issues.push(`name must be at most ${LAUNCHER_LIMITS.nameBytes} bytes (UTF-8)`);
  if (utf8Bytes(input.symbol) > LAUNCHER_LIMITS.symbolBytes) issues.push(`symbol must be at most ${LAUNCHER_LIMITS.symbolBytes} bytes (UTF-8)`);
  if (utf8Bytes(input.baseURI) > LAUNCHER_LIMITS.baseURIBytes) issues.push(`base URI must be at most ${LAUNCHER_LIMITS.baseURIBytes} bytes`);
  if (!HASH32.test(input.metadataManifestHash)) issues.push('the metadata manifest hash must be 32 bytes');
  if (input.kind === 'token') {
    if (input.fractionsPerNft !== 1n) issues.push('a token launch has no fractions per NFT (r = 1)');
    if (input.baseURI !== '') issues.push('a token launch has no base URI');
    if (input.units < 1n || input.units > MAX_WHOLE_SUPPLY) issues.push('the token supply must be 1 … 1,000,000,000 whole tokens');
  } else {
    if (!isFractionTier(input.fractionsPerNft)) issues.push('fractions per NFT must be a power of ten from 1 to 1,000,000,000');
    if (input.units < 1n) issues.push('a collection has at least one NFT');
    else if (input.units * input.fractionsPerNft > MAX_COLLECTION_FRACTIONS) issues.push('collection size × fractions per NFT must not exceed 1,000,000,000');
  }
  return issues;
}

export interface DraftConversionOptions {
  /** Token drafts carry no supply field: the page states the whole-token supply explicitly (1 … 10^9). */
  readonly tokenWholeSupply?: bigint;
  readonly baseURI?: string;
}

/**
 * The launcher input for a wizard draft (`LaunchDraft`, validated by the domain validator). Throws
 * `PrepareRefusal('invalid_input')` when a field the launcher needs is missing or out of bounds.
 */
export function createLaunchInputFromDraft(draft: LaunchDraft, options: DraftConversionOptions = {}): CreateLaunchInput {
  if (draft.metadataManifestHash === null) throw new PrepareRefusal('invalid_input', 'the draft has no metadata manifest hash');
  let units: bigint;
  let fractionsPerNft: bigint;
  if (draft.assetType === 'nft_collection') {
    const r = fractionsPerNftFromUnitRaw(draft.nftUnitRaw);
    if (r === null) throw new PrepareRefusal('invalid_input', 'the draft’s NFT unit is not a fraction tier');
    if (!isRawAmount(draft.collectionSize)) throw new PrepareRefusal('invalid_input', 'the draft has no collection size');
    units = BigInt(draft.collectionSize);
    fractionsPerNft = r;
  } else {
    if (options.tokenWholeSupply === undefined) throw new PrepareRefusal('invalid_input', 'a token launch needs an explicit whole-token supply');
    units = options.tokenWholeSupply;
    fractionsPerNft = 1n;
  }
  const input: CreateLaunchInput = Object.freeze({
    kind: draft.assetType,
    name: draft.name,
    symbol: draft.symbol,
    units,
    fractionsPerNft,
    quote: draft.quoteAddress,
    rewardSide: draft.rewardSide,
    baseURI: options.baseURI ?? '',
    metadataManifestHash: draft.metadataManifestHash,
  });
  const issues = createLaunchInputIssues(input);
  if (issues.length > 0) throw new PrepareRefusal('invalid_input', issues.join('; '));
  return input;
}

export interface LaunchTemplateBounds {
  readonly template: WriteTemplate;
  /** N bound read from the registry (`maxCollectionUnits`), equal to the manifest's. */
  readonly maxCollectionUnits: bigint;
  /** NFTs the template's reference buy delivers at most (registry REFERENCE_BUY_NFTS). */
  readonly referenceBuyNfts: bigint;
}

/**
 * The template a launch on `quote` uses, with its real N bound, read from the registry and cross-checked with the
 * manifest. The wizard shows `maxCollectionUnits` as the collection-size limit.
 */
export async function readLaunchTemplateBounds(reader: ChainReader, deployment: WriteDeployment, quote: Address): Promise<LaunchTemplateBounds> {
  const version = Number(await readContract<number>(reader, deployment.registry, registryAbi, 'latestTemplateFor', [quote]));
  if (version === 0) throw new PrepareRefusal('template_unknown', `the registry has no active launch template for quote ${quote}`);
  const onChain = await readRegistryTemplate(reader, deployment, version);
  if (onChain === null || !onChain.active || onChain.quote.toLowerCase() !== quote.toLowerCase()) {
    throw new PrepareRefusal('template_unknown', `launch template ${version} is not an active template for ${quote}`);
  }
  const manifest = deployment.templates.find((t) => t.version === version) ?? null;
  const expected = templateForQuote(deployment, quote);
  if (
    manifest === null ||
    expected === null ||
    expected.version !== version ||
    manifest.startFdvQ !== onChain.startFdvQ ||
    manifest.minStartUnitValueQ !== onChain.minStartUnitValueQ ||
    manifest.tickSpacing !== onChain.tickSpacing ||
    manifest.rangeTicks !== onChain.rangeTicks
  ) {
    throw new PrepareRefusal('template_not_in_manifest', `launch template ${version} does not match the reviewed deployment manifest`);
  }
  const [maxUnits, referenceBuyNfts] = await Promise.all([
    readContract<bigint>(reader, deployment.registry, registryAbi, 'maxCollectionUnits', [version]),
    readContract<bigint>(reader, deployment.registry, registryAbi, 'REFERENCE_BUY_NFTS'),
  ]);
  if (maxUnits !== manifest.maxCollectionUnits) throw new PrepareRefusal('template_not_in_manifest', `template ${version}: the registry’s N bound differs from the manifest`);
  return Object.freeze({ template: manifest, maxCollectionUnits: maxUnits, referenceBuyNfts });
}

/** The verified outcome of a finalized launch (the app's success content). */
export interface VerifiedLaunch {
  readonly pairId: Hex;
  readonly appPairId: `${number}:${Address}`;
  readonly token: Address;
  readonly mirror: Address | null;
  readonly ledger: Address;
  readonly collector: Address;
  readonly poolId: Hex;
  readonly quote: Address;
  readonly rewardSide: 'T' | 'Q';
  readonly templateVersion: number;
  readonly name: string;
  readonly symbol: string;
  readonly createdAtBlock: bigint;
}

export interface PrepareContext {
  readonly reader: ChainReader;
  readonly deployment: WriteDeployment;
  readonly account: Address;
}

export async function prepareCreateLaunch(ctx: PrepareContext, input: CreateLaunchInput): Promise<PreparedWrite<VerifiedLaunch>> {
  const issues = createLaunchInputIssues(input);
  if (issues.length > 0) throw new PrepareRefusal('invalid_input', issues.join('; '));
  const { reader, deployment, account } = ctx;
  await checkDeploymentWiring(reader, deployment);
  if (input.rewardSide === 'T' && deployment.converter === null) throw new PrepareRefusal('wrong_payout_side', 'this deployment has no claim converter, so it cannot launch pairs that pay in T');
  const bounds = await readLaunchTemplateBounds(reader, deployment, input.quote);
  if (input.kind === 'nft_collection' && input.units > bounds.maxCollectionUnits) {
    throw new PrepareRefusal('bounds', `this template allows at most ${bounds.maxCollectionUnits} NFTs per collection (ADR-0011 §4); the draft has ${input.units}`);
  }
  const params: LaunchParams = {
    kind: input.kind === 'nft_collection' ? 1 : 0,
    name: input.name,
    symbol: input.symbol,
    units: input.units,
    fractionsPerNft: input.fractionsPerNft,
    templateVersion: bounds.template.version,
    payoutAsset: input.rewardSide === 'T' ? 1 : 0,
    baseURI: input.baseURI,
    metadataManifestHash: input.metadataManifestHash,
  };
  const call = createLaunchCall(deployment, params);
  const supply = input.units * input.fractionsPerNft * 10n ** 18n;
  const details: WriteDetail[] = [
    { label: 'Contract', value: `SquareHoleLauncher ${deployment.launcher} · createLaunch` },
    { label: 'Quote asset (Q)', value: `${input.quote} (launch template ${bounds.template.version}, “${bounds.template.label}”)` },
    { label: 'Supply', value: `${formatTokenAmount(supply, 18)} ${input.symbol} (${supply} raw)` },
    { label: 'Collection bound', value: input.kind === 'nft_collection' ? `${input.units} of at most ${bounds.maxCollectionUnits} NFTs on this template` : 'not a collection' },
    { label: 'Holder fee share paid in (R)', value: input.rewardSide },
    { label: 'Purchase at creation', value: 'None: creation makes no purchase and sends no value' },
  ];
  const mock = testnetMockDisclosure(deployment, input.quote);
  if (mock !== null) details.push({ label: 'Testnet mock quote', value: mock });
  return Object.freeze({
    call,
    expectedLedger: null,
    details: Object.freeze(details.map((d) => Object.freeze(d))),
    verify: (receipt: TxReceipt, verifyReader: ChainReader, stage: 'included' | 'finalized') =>
      verifyLaunch(receipt, verifyReader, stage, deployment, account, input, bounds.template.version),
  });
}

async function verifyLaunch(
  receipt: TxReceipt,
  reader: ChainReader,
  stage: 'included' | 'finalized',
  deployment: WriteDeployment,
  account: Address,
  input: CreateLaunchInput,
  templateVersion: number,
): Promise<VerifyOutcome<VerifiedLaunch>> {
  const events = eventsFrom<{ pairId: Hex; token: Address; quote: Address; record: RegistryPair }>(receipt.logs, deployment.registry, registryAbi, 'PairCreated');
  if (events.length !== 1) return { ok: false, reason: `expected one PairCreated from the registry, found ${events.length}` };
  const event = events[0] as { pairId: Hex; token: Address; quote: Address; record: RegistryPair };
  const record = event.record;
  const mismatch = launchRecordMismatch(record, deployment, account, input, templateVersion);
  if (mismatch) return { ok: false, reason: `PairCreated does not match the request: ${mismatch}` };
  if (event.pairId !== record.pairId || event.token.toLowerCase() !== record.token.toLowerCase()) return { ok: false, reason: 'PairCreated topics differ from its record' };

  // The registry record at the receipt's block, field by field (the event is what the transaction said; the registry
  // is what the chain keeps).
  const stored = await readRegistryPair(reader, deployment, record.pairId, receipt.blockNumber);
  if (stored === null) return { ok: false, reason: 'the registry has no record for the new pair at the receipt block' };
  const differing = (Object.keys(record) as (keyof RegistryPair)[]).filter((key) => String(stored[key]).toLowerCase() !== String(record[key]).toLowerCase());
  if (differing.length > 0) return { ok: false, reason: `the registry record differs from PairCreated in ${differing.join(', ')}` };

  let name: string;
  let symbol: string;
  if (stage === 'finalized') {
    [name, symbol] = await Promise.all([
      readContract<string>(reader, record.token, launchTokenAbi, 'name', [], receipt.blockNumber),
      readContract<string>(reader, record.token, launchTokenAbi, 'symbol', [], receipt.blockNumber),
    ]);
    if (name !== input.name || symbol !== input.symbol) return { ok: false, reason: 'the new token’s name or symbol differs from the request' };
  } else {
    name = input.name;
    symbol = input.symbol;
  }
  return {
    ok: true,
    result: Object.freeze({
      pairId: record.pairId,
      appPairId: appPairId(deployment.chainId, record.token),
      token: record.token,
      mirror: record.kind === 1 ? record.mirror : null,
      ledger: record.ledger,
      collector: record.collector,
      poolId: record.poolId,
      quote: record.quote,
      rewardSide: record.rewardSide === 1 ? 'T' : 'Q',
      templateVersion: record.templateVersion,
      name,
      symbol,
      createdAtBlock: record.createdAtBlock,
    }),
  };
}

/** The first field of a launch record that differs from the request (null when every checked field matches). */
export function launchRecordMismatch(record: RegistryPair, deployment: WriteDeployment, account: Address, input: CreateLaunchInput, templateVersion: number): string | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const zero = '0x0000000000000000000000000000000000000000';
  const expectedConverter = input.rewardSide === 'T' ? (deployment.converter ?? zero) : zero;
  const checks: [string, boolean][] = [
    ['chainId', record.chainId === BigInt(deployment.chainId)],
    ['pairId', same(record.pairId, registryPairId(deployment.chainId, record.token))],
    ['kind', record.kind === (input.kind === 'nft_collection' ? 1 : 0)],
    ['mirror', input.kind === 'nft_collection' ? !same(record.mirror, zero) : same(record.mirror, zero)],
    ['quote', same(record.quote, input.quote)],
    ['hook', same(record.hook, deployment.hook)],
    ['rewardSide', record.rewardSide === (input.rewardSide === 'T' ? 1 : 0)],
    ['converter', same(record.converter, expectedConverter)],
    ['fractionsPerNft', record.fractionsPerNft === input.fractionsPerNft],
    ['units', record.units === input.units],
    ['initialSupply', record.initialSupply === input.units * input.fractionsPerNft * 10n ** 18n],
    ['templateVersion', record.templateVersion === templateVersion],
    ['metadataManifestHash', same(record.metadataManifestHash, input.metadataManifestHash)],
    ['creator', same(record.creator, account)],
  ];
  return checks.find(([, ok]) => !ok)?.[0] ?? null;
}
