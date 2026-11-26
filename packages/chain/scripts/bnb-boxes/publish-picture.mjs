#!/usr/bin/env node
/**
 * SH-295: a box logo on Arweave, as the site's Create press publishes it (apps/web/src/features/pictures/
 * arweave-publish.ts `publishToArweave`: a free Turbo upload of the exact bytes, signed by a throwaway key made in this
 * process and dropped with it, tagged App-Name "Square Hole", SHA-256 <hex>, Box-Chain-Id). The indexer finds a box's
 * logo by those tags (packages/indexer/src/pictures/discovery.ts), so a box created by script shows its logo once its
 * bytes are published, by this or by anyone.
 *
 *   node packages/chain/scripts/bnb-boxes/publish-picture.mjs --file <png> [--chain 97] [--expect <0x sha256>] [--send]
 *
 * Without --send nothing is sent: it prints the bytes' sha256, the tags, the item's size against the free limit, and
 * whether Arweave already holds a copy (a GraphQL search, read only). With --send it uploads once, unless a copy exists.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './ts.mjs';

const WEB = '../../../../apps/web/src/features/pictures';
const { publishToArweave, pictureTags, TURBO_FREE_BYTES } = await import(`${WEB}/arweave-publish.ts`);
const { itemSize } = await import(`${WEB}/ans104-eth.ts`);

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const file = resolve(flag('--file') ?? '');
const chainId = Number(flag('--chain', '97'));
const bytes = new Uint8Array(readFileSync(file));
const sha256 = `0x${createHash('sha256').update(bytes).digest('hex')}`;
if (flag('--expect')) assert.equal(sha256, flag('--expect').toLowerCase(), `${file} is not the picture the sheet commits`);
const tags = pictureTags(bytes, sha256, chainId);
assert.ok(tags, 'a PNG, JPEG or WebP picture');
const size = itemSize(bytes.length, tags);
process.stdout.write(`${file}: ${bytes.length} bytes, sha256 ${sha256}; item ${size} bytes against the free ${TURBO_FREE_BYTES}\n`);
assert.ok(size <= TURBO_FREE_BYTES, 'above the free upload size');

const query = `{transactions(first:5,tags:[{name:"App-Name",values:["Square Hole"]},{name:"SHA-256",values:["${sha256.slice(2)}"]}]){edges{node{id}}}}`;
const found = await fetch('https://arweave.net/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) })
  .then(r => r.json()).then(j => j.data.transactions.edges.map(e => e.node.id), () => null);
process.stdout.write(`on Arweave already: ${found === null ? 'unknown (the search failed)' : found.length ? found.join(', ') : 'no'}\n`);
if (!args.includes('--send')) process.exit(0);
assert.ok(found !== null, 'the search failed: not sent (run again)');
if (found.length) { process.stdout.write('a copy exists: nothing sent\n'); process.exit(0); }
const [result] = await publishToArweave([{ sha256, bytes }], { chainId });
process.stdout.write(`${JSON.stringify(result)}\n`);
assert.ok(result.ok, 'the upload was refused');
