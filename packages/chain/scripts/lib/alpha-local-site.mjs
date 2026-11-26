/**
 * F156 (SH-ALPHA-TRADE-BOX): the site's core manifest for the 31337 alpha of SH-ALPHA-REHEARSAL, so the box page, its
 * indexer and its trade box can run on that chain (`pnpm dev:alpha-local`, apps/web/playwright.alpha-trade.config.ts).
 * LOCAL ONLY: written into the run's own folder under .cache, never committed, never a Sepolia override.
 *
 * The site reads a core v1 envelope with the v2 release beside it (parseCoreManifestV2). The alpha deploys the real v2
 * release with no core v1 genesis (V1's genesis pins refuse 31337, SH-ALPHA-REHEARSAL "Decisions"), so:
 * - the chain-wide contracts are the alpha's own (PoolManager, WETH, DrandSource, the platform custody double), each with
 *   the hash of its code at the evidence block;
 * - version 1 is named by placeholder addresses that hold no code on this chain, each with the empty-code hash, so the
 *   manifest says exactly what is there: no core v1. The indexer finds no v1 row there;
 * - the release is read from the factory as core-v2-local-manifest.mjs `readLocalManifest` reads the twin's;
 * - the FIT custody double is one owner with threshold 1 on chain (CoreV2LocalGenesis `_bootstrapAlpha`), while the
 *   manifest shape asks for a founder, a bot and a backup with threshold 2. Its owners and threshold are therefore test
 *   pins (the deployer and the two admitted testers), said so in its `controlTransferProof`: local test data, never an
 *   attestation. The platform custody's are read from the chain as they are.
 */
import { createPublicClient, http, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
import { artifact } from './core-v2-local-manifest.mjs';
import { assertLocalRpc, rpc } from './core-v2-local-runtime.mjs';

const EMPTY_CODE_HASH = keccak256('0x');
/** A placeholder address for a core v1 part the alpha does not have (no code there; the manifest says so by its hash). */
export const noV1 = name => `0x${keccak256(toHex(`square-hole-alpha-local:no-core-v1:${name}`)).slice(-40)}`;
const V1_IMPLEMENTATIONS = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'];
const RELEASE_IMPLEMENTATIONS = { 0: 'coordinator', 1: 'token', 2: 'hook', 3: 'vault', 4: 'collection', 5: 'receiver', 6: 'launchRouter', 7: 'tickets',
  8: 'royaltyRouter', 16: 'itemLedger', 17: 'holderLedger', 19: 'starterSetLoader', 20: 'tokenLedger', 21: 'shopVault', 22: 'pileVault' };

/**
 * `chain`: { rpcUrl, factory, manager, weth, drand, platform, testers: [address, address], startBlock } of a running alpha.
 * `outDir`: the alpha's own Forge output (.cache/alpha-forge-out), where its artifacts' ABIs are.
 */
export async function readAlphaSiteManifest(chain, { outDir, request = rpc,
  client = createPublicClient({ transport: http(chain.rpcUrl, { retryCount: 0 }) }) } = {}) {
  await assertLocalRpc(chain.rpcUrl, request, { alpha: true });
  const block = await client.getBlock();
  const blockNumber = block.number;
  const abi = name => artifact(name, { outDir }).abi;
  const read = (name, address, functionName, args = []) => client.readContract({ abi: abi(name), address, functionName, args, blockNumber });
  const contract = async address => {
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === '0x') throw new Error(`missing alpha contract ${address}`);
    return { address, codeHash: keccak256(code) };
  };
  const absent = async name => {
    const address = noV1(name);
    const code = await client.getCode({ address, blockNumber });
    if (code && code !== '0x') throw new Error(`the core v1 placeholder ${name} holds code`);
    return { address, codeHash: EMPTY_CODE_HASH };
  };
  const factoryRead = (fn, args = []) => read('BoxFactoryV2', chain.factory, fn, args);
  if ((await factoryRead('poolManager')).toLowerCase() !== chain.manager.toLowerCase()) throw new Error('alpha manager mismatch');
  const implementations = {};
  for (const [role, name] of Object.entries(RELEASE_IMPLEMENTATIONS)) implementations[name] = await contract(await factoryRead('implementation', [BigInt(role)]));
  implementations.hookExtension = await contract(await read('BoxHookV2', implementations.hook.address, 'extension'));
  const custody = async address => {
    const singleton = await read('LocalV2Custody', address, 'singleton');
    const [modules, next] = await read('LocalV2Custody', address, 'getModulesPaginated', ['0x0000000000000000000000000000000000000001', 10n]);
    if (modules.length || BigInt(next) !== 1n) throw new Error('unexpected alpha custody modules');
    return { ...await contract(address), singleton, singletonCodeHash: (await contract(singleton)).codeHash,
      owners: (await read('LocalV2Custody', address, 'getOwners')).map(owner => owner.toLowerCase()),
      threshold: String(await read('LocalV2Custody', address, 'getThreshold')), version: await read('LocalV2Custody', address, 'VERSION'),
      modulesEnabled: false, guard: zeroAddress, guardCodeHash: zeroHash, handler: zeroAddress, handlerCodeHash: zeroHash };
  };
  const fitAddress = await read('BoxReceiverV2', implementations.receiver.address, 'FIT_SAFE');
  const platformAddress = await read('BoxReceiverV2', implementations.receiver.address, 'PLATFORM_SAFE');
  if (platformAddress.toLowerCase() !== chain.platform.toLowerCase()) throw new Error('alpha platform custody mismatch');
  const platform = await custody(platformAddress);
  const fitOnChain = await custody(fitAddress);
  const founder = platform.owners[0];
  const fit = { ...fitOnChain, owners: [founder, ...chain.testers.map(tester => tester.toLowerCase())], threshold: '2',
    controlTransferProof: `LOCAL ONLY: alpha custody double, ${fitOnChain.threshold} of ${fitOnChain.owners.length} on chain; these owners and threshold are test pins for the manifest's shape, not an attestation` };
  platform.controlTransferProof = 'LOCAL ONLY: alpha custody double; no Safe signature or public release proof';
  const v1 = {};
  for (const name of V1_IMPLEMENTATIONS) v1[name] = await absent(`implementation:${name}`);
  return {
    schema: 'squarehole.core-deployment/v1', status: 'deployed', chainId: 31337, network: 'local',
    chain: { poolManager: await contract(chain.manager), weth: await contract(chain.weth), randomness: await contract(chain.drand), platformSafe: await contract(chain.platform) },
    versions: [{ version: 1, factory: await absent('factory'), registry: await absent('registry'), startBlock: String(chain.startBlock), implementations: v1,
      versionCodeHash: EMPTY_CODE_HASH, supportedTemplates: [keccak256(toHex('square-hole-alpha-local:no-core-v1:template'))] }],
    evidence: { block: { number: blockNumber.toString(), hash: block.hash }, finality: 'confirmed' },
    gitCommit: null,
    releases: [{ version: 2, factory: await contract(chain.factory), registry: await contract(await factoryRead('registry')),
      listingRegistry: await contract(await factoryRead('listingRegistry')), safes: { fit, platform }, startBlock: String(chain.startBlock),
      implementations, versionCodeHash: await factoryRead('versionCodeHash') }],
  };
}
