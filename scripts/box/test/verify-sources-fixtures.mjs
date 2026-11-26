import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const { keccak256, toHex, encodeAbiParameters } = createRequire(new URL('../../../packages/chain/package.json', import.meta.url))('viem');
export const address = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
export const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
export const source = 'src/Example.sol';
export const contract = `${source}:Example`;
export const librarySource = 'src/Library.sol';
export const runtime = `0x6001${address(2).slice(2)}${word(900719925474099312345n).slice(2)}00`;

export async function fixture() {
  await mkdir('.cache/verify-sources', { recursive: true });
  const dir = await mkdtemp('.cache/verify-sources/case-');
  const input = {
    language: 'Solidity', sources: { [source]: { content: '// Obviously synthetic offline compiler fixture\ncontract Example {}' },
      [librarySource]: { content: 'library Library {}' } },
    settings: { optimizer: { enabled: true, runs: 1000 }, viaIR: true, evmVersion: 'amsterdam',
      metadata: { bytecodeHash: 'none' }, libraries: {} },
  };
  const linkReferences = { [librarySource]: { Library: [{ start: 2, length: 20 }] } };
  const bytecode = { object: `6001${'__$' + 'a'.repeat(34) + '$__'}00`, linkReferences };
  const build = { solcLongVersion: '0.8.26+commit.8a97fa7a', input,
    output: { contracts: {
      [source]: { Example: { abi: [{ type: 'constructor', inputs: [{ name: 'amount', type: 'uint256' }] }],
        evm: { bytecode, deployedBytecode: { object: `6001${'__$' + 'a'.repeat(34) + '$__'}${'00'.repeat(32)}00`,
          linkReferences, immutableReferences: { 7: [{ start: 22, length: 32 }] } } } } },
      [librarySource]: { Library: { abi: [], evm: { bytecode: { object: '6002' }, deployedBytecode: { object: '600200' } } } },
    } },
  };
  const argumentsHex = encodeAbiParameters([{ type: 'uint256' }], [900719925474099312345n]);
  const manifest = { format: 'squarehole.verify-sources/1', chainId: '11155111', contracts: [
    { address: address(1), codeHash: keccak256(runtime), contract, buildInfo: 'build.json',
      constructorArguments: argumentsHex, creationInput: `0x6001${address(2).slice(2)}00${argumentsHex.slice(2)}`,
      immutables: { 7: word(900719925474099312345n) }, libraries: { [librarySource]: { Library: address(2) } } },
    { address: address(2), codeHash: keccak256('0x600200'), contract: `${librarySource}:Library`, buildInfo: 'build.json', constructorArguments: '0x' },
  ] };
  const save = async () => {
    await writeFile(join(dir, 'build.json'), JSON.stringify(build));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  };
  await save();
  return { dir, build, manifest, save };
}

// Captured from solc 0.8.26 --standard-json with resolved addresses, including its unmodified metadata.
export async function resolvedSolcFixture(metadataField = 'metadata') {
  const build = JSON.parse(await readFile(new URL('./verify-sources-solc-0.8.26.json', import.meta.url), 'utf8'));
  await mkdir('.cache/verify-sources', { recursive: true });
  const dir = await mkdtemp('.cache/verify-sources/resolved-solc-');
  const artifacts = {};
  const manifest = { format: 'squarehole.verify-sources/1', chainId: '11155111', contracts: [] };
  await mkdir(join(dir, 'src'));
  for (const [path, s] of Object.entries(build.input.sources)) await writeFile(join(dir, path), s.content);
  for (const [path, contracts] of Object.entries(build.output.contracts)) {
    for (const [name, code] of Object.entries(contracts)) {
      const at = name === 'Example' ? address(1) : build.input.settings.libraries[path][name];
      artifacts[name] = { abi: code.abi, bytecode: code.evm.bytecode, deployedBytecode: code.evm.deployedBytecode,
        [metadataField]: metadataField === 'rawMetadata' ? code.metadata : JSON.parse(code.metadata) };
      manifest.contracts.push({ address: at, contract: `${path}:${name}`, artifact: `${name}.json`,
        codeHash: keccak256(`0x${code.evm.deployedBytecode.object}`), creationInput: `0x${code.evm.bytecode.object}` });
    }
  }
  const save = async () => {
    await writeFile(join(dir, 'build.json'), JSON.stringify(build));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const [name, artifact] of Object.entries(artifacts)) await writeFile(join(dir, `${name}.json`), JSON.stringify(artifact));
  };
  await save();
  const fullManifest = { ...manifest, contracts: manifest.contracts.map((record) => ({ ...record, buildInfo: 'build.json' })) };
  return { dir, build, artifacts, manifest, fullManifest, save, options: { baseDir: dir, buildDir: dir, sourceRoot: dir } };
}

export function artifactCompilerInput(build, target) {
  const [path, name] = target.split(':');
  const metadata = JSON.parse(build.output.contracts[path][name].metadata);
  const input = structuredClone(build.input);
  // solc omits unrelated sources and diagnostic output selection from a contract's metadata.
  input.sources = Object.fromEntries(Object.keys(metadata.sources).map((path) => [path, input.sources[path]]));
  delete input.settings.outputSelection;
  return input;
}

export function explorerRow(entry) {
  return { SourceCode: `{${entry.request.fields.sourceCode}}`, ContractName: entry.contract.split(':').at(-1),
    CompilerVersion: entry.compilerVersion, ConstructorArguments: entry.constructorArguments.slice(2),
    OptimizationUsed: entry.settings.optimizer.enabled ? '1' : '0', Runs: String(entry.settings.optimizer.runs),
    EVMVersion: entry.settings.evmVersion, Proxy: '0', SimilarMatch: '' };
}

export function fakeExplorer(plan, overrides = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const query = new URLSearchParams(init.body);
    calls.push({ url, query, init });
    const action = query.get('action');
    const at = query.get('address') ?? query.get('contractaddress');
    const entry = plan.contracts.find((c) => c.address === at);
    const response = overrides[action]?.(entry, calls.length, query) ?? (action === 'eth_getCode'
      ? { jsonrpc: '2.0', id: 1, result: entry.runtime }
      : action === 'getsourcecode' ? { status: '1', result: [explorerRow(entry)] }
      : action === 'verifysourcecode' ? { status: '1', result: 'fake-guid-for-tests' }
      : { status: '1', result: 'Pass - Verified' });
    return { status: 200, ok: true, headers: new Headers(), json: async () => response };
  };
  return { fetch, calls };
}
