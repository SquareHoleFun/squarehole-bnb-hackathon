/** Reproducible offline E09B reports. All Forge tests selected here are owned by this ticket. */
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { encodeAbiParameters, zeroAddress, zeroHash } from 'viem';
import { libraryNames, assertNoDotEnv } from './release.mjs';
const root = fileURLToPath(new URL('../../../../',import.meta.url));
const contracts = join(root,'packages/contracts');
const output = join(root,'docs/evidence/sh-existing-nfts-e09b');
const scratch = join(root,'.cache/sh-existing-nfts-e09b');
const artifacts = ['SetFactorySlot','SetFactoryV2','SetFactoryV2Planner','SetFactoryV2Checks','SetSpecV2Validator','SetVaultV2',
  'BoxRegistryV2','ListingRegistry','BoxCoordinatorV2','CoordinatorViews','BoxTokenV2','BoxHookV2','BoxHookV2Extension',
  'StarterSetLoaderV2','BoxReceiverV2','BoxReceiverV2Extension','BoxLaunchRouterV2','ReceiverViews','VaultViews','BoxFactoryV2Parts',
  'FeeModuleDirectoryV21','EatPriceCoinFeeModuleV21','HoldersTFeeModuleV21','ItemsTFeeModuleV21','PileFeeModuleV21',...libraryNames];
export function gasRows(log) {
  if (!/34 tests passed, 0 failed, 0 skipped/.test(log)) throw new Error('incomplete or failed gas report');
  const rows = {};
  let suite = '';
  for (const line of log.split('\n')) {
    const start = line.match(/^Ran \d+ tests? for .*:Report(\w+)/);
    if (start) suite = start[1];
    const entry = line.match(/^ {2}([\w ,/-]+): (\d+)$/);
    if (!entry || !suite || entry[1].startsWith('retry ') || entry[1].startsWith('largest page')) continue;
    let label = entry[1];
    if (['router buy','collect','graduate','fail deadline','fail filled timeout'].includes(label)) label += suite.includes('ERC20') ? ' (ERC-20)' : ' (native)';
    if (rows[label] && rows[label] !== entry[2]) throw new Error(`conflicting measurement ${label}`);
    rows[label] = BigInt(entry[2]).toString();
  }
  return Object.fromEntries(Object.entries(rows).sort(([a],[b])=>a.localeCompare(b)));
}
export function sizeRow(name,runtime,creation,argsBytes) {
  const runtimeBytes = BigInt((runtime.length-2)/2), initcodeBytes = BigInt((creation.length-2)/2)+argsBytes;
  const budget = name.startsWith('Set') && name !== 'SetFactorySlot' ? 22118n : 24576n;
  if (runtimeBytes > budget) throw new Error(`${name} runtime budget`);
  if (initcodeBytes > 49152n) throw new Error(`${name} initcode ceiling`);
  return {contract:name,runtimeBytes:runtimeBytes.toString(),runtimeMargin:(24576n-runtimeBytes).toString(),
    releaseBudget:budget.toString(),releaseMargin:(budget-runtimeBytes).toString(),constructorBytes:argsBytes.toString(),
    initcodeBytes:initcodeBytes.toString(),initcodeMargin:(49152n-initcodeBytes).toString()};
}
function zeroValue(param,name) {
  const array = param.type.match(/^(.*)\[(\d*)\]$/);
  if (array) {
    // Fee directory has four initial modules. Registry has one older registry in the report config.
    const count = array[2] ? BigInt(array[2]) : name === 'FeeModuleDirectoryV21' ? 4n : 1n;
    const values = [];
    for (let i=0n;i<count;++i) values.push(zeroValue({...param,type:array[1]},name));
    return values;
  }
  if (param.type === 'tuple') return param.components.map(p=>zeroValue(p,name));
  if (param.type === 'address') return zeroAddress;
  if (param.type === 'bytes32') return zeroHash;
  if (param.type === 'bool') return false;
  if (/^uint|^int/.test(param.type)) return 0n;
  throw new Error(`unhandled constructor ${name} ${param.type}`);
}
function run(args,label,env={}) {
  assertNoDotEnv(contracts);
  const result = spawnSync('forge',args,{cwd:contracts,env:{PATH:process.env.PATH,TERM:'dumb',FOUNDRY_PROFILE:'default',...env},encoding:'utf8',maxBuffer:64*1024*1024});
  writeFileSync(join(scratch,`${label}.log`),(result.stdout??'')+(result.stderr??''));
  if (result.status !== 0) throw new Error(`${label} failed; see .cache/sh-existing-nfts-e09b/${label}.log`);
  return result.stdout;
}
export function main() {
  mkdirSync(output,{recursive:true}); mkdirSync(scratch,{recursive:true});
  // Focus the build so unrelated legacy/test harness EIP-170 violations cannot pollute release sizes.
  const build = run(['build','src/box-v2/set/SetFactoryV2.sol','src/box-v2/set/SetVaultV2.sol','src/box-v2/set/SetSpecV2Validator.sol',
    'src/box-v2/BoxReceiverV2.sol','script/existing-nfts/release/SetReleaseBase.sol','--sizes','--skip','test','--skip','script','--offline'],'build-sizes-focused');
  const gas = {};
  for (const evm of ['cancun','amsterdam']) {
    process.stdout.write(`Measuring E07 cold operations on ${evm}...\n`);
    gas[evm] = gasRows(run(['test','--match-path','test/box-v2/existing-nfts/release/ReleaseGasReport.t.sol','--hardfork',evm,'-vv','--offline'],
      `gas-${evm}`,{FOUNDRY_PROFILE:'sepolia-rehearsal',FOUNDRY_FUZZ_RUNS:'256'}));
    if (Object.keys(gas[evm]).length !== 29) throw new Error(`expected 29 cold rows on ${evm}`);
  }
  const sizes = artifacts.map(name=> {
    const artifactFile = name === 'SetFactorySlot' ? 'SetReleaseBase.sol' : `${name}.sol`;
    const a = JSON.parse(readFileSync(join(contracts,`out/${artifactFile}/${name}.json`),'utf8'));
    const inputs = a.abi.find(entry=>entry.type==='constructor')?.inputs??[];
    const args = encodeAbiParameters(inputs,inputs.map(p=>zeroValue(p,name)));
    return sizeRow(name,a.deployedBytecode.object,a.bytecode.object,BigInt((args.length-2)/2));
  });
  const pretty = value=>`${JSON.stringify(value,null,2)}\n`;
  writeFileSync(join(output,'gas.json'),pretty(gas));
  writeFileSync(join(output,'sizes.json'),pretty(sizes));
  const table = ['# E09B cold gas report','','Generated by `node packages/chain/scripts/set-release/reports.mjs`. Pinned Cancun bytecode on both runtime EVMs.',
    '34 inherited E07 tests per EVM, including all four N=10000 tests. Gross call gas plus conservative transaction overhead; no refunds.',
    'The 16M call envelope and 16777216 transaction ceiling remain asserted by E07. Retry and warm chronology rows are excluded.','',
    '| Cold operation | Cancun | Amsterdam |','| --- | ---: | ---: |',...Object.keys(gas.cancun).map(k=>`| ${k} | ${gas.cancun[k]} | ${gas.amsterdam[k]} |`),''];
  writeFileSync(join(output,'gas.md'),table.join('\n'));
  writeFileSync(join(output,'sizes.md'),['# E09B deployment sizes','',
    'Generated by `node packages/chain/scripts/set-release/reports.mjs` after the focused `forge build --sizes`.',
    'solc 0.8.26; repository optimizer/metadata settings; Cancun target bytecode used on Cancun and Amsterdam.',
    'Initcode includes ABI constructor arguments (one older registry, four built-in modules). Add 32 bytes per additional older registry.',
    'The scripts check actual argument-inclusive initcode at deployment; Safes/PoolManager/WETH are existing dependencies, not deployed here.',
    'Set contracts keep the 22118-byte release budget; reused contracts and the reservation use the EIP-170 ceiling.','',
    '| Contract | Runtime | EIP-170 margin | Release margin | Args | Initcode + args | EIP-3860 margin |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...sizes.map(s=>`| ${s.contract} | ${s.runtimeBytes} | ${s.runtimeMargin} | ${s.releaseMargin} | ${s.constructorBytes} | ${s.initcodeBytes} | ${s.initcodeMargin} |`),''].join('\n'));
  const names = new Set(artifacts);
  writeFileSync(join(output,'forge-sizes.txt'),['Focused forge build --sizes (selected deployed release artifacts; constructor arguments excluded here).',
    ...build.split('\n').filter(line=>line.startsWith('| Contract ') || names.has(line.split('|')[1]?.trim())),''].join('\n'));
  process.stdout.write('Wrote 29 cold gas rows for both EVMs and 33 deployment size rows.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {main();} catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
