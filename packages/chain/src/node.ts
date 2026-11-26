/**
 * Node-only helpers (tests, scripts). Never imported by the browser entry (src/index.ts): the app loads manifests
 * through its bundler (see `selectManifestModule`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/contracts/deployments of this repository. */
export const DEFAULT_DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/deployments');

/**
 * Parsed `deployments/<chainId>.json`, or null when the file does not exist (the chain is not deployed). A file that
 * exists but is not JSON throws; `createChainConfig` then validates the manifest itself.
 */
export function readDeploymentManifestFile(chainId: number, directory: string = DEFAULT_DEPLOYMENTS_DIR): unknown {
  const path = join(directory, `${chainId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
