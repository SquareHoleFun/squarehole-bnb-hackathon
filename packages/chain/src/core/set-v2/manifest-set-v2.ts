import { zeroAddress, type Hex } from 'viem';
import { z } from 'zod';
import { SET_RELEASE, SET_TEMPLATE, setAddressSchema } from '@squarehole/box-spec';
import { parseCoreManifest, type DeployedCoreManifest } from '../../config/core-manifest';
import { ChainConfigError } from '../../errors';
import { parseCoreManifestV2, type DeployedCoreManifestV2 } from '../v2/manifest-v2';
import { setFactoryV2Abi } from './abi-set-v2';

export const SET_MANIFEST_SCHEMA = 'squarehole.set-release/v1';
export type SetCoreManifest = DeployedCoreManifest | DeployedCoreManifestV2;
const address = setAddressSchema.refine(s => s.toLowerCase() !== zeroAddress).transform(s => s.toLowerCase() as `0x${string}`);
const hash = z.templateLiteral(['0x', z.string()]).refine(s => /^0x[0-9a-fA-F]{64}$/.test(s)).transform(s => s.toLowerCase() as Hex);
const pin = z.strictObject({ address, codeHash: hash });
const schema = z.strictObject({
  schema: z.literal(SET_MANIFEST_SCHEMA), network: z.enum(['local', 'sepolia']),
  chainId: z.union([z.literal(31337), z.literal(11155111)]),
  release: hash.refine(s => s === SET_RELEASE), templateId: hash.refine(s => s === SET_TEMPLATE),
  versionCodeHash: hash, factory: pin, registry: pin, listingRegistry: pin,
  poolManager: pin, platformSafe: pin,
  startBlock: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  implementations: z.strictObject({
    coordinator: pin, token: pin, hook: pin, vault: pin, receiver: pin, launchRouter: pin, starterSetLoader: pin,
  }),
});
export type SetReleaseManifest = z.output<typeof schema>;
function fail(message: string): never { throw new ChainConfigError('invalid_manifest', `Set manifest rejected: ${message}`); }

/** Separate local/Sepolia add-on file, bound to a deployed core on the same network; no env/IO here. */
export function parseSetManifest(input: unknown, coreInput: unknown): SetReleaseManifest {
  const extended = typeof coreInput === 'object' && coreInput !== null && 'releases' in coreInput
    ? parseCoreManifestV2(coreInput) : null;
  const core = extended ?? parseCoreManifest(coreInput);
  if (core.status !== 'deployed') fail('core must be deployed');
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const manifest = parsed.data;
  if (manifest.network === 'sepolia' && manifest.chainId !== 11155111) fail('Sepolia requires chainId 11155111');
  if (manifest.network !== core.network) fail('network differs from core');
  if (manifest.chainId !== core.chainId) fail('chainId differs from core');
  for (const key of ['poolManager', 'platformSafe'] as const) {
    if (manifest[key].address !== core.chain[key].address.toLowerCase() || manifest[key].codeHash !== core.chain[key].codeHash.toLowerCase()) fail(`${key} differs from core`);
  }
  const registries = [...core.versions, ...(extended?.releases ?? [])];
  if (registries.some(r => r.registry.address.toLowerCase() === manifest.registry.address)) fail('registry belongs to v1/v2.1');
  return manifest;
}

export type SetFactoryIdentityRead = (request: {
  readonly address: `0x${string}`;
  readonly abi: typeof setFactoryV2Abi;
  readonly functionName: 'versionCodeHash' | 'RELEASE' | 'TEMPLATE';
}) => Promise<Hex>;

/** Hosts must await this at startup, using reads on the manifest chain at one chosen block. Rejections propagate. */
export async function checkSetFactoryIdentity(manifest: SetReleaseManifest, read: SetFactoryIdentityRead): Promise<void> {
  const expected = { versionCodeHash: manifest.versionCodeHash, RELEASE: manifest.release, TEMPLATE: manifest.templateId };
  await Promise.all((['versionCodeHash', 'RELEASE', 'TEMPLATE'] as const).map(async functionName => {
    const actual = await read({ address: manifest.factory.address, abi: setFactoryV2Abi, functionName });
    if (actual.toLowerCase() !== expected[functionName].toLowerCase()) fail(`factory ${functionName} mismatch`);
  }));
}
