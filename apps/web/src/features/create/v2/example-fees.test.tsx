import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS } from './listings';
import { INSIDE, pickFor, type FeeChoice, type SidePick } from './recipes';
import { required } from '../../core/v2/test-support/required';

// Exercise createExample's real fee locators against the real step without a browser, RPC, art upload or send.
// The surrounding form's page assertions and backend imports are outside this selector regression.
vi.mock('@playwright/test', () => ({ expect: (value: unknown) => ({
  toEqual: (wanted: unknown) => expect(value).toEqual(wanted),
  toHaveAttribute: async () => {}, toHaveText: async () => {},
}) }));
vi.mock('../../../../../../packages/chain/scripts/local-core-v2-chain.mjs', () => ({ readLocalBox: vi.fn() }));
vi.mock('../../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs', () => ({ sha256Hex: vi.fn(), writeExampleArt: vi.fn() }));
vi.mock('../../../../../../packages/box-spec/examples/v2/registry.mjs', () => ({ ITEMS_INSIDE_POLICIES: {} }));
vi.mock('../../../../e2e/core-v2-chain/examples/chain.mjs', () => ({ artifact: vi.fn(), read: vi.fn(), call: vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(here, '../../../../e2e/core-v2-chain/examples/create.mjs');
const { createExample } = await import(/* @vite-ignore */ helperPath) as {
  createExample: (page: unknown, chain: unknown, example: unknown, wallet: unknown, evidence: unknown) => Promise<unknown>;
};
type Pick = { choice: FeeChoice; inside?: keyof typeof INSIDE };
type Example = { ticker: string; priceCoin: { symbol: string }; contents: { kind: string }; fees: { buyers: Pick; sellers: Pick } };
const exampleOf = (id: string): Example => JSON.parse(readFileSync(resolve(here, `../../../../../../packages/box-spec/examples/v2/${id}.json`), 'utf8')) as Example;
afterEach(cleanup);

describe('SH-194-af1: example fee selectors match the creation step', () => {
  const check = async (example: Example) => {
    const pricing = { ...required(DEMO_LISTINGS[0]), symbol: example.priceCoin.symbol, checkedBurn: false };
    let picks = { buyers: pickFor('keep'), sellers: pickFor('keep') };
    const step = () => <FeesStep {...picks} ctx={{ pricing, ticker: example.ticker, listings: [pricing] }} collection pileInPrice errorFor={() => null}
      set={(patch: { buyers?: SidePick; sellers?: SidePick }) => { picks = { ...picks, ...patch }; view.rerender(step()); }} />;
    const view = render(step());
    const noop = () => {};
    const outsideFees = { click: noop, fill: noop, check: noop, setInputFiles: noop };
    const finished = new Error('fee picks complete');
    let next = 0;
    const page = {
      goto: noop,
      locator: (selector: string) => {
        if (!selector.startsWith('#create-v2-')) return outsideFees;
        // The Alchemist's unchanged module setup is outside this test; its sellers' burn still runs below.
        if (selector === '#create-v2-buyers' && example.fees.buyers.choice === 'alchemist') return { getByRole: () => outsideFees };
        return { getByRole: (role: 'button', options: { name: string; exact: boolean }) => {
          expect(options.exact).toBe(true);
          const group = required(view.container.querySelector<HTMLElement>(selector));
          return { click: () => fireEvent.click(within(group).getByRole(role, { name: options.name })) };
        } };
      },
      getByRole: (_role: string, options: { name: string | RegExp }) => options.name === 'Next'
        ? { click: () => { if (++next === 3) throw finished; } } : outsideFees,
    };
    // Contents setup is skipped; only the actual fixture's fee choices matter here. Stop before download/send.
    await expect(createExample(page, {}, { ...example, contents: { ...example.contents, kind: 'token' } }, { requests: [] }, {})).rejects.toBe(finished);
    for (const side of ['buyers', 'sellers'] as const) {
      const pick = example.fees[side];
      if (pick.choice === 'alchemist') continue;
      expect(picks[side]).toEqual(pickFor(pick.choice, pick.inside ? INSIDE[pick.inside] : undefined));
    }
  };

  it.each(['rent-free', 'exit-liquidity', 'paper-certificates', 'gpu-poor', 'the-alchemist', 'dragons-hoard'])('%s selects its main and in-vault choices', async id => {
    await check(exampleOf(id));
  });
  it('selects box-token claims and preserves the vault burn rule', async () => {
    await check({ ...exampleOf('rent-free'), fees: { buyers: { choice: 'holders-t' }, sellers: { choice: 'items-t', inside: 'burn' } } });
  });
});
