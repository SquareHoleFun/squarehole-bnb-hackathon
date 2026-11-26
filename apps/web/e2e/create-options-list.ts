import manifest from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };

/**
 * SH-218 rail 2: the standard browser suite's one answer for the release's list of switched-off Create options. The
 * suite's chain source is the local twin's build manifest; the live indexer serves the list at this path, so every spec
 * whose routed indexer opens Create answers it here, and Create works as for a visitor of the live site: nothing off.
 * A spec that switches options off passes them (e2e/create-options.spec.ts).
 */
const RELEASE = manifest.releases[0] as unknown as { factory: { address: string }; registry: { address: string }; versionCodeHash: string };
export const CREATE_OPTIONS_PATH = `/v2/create-options/${manifest.chainId}/${RELEASE.factory.address.toLowerCase()}.json`;

/** The list as the server would serve it for the suite's release (schema 1, revision 1), with `off` switched off. */
export function createOptionsList(off: readonly string[] = []): Record<string, unknown> {
  return { schema: 1, chainId: manifest.chainId, factory: RELEASE.factory.address.toLowerCase(), registry: RELEASE.registry.address.toLowerCase(),
    versionCodeHash: RELEASE.versionCodeHash.toLowerCase(), revision: 1, off: off.map((key) => ({ key })) };
}

/** A routed indexer's answer for `path`: the empty list at the list's path, else null (the route answers the rest). */
export const createOptionsAnswer = (path: string): Record<string, unknown> | null => (path === CREATE_OPTIONS_PATH ? createOptionsList() : null);
