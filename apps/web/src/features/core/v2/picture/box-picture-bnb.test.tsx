/**
 * SH-273: the box page's picture in this repository's builds. (1) The figures row beside the picture is the header's
 * tiles, with the dollar values the header shows while the indexer's Atlas price is fresh (SH-266). (2) Under
 * `SH_TESTNET=bnb` (BNB Chain testnet, chain 97) Square Hole's sheet has no Safe payouts: that network has no Safes and
 * no FIT, and the page's own Safes panel is left out there too (SH-258); the Sepolia build keeps the block.
 * The boxes are SH-255's recorded Sepolia answers (test-support/box-picture-v2.ts); the price block is a fake in the
 * indexer's shape (SH-266's usd-v2.test.tsx), never a deployment.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../../app-providers';
import { createDemoWalletAdapter } from '../../../wallet';
import { lifeStepsV2 } from '../life-state';
import { boxPictureFixture } from '../test-support/box-picture-v2';
import BoxPagePicture from './BoxPagePicture';
import alchemistSettings from '../../../../../../../packages/box-spec/examples/v2/bnb/the-alchemist.json' with { type: 'json' };

type Json = Record<string, unknown>;
const NO_ALCHEMIST = { buyers: false, sellers: false } as const;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** GPU Poor (priced in tNVDA) with a fresh price of its price coin, as the indexer publishes it. */
function withPrice() {
  return boxPictureFixture('gpu-poor', (answer) => {
    const q = (((answer.row as Json).record as Json).q as string).toLowerCase();
    const at = BigInt(((answer.asOf as Json).timestamp as string));
    return { ...answer, prices: { source: 'Atlas', maxAgeSeconds: '180', coins: [{ role: 'price', token: q, symbol: 'tNVDA', decimals: 18, feed: 'NVDAB/USD', atlasId: 934,
      standsInFor: 'NVDAB', usdX18: '147737064126976709110', aggregatedAt: (at - 21n).toString(), onchainAt: (at - 20n).toString(), ageSeconds: '20', maxAgeSeconds: '180' }] } };
  });
}

describe('SH-273: the figures row beside the picture', () => {
  it('carries the dollar values the header shows while the price is fresh', () => {
    const { record, view } = withPrice();
    expect(view.prices).toBeDefined();
    const nowSec = view.timestamp;
    render(
      <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter>
        <BoxPagePicture record={record} view={view} life={{ steps: lifeStepsV2({ view, nowSec, coin: 'tNVDA', ticker: 'VRAM', price: '0.58', graduatedAt: view.timestamp - 3_600n }), stage: 'graduated', nowSec }}
          alchemist={NO_ALCHEMIST} pileCoin={null} idLine={null} notice={null} creatorClaim={null} entries={[]} closable={false} />
      </MemoryRouter></AppProviders>,
    );
    const tiles = document.querySelector('.sh-bpic-side .sh-box-stats');
    expect(tiles).not.toBeNull();
    // Market cap and 24h volume: the coin, then "about $X" (SH-266's unit), as in the header.
    expect(tiles?.textContent ?? '').toMatch(/tNVDA, about \$/);
  });
});

describe('SH-273: Square Hole’s sheet and the Safes', () => {
  async function markSheet() {
    const { liveModelOf } = await import('./live-picture');
    const { sheetOf } = await import('./LiveSheets');
    const { boxPictureFixture: fixture } = await import('../test-support/box-picture-v2');
    const { record, view } = fixture('gpu-poor');
    const model = liveModelOf(record, view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null });
    const sheet = sheetOf('mark', { record, view, model, nowSec: view.timestamp, pileCoin: null, creatorClaim: null });
    return { html: text(renderToStaticMarkup(<>{sheet.body}</>)), why: sheet.why.join(' ') };
  }

  it('Sepolia (the default build): its 3 parts, then Safe payouts', async () => {
    const { html } = await markSheet();
    expect(html).toMatch(/^0\.179643200038268463 tNVDA Safe payouts Paid to FIT Safe .+ Paid to platform Safe .+$/);
  });

  it('BNB Chain testnet: its 3 parts and nothing about Safes or FIT', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const { html, why } = await markSheet();
    expect(html).toBe('0.179643200038268463 tNVDA');
    expect(`${html} ${why}`).not.toMatch(/Safe|FIT/);
  });
});

/**
 * The Alchemist is not on chain 97 yet (its converter route becomes selectable a day after its registration); its
 * settings are packages/box-spec/examples/v2/bnb/the-alchemist.json: a coin pile priced in tUSDC (6 decimals), a raise
 * of 1 tUSDC, 30 days, the buyers' fees through The Alchemist into a tNVDA pile that leaves 5% behind, the sellers'
 * fees buy back and burn. The recorded Sepolia Alchemist has the same rules (checked against the settings below); its
 * price coin, decimals, raise and fees are set to the chain-97 settings, and the picture is drawn under
 * `SH_TESTNET=bnb`, raising and graduated, with the module unchecked and checked.
 */
describe('SH-273: The Alchemist from its chain-97 settings', () => {
  const settings = alchemistSettings as Json;
  const fees = settings.fees as { buyers: { choice: string }; sellers: { choice: string } };
  const contents = settings.contents as { kind: string; leaveBehindBps: string; seed: { amount: string } };

  async function alchemistOnBnb(stage: 'raising' | 'graduated', checked: boolean) {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const { boxPictureFixture: fixture } = await import('../test-support/box-picture-v2');
    const { recordV2 } = await import('../record-v2');
    const { liveModelOf, livePictureOf } = await import('./live-picture');
    const { sheetOf } = await import('./LiveSheets');
    const { pileConfigV2 } = await import('../../../../../../../packages/chain/src/core/v2');
    const raise = (settings.raise as { amount: string }).amount;
    const f = fixture('the-alchemist', (answer) => {
      const edited: Json = answer;
      if (stage === 'graduated') return { ...edited, fees: { ...(answer.fees as Json), buyersP: '1808808', sellersP: '0', tipsP: '0' } };
      // Raising: a quarter of the raise in, ten days left on chain time, nothing split yet.
      const at = BigInt((answer.asOf as Json).timestamp as string);
      return { ...edited, graduated: false, closedAt: '0', gate: { ...(answer.gate as Json), deadline: (at + 864_000n).toString() },
        statistics: { ...(answer.statistics as Json), raiseProgress: { raisedP: '250000', raiseP: raise, progressBps: '2500' } }, position: null, pool: null };
    });
    // The raise and the coin's decimals after parsing: the spec is decoded from its encoded bytes, which hold the recorded raise.
    const view = { ...f.view, decimals: Number((settings.priceCoin as { decimals: string }).decimals), record: { ...f.view.record, raise: BigInt(raise) }, spec: { ...f.view.spec, raise: BigInt(raise) } };
    const record = recordV2(view, f.source, null, 'tUSDC');
    const pileCoin = { symbol: 'tNVDA', decimals: 18 };
    const model = liveModelOf(record, view, { nowSec: f.view.timestamp, alchemist: { buyers: checked, sellers: false }, pileCoin });
    const picture = livePictureOf(model);
    const ids = [...picture.parts.map((part) => part.id), 'inbox' as const];
    const sheets = ids.map((id) => {
      const sheet = sheetOf(id, { record, view, model, nowSec: view.timestamp, pileCoin, creatorClaim: null });
      return { id, title: sheet.title, why: sheet.why.join(' '), body: text(renderToStaticMarkup(<>{sheet.body}</>)) };
    });
    return { view, model, picture, sheets, pile: pileConfigV2(view.spec.contentsParams) };
  }

  it('the recorded Alchemist has the chain-97 settings\' rules', async () => {
    const { view, pile } = await alchemistOnBnb('raising', false);
    expect([view.choices.buyers, view.choices.sellers]).toEqual([fees.buyers.choice === 'alchemist' ? 'module' : fees.buyers.choice, fees.sellers.choice]);
    expect(view.spec.boxType).toBe(5);
    expect(contents.kind).toBe('pile');
    expect(view.spec.deadlineDays).toBe(Number((settings.deadline as { days: string }).days));
    expect(pile.leaveBehindBps).toBe(BigInt(contents.leaveBehindBps));
    expect(pile.seedAmount).toBe(BigInt(contents.seed.amount));
    expect(view.decimals).toBe(6);
    expect(view.record.raise).toBe(1_000_000n);
  });

  for (const stage of ['raising', 'graduated'] as const) {
    for (const checked of [false, true]) {
      it(`${stage}, the module ${checked ? 'checked' : 'not checked yet'}: every part draws and opens, in the chain's words`, async () => {
        const { model, picture, sheets } = await alchemistOnBnb(stage, checked);
        expect(model.stage).toBe(stage);
        expect(picture.parts).toHaveLength(10);
        // Every sheet says something; nothing names Sepolia, ETH, FIT or a Safe.
        for (const sheet of sheets) expect(sheet.body, sheet.id).not.toBe('');
        const all = [...picture.parts.map((part) => `${part.name} ${part.description ?? ''}`), ...sheets.map((s) => `${s.title} ${s.why} ${s.body}`)].join(' ');
        expect(all).not.toMatch(/Sepolia|\bETH\b|\bFIT\b|Safe/);
        const sheet = (id: string) => sheets.find((s) => s.id === id)?.body ?? '';
        expect(sheet('raise')).toContain(stage === 'raising' ? 'Raised 0.25 / 1 tUSDC' : 'Deadline 30 days');
        expect(sheet('contents')).toMatch(/^tNVDA .*Leave behind 5%/);
        expect(sheet('buyers')).toContain(checked ? 'The Alchemist' : 'Fee module');
        expect(sheet('sellers')).toContain('Buy-back progress');
        if (stage === 'graduated') {
          expect(sheet('buyers')).toMatch(/^1% of every trade: in tUSDC on buys, in LEAD on sales 1\.808808 tUSDC/);
          // The rule's parts of 1.808808 tUSDC: 10, 2 and 3 fifteenths (120,587 raw each), printed short.
          expect(model.fees?.buyers).toMatchObject({ fee: 1_808_808n, pick: 1_205_870n, pool: 241_174n, squareHole: 361_761n });
          expect(model.ledger.map((line) => [line.choice, line.amount !== null])).toEqual([['alchemist', true], ['burn', true], ['pool', true], ['mark', true]]);
        } else {
          expect(model.fees).toBeNull();
          expect(model.ledger.every((line) => line.amount === null)).toBe(true);
        }
      });
    }
  }
});
