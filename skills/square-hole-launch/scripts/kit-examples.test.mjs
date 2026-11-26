import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { jsonSchema, loadExamples } from '../../../packages/box-spec/examples/v2/registry.mjs';
import { SEPOLIA_STAND_INS } from '../../../scripts/kits/catalog.mjs';

const repo = new URL('../../../', import.meta.url);
const skill = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, skill), 'utf8');
const rows = new Map(loadExamples().map(row => [row.id, row]));
// Every step a registry row can be pending on (EXAMPLE-LIFE, ALCHEMIST-REGISTRATION, ...).
const STEPS = jsonSchema.properties.pendingStep.enum;
const { encodeAbiParameters, keccak256, zeroHash } = createRequire(new URL('../../../packages/chain/package.json', import.meta.url))('viem');
const kits = readdirSync(new URL('examples/boxes/', repo), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

for (const id of kits) {
  test(`${id}: worked recipe equals its complete registry row`, () => {
    const doc = read(`references/v2/kits/${id}.md`);
    const block = doc.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(block, 'include the exact registry recipe, separate from settings');
    assert.deepEqual(JSON.parse(block[1]), rows.get(id));
    assert.ok(doc.includes(`examples/boxes/${id}/README.md`), 'link the kit');
    assert.match(doc, /Load settings/);
    if (rows.get(id).status === 'ready') for (const step of STEPS) assert.ok(!doc.includes(step), `names ${step}, but ${id} is ready`);
  });
}

for (const [file, id] of [
  ['examples/bag-holders', 'bag-holders'], ['examples/exit-liquidity', 'exit-liquidity'],
  ['examples/junkyard-shop', 'junkyard'], ['examples/dragons-hoard', 'dragons-hoard'],
  ['configurations/link-marines', 'link-marines-v2'], ['presets/link-marines', 'link-marines-v2'],
  ['configurations/stock-priced', 'gpu-poor'],
]) {
  test(`${file}: draft economics match the registry`, () => {
    const text = read(`references/v2/${file}.json`);
    const doc = JSON.parse(text);
    const row = rows.get(id);
    const spec = doc.spec;
    // SH-EX-LMV2 fix round: a draft tied to a ready row never says the registry still waits on a step.
    if (row.status === 'ready') {
      for (const step of STEPS) assert.ok(!text.includes(step), `${file} names ${step}, but ${id} is ready`);
      assert.doesNotMatch(text, /\bawaits?\b/i, `${file}: ${id} is ready`);
    }
    assert.equal(spec.tokenName, row.name);
    assert.equal(spec.tokenSymbol, row.ticker);
    assert.equal(String(spec.n), row.contents.size);
    // Demo drafts name issuer symbols (PAXG); a registry row may name the Sepolia stand-in (TEST_GOLD) of the same coin.
    const sameCoin = spec.pricing === row.priceCoin.symbol
      || (SEPOLIA_STAND_INS[spec.pricing] !== undefined && SEPOLIA_STAND_INS[spec.pricing] === SEPOLIA_STAND_INS[row.priceCoin.symbol]);
    assert.ok(sameCoin, `${spec.pricing} is not the registry's ${row.priceCoin.symbol}`);
    assert.equal(String(spec.deadlineDays), row.deadline.days);
    assert.equal(String(spec.pickFeeBps), row.contents.pickFeeBps);
    assert.equal(spec.boxType, { token: 'TOKEN_ONLY', collection: 'NEW_COLLECTION', shop: 'SHOP', pile: 'PILE' }[row.contents.kind]);
    if (row.contents.kind === 'collection') assert.equal(spec.artMode, row.contents.art.mode.toUpperCase());
    for (const side of ['buyers', 'sellers']) {
      const fees = row.fees[side];
      const [leg, dest] = {
        burn: ['BuyT', 'Eat'], eat: ['AsPaid', 'Eat'], grow: ['AsPaid', 'Depth'],
        items: ['AsPaid', 'Items'], holders: ['AsPaid', 'Holders'],
        shop: ['BuyT', 'BudgetOrPile'], pile: ['AsPaid', 'BudgetOrPile'],
      }[fees.choice];
      assert.equal(spec[side].split, 'NoSplit');
      assert.equal(spec[side].a.leg, leg);
      assert.equal(spec[side].a.dest, dest);
      if (fees.inside) assert.equal(spec[side].a.destParams.insidePolicy, { keep: 'Keep', burn: 'BuyBackBurn', depth: 'Depth' }[fees.inside]);
      if (fees.ceilingPreset) assert.equal(String(spec[side].a.destParams.ceilingPreset), fees.ceilingPreset);
    }
    const royalties = spec.addOns.find(a => a.addOn === 'royalties');
    assert.equal(String(royalties?.params.bps ?? '0'), row.royalties.bps);
    if (row.contents.kind === 'pile') {
      assert.equal(spec.contentsParams.seedAmount, row.contents.seed.amount);
      assert.equal(spec.contentsParams.leaveBehindBps, row.contents.leaveBehindBps);
    }
    if (row.contents.kind === 'shop') {
      for (const field of ['seedT', 'givePricesT', 'pickBps', 'weeklyBps', 'collectionBps', 'listDelay']) {
        assert.deepEqual(spec.contentsParams[field], row.contents.shop[field]);
      }
      assert.equal(String(spec.addOns.find(a => a.addOn === 'starter-set').params.count), '10');
      assert.match(doc.brief, /Safe/);
      assert.deepEqual(doc.creatorPolicy, row.creator);
      const expected = row.contents.shop.collections.flatMap((c, i) => c.starterIds.map(id => ({
        collection: spec.contentsParams.collections[i], id, tier: c.tier,
      })));
      assert.deepEqual(doc.starterSet, expected);
      let hash = zeroHash;
      for (const item of [...expected].reverse()) hash = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }],
        [item.collection, BigInt(item.id), BigInt(item.tier), hash],
      ));
      assert.equal(spec.addOns.find(a => a.addOn === 'starter-set').params.setHash, hash);
    }
  });
}

test('kit entry path distinguishes settings, bindings and pending recipes', () => {
  const doc = read('SKILL.md');
  assert.match(doc, /## Start from a kit/);
  assert.match(doc, /Load settings/);
  assert.match(doc, /choose the listing/i);
  assert.match(doc, /ALCHEMIST-REGISTRATION/);
  const pile = read('references/v2/spec-json.md');
  assert.doesNotMatch(pile, /illustrates 1000 USDC seed|USDC grow-both-sides/);
  assert.match(pile, /1 ETH seed/);
});

test('pending Alchemist gives review steps, never instructions to load and sign now', () => {
  const doc = read('references/v2/kits/the-alchemist.md');
  assert.match(doc, /Do not use Load settings/);
  assert.doesNotMatch(doc, /choose \*\*Load settings\*\* and select that file/);
});

for (const id of ['frog-kiln', 'paper-certificates']) {
  test(`${id}: public template and manifest are named in the skill and kit guides`, () => {
    const base = `examples/boxes/${id}`;
    const settings = `${base}/settings/${id}-boxspec-v2.json`;
    const plan = `${base}/settings/${id}-plan.json`;
    for (const path of [settings, plan]) assert.ok(existsSync(new URL(path, repo)), path);
    const manifest = JSON.parse(readFileSync(new URL(plan, repo), 'utf8'));
    assert.equal(manifest.format, 'squarehole.hidden-kit-plan/1');
    assert.equal(manifest.plan.path, `${base}/plan.csv`);
    assert.equal(manifest.plan.count, id === 'frog-kiln' ? '420' : '1929');
    if (id === 'paper-certificates') assert.equal(manifest.plan.specimen, '0');
    for (const path of ['SKILL.md', 'references/v2/kits/README.md', `references/v2/kits/${id}.md`]) {
      const doc = read(path);
      assert.ok(doc.includes(settings), `${path}: name the public settings file`);
      assert.ok(doc.includes(plan), `${path}: name the accompanying plan manifest`);
      assert.doesNotMatch(doc, /no public (?:kit )?settings (?:file|download)|no public bundle command|pending L1|until L1|final names/i);
      assert.doesNotMatch(doc, /data:image\/|"(?:salts|revealList|proofs)"\s*:/, 'documentation must not embed hidden edition material');
    }
  });
}

for (const path of [
  'SKILL.md', 'references/v2/README.md', 'references/v2/kits/README.md',
  'references/v2/kits/frog-kiln.md', 'references/v2/kits/paper-certificates.md',
]) {
  test(`${path}: hidden template route keeps the two file selections and private reveal gate`, () => {
    const doc = read(path);
    assert.match(doc, /Load settings[\s\S]*-plan\.json[^\n]*together/i);
    assert.match(doc, /then[\s\S]*12[\s\S]*plan\.csv/i);
    assert.match(doc, /checks?[^.]*plan[^.]*table/i);
    assert.match(doc, /fresh (?:item )?numbers and salts/i);
    assert.match(doc, /replaces?[^.]*marker[^.]*root/i);
    assert.match(doc, /save[^.]*reveal file privately before Create/i);
    assert.match(doc, /keeps?[^.]*file's own hidden picture/i);
    assert.match(doc, /art\/hidden\.svg[^.]*public/i);
    assert.match(doc, /no SVG upload/i);
    assert.match(doc, /(?:without an AI browser agent|no AI browser agent)/i);
  });
}

test('L1 filenames stay unchanged for the ten other kits, including the refused review file', () => {
  const folders = {
    'gpu-poor': 'settings', 'one-dollar': 'settings', 'rent-free': 'build', 'bag-holders': 'build',
    'exit-liquidity': 'build', 'link-marines': 'build', 'dragons-hoard': 'settings', junkyard: 'settings',
    'one-collection-shop': 'settings', 'the-alchemist': 'settings',
  };
  const index = read('references/v2/kits/README.md');
  for (const [id, folder] of Object.entries(folders)) {
    const settings = `examples/boxes/${id}/${folder}/${id}-boxspec-v2.json`;
    assert.ok(index.includes(settings), `index: ${id}`);
    assert.ok(read(`references/v2/kits/${id}.md`).includes(settings), `guide: ${id}`);
  }
  assert.match(index, /Review file only; creation refused/);
  const paper = read('references/v2/kits/paper-certificates.md');
  assert.match(paper, /Gold Certificates/);
  assert.match(paper, /specimen number 0/);
  assert.match(paper, /Do not load the 776 MB numbered rendition/);
});

test('retaining a loaded hidden picture leaves SVG upload coming soon', () => {
  const plain = JSON.parse(readFileSync(new URL('packages/box-spec/plain-words.v1.json', repo), 'utf8'));
  assert.ok(plain.launchFlowCanEnter.comingSoon.some(entry => entry.id === 'hidden-svg-upload'));
  assert.match(read('references/examples/README.md'), /waits for an SVG upload in the launch flow/);
});

for (const id of ['gpu-poor', 'one-dollar', 'rent-free']) {
  test(`${id}: locked description stays valid when selecting the verified test coin`, () => {
    const doc = read(`references/v2/kits/${id}.md`);
    assert.match(doc, /locked description[^.]*coin-neutral/i);
    assert.match(doc, /no (?:description |text )?rewrite[^.]*price coin/i);
    assert.match(doc, /unbound[^.]*ETH listing 0/i);
    assert.match(doc, /verified[^.]*listing/i);
  });
}

test('One Dollar distinguishes a bound listing from an address and spells out whole-coin seeds', () => {
  const doc = read('references/v2/kits/one-dollar.md');
  assert.match(doc, /priceListing[^.]*id[^.]*token[^.]*raise/);
  assert.match(doc, /TEST_USDC[^.]*match[^.]*listing[^.]*token/i);
  assert.match(doc, /address alone[^.]*does not[^.]*listing/i);
  assert.match(doc, /one ETH[^.]*1000000000000000000[^.]*raw/i);
  assert.match(doc, /one tUSDC[^.]*1000000[^.]*raw/i);
});

test('One Dollar documents the supported load and price-following seed without promising conversion', () => {
  const doc = read('references/v2/kits/one-dollar.md');
  assert.match(doc, /Load settings accepts[^.]*same-price-coin pile[^.]*coin is listed/i);
  assert.match(doc, /pile coin follows[^.]*price coin/i);
  assert.match(doc, /keeps[^.]*typed[^.]*`1`/i);
  assert.match(doc, /rebuilds[^.]*raw amount[^.]*new listing[^.]*decimals/i);
  assert.match(doc, /refuses[^.]*seed[^.]*more decimals/i);
  assert.match(doc, /not a value conversion/i);
  assert.match(doc, /founder separately approves and loads the seed after Create/i);
});

test('kit entry and One Dollar preserve the raw-seed boundary when the pile follows price', () => {
  for (const path of ['SKILL.md', 'references/v2/kits/one-dollar.md']) {
    const doc = read(path);
    assert.match(doc, /never reinterpret a raw seed in another coin's decimals/i, path);
    assert.match(doc, /original coin[^.]*decimals/i, path);
    assert.match(doc, /(?:new|selected) listing[^.]*decimals/i, path);
  }
});

test('the three non-hidden guides retain test-coin and no-income disclaimers', () => {
  const gpu = read('references/v2/kits/gpu-poor.md');
  assert.match(gpu, /tNVDA is an unbacked test coin, not Nvidia stock or an Ondo claim/);
  for (const id of ['one-dollar', 'rent-free']) {
    const doc = read(`references/v2/kits/${id}.md`);
    assert.match(doc, /tUSDC is an unbacked Sepolia test coin/i);
    assert.match(doc, /no promise of value/i);
  }
  assert.match(read('references/v2/kits/rent-free.md'), /Rent and property tax are jokes, not real property income/);
});

test('no kit guide retains the superseded locked-ETH or fixed-pile/importer claims', () => {
  const stale = /locked[^.\n]*(?:still says|starts in ETH)|pile coin stays tUSDC when pricing changes|cannot load the intended same-price-coin pile|wait for the importer fix/i;
  for (const file of readdirSync(new URL('references/v2/kits/', skill)).filter(file => file.endsWith('.md'))) {
    assert.doesNotMatch(read(`references/v2/kits/${file}`), stale, file);
  }
});


test('Sepolia Link Marines selects v2 rations, ready with its lives', () => {
  const guide = read('references/v2/kits/link-marines-v2.md');
  assert.match(guide, /inside Depth/);
  // SH-EX-LMV2: the row is ready, so no example-life gate step remains; a ready row is still no Sepolia deployment.
  assert.doesNotMatch(guide, /EXAMPLE-LIFE|"pendingStep"/);
  assert.match(guide, /"status": "ready"/);
  assert.match(guide, /not a Sepolia deployment/);
  assert.match(guide, /12 ranks and 35 squads/);
  assert.match(read('references/v2/kits/README.md'), /Link Marines version 2/);
  assert.match(read('references/v2/kits/link-marines.md'), /archival/i);
  // SH-EX-LMV2 fix round: the worked configuration and preset tied to this row (SKILL.md keeps them at hand) say so too.
  for (const file of ['configurations/link-marines.json', 'presets/link-marines.json']) {
    const draft = read(`references/v2/${file}`);
    assert.doesNotMatch(draft, /EXAMPLE-LIFE|awaits/, file);
    assert.match(draft, /registry row is ready: the local contract and browser lives pass; that is not a Sepolia deployment/, file);
  }
});
