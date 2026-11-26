#!/usr/bin/env node
/**
 * SH-261: a demo box created and lived on the REAL test network (chain 97) from keystores, one transaction at a time.
 *
 *   node packages/chain/scripts/bnb-boxes/real.mjs create <box> --rpc <url> --files <dir> --state <file>
 *     --creator <keystore> [--keeper <keystore or address: converter, checked to be the route's trigger>]
 *     [--password-file <path> | --password-dir <dir>] [--dry]
 *   node packages/chain/scripts/bnb-boxes/real.mjs life <box> --rpc <url> --files <dir> --state <file>
 *     --creator <keystore> --a <keystore> --b <keystore> [--keeper <keystore>] [--password-file <path> | --password-dir <dir>] [--dry]
 *     [--trade-after <raw price coin B buys per round after graduation>]
 *   node packages/chain/scripts/bnb-boxes/real.mjs status <box> --state <file>
 *
 * - Every transaction is prepared by this code (to, data, value, gas limit), signed by `cast mktx` with
 *   `--account <keystore name>` and `--password-file <path>` (a real signer must have one), both handed to cast unread:
 *   no key is in this process, a file or a command line. One at a time: the call, its nonce and the signed bytes with
 *   their hash are written to the state file, THEN `cast publish` broadcasts them, the receipt is awaited and its status
 *   checked, what it changed read back; only then the next. A new send is refused while the account has a pending
 *   transaction that is not this run's (the keeper's wallet: the keeper service must be dry or idle).
 * - The state file (`--state`, one per box) keeps the creation's run (kit, creator, coordinator, the sheet's digest) and
 *   every action and transaction of the life. A run started again with it first reconciles every kept send: mined with
 *   its call (status checked), or awaited, or (its nonce unused) its own bytes broadcast again; a nonce used by another
 *   call, a failed lookup or an older entry without its call stops the run plainly. Never a second approval or create.
 * - `--rpc` takes one or more of the runbook's public chain-97 endpoints (lane c's `ALLOWED_RPCS`), comma-separated,
 *   each answering chain id 97: sends go to the first; reads retry on a rate limit and may fail over to the others in
 *   the list. A dry run's fork is asked directly and only (never a public endpoint).
 * - `--dry` sends nothing: it starts a local fork of `--rpc` (anvil, 127.0.0.1:`--dry-port`, default a free port chosen at start and printed; a port that
 *   already answers is refused), lets the
 *   roles' addresses send there (impersonated on the fork only), runs the same steps from a copy of the state file and
 *   prints every transaction. The real chain and the state file are not touched.
 * - The proof of this mode on a local chain adds `--local-proof` (a loopback `--rpc` is then accepted) and
 *   `--keystore-dir <dir>` (keystore files there instead of cast's default folder).
 *
 * Boxes: `stock` (GPU Poor, holders paid in tNVDA); `converter` (The Alchemist, priced in tUSDC, a tNVDA pile through
 * route 6; on a dry run `--warp-to <its readyAt>` moves the fork's clock past the route's day); `rentfree` (Rent Free, 500 houses priced in tUSDC; `create` reads
 * its settings and items folder from .cache/bnb-boxes/rent-free/ (or `--settings`, `--items`) and, after a GREEN read-back, reveals every house in batches of 40 through Multicall3).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SH_TESTNET = 'bnb';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { castEndpoint, castSender, isLoopback, keystoreRole, makeChain, nodeSender, roleAddress, stateStore, setReadEndpoints, usedNonces } = await import('./chain.mjs');
const { sheetSpec } = await import('./readback.mjs');
const { parseAbi } = await import('viem');
const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { alchemistV21Abi } = await import('../../../../packages/chain/src/core/v2/alchemist-v21.ts');
const { startFork, freePort } = await import('./local-chain.mjs');
const { launch, releaseFiles, routeIdsOf } = await import('./launch.mjs');
const { holdersLife } = await import('./life.mjs');
const { revealAll, itemsLife } = await import('./items.mjs');
const { converterLife } = await import('./pile.mjs');
const { eatLife } = await import('./eat.mjs');
const { loadProfileExamples } = await import('../../../../packages/box-spec/examples/v2/registry.mjs');
const { rpc } = await import('./chain.mjs');

/** The demo boxes: their settings and their life. */
export const BOXES = Object.freeze({
  stock: { kit: 'gpu-poor', settings: 'examples/boxes/gpu-poor/settings/bnb/gpu-poor-boxspec-v2.json', life: 'holders' },
  // Its settings carry the public reveal list and its 500 models (96 MB), so they and the items folder are written to
  // .cache/ (settings.mjs rent-free --extras <file> --out <this> --items-out <the items folder>), never committed.
  rentfree: { kit: 'rent-free', settings: '.cache/bnb-boxes/rent-free/rent-free-boxspec-v2.json', items: '.cache/bnb-boxes/rent-free/items', life: 'items' },
  // The converter box (The Alchemist): priced in tUSDC, its buyers' fees converted into a tNVDA pile through route 6.
  // Its route is selectable from its readyAt (1795681089 on chain 97); its life's keeper must be the route's trigger.
  converter: { kit: 'the-alchemist', settings: 'examples/boxes/the-alchemist/settings/bnb/the-alchemist-boxspec-v2.json', life: 'converter' },
  // SH-286: a box priced in a coin launched on Flap (PILE, once listed), its fees eating that coin on both sides. Its
  // sheet is written by rail-sheet.mjs from the chain's listing; it is no registry kit.
  rail: { kit: 'pile-furnace', settings: '.cache/bnb-boxes/rail/pile-furnace-boxspec-v2.json', life: 'eat' },
  // The same coin, its fees paid to the box's holders in PILE (GPU Poor's rule; no directory row, no day to wait).
  railholders: { kit: 'pile-party', settings: '.cache/bnb-boxes/rail/pile-party-boxspec-v2.json', life: 'holders' },
});
const RAIL_ROWS = Object.freeze({
  rail: { id: 'pile-furnace', contents: { kind: 'token', size: '0' }, fees: { buyers: { choice: 'eat' }, sellers: { choice: 'eat' } } },
  railholders: { id: 'pile-party', contents: { kind: 'token', size: '0' }, fees: { buyers: { choice: 'holders' }, sellers: { choice: 'holders' } } },
});
const rowOf = box => RAIL_ROWS[box] ?? loadProfileExamples('bnb').find(row => row.id === BOXES[box].kit);

const json = value => `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;
const say = line => process.stdout.write(`${line}\n`);

function flags(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 1) {
    assert.ok(args[i].startsWith('--'), `unexpected ${args[i]}`);
    const key = args[i].slice(2);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) { o[key] = args[i + 1]; i += 1; } else o[key] = true;
  }
  return o;
}

const [command, box, ...rest] = process.argv.slice(2);
try {
  assert.ok(['create', 'life', 'status'].includes(command) && Object.hasOwn(BOXES, box ?? ''), `usage: real.mjs create|life|status ${Object.keys(BOXES).join('|')} --flags (see the head comment)`);
  const o = flags(rest);
  assert.ok(typeof o.state === 'string', '--state <file> is required (one per box)');
  const statePath = resolve(o.state);
  if (command === 'status') {
    const store = stateStore(statePath);
    say(json({ run: store.data.memo['create:run']?.coordinator ?? null, created: Boolean(store.data.memo['create:result']),
      actions: Object.keys(store.data.done), transactions: Object.entries(store.data.tx).map(([key, tx]) => `${key} ${tx.label} ${tx.hash}`) }));
    process.exit(0);
  }
  for (const name of ['rpc', 'files', 'creator']) assert.ok(typeof o[name] === 'string', `--${name} is required`);
  if (command === 'life') for (const name of ['a', 'b']) assert.ok(typeof o[name] === 'string', `--${name} <keystore> is required`);
  // --rpc a[,b,…]: sends go to the first; reads may fail over to the others on a rate limit (chain.mjs resilientFetch).
  const given = String(o.rpc).split(',').map(u => u.trim()).filter(Boolean);
  // The local proof's endpoints are all loopback (its own node and its fault proxy): never a public one; checked
  // before any endpoint is asked anything.
  if (o['local-proof'] === true) assert.ok(given.every(isLoopback), `--local-proof takes loopback endpoints only: ${given.join(', ')}`);
  const urls = [];
  for (const one of given) urls.push(await castEndpoint(one, { localProof: o['local-proof'] === true }));
  const url = urls[0];
  setReadEndpoints(urls, say);
  const filesDir = resolve(o.files);
  const { extras, manifest } = releaseFiles(filesDir);
  // --password-dir <dir>: each role's password file is <dir>/<keystore name>.pass; --password-file: one for all (or the
  // fallback). Paths only: cast reads them.
  const keystore = { keystoreDir: typeof o['keystore-dir'] === 'string' ? resolve(o['keystore-dir']) : null, passwordFile: typeof o['password-file'] === 'string' ? o['password-file'] : null,
    passwordDir: typeof o['password-dir'] === 'string' ? resolve(o['password-dir']) : null };
  const names = { creator: o.creator, ...(command === 'life' ? { a: o.a, b: o.b, keeper: typeof o.keeper === 'string' ? o.keeper : o.creator } : {}) };
  const roles = {};
  const impersonated = new Set();
  for (const [role, name] of Object.entries(names)) {
    // A dry run needs only the address, so it also takes one (0x…) instead of a keystore name; so does the local proof,
    // for an account no keystore holds (the route's trigger), impersonated on its local node only.
    if ((o.dry || o['local-proof'] === true) && /^0x[0-9a-fA-F]{40}$/.test(name)) {
      roles[role] = { name, address: name };
      if (!o.dry) impersonated.add(name.toLowerCase());
      say(`${role}: address ${name} (${o.dry ? 'dry run' : 'impersonated on the local proof\'s node'})`);
      continue;
    }
    // A real signer has a password file (its path goes to cast, unread).
    const entry = keystoreRole(name, { ...keystore, requirePassword: !o.dry });
    entry.address = await roleAddress(entry);
    roles[role] = entry;
    say(`${role}: keystore ${name}, address ${entry.address}${entry.password ? `, password file ${entry.password}` : ''}`);
  }
  const spec = BOXES[box];
  const real = stateStore(statePath);
  let fork = null;
  let chain;
  if (o.dry) {
    // The fork's upstream and its price reads use the list's second endpoint, if any, to spare the first's allowance.
    const upstream = urls[1] ?? url;
    // Its port: --dry-port, or a free one chosen now; a port that already answers is refused (local-chain.mjs anvil).
    fork = await startFork({ forkUrl: upstream, port: o['dry-port'] ? Number(o['dry-port']) : await freePort() });
    for (const role of Object.values(roles)) await rpc(fork.url, 'anvil_impersonateAccount', [role.address]);
    // A copy of the state in memory: the dry run continues where the real one stands and writes nothing.
    const copy = stateStore(null);
    Object.assign(copy.data, copy.plain(real.data));
    // Every dry send is priced as the real one (chain.mjs `sendPrice` against the real endpoint) and refused below
    // that endpoint's price: a fork takes any price, the real chain does not.
    chain = makeChain({ url: fork.url, sender: nodeSender(fork.url, { priceUrl: upstream }), store: copy, clock: 'warp', log: line => say(`[dry] ${line}`) });
    say(`dry run on a fork of ${upstream} at block ${await chain.client.getBlockNumber()} (${fork.url}); nothing is sent to ${url}`);
    // --warp-to <unix time>: the fork's clock is moved there first (a route's readyAt that the real chain reaches later).
    if (typeof o['warp-to'] === 'string') { await chain.mineTo(BigInt(o['warp-to'])); say(`[dry] the fork's clock moved to ${o['warp-to']}`); }
  } else {
    // The real chain's clock is waited for; the local proof moves its node's clock instead (its blocks come only with sends).
    const cast = castSender(url, Object.values(roles).filter(role => !impersonated.has(role.address.toLowerCase())), { used: usedNonces(real.data), log: say });
    let sender = cast;
    if (impersonated.size > 0) {
      assert.ok(isLoopback(url), 'an impersonated role only on the local proof\'s own node');
      for (const address of impersonated) await rpc(url, 'anvil_impersonateAccount', [address]);
      const node = nodeSender(url);
      const pick = from => (impersonated.has(from.toLowerCase()) ? node : cast);
      sender = { kind: 'cast', nonceUrls: cast.nonceUrls, prepare: tx => pick(tx.from).prepare(tx), publish: (prepared, tx) => pick(tx.from).publish(prepared, tx) };
    }
    chain = makeChain({ url, sender, store: real, clock: o['local-proof'] === true ? 'warp' : 'wait', log: say });
  }
  try {
    if (command === 'create') {
      const row = rowOf(box);
      // A converter route is selectable only from its readyAt: before it the factory refuses the createBox (measured on
      // a fork of the real chain: the approval goes out, the createBox's estimate reverts). The route ids of the sheet
      // that will be sent are read LIVE in the release's directory (readyAt, withdrawn) before anything is sent; launch
      // resolves them again before the approval and before createBox.
      const sheetPath = resolve(ROOT, typeof o.settings === 'string' ? o.settings : spec.settings);
      const sheet = sheetSpec(readFileSync(sheetPath, 'utf8'));
      // A sheet given with --settings must be this kit's: its kind, names, price coin, both fee sides, its contents
      // (the pile's settings) and add-ons equal the kit's own sheet (the raise and what follows from it may differ).
      if (typeof o.settings === 'string') {
        const own = sheetSpec(readFileSync(resolve(ROOT, spec.settings), 'utf8'));
        for (const field of ['boxType', 'tokenName', 'tokenSymbol', 'pricing', 'buyers', 'sellers', 'contentsParams', 'addOns', 'pickFeeBps', 'n']) {
          assert.equal(json(sheet[field]), json(own[field]), `the sheet ${o.settings} is not ${spec.kit}'s: its ${field} differs; nothing was sent`);
        }
        say(`the sheet ${o.settings} is ${spec.kit}'s (kind, names, price coin, fee sides, contents)`);
      }
      const routes = routeIdsOf(sheet);
      // A side that eats the price coin uses the directory's built-in row 0, selectable from the directory's first day
      // (26 November 2026, 15:15:02 +07 on chain 97): before it the factory refuses the createBox. Nothing is sent before.
      if ([sheet.buyers, sheet.sellers].some(side => Number(side.a.leg) === 1 && Number(side.a.dest) === 1)) {
        const selectable = await chain.read(manifest.releases[0].feeModuleDirectory.address, parseAbi(['function initialSelectable(uint32) view returns (bool)']), 'initialSelectable', [0]);
        assert.ok(selectable, `the eat module (the directory's row 0) is not selectable yet on this chain (its day: ${extras.feeModuleDirectory.modules.find(m => m.id === 0)?.readyAt}): nothing was sent`);
        say('the eat module (directory row 0) is selectable');
      }
      // A real converter creation needs the route's trigger as a keystore role (the life converts with it): --keeper
      // <keystore name>, its password file required, its address derived and compared before the approval.
      if (routes.length > 0 && !o.dry && o['local-proof'] !== true) {
        assert.ok(typeof o.keeper === 'string' && !/^0x/i.test(o.keeper), 'a real converter creation needs --keeper <the keystore of the route\'s trigger>: nothing was sent');
      }
      const directory = manifest.releases[0].feeModuleDirectory.address;
      for (const id of routes) {
        const [module, , readyAt, withdrawn] = await chain.read(directory, coreV2.feeModuleDirectoryV21Abi, 'record', [id]);
        // The life's keeper must be the route's trigger: checked now (with --keeper), not after the box exists.
        if (typeof o.keeper === 'string') {
          const trigger = await chain.read(module, alchemistV21Abi, 'conversionTrigger');
          const keeperAddress = /^0x[0-9a-fA-F]{40}$/.test(o.keeper) && (o.dry || o['local-proof'] === true) ? o.keeper
            : await roleAddress(keystoreRole(o.keeper, { ...keystore, requirePassword: !o.dry }));
          assert.equal(keeperAddress.toLowerCase(), trigger.toLowerCase(), `the keeper ${o.keeper} (${keeperAddress}) is not route ${id}'s trigger ${trigger}: the life could not convert; nothing was sent`);
          say(`the keeper ${o.keeper} is route ${id}'s trigger ${trigger}`);
        }
        const now = await chain.now();
        assert.ok(!withdrawn, `route ${id} is withdrawn: nothing was sent`);
        assert.ok(now >= readyAt, `route ${id} becomes selectable at ${readyAt} (${new Date(Number(readyAt) * 1000).toISOString()}); the chain's clock is ${now}: nothing was sent`);
        say(`route ${id} is selectable since ${readyAt}`);
      }
      const itemsDir = row.contents.kind === 'collection' ? resolve(ROOT, typeof o.items === 'string' ? o.items : spec.items) : null;
      const created = await launch({ rpcUrl: chain.url, filesDir, settingsPath: sheetPath, creator: roles.creator.address, sender: chain.sender, store: chain.store, itemsDir, kit: spec.kit,
        rebuildDir: resolve(ROOT, '.cache/bnb-boxes/rebuilt'), clock: o.dry || o['local-proof'] === true ? 'warp' : 'wait', log: o.dry ? line => say(`[dry] ${line}`) : say });
      for (const row of created.readBack.rows) say(`${row.same ? 'same' : 'DIFF'}  ${row.group} / ${row.field}${row.same ? '' : `: sheet ${json(row.sheet).trim()}, chain ${json(row.chain).trim()}`}`);
      say(`created ${created.coordinator}; read-back ${created.readBack.ok ? 'GREEN' : 'RED'}: ${created.readBack.rows.filter(r => r.same).length} of ${created.readBack.rows.length} fields equal (createBox ${created.readBack.createTx})`);
      if (!created.readBack.ok) { process.exitCode = 1; throw new Error('the read-back is RED: nothing more is sent'); }
      const revealText = chain.store.data.memo['create:revealFile'];
      if (revealText) {
        // The box's own reveal file: the salts every reveal needs. Kept beside the state file for the creator.
        if (!o.dry) writeFileSync(`${statePath}.reveal.json`, revealText);
        const revealed = await revealAll(chain, created.coordinator, revealText, roles.creator.address);
        say(`revealed ${revealed.total} items in ${revealed.batches.length} sends (collection ${revealed.collection})`);
      }
    } else {
      // The life runs only on the box of this state file's own GREEN read-back; --box, if given, must be that box.
      const result = chain.store.data.memo['create:result'];
      assert.ok(result?.readBack?.ok === true, 'the state file holds no GREEN read-back of a created box: run create first');
      const coordinator = result.coordinator;
      if (typeof o.box === 'string') assert.equal(o.box.toLowerCase(), coordinator.toLowerCase(), `--box ${o.box} is not this state file's box ${coordinator}`);
      if (chain.store.data.memo['create:kit'] !== undefined) assert.equal(chain.store.data.memo['create:kit'], spec.kit, `the state file is ${chain.store.data.memo['create:kit']}'s, not ${spec.kit}'s`);
      // A life record in an older format (the two finished real lives: sends saved without their calldata, or a hash
      // without its nonce) is refused before any send.
      const old = Object.values(chain.store.data.tx).filter(slot => (slot.nonce !== undefined && slot.nonce !== null && !slot.data) || (slot.hash && (slot.nonce === undefined || slot.nonce === null)));
      if (old.length > 0) throw Object.assign(new Error(`this life is complete: its record holds ${old.length} sends in an older format; nothing was sent`), { plain: true });
      const before = {};
      for (const [role, entry] of Object.entries(roles)) before[role] = await chain.client.getBalance({ address: entry.address });
      const row = rowOf(box);
      // --trade-after <raw price coin>: what B buys per round after graduation (default a tenth of the raise).
      const tradeAfter = typeof o['trade-after'] === 'string' ? BigInt(o['trade-after']) : null;
      const parties = { swapper: extras.trade.swapper, keeper: roles.keeper.address, a: roles.a.address, b: roles.b.address, tradeAfter };
      const life = spec.life === 'holders' ? await holdersLife(chain, coordinator, parties)
        : spec.life === 'converter' ? await converterLife(chain, coordinator, { ...parties, fees: row.fees })
        : spec.life === 'eat' ? await eatLife(chain, coordinator, parties)
          : await itemsLife(chain, coordinator, { ...parties, fees: row.fees, size: Number(row.contents.size) });
      if (life.conversion) {
        say(`converted ${life.conversion.amountIn} raw price coin into ${life.conversion.amountOut} raw tNVDA in the pile (${life.conversion.hash}${life.conversion.by ? `, by ${life.conversion.by}` : ''})`);
        say(`sale fees sold: ${life.feesSold.sold} raw price coin (${life.feesSold.steps.map(step => step.hash).join(', ')}); burned ${life.burned.tBurned} raw LEAD (${life.burned.hash})`);
        say(`A redeemed ${life.redeemed.amount} raw LEAD for ${life.redeemed.received} raw tNVDA`);
      }
      for (const c of life.claimed ?? []) say(`claimed ${c.quote} raw price coin by ${c.holder}`);
      if (life.claim) say(`house 1: taken out for ${life.taken.paid} raw box tokens; its owner claimed ${life.claim.received} raw price coin`);
      for (const [role, entry] of Object.entries(roles)) say(`${role}: gas paid ${life.gasPaid[entry.address.toLowerCase()] ?? 0n} wei over this state file`);
      // The result file carries the evidence (hashes, amounts); GREEN is printed after it is written.
      if (typeof o.out === 'string') writeFileSync(resolve(o.out), json(life));
      for (const e of life.eats ?? []) say(`ate ${e.amount} raw price coin (${e.burned ? 'burned' : 'to 0xdEaD'}) in ${e.hash}`);
      say(life.eats ? `life GREEN: ${life.total} raw price coin eaten in ${life.eats.length} eats` : life.claimed ? `life GREEN: ${life.claimed.length} claims, ${life.total} raw price coin paid to holders` : life.claim ? `life GREEN: house 1 paid ${life.claim.received} raw price coin to its owner`
        : `life GREEN: ${life.conversion.amountOut} raw tNVDA converted into the pile, ${life.burned.tBurned} raw LEAD burned, ${life.redeemed.received} raw tNVDA paid on a redemption`);
    }
  } finally {
    if (fork) fork.stop();
  }
} catch (error) {
  console.error(`real run stopped: ${error.plain ? error.message : error.stack ?? error.message}`);
  process.exitCode = 1;
}
