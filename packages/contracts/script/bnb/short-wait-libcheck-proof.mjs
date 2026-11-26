#!/usr/bin/env node
/**
 * SH-300: a proof of `check`'s library points on a LOCAL anvil (no fork, nothing sent but anvil_setCode), loaded from
 * the fork-4 rehearsal's end state (hackathon/rehearsals/short-wait-fork/anvil-end-state.json.gz, decoded). That state
 * holds the second release but not the libraries it reused from the live chain, so this plants them: at each address
 * the receiver's code names (and, for a library that links another, a stand-in address of this proof's choosing), the
 * library's own artifact with its call guard set to that address. Then:
 *   1. every library point of `check` passes (one address per link, the code there is the library's artifact);
 *   2. with ONE library's code swapped for another library's, exactly that library's point fails.
 * The other points read accounts the state lacks and are not this proof's subject. Run from packages/contracts:
 *   node --experimental-transform-types script/bnb/short-wait-libcheck-proof.mjs --rpc-url <loopback anvil> --factory <0x>
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS, rpc } from './bnb-testnet.mjs';
import { checkRelease } from './short-wait.mjs';

const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const url = flag('--rpc-url'); const factory = flag('--factory');
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, 'a loopback anvil');
assert.ok((await rpc(url, 'web3_clientVersion')).startsWith('anvil/'));
const art = (name, file = `${name}.sol`) => JSON.parse(readFileSync(join(CONTRACTS, `out/${file.split('/').pop()}/${name}.json`), 'utf8')).deployedBytecode;
const call = async (to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const receiver = `0x${(await call(factory, execFileSync('cast', ['calldata', 'implementation(uint256)', '5'], { encoding: 'utf8' }).trim())).slice(26)}`;
const planted = new Map(); let next = 0x5100;
async function plant(name, file, at) {
  if (planted.has(at)) return;
  const a = art(name, file); let code = a.object.slice(2).toLowerCase();
  assert.ok(code.startsWith(`73${'0'.repeat(40)}`), `${name}: a library's call guard`);
  code = `73${at.slice(2)}${code.slice(42)}`;
  planted.set(at, { name, file, code });
  for (const [f, libs] of Object.entries(a.linkReferences ?? {})) {
    for (const [lib, refs] of Object.entries(libs)) {
      const known = [...planted.entries()].find(([, v]) => v.name === lib);
      const where = known ? known[0] : `0x${(next++).toString(16).padStart(40, '0')}`;
      for (const { start } of refs) code = code.slice(0, start * 2) + where.slice(2) + code.slice((start + 20) * 2);
      planted.get(at).code = code;
      await plant(lib, f, where);
    }
  }
  await rpc(url, 'anvil_setCode', [at, `0x${planted.get(at).code}`]);
}
const live = (await rpc(url, 'eth_getCode', [receiver, 'latest'])).slice(2).toLowerCase();
for (const [file, libs] of Object.entries(art('BoxReceiverV2').linkReferences)) {
  for (const [lib, refs] of Object.entries(libs)) await plant(lib, file, `0x${live.slice(refs[0].start * 2, (refs[0].start + 20) * 2)}`);
}
const points = checks => checks.filter(c => /librar|links/.test(c.what));
const one = points(await checkRelease(url, factory));
process.stdout.write(`planted ${planted.size} libraries; library points ${one.filter(c => c.ok).length} of ${one.length} pass\n`);
for (const c of one) process.stdout.write(`  ${c.ok} ${c.what} ${c.detail ?? ''}\n`);
assert.ok(one.length > 0 && one.every(c => c.ok), 'every library point passes with the right code');
// Swap one library's code for another's (each with its own call guard): exactly that point fails.
// Two libraries that link none: the swap changes one point only.
const victim = [...planted.entries()].find(([, v]) => v.name === 'FeeModuleProofV21');
const donor = [...planted.entries()].find(([, v]) => v.name === 'ReceiverModuleCallV21');
await rpc(url, 'anvil_setCode', [victim[0], `0x73${victim[0].slice(2)}${donor[1].code.slice(42)}`]);
const two = points(await checkRelease(url, factory));
const failed = two.filter(c => !c.ok).map(c => c.what);
process.stdout.write(`after ${victim[1].name}'s code was replaced by ${donor[1].name}'s: failing ${JSON.stringify(failed)}\n`);
assert.deepEqual(failed, [`BoxReceiverV2's library ${victim[1].name} is ${victim[1].name}`]);
process.stdout.write('PROOF OK\n');
