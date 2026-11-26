// SH-262: the card shop's real-run steps, without a chain: the driver-state reading and the bindings from the deployment
// files (no network). The sending, pricing and restarts are lane d's (chain.mjs) and proven by card-shop-proof.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { STOCK_STEP, bindingsFrom, cardsFromDriverState } from './card-shop.mjs';

const card = n => `0x${String(n).repeat(40)}`;
const printed = { cardsCommon: card(1), cardsUncommon: card(2), cardsRare: card(3), cardsLegendary: card(4) };

test('the four collections come from the driver state\'s stock step record, and nothing else', () => {
  assert.deepEqual(cardsFromDriverState({ extra: { [STOCK_STEP]: printed } }),
    { 'common-cards': card(1), 'uncommon-cards': card(2), 'rare-cards': card(3), 'legendary-cards': card(4) });
  assert.throws(() => cardsFromDriverState({ extra: {} }), /stock step/);
  assert.throws(() => cardsFromDriverState({ extra: { [STOCK_STEP]: { ...printed, cardsRare: '0x00' } } }), /cardsRare/);
});

test('bindings: factory from the manifest, tUSDC listing 1 and the native raise from the extras, addresses checksummed', () => {
  const usdc = '0x25c5789b269d8f76309ce961759d643dce291347';
  const manifest = { chainId: 97, releases: [{ factory: { address: '0xb954a0db33a6351e76e519b4830489531c39d4f0' } }] };
  const extras = { chainId: 97, coins: { tUSDC: { address: usdc } }, listings: [
    { id: 0, token: `0x${'0'.repeat(40)}`, symbol: 'BNB', decimals: 18, raise: '1000000000000000' },
    { id: 1, token: usdc, symbol: 'tUSDC', decimals: 6, raise: '1000000' }] };
  const { factory, bindings } = bindingsFrom({ manifest, extras, cards: cardsFromDriverState({ extra: { [STOCK_STEP]: printed } }),
    creator: '0x2ef9a78074bbf674bea16f21154a30c821a3c576' });
  assert.equal(factory, '0xB954a0db33a6351e76E519b4830489531C39d4F0');
  assert.deepEqual(bindings.priceListing, { id: '1', token: '0x25C5789b269D8f76309CE961759d643dce291347', raise: '1000000' });
  assert.equal(bindings.nativeRaise, '1000000000000000');
  assert.equal(bindings.owner, '0x2EF9A78074bbf674bEA16f21154a30c821A3C576');
  const wrong = structuredClone(extras); wrong.listings[1].symbol = 'tNVDA';
  assert.throws(() => bindingsFrom({ manifest, extras: wrong, cards: {}, creator: card(5) }), /tUSDC/);
});

test('SH-300: bindings of the SECOND release: its factory from releases[1], its listings from secondRelease; the default stays release 0', () => {
  const usdc = '0x25c5789b269d8f76309ce961759d643dce291347';
  const second = '0x2ca9b6d94c702dd73eaf8891f36e757e9feddfbc';
  const rows = [{ id: 0, token: `0x${'0'.repeat(40)}`, symbol: 'BNB', decimals: 18, raise: '1000000000000000' },
    { id: 1, token: usdc, symbol: 'tUSDC', decimals: 6, raise: '1000000' }];
  const manifest = { chainId: 97, releases: [{ factory: { address: '0xb954a0db33a6351e76e519b4830489531c39d4f0' } }, { factory: { address: second } }] };
  const extras = { chainId: 97, coins: { tUSDC: { address: usdc } }, listings: rows, secondRelease: { factory: second, listings: rows.map(r => ({ ...r, raise: r.id === 1 ? '2000000' : r.raise })) } };
  const cards = cardsFromDriverState({ extra: { [STOCK_STEP]: printed } });
  const creator = '0x2ef9a78074bbf674bea16f21154a30c821a3c576';
  assert.equal(bindingsFrom({ manifest, extras, cards, creator }).factory, '0xB954a0db33a6351e76E519b4830489531C39d4F0');
  const one = bindingsFrom({ manifest, extras, cards, creator, release: 1 });
  assert.equal(one.factory, '0x2Ca9B6D94c702Dd73eaf8891F36E757e9fEDdfbc');
  assert.equal(one.bindings.priceListing.raise, '2000000');
  assert.throws(() => bindingsFrom({ manifest, extras: { ...extras, secondRelease: undefined }, cards, creator, release: 1 }), /listings of release 1/);
  assert.throws(() => bindingsFrom({ manifest, extras, cards, creator, release: 2 }), /release 0 or 1/);
});
