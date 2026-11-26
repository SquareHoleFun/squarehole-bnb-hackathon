#!/usr/bin/env node
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json, need } from './common.mjs';
import { parseInput } from './config.mjs';
import { httpRpc, ScanIncomplete } from './rpc.mjs';
import { buildListingKit } from './kit.mjs';
import { realpathSync } from 'node:fs';

const help = `Usage: node scripts/listing/cli.mjs --input public-listing-input.json --out new-output-directory [--cursor public-scan.json] [--allow-mainnet]
Prepares public reports and an unsigned Safe Transaction Builder batch. Reads RPC only from LISTING_RPC.
Chains: 1 (requires --allow-mainnet), 11155111 (Sepolia), 31337 (http://127.0.0.1 only).
--cursor saves validated log pages at one snapshot; rerun the same command to resume an incomplete scan.
No signing, sending, service submission or wallet method exists. Existing output directories are refused.
Exit: 0 all coins eligible; 2 reports written with excluded coins; 1 input/RPC/output failure.
`;

export async function runCli(argv, { env = process.env, rpcFactory = httpRpc, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (argv.length === 1 && argv[0] === '--help') { stdout.write(help); return 0; }
    const args = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      need(['--input', '--out', '--cursor', '--allow-mainnet'].includes(flag) && !Object.hasOwn(args, flag), 'invalid arguments');
      if (flag === '--allow-mainnet') args[flag] = true;
      else { need(argv[i + 1] && !argv[i + 1].startsWith('--'), 'missing argument'); args[flag] = argv[++i]; }
    }
    need(args['--input'] && args['--out'], 'input and output required');
    const stat = await lstat(args['--input']);
    need(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'regular public input file required');
    const input = JSON.parse(await readFile(args['--input'], 'utf8'));
    const allowMainnet = args['--allow-mainnet'] === true;
    const config = parseInput(input, allowMainnet);
    const out = resolve(args['--out']);
    try { await lstat(out); throw new Error('output exists'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const scanOptions = {};
    if (args['--cursor']) {
      const path = resolve(args['--cursor']);
      need(path !== resolve(args['--input']) && path !== out && !path.startsWith(`${out}${sep}`), 'cursor must be separate from input and output');
      try {
        const cursorStat = await lstat(path);
        need(cursorStat.isFile() && cursorStat.size <= 128 * 1024 * 1024, 'regular bounded cursor required');
        scanOptions.cursor = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      scanOptions.saveCursor = async cursor => {
        const contents = `${json(cursor)}\n`;
        need(Buffer.byteLength(contents) <= 128 * 1024 * 1024, 'cursor too large; partition input');
        const temporary = `${path}.${randomUUID()}.next`;
        await writeFile(temporary, contents, { flag: 'wx' });
        await rename(temporary, path);
      };
    }
    const endpoint = env.LISTING_RPC; need(typeof endpoint === 'string' && endpoint.length > 0, 'RPC environment missing');
    const result = await buildListingKit(input, rpcFactory(endpoint, { chainId: config.chainId, allowMainnet }), allowMainnet, scanOptions);
    // Exclusive new directory + exclusive files: a previous kit is never overwritten.
    await mkdir(out);
    await mkdir(join(out, 'issuer-powers'));
    const { issuerSheets, safeBatch, multiSend, dust, runner, royaltyLots, ...report } = result;
    for (const [name, contents] of Object.entries({ 'report.json': report, 'safe-batch.json': safeBatch,
      'royalty-lots.json': royaltyLots, 'multisend.json': multiSend, 'dust.json': dust, 'burn-bot-routes.json': runner })) {
      await writeFile(join(out, name), `${json(contents)}\n`, { flag: 'wx' });
    }
    for (const [token, contents] of Object.entries(issuerSheets)) await writeFile(join(out, 'issuer-powers', `${token}.md`), contents, { flag: 'wx' });
    const accepted = result.coins.filter(c => c.eligible).length;
    stdout.write(`Listing kit written: ${accepted} eligible, ${result.coins.length - accepted} excluded. Unsigned; nothing sent.\n`);
    return accepted === result.coins.length ? 0 : 2;
  } catch (error) {
    // Do not print paths, input text, environment values or upstream exception messages.
    stderr.write(error instanceof ScanIncomplete ? 'Listing scan incomplete. Rerun the same input with --cursor to resume; no pack written.\n'
      : 'Listing kit refused. Check public input, --allow-mainnet, RPC availability, cursor and a new output directory.\n');
    return 1;
  }
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exitCode = await runCli(process.argv.slice(2));
