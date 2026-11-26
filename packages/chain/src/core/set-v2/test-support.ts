/** Local synthetic inputs only; no deployment claim or network reads. */
import { encodePacked, keccak256, stringToHex, zeroAddress, type Address } from 'viem';
import { SET_FORMAT, SET_SCHEMA, SET_RELEASE, SET_TEMPLATE, encodeSetSpecV2, type SetSpecV2 } from '@squarehole/box-spec';
import { standardRuntime } from '../v2/clones-v2';
import { synthManifestV2 } from '../v2/test-support/synth-v2';

export const hash = (label: string) => keccak256(stringToHex(label));
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing value');
  return value;
}
export const address = (label: string): Address => `0x${hash(label).slice(-40)}`;
const pin = (label: string) => ({ address: address(label), codeHash: hash(label) });
export const core = synthManifestV2();
export const setManifestInput = () => ({
  schema: 'squarehole.set-release/v1' as const, network: 'local' as const, chainId: core.chainId,
  release: SET_RELEASE, templateId: SET_TEMPLATE, versionCodeHash: hash('set version'),
  factory: pin('set factory'), registry: pin('set registry'), listingRegistry: pin('set listing registry'),
  poolManager: core.chain.poolManager, platformSafe: core.chain.platformSafe, startBlock: '51',
  implementations: {
    coordinator: pin('set coordinator'), token: pin('set token'), hook: pin('set hook'),
    vault: pin('set vault'), receiver: pin('set receiver'), launchRouter: pin('set launch router'),
    starterSetLoader: pin('set loader'),
  },
});
export const spec: SetSpecV2 = {
  format: SET_FORMAT, schema: SET_SCHEMA, release: SET_RELEASE, tokenName: 'Outside Set', tokenSymbol: 'SET',
  pricing: { listingId: 0, token: zeroAddress }, raise: 4206980085000000000n, openAt: 0,
  deadlineDays: 30, creatorBuy: 0n, collection: address('outside collection'), count: 10,
  setHash: hash('ordered set'), pickFeeBps: 500, description: 'Named picks and returns', logoSha256: hash('logo'),
};
export const identityInput = () => {
  const roles: Address[] = Array<Address>(24).fill(zeroAddress);
  for (const i of [0, 1, 2, 3, 5, 6, 19]) roles[i] = address(`box role ${i}`);
  const creator = address('creator');
  const args = encodePacked(
    ['address', 'address', 'address', 'address', 'address', 'uint32', 'bytes32', 'uint16'],
    [required(roles[0]), required(roles[1]), required(roles[19]), creator, spec.collection, spec.count, spec.setHash, spec.pickFeeBps],
  );
  const encodedSpec = encodeSetSpecV2(spec);
  return {
    registry: setManifestInput().registry.address, templateId: SET_TEMPLATE,
    encodedSpec, specHash: keccak256(encodedSpec), roles, creator,
    vaultCode: standardRuntime(setManifestInput().implementations.vault.address, args),
  };
};
