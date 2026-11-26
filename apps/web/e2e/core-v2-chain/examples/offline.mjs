import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { ROOT } from './support.mjs';

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

// Await every child, including replay, so the owner's finally runs only after readers stop.
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
      resolve({ code, signal, output });
    });
  });
}
async function main() {
  // Keep release compilation settings, adding only read access to this ticket's inputs.
  // The contract owner's configuration stays untouched.
  const junkyard = process.argv.includes('--junkyard');
  const hidden = process.argv.includes('--hidden');
  let hiddenIndex = process.env.SH_HIDDEN_KITS;
  let generatedDirectory;
  try {
    if (!junkyard && !hiddenIndex) {
      const base = new URL('.cache/hidden-art/', ROOT);
      await mkdir(base, { recursive: true, mode: 0o700 });
      generatedDirectory = await mkdtemp(new URL('lives-', base));
      const directory = relative(fileURLToPath(ROOT), generatedDirectory);
      const prepared = await run(process.execPath, ['--experimental-transform-types',
        'apps/web/e2e/core-v2-chain/examples/prepare-hidden.mjs', '--directory', directory],
        { cwd: fileURLToPath(ROOT), stdio: ['ignore', 'pipe', 'inherit'] });
      if (prepared.code !== 0) throw new Error(`Hidden kit preparation failed (${prepared.signal ?? prepared.code})`);
      hiddenIndex = prepared.output.trim();
      if (!hiddenIndex.startsWith(`${directory}/`) || !/^lives-[a-z0-9-]+\.json$/.test(hiddenIndex.slice(directory.length + 1))) {
        throw new Error('invalid private kit index');
      }
    }
    const scratchName = junkyard ? 'junkyard-forge' : hidden ? 'hidden-forge' : 'forge';
    const scratch = new URL(`.cache/examples-e2e/${scratchName}/`, ROOT);
    await mkdir(scratch, { recursive: true });
    // Foundry anchors custom configurations to their directory. These relative links
    // preserve the owner's paths (including fixture reads) in the isolated test root.
    for (const name of ['src', 'test', 'script', 'lib']) {
      try { await symlink(`../../../packages/contracts/${name}`, new URL(name, scratch)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    // A different Foundry root/configuration must own its compilation outputs. Migrate
    // links left by earlier runs without following them or touching the owner's data.
    let retired;
    for (const name of ['out', 'cache']) {
      const path = new URL(name, scratch);
      let stat;
      try { stat = await lstat(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) {
        if (!retired) {
          await mkdir(new URL('.cache/trash/', ROOT), { recursive: true });
          retired = await mkdtemp(new URL('.cache/trash/examples-forge-links-', ROOT));
        }
        await rename(path, `${retired}/${name}`);
      }
      await mkdir(path, { recursive: true });
    }
    const original = await readFile(new URL('packages/contracts/foundry.toml', ROOT), 'utf8');
    const config = original.replace('test = "test"', `test = "../../../${junkyard ? 'packages/chain/scripts/solidity/test' : 'apps/web/e2e/core-v2-chain/examples/forge'}"`)
      .replace('[profile.default]', '[profile.default]\nallow_paths = ["../../../packages/chain/scripts/solidity", "../../../packages/contracts", "../../../apps/web/e2e/core-v2-chain/examples/forge"]')
      .replace('fs_permissions = [', 'fs_permissions = [\n  { access = "read", path = "../../../packages/box-spec/examples/v2" },\n  { access = "read", path = "../../../packages/chain/scripts/local-art" },\n  { access = "read", path = "../../../examples/boxes" },\n  { access = "read", path = "../../../.cache/hidden-art" },');
    await writeFile(new URL('foundry.toml', scratch), config);
    const child = await run('forge', ['test', '--offline', '--root', `../../.cache/examples-e2e/${scratchName}`,
      '--match-path', junkyard ? '**/Junkyard*.t.sol' : '**/ExampleLives.t.sol', '--json', '-vv', ...(hidden ? ['--match-test', 'test_(frogKiln|paperCertificates)'] : []), ...process.argv.slice(2).filter(arg => !['--json', '--junkyard', '--hidden', '--keep-hidden-art'].includes(arg))], {
      cwd: fileURLToPath(new URL('packages/contracts/', ROOT)), stdio: ['inherit', 'pipe', 'inherit'],
      // The longer Junkyard life shares one test budget, like the whole-release rehearsals. Amsterdam exceeds the
      // default test gas limit; this profile changes only that budget, never compiler settings or transaction stipends.
      env: { ...process.env, ...(hiddenIndex ? { SH_HIDDEN_KITS: hiddenIndex } : {}), ...(junkyard || hidden ? { FOUNDRY_PROFILE: 'sepolia-rehearsal' } : {}),
        FOUNDRY_FUZZ_RUNS: '256', SH_EXAMPLES_CONTRACTS_ROOT: fileURLToPath(new URL('packages/contracts', ROOT)) },
    });
    const { output } = child;
    if (process.argv.includes('--json')) process.stdout.write(output);
    if (child.code !== 0) {
      if (!process.argv.includes('--json')) process.stderr.write(output);
      throw new Error(`Offline Forge failed (${child.signal ?? child.code})`);
    }
    // This file is regenerated by THIS run; passing Solidity alone is insufficient.
    JSON.parse(output);
    if (hidden) {
      await writeFile(new URL('.cache/examples-e2e/hidden-contracts.json', ROOT), output);
      if (!process.argv.includes('--json')) console.warn('Both hidden kit lives passed.');
      return;
    }
    if (junkyard) {
      await writeFile(new URL('.cache/examples-e2e/junkyard-contracts.json', ROOT), output);
      if (!process.argv.includes('--json')) console.warn('Junkyard offline EVM tests passed.');
      return;
    }
    await writeFile(new URL('.cache/examples-e2e/contract-replay.json', ROOT), output);
    // Type transforms, as in the preflight tests: the replay loads chain and set modules that Node's stripping refuses.
    const replay = await run(process.execPath, ['--experimental-vm-modules', '--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--test',
      'apps/web/e2e/core-v2-chain/examples/replay.test.mjs'], {
      cwd: fileURLToPath(ROOT), stdio: ['inherit', process.argv.includes('--json') ? 2 : 1, 'inherit'],
      env: { ...process.env, SH_EXAMPLES_ARTIFACTS: fileURLToPath(new URL('out/', scratch)) },
    });
    if (replay.code !== 0) throw new Error(`Offline replay failed (${replay.signal ?? replay.code})`);
  } finally {
    if (generatedDirectory) {
      if (process.argv.includes('--keep-hidden-art')) console.warn(`Kept private hidden art: ${relative(fileURLToPath(ROOT), generatedDirectory)}`);
      else await rm(generatedDirectory, { recursive: true, force: true });
    }
  }
}
