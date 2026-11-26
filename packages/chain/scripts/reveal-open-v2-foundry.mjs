/** Copy the contract build settings into scratch with read access to the generated public replay vector.
 * Foundry anchors relative paths at the alternate config's directory. No tracked build setting is edited.
 * Run from the repository root, after reveal-open-v2.test.ts has produced its vector.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
const dir = '.cache/tmp/ex-l4-foundry';
const base = '../../../packages/contracts/';
let config = readFileSync('packages/contracts/foundry.toml', 'utf8');
config = config.replace(/^(src|test) = "([^"]+)"/gm, (_match, key, value) => `${key} = "${base}${value}"`);
config = config.replace('libs = ["lib"]', `libs = ["${base}lib"]`);
config = config.replaceAll('=lib/', `=${base}lib/`).replaceAll('=src/', `=${base}src/`);
config = config.replace(/\bpath = "([^"]+)"/g, (_match, value) => `path = "${posix.normalize(base + value)}"`);
config = config.replaceAll('paths = "lib/', `paths = "${base}lib/`);
config = config.replace('fs_permissions = [', 'fs_permissions = [\n  { access = "read", path = ".." },');
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/foundry.toml`, config);
