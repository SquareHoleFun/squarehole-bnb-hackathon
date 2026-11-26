import { parseCoreManifestV2, type DeployedCoreManifestV2 } from '../../chain/src/core/v2/manifest-v2';

export type Mode = 'dry-run' | 'live';
export interface Service {
  enabled: boolean;
  mode: Mode;
  allowMainnet: boolean;
}
export interface Config {
  mode: Mode;
  chainId: number;
  rpcUrl: string;
  apiBase: string;
  manifestPath: string;
  cycleMs: number;
  feeBps: bigint;
  stateDir: string;
  healthFile: string;
}
function fail(name: string): never { throw new Error(`invalid ${name}`); }
function positive(value: string | undefined, name: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return fail(name);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fail(name);
  return n;
}
function bit(value: string | undefined, name: string): boolean {
  const flag = value ?? '0';
  if (flag !== '0' && flag !== '1') return fail(name);
  return flag === '1';
}
/** The stack's worker flags (infra/server/services/runtime.mjs): no private env file means disabled; enabled means a
 * dry run (discover, read and quote, never post) unless the mode is exactly `live`; chain 1 needs the mainnet flag. */
export function loadService(env: Record<string, string | undefined>): Service {
  const enabled = bit(env.SH_SERVICE_ENABLED, 'SH_SERVICE_ENABLED');
  const mode = env.SH_SERVICE_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') return fail('SH_SERVICE_MODE');
  return { enabled, mode, allowMainnet: bit(env.SH_SERVICE_ALLOW_MAINNET, 'SH_SERVICE_ALLOW_MAINNET') };
}
/** Durable state and health locations, the only settings a disabled poster reads. */
export function loadPaths(env: Record<string, string | undefined>): { stateDir: string; healthFile: string } {
  const stateDir = env.SH_COW_STATE_DIR ?? '.cache/cow-poster';
  const healthFile = env.SH_COW_HEALTH_FILE ?? `${stateDir}/health.json`;
  if (!stateDir || !healthFile) fail('SH_COW_STATE_DIR/SH_COW_HEALTH_FILE');
  return { stateDir, healthFile };
}
function url(value: string | undefined, name: string): URL {
  try {
    const parsed = new URL(value ?? '');
    if (!['http:', 'https:'].includes(parsed.protocol)) return fail(name);
    return parsed;
  } catch { return fail(name); }
}
export function loadConfig(env: Record<string, string | undefined>): Config {
  const service = loadService(env);
  const chainId = positive(env.SH_COW_CHAIN_ID, 'SH_COW_CHAIN_ID');
  const rpcUrl = url(env.SH_COW_RPC_URL, 'SH_COW_RPC_URL').href;
  const network = chainId === 1 ? 'mainnet' : chainId === 11155111 ? 'sepolia' : null;
  const api = url(env.SH_COW_API_BASE ?? (network ? `https://api.cow.fi/${network}` : undefined), 'SH_COW_API_BASE');
  if (api.username || api.password || api.search || api.hash) fail('SH_COW_API_BASE');
  if (api.hostname === 'api.cow.fi' && (api.protocol !== 'https:' || (network && api.pathname.replace(/\/$/, '') !== `/${network}`))) fail('SH_COW_API_BASE');
  const fee = env.SH_COW_FEE_BPS ?? '500';
  if (!/^(0|[1-9][0-9]*)$/.test(fee) || BigInt(fee) > 10_000n) fail('SH_COW_FEE_BPS');
  const cycleMs = positive(env.SH_COW_CYCLE_MS ?? '600000', 'SH_COW_CYCLE_MS');
  if (cycleMs > 2_147_483_647) fail('SH_COW_CYCLE_MS');
  const manifestPath = env.SH_COW_MANIFEST;
  if (!manifestPath) return fail('SH_COW_MANIFEST');
  const { stateDir, healthFile } = loadPaths(env);
  if (chainId === 1 && !service.allowMainnet) fail('SH_SERVICE_ALLOW_MAINNET');
  return { mode: service.mode, chainId, rpcUrl, apiBase: api.href.replace(/\/$/, ''), manifestPath, cycleMs,
    feeBps: BigInt(fee), stateDir, healthFile };
}
export function loadManifest(input: unknown, chainId: number): DeployedCoreManifestV2 {
  let manifest: DeployedCoreManifestV2;
  try { manifest = parseCoreManifestV2(input); }
  catch { throw new Error('invalid release manifest'); }
  if (manifest.chainId !== chainId) throw new Error('manifest chain mismatch');
  return manifest;
}
