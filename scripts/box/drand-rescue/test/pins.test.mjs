import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { read, canonical, v, runtime } from './model.mjs';
import { signatureXY, decompress, compress, P } from '../signature.mjs';
import { CHAIN_HASH, GENESIS, PERIOD, SILENCE, SILENCE_UNREQUESTED, PINS, RELAYS } from '../quicknet.mjs';
import { ABIS, SIGNATURES } from '../abi.mjs';

test('n: independent Python G1 port agrees with every committed vector', () => {
  for (const name of ['drand-quicknet', 'drand-quicknet-box']) {
    const data = JSON.parse(read(`packages/contracts/test/vectors/${name}.json`));
    for (let i = 0; i < data.rounds.length; i++) {
      const published = { round: String(data.rounds[i]), signature: data.signatures[i].slice(2),
        randomness: data.randomness[i].slice(2) };
      assert.equal(signatureXY(published, BigInt(data.rounds[i])), data.signaturesXY[i]);
      assert.equal(compress(...decompress(published.signature)), published.signature);
    }
  }
});

test('n: refuses flags, field overflow, off-curve, wrong randomness and round', () => {
  const x = n => n.toString(16).padStart(96, '0');
  for (const raw of [x(0n), x(3n << 382n), x((1n << 383n) | P), x((1n << 383n) | 1n)]) {
    const data = { round: '1', signature: raw, randomness: createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex') };
    assert.throws(() => signatureXY(data, 1n));
  }
  const data = JSON.parse(read('packages/contracts/test/vectors/drand-quicknet.json'));
  assert.throws(() => signatureXY({ round: '1', signature: data.signatures[0].slice(2), randomness: '00'.repeat(32) }, 1n));
  assert.throws(() => signatureXY({ round: '2', signature: data.signatures[0].slice(2), randomness: data.randomness[0].slice(2) }, 1n));
});

test('o: constants drift pins use source text, never import generated configuration', () => {
  const pins = read('packages/contracts/src/box/randomness/DrandSourcePins.sol');
  for (const [chain, suffix] of [['1', 'MAINNET'], ['11155111', 'SEPOLIA']]) {
    assert.equal(PINS[chain].address.toLowerCase(), pins.match(new RegExp(`ADDRESS_${suffix} = (0x[\\da-fA-F]+)`))[1].toLowerCase());
    assert.equal(PINS[chain].codeHash, pins.match(new RegExp(`CODE_HASH_${suffix} = (0x[\\da-f]+)`))[1]);
    assert.equal(v.keccak256(runtime), PINS[chain].codeHash);
  }
  const python = read('packages/contracts/script-py/drand_vectors.py');
  assert.equal(CHAIN_HASH, python.match(/CHAIN_HASH = "([^"]+)"/)[1]);
  assert.equal(GENESIS, BigInt(python.match(/GENESIS_TIME = ([\d_]+)/)[1].replaceAll('_', '')));
  assert.equal(PERIOD, BigInt(python.match(/PERIOD = (\d+)/)[1]));
  const tickets = read('packages/contracts/src/box/BoxTickets.sol');
  assert.equal(SILENCE, BigInt(tickets.match(/SILENCE = (\d+) days/)[1]) * 86400n);
  assert.equal(SILENCE_UNREQUESTED, BigInt(tickets.match(/SILENCE_UNREQUESTED = (\d+) days/)[1]) * 86400n);
  assert.deepEqual(RELAYS, ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com']);
});

const shape = list => list?.map(({ type, components, indexed }) => ({
  type, ...(components ? { components: shape(components) } : {}), indexed: Boolean(indexed),
}));
test('o: every ABI selector, outputs, mutability and event layout match canonical text', () => {
  const errors = new Set();
  for (const [name, abi] of Object.entries(ABIS)) {
    if (name === 'backedSource') continue; // Source declarations are pinned in backed-pins.test.mjs.
    const original = canonical(name);
    for (const fragment of abi) {
      const other = original.find(e => e.type === fragment.type && e.name === fragment.name);
      assert.ok(other, `${name}.${fragment.name}`);
      if (fragment.type === 'function' || fragment.type === 'error') {
        assert.equal(v.toFunctionSelector(fragment), v.toFunctionSelector(other));
      }
      assert.deepEqual(shape(fragment.inputs), shape(other.inputs));
      assert.deepEqual(shape(fragment.outputs), shape(other.outputs));
      assert.equal(fragment.stateMutability, other.stateMutability);
      if (fragment.type === 'error') errors.add(fragment.name);
    }
  }
  for (const name of ['WordAlreadyRequested', 'WordAlreadyAccepted', 'WordNotReady', 'RoundKnown',
    'RoundNotYet', 'InvalidSignature', 'HeadNotDead', 'NothingPending']) assert.ok(errors.has(name), name);
});

test('p: runbook cast signatures, script paths, laptop setup and package gates', () => {
  const text = read('docs/runbooks/never-stuck.md');
  for (const signature of Object.values(SIGNATURES)) assert.ok(text.includes(`'${signature}'`), signature);
  for (const name of ['status()', 'requestOf(address,uint256)', 'wordOf(address,uint256)']) assert.ok(text.includes(name));
  assert.ok(read('packages/contracts/scripts/drand-round.py'));
  for (const phrase of ['7 days', '30 days', 'deadline', '24.22.1', 'blind signing', '0.01 ETH',
    'pnpm install', 'pnpm rescue:box0 --rpc <url> --ledger']) assert.ok(text.includes(phrase), phrase);
  const start = text.indexOf('\n## Turning it on\n');
  assert.ok(start >= 0, 'Turning it on');
  const section = text.slice(start + 1, text.indexOf('\n## ', start + 1));
  const steps = [...section.matchAll(/(?:^|\n)\d\. ([\s\S]*?)(?=\n\d\. |\n\n|\n?(?![\s\S]))/g)].map(m => m[1]);
  assert.equal(steps.length, 3);
  for (const phrase of ['Hetzner Cloud', 'Ubuntu 24.04', 'setup.sh', 'release tag']) assert.ok(steps[0].includes(phrase), phrase);
  for (const phrase of ['DRAND_RESCUE_RPC_URL', 'DRAND_RESCUE_KEY_FILE', 'DRAND_RESCUE_MAILER_URL',
    'DRAND_RESCUE_MAILER_TOKEN', '0600', 'header check']) assert.ok(steps[1].includes(phrase), phrase);
  for (const phrase of ['systemctl enable --now squarehole-rescue.timer', 'systemctl start squarehole-rescue.service', 'email']) assert.ok(steps[2].includes(phrase), phrase);
  for (const phrase of ['ETH_RPC_URL', 'debug_getRawHeader', 'cast keccak', '--field hash', 'two unnamed fields']) assert.ok(section.includes(phrase), phrase);
  assert.doesNotMatch(section, /--rpc-url|--rpc /);
  assert.match(text, /header raw ok.*header fields ok/s);
  assert.match(text, /run again after/);
  assert.match(text, /keys read 64 of/);
  // SH-RC8-DRAND-RESCUE requests 9 and 10: the keeper's poster document and the monitoring runbook's incident row
  // point here, worded as the lane's evidence gives them; since F145 the row checks the Hetzner service's journal
  // and the email heartbeat (SH-RC8-RESCUE-FOLLOWUPS request 7, SH-RC8-MONITOR-FOLLOWUPS request 6).
  const poster = read('docs/ops/drand-poster.md').split('\n\n');
  assert.equal(poster[2], 'The independent hourly poster and founder Ledger fallback are in [Never stuck](../runbooks/never-stuck.md).');
  const rows = read('docs/runbooks/monitoring.md').split('\n').filter(l => l.startsWith('| Drand nearing silence'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].endsWith(' Run the [second poster / Ledger fallback](never-stuck.md) immediately for a live head; check its service journal and email heartbeat. |'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['rescue:box0'], 'node scripts/box/drand-rescue/rescue.mjs --now');
  assert.equal(pkg.scripts['test:rescue'], 'node --test scripts/box/drand-rescue/test/*.test.mjs');
  assert.equal(pkg.scripts['test:rescue-e2e'], 'node --test scripts/box/drand-rescue/e2e/*.test.mjs');
  assert.ok(pkg.scripts['test:scripts'].includes('pnpm test:rescue'));
  assert.ok(!pkg.scripts.verify.includes('test:rescue-e2e'));
});
