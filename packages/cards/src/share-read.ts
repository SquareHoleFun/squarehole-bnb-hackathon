/**
 * A chain box's card facts (`ShareBox`), read the way the site reads it (S10a § 5, C19): the indexer gateway's snapshot
 * (`/v1/boxes/<chain>/<token>`, checked by the same parsers as the site), and when the gateway does not answer, the
 * registry row read straight from the chain through a keyless public RPC (share-direct.ts). Only the registries of the
 * given core manifest count (today Sepolia's is `awaiting-broadcast`: every Sepolia box is then unknown, as the site
 * says "Core v1 is not on Sepolia yet").
 *
 * Shared by the Pages function (the tags of a box page; apps/web/src/share/share-data.ts adds the Demo boxes) and the
 * card service (service/card-service.ts), so the page and its picture name the same state. The caller checks the
 * chain id and the token (both from a URL) before anything here runs.
 */
import { coreDeploymentState, coreVersion1, type BoxRow, type DeployedCoreManifest } from '@squarehole/chain';
import { parseItemView, type CoreItemView, parseBoxView, type CorePhase } from '@squarehole/indexer/client';
import type { ShareBox, ShareState } from './share-model';

/** A block's number and time (Unix seconds): what an open block's estimated time is counted from. */
export interface BlockTime {
  readonly block: bigint;
  readonly timestamp: bigint;
}

/** Seconds per Sepolia block, for an open block's estimated time (the row's openAt replaces it once it lands). */
export const BLOCK_SECONDS = 12n;

/**
 * The row's opening: a clock time (`openAt`, Unix seconds) on rows that carry one (the openAt contracts), else its open
 * block, estimated from a known block's time and marked approximate. Typed by the two fields alone so it reads both row
 * shapes.
 */
export function openingOf(row: { readonly openAt?: bigint; readonly openBlock?: bigint }, at: BlockTime | null): { readonly opensAt: number; readonly approx: boolean } | null {
  if (row.openAt !== undefined) return { opensAt: Number(row.openAt), approx: false };
  if (row.openBlock === undefined || at === null) return null;
  const ahead = row.openBlock > at.block ? row.openBlock - at.block : 0n;
  return { opensAt: Number(at.timestamp + ahead * BLOCK_SECONDS), approx: true };
}

export function stateOfPhase(phase: CorePhase, opening: ReturnType<typeof openingOf>): ShareState {
  switch (phase) {
    case 'upcoming':
      return { kind: 'upcoming', opensAt: opening?.opensAt ?? null, approx: opening?.approx ?? false };
    case 'window':
    case 'bonding':
      return { kind: 'open' };
    case 'graduating':
      return { kind: 'graduating' };
    case 'graduated':
      return { kind: 'graduated' };
  }
}

const ZERO32 = `0x${'0'.repeat(64)}`;

/** A chain box's card facts from its row: the name rule of the site (spec-record.ts: collection name, else token name). */
export function boxOfRow(row: BoxRow, network: 'sepolia' | 'local', phase: CorePhase, at: BlockTime | null): ShareBox {
  const cover = row.spec.coverSha256.toLowerCase();
  const collectionCover = row.spec.collectionCoverSha256.toLowerCase();
  return {
    chainId: row.chainId,
    token: (row.contracts.token as string).toLowerCase() as `0x${string}`,
    chainLabel: network === 'local' ? 'Local chain' : 'Sepolia',
    name: row.spec.collectionName || row.spec.tokenName,
    ticker: row.spec.tokenSymbol,
    demo: false,
    state: stateOfPhase(phase, openingOf(row, at)),
    logoSha256: cover === ZERO32 ? null : (cover as `0x${string}`),
    collectionCoverSha256: collectionCover === ZERO32 ? null : (collectionCover as `0x${string}`),
  };
}

/** The core deployment a card reads: the manifest for the chain, with where to read it. */
export interface ShareCore {
  readonly network: 'sepolia' | 'local';
  readonly chainId: number;
  readonly manifest: DeployedCoreManifest;
  readonly rpcUrls: readonly string[];
  readonly indexerOrigin: string | null;
}

export interface ShareConfig {
  /** The Sepolia core manifest (`awaiting-broadcast` until the broadcast): the build's, or the server's file. */
  readonly sepoliaManifest: unknown;
  /** Local testing only: a local twin's manifest (network `local`), read instead of Sepolia's for its chain id. */
  readonly localManifest: unknown;
  readonly sepoliaRpcUrls: readonly string[];
  readonly localRpcUrl: string | null;
  readonly indexerOrigin: string | null;
}

/** The core deployment for a chain id, or why there is none (never throws). */
export function shareCoreFor(chainId: number, config: ShareConfig): ShareCore | { readonly reason: string } {
  const local = config.localManifest === null || config.localManifest === undefined ? null : coreDeploymentState(config.localManifest);
  if (local !== null) {
    if (local.status !== 'deployed' || local.manifest.network !== 'local') return { reason: 'the local core manifest is not a deployed local twin' };
    if (local.manifest.chainId === chainId) {
      if (config.localRpcUrl === null) return { reason: 'no local RPC' };
      return { network: 'local', chainId, manifest: local.manifest, rpcUrls: [config.localRpcUrl], indexerOrigin: config.indexerOrigin };
    }
  }
  const sepolia = coreDeploymentState(config.sepoliaManifest);
  if (sepolia.status !== 'deployed') return { reason: sepolia.status === 'awaiting-broadcast' ? 'Core v1 is not on Sepolia yet' : `no core manifest (${sepolia.status})` };
  if (sepolia.manifest.network !== 'sepolia' || sepolia.manifest.chainId !== chainId) return { reason: `no core deployment on chain ${chainId}` };
  return { network: 'sepolia', chainId, manifest: sepolia.manifest, rpcUrls: config.sepoliaRpcUrls, indexerOrigin: config.indexerOrigin };
}

/** Whether the manifest shows a row: its registry is one of the manifest's and its template is one that version shows. */
export function rowShown(core: ShareCore, row: BoxRow): boolean {
  const version = core.manifest.versions.find((v) => v.registry.address.toLowerCase() === row.registry.toLowerCase());
  return version !== undefined && version.supportedTemplates.some((t) => t.toLowerCase() === row.templateId.toLowerCase());
}

export function parseOptionsFor(core: ShareCore) {
  return { chainId: core.chainId, box0Registry: coreVersion1(core.manifest).registry.address as `0x${string}`, registries: core.manifest.versions.map((v) => v.registry.address) };
}

/** A box read from the chain: its row, its phase (the hook's `phase()`) and the block it was read at. */
export interface DirectBox {
  readonly row: BoxRow;
  readonly phase: CorePhase;
  readonly at: BlockTime;
}

export interface ShareReaders {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The chain read without the indexer (null: none, as in a test that wants the indexer only). */
  readonly direct: { box(core: ShareCore, token: `0x${string}`): Promise<DirectBox | null> } | null;
  /** How long the indexer may take before the chain is read instead. */
  readonly indexerTimeoutMs: number;
}

export type ShareLookup =
  | { readonly status: 'box'; readonly box: ShareBox; readonly via: 'demo' | 'indexer' | 'direct' }
  /**
   * A well-formed link this site cannot show a box for: not on the source, not shown, or (`failed`) nothing answered,
   * which may change at the next read.
   */
  | { readonly status: 'unknown'; readonly reason: string; readonly failed?: true }
  /** Not a box link at all (a malformed address or a chain this build does not know). */
  | { readonly status: 'invalid' };

const why = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

/** The indexer's snapshot of one box: the box, `null` for its own 404 ("no shown box with that token"), or throws. */
async function fromIndexer(core: ShareCore, token: `0x${string}`, readers: ShareReaders): Promise<ShareBox | null> {
  const origin = core.indexerOrigin;
  if (origin === null) throw new Error('no indexer');
  const response = await readers.fetch(`${origin}/v1/boxes/${core.chainId}/${token}`, { signal: AbortSignal.timeout(readers.indexerTimeoutMs), headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the indexer answered ${response.status}`);
  const { row, view } = parseBoxView(await response.json(), parseOptionsFor(core));
  if ((row.contracts.token as string).toLowerCase() !== token) throw new Error('the indexer answered for another token');
  if (!rowShown(core, row)) return null;
  return boxOfRow(row, core.network, view.phase, { block: BigInt(view.asOf.block), timestamp: BigInt(view.asOf.timestamp) });
}

/**
 * A chain box by its chain id and lowercase token (both checked by the caller), and what its card says: the indexer
 * first, the chain when the indexer fails. Never throws.
 */
export async function loadCoreBox(chainId: number, token: `0x${string}`, config: ShareConfig, readers: ShareReaders): Promise<ShareLookup> {
  const core = shareCoreFor(chainId, config);
  if ('reason' in core) return { status: 'unknown', reason: core.reason };
  let indexerError: string | null = null;
  if (core.indexerOrigin !== null) {
    try {
      const box = await fromIndexer(core, token, readers);
      return box ? { status: 'box', box, via: 'indexer' } : { status: 'unknown', reason: 'the indexer shows no box with that token' };
    } catch (error) {
      indexerError = why(error);
    }
  }
  if (readers.direct === null) return indexerError === null ? { status: 'unknown', reason: 'no indexer and no chain reader' } : { status: 'unknown', reason: indexerError, failed: true };
  try {
    const found = await readers.direct.box(core, token);
    if (found === null || !rowShown(core, found.row)) return { status: 'unknown', reason: 'no shown box with that token on the chain' };
    return { status: 'box', box: boxOfRow(found.row, core.network, found.phase, found.at), via: 'direct' };
  } catch (error) {
    return { status: 'unknown', reason: `${indexerError ? `${indexerError}; ` : ''}the chain read failed: ${why(error)}`, failed: true };
  }
}


/** Fresh reveal state for a card: no week-long box-facts cache and no unanchored metadata fallback. */
export async function loadCoreItem(chainId: number, token: `0x${string}`, id: string, config: ShareConfig, readers: ShareReaders): Promise<{ box: ShareBox; item: CoreItemView } | null> {
  const core = shareCoreFor(chainId, config);
  if ('reason' in core || !core.indexerOrigin) return null;
  const get = async (suffix: string) => {
    const response = await readers.fetch(`${core.indexerOrigin}/v1/boxes/${chainId}/${token}${suffix}`, { cache: 'no-store', signal: AbortSignal.timeout(readers.indexerTimeoutMs) });
    if (!response.ok) throw new Error('item read unavailable');
    return response.json() as Promise<unknown>;
  };
  try {
    const { row, view } = parseBoxView(await get(''), parseOptionsFor(core));
    if (row.contracts.token?.toLowerCase() !== token || !rowShown(core, row)) return null;
    const item = parseItemView(await get(`/items/${id}`), row);
    if (item.id !== id || !item.revealed) return null;
    return { box: boxOfRow(row, core.network, view.phase, null), item };
  } catch { return null; }
}
