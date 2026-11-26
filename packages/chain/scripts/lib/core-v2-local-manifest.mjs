import '../register-ts.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, isAddress, keccak256, parseAbi, zeroAddress, zeroHash } from 'viem';
import { CONTRACTS, assertLocalRpc, rpc } from './core-v2-local-runtime.mjs';
import { readReceiverParts } from './core-v2-receiver-parts.mjs';

export function artifact(name, { outDir = join(CONTRACTS, 'out'), sourceFile } = {}) {
  return JSON.parse(readFileSync(join(outDir, sourceFile ?? ({ JunkyardGold: 'JunkyardLocal.s.sol', JunkyardSafeDouble: 'JunkyardLocal.s.sol', JunkyardCollection: 'JunkyardLocal.s.sol', LocalV2Custody: 'DeployCoreV2Local.s.sol', HostileCollection: 'ShopDoubles.sol' })[name] ?? `${name}.sol`, `${name}.json`), 'utf8'));
}

/** Separate 31337 evidence envelope: not a public-release manifest and never a Sepolia override. */
export async function readAlphaLocalManifest(chain, { request = rpc,
  client = createPublicClient({ transport: http(chain.rpcUrl, { retryCount: 0 }) }) } = {}) {
  await assertLocalRpc(chain.rpcUrl, request, { alpha: true });
  if (![chain.factory, chain.poolSwapTest, chain.manager, chain.assets?.teth, chain.assets?.pairs,
    chain.assets?.usdc, chain.assets?.nvda, chain.assets?.gold, chain.assets?.pepe].every(a => typeof a === 'string' && isAddress(a) && a !== zeroAddress)) {
    throw new Error('explicit alpha deployment required');
  }
  const block = await client.getBlock();
  const blockNumber = block.number;
  const abi = parseAbi(['function manager() view returns (address)', 'function poolManager() view returns (address)',
    'function registry() view returns (address)']);
  const read = (address, functionName) => client.readContract({ address, abi, functionName, blockNumber });
  for (const [address, fn] of [[chain.poolSwapTest, 'manager'], [chain.factory, 'poolManager'], [chain.assets.pairs, 'manager']]) {
    if ((await read(address, fn)).toLowerCase() !== chain.manager.toLowerCase()) throw new Error('alpha manager mismatch');
  }
  const contract = async address => {
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === '0x') throw new Error('missing alpha runtime code');
    return { address, codeHash: keccak256(code) };
  };
  const helper = await contract(chain.poolSwapTest);
  return { schema: 'square-hole-alpha-local/1', chainId: 31337,
    evidence: { number: blockNumber.toString(), hash: block.hash },
    factory: await contract(chain.factory), registry: await contract(await read(chain.factory, 'registry')),
    poolManager: await contract(chain.manager),
    coinDeployment: { chainId: 31337, status: 'deployed', teth: await contract(chain.assets.teth),
      pairHelper: await contract(chain.assets.pairs), poolSwapTest: helper.address, poolManager: chain.manager,
      poolSwapTestCodeHash: helper.codeHash,
      pairs: [['usdc', 'tUSDC', 6], ['nvda', 'tNVDA', 18], ['gold', 'tGOLD', 18], ['pepe', 'tPEPE', 18]]
        .map(([name, symbol, decimals]) => ({ coin: chain.assets[name], symbol, decimals, fee: '3000',
          tickSpacing: 60, hooks: zeroAddress, tickLower: -887220, tickUpper: 887220 })) },
    localDeployment: { poolSwapTest: helper.address, poolManager: chain.manager, poolSwapTestCodeHash: helper.codeHash } };
}

/** All identities, hashes, Safe-shaped metadata and box records are read at the same canonical evidence block. */
export async function readLocalManifest(chain) {
  await assertLocalRpc(chain.rpcUrl);
  const { readCoreManifest, viemCoreReads } = await import('../../src/core/core-manifest-writer.ts');
  const { parseCoreManifestV2 } = await import('../../src/core/v2/manifest-v2.ts');
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  const manifest = await readCoreManifest(viemCoreReads(client), chain.genesisFactory, { network: 'local', gitCommit: null });
  const blockNumber = BigInt(manifest.evidence.block.number);
  const read = (name, address, functionName, args = []) => client.readContract({ abi: artifact(name).abi, address, functionName, args, blockNumber });
  const contract = async address => {
    const code = await client.getCode({ address, blockNumber });
    if (!code || code === '0x') throw new Error(`missing local contract ${address}`);
    return { address, codeHash: keccak256(code) };
  };
  const factoryRead = (fn, args = []) => read('BoxFactoryV2', chain.factory, fn, args);
  const implementationNames = { 0: 'coordinator', 1: 'token', 2: 'hook', 3: 'vault', 4: 'collection', 5: 'receiver',
    6: 'launchRouter', 7: 'tickets', 8: 'royaltyRouter', 16: 'itemLedger', 17: 'holderLedger', 19: 'starterSetLoader', 20: 'tokenLedger', 21: 'shopVault', 22: 'pileVault' };
  const implementations = {};
  for (const [role, name] of Object.entries(implementationNames)) {
    implementations[name] = await contract(await factoryRead('implementation', [BigInt(role)]));
  }
  implementations.hookExtension = await contract(await read('BoxHookV2', implementations.hook.address, 'extension'));
  // The strict application manifest has no receiver-helper fields yet. Preserve both code commitments in
  // local-core-v2-chain.json (saved by checkpoint), at this same block, without changing its release schema.
  chain.receiverParts = await readReceiverParts(client, implementations.receiver.address, blockNumber);
  const safes = {};
  for (const [role, getter] of Object.entries({ fit: 'FIT_SAFE', platform: 'PLATFORM_SAFE' })) {
    const address = await read('BoxReceiverV2', implementations.receiver.address, getter);
    const singleton = await read('LocalV2Custody', address, 'singleton');
    const [modules, next] = await read('LocalV2Custody', address, 'getModulesPaginated', ['0x0000000000000000000000000000000000000001', 10n]);
    if (modules.length || BigInt(next) !== 1n) throw new Error('unexpected local custody modules');
    safes[role] = { ...await contract(address), singleton, singletonCodeHash: (await contract(singleton)).codeHash,
      owners: await read('LocalV2Custody', address, 'getOwners'), threshold: String(await read('LocalV2Custody', address, 'getThreshold')),
      version: await read('LocalV2Custody', address, 'VERSION'), modulesEnabled: false,
      guard: zeroAddress, guardCodeHash: zeroHash, handler: zeroAddress, handlerCodeHash: zeroHash,
      controlTransferProof: 'LOCAL ONLY: LocalV2Custody double; no Safe signature or public release proof' };
  }
  return parseCoreManifestV2({ ...manifest, releases: [{ version: 2, factory: await contract(chain.factory),
    registry: await contract(await factoryRead('registry')), listingRegistry: await contract(await factoryRead('listingRegistry')),
    safes, startBlock: chain.releaseStartBlock, implementations, versionCodeHash: await factoryRead('versionCodeHash') }] });
}

/** Plain boxes deliberately do not maintain holder/item harvest counters. Collected is the fee-booking receipt.
 * Read every receipt for this receiver, bounded by the release start and the same block as its balance reads.
 */
export async function readCollectedFees(client, receiver, fromBlock, toBlock) {
  const logs = await client.getContractEvents({ address: receiver, abi: artifact('BoxReceiverV2').abi,
    eventName: 'Collected', fromBlock, toBlock, strict: true });
  return logs.reduce((sum, { args }) => {
    for (const key of Object.keys(sum)) sum[key] += args[key];
    return sum;
  }, { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n });
}

/** Read independently of the indexer; browser assertions compare against this exact block. */
export async function readLocalBox(chain, coordinator, blockNumber) {
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  blockNumber ??= await client.getBlockNumber({ cacheTime: 0 });
  const read = (name, address, functionName, args = []) => client.readContract({ abi: artifact(name).abi, address, functionName, args, blockNumber });
  const c = (name, args) => read('BoxCoordinatorV2', coordinator, name, args);
  const token = await c('token'); const hook = await c('hook'); const receiver = await c('receiver');
  const h = name => read('BoxHookV2', hook, name);
  const r = (name, args) => read('BoxReceiverV2', receiver, name, args);
  const [pot, left] = await c('claimState');
  return { coordinator, token, hook, receiver, block: blockNumber, vault: await c('vault'), holderLedger: await c('roleAddress', [17n]), itemLedger: await c('roleAddress', [16n]),
    graduated: await c('graduated'), failed: await c('failed'), failedAt: await c('failedAt'), openAt: await c('effectiveOpenAt'),
    deadline: await c('deadline'), raise: await c('raise'), gateOpen: await c('gateOpen'), closed: await h('closed'),
    pairedLiquidity: await h('pairedLiquidity'), saleFeesPending: await h('saleFeesPending'),
    harvestedFees: await r('harvestedFees'),
    collectedFees: await readCollectedFees(client, receiver, BigInt(chain.releaseStartBlock), blockNumber), creatorP: await r('creatorP'), fitOwed: await r('fitOwed'), platformOwed: await r('platformOwed'),
    pot, left, supply: await read('BoxTokenV2', token, 'totalSupply'),
    actorT: await read('BoxTokenV2', token, 'balanceOf', [chain.accounts.actor]) };
}
