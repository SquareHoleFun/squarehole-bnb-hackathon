/** Founder entry point. No dotenv, ambient RPC, raw key, account alias or arbitrary Forge flag support. */
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createPublicClient, http, isAddress, keccak256, stringToHex, zeroHash, parseAbi } from 'viem';

const contracts = fileURLToPath(new URL('../../../contracts/', import.meta.url));
const fields = ['chainId', 'poolManager', 'weth', 'platformSafe', 'fitSafe', 'v1RegistryDirectory'];
export const libraryNames = ['FactoryChecksCurve', 'ReceiverShopV21', 'ReceiverPendingV21', 'ReceiverRewardsV21',
  'RewardAccountingV21', 'ReceiverBooksV21', 'FeeModuleProofV21', 'ReceiverModuleCallV21'];
export const libraryKey = name => `src/box-v2/libraries/${name}.sol:${name}`;
const address = value => typeof value === 'string' && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);

export function parseConfig(text) {
  const config = JSON.parse(text);
  if (!config || Array.isArray(config) || Object.keys(config).sort().join() !== [...fields].sort().join()) throw new Error('release config fields');
  if (!['1', '11155111', '31337'].includes(config.chainId)) throw new Error('chainId must be a supported decimal string');
  for (const key of fields.slice(1, 5)) if (!address(config[key])) throw new Error(`invalid ${key}`);
  const directory = config.v1RegistryDirectory;
  if (!Array.isArray(directory) || !directory.length || directory.some(a => !address(a)) || new Set(directory.map(a => a.toLowerCase())).size !== directory.length) throw new Error('invalid registry directory');
  if (config.fitSafe.toLowerCase() === config.platformSafe.toLowerCase()) throw new Error('distinct Safes required');
  return { ...config, hash: keccak256(stringToHex(text)) };
}

export function guardChain(config, actualChainId, clientVersion, options) {
  if (BigInt(config.chainId) !== actualChainId) throw new Error('RPC chain differs from reviewed config');
  if (actualChainId === 1n && options['mainnet-ack']?.toLowerCase() !== config.hash) throw new Error('mainnet-ack must name the exact reviewed config manifest hash');
  if ((options['local-fork'] || actualChainId === 31337n) && !/^anvil\//i.test(clientVersion)) throw new Error('local fork requires Anvil');
}

const allowed = ['config', 'rpc', 'sender', 'unlocked', 'ledger', 'trezor', 'key-file', 'mainnet-ack', 'local-fork',
  'broadcast', 'evm', 'handoff'];
export function forgeArguments(phase, configText, options, handoff) {
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`unsupported option ${key}`);
  if (!address(options.sender)) throw new Error('explicit --sender required');
  const signers = ['unlocked', 'ledger', 'trezor', 'key-file'].filter(key => options[key]);
  if (signers.length !== 1) throw new Error('exactly one founder signer required');
  if (!['cancun', 'amsterdam'].includes(options.evm)) throw new Error('explicit --evm cancun|amsterdam required');
  if (!['parts', 'factory'].includes(phase)) throw new Error('phase must be parts or factory');
  if (!options.rpc) throw new Error('explicit --rpc required');
  const args = ['script', `script/existing-nfts/release/${phase === 'parts' ? 'DeployParts.s.sol:DeploySetParts' : 'DeployFactory.s.sol:DeploySetFactory'}`,
    '--sig', phase === 'parts' ? 'run(string,bytes32)' : 'run(string,bytes32,bytes)', configText, options['mainnet-ack'] ?? zeroHash];
  if (phase === 'factory') {
    if (!handoff?.mined || handoff.configHash !== parseConfig(configText).hash || handoff.sender !== options.sender.toLowerCase()) throw new Error('mined handoff/config/sender mismatch');
    if (!/^0x[0-9a-f]{1856}$/i.test(handoff.parts)) throw new Error('invalid address-only parts handoff');
    args.push(handoff.parts);
    for (const name of libraryNames) {
      const pin = handoff.libraries?.[libraryKey(name)];
      if (!address(pin?.address)) throw new Error(`missing library ${name}`);
      args.push('--libraries', `${libraryKey(name)}:${pin.address}`);
    }
  }
  args.push('--rpc-url', options.rpc, '--sender', options.sender, '--hardfork', options.evm, '--offline', '--slow', '--isolate',
    '--disable-external-identification', '--gas-estimate-multiplier', options.evm === 'amsterdam' ? '110' : '130');
  args.push(signers[0] === 'key-file' ? '--keystore' : `--${signers[0]}`);
  // Resolve before spawning: Forge runs in packages/contracts, not the invocation directory.
  if (signers[0] === 'key-file') args.push(resolve(options['key-file']));
  if (options.broadcast) args.push('--broadcast');
  return args;
}

/** Forge auto-loads dotenv files. Refuse their presence without opening them, including ancestor lookup. */
export function assertNoDotEnv(start, stat = lstatSync) {
  let dir = resolve(start);
  for (;;) {
    try { stat(join(dir, '.env')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
      continue;
    }
    throw new Error('Forge dotenv discovery refused: run from a checkout with no .env in its ancestor chain');
  }
}

export function assertNewOutput(file, stat = lstatSync) {
  try { stat(file); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('output exists; preserve it and choose a new path');
}

export async function pinCode(client, target, blockNumber) {
  const code = await client.getCode({ address: target, blockNumber });
  if (!code || code === '0x') throw new Error(`no mined code at ${target}`);
  return { address: target.toLowerCase(), codeHash: keccak256(code) };
}

export function runForge(args) {
  assertNoDotEnv(contracts);
  return new Promise((resolveRun, reject) => {
    // Drop ambient keys, RPC, profile overrides and NODE_OPTIONS. Signers are explicit CLI arguments only.
    const child = spawn('forge', args, { cwd: contracts, env: { PATH: process.env.PATH, TERM: 'dumb' }, stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun(output) : reject(new Error(`forge exited ${code}; preserve receipts and do not retry blindly`)));
  });
}

const slotAbi = parseAbi(['function sealedBlock() view returns (uint256)', 'function configHash() view returns (bytes32)',
  'function sender() view returns (address)', 'function partsHash() view returns (bytes32)']);

export async function main(argv = process.argv.slice(2)) {
  const { values: options, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries(allowed.map(name => [name, {
    type: ['unlocked', 'ledger', 'trezor', 'local-fork', 'broadcast'].includes(name) ? 'boolean' : 'string',
  }])) });
  if (positionals.length !== 1 || !options.config) throw new Error('usage: release.mjs config-hash|parts|factory --config FILE [explicit operator options]');
  const text = readFileSync(options.config, 'utf8'), config = parseConfig(text), phase = positionals[0];
  if (phase === 'config-hash') { process.stdout.write(`${config.hash}\n`); return; }
  // Refuse mainnet before even opening an RPC connection.
  guardChain(config, BigInt(config.chainId), options['local-fork'] || config.chainId === '31337' ? 'anvil/preflight' : '', options);
  if (!options.handoff) throw new Error('explicit --handoff FILE required (new file in phase 1)');
  if (phase === 'parts' && options.broadcast) assertNewOutput(options.handoff);
  const handoff = phase === 'factory' ? JSON.parse(readFileSync(options.handoff, 'utf8')) : undefined;
  const args = forgeArguments(phase, text, options, handoff);
  const url = new URL(options.rpc);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP(S) RPC required');
  if ((options['local-fork'] || config.chainId === '31337') && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('local fork requires loopback RPC');
  const client = createPublicClient({ transport: http(options.rpc, { retryCount: 0 }) });
  const chainId = BigInt(await client.request({ method: 'eth_chainId' }));
  const version = await client.request({ method: 'web3_clientVersion' });
  guardChain(config, chainId, version, options);
  if (handoff) {
    const block = await client.getBlockNumber({ cacheTime: 0 });
    if (block <= BigInt(handoff.sealedBlock)) throw new Error('wait for an additional block after the phase-1 seal');
    for (const pin of Object.values(handoff.libraries)) {
      if ((await pinCode(client, pin.address, block)).codeHash !== pin.codeHash) throw new Error('mined library hash changed');
    }
  }
  const output = await runForge(args);
  if (phase !== 'parts' || !options.broadcast) return; // Simulated addresses are never saved as a mined handoff.
  const parts = output.match(/SETRELEASE\|parts\|(0x[0-9a-fA-F]{1856})(?![0-9a-fA-F])/)?.[1];
  const slot = output.match(/SETRELEASE\|slot\|(0x[0-9a-fA-F]{40})/)?.[1];
  if (!parts || !slot) throw new Error('missing parts/slot output; retain broadcast receipts');
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const readSlot = functionName => client.readContract({ address: slot, abi: slotAbi, functionName, blockNumber: block });
  const sealedBlock = await readSlot('sealedBlock');
  if (sealedBlock === 0n || await readSlot('configHash') !== config.hash || (await readSlot('sender')).toLowerCase() !== options.sender.toLowerCase() || await readSlot('partsHash') !== keccak256(parts)) throw new Error('mined slot does not match output');
  const libraries = {};
  for (const name of libraryNames) {
    const key = libraryKey(name);
    const row = output.split('\n').find(line => line.includes(`SETRELEASE|library|${key}|`));
    const target = row?.split('|').at(-1).trim();
    if (!address(target)) throw new Error(`missing library ${name}`);
    libraries[key] = await pinCode(client, target, block);
  }
  writeFileSync(options.handoff, `${JSON.stringify({ mined: true, configHash: config.hash, sender: options.sender.toLowerCase(),
    chainId: config.chainId, slot, parts, sealedBlock: sealedBlock.toString(), libraries }, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
