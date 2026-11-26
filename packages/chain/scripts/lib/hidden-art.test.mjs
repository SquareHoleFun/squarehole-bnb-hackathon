import '../register-ts.mjs';
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, statSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { toHex, zeroHash } from 'viem';
import { loadExamples } from '../../../box-spec/examples/v2/registry.mjs';
import { buildExampleSpec } from '../create-example-v2.mjs';
import * as hidden from './hidden-art.mjs';
const { boxSpecFile } = await import('../../../../apps/web/src/features/create/v2/model.ts');
const { boxLeaf, buildBoxTree, verifyBoxProof } = await import('../../../artwork/src/box-commitment.ts');
const { metadataTableHex, sortedTraitTypes } = await import('../../../../apps/web/src/features/create/create-model.ts');

/** The metadata table v1's trait types (packages/artwork `encodeMetadataTable`), read apart from the page's own reader. */
function tableTypes(hex) {
  const bytes = Buffer.from(hex.slice(2), 'hex');
  let at = 3 + bytes.readUInt16BE(1);
  const types = [];
  for (let t = bytes[at++]; t > 0; t--) {
    const name = bytes.subarray(at + 1, at + 1 + bytes[at]).toString('ascii'); at += 1 + bytes[at];
    const values = [];
    for (let v = bytes[at++]; v > 0; v--) { values.push(bytes.subarray(at + 1, at + 1 + bytes[at]).toString('ascii')); at += 1 + bytes[at]; }
    types.push({ name, values });
  }
  return types;
}
const byCodePoint = values => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

for (const id of ['frog-kiln', 'paper-certificates']) {
  test(`${id}: private generated pictures, secrets, proofs and exact Create download bytes`, async t => {
    const example = loadExamples().find(e => e.id === id);
    mkdirSync('.cache/hidden-art', { recursive: true });
    const parentDirectory = mkdtempSync('.cache/hidden-art/test-');
    t.after(() => rmSync(parentDirectory, { recursive: true, force: true }));
    const local = await hidden.createHiddenArt(example, { parentDirectory });
    assert.equal(relative(parentDirectory, local.directory).includes('/'), false, 'generated kit belongs to the run-owned parent');
    const reveal = JSON.parse(readFileSync(`${local.directory}/reveal.json`, 'utf8'));
    const secret = JSON.parse(readFileSync(`${local.directory}/secret.json`, 'utf8'));
    assert.match(secret.seed, /^[0-9a-f]{64}$/);
    assert.equal(statSync(local.directory).mode & 0o777, 0o700);
    assert.equal(statSync(`${local.directory}/reveal.json`).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['check-ignore', local.directory], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), local.directory);
    assert.equal(reveal.items.length, Number(example.contents.size));
    assert.equal(reveal.format, 'squarehole.box-reveal-list/1');
    assert.equal(local.art.revealListId, zeroHash);
    const leaves = reveal.items.map(item => boxLeaf({ ...item, id: Number(item.id), traitsPacked: BigInt(item.traitsPacked) }, reveal.items.length));
    const tree = buildBoxTree(leaves, reveal.items.length);
    assert.equal(tree.root, local.art.revealRoot);
    for (const id of [1, reveal.items.length]) {
      assert.ok(verifyBoxProof(id, leaves[id - 1], tree.proof(id), tree.root, reveal.items.length));
      assert.equal(verifyBoxProof(id, zeroHash, tree.proof(id), tree.root, reveal.items.length), false);
    }

    // SH-AI-PLAN fix round 1: hidden art's table is sorted, the same for every deal (built from the kit's traits alone),
    // and every item's packed traits decode back to its own traits.
    const types = tableTypes(local.art.metadataTable);
    assert.deepEqual(types.map(type => type.name), byCodePoint(types.map(type => type.name)));
    for (const type of types) assert.deepEqual(type.values, byCodePoint(type.values));
    const assign = await import(new URL(`../../../../examples/boxes/${id}/assign.mjs`, import.meta.url));
    const kitTraits = assign.VARIANT_NAMES.map((name, i) => id === 'frog-kiln'
      ? [['Glaze', assign.TRAITS[i][0]], ['Crack', assign.TRAITS[i][1]]]
      : [['Company', name], ['Ink', assign.TRAITS[i][0]], ['Series', assign.TRAITS[i][1]]]);
    const fromKit = new Map();
    for (const [trait, value] of kitTraits.flat()) if (value) fromKit.set(trait, [...new Set([...(fromKit.get(trait) ?? []), value])]);
    assert.equal(local.art.metadataTable, metadataTableHex('', sortedTraitTypes([...fromKit].map(([name, values]) => ({ name, values })))));
    const traits = JSON.parse(readFileSync(`${local.directory}/items/traits.json`, 'utf8'));
    const attributes = JSON.parse(readFileSync(`${local.directory}/attributes.json`, 'utf8'));
    for (const [i, item] of reveal.items.entries()) {
      const packed = BigInt(item.traitsPacked);
      const decoded = types.flatMap((type, t) => { const v = Number((packed >> BigInt(8 * t)) & 0xffn); return v === 0 ? [] : [`${type.name}=${type.values[v - 1]}`]; });
      assert.deepEqual(byCodePoint(decoded), byCodePoint(traits[i].attributes.map(a => `${a.trait_type}=${a.value}`)), `item ${item.id}`);
      assert.deepEqual(attributes[item.id], traits[i].attributes.map(a => `{"trait_type":"${a.trait_type}","value":"${a.value}"}`));
    }

    const pngs = readdirSync(`${local.directory}/items`).filter(f => f.endsWith('.png'));
    assert.equal(pngs.length, reveal.items.length);
    for (const item of reveal.items) {
      const bytes = readFileSync(`${local.directory}/items/${item.id}.png`);
      assert.equal(hidden.sha256(bytes), item.imageSha256);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    const inputs = { creator: toHex(1n, { size: 20 }), factory: toHex(2n, { size: 20 }), listingId: '8', art: local.art };
    const listing = { id: 8, token: toHex(3n, { size: 20 }), decimals: 18, class: 5, kind: 1, raise: BigInt(example.raise.amount), burnSelector: '0x42966c68' };
    const { spec } = buildExampleSpec(example, inputs, listing, 4206980085000000000n);
    const filename = hidden.writeHiddenSettings(example, local, spec);
    const frame = boxSpecFile(spec, { pricing: listing, listings: [] });
    const expected = createHash('sha256').update(frame.parts[0]);
    let first = true;
    for (const picture of hidden.hiddenPictures(example, local.directory)) {
      assert.ok(picture.bytes.length <= 1048576);
      const part = `${first ? '' : ',\n'}    ${JSON.stringify({ role: picture.role, sha256: picture.sha256, base64: Buffer.from(picture.bytes).toString('base64') })}`;
      assert.ok(!part.includes(secret.seed));
      expected.update(part); first = false;
    }
    expected.update(frame.parts.at(-1));
    assert.match(frame.parts.at(-1), /"revealList": null/);
    const actual = createHash('sha256');
    for await (const chunk of createReadStream(filename)) actual.update(chunk);
    assert.equal(actual.digest('hex'), expected.digest('hex'), 'streamed file matches Create byte for byte');
    assert.throws(() => hidden.writeHiddenSettings(example, local, spec), /EEXIST/);
    const report = JSON.parse(readFileSync(`${local.directory}/size-report.json`, 'utf8'));
    assert.equal(report.items, example.contents.size);
    assert.equal(BigInt(report.totalPngBytes), pngs.reduce((sum, name) => sum + BigInt(statSync(`${local.directory}/items/${name}`).size), 0n));
  });
}
