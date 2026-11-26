// SIZE-B3: original ABI/storage preserved, with M3-23 funding companion and appended state.
// Run after forge build. The fixtures exclude compiler AST ids, never slots, offsets or field types.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const pins = read(new URL('./abi-pins.json', import.meta.url));

function normalize(data) {
  function typed(id) {
    const type = data.types[id];
    const result = Object.fromEntries(Object.entries(type).filter(([key]) => !['members', 'base', 'key', 'value'].includes(key)));
    for (const key of ['base', 'key', 'value']) {
      if (key in type) result[key] = typed(type[key]);
    }
    if (type.members) result.members = type.members.map(entry);
    return result;
  }
  function entry(member) {
    return Object.fromEntries(Object.entries(member)
      .filter(([key]) => !['astId', 'contract'].includes(key))
      .map(([key, value]) => [key, key === 'type' ? typed(value) : value]));
  }
  return data.storage.map(entry);
}

for (const [name, hash] of Object.entries(pins)) {
  const artifact = read(new URL(`out/${name}.sol/${name}.json`, root));
  assert.equal(createHash('sha256').update(JSON.stringify(artifact.abi)).digest('hex'), hash, `${name} ABI changed`);
  const layout = JSON.parse(execFileSync('forge', ['inspect', `src/box-v2/${name}.sol:${name}`, 'storageLayout', '--json'], {
    cwd: fileURLToPath(root), encoding: 'utf8',
  }));
  const short = name.slice(3, -2);
  assert.deepEqual(normalize(layout), read(new URL(`./${short}.layout.json`, import.meta.url)), `${name} storage changed`);
}
process.stdout.write('SIZE-B3: receiver ABI and storage match the M3-23 funding fixtures\n');
