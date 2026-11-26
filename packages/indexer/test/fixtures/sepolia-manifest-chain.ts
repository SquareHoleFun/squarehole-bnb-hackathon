/**
 * TEST ONLY: fake chain for SH-TA-11, not recorded Sepolia logs or bytecode.
 * Box 0 addresses: SH-SEPOLIA-CORE-V1-DEPLOY.md, "Box 0" table. Native listing raise/bootstrap:
 * SH-SEPOLIA-CORE-V2-DEPLOY/reviewed-plan.json. Registries and implementations come only from the input manifest.
 */
import { readFileSync } from 'node:fs';
import { boxRowFromRecord, drandSourceOf, ROLE_NAMES, type RoleName } from '@squarehole/chain';
import { labelHash, registryLogs } from '@squarehole/chain/core/test-support';
import { boxHookAbi, boxItemStreamAbi } from '@squarehole/chain/abi';
import { encodeFunctionData, encodeFunctionResult, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { listingRegistryV2Abi, type DeployedCoreManifestV2 } from '../../src/core/v2/chain-v2';
import { ev, synthBox, synthManifest, World } from '../core/core-synth';
import { eventV2, requiredV2, ScriptedCoreChain } from '../core/scripted-core-chain';

const box0: Partial<Record<RoleName, Address>> = {
  coordinator: '0x4039f68558Fb8cfce3070712FBb1D530D5e1cb5D',
  token: '0xaC0B0beeEf2E3951B67c47096ad26ef45AFdD396',
  hook: '0xfF107F6e6A4173E6938147bB5AD52EbD2148Aae0',
  vault: '0x9CadBfCCE0E2D18Acf1E423f0C2f1346617297A3',
  collection: '0xCA1cDA4A704899735497a4014FF53b27aB638ACa',
  receiver: '0x4C75930f44F0b5C1D6BA0Aa6030f551F428816Dd',
  launchRouter: '0x73af183f31866cA1482d7cdD463a2fEEbE9e4f6C',
  tickets: '0x409814D2f3B9a8DC0204e67aD3C1ceAaE2d0A83D',
  royaltyRouter: '0x6D6B777eBBB5F98382Dd3253fD0cBB81B16E8BC0',
  itemStream: '0xe6aF3cE326a4ab2c5E884D61D5E9f0c69644f9fB',
  executor: '0xf1B15FC37BE694F70C25e1a94c1d0AdC7b145CE1',
  metadataTable: '0xa06B55436269C3e562F45567DaD63C090aA74dEc',
};

export const nativeListing = {
  id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, listedAt: 1792721424n,
  raise: 4206980085000000000n,
  // Only bootstrap is a deploy-record value; the other positive parameters are synthetic call answers.
  q: { bootstrapQ: 1500000000000000n, batchMinQ: 1n, tipMaxQ: 1n, swapStepMinQ: 1n },
} as const;

export function sepoliaManifestChain(manifest: DeployedCoreManifestV2, listingBlock?: bigint) {
  const v1 = requiredV2(manifest.versions[0]);
  const v2 = requiredV2(manifest.releases[0]);
  const original = synthBox({ boxId: 0n, creationBlock: BigInt(v1.startBlock) });
  const oldImplementations = requiredV2(synthManifest().versions[0]).implementations;
  const codes = new Map<string, Hex>();
  const drand = JSON.parse(readFileSync(new URL('./f143-drand-runtime.json', import.meta.url), 'utf8')) as { runtime: Hex };
  codes.set(drandSourceOf(manifest).address.toLowerCase(), drand.runtime);
  const contracts = ROLE_NAMES.map(role => original.row.contracts[role] ? requiredV2(box0[role]) : zeroAddress);
  const codeHashes = ROLE_NAMES.map((role, i) => {
    const oldAddress = original.row.contracts[role];
    if (!oldAddress) return requiredV2(original.record.codeHashes[i]);
    let code = requiredV2(original.codes.get(oldAddress.toLowerCase()));
    for (const key of Object.keys(oldImplementations) as (keyof typeof oldImplementations)[]) {
      code = code.replace(oldImplementations[key].address.slice(2).toLowerCase(), v1.implementations[key].address.slice(2).toLowerCase()) as Hex;
    }
    codes.set(requiredV2(contracts[i]).toLowerCase(), code);
    return keccak256(code);
  });
  const record = { ...original.record, templateId: requiredV2(v1.supportedTemplates[0]),
    poolManager: manifest.chain.poolManager.address, randomness: manifest.chain.randomness.address, contracts, codeHashes };
  const row = boxRowFromRecord(record, original.encodedSpec, { chainId: manifest.chainId, registry: v1.registry.address, box0Registry: v1.registry.address });
  const box = { ...original, row, record, codes };
  const world = new World('sepolia-manifest');
  world.block(record.creationBlock, [[
    ...registryLogs({ spec: row.spec, record, encodedSpec: original.encodedSpec }, { registry: v1.registry.address, blockNumber: record.creationBlock, blockHash: labelHash('pending') })
      .map(log => ({ ...log, topics: [...log.topics] })),
    ev.mint(box, record.creator, 10n ** 27n),
  ]]);
  world.block(listingBlock ?? BigInt(v2.startBlock) + 9n, [eventV2('listingRegistry', 'ListingAdded', v2.listingRegistry.address, nativeListing)]);
  world.to(BigInt(manifest.evidence.block.number));
  const chain = new ScriptedCoreChain(manifest.chainId, world.headers, world.logs,
    address => codes.get(address.toLowerCase()),
    (to, data) => {
      if (to.toLowerCase() === v2.listingRegistry.address.toLowerCase()
        && data === encodeFunctionData({ abi: listingRegistryV2Abi, functionName: 'listing', args: [0] })) {
        return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', result: nativeListing });
      }
      if (to.toLowerCase() === box0.hook?.toLowerCase()
        && data === encodeFunctionData({ abi: boxHookAbi, functionName: 'depthBudget' })) {
        return encodeFunctionResult({ abi: boxHookAbi, functionName: 'depthBudget', result: [0n, 0n] });
      }
      if (to.toLowerCase() === box0.itemStream?.toLowerCase()
        && data === encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'index' })) {
        return encodeFunctionResult({ abi: boxItemStreamAbi, functionName: 'index', result: 0n });
      }
      return undefined;
    });
  return { chain, box, world };
}
