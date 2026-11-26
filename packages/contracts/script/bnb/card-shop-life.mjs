#!/usr/bin/env node
/**
 * SH-262: the card shop's life on a local chain with id 97, by script, through the same steps the real run uses
 * (card-shop.mjs). Run from packages/contracts with forge, anvil and the built contract tree:
 *
 *   node --experimental-transform-types --no-warnings=ExperimentalWarning script/bnb/card-shop-life.mjs \
 *     [--rehearsal ../../hackathon/rehearsals/plain-97] [--port 8576] [--out <dir>]
 *
 * It starts anvil (chain id 97) from lane c's plain rehearsal (its state dump, state file and read-back files), then, as
 * the real run will, with the deploy wallet as the creator:
 * 1. the card stock step (CardShopStock.s.sol) through lane c's driver (runStep, the extra hook);
 * 2. the settings step: the kit tooling (Create's own serializer) bound from the deployment files and the driver state;
 * 3. create, load (starter set, seed, complete), graduate (buy the curve full, press graduate): each step run twice, the
 *    second run sending nothing;
 * 4. the created box's rules read back and compared with the kit's sheet, field by field;
 * 5. after the seven-day list delay (local only: the clock is moved) a tester gives one card of each tier and receives
 *    exactly that tier's price; one give beyond the weekly limit is refused;
 * 6. a picker picks a card for exactly the pick price (the pick step, also run twice).
 * Every amount is compared to the last unit. Writes result.json into --out. Stops the anvil it started; never a key.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYER, ROOT, rpc, runStep, saveState as saveDriverState } from './bnb-testnet.mjs';
import { STOCK_STEP, TIERS, artifact, buildSettings, cardsFromDriverState, create, graduate, json, load,
  pick, readSettingsDir, roles, writeSettings } from './card-shop.mjs';
import { stateStore } from '../../../chain/scripts/bnb-boxes/chain.mjs';
import { localChain, startChain } from '../../../chain/scripts/bnb-boxes/local-chain.mjs';

const require = createRequire(join(ROOT, 'packages/chain/package.json'));
const { decodeEventLog, erc20Abi, getContractAddress, zeroAddress } = require('viem');
const { factoryV2Abi } = await import('../../../chain/src/core/v2/abi-v2.ts');
const { loadExamples } = await import('../../../box-spec/examples/v2/registry.mjs');
const { shopConfigV2 } = await import('../../../chain/src/core/v2/m2-spec-v2.ts');
const { pickFor, sideOf } = await import('../../../../apps/web/src/features/create/v2/recipes.ts');

/** Local actors besides the deploy wallet (anvil impersonation; no key exists for them): a seller of cards, a picker. */
export const ACTORS = Object.freeze({ creator: DEPLOYER, tester: '0x0000000000000000000000000000000000007e57',
  picker: '0x000000000000000000000000000000000000d1c4' });
const WEEK = 604_800n;
const hex = n => `0x${BigInt(n).toString(16)}`;
const same = (a, b, message) => assert.equal(String(a).toLowerCase(), String(b).toLowerCase(), message);

function flags(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(args[i].startsWith('--') && args[i + 1] !== undefined, `bad option ${args[i]}`);
    o[args[i].slice(2)] = args[i + 1];
  }
  return o;
}

export async function life({ rehearsal, port, out }) {
  mkdirSync(out, { recursive: true });
  const s = JSON.parse(readFileSync(join(rehearsal, 'state.json'), 'utf8'));
  const driverState = join(out, 'driver-state.json');
  const result = { started: new Date().toISOString(), actors: ACTORS, complete: false };
  // Lane d's node start (local-chain.mjs): a port that already answers is refused before starting, the child's own
  // "Listening on" line is awaited; the life never attaches to another chain.
  const node = await startChain({ dumpGz: join(rehearsal, 'anvil-state.json.gz'), workDir: out, port });
  const { url } = node;
  const log = (step, text) => writeFileSync(join(out, `${step.replace(/[^A-Za-z0-9_-]+/g, '_')}.log`), text);
  try {
    assert.ok((await rpc(url, 'web3_clientVersion')).startsWith('anvil/'), 'anvil only');
    result.startBlock = BigInt(await rpc(url, 'eth_blockNumber')).toString();
    for (const who of [DEPLOYER, ACTORS.tester, ACTORS.picker]) {
      await rpc(url, 'anvil_impersonateAccount', [who]);
      await rpc(url, 'anvil_setBalance', [who, hex(10n ** 20n)]);
    }
    // Lane d's chain on this node (nodeSender, impersonated accounts, fixed gas limits, kept transactions).
    const store = stateStore(join(out, 'card-shop-state.json'));
    const ld = localChain(url, { store });
    let n = 0;
    const errorName = error => error?.walk?.(e => e?.data?.errorName)?.data?.errorName ?? null;
    const c = { read: (abi, to, fn, args = []) => ld.read(to, abi, fn, args),
      call: (from, abi, to, fn, args = []) => ld.act(`life:${n++}:${fn}`, () => ld.send(from, to, abi, fn, args).then(r => r.transactionHash)),
      simulate: (from, abi, to, fn, args = []) => ld.simulate(from, to, abi, fn, args),
      refusal: (from, abi, to, fn, args = []) => ld.simulate(from, to, abi, fn, args).then(() => null, errorName) };
    const now = () => ld.now();
    const moveTo = t => ld.mineTo(t);
    const nonceOf = async who => BigInt(await rpc(url, 'eth_getTransactionCount', [who, 'latest']));
    const T = artifact('BoxTokenV2'); const V = artifact('ShopVaultV2'); const C = artifact('TestTradingCards'); const B = artifact('BoxCoordinatorV2');

    // 1. The card stock, as the deployer, through lane c's driver: first stopped after a few transactions (forge killed),
    // then run again, which must reuse what the stopped run made and mint only what is missing.
    const stockCtx = { url, signer: ['--unlocked'], log, broadcastRoot: join(out, 'broadcast'), save: st => saveDriverState(driverState, st) };
    const deployerNonce = async () => BigInt(await rpc(url, 'eth_getTransactionCount', [DEPLOYER, 'latest']));
    const stockStart = await deployerNonce();
    let stoppedAt = null;
    try {
      await runStep(STOCK_STEP, s, { extraArgs: [ACTORS.creator, ACTORS.tester] }, { ...stockCtx, onSpawn: forge => {
        const watch = setInterval(async () => {
          try {
            const n = await deployerNonce();
            if (n >= stockStart + 6n && stoppedAt === null) { stoppedAt = n; forge.kill('SIGKILL'); clearInterval(watch); }
          } catch { /* the next tick reads again */ }
        }, 10);
        forge.on('close', () => clearInterval(watch));
      } });
    } catch (error) { assert.ok(stoppedAt !== null, `the stock step failed without being stopped: ${error.message}`); }
    assert.ok(stoppedAt !== null && s.pending?.step === STOCK_STEP, 'the first stock run was stopped part way');
    const afterStop = await deployerNonce();
    assert.ok(afterStop > stockStart && afterStop < stockStart + 36n, `stopped after ${afterStop - stockStart} of 36 transactions`);
    await runStep(STOCK_STEP, s, { extraArgs: [ACTORS.creator, ACTORS.tester] }, stockCtx);
    const stockEnd = await deployerNonce();
    assert.equal(stockEnd - stockStart, 36n, 'the stopped run and the rerun sent 36 transactions together: no second set');
    const cards = cardsFromDriverState(s);
    // A rerun after every stock transaction mined but before the state was saved: it sends nothing and the driver accepts
    // that verified zero-send completion (the printed addresses have code), with the same four addresses.
    const rerunRecord = { ...s.gas[STOCK_STEP] };
    const without = record => Object.fromEntries(Object.entries(record).filter(([key]) => key !== STOCK_STEP));
    s.gas = without(s.gas); s.extra = without(s.extra);
    await runStep(STOCK_STEP, s, { extraArgs: [ACTORS.creator, ACTORS.tester] }, stockCtx);
    assert.equal(await deployerNonce(), stockEnd, 'the zero-send rerun sent nothing');
    assert.equal(s.gas[STOCK_STEP].nothingToSend, true, 'recorded as a verified zero-send completion');
    assert.deepEqual(cardsFromDriverState(s), cards, 'the same four collections');
    s.gas[STOCK_STEP] = rerunRecord;
    // Every collection the deployer made in these nonces: exactly the four printed ones.
    const made = [];
    for (let n = stockStart; n < stockEnd; n++) {
      const at = getContractAddress({ from: DEPLOYER, nonce: n });
      if ((await rpc(url, 'eth_getCode', [at, 'latest'])).length > 2) made.push(at);
    }
    assert.deepEqual(made.map(a => a.toLowerCase()).sort(), Object.values(cards).map(a => a.toLowerCase()).sort(), 'four collections, no duplicates');
    for (const [tier, key] of TIERS.entries()) {
      assert.equal(await c.read(C, cards[key], 'tier'), tier);
      same(await c.read(C, cards[key], 'owner'), DEPLOYER, 'the deployer mints');
      for (let id = 1n; id <= 8n; id++) same(await c.read(C, cards[key], 'ownerOf', [id]), id <= 4n ? ACTORS.creator : ACTORS.tester);
    }
    const stockTx = s.gas[STOCK_STEP].transactions;
    result.stock = { cards, stoppedAfter: (afterStop - stockStart).toString(), rerunTransactions: stockTx.length, total: (stockEnd - stockStart).toString() };

    // 2. The settings, from the rehearsal's read-back files and the driver state (the real run reads the repository's).
    const built = await buildSettings({ manifest: JSON.parse(readFileSync(join(rehearsal, 'core-v1/97.json'), 'utf8')),
      extras: JSON.parse(readFileSync(join(rehearsal, 'bnb-testnet/97-extras.json'), 'utf8')), cards, creator: ACTORS.creator });
    const settings = readSettingsDir(writeSettings(join(out, 'settings'), built));
    same(settings.factory, s.factory, 'the read-back files name the driver\'s factory');
    const shop = shopConfigV2(settings.spec.contentsParams);

    // 3. Create, load, graduate: each twice, the second run sending nothing.
    // Each step twice: the second run returns the kept result and moves no nonce.
    const twice = async (name, step, from, extra) => {
      const first = await step(ld, settings, from, extra);
      const before = await Promise.all([DEPLOYER, ACTORS.tester, ACTORS.picker].map(nonceOf));
      const again = await step(ld, settings, from, extra);
      assert.deepEqual(await Promise.all([DEPLOYER, ACTORS.tester, ACTORS.picker].map(nonceOf)), before, `${name}: a second run sends nothing`);
      return { first, again };
    };
    const usdcBefore = await c.read(erc20Abi, s.coins.usdc, 'balanceOf', [ACTORS.creator]);
    const created = await twice('create', create, ACTORS.creator);
    const paidP = usdcBefore - await c.read(erc20Abi, s.coins.usdc, 'balanceOf', [ACTORS.creator]);
    const box = created.first.box;
    const createdAt = BigInt(created.first.createdAt);
    const r = await roles(ld, box);
    assert.equal(await c.read(B, box, 'specHash'), settings.specHash, 'the box holds exactly the settings file\'s spec');
    same(await c.read(B, box, 'creator'), ACTORS.creator);
    const creatorT = await c.read(T, r.token, 'balanceOf', [ACTORS.creator]);
    assert.ok(creatorT >= shop.seedT, `the creator buy (${creatorT}) covers the seed (${shop.seedT})`);
    await twice('load', load, ACTORS.creator);
    result.creation = { ...r, specHash: settings.specHash, creatorBuyP: created.first.creatorBuyP, bootstrapQ: created.first.bootstrapQ, creatorT };

    // 4. The created box's rules, read back and compared with the sheet (the registry row), field by field.
    const row = loadExamples().find(e => e.id === 'card-shop');
    const sheet = row.contents.shop; const spec = settings.spec;
    const compare = [];
    const field = (name, sheetValue, specValue, chainValue) => {
      assert.equal(String(specValue), String(sheetValue), `${name}: settings file vs sheet`);
      assert.equal(String(chainValue), String(sheetValue), `${name}: chain vs sheet`);
      compare.push({ field: name, sheet: String(sheetValue), settings: String(specValue), chain: String(chainValue) });
    };
    field('name', row.name, spec.tokenName, await c.read(T, r.token, 'name'));
    field('ticker', row.ticker, spec.tokenSymbol, await c.read(T, r.token, 'symbol'));
    const boxQ = await c.read(B, box, 'q');
    same(boxQ, s.coins.usdc, 'the box is priced in the deployment\'s tUSDC');
    field('price coin', 'tUSDC', await c.read(erc20Abi, spec.pricing.token, 'symbol'), await c.read(erc20Abi, boxQ, 'symbol'));
    field('raise (the listing\'s)', settings.bindings.priceListing.raise, spec.raise, await c.read(B, box, 'raise'));
    const listingQ = await c.read(factoryV2Abi, settings.factory, 'boxQParameters', [1, spec.raise]);
    field('creator buy (raw tUSDC)', (BigInt(row.creator.buyEthEquivalent) * spec.raise + BigInt(settings.bindings.nativeRaise) - 1n) / BigInt(settings.bindings.nativeRaise),
      spec.creatorBuy, await c.read(B, box, 'creatorBuyAmount'));
    field('bootstrap (raw tUSDC)', listingQ.bootstrapQ, created.first.bootstrapQ, await c.read(B, box, 'bootstrapQ'));
    field('creation payment, measured (raw tUSDC)', listingQ.bootstrapQ + spec.creatorBuy, BigInt(created.first.bootstrapQ) + spec.creatorBuy, paidP);
    field('seed', sheet.seedT, shop.seedT, await c.read(V, r.vault, 'budgetT'));
    field('ceiling (seed x preset)', BigInt(sheet.seedT) * BigInt(row.fees.sellers.ceilingPreset), shop.seedT * 2n, await c.read(V, r.vault, 'ceilingT'));
    field('curator', zeroAddress, shop.curator, await c.read(V, r.vault, 'curator'));
    field('starters inside', sheet.collections.reduce((n, x) => n + x.starterIds.length, 0), settings.starter.length, await c.read(V, r.vault, 'inside'));
    // The tiers as the vault recorded them: its CollectionAdded events in the creation block.
    const createdBlock = hex(created.first.block);
    const added = new Map((await rpc(url, 'eth_getLogs', [{ address: r.vault, fromBlock: createdBlock, toBlock: createdBlock }]))
      .map(l => { try { return decodeEventLog({ abi: V, data: l.data, topics: l.topics }); } catch { return null; } })
      .filter(e => e?.eventName === 'CollectionAdded').map(e => [e.args.collection.toLowerCase(), e.args]));
    assert.equal(added.size, 4, 'four collections listed at creation');
    for (const [tier, key] of TIERS.entries()) {
      const at = shop.collections.findIndex(a => a.toLowerCase() === cards[key].toLowerCase());
      const [giveT, pickT, activeAt] = await c.read(V, r.vault, 'collectionTerms', [cards[key]]);
      const event = added.get(cards[key].toLowerCase());
      field(`${key} tier`, sheet.collections[tier].tier, shop.tiers[at], event.tier);
      assert.equal(event.activeAt, activeAt, `${key}: the event's activation is the terms'`);
      field(`${key} give`, sheet.givePricesT[tier], shop.givePricesT[tier], giveT);
      field(`${key} pick`, BigInt(sheet.givePricesT[tier]) * BigInt(sheet.pickBps) / 10000n, shop.givePricesT[tier] * BigInt(shop.pickBps) / 10000n, pickT);
      field(`${key} list delay`, sheet.listDelay, shop.listDelay, activeAt - createdAt);
      for (const id of sheet.collections[tier].starterIds) same(await c.read(C, cards[key], 'ownerOf', [BigInt(id)]), r.vault, `${key} #${id} inside`);
    }
    // No getter reads these two back: a spec-hash check (the box's spec hash equals the settings file's, above).
    for (const [name, sheetValue, specValue] of [['weekly limit bps', sheet.weeklyBps, shop.weeklyBps], ['per-collection limit bps', sheet.collectionBps, shop.collectionBps]]) {
      assert.equal(String(specValue), String(sheetValue), `${name}: settings file vs sheet`);
      compare.push({ field: name, sheet: String(sheetValue), settings: String(specValue), chain: 'spec-hash check (no getter)' });
    }
    // The fee choices as the box's receiver holds them (FeeChoice: Holders 4, ShopT 11).
    const receiver = await c.read(B, box, 'receiver');
    const R = artifact('BoxReceiverV2');
    for (const [sideName, getter, wantChoice] of [['buyers', 'buyersChoice', 4], ['sellers', 'sellersChoice', 11]]) {
      const want = sideOf(pickFor(row.fees[sideName].choice, 1, Number(row.fees[sideName].ceilingPreset ?? '2')));
      assert.deepEqual(spec[sideName], want, `${sideName} fee side`);
      field(`${sideName} fees (FeeChoice)`, `${row.fees[sideName].choice}=${wantChoice}`, `${row.fees[sideName].choice}=${wantChoice}`,
        `${row.fees[sideName].choice}=${await c.read(R, receiver, getter)}`);
    }
    assert.equal(await c.read(T, r.token, 'allowance', [ACTORS.creator, r.vault]), 0n, 'the seed approval is used up exactly');
    assert.equal(await c.read(B, box, 'gateOpen'), true);
    result.compare = compare;

    // Graduation: the graduate step, after the launch window (local: the clock is moved to it).
    const swapper = s.dependencies.swapper;
    await twice('graduate', graduate, ACTORS.creator, { swapper });
    assert.ok(await c.read(B, box, 'graduated'), 'graduated');
    const budget0 = await c.read(V, r.vault, 'budgetT');
    assert.equal(budget0, shop.seedT, 'no fees bought into the shop yet: the week starts at the seed');

    // 5. Local only: past the seven-day list delay, one give of each tier at exactly its price; one beyond the week's limit.
    const activeAt = createdAt + WEEK;
    for (const key of TIERS) await c.call(ACTORS.tester, C, cards[key], 'setApprovalForAll', [r.vault, true]);
    const delayRefusal = await now() < activeAt ? await c.refusal(ACTORS.tester, V, r.vault, 'give', [cards[TIERS[0]], 5n, 0n]) : 'passed';
    assert.equal(delayRefusal, 'InvalidRequest', 'no give before the list delay');
    await moveTo(activeAt);
    const balances = async who => ({ t: await c.read(T, r.token, 'balanceOf', [who]), budget: await c.read(V, r.vault, 'budgetT'), inside: await c.read(V, r.vault, 'inside') });
    const gives = [];
    const secondRare = () => c.simulate(ACTORS.tester, V, r.vault, 'give', [cards['rare-cards'], 6n, shop.givePricesT[2]]);
    let rareBeforeLegendary = null;
    for (const [tier, key] of TIERS.entries()) {
      const price = shop.givePricesT[tier];
      // Right before the Legendary give the same second Rare sale succeeds (simulated); right after it, it is refused.
      if (key === 'legendary-cards') rareBeforeLegendary = await secondRare();
      const before = await balances(ACTORS.tester);
      await c.call(ACTORS.tester, V, r.vault, 'give', [cards[key], 5n, price]);
      const after = await balances(ACTORS.tester);
      assert.equal(after.t - before.t, price, `${key}: the seller receives exactly the tier's price`);
      assert.equal(before.budget - after.budget, price);
      assert.equal(after.inside - before.inside, 1n);
      same(await c.read(C, cards[key], 'ownerOf', [5n]), r.vault);
      gives.push({ tier, collection: key, id: '5', priceT: price, receivedT: after.t - before.t });
    }
    const spent = gives.reduce((a, g) => a + g.receivedT, 0n); // measured deltas
    const weekly = budget0 * BigInt(shop.weeklyBps) / 10000n; const perCollection = budget0 * BigInt(shop.collectionBps) / 10000n;
    const rare = shop.givePricesT[2];
    assert.equal(rareBeforeLegendary, rare, 'right before the Legendary give, the second Rare sale would pay exactly its price');
    assert.ok(spent + rare > weekly && 2n * rare <= perCollection, 'the second Rare is over the weekly limit, not the collection\'s');
    const before = await balances(ACTORS.tester);
    const refused = await c.refusal(ACTORS.tester, V, r.vault, 'give', [cards['rare-cards'], 6n, rare]);
    assert.equal(refused, 'InvalidRequest', 'a give beyond the weekly limit is refused');
    assert.deepEqual(await balances(ACTORS.tester), before);
    same(await c.read(C, cards['rare-cards'], 'ownerOf', [6n]), ACTORS.tester);

    // 6. The pick step: a Legendary for exactly its pick price, twice (the second sends nothing).
    const [, pickT] = await c.read(V, r.vault, 'collectionTerms', [cards['legendary-cards']]);
    assert.equal(pickT, shop.givePricesT[3] * 2n, 'a Legendary pick costs twice its give price');
    const pickBefore = await balances(ACTORS.picker);
    // The creator pays the picker exactly the pick price inside the pick step (--payer), then the picker picks.
    await twice('pick', pick, ACTORS.picker, { card: 'legendary-cards', id: 1n, payer: ACTORS.creator });
    const pickAfter = await balances(ACTORS.picker);
    assert.equal(pickBefore.t, 0n, 'the picker held no CARD before');
    assert.equal(pickAfter.t, 0n, 'the payer sent exactly the pick price and the picker paid exactly it');
    assert.equal(pickAfter.budget - pickBefore.budget, pickT);
    assert.equal(pickBefore.inside - pickAfter.inside, 1n);
    same(await c.read(C, cards['legendary-cards'], 'ownerOf', [1n]), ACTORS.picker);
    assert.equal(await c.read(T, r.token, 'allowance', [ACTORS.picker, r.vault]), 0n);
    result.life = { budgetStartT: budget0, weeklyLimitT: weekly, perCollectionLimitT: perCollection, gives, spentT: spent,
      refused: { collection: 'rare-cards', id: '6', priceT: rare, simulatedBeforeLegendaryT: rareBeforeLegendary, error: refused, wouldSpendT: spent + rare },
      listDelay: delayRefusal, pick: { collection: 'legendary-cards', id: '1', pickT, budgetInT: pickAfter.budget - pickBefore.budget },
      budgetEndT: await c.read(V, r.vault, 'budgetT'), insideEnd: await c.read(V, r.vault, 'inside') };
    const sent = Object.values(store.data.tx);
    result.sent = { transactions: sent.length, gasUsed: sent.reduce((a, t) => a + BigInt(t.gasUsed ?? 0n), 0n) };
    result.complete = true;
  } catch (error) {
    result.error = String(error.stack ?? error);
    if (error.out) writeFileSync(join(out, 'failed-step.log'), error.out);
  } finally {
    node.stop();
    writeFileSync(join(out, 'result.json'), json(result));
  }
  process.stdout.write(`${result.complete ? 'CARD SHOP LIFE COMPLETE' : 'CARD SHOP LIFE FAILED'} -> ${out}\n`);
  if (!result.complete) { process.stdout.write(`${result.error}\n`); process.exitCode = 1; }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = flags(process.argv.slice(2));
  await life({ rehearsal: resolve(o.rehearsal ?? join(ROOT, 'hackathon/rehearsals/plain-97')), port: Number(o.port ?? 8576),
    out: resolve(o.out ?? join(ROOT, '.cache/card-shop-life', String(Date.now()))) });
}
