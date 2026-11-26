/**
 * SH-V21-FE13: a shop in the creation flow. Only the presets the factory accepts are offered (the generated validator,
 * box-spec.v2.json's `shop` entry and ShopVaultV2.initialize's literals agree); field 30 is the chain package's own
 * ShopConfigV2 encoding; the F132 seed rule, the collection list and the curator are checked on the page as the
 * validator checks them; the plan funds the seed and opens the box after Create.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAbiParameters, keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { Reason, validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { buildCreateCallsV2, shopConfigV2, starterCommitmentV2 } from '../../../../../../packages/chain/src/core/v2';
import { required } from '../../core/v2/test-support/required';
import { creationPlan, demoCreateGas } from './creation-plan';
import { DEMO_LISTINGS } from './listings';
import { buildSpecV2, newPile, recipeCtx, v2Issues, type BuildV2Input } from './model';
import { pickFor } from './recipes';
import {
  IDS_LINE, SHOP_COLLECTION_BPS, SHOP_CONTROL, SHOP_LIST_DELAY_DAYS, SHOP_PICK_BPS, SHOP_WEEKLY_BPS, T_SUPPLY, curatorOf, idsOf, newShop, pickPriceOf, shopConfigOf, shopIssues,
  starterCommitmentOf, starterItemsOf, starterKey, type ShopChoice, type StarterCheck,
} from './shop';
import { addressOf as typedAddressOf } from './shop';
import { BoxTypeV2 } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const NFT_A = '0x00000000000000000000000000000000000000a1';
const NFT_B = '0x00000000000000000000000000000000000000b2';
const SAFE = '0x000000000000000000000000000000000000Safe'.replace('Safe', '5afe');
const E18 = 10n ** 18n;
const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));

/** A shop the validator accepts: seed 1000, tiers 1/2/4/8, two collections at tiers 1 and 3. */
const SHOP: ShopChoice = { ...newShop(), seed: '1000', prices: ['1', '2', '4', '8'], collections: [{ address: NFT_A, tier: 0 }, { address: NFT_B, tier: 2 }] };
const shopInput = (shop: Partial<ShopChoice> = {}, pricing = 'ETH', form: Partial<BuildV2Input['form']> = {}): BuildV2Input =>
  inputV2Of(config('rug-rugs'), { pricing: coin(pricing).token, buyers: pickFor('holders'), sellers: pickFor('holders'), pile: null, shop: { ...SHOP, ...shop } }, { firstIn: '0.05', ...form });
const verdict = (input: BuildV2Input) => validateBoxSpecV2(buildSpecV2(input), { listing: recipeCtx(input).pricing });

describe('SH-V21-FE13 shop presets: only what the factory accepts', () => {
  it('match box-spec.v2.json and ShopVaultV2.initialize literal for literal', () => {
    const shop = JSON.parse(read('packages/box-spec/box-spec.v2.json')).shop as Record<string, unknown>;
    expect(shop.pickBps).toEqual([...SHOP_PICK_BPS]);
    expect(shop.weeklyBps).toEqual([...SHOP_WEEKLY_BPS]);
    expect(shop.collectionBps).toEqual([...SHOP_COLLECTION_BPS]);
    expect(shop.listDelaySeconds).toEqual(SHOP_LIST_DELAY_DAYS.map((days) => days * 86_400));
    const source = read('packages/contracts/src/box-v2/ShopVaultV2.sol');
    for (const bps of SHOP_PICK_BPS) expect(source).toContain(`cfg.pickBps != ${bps}`);
    for (const bps of SHOP_WEEKLY_BPS) expect(source).toContain(`cfg.weeklyBps != ${bps}`);
    for (const bps of SHOP_COLLECTION_BPS) expect(source).toContain(`cfg.collectionBps != ${bps}`);
    for (const days of SHOP_LIST_DELAY_DAYS) expect(source).toContain(`cfg.listDelay != ${days} days`);
  });

  it('every offered combination is a valid shop in ETH, USDC and PAXG, and decodes back as typed through the chain package', () => {
    let checked = 0;
    for (const pickBps of SHOP_PICK_BPS) for (const weeklyBps of SHOP_WEEKLY_BPS) for (const collectionBps of SHOP_COLLECTION_BPS) for (const listDelayDays of SHOP_LIST_DELAY_DAYS) {
      for (const symbol of ['ETH', 'USDC', 'PAXG']) {
        const input = shopInput({ pickBps, weeklyBps, collectionBps, listDelayDays }, symbol);
        expect(verdict(input), `${symbol} ${pickBps}/${weeklyBps}/${collectionBps}/${listDelayDays}`).toEqual({ reason: 0, field: 0 });
        const decoded = shopConfigV2(buildSpecV2(input).contentsParams);
        expect(decoded).toMatchObject({ seedT: 1000n * E18, pickBps, weeklyBps, collectionBps, listDelay: listDelayDays * 86_400 });
        expect([...decoded.givePricesT]).toEqual([1n, 2n, 4n, 8n].map((n) => n * E18));
        expect(decoded.collections.map((a) => a.toLowerCase())).toEqual([NFT_A, NFT_B]);
        expect([...decoded.tiers]).toEqual([0, 2]);
        checked += 1;
      }
    }
    expect(checked).toBe(4 * 2 * 3 * 3 * 3);
  });

  it('any other preset is refused by the validator, so the page never offers one', () => {
    for (const shop of [{ pickBps: 10_000 }, { pickBps: 25_000 }, { weeklyBps: 250 }, { collectionBps: 1_000 }, { listDelayDays: 1 }] as const) {
      const input = shopInput(shop as unknown as Partial<ShopChoice>);
      expect(verdict(input).reason, JSON.stringify(shop)).toBe(Reason.NOT_A_MEMBER);
      expect(v2Issues(input).some((issue) => issue.step === 'v2-contents' && issue.message === 'Pick one of the options'), JSON.stringify(shop)).toBe(true);
    }
  });
});

describe('SH-V21-FE13 shop spec', () => {
  it('is a SHOP box: no collection of its own, the collection list and a seed-only starter set, the creator as curator', () => {
    const input = shopInput();
    const spec = buildSpecV2(input);
    expect(spec).toMatchObject({ boxType: BoxTypeV2.SHOP, n: 0, firstId: 0n, artMode: 0, pickFeeBps: 0, collectionName: '', collectionSymbol: '' });
    expect(spec.addOns.map((a) => a.id)).toEqual([7, 8]);
    expect(spec.addOns[0]?.params).toBe('0x');
    expect(starterCommitmentV2(spec)).toEqual({ setHash: `0x${'0'.repeat(64)}`, count: 0 });
    expect((spec.contentsParams.length - 2) / 2).toBe(480 + 2 * 64);
    expect(shopConfigV2(spec.contentsParams).curator).toBe(required(input.owner));
    expect(v2Issues(input)).toEqual([]);
  });

  it('a typed curator, a Safe say, is the one encoded; the zero address and a typo are refused', () => {
    expect(shopConfigV2(buildSpecV2(shopInput({ curator: 'address', curatorAddress: SAFE })).contentsParams).curator.toLowerCase()).toBe(SAFE.toLowerCase());
    for (const curatorAddress of ['', '0x12', '0x0000000000000000000000000000000000000000']) {
      expect(v2Issues(shopInput({ curator: 'address', curatorAddress })).find((issue) => issue.control === SHOP_CONTROL.curatorAddress)?.step, curatorAddress).toBe('v2-contents');
    }
  });

  it('with you as curator and no wallet yet, the Overview asks for one (never a zero curator, which would freeze the list)', () => {
    const input = { ...shopInput(), owner: null };
    expect(shopConfigV2(buildSpecV2(input).contentsParams).curator).toBe('0x0000000000000000000000000000000000000000');
    expect(v2Issues(input).filter((issue) => issue.control === SHOP_CONTROL.curatorRow)).toEqual([{ step: 'v2-overview', control: SHOP_CONTROL.curatorRow, message: 'Connect a wallet: you are the curator.' }]);
  });

  it('F132: the seed must be twice the cheapest listed give; the page and the validator agree at the boundary', () => {
    // The cheapest listed tier is tier 1 (1): 2 is enough, one raw unit less is not.
    expect(verdict(shopInput({ seed: '2' }))).toEqual({ reason: 0, field: 0 });
    expect(v2Issues(shopInput({ seed: '2' }))).toEqual([]);
    const short = shopInput({ seed: '1.999999999999999999' });
    expect(verdict(short).reason).toBe(Reason.OUT_OF_RANGE);
    expect(v2Issues(short).find((issue) => issue.control === SHOP_CONTROL.seed)?.message).toBe('At least 2 RUGS: twice the cheapest listed give');
    // Only listed tiers count: with tier 1 unused, the cheapest listed give is tier 3's 4.
    const unlisted = { collections: [{ address: NFT_A, tier: 2 as const }] };
    expect(verdict(shopInput({ ...unlisted, seed: '8' }))).toEqual({ reason: 0, field: 0 });
    expect(verdict(shopInput({ ...unlisted, seed: '7.999999999999999999' })).reason).toBe(Reason.OUT_OF_RANGE);
    expect(v2Issues(shopInput({ ...unlisted, seed: '7.999999999999999999' })).find((issue) => issue.control === SHOP_CONTROL.seed)?.message).toBe('At least 8 RUGS: twice the cheapest listed give');
  });

  it('tiers above zero and each above the one before; amounts within T’s supply', () => {
    const cases: [ShopChoice['prices'], number, string][] = [
      [['1', '1', '4', '8'], 1, 'Above tier 1'],
      [['1', '2', '1.5', '8'], 2, 'Above tier 2'],
      [['0', '2', '4', '8'], 0, 'More than 0'],
      [['1', 'two', '4', '8'], 1, 'Use a number like 1000, up to 18 decimals'],
      [['1', '2', '4', '1000000001'], 3, 'At most 1000000000 RUGS'],
    ];
    for (const [prices, tier, message] of cases) {
      const input = shopInput({ prices });
      expect(v2Issues(input).find((issue) => issue.control === SHOP_CONTROL.tier(tier))?.message, prices.join('/')).toBe(message);
    }
    expect(verdict(shopInput({ prices: ['1', '1', '4', '8'] })).reason).toBe(Reason.OUT_OF_RANGE);
    expect(verdict(shopInput({ prices: ['0', '2', '4', '8'] })).reason).toBe(Reason.OUT_OF_RANGE);
    expect(v2Issues(shopInput({ seed: '1000000001' })).find((issue) => issue.control === SHOP_CONTROL.seed)?.message).toBe('At most 1000000000 RUGS');
    expect(T_SUPPLY).toBe(10n ** 27n);
  });

  it('1 to 64 collections, each an address, none twice; the validator refuses the same', () => {
    expect(v2Issues(shopInput({ collections: [] })).map((issue) => issue.control)).toContain(SHOP_CONTROL.collections);
    expect(verdict(shopInput({ collections: [] })).reason).toBe(Reason.OUT_OF_RANGE);
    const twice = shopInput({ collections: [{ address: NFT_A, tier: 0 }, { address: NFT_A.toUpperCase().replace('0X', '0x'), tier: 1 }] });
    expect(v2Issues(twice).find((issue) => issue.control === SHOP_CONTROL.collection(1))?.message).toBe('Listed twice');
    expect(verdict(twice).reason).toBe(Reason.RECIPE_RULE);
    for (const address of ['', 'junkyard.eth', '0x0000000000000000000000000000000000000000']) {
      expect(v2Issues(shopInput({ collections: [{ address, tier: 0 }] })).find((issue) => issue.control === SHOP_CONTROL.collection(0))?.message, address).toBe('Use a collection address like 0x12…, 42 characters');
    }
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}`, tier: 0 as const }));
    expect(verdict(shopInput({ collections: many(64) }))).toEqual({ reason: 0, field: 0 });
    // 65 entries pass field 30's longest length (480 + 64 × 64 bytes) before any rule is read.
    expect(verdict(shopInput({ collections: many(65) })).reason).toBe(Reason.LENGTH_OUT_OF_RANGE);
    expect(v2Issues(shopInput({ collections: many(65) })).map((issue) => issue.message)).toContain('At most 64 collections');
  });

  it('the chain’s answer about each collection: not a contract, not an ERC-721, or not answered yet each hold Contents', () => {
    const checks = (answer: 'no-code' | 'not-erc721' | 'unknown' | 'erc721') => new Map([[NFT_A, answer], [NFT_B, 'erc721' as const]]);
    const message = (answer: 'no-code' | 'not-erc721' | 'unknown' | 'erc721') => v2Issues({ ...shopInput(), shopChecks: checks(answer) }).find((issue) => issue.control === SHOP_CONTROL.collection(0))?.message;
    expect(message('no-code')).toBe('No contract at this address');
    expect(message('not-erc721')).toBe('Not an ERC-721 collection');
    expect(message('unknown')).toBe('Checking this collection');
    expect(message('erc721')).toBeUndefined();
  });

  it('the seed comes from the first buy, so a shop needs one (at Opening)', () => {
    expect(v2Issues(shopInput({}, 'ETH', { firstIn: '' }))).toContainEqual({ step: 'v2-opening', control: 'create-first-in', message: 'A shop needs your ETH at start: the seed comes from it.' });
    expect(v2Issues(shopInput({}, 'USDC', { firstIn: '0' })).map((issue) => issue.message)).toContain('A shop needs your USDC at start: the seed comes from it.');
    expect(v2Issues(shopInput({}, 'USDC', { firstIn: '5' })).filter((issue) => issue.step === 'v2-opening')).toEqual([]);
  });

  it('a shop is never a pile: a pile left in the choices is not built, nor checked', () => {
    const input = { ...shopInput(), v2: { ...shopInput().v2, pile: { ...newPile(coin('USDC').token), seed: 'oops' } } };
    expect(buildSpecV2(input).boxType).toBe(BoxTypeV2.SHOP);
    expect(v2Issues(input)).toEqual([]);
  });

  it('pick prices round up, as ShopVaultV2 collectionTerms does', () => {
    expect(pickPriceOf(1n, 12_500)).toBe(2n);
    expect(pickPriceOf(4n, 12_500)).toBe(5n);
    expect(pickPriceOf(3n, 15_000)).toBe(5n);
    expect(pickPriceOf(E18, 20_000)).toBe(2n * E18);
    expect(pickPriceOf(7n, 30_000)).toBe(21n);
  });

  it('the plan: create, then the creator approves the seed, the shop pulls it and the loader opens the box', () => {
    const input = shopInput();
    const spec = buildSpecV2(input);
    const seedT = shopConfigOf(required(input.v2.shop), input.owner ?? null).seedT;
    const plan = creationPlan(spec, recipeCtx(input).pricing, { estimate: demoCreateGas, shopSeedT: seedT });
    expect(plan.steps.map((step) => step.call)).toEqual(['createBox', 'approveShopSeed', 'fundSeed', 'complete']);
    expect(plan.steps.slice(1, 3).map((step) => step.amount)).toEqual([1000n * E18, 1000n * E18]);
    expect(plan.waits).toBe(true);
  });

  it('issues name the box’s ticker; T before there is one', () => {
    const issues = shopIssues({ ...SHOP, seed: '1' }, { owner: null, ticker: '', firstIn: 1n, priceSymbol: 'ETH' });
    expect(issues.find((issue) => issue.control === SHOP_CONTROL.seed)?.message).toBe('At least 2 T: twice the cheapest listed give');
    const [decoded] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], required(buildSpecV2(shopInput()).addOns[1]).params);
    expect(decoded).toBe(`0x${'0'.repeat(64)}`);
  });
});

describe('SH-SHOP-CREATE starter items', () => {
  /** SHOP with starter ids typed for both collections: ten in all by default. */
  const starters = (a = '1-6', b = '7, 8, 9, 10'): Partial<ShopChoice> => ({ collections: [{ address: NFT_A, tier: 0, ids: a }, { address: NFT_B, tier: 2, ids: b }] });
  const issueAt = (input: BuildV2Input, control: string) => v2Issues(input).find((issue) => issue.control === control)?.message;

  it('ids as typed: numbers and ranges, separated by commas, spaces or new lines, in typed order', () => {
    expect(idsOf('')).toEqual([]);
    expect(idsOf('  ')).toEqual([]);
    expect(idsOf('1, 2, 5-9')).toEqual([1n, 2n, 5n, 6n, 7n, 8n, 9n]);
    expect(idsOf('12 3\n7 - 8,0')).toEqual([12n, 3n, 7n, 8n, 0n]);
    expect(idsOf(`${(1n << 256n) - 1n}`)).toEqual([(1n << 256n) - 1n]);
    for (const text of ['x', '1.5', '-1', '01', '9-5', '1--2', `${1n << 256n}`, '0x10']) expect(idsOf(text), text).toBe('format');
    expect(idsOf('1-10000')).toHaveLength(10_000);
    expect(idsOf('1-10001')).toBe('many');
    expect(idsOf('1-1000000000000')).toBe('many');
  });

  // XR-SH-SHOP-CREATE F1 (fix round 1): a comma group with nothing in it is no id; only a field that is blank throughout
  // means no starter items.
  it('an empty or blank comma group is refused, leading, trailing, repeated or of white space only; a blank field is none', () => {
    for (const blank of ['', ' ', ' \n\t ']) expect(idsOf(blank), JSON.stringify(blank)).toEqual([]);
    for (const text of [',', ',,', ', ,', ',1-10', '1-10,', '1-4,,5-10', '1-4, ,5-10', '1-4, \n ,5-10', '1-10,\t', '\n,1-10']) {
      expect(idsOf(text), JSON.stringify(text)).toBe('format');
      expect(issueAt(shopInput(starters(text, '')), SHOP_CONTROL.starters(0)), JSON.stringify(text)).toBe(IDS_LINE);
      expect(starterItemsOf({ collections: [{ address: NFT_A, tier: 0, ids: text }] }), JSON.stringify(text)).toBeNull();
    }
    // Commas between groups and white space within one still read as before.
    expect(idsOf('1-4, 5 6,7 - 10')).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
    expect(issueAt(shopInput(starters('1-4, 5 6,7 - 10', '')), SHOP_CONTROL.starters(0))).toBeUndefined();
  });

  it('add-on 8 commits them in row order, then typed order: the chain package’s loader pages accept exactly that set', () => {
    const input = shopInput(starters());
    const spec = buildSpecV2(input);
    const items = required(starterItemsOf(required(input.v2.shop)));
    expect(items.map((item) => [item.collection.toLowerCase(), item.id, item.tier])).toEqual([...[1n, 2n, 3n, 4n, 5n, 6n].map((id) => [NFT_A, id, 0]), ...[7n, 8n, 9n, 10n].map((id) => [NFT_B, id, 2])]);
    const commitment = required(starterCommitmentV2(spec));
    expect(commitment).toEqual(starterCommitmentOf(items));
    expect(commitment.count).toBe(10);
    // IStarterSetLoaderV2: h[i] = keccak256(abi.encode(collection, id, tier, h[i+1])), h[10] = 0 (the last by hand).
    const last = keccak256(`0x${NFT_B.slice(2).padStart(64, '0')}${toHex(10n, { size: 32 }).slice(2)}${toHex(2n, { size: 32 }).slice(2)}${'0'.repeat(64)}`);
    expect(starterCommitmentOf(items.slice(-1)).setHash).toBe(last);
    // TA-21's creation calls take these items (and refuse any other order) for this spec.
    const plan = { chainId: 31337, creator: SAFE as `0x${string}`, factory: `0x${'f'.repeat(40)}` as const, coordinator: `0x${'c'.repeat(40)}` as const, vault: `0x${'d'.repeat(40)}` as const,
      starterLoader: `0x${'e'.repeat(40)}` as const, spec, cs: `0x${'1'.repeat(64)}` as const, hs: `0x${'2'.repeat(64)}` as const, bootstrapQ: 1n };
    expect(buildCreateCallsV2({ ...plan, starterItems: items }).filter((call) => call.kind === 'loadStarter')).toHaveLength(1);
    expect(() => buildCreateCallsV2({ ...plan, starterItems: [...items].reverse() })).toThrow('starter commitment mismatch');
    expect(verdict(input)).toEqual({ reason: 0, field: 0 });
    expect(v2Issues(input).filter((issue) => issue.step !== 'v2-overview')).toEqual([]);
  });

  it('none, or 10 to 10,000 in all; each id once per collection; ids the page reads', () => {
    expect(issueAt(shopInput(starters('1-5', '6-9')), SHOP_CONTROL.collections)).toBe('At least 10 starter items, or none');
    expect(issueAt(shopInput(starters('1-5000', '1-5001')), SHOP_CONTROL.collections)).toBe('At most 10,000 starter items');
    expect(issueAt(shopInput(starters('1-10001', '')), SHOP_CONTROL.collections)).toBe('At most 10,000 starter items');
    expect(issueAt(shopInput(starters('1-5000', '1-5000')), SHOP_CONTROL.collections)).toBeUndefined();
    expect(issueAt(shopInput(starters('1-6, 6', '7-10')), SHOP_CONTROL.starters(0))).toBe('Listed twice');
    // The same id in two collections is two items.
    expect(issueAt(shopInput(starters('1-5', '1-5')), SHOP_CONTROL.starters(1))).toBeUndefined();
    expect(issueAt(shopInput(starters('1-6', 'seven')), SHOP_CONTROL.starters(1))).toBe(IDS_LINE);
    // Ids the page cannot read build no starter set (the spec stays encodable); the issue holds Contents.
    const bad = buildSpecV2(shopInput(starters('1-6', 'seven')));
    expect(starterCommitmentV2(bad)).toEqual({ setHash: `0x${'0'.repeat(64)}`, count: 0 });
    // The validator agrees about a set of nine (add-on 8's own rule).
    expect(verdict(shopInput(starters('1-5', '6-9'))).reason).not.toBe(0);
  });

  it('each item must be in the wallet the creator connects: asked on the chain, held at the Overview until it is', () => {
    const ten = shopInput(starters());
    const items = required(starterItemsOf(required(ten.v2.shop)));
    const row = (input: Parameters<typeof v2Issues>[0]) => v2Issues(input).filter((issue) => issue.control === SHOP_CONTROL.startersRow);
    expect(row({ ...ten, owner: null })).toEqual([{ step: 'v2-overview', control: SHOP_CONTROL.startersRow, message: 'Connect the wallet that holds the starter items.' }]);
    // The Demo asks no chain: nothing more is held.
    expect(row(ten)).toEqual([]);
    const answers = (answer: (i: number) => StarterCheck | 'unknown' | undefined) => new Map(items.flatMap((item, i) => { const a = answer(i); return a ? [[starterKey(item), a] as const] : []; }));
    expect(row({ ...ten, starterChecks: answers(() => 'yours') })).toEqual([]);
    expect(row({ ...ten, starterChecks: answers((i) => (i < 9 ? 'yours' : undefined)) }).map((issue) => issue.message)).toEqual(['Checking the starter items']);
    expect(row({ ...ten, starterChecks: answers((i) => (i === 3 ? 'unknown' : 'yours')) }).map((issue) => issue.message)).toEqual(['Checking the starter items']);
    expect(row({ ...ten, starterChecks: answers((i) => (i % 5 === 0 ? 'not-yours' : 'yours')) }).map((issue) => issue.message)).toEqual(['Not in your wallet: 2 starter items']);
    expect(row({ ...ten, starterChecks: answers((i) => (i === 0 ? 'not-yours' : 'yours')) }).map((issue) => issue.message)).toEqual(['Not in your wallet: 1 starter item']);
    // A shop without starter items asks nothing about them.
    expect(row({ ...shopInput(), owner: null })).toEqual([]);
  });

  it('the plan: after Create, each page’s items approved one by one, then the page, before the seed', () => {
    const input = shopInput(starters());
    const plan = creationPlan(buildSpecV2(input), recipeCtx(input).pricing, { estimate: demoCreateGas, shopSeedT: 1000n * E18, starters: 10 });
    expect(plan.steps.map((step) => step.call)).toEqual(['createBox', ...Array(10).fill('approveStarter'), 'loadStarter', 'approveShopSeed', 'fundSeed', 'complete']);
    const big = creationPlan(buildSpecV2(input), recipeCtx(input).pricing, { estimate: demoCreateGas, shopSeedT: 1000n * E18, starters: 40 });
    expect(big.steps.map((step) => `${step.call}${step.index ?? ''}`).slice(1, -3)).toEqual([...Array.from({ length: 32 }, (_, i) => `approveStarter${i}`), 'loadStarter0', ...Array.from({ length: 8 }, (_, i) => `approveStarter${32 + i}`), 'loadStarter1']);
  });
});

describe('SH-SHOP-CREATE no curator', () => {
  it('is the zero curator: the validator takes it, and the page asks no wallet for it', () => {
    const input = { ...shopInput({ curator: 'none', curatorAddress: '' }), owner: null };
    const spec = buildSpecV2(input);
    expect(shopConfigV2(spec.contentsParams).curator).toBe('0x0000000000000000000000000000000000000000');
    expect(curatorOf(required(input.v2.shop), SAFE as `0x${string}`)).toBe('0x0000000000000000000000000000000000000000');
    expect(verdict(input)).toEqual({ reason: 0, field: 0 });
    expect(v2Issues(input).filter((issue) => issue.control === SHOP_CONTROL.curatorRow || issue.control === SHOP_CONTROL.curatorAddress)).toEqual([]);
  });

  it('the deployed v2.1 shop allows it: ShopVaultV2 stores the committed curator unchecked and refuses every curator action while it is zero', () => {
    // core-v21-rc8 (the Sepolia release) has these same sources; IShopVaultV2 names zero "a fixed list".
    const vault = read('packages/contracts/src/box-v2/ShopVaultV2.sol');
    const api = read('packages/contracts/src/box-v2/interfaces/IShopVaultV2.sol');
    const spec = read('packages/contracts/src/box-v2/BoxSpecV2.sol');
    expect(api).toContain('/// @notice Initial curator, or zero for a fixed list; no curator may remove or alter entries/prices.');
    expect(vault).toContain('curator = cfg.curator;');
    expect(vault).not.toMatch(/cfg\.curator\s*==\s*address\(0\)/);
    // addCollection, proposeCurator and renounceCurator all pass `_onlyCurator`, which refuses a zero curator; acceptCurator needs a pending one.
    expect(vault).toContain('if (_failed || msg.sender != curator || curator == address(0)) revert Unauthorized(msg.sender);');
    expect(vault.match(/_onlyCurator\(\);/g)).toHaveLength(3);
    expect(vault).toContain('if (_failed || msg.sender != pendingCurator || pendingCurator == address(0)) revert Unauthorized(msg.sender);');
    // The factory's spec check reads the curator word only as an address (word 10), never refusing zero.
    expect(spec).toContain('if (_pw(p, 10) > 1_461_501_637_330_902_918_203_684_832_716_283_019_655_932_542_975) return (REASON_RECIPE_RULE, FIELD_CONTENTS_PARAMS);');
    expect(spec).not.toMatch(/_pw\(p, 10\) == 0/);
  });
});

describe('SH-254 a typed address is checked, never repaired', () => {
  const RIGHT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  it('accepts a checksummed address, and one all in lower or all in upper case', () => {
    expect(typedAddressOf(RIGHT)).toBe(RIGHT);
    expect(typedAddressOf(RIGHT.toLowerCase())).toBe(RIGHT);
    expect(typedAddressOf(`0x${RIGHT.slice(2).toUpperCase()}`)).toBe(RIGHT);
  });
  it('refuses a mixed-case address whose checksum is wrong (one mistyped digit), as the field says', () => {
    // One digit changed in the checksummed form: still hex, still mixed case, the checksum no longer matches.
    const typo = `${RIGHT.slice(0, -1)}9`;
    expect(typedAddressOf(typo)).toBeNull();
    expect(typedAddressOf('0xDe00000000000000000000000000000000000B22')).toBeNull();
  });
});
