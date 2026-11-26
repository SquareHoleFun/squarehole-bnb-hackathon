import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCreateOptions } from './schema';

const root = new URL('./data/', import.meta.url);
const files = readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === 'string' && file.endsWith('.json'));
const manifestsRoot = new URL('../../../contracts/deployments/core-v1/', import.meta.url);
const manifests = readdirSync(manifestsRoot).filter(file => file.endsWith('.json'));
interface Manifest {
  chainId: number;
  releases?: { factory: { address: string }; registry: { address: string }; versionCodeHash: string }[];
}
const readManifest = (file: string) => JSON.parse(readFileSync(new URL(file, manifestsRoot), 'utf8')) as Manifest;
describe('installed Create documents', () => {
  it('has the initial Sepolia document', () => {
    expect(files).toContain('11155111/0xfae1e6cff43cadcbe01885bdd0aa6218263de393.json');
  });
  it.each(manifests)('%s has a data file for every release', file => {
    const manifest = readManifest(file);
    // Older manifests without a releases list have no Create release to cover.
    for (const release of manifest.releases ?? []) {
      expect(files).toContain(`${manifest.chainId}/${release.factory.address.toLowerCase()}.json`);
    }
  });
  it.each(files)('%s parses and matches its deployment pins', file => {
    const result = parseCreateOptions(readFileSync(new URL(file, root), 'utf8'));
    if (!result.ok) throw new Error(result.reason);
    const doc = result.document;
    expect(file).toBe(`${doc.chainId}/${doc.factory}.json`);
    const manifest = readManifest(`${doc.chainId}.json`);
    const release = manifest.releases?.find(r => r.factory.address.toLowerCase() === doc.factory);
    expect(release).toBeDefined();
    if (!release) throw new Error('document has no deployed release');
    expect(doc).toMatchObject({ chainId: manifest.chainId, registry: release.registry.address.toLowerCase(), versionCodeHash: release.versionCodeHash.toLowerCase() });
  });
});
