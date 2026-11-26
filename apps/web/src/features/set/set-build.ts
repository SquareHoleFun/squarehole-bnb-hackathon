/**
 * SH-EXISTING-NFTS-E08C: where the existing-NFTs add-on lives in this build, and whether the site may show it.
 *
 * The add-on is local only until its release ticket (E-09). A development build that names SH_SET_LOCAL_MANIFEST
 * carries the add-on's own manifest (`SET_LOCAL_MANIFEST`, deployments-plugin.ts); it is parsed here against the build's
 * local core manifest (`parseSetManifest`, E-08A: never a v1 or v2.1 registry, never inserted into the core releases),
 * and the add-on shows only once its factory answers `versionCodeHash`, `RELEASE` and `TEMPLATE` as pinned, read at one
 * block over the source's RPC (`checkSetFactoryIdentity`, design § 4.10). A refused or unreadable check shows nothing
 * of the add-on (checks stay silent: no label says anything was checked). The production site carries none of this:
 * every branch below folds away there (`SET_BUILD`).
 *
 * Nothing here touches a wallet; the identity reads are view calls.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPublicClient, http } from 'viem';
import { parseCoreManifest } from '@squarehole/chain';
import { checkSetFactoryIdentity, parseSetManifest, type SetCoreManifest, type SetReleaseManifest } from '@squarehole/chain/core/set-v2';
import { SET_LOCAL_MANIFEST } from 'virtual:squarehole-deployments';
import { parseCoreManifestV2 } from '../../../../../packages/chain/src/core/v2';
import { setInputsFor, type CoreBuild } from '../core/core-build';
import { DeadlineError } from '../core/deadline';
import { BUILD_CORE } from '../core/useCore';
import { useDataSource, type DataSourceId } from '../data-source';

/** The add-on in this build: false on the production site, where every branch of it folds away (src/build-mode.ts). */
export const SET_BUILD = !import.meta.env?.SH_PRODUCTION;

/** The build's core manifests with the add-on's local manifest beside them (the production site: none). */
export const BUILD_SET: CoreBuild = SET_BUILD ? Object.freeze({ ...BUILD_CORE, set: SET_LOCAL_MANIFEST }) : BUILD_CORE;

/** The add-on on a source: its parsed manifest, the core manifest it binds to, and the source's RPC, indexer and art. */
export interface SetSource {
  readonly network: 'local';
  readonly chainId: number;
  readonly core: SetCoreManifest;
  readonly release: SetReleaseManifest;
  readonly rpc: string;
  /** The indexer gateway whose `/v2/sets/*` routes serve the add-on's boxes (E-08B); null: the boxes cannot be listed. */
  readonly origin: string | null;
  /** Our own IPFS gateways for this source (CORE_ART_GATEWAYS): the only way an `ipfs://` picture is fetched. */
  readonly art: readonly string[];
}

export type SetSourceResolution =
  | { readonly status: 'ready'; readonly source: SetSource }
  | { readonly status: 'none' | 'invalid'; readonly reason: string };

const NONE: SetSourceResolution = /* @__PURE__ */ Object.freeze({ status: 'none', reason: 'No existing-NFTs add-on on this source.' });

function parseCore(input: unknown): SetCoreManifest {
  if (typeof input === 'object' && input !== null && 'releases' in input) return parseCoreManifestV2(input);
  const core = parseCoreManifest(input);
  if (core.status !== 'deployed') throw new Error('The local core manifest is not deployed.');
  return core;
}

/** The add-on on a data source, parsed (never read on chain). Never throws: an invalid manifest says why. */
export function setSourceOf(id: DataSourceId, build: CoreBuild): SetSourceResolution {
  if (!SET_BUILD) return NONE;
  const inputs = setInputsFor(id, build);
  if (inputs === null) return NONE;
  try {
    const release = parseSetManifest(inputs.set, inputs.core);
    const core = parseCore(inputs.core);
    if (!build.localRpcUrl) return { status: 'invalid', reason: 'No local RPC in this build.' };
    return { status: 'ready', source: Object.freeze({ network: 'local', chainId: release.chainId, core, release, rpc: build.localRpcUrl, origin: build.indexers.local, art: build.artGateways?.local ?? [] }) };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * How the factory's identity is checked: the RPC's chain first, then the three reads at one block, every request with
 * the check's `signal`. Tests replace it.
 */
export type FactoryCheck = (source: SetSource, signal: AbortSignal) => Promise<void>;

export const rpcFactoryCheck: FactoryCheck = async (source, signal) => {
  // XR2-ITEM-3D-V2 F1: the check's signal reaches every request through the transport, headers and body. viem's own
  // timeout ends once the headers came (viem 2.56.8 utils/rpc/http.js: the body is read after it), so a body that
  // never ends held the check open for good; this signal ends it, and the reads still in flight when the check ends.
  const client = createPublicClient({ transport: http(source.rpc, { retryCount: 0, fetchOptions: { signal } }), ccipRead: false });
  if (await client.getChainId() !== source.chainId) throw new Error('The RPC serves another chain.');
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  await checkSetFactoryIdentity(source.release, ({ address, abi, functionName }) => client.readContract({ address, abi, functionName, blockNumber }));
};

type Check = { readonly status: 'checking' } | { readonly status: 'ready' } | { readonly status: 'refused'; readonly reason: string; readonly at: number; readonly source: SetSource };
/** A refused or unreadable check is asked again after this long (an RPC that was down comes back). */
const RETRY_MS = 30_000;
const checks = new Map<string, Check>();
const listeners = new Set<() => void>();
let checker: FactoryCheck = rpcFactoryCheck;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const keyOf = (source: SetSource) => `${source.chainId}:${source.rpc}:${source.release.factory.address}:${source.release.versionCodeHash}`;

/** XR2-ITEM-3D-V2 F1: a factory check that has not ended within this long is refused, and its requests are aborted. */
export const FACTORY_CHECK_DEADLINE_MS = 8_000;

/**
 * One whole check, bounded: its requests share one signal, aborted at the deadline and as soon as the check fails, so
 * nothing of a finished check stays in flight (checkSetFactoryIdentity reads the three pins at once: one that does not
 * match used to leave the other two reading). It ends by the deadline even when a checker ignores its signal.
 */
function boundedCheck(source: SetSource): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError(FACTORY_CHECK_DEADLINE_MS)), FACTORY_CHECK_DEADLINE_MS);
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const check = new Promise<void>((resolve) => resolve(checker(source, controller.signal)));
  return Promise.race([check, stopped]).then(
    () => clearTimeout(timer),
    (error: unknown) => {
      clearTimeout(timer);
      // The reads still in flight stop before the check can be asked again.
      controller.abort(error);
      throw error;
    },
  );
}

/** Checks the source's factory unless that is done or under way; a refused check again after RETRY_MS, or `now`. */
function ensureChecked(source: SetSource, now = false): void {
  const key = keyOf(source);
  const known = checks.get(key);
  if (known && (known.status !== 'refused' || (!now && Date.now() - known.at < RETRY_MS))) return;
  // This check's own entry: an end that finds another one there (a later check, or a reset) changes nothing.
  const running: Check = { status: 'checking' };
  checks.set(key, running);
  notify();
  const settle = (next: Check) => {
    if (checks.get(key) !== running) return;
    checks.set(key, next);
    notify();
  };
  boundedCheck(source).then(
    () => settle({ status: 'ready' }),
    (error: unknown) => settle({ status: 'refused', reason: error instanceof Error ? error.message : 'The factory could not be read.', at: Date.now(), source }),
  );
}

/**
 * Every refused check, asked again now; a check that passed or is under way is left as it is, so two checks of one
 * factory never run at once (a refused one has nothing in flight: boundedCheck).
 */
function recheckRefused(): void {
  const refused = [...checks.values()].filter((check) => check.status === 'refused');
  for (const check of refused) ensureChecked(check.source, true);
}

/**
 * XR-ITEM-3D-V2 F2: the box page's Retry checks a refused factory again at once (with the feeds that never answered,
 * useBoxSources.ts), so a check that could not be read (an RPC that timed out) is not left until RETRY_MS. Nothing on
 * the production site, which has no add-on.
 */
export const recheckSetFactories: () => void = SET_BUILD ? recheckRefused : () => undefined;

/** Test seam: forget every check and check with `next` (default: the RPC). */
export function resetSetChecksForTests(next: FactoryCheck = rpcFactoryCheck): void {
  checks.clear();
  checker = next;
  notify();
}

export type SetSourceState =
  | { readonly status: 'ready'; readonly source: SetSource }
  | { readonly status: 'none' | 'invalid' | 'checking' | 'refused'; readonly source: null; readonly reason: string | null };

const NO_SET: SetSourceState = /* @__PURE__ */ Object.freeze({ status: 'none', source: null, reason: null });

/**
 * The add-on on the current data source, shown only once its factory's identity checked out (`ready`). `checking` while
 * the three reads run; `refused` when they did not match or could not be read; `none` or `invalid` without a manifest.
 * The production site's is a constant `none` (chosen once per build, so the hooks' order never changes), and nothing
 * of the check ships there. A refused add-on is still this source's (XR-ITEM-3D-V2 F2): its boxes are unread, so a box
 * link missing from the other feeds says it could not be read (useSetFeed.ts), never that it is not there.
 */
export const useSetSource: (build?: CoreBuild) => SetSourceState = SET_BUILD ? useCheckedSetSource : () => NO_SET;

function useCheckedSetSource(build: CoreBuild = BUILD_SET): SetSourceState {
  const data = useDataSource();
  const resolved = useMemo(() => setSourceOf(data.id, build), [data.id, build]);
  const source = resolved.status === 'ready' ? resolved.source : null;
  const key = source ? keyOf(source) : null;
  useEffect(() => {
    if (source) ensureChecked(source);
  }, [source]);
  const check = useSyncExternalStore(subscribe, () => (key === null ? null : checks.get(key) ?? null), () => null);
  if (resolved.status !== 'ready') return { status: resolved.status, source: null, reason: resolved.reason };
  if (check === null || check.status === 'checking') return { status: 'checking', source: null, reason: null };
  if (check.status === 'refused') return { status: 'refused', source: null, reason: check.reason };
  return { status: 'ready', source: resolved.source };
}
