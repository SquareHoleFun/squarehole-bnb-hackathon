import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { zeroAddress } from 'viem';
import { expect, it, vi } from 'vitest';
import { RulesPanel, BUY_BACK_SAYS, FINAL_SAYS } from '../src/components/RulesPanel';
import { RULE_KIND } from '../src/lib/rules';

const rule = { kind: RULE_KIND.burn, bps: 10000, target: zeroAddress, owed: 1n, delivered: 2n, burned: 3n };
vi.mock('../src/lib/app-context', () => ({
  useApp: () => ({ config: {} }), useTx: () => ({ step: { kind: 'idle' } }),
  useChainRead: () => ({ state: 'ok', value: { rules: [rule], pending: 4n } }),
}));
vi.mock('../src/lib/wallet', () => ({ useWallet: () => ({}) }));
vi.mock('../src/components/WalletBar', () => ({ useWriteGate: () => ({ ready: true }) }));

// Capture what the panel passes to the real, initially closed Help.
let contents = '';
vi.mock('../src/components/bits', async (original) => {
  const bits = await original<typeof import('../src/components/bits')>();
  return { ...bits, Help: (props: ComponentProps<typeof bits.Help>) => {
    contents = renderToStaticMarkup(createElement('span', null, props.children));
    return createElement(bits.Help, props);
  } };
});

it.each(['flap', 'four'] as const)('%s keeps the explanations in Help and the figures and action on the panel', (rail) => {
  const of = rail === 'flap' ? "Of the curve fees at the launch, and of the tax left after Flap's share and the burned part." : "Of the token's tax.";
  const panel = renderToStaticMarkup(createElement(RulesPanel, {
    rail, of, splitter: zeroAddress, asset: { symbol: 'BNB', decimals: 0 }, tokenSymbol: 'CARD', writable: true,
  }));
  expect(panel).toContain('aria-expanded="false"');
  expect(panel).toContain('data-testid="rule-0-bps"');
  expect(panel).toContain('data-testid="rules-pending"');
  expect(panel).toContain('data-testid="share-out"');
  for (const sentence of [of, FINAL_SAYS[rail], BUY_BACK_SAYS[rail],
    'A part that cannot be paid now stays owed and is tried again at the next share-out.',
    'Share out splits what waits by the parts, then sends each rule what it is owed; what cannot be sent stays owed.',
  ]) {
    expect(panel.replaceAll('&#x27;', "'")).not.toContain(sentence);
    expect(contents.replaceAll('&#x27;', "'")).toContain(sentence);
  }
});
