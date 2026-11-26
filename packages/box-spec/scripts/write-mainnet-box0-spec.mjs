#!/usr/bin/env node
/** Box 0, readiness step 7. Public inputs only; no key, seed, salt, RPC or broadcast. See box0-spec.1.README.md. */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAddress, keccak256, toHex } from 'viem';
import { loadBoxSpecLibrary } from './lib/load-generated.mjs';

// Pinned from sh-box0-commitment-exporter-fix1 c81400c8, box0-export/placeholders.ts (six roots).
export const KNOWN_TEST_ROOTS = [
  '0xf983840bf08a7deb54c03a65382418390b9cdc259e2152a01d56d340ca3679ec',
  '0x3d88f4cc193a1debaa14062d0866edba43dd836564dcb36f2234517b98fa922d',
  '0x96ab1aa34dca451e37eb23c6f4010ae2c3d8546868120b79abbee6913654614a',
  '0xfe3ba00e7949b9bed0fb17f7af5e0e101b581ec6d328bf0dec0330bba08842fc',
  '0xdfc000d2ce029fc889fb15f05384153d543afc63a3a60a22e302ee11bcb0979f',
  '0xfdbae7713f2c54f1f75970cddee81cf4fb1ef9d17c69255b85b90fe34e6c26fc',
];
const TEST_GENERATORS = [
  '0xe95521689a770d6d7b423c18b6d84d6556192211000000000000000000000000',
  '0x328f60269102b38166998b931526ce934f7876ee07c549e2949bf59278db9a2b',
  '0xb2bef4c106e7a62014645962d428e333da58b8eff38557696e8190a29b88950a',
  '0x31349e9b3d9338f711f34c6a3acebc4b758707c5000000000000000000000000',
];
// The same four test tables, with an empty description: changing copy cannot disguise a test value order.
const TEST_VALUE_ORDERS = [
  '0x74133bce98ccde702e998fb1f169d7cca4e5e45b7ec6b8c6f3f8266eaae15bd5',
  '0x4e532a53109b18ee626a991269ee539eea286ac5d7d09df98260e7791c560351',
  '0xce04267df9ec0981d300bad3bb068c6a3e5c40b608f5d8093d3550cef27c1279',
  '0xb2df09c48efaf1631201bc525910538158eb497b795a366cae434c45ac2ec2e6',
];
const ZERO = `0x${'0'.repeat(64)}`;
const DEFAULT_OUT = fileURLToPath(new URL('../../contracts/script/config/box0-spec.1.json', import.meta.url));
const DEFAULT_ENCODING = {
  image: { format: 'webp', size: 512, quality: 90 },
  avatar: { format: 'webp', size: 256 },
  model: { format: 'glb' },
};
const ESCROW_MODES = ['trustees-2-of-3', 'zama-plus-floor', 'floor-only'];

class Refusal extends Error {}
function requireThat(condition, message) { if (!condition) throw new Refusal(message); }
function hash(value, field) {
  requireThat(typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value), `${field}: expected bytes32`);
  return value.toLowerCase();
}
function treeHash(tree, field) {
  requireThat(typeof tree === 'string' && /^(?:[\da-f]{40}|[\da-f]{64})$/.test(tree), `${field}: expected a git tree id`);
  const h = `0x${tree.padEnd(64, '0')}`;
  requireThat(h !== ZERO && !TEST_GENERATORS.includes(h), `${field}: test generator refused`);
  return h;
}
function openingTime(value, now) {
  let time;
  if (typeof value === 'number' && Number.isSafeInteger(value)) time = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) time = BigInt(value);
  else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z$/.test(value)) {
    const canonical = value.length === 17 ? value.replace('Z', ':00Z') : value;
    const ms = Date.parse(canonical);
    requireThat(Number.isFinite(ms) && new Date(ms).toISOString() === canonical.replace('Z', '.000Z'), 'openAt: invalid UTC time');
    time = BigInt(ms / 1000);
  }
  requireThat(time !== undefined, 'openAt: supply a UTC clock time or Unix seconds');
  requireThat(time >= now + 2700n, 'openAt: must be at least 45 minutes ahead');
  requireThat(time <= now + 1209600n, 'openAt: must be at most 14 days ahead');
  requireThat(time <= 0xffffffffn, 'openAt: outside uint32');
  return Number(time); // Unix time only. Raw economic amounts stay bigint in BoxSpecV1.
}
function encodingFile(got, want, field) {
  requireThat(want && ['webp', 'png', 'jpeg'].includes(want.format) && Number.isSafeInteger(want.size) && want.size > 0,
    `${field} encoding: invalid expectation`);
  requireThat(want.quality === undefined || (Number.isInteger(want.quality) && want.quality >= 0 && want.quality <= 100),
    `${field} encoding: invalid quality`);
  requireThat(got && got.format === want.format && got.size === want.size &&
    (want.quality === undefined || got.quality === want.quality), `${field} encoding differs from launch inputs`);
  requireThat(got.quality === undefined || (Number.isInteger(got.quality) && got.quality >= 0 && got.quality <= 100),
    `${field} encoding: invalid exported quality`);
  return { format: got.format, size: got.size, ...(got.quality === undefined ? {} : { quality: got.quality }) };
}

/** The export binds bytes, value order, rendering provenance and founder choices; no private inputs are needed. */
export async function buildMainnetSpec(commitment, table, inputs, now = BigInt(Math.floor(Date.now() / 1000))) {
  const lib = await loadBoxSpecLibrary();
  const { BOX_0_MISFITS } = await import('../src/generated/fixtures.v1.ts');
  const { encodeBoxMetadataTable } = await import('../../artwork/src/box-commitment.ts');
  requireThat(commitment?.format === 'squarehole.box0-commitment/1', 'wrong public commitment format');
  requireThat(commitment.n === 4269 && commitment.depth === 13, 'wrong edition size or depth');
  const revealRoot = hash(commitment.root, 'root');
  requireThat(revealRoot !== ZERO && !KNOWN_TEST_ROOTS.includes(revealRoot), 'test or zero root refused');
  const generatorHash = hash(inputs?.generatorHash, 'generator hash');
  requireThat(!TEST_GENERATORS.includes(generatorHash), 'test generator refused');
  requireThat(generatorHash === hash(commitment.generatorHash, 'exported generator hash'), 'generator hash differs from export');
  const renderHash = treeHash(commitment.renderGeneratorTree, 'render generator');
  if (generatorHash === ZERO) {
    requireThat(commitment.generatorTree === null, 'zero generator hash needs null generatorTree');
  } else {
    requireThat(treeHash(commitment.generatorTree, 'generator tree') === generatorHash, 'generator hash differs from tree');
    requireThat(commitment.generatorTree === commitment.renderGeneratorTree && renderHash === generatorHash,
      'render generator differs from committed generator');
  }
  requireThat(typeof inputs.safe === 'string' && isAddress(inputs.safe) && !/^0x0{40}$/i.test(inputs.safe), 'Safe must be a nonzero address');
  const logoSha256 = hash(inputs.logoSha256, 'logo sha256');
  requireThat(logoSha256 !== ZERO && logoSha256 !== BOX_0_MISFITS.coverSha256, 'logo must be the founder-selected PNG digest');
  const openAt = openingTime(inputs.openAt, now);
  requireThat(table?.format === 'squarehole.box-trait-table/1' && typeof table.table === 'string' &&
    /^0x(?:[\da-f]{2})+$/i.test(table.table), 'invalid metadata table format or bytes');
  const metadataTable = table.table.toLowerCase();
  const spec = { ...BOX_0_MISFITS, revealRoot, generatorHash, metadataTable, openAt,
    marketplaceOwner: inputs.safe, coverSha256: logoSha256 };
  const verdict = lib.validateBoxSpecV1(spec, lib.CONTEXT_V1);
  requireThat(verdict.reason === 0, 'BoxSpecV1 validation refused the spec');
  const bytes = Buffer.from(metadataTable.slice(2), 'hex');
  const valueOrderHash = keccak256(toHex(Buffer.concat([Buffer.from([1, 0, 0]), bytes.subarray(3 + bytes.readUInt16BE(1))])));
  requireThat(!TEST_VALUE_ORDERS.includes(valueOrderHash), 'test table refused');
  requireThat(hash(commitment.metadataTable?.hash, 'table hash') === keccak256(metadataTable), 'table hash differs from export');
  requireThat(commitment.metadataTable.bytes === bytes.length, 'table length differs from export');
  requireThat(hash(commitment.metadataTable.valueOrderHash, 'value order') === valueOrderHash, 'value order differs from export');
  let listed;
  try {
    listed = toHex(encodeBoxMetadataTable({ description: table.description ?? '',
      traitTypes: table.types.map((t) => ({ name: t.name, values: t.list })) }));
  } catch { throw new Refusal('invalid table lists'); }
  requireThat(listed === metadataTable, 'table lists differ from table bytes');
  const expected = inputs.encoding ?? DEFAULT_ENCODING;
  const encoding = {
    image: encodingFile(commitment.encoding?.image, expected.image, 'image'),
    avatar: expected.avatar === null ? null : encodingFile(commitment.encoding?.avatar, expected.avatar, 'avatar'),
    model: { format: 'glb' },
  };
  if (expected.avatar === null) requireThat(commitment.encoding?.avatar === null, 'avatar encoding differs from launch inputs');
  requireThat(expected.model?.format === 'glb' && commitment.encoding?.model?.format === 'glb', 'model encoding must be glb');
  const escrowIntent = inputs.escrowIntent ?? 'trustees-2-of-3';
  requireThat(ESCROW_MODES.includes(escrowIntent) && commitment.archive?.escrowIntent === escrowIntent, 'escrow intent differs from launch inputs');
  return {
    format: 'squarehole.box0-spec/1', chainId: 1, build: 'mainnet', platform: spec.marketplaceOwner,
    specHash: lib.specHash(spec), openAt, openAtUtc: new Date(openAt * 1000).toISOString(),
    commitment: { root: revealRoot, metadataTableHash: keccak256(metadataTable), metadataTableBytes: bytes.length,
      valueOrderHash, renderGeneratorTree: commitment.renderGeneratorTree, escrowIntent, encoding },
    summary: { tokenName: spec.tokenName, tokenSymbol: spec.tokenSymbol, collectionName: spec.collectionName,
      collectionSymbol: spec.collectionSymbol, n: spec.n, raiseWei: spec.raise.toString(), revealRoot,
      generatorHash, coverSha256: spec.coverSha256, collectionCoverSha256: spec.collectionCoverSha256 },
    encoded: lib.encodeBoxSpecV1(spec),
  };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refusal('cannot read input JSON'); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node packages/box-spec/scripts/write-mainnet-box0-spec.mjs --commitment <public.json> --table <table.json> --inputs <launch.json> [--out <new-spec.json>]\n');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    requireThat(['--commitment', '--table', '--inputs', '--out'].includes(key) && !options[key] &&
      args[i + 1] && !args[i + 1].startsWith('--'), 'invalid, duplicate or missing command option');
    options[key] = args[i + 1];
  }
  requireThat(options['--commitment'] && options['--table'] && options['--inputs'], 'commitment, table and launch inputs are required');
  const output = await buildMainnetSpec(readJson(options['--commitment']), readJson(options['--table']), readJson(options['--inputs']));
  try { writeFileSync(options['--out'] ?? DEFAULT_OUT, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' }); }
  catch { throw new Refusal('cannot create output: it must be a new file in an existing directory'); }
  process.stdout.write('Mainnet box 0 spec written. No deployment performed.\n');
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  main().catch((error) => {
    // Parser, library and filesystem errors can contain input values or local paths. Never echo them.
    process.stderr.write(`${error instanceof Refusal ? error.message : 'mainnet spec refused: invalid public inputs'}\n`);
    process.exitCode = 1;
  });
}
