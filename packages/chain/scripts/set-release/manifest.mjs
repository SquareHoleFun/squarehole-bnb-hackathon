import '../register-ts.mjs';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, http, parseAbi, encodeAbiParameters, decodeAbiParameters, getContractAddress, keccak256, zeroAddress, zeroHash } from 'viem';
import { parseConfig, pinCode, libraryNames, libraryKey, assertNewOutput } from './release.mjs';
const { SET_RELEASE, SET_TEMPLATE } = await import('@squarehole/box-spec');
const { parseSetManifest, setFactoryV2Abi } = await import('@squarehole/chain/core/set-v2');
const releaseTuple = setFactoryV2Abi.find(entry => entry.name === 'release').outputs[0];
const verifyAbi = [{type:'function',name:'verifyCode',stateMutability:'view',inputs:[{...releaseTuple,name:'r'},{type:'address',name:'planner'}],outputs:[]}];
const graphAbi = parseAbi([
  'function extension() view returns (address)', 'function receiverCode() view returns (address,address,address)',
  'function feeModule(uint8) view returns (address,bytes32)', 'function directory() view returns (address[])',
  'function validator() view returns (address)', 'function parts() view returns (address)',
  'function configHash() view returns (bytes32)', 'function sender() view returns (address)',
  'function partsHash() view returns (bytes32)', 'function sealedBlock() view returns (uint256)',
  'function chainId() view returns (uint256)', 'function used() view returns (bool)',
]);
const roles = [[0,'coordinator'],[1,'token'],[2,'hook'],[3,'vault'],[5,'receiver'],[6,'launchRouter'],[19,'starterSetLoader']];
const lower = value => value.toLowerCase();
function equal(actual, expected, label) { if (lower(actual) !== lower(expected)) throw new Error(`${label} hash/identity mismatch`); }
export function canonical(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));
  return value;
}
const json = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
function assertSupportedNetwork(network) {
  if (network === 'mainnet') throw new Error('mainnet set manifests are not supported; a separate ticket and counsel approval are required');
  if (!['local','sepolia'].includes(network)) throw new Error('manifest network must be local or sepolia');
}

/** One observation block for every identity/code read; startBlock is independently checked for first code. */
export async function buildManifest({client, configText, core, factory, startBlock, network, handoff}) {
  assertSupportedNetwork(network);
  const config = parseConfig(configText);
  const chainId = BigInt(await client.request({method:'eth_chainId'}));
  if (chainId !== BigInt(config.chainId)) throw new Error('RPC chain differs from config');
  const clientVersion = await client.request({method:'web3_clientVersion'});
  if ((network === 'sepolia' && chainId !== 11155111n) ||
      (network === 'local' && (!/^anvil\//i.test(clientVersion) || ![31337n,11155111n].includes(chainId)))) throw new Error('network/chain/client mismatch');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(startBlock)) throw new Error('invalid decimal startBlock');
  const observation = await client.getBlock({blockTag:'latest'}), blockNumber = observation.number;
  if (blockNumber === null || !observation.hash || BigInt(startBlock) > blockNumber) throw new Error('unmined observation/startBlock');
  if (BigInt(startBlock) > 0n) {
    const before = await client.getCode({address:factory,blockNumber:BigInt(startBlock)-1n});
    if (before && before !== '0x') throw new Error('startBlock is not the first factory code block');
  }
  await pinCode(client, factory, BigInt(startBlock));
  const read = (address, functionName, args = [], abi = graphAbi) => client.readContract({address,abi,functionName,args,blockNumber});
  const factoryRead = name => read(factory,name,[],setFactoryV2Abi);
  const r = await factoryRead('release');
  equal(r.factory, factory, 'factory');
  for (const name of ['poolManager','weth','fitSafe','platformSafe']) equal(r[name], config[name], name);
  const pins = {};
  const pin = async (name, target, expected) => {
    const value = await pinCode(client, target, blockNumber);
    if (expected) equal(value.codeHash, expected, name);
    pins[name] = value;
    return value;
  };
  await pin('factory', factory);
  const implementations = {};
  for (const [role,name] of roles) implementations[name] = await pin(name,r.implementations[role],r.implementationHashes[role]);
  for (let role = 0; role < 24; ++role) if (!roles.some(([used]) => used === role)) {
    equal(r.implementations[role], zeroAddress, 'unused implementation');
    equal(r.implementationHashes[role], zeroHash, 'unused implementation hash');
  }
  const receiver = r.implementations[5];
  const receiverCode = await read(receiver,'receiverCode');
  const dependencies = [r.registry,r.listingRegistry,r.poolManager,r.weth,await read(r.implementations[2],'extension'),
    getContractAddress({from:r.implementations[0],nonce:1n}),...receiverCode];
  for (let i=0; i<4; ++i) {
    const [target, recordedHash] = await read(receiver,'feeModule',[i+6]);
    equal(recordedHash,r.dependencyHashes[9+i],`feeModule${i}`);
    dependencies.push(target);
  }
  const depNames = ['registry','listingRegistry','poolManager','weth','hookExtension','coordinatorViews',
    'receiverViews','receiverCallback','feeDirectory','eatPriceCoinModule','holdersModule','itemsModule','pileModule'];
  for (let i=0; i<dependencies.length; ++i) await pin(depNames[i],dependencies[i],r.dependencyHashes[i]);
  const directory = await read(r.registry,'directory'), directoryHashes = [];
  if (directory.map(lower).join() !== config.v1RegistryDirectory.map(lower).join()) throw new Error('registry directory identity mismatch');
  for (let i=0; i<directory.length; ++i) directoryHashes.push((await pin(`olderRegistry${i}`,directory[i])).codeHash);
  equal(keccak256(encodeAbiParameters([{type:'address[]'},{type:'bytes32[]'}],[directory,directoryHashes])),r.directoryHash,'directory');
  const planner = await factoryRead('planner'), checks = await factoryRead('checks');
  await pin('planner',planner,r.plannerHash);
  await pin('checks',checks);
  await pin('validator',await read(planner,'validator'));
  await pin('encoder',await read(planner,'parts'));
  await pin('vaultViews',getContractAddress({from:r.implementations[3],nonce:1n}));
  await pin('platformSafe',r.platformSafe);
  await pin('fitSafe',r.fitSafe);
  // Validate the live graph with the release's own immutable checker as well as comparing every hash above.
  await read(checks,'verifyCode',[r,planner],verifyAbi);
  const versionCodeHash = await factoryRead('versionCodeHash');
  equal(await factoryRead('RELEASE'),SET_RELEASE,'RELEASE');
  equal(await factoryRead('TEMPLATE'),SET_TEMPLATE,'TEMPLATE');
  equal(versionCodeHash,keccak256(encodeAbiParameters([
    {type:'bytes32'},{type:'bytes32'},releaseTuple,{type:'address'},{type:'address'},
    {type:'bytes32'},{type:'bytes32'},{type:'bytes32'},
  ],[SET_RELEASE,SET_TEMPLATE,r,planner,checks,pins.checks.codeHash,pins.encoder.codeHash,pins.validator.codeHash])),'versionCodeHash');

  if (!handoff?.mined || handoff.configHash !== config.hash || handoff.chainId !== config.chainId) throw new Error('mined handoff/config mismatch');
  const [slot,registry,listings,impls,planned,checked] = decodeAbiParameters(
    [{type:'address'},{type:'address'},{type:'address'},{type:'address[24]'},{type:'address'},{type:'address'}],handoff.parts);
  equal(slot,handoff.slot,'slot'); equal(registry,r.registry,'handoff registry'); equal(listings,r.listingRegistry,'handoff listings');
  equal(planned,planner,'handoff planner'); equal(checked,checks,'handoff checks');
  impls.forEach((target,i) => equal(target,r.implementations[i],'handoff implementation'));
  // The one-use reservation fixes factory CREATE nonce 1.
  equal(getContractAddress({from:slot,nonce:1n}),factory,'reserved factory');
  await pin('slot',slot);
  equal(await read(slot,'configHash'),config.hash,'slot config');
  equal(await read(slot,'partsHash'),keccak256(handoff.parts),'slot parts');
  equal(await read(slot,'sender'),handoff.sender,'slot sender');
  if (await read(slot,'chainId') !== chainId || !await read(slot,'used') ||
      await read(slot,'sealedBlock') !== BigInt(handoff.sealedBlock) || BigInt(handoff.sealedBlock) >= BigInt(startBlock)) throw new Error('slot phase boundary mismatch');
  for (const name of libraryNames) {
    const key = libraryKey(name), expected = handoff.libraries?.[key];
    if (!expected) throw new Error(`missing library ${name}`);
    await pin(`library:${name}`,expected.address,expected.codeHash);
  }
  // The maintained parser binds the truthful network and chain to the deployed core.
  const chainIdWire = {'11155111':11155111,'31337':31337}[config.chainId];
  const manifest = parseSetManifest({schema:'squarehole.set-release/v1',network,chainId:chainIdWire,release:SET_RELEASE,templateId:SET_TEMPLATE,
    versionCodeHash,factory:pins.factory,registry:pins.registry,listingRegistry:pins.listingRegistry,poolManager:pins.poolManager,
    platformSafe:pins.platformSafe,startBlock,implementations},core);
  const after = await client.getBlock({blockNumber});
  equal(after.hash,observation.hash,'observation block reorg');
  return {manifest,attestation:{schema:'squarehole.set-release-attestation/v1',configHash:config.hash,chainId:config.chainId,
    startBlock,versionCodeHash,observation:{block:blockNumber.toString(),hash:observation.hash},pins,release:canonical(r)}};
}

/** Compare against fresh chain reads, not the old observation block (which would conceal later code changes). */
export async function checkManifest({manifest,attestation,...options}) {
  assertSupportedNetwork(manifest.network);
  const recorded = await options.client.getBlock({blockNumber:BigInt(attestation.observation.block)});
  equal(recorded.hash,attestation.observation.hash,'recorded observation block');
  const fresh = await buildManifest({...options,startBlock:manifest.startBlock,factory:manifest.factory.address,network:manifest.network});
  if (json(manifest) !== json(fresh.manifest)) throw new Error('client manifest hash/identity mismatch');
  const oldPins = {...attestation,observation:undefined};
  const newPins = {...fresh.attestation,observation:undefined};
  if (json(oldPins) !== json(newPins)) throw new Error('attestation code hash/identity mismatch');
}

export async function main(argv = process.argv.slice(2)) {
  const {values:o,positionals} = parseArgs({args:argv,allowPositionals:true,options:Object.fromEntries(
    ['rpc','config','core','factory','start-block','network','handoff','manifest','attestation'].map(name=>[name,{type:'string'}]))});
  if (positionals.length !== 1 || !['write','check'].includes(positionals[0])) throw new Error('usage: manifest.mjs write|check --rpc URL --config FILE --core FILE --handoff FILE --manifest FILE --attestation FILE [--factory ADDRESS --start-block DECIMAL --network local|sepolia]');
  for (const name of ['rpc','config','core','handoff','manifest','attestation']) if (!o[name]) throw new Error(`missing --${name}`);
  const readJson = file => JSON.parse(readFileSync(file,'utf8'));
  if (positionals[0] === 'write') {
    assertNewOutput(o.manifest); assertNewOutput(o.attestation);
    if (resolve(o.manifest) === resolve(o.attestation)) throw new Error('distinct output files required');
  }
  const options = {client:createPublicClient({transport:http(o.rpc,{retryCount:0})}),configText:readFileSync(o.config,'utf8'),
    core:readJson(o.core),handoff:readJson(o.handoff),factory:o.factory,startBlock:o['start-block'],network:o.network};
  if (positionals[0] === 'check') {
    await checkManifest({...options,manifest:readJson(o.manifest),attestation:readJson(o.attestation)});
    process.stdout.write('All client and attestation hashes match mined code.\n');
  } else {
    const result = await buildManifest(options);
    writeFileSync(o.manifest,json(result.manifest),{flag:'wx'});
    writeFileSync(o.attestation,json(result.attestation),{flag:'wx'});
    process.stdout.write('Wrote client manifest and full graph attestation from mined code.\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => {process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
