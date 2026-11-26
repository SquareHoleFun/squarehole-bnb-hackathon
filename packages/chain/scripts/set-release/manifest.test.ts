import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, getContractAddress, keccak256, zeroAddress, zeroHash } from 'viem';
import { SET_RELEASE, SET_TEMPLATE } from '@squarehole/box-spec';
import { parseSetManifest, setFactoryV2Abi } from '@squarehole/chain/core/set-v2';
import { core as coreFixture, address } from '../../src/core/set-v2/test-support';
const { buildManifest, checkManifest } = await import(new URL('./manifest.mjs', import.meta.url).href);
const { libraryNames, libraryKey, parseConfig } = await import(new URL('./release.mjs', import.meta.url).href);

// Same offline read boundary as chain's existing manifest tests: state and RPC reads live in memory.
function fixture(network: 'local' | 'sepolia' = 'local', chainId: 31337 | 11155111 = network === 'sepolia' ? 11155111 : 31337) {
  const core = structuredClone(coreFixture);
  core.network = network;
  core.chainId = chainId;
  const code = '0x60006000f3' as const;
  const codeHash = keccak256(code);
  core.chain.poolManager.codeHash = codeHash;
  core.chain.platformSafe.codeHash = codeHash;
  const factory = getContractAddress({from:address('slot'),nonce:1n}).toLowerCase();
  const implementations = Array<string>(24).fill(zeroAddress);
  const implementationHashes = Array<string>(24).fill(zeroHash);
  for (const i of [0,1,2,3,5,6,19]) { implementations[i] = address(`impl ${i}`); implementationHashes[i] = codeHash; }
  const r = {factory,registry:address('registry'),listingRegistry:address('listings'),poolManager:core.chain.poolManager.address,
    weth:address('weth'),fitSafe:address('fit'),platformSafe:core.chain.platformSafe.address,implementations,implementationHashes,
    dependencyHashes:Array(13).fill(codeHash),plannerHash:codeHash,directoryHash:zeroHash};
  const directory = [address('old registry')];
  r.directoryHash = keccak256(encodeAbiParameters([{type:'address[]'}, {type:'bytes32[]'}], [directory, [codeHash]]));
  const planner = address('planner'), checks = address('checks');
  const releaseOutput = setFactoryV2Abi.find(x => x.type === 'function' && x.name === 'release');
  if (!releaseOutput || !('outputs' in releaseOutput)) throw new Error('release ABI');
  const versionCodeHash = keccak256(encodeAbiParameters([
    {type:'bytes32'}, {type:'bytes32'}, releaseOutput.outputs[0], {type:'address'}, {type:'address'},
    {type:'bytes32'}, {type:'bytes32'}, {type:'bytes32'},
  ], [SET_RELEASE, SET_TEMPLATE, r, planner, checks, codeHash, codeHash, codeHash] as never));
  const configText = JSON.stringify({chainId:String(core.chainId),poolManager:r.poolManager,weth:r.weth,fitSafe:r.fitSafe,
    platformSafe:r.platformSafe,v1RegistryDirectory:directory});
  const parts = encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address[24]'},{type:'address'},{type:'address'}],
    [address('slot'),r.registry,r.listingRegistry,implementations,planner,checks] as never);
  const handoff = {mined:true,configHash:parseConfig(configText).hash,chainId:String(core.chainId),sender:address('sender'),
    slot:address('slot'),parts,sealedBlock:'49',libraries:Object.fromEntries(libraryNames.map((name: string) => [libraryKey(name),{address:address(name),codeHash}]))};
  const mutated = new Set<string>();
  const blocks: bigint[] = [];
  const client = {
    request: vi.fn(async ({method}:{method:string}) => method === 'web3_clientVersion'
      ? network === 'local' ? 'anvil/v1' : 'Geth/offline-fixture'
      : `0x${BigInt(chainId).toString(16)}`),
    getBlock: async () => ({number:60n,hash:zeroHash}),
    getCode: async ({address:target,blockNumber}:{address:string;blockNumber:bigint}) => {
      blocks.push(blockNumber);
      if (target.toLowerCase() === factory && blockNumber < 50n) return '0x';
      return mutated.has(target.toLowerCase()) ? '0x60016000f3' : code;
    },
    readContract: async ({address:target,functionName,args,blockNumber}:{address:string;functionName:string;args:bigint[];blockNumber:bigint}) => {
      blocks.push(blockNumber);
      const reads: Record<string, unknown> = {release:r,planner,checks,RELEASE:SET_RELEASE,TEMPLATE:SET_TEMPLATE,versionCodeHash,
        extension:address('hook extension'),receiverCode:[address('receiver views'),address('receiver callback'),address('fee directory')],
        directory,validator:address('validator'),parts:address('encoder'),verifyCode:undefined,configHash:handoff.configHash,
        partsHash:keccak256(parts),sender:handoff.sender,sealedBlock:49n,chainId:BigInt(chainId),used:true};
      if (functionName === 'feeModule') return [address(`module ${args[0]}`),codeHash];
      if (target === address('slot') && functionName === 'parts') throw new Error('unexpected slot read');
      if (!(functionName in reads)) throw new Error(`unhandled ${functionName}`);
      return reads[functionName];
    },
  };
  return {client,core,factory,configText,handoff,startBlock:'50',network,mutated,blocks,r};
}

describe('mined release manifest', () => {
  it.each([
    ['local', 31337], ['local', 11155111], ['sepolia', 11155111],
  ] as const)('round trips %s/%s through writer, parser and check with decimal blocks and all graph hashes', async (network, chainId) => {
    const f = fixture(network, chainId);
    const output = JSON.parse(JSON.stringify(await buildManifest(f)));
    expect(parseSetManifest(JSON.parse(JSON.stringify(output.manifest)), f.core)).toEqual(output.manifest);
    expect(output.manifest).toMatchObject({network, chainId});
    expect(output.manifest.startBlock).toBe('50');
    expect(output.attestation.pins.feeDirectory.codeHash).toBe(f.r.dependencyHashes[8]);
    expect(output.attestation.pins.coordinatorViews.address).toBe(getContractAddress({from:f.r.implementations[0] as `0x${string}`,nonce:1n}).toLowerCase());
    expect(f.blocks.every(b => [49n,50n,60n].includes(b))).toBe(true);
    await expect(checkManifest({...f, ...output})).resolves.toBeUndefined();
  });
  it.each(['factory','fee directory','ReceiverBooksV21','old registry','fit'])('detects changed code at %s', async name => {
    const f = fixture();
    const output = await buildManifest(f);
    f.mutated.add(name === 'factory' ? f.factory : address(name));
    await expect(checkManifest({...f, ...output})).rejects.toThrow(/hash|code|identity/i);
  });
  it('rejects a changed persisted pin even if chain is unchanged', async () => {
    const f = fixture();
    const output = await buildManifest(f);
    output.manifest.implementations.vault.codeHash = zeroHash;
    await expect(checkManifest({...f, ...output})).rejects.toThrow(/manifest/);
  });
  it('rejects core pins whose claimed code differs from chain', async () => {
    const f = fixture();
    f.core.chain.poolManager.codeHash = zeroHash;
    await expect(buildManifest(f)).rejects.toThrow('poolManager');
  });
  it('refuses network/chain mismatches and a local label for a public RPC', async () => {
    await expect(buildManifest({...fixture(), network:'sepolia'})).rejects.toThrow(/network\/chain/);
    await expect(buildManifest({...fixture('sepolia'), network:'local'})).rejects.toThrow(/network\/chain/);
  });
  it('binds a Sepolia write and check to the deployed core network and chain', async () => {
    const f = fixture('sepolia');
    const output = await buildManifest(f);
    for (const core of [
      {...f.core, network:'local'},
      {...f.core, network:'local', chainId:31337},
      {...f.core, chainId:31337},
      {schema:f.core.schema, network:'sepolia', chainId:11155111, status:'awaiting-broadcast'},
    ]) {
      await expect(buildManifest({...f, core})).rejects.toThrow(/network|chainId|Sepolia|deployed/);
      await expect(checkManifest({...f, ...output, core})).rejects.toThrow(/network|chainId|Sepolia|deployed/);
    }
  });
  it('clearly refuses mainnet writes and checks before RPC reads', async () => {
    const f = fixture();
    const output = await buildManifest(f);
    const mainnet = {...f, network:'mainnet', configText:JSON.stringify({...JSON.parse(f.configText),chainId:'1'}),
      core:{...f.core,network:'mainnet',chainId:1}};
    const client = {request:vi.fn(),getBlock:vi.fn(),getCode:vi.fn(),readContract:vi.fn()};
    await expect(buildManifest({...mainnet,client})).rejects.toThrow(/mainnet.*not supported/i);
    await expect(checkManifest({...mainnet,...output,client,manifest:{...output.manifest,network:'mainnet',chainId:1}}))
      .rejects.toThrow(/mainnet.*not supported/i);
    for (const read of Object.values(client)) expect(read).not.toHaveBeenCalled();
  });
  it('requires the actual first factory block', async () => {
    await expect(buildManifest({...fixture(), startBlock:'51'})).rejects.toThrow('startBlock');
  });
});

it('detects a changed historical observation block hash', async () => {
  const f = fixture();
  const output = await buildManifest(f);
  output.attestation.observation.hash = '0x'+'11'.repeat(32);
  await expect(checkManifest({...f,...output})).rejects.toThrow(/observation/);
});
