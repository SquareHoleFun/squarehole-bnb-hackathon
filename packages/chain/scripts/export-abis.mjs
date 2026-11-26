#!/usr/bin/env node
/**
 * Exports typed ABIs (TypeScript `as const`) from the pinned contract build into packages/chain/src/abi/*.ts
 * (06-ARCHITECTURE: "Contract ABIs are generated from pinned sources/deployments, not invented JSON").
 *
 * Sources:
 * - Square Hole contracts, the DN404 mirror and the Uniswap v4 PoolManager: forge's artifacts in
 *   packages/contracts/out (run `forge build` in packages/contracts first).
 * - Uniswap v4 StateView and V4Quoter (periphery lens contracts that no Square Hole source imports, so `forge build`
 *   does not emit them): `forge inspect <pinned lib path>:<Name> abi --json`, compiled from the pinned
 *   lib/v4-periphery submodule with the project's compiler settings. Nothing is written to out/.
 *
 * - `revertErrorsAbi` (src/abi/revertErrors.ts): every custom error a createLaunch / claim / claimAsT simulation can
 *   surface, collected from the Square Hole artifacts and the Uniswap v4 libraries they call (library artifacts carry
 *   their errors; v4 wraps hook reverts in ERC-7751 `WrappedError`), deduplicated by signature. The write side decodes
 *   reverts with it (SH-C integration: this script is the single ABI source of packages/chain).
 *
 * Usage: node scripts/export-abis.mjs           (writes src/abi/*.ts)
 *        node scripts/export-abis.mjs --check   (exit 1 when a committed file differs from the build)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chainDir = resolve(here, '..');
const contractsDir = resolve(chainDir, '../contracts');
const abiDir = join(chainDir, 'src/abi');

/** Every exported ABI. `file` is the generated module; `artifact` or `lens` names the source. */
export const ABI_ENTRIES = [
  { name: 'squareHoleRegistryAbi', file: 'squareHoleRegistry', artifact: 'SquareHoleRegistry.sol/SquareHoleRegistry.json' },
  { name: 'squareHoleLauncherAbi', file: 'squareHoleLauncher', artifact: 'SquareHoleLauncher.sol/SquareHoleLauncher.json' },
  { name: 'squareHoleTokenAbi', file: 'squareHoleToken', artifact: 'SquareHoleToken.sol/SquareHoleToken.json' },
  { name: 'squareHoleFungibleTokenAbi', file: 'squareHoleFungibleToken', artifact: 'SquareHoleFungibleToken.sol/SquareHoleFungibleToken.json' },
  { name: 'dn404MirrorAbi', file: 'dn404Mirror', artifact: 'DN404Mirror.sol/DN404Mirror.json' },
  { name: 'rewardLedgerAbi', file: 'rewardLedger', artifact: 'RewardLedger.sol/RewardLedger.json' },
  { name: 'feeCollectorAbi', file: 'feeCollector', artifact: 'FeeCollector.sol/FeeCollector.json' },
  { name: 'squareHoleHookAbi', file: 'squareHoleHook', artifact: 'SquareHoleHook.sol/SquareHoleHook.json' },
  { name: 'squareHoleClaimConverterAbi', file: 'squareHoleClaimConverter', artifact: 'SquareHoleClaimConverter.sol/SquareHoleClaimConverter.json' },
  { name: 'mockTetherUsdAbi', file: 'mockTetherUsd', artifact: 'MockTetherUSD.sol/MockTetherUSD.json' },
  { name: 'poolManagerAbi', file: 'poolManager', artifact: 'PoolManager.sol/PoolManager.json' },
  { name: 'stateViewAbi', file: 'stateView', lens: 'lib/v4-periphery/src/lens/StateView.sol:StateView' },
  { name: 'v4QuoterAbi', file: 'v4Quoter', lens: 'lib/v4-periphery/src/lens/V4Quoter.sol:V4Quoter' },
  // Core v1 (S10a, docs/design/s10a-core-v1-site.md § 2.1): the registry the indexer and the site find every box
  // through, the factory the manifest writer reads, and each contract of a box whose events or views they decode.
  { name: 'boxRegistryAbi', file: 'boxRegistry', artifact: 'BoxRegistry.sol/BoxRegistry.json' },
  { name: 'boxFactoryV1Abi', file: 'boxFactoryV1', artifact: 'BoxFactoryV1.sol/BoxFactoryV1.json' },
  { name: 'boxCoordinatorAbi', file: 'boxCoordinator', artifact: 'BoxCoordinator.sol/BoxCoordinator.json' },
  { name: 'boxHookAbi', file: 'boxHook', artifact: 'BoxHook.sol/BoxHook.json' },
  { name: 'boxLaunchRouterAbi', file: 'boxLaunchRouter', artifact: 'BoxLaunchRouter.sol/BoxLaunchRouter.json' },
  { name: 'boxReceiverAbi', file: 'boxReceiver', artifact: 'BoxReceiver.sol/BoxReceiver.json' },
  { name: 'boxVaultAbi', file: 'boxVault', artifact: 'BoxVault.sol/BoxVault.json' },
  { name: 'boxCollectionAbi', file: 'boxCollection', artifact: 'BoxCollection.sol/BoxCollection.json' },
  { name: 'boxTicketsAbi', file: 'boxTickets', artifact: 'BoxTickets.sol/BoxTickets.json' },
  { name: 'boxItemStreamAbi', file: 'boxItemStream', artifact: 'BoxItemStream.sol/BoxItemStream.json' },
  { name: 'boxRoyaltyRouterAbi', file: 'boxRoyaltyRouter', artifact: 'BoxRoyaltyRouter.sol/BoxRoyaltyRouter.json' },
  { name: 'fitBuybackExecutorAbi', file: 'fitBuybackExecutor', artifact: 'FitBuybackExecutor.sol/FitBuybackExecutor.json' },
  { name: 'backedSourceAbi', file: 'backedSource', artifact: 'BoxBackedSource.sol/BoxBackedSource.json' },
  { name: 'drandSourceAbi', file: 'drandSource', artifact: 'DrandSource.sol/DrandSource.json' },
  { name: 'boxTokenAbi', file: 'boxToken', artifact: 'BoxToken.sol/BoxToken.json' },
];

/** Artifacts whose custom errors make up `revertErrorsAbi` (Square Hole contracts and the v4 code they call). */
export const REVERT_ERROR_ARTIFACTS = [
  'SquareHoleLauncher.sol/SquareHoleLauncher.json',
  'SquareHoleRegistry.sol/SquareHoleRegistry.json',
  'RewardLedger.sol/RewardLedger.json',
  'SquareHoleClaimConverter.sol/SquareHoleClaimConverter.json',
  'FeeCollector.sol/FeeCollector.json',
  'SquareHoleHook.sol/SquareHoleHook.json',
  'SquareHoleToken.sol/SquareHoleToken.json',
  'SquareHoleFungibleToken.sol/SquareHoleFungibleToken.json',
  'LaunchDeployers.sol/CoreDeployer.json',
  'LaunchDeployers.sol/CollectionTokenDeployer.json',
  'LaunchDeployers.sol/FungibleTokenDeployer.json',
  'MockTetherUSD.sol/MockTetherUSD.json',
  'PoolManager.sol/PoolManager.json',
  'Pool.sol/Pool.default.json',
  'Hooks.sol/Hooks.default.json',
  'CustomRevert.sol/CustomRevert.default.json',
  'TickMath.sol/TickMath.default.json',
  'SafeCast.sol/SafeCast.default.json',
  'Currency.sol/CurrencyLibrary.default.json',
  'LPFeeLibrary.sol/LPFeeLibrary.default.json',
];

function canonicalType(param) {
  if (!param.type.startsWith('tuple')) return param.type;
  return `(${param.components.map(canonicalType).join(',')})${param.type.slice('tuple'.length)}`;
}

/** An error fragment with only the keys viem needs (no internalType), in a fixed order. */
function cleanError(fragment) {
  const param = (p) => {
    const out = { name: p.name, type: p.type };
    if (p.components !== undefined) out.components = p.components.map(param);
    return out;
  };
  return { type: 'error', name: fragment.name, inputs: fragment.inputs.map(param) };
}

/** The deduplicated, signature-sorted error table and the digest of each source artifact's ABI. */
export function collectRevertErrors() {
  const sources = [];
  const bySignature = new Map();
  for (const artifact of REVERT_ERROR_ARTIFACTS) {
    const abi = readAbi({ artifact });
    sources.push({ artifact, sha256: abiDigest(abi) });
    for (const error of abi.filter((item) => item.type === 'error')) {
      const key = `${error.name}(${error.inputs.map(canonicalType).join(',')})`;
      if (!bySignature.has(key)) bySignature.set(key, cleanError(error));
    }
  }
  const errors = [...bySignature.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, error]) => error);
  return { sources, errors };
}

function revertErrorsText({ sources, errors }) {
  return [
    '// Generated by packages/chain/scripts/export-abis.mjs from packages/contracts/out. Do not edit by hand:',
    '// re-run `pnpm --filter @squarehole/chain abi:export` after a contract change (abi-drift.test.ts fails otherwise).',
    `// Every custom error the writers decode: ${errors.length} signatures from ${sources.length} artifacts, deduplicated by signature.`,
    `export const revertErrorsAbi = ${JSON.stringify(errors, null, 2)} as const;`,
    '',
    '/** The artifacts the error table was collected from and the sha256 of each artifact ABI. */',
    'export const REVERT_ERROR_SOURCES = [',
    ...sources.map(({ artifact, sha256 }) => `  { artifact: '${artifact}', sha256: '${sha256}' },`),
    '] as const;',
    '',
  ].join('\n');
}

function sourceOf(entry) {
  return entry.artifact ? `packages/contracts/out/${entry.artifact}` : `forge inspect ${entry.lens} abi (packages/contracts)`;
}

export function readAbi(entry) {
  if (entry.artifact) {
    const path = join(contractsDir, 'out', entry.artifact);
    if (!existsSync(path)) throw new Error(`missing artifact ${path}: run \`forge build\` in packages/contracts first`);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(artifact.abi)) throw new Error(`artifact without an ABI: ${path}`);
    return artifact.abi;
  }
  const result = spawnSync('forge', ['inspect', entry.lens, 'abi', '--json'], { cwd: contractsDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`forge inspect ${entry.lens} failed: ${result.stderr || result.error}`);
  const abi = JSON.parse(result.stdout);
  if (!Array.isArray(abi)) throw new Error(`forge inspect ${entry.lens} returned no ABI array`);
  return abi;
}

/** sha256 of the canonical JSON text of the ABI (the same text the module embeds). */
export function abiDigest(abi) {
  return createHash('sha256').update(JSON.stringify(abi)).digest('hex');
}

function moduleText(entry, abi) {
  return [
    `// Generated by packages/chain/scripts/export-abis.mjs from ${sourceOf(entry)}. Do not edit by hand:`,
    '// re-run `pnpm --filter @squarehole/chain abi:export` after a contract change (abi-drift.test.ts fails otherwise).',
    `// sha256(JSON): ${abiDigest(abi)}`,
    `export const ${entry.name} = ${JSON.stringify(abi, null, 2)} as const;`,
    '',
  ].join('\n');
}

function indexText(entries) {
  const lines = [
    '// Generated by packages/chain/scripts/export-abis.mjs. Do not edit by hand.',
    '// Typed ABIs of the pinned contracts (packages/contracts, forge build) and the Uniswap v4 lens contracts',
    '// (pinned lib/v4-periphery). Import these; never hand-write an ABI fragment.',
  ];
  for (const { entry } of entries) lines.push(`export { ${entry.name} } from './${entry.file}';`);
  lines.push(`export { REVERT_ERROR_SOURCES, revertErrorsAbi } from './revertErrors';`);
  lines.push('', '/** Where each ABI came from and the sha256 of its JSON (checked by abi-drift.test.ts). */');
  lines.push('export const ABI_SOURCES = [');
  for (const { entry, abi } of entries) {
    const kind = entry.artifact ? `artifact: '${entry.artifact}'` : `lens: '${entry.lens}'`;
    lines.push(`  { name: '${entry.name}', file: '${entry.file}', ${kind}, sha256: '${abiDigest(abi)}' },`);
  }
  lines.push('] as const;', '');
  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const built = ABI_ENTRIES.map((entry) => ({ entry, abi: readAbi(entry) }));
  const files = [
    ...built.map(({ entry, abi }) => [join(abiDir, `${entry.file}.ts`), moduleText(entry, abi)]),
    [join(abiDir, 'revertErrors.ts'), revertErrorsText(collectRevertErrors())],
    [join(abiDir, 'index.ts'), indexText(built)],
  ];
  const drift = [];
  for (const [path, text] of files) {
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) drift.push(path);
    } else {
      writeFileSync(path, text);
    }
  }
  if (check) {
    if (drift.length > 0) {
      console.error(`ABI drift in ${drift.length} file(s):\n${drift.join('\n')}\nRun: pnpm --filter @squarehole/chain abi:export`);
      process.exit(1);
    }
    process.stdout.write(`ABIs match the build (${built.length} contracts and the revert error table).\n`);
  } else {
    process.stdout.write(`Wrote ${files.length} files to ${abiDir}.\n`);
  }
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) main();
