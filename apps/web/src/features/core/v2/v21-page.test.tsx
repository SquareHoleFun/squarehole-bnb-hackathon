/**
 * SH-V21-FE12 on the box page: the v2.1 choices in the page's words (Burn or Lock by the receiver's own creation
 * snapshot, the box token named for a T payout, To the pile), the Eaten total, a failed box's claims without end and the
 * money no claim can reach (RC5-A, F136: no FIT sweep), the status line of a box the indexer has not checked yet, and the
 * snapshot's v2.1 fields parsed from decimal strings only.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeAbiParameters, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { boxSpecV2Parameter, encodeBoxSpecV2, type BoxSpecV2 } from '../../../../../../packages/chain/src/core/v2';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { feeText, lockedForGoodP, statusLine, V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { recordV2, summaryV2 } from './record-v2';
import { publishedV2 } from './test-support/published-v2';
import { required } from './test-support/required';
import { feePlace, pictureLoaded } from './test-support/picture-loaded';

vi.mock('./SafesV2', () => ({ SafesV2: () => <p>Safe read panel</p> }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => <p>Burn log panel</p> }));
// SH-255: these pages now wait for the picture's lazy chunk, long enough for the chart to start: the chart's drawing as
// every page test that waits has it (jsdom has no canvas or matchMedia; the real library threw after teardown).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Json = Record<string, unknown>;
const branch = (leg: number, dest: number, destParams: Hex = '0x') => ({ leg, dest, legParams: '0x' as Hex, destParams });
const side = (leg: number, dest: number, destParams: Hex = '0x') => ({ a: branch(leg, dest, destParams), b: branch(0, 0), split: 1, splitParams: '0x' as Hex });
const uint8 = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
const EAT = side(1, 1); const PILE = side(1, 7); const HOLDERS_T = side(2, 6, uint8(2));

/** The published body with its spec's sides replaced (the record's spec hash follows, as a real box's would). */
function withSides(body: Json, sides: Partial<Pick<BoxSpecV2, 'buyers' | 'sellers'>>): Json {
  const row = body.row as Json; const record = row.record as Json;
  const [spec] = decodeAbiParameters([boxSpecV2Parameter], row.encodedSpec as Hex) as unknown as [BoxSpecV2];
  const encodedSpec = encodeBoxSpecV2({ ...spec, ...sides });
  return { ...body, row: { ...row, encodedSpec, specHash: keccak256(encodedSpec), record: { ...record, specHash: keccak256(encodedSpec) } } };
}
const withMoney = (body: Json, money: Json): Json => ({ ...body, money: { ...(body.money as Json), ...money } });
const FIT_SAFE = (body: Json) => ((body.money as Json).safes as Json).fit as string;

async function page(patch: Partial<V2Snapshot> = {}) {
  const { body, source } = await publishedV2();
  const view = { ...parseSnapshotV2(body, source), verified: true, ...patch };
  // SH-BOX-LIFE-VIEW: the record names its price coin (the synthetic listing's 6-decimal coin) by its symbol.
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
  return view;
}
// SH-255: a side's choice as Where the fees go names it on the picture (the Fees card's rows before it).
const feeOf = (label: 'Buyers’ fees' | 'Sellers’ fees') => feePlace(label === 'Buyers’ fees' ? 'buyers' : 'sellers');

describe('the v2.1 snapshot fields', () => {
  it('parses an eat box’s receiver reads, a pile box’s fees and a T box’s purchases, only from decimal strings', async () => {
    const { body, source } = await publishedV2(false);
    const eat = parseSnapshotV2(withMoney(withSides(body, { buyers: EAT, sellers: PILE }), {
      eat: { pendingP: '7', eatenP: '900719925474099300000001', burnSelector: '0x00000000' }, pileFees: { pendingP: '11', movedP: '13' } }), source);
    expect(eat.choices).toEqual({ buyers: 'eat', sellers: 'pile' });
    expect(eat.eat).toEqual({ pendingP: 7n, eatenP: 900719925474099300000001n, burned: false });
    expect(eat.pileFees).toEqual({ pendingP: 11n, movedP: 13n });
    expect(parseSnapshotV2(withMoney(withSides(body, { buyers: EAT }), { eat: { pendingP: '0', eatenP: '1', burnSelector: '0x42966c68' } }), source).eat?.burned).toBe(true);
    // No money read: the eat figures are unavailable, never 0; another box has no eat field at all.
    expect(parseSnapshotV2({ ...withSides(body, { buyers: EAT }), money: null }, source).eat).toBeNull();
    expect('eat' in parseSnapshotV2(body, source)).toBe(false);
    for (const bad of [{ pendingP: 7, eatenP: '1', burnSelector: '0x00000000' }, { pendingP: '7', eatenP: '1', burnSelector: '0x12345678' }]) {
      expect(() => parseSnapshotV2(withMoney(withSides(body, { buyers: EAT }), { eat: bad }), source)).toThrow();
    }
    const t = parseSnapshotV2({ ...withMoney(withSides(body, { sellers: HOLDERS_T }), { payInT: { pendingP: '5', holdersP: '5', buyersItemsP: '0', sellersItemsP: '0', burnPendingT: '0', holderBalanceT: '30', itemBalanceT: '0', receiverBalanceT: '0' } }),
      payInT: { spentP: '1', boughtT: '40', tipsP: '0', holdersFundedT: '40', itemsFundedT: '0', insideBurnT: '0', burnedT: '0', holdersPaidT: '10', holderResidueT: '0', itemsPaidT: '0', itemResidueT: '0',
        batches: { '2': { fundingT: '40', holderT: '38', residueT: '2', paidT: '10', flushedT: '0' } }, paidByItemT: {} } }, source);
    expect(t.choices.sellers).toBe('holders-t');
    expect(t.payInT?.history?.batches['2']).toEqual({ fundingT: 40n, holderT: 38n, residueT: 2n, paidT: 10n, flushedT: 0n });
    expect(t.payInT?.money).toEqual({ pendingP: 5n, holderBalanceT: 30n, itemBalanceT: 0n, burnPendingT: 0n });
    // A T holder box carries the authenticated row the bounded claim readers need (as a P holder box does).
    expect(t.claimRow?.record.specHash).toBe(t.record.specHash);
  });

  it('RC5-A: the closing view carries the pot, the coins still counted and the creator remainder, and no FIT sweep', async () => {
    const { body, source } = await publishedV2(true);
    const closing = body.closing as Json;
    // The indexer publishes no sweep any more; an older publication's field is not read, whatever it names.
    expect(closing).not.toHaveProperty('sweptToFit');
    const parsed = parseSnapshotV2(body, source).closing;
    // RC6 (R2-4a): initialT is PotFixed's counted T, kept after claims; an older publication without it is unknown.
    // RC6-RR-INBOX: the failed box's inbox P at the money hash, none in this box's inbox.
    expect(parsed).toEqual({ pot: 10000001n, initialT: 3n * 10n ** 18n, tLeft: 3n * 10n ** 18n, creatorEntitlement: 0n, inboxP: 0n });
    const { initialT: _published, ...older } = closing;
    expect(_published).toBe('3000000000000000000');
    expect(parseSnapshotV2({ ...body, closing: older }, source).closing?.initialT).toBeNull();
    expect(() => parseSnapshotV2({ ...body, closing: { ...closing, initialT: 3 } }, source)).toThrow();
    for (const legacy of [{ amountP: '1', safe: FIT_SAFE(body) }, { amountP: 1, safe: `0x${'1'.repeat(40)}` }, null]) {
      expect(parseSnapshotV2({ ...body, closing: { ...closing, sweptToFit: legacy } }, source).closing).toEqual(parsed);
    }
  });

  it('a box the indexer has not audited yet reads Checking, a refuted audit Unverified', async () => {
    const { body, source } = await publishedV2();
    const fresh = parseSnapshotV2(body, source);
    expect(body.verified).toBeNull(); expect(fresh.audited).toBe(false); expect(fresh.verified).toBe(false);
    expect(statusLine(fresh, false)).toBe('Checking · a new box is checked within 32 blocks, about 6 minutes on Sepolia.');
    expect(statusLine({ ...fresh, audited: true }, false)).toBe('Unverified · actions wait for a current verified read.');
    expect(statusLine({ ...fresh, audited: true, verified: true }, false)).toBeNull();
    expect(statusLine({ ...fresh, audited: true, verified: true }, true)).toBe('Stale · actions wait for a current verified read.');
    expect(summaryV2(recordV2(fresh, source), fresh, false).notice).toBe('Checking');
    expect(summaryV2(recordV2({ ...fresh, audited: true }, source), { ...fresh, audited: true }, false).notice).toBe('Unverified');
    // FE12 review L-1: only a new box is Checking (two audit periods, 64 blocks); an older box without an audit (one
    // that could not run) is Unverified.
    const at = (age: bigint) => ({ ...fresh, block: fresh.record.creationBlock + age });
    expect(fresh.block - fresh.record.creationBlock).toBeLessThanOrEqual(64n);
    expect(statusLine(at(64n), false)).toMatch(/^Checking · /);
    expect(statusLine(at(65n), false)).toBe('Unverified · actions wait for a current verified read.');
    expect(summaryV2(recordV2(at(65n), source), at(65n), false).notice).toBe('Unverified');
    expect(summaryV2(recordV2(at(64n), source), at(64n), false).notice).toBe('Checking');
  });
});

describe('the box page', () => {
  it('names each v2.1 choice: Burn or Lock by the receiver’s snapshot, Unavailable unread, the box token for a T payout', async () => {
    const { body, source } = await publishedV2(false);
    const view = parseSnapshotV2(withMoney(withSides(body, { buyers: EAT, sellers: HOLDERS_T }), { eat: { pendingP: '0', eatenP: '0', burnSelector: '0x00000000' } }), source);
    expect(feeText(view, 'buyers', 'LINK', 'MARINE')).toBe('Lock LINK');
    expect(feeText({ ...view, eat: { ...required(view.eat), burned: true } }, 'buyers', 'FIT', 'MARINE')).toBe('Burn FIT');
    expect(feeText({ ...view, eat: null }, 'buyers', 'LINK', 'MARINE')).toBe('Unavailable');
    expect(feeText(view, 'sellers', 'LINK', 'MARINE')).toBe('To holders · in MARINE');
    expect(feeText({ ...view, choices: { buyers: 'pile', sellers: 'module' } }, 'buyers', 'ETH', 'X')).toBe('To the pile');
    expect(feeText({ ...view, choices: { buyers: 'pile', sellers: 'module' } }, 'sellers', 'ETH', 'X')).toBe('Fee module');
  });

  it('shows the Eaten total for an eat box, locked or burned with the coin, and what still waits', async () => {
    await page({ failed: null, closing: null, graduated: true, choices: { buyers: 'eat', sellers: 'burn' }, eat: { pendingP: 7_000_000n, eatenP: 12_345_678n, burned: false } });
    const panel = screen.getByRole('region', { name: 'Eaten' });
    expect(panel.querySelector('.sh-v2-value')?.textContent).toBe('12.345678 tUSDC');
    expect(within(panel).getByText('Locked')).toBeTruthy();
    expect(within(panel).getByText('Waiting', { selector: 'dt' }).nextElementSibling?.textContent).toBe('7 tUSDC');
    expect(within(panel).getByText('0x000000000000000000000000000000000000dEaD')).toBeTruthy();
    expect(await feeOf('Buyers’ fees')).toBe('Lock tUSDC');
    expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
    cleanup();
    await page({ failed: null, closing: null, choices: { buyers: 'eat', sellers: 'eat' }, eat: null });
    expect(screen.getByRole('region', { name: 'Eaten' }).querySelector('.sh-v2-value')?.textContent).toBe('Unavailable');
    expect(await feeOf('Buyers’ fees')).toBe('Unavailable');
  });

  it('RC5-A: a failed box’s claim stays usable with no time limit, even with an empty pot; nothing is swept to FIT', async () => {
    const view = await page();
    const failed = required(view.failed);
    // The fixture failed decades before the clock this page reads: far past the retired year, the claim is still offered.
    expect(BigInt(Math.floor(Date.now() / 1000)) - failed.at).toBeGreaterThan(365n * 86_400n);
    const claim = screen.getByRole('region', { name: 'Failure claim' });
    expect(within(claim).getByText(/Claims never close\./)).toBeTruthy();
    expect(within(claim).getByText(/stay locked for good: nobody can take them out, Square Hole included\./)).toBeTruthy();
    // RC6 (F137, F138): every holder claim moves the box's fees and the inbox's P into the pot first.
    expect(within(claim).getByText(/^Each holder claim first moves the fees still in the box and the inbox’s tUSDC into the pot, then takes its share\./)).toBeTruthy();
    expect(claim.textContent).not.toMatch(/when anyone collects/);
    expect(screen.getByRole('textbox', { name: 'Coins to claim' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim tUSDC' })).toBeTruthy();
    expect(screen.getByText('Approve, then claim · claims do not expire')).toBeTruthy();
    expect(claim.textContent).not.toMatch(/FIT|sweep|swept|year/i);
    expect(screen.queryByText(/Locked for good/)).toBeNull();
    cleanup();
    // A zero pot with coins still counted: the right to claim stays, at a price of 0.
    await page({ closing: { pot: 0n, initialT: 3n * 10n ** 18n, tLeft: 3n * 10n ** 18n, creatorEntitlement: 0n } });
    expect(screen.getByRole('region', { name: 'Failure claim' }).querySelector('.sh-v2-value')?.textContent).toBe('0 tUSDC per 1M B4');
    expect(screen.getByRole('button', { name: 'Claim tUSDC' })).toBeTruthy();
  });

  it('RC5-A: once every counted coin is in, later money is locked for good, never the creator’s or FIT’s', async () => {
    const view = await page();
    const closing = required(view.closing);
    cleanup();
    // Every counted coin claimed, 5 P arrived afterwards: locked, no claim button for anyone.
    await page({ closing: { ...closing, pot: 5_000_000n, tLeft: 0n, creatorEntitlement: 0n } });
    let claim = screen.getByRole('region', { name: 'Failure claim' });
    expect(within(claim).getByText('No coins left to claim')).toBeTruthy();
    expect(within(claim).getByText('Locked for good 5 tUSDC')).toBeTruthy();
    // R2-4a: a box with buyers whose last holder claimed is not a box nobody bought (initialT 3 coins).
    expect(closing.initialT).toBe(3n * 10n ** 18n);
    expect(within(claim).queryByText(/With no buyers/)).toBeNull();
    cleanup();
    // An older publication without initialT: unknown, so the no-buyer sentence is not shown, even with tLeft 0.
    await page({ closing: { ...closing, initialT: null, pot: 5_000_000n, tLeft: 0n, creatorEntitlement: 0n } });
    expect(within(screen.getByRole('region', { name: 'Failure claim' })).queryByText(/With no buyers/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Claim tUSDC' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Claim creator remainder' })).toBeNull();
    cleanup();
    // Nobody bought: the creator's remainder stays claimable; 5 P that arrived later outside the inbox is locked beside it.
    await page({ closing: { ...closing, pot: 7_000_000n, initialT: 0n, tLeft: 0n, creatorEntitlement: 2_000_000n } });
    claim = screen.getByRole('region', { name: 'Failure claim' });
    expect(within(claim).getByText('Locked for good 5 tUSDC')).toBeTruthy();
    expect(within(claim).getByText('Creator remainder: 2 tUSDC')).toBeTruthy();
    // INBOX af2: inbox P moved into the pot later is the creator's, never locked. RC6RR2-FC-2: only the address that
    // made the box claims it, to any address it names; a fee payee the creator rotated to cannot.
    expect(within(claim).getByText('With no buyers, inbox tUSDC that reaches the pot later is added to the creator remainder.')).toBeTruthy();
    expect(within(claim).getByText('Only the address that made the box can claim it, to any address it names, not a later fee payee.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim creator remainder' })).toBeTruthy();
    cleanup();
    await page({ closing: { ...closing, pot: 2_000_000n, tLeft: 0n, creatorEntitlement: 2_000_000n } });
    expect(screen.queryByText(/Locked for good/)).toBeNull();
    expect(lockedForGoodP({ pot: 1n, tLeft: 1n, creatorEntitlement: 0n })).toBe(0n);
    expect(lockedForGoodP({ pot: 1n, tLeft: 0n, creatorEntitlement: 2n })).toBe(0n);
  });

  it('RC6-RR-INBOX: inbox P a claim still moves in is shown apart from the pot, never as held by the coordinator', async () => {
    const view = await page();
    const closing = required(view.closing);
    cleanup();
    // Nobody bought; 77 P reached the inbox after the creator's paid claim. claimState and quoteClaim(0) both count it.
    await page({ closing: { ...closing, pot: 77_000_000n, initialT: 0n, tLeft: 0n, creatorEntitlement: 77_000_000n, inboxP: 77_000_000n } });
    let claim = screen.getByRole('region', { name: 'Failure claim' });
    expect(within(claim).getByText('Claim pot 0 tUSDC · 0 coins left')).toBeTruthy();
    expect(within(claim).getByText('77 tUSDC waits in the inbox; the creator’s claim moves it into the pot first.')).toBeTruthy();
    expect(within(claim).getByText('Creator remainder: 77 tUSDC')).toBeTruthy();
    expect(within(claim).queryByText(/Locked for good/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Claim creator remainder' })).toBeTruthy();
    cleanup();
    // Holders still to claim: their pot excludes the inbox, and the next claim sweeps it in.
    await page({ closing: { ...closing, pot: 5_000_000n, inboxP: 2_000_000n } });
    claim = screen.getByRole('region', { name: 'Failure claim' });
    expect(within(claim).getByText(`Claim pot 5 tUSDC · ${Number(closing.tLeft / 10n ** 18n)} coins left`)).toBeTruthy();
    expect(within(claim).getByText('2 tUSDC waits in the inbox; the next claim moves it into the pot first.')).toBeTruthy();
    cleanup();
    // Every counted coin is in: no claim can take inbox P any more, so no line promises one; unknown inbox P: none either.
    for (const patch of [{ pot: 5_000_000n, tLeft: 0n, creatorEntitlement: 0n, inboxP: 2_000_000n }, { pot: 77_000_000n, initialT: 0n, tLeft: 0n, creatorEntitlement: 77_000_000n, inboxP: null }]) {
      await page({ closing: { ...closing, ...patch } });
      claim = screen.getByRole('region', { name: 'Failure claim' });
      expect(within(claim).queryByText(/waits in the inbox/)).toBeNull();
      expect(within(claim).getByText(`Claim pot ${patch.pot / 1_000_000n} tUSDC · 0 coins left`)).toBeTruthy();
      cleanup();
    }
  });

  it('RC6-RR-INBOX: parses the closing inbox P, unknown (null) in an older publication', async () => {
    const { body, source } = await publishedV2();
    const closing = (body.closing ?? {}) as Json;
    expect(parseSnapshotV2({ ...body, closing: { ...closing, inboxP: '77' } }, source).closing?.inboxP).toBe(77n);
    expect(parseSnapshotV2({ ...body, closing: { ...closing, inboxP: null } }, source).closing?.inboxP).toBeNull();
    // The publication now carries it (the scripted box's inbox holds none); one without it is an older one.
    const { inboxP: published, ...older } = closing;
    expect(published).toBe('0');
    expect(parseSnapshotV2({ ...body, closing: older }, source).closing?.inboxP).toBeNull();
  });

  it('F138: the income inbox shows its coins; a failed box sells nothing more and hands other coins to the payee', async () => {
    const coin = `0x${'ab'.repeat(20)}`; const usdc = `0x${'cd'.repeat(20)}`;
    const view = await page();
    expect(view.failed).not.toBeNull();
    const money = required(view.money);
    const inbox = { router: `0x${'ee'.repeat(20)}` as const, payee: view.record.creator, balances: { [coin]: 7n }, listVersion: 3n, complete: true,
      coins: [{ coin: usdc as `0x${string}`, lot: 100n, balance: 250n, oldestUnsoldAt: view.timestamp, registered: true, belowOneLot: false }] };
    cleanup();
    await page({ money: { ...money, inbox } });
    expect(screen.getByText(`${coin}: 7 raw units`)).toBeTruthy();
    expect(screen.getByText(`${usdc}: 250 raw units`)).toBeTruthy();
    // Part 2 fix round (review low 4b): the payee takes in-kind coins with claimInKind; nothing is sent by itself.
    expect(screen.getByText(/^This box sells nothing more\. The creator’s payee can take its coins other than tUSDC as they are; tUSDC here joins the claim pot\./)).toBeTruthy();
    expect(screen.queryByText(/conversion Safe|locked for good \(|awaiting forwarding/)).toBeNull();
    // The page's existing 'Grow the pool' choice label is the one allowed phrase (as in the eat test above).
    expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
    cleanup();
    // A live box: the listed coin is for sale; its 30-day wait counts from the observed clock.
    const now = BigInt(Math.floor(Date.now() / 1000));
    // RC6 part 4: the indexer also publishes coins with no lot (P, T, ETH and coins learnt from receipts): never for sale.
    const unlisted = { coin: coin as `0x${string}`, lot: 0n, balance: 7n, oldestUnsoldAt: 0n, registered: false, belowOneLot: false };
    await page({ failed: null, closing: null, money: { ...money, inbox: { ...inbox, coins: [{ ...required(inbox.coins[0]), oldestUnsoldAt: now - 86_400n }, unlisted] } } });
    expect(screen.getByText(`${usdc}: 250 raw units · for sale, or the payee’s in 29 days without a sale`)).toBeTruthy();
    expect(screen.getByText(`${coin}: 7 raw units`)).toBeTruthy();
    expect(screen.getAllByText(/for sale/)).toHaveLength(1);
    // Part 3: the box offers listed coins on CoW (our poster posts them); a sale is not promised, so the words never say
    // they sell, and the payee can take one that does not sell for 30 days.
    expect(screen.getByText(/^Royalties and gifts in other coins arrive here\. The box offers coins on its sale list for tUSDC on CoW, in whole lots\. If one does not sell for 30 days, the creator’s payee can take it as it is, and any other coin at any time\. ETH is taken as WETH\.$/)).toBeTruthy();
    expect(screen.queryByText(/sell for P through CoW/)).toBeNull();
    cleanup();
    await page({ failed: null, closing: null, money: { ...money, inbox: null } });
    expect(screen.getByText('Inbox balances unavailable.')).toBeTruthy();
  });

  it('COW-2: a listed coin below one lot is never for sale, and its in-kind countdown runs only from a started clock', async () => {
    const usdc = `0x${'cd'.repeat(20)}` as const;
    const view = await page();
    const money = required(view.money);
    cleanup();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const inbox = (coins: NonNullable<NonNullable<V2Snapshot['money']>['inbox']>['coins']) =>
      ({ router: `0x${'ee'.repeat(20)}` as const, payee: view.record.creator, balances: {}, listVersion: 3n, complete: true, coins });
    const dust = (oldestUnsoldAt: bigint) => ({ coin: usdc, lot: 100n, balance: 40n, oldestUnsoldAt, registered: false, belowOneLot: true });
    for (const [clock, words] of [
      [0n, ' · below one lot; waiting for observation to start the 30-day in-kind wait'],
      [now - 86_400n, ' · below one lot; the payee can claim in kind in 29 days if the clock does not restart'],
      [now - 31n * 86_400n, ' · below one lot; the payee can claim in kind now'],
    ] as const) {
      await page({ failed: null, closing: null, money: { ...money, inbox: inbox([dust(clock)]) } });
      expect(screen.getByText(`${usdc}: 40 raw units${words}`)).toBeTruthy();
      expect(screen.queryByText(/for sale/)).toBeNull();
      cleanup();
    }
    // A whole lot whose clock nobody has observed yet: offered on CoW, with no countdown from an unstarted clock.
    await page({ failed: null, closing: null, money: { ...money, inbox: inbox([{ ...dust(0n), balance: 250n, belowOneLot: false }]) } });
    expect(screen.getByText(`${usdc}: 250 raw units · for sale`)).toBeTruthy();
    expect(screen.queryByText(/payee’s in \d+ days|claim in kind in/)).toBeNull();
    cleanup();
    // A failed box offers nothing more and has no wait: the coin is listed without sale or countdown words.
    await page({ money: { ...money, inbox: inbox([dust(now - 86_400n)]) } });
    expect(screen.getByText(`${usdc}: 40 raw units`)).toBeTruthy();
  });

  it('SH-RC7 item 29: the WETH row counts the inbox’s ETH toward one lot, as observe(WETH) and refreshOrder(WETH) wrap it first', async () => {
    const usdc = `0x${'cd'.repeat(20)}` as const; const eth = `0x${'00'.repeat(20)}`;
    const view = await page();
    const money = required(view.money);
    const weth = (await publishedV2()).source.manifest.chain.weth.address.toLowerCase() as `0x${string}`;
    cleanup();
    // The indexer's row counts WETH only (balance 40 of a 100 lot: below one lot); the inbox's ETH sits beside it.
    const show = (ethHeld: bigint | null, coins = [{ coin: weth, lot: 100n, balance: 40n, oldestUnsoldAt: 0n, registered: false, belowOneLot: true },
      { coin: usdc, lot: 100n, balance: 40n, oldestUnsoldAt: 0n, registered: false, belowOneLot: true }]) =>
      page({ failed: null, closing: null, money: { ...money, inbox: { router: `0x${'ee'.repeat(20)}`, payee: view.record.creator,
        balances: ethHeld === null ? {} : { [eth]: ethHeld }, listVersion: 3n, complete: true, coins } } });
    const waiting = ' · below one lot; waiting for observation to start the 30-day in-kind wait';
    // 40 WETH and 60 ETH make a whole lot: offered, never "below one lot". Another coin never counts the ETH.
    await show(60n);
    expect(screen.getByText(`${weth}: 40 raw units · for sale`)).toBeTruthy();
    // Release review IDX-SITE-1: the payee takes the inbox's ETH as WETH (claimInKind(0) wraps it), so its row carries
    // WETH's words.
    expect(screen.getByText(`${eth}: 60 raw units · for sale`)).toBeTruthy();
    expect(screen.getByText(`${usdc}: 40 raw units${waiting}`)).toBeTruthy();
    cleanup();
    // 40 WETH and 59 ETH: still below one lot, counted together.
    await show(59n);
    expect(screen.getByText(`${weth}: 40 raw units${waiting}`)).toBeTruthy();
    expect(screen.getByText(`${eth}: 59 raw units${waiting}`)).toBeTruthy();
    cleanup();
    // The ETH balance unread: the row keeps the published words.
    await show(null);
    expect(screen.getByText(`${weth}: 40 raw units${waiting}`)).toBeTruthy();
    cleanup();
    // A whole lot of WETH alone stays for sale whatever the ETH.
    await show(0n, [{ coin: weth, lot: 100n, balance: 100n, oldestUnsoldAt: 0n, registered: true, belowOneLot: false }]);
    expect(screen.getByText(`${weth}: 100 raw units · for sale`)).toBeTruthy();
  });

  it('COW-2: parses each inbox coin’s belowOneLot, and derives it in bigint for an older publication without it', async () => {
    const { body, source } = await publishedV2();
    const usdc = `0x${'cd'.repeat(20)}`;
    const creator = ((body.row as Json).record as Json).creator as string;
    const coins = (rows: readonly Json[]) => required(parseSnapshotV2(withMoney(body, { royalty: { router: `0x${'ee'.repeat(20)}`, payee: creator,
      balances: {}, listVersion: '3', complete: true, coins: rows } }), source).money?.inbox).coins.map((c) => c.belowOneLot);
    const coin = (lot: string, balance: string, extra: Json = {}) => ({ coin: usdc, lot, balance, oldestUnsoldAt: '0', registered: false, ...extra });
    // Derived: positive custody below a positive lot only, exact beyond 2^53.
    expect(coins([coin('100', '40'), coin('100', '100'), coin('100', '0'), coin('0', '40'),
      coin(String(2n ** 201n), String(2n ** 200n))])).toEqual([true, false, false, false, true]);
    // Published by the chain reader (SH-RC6-RR-OFFCHAIN): taken as given.
    expect(coins([coin('100', '40', { belowOneLot: true }), coin('100', '250', { belowOneLot: false })])).toEqual([true, false]);
  });

  it('says a new box is being checked instead of looking broken', async () => {
    await page({ verified: false, audited: false });
    // SH-255: the notice sits under the name in the picture's head (a lazy chunk).
    await pictureLoaded();
    expect(screen.getByText(/^Checking · a new box is checked within 32 blocks/).getAttribute('role')).toBe('status');
    expect(screen.queryByText(/^Unverified/)).toBeNull();
  });
});
