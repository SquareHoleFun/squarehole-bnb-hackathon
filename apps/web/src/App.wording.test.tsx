/**
 * Rendered wording check (F23 "use safe wording everywhere"; core v2 C21; SEC staff FAQ Q2.5): every route of the demo
 * app, disconnected and with each demo persona connected, passes `appCopyFraming` (features/legal/wording.ts) over its
 * rendered copy, accessible names and page title. The source scan (copy-wording.test.ts) covers states a render does
 * not reach; the browser audit is e2e/wording-audit.spec.ts.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCopyFraming, renderedCopy } from './features/legal/wording';
import { DEMO_WALLET_TITLE } from './features/wallet';
import { withoutTemplateNames } from './features/create/v2/test-support/template-wording';
import { click, connectAs, flush, renderM3 } from './test-support/m3';

// The FIT pair page is a lazy route: load its chunk once so the fake-timer flush can render it.
await import('./pages/FitPairPage');

const ORCHARD = '0x0000000000000000000000000000000000000066';
const ROUND = '0x0000000000000000000000000000000000000067';
const FRAMES = '0x000000000000000000000000000000000000006a';
const KITES = '0xde00700000000000000000000000000000000001';
const MISFITS_BOX = '/box/31337/0x000000000000000000000000000000000000f17e';
const ROUTES = [
  '/',
  '/?state=bonding&sort=mcap',
  `${MISFITS_BOX}`,
  `${MISFITS_BOX}?tab=token`,
  `${MISFITS_BOX}?tab=owning`,
  `${MISFITS_BOX}?tab=about`,
  `${MISFITS_BOX}?scenario=migrated&tab=owning`,
  `${MISFITS_BOX}?scenario=before_open`,
  `/box/31337/${KITES}`,
  '/box/31337/0xde00700000000000000000000000000000000003',
  '/box/31337/0xde00700000000000000000000000000000000005?tab=owning',
  '/wallet/0xde00000000000000000000000000000000000a11',
  '/wallet/0xde00000000000000000000000000000000000b22',
  '/my-box',
  '/pairs',
  '/pairs?type=nft_collection',
  '/launch',
  // SH-AI-PLAN: the plan guide, with its prompt for an AI.
  '/create/plan',
  '/rewards',
  `/rewards?pair=31337%3A${FRAMES}`,
  '/rewards?scenario=conversion_fails',
  '/rewards?scenario=unavailable',
  '/portfolio',
  '/settings',
  '/about/risks',
  '/about/terms',
  '/about/privacy',
  `/pair/31337/${ORCHARD}`,
  `/pair/31337/${ROUND}`,
  `/pair/31337/${FRAMES}`,
  '/fit-pair',
  '/fit-pair?scenario=window',
  '/fit-pair?scenario=migrated',
  '/no-such-page',
];
// The picker's personas (SH-V2-FE11: the old pairs' holders are no longer offered).
const PERSONAS = ['Never held', 'Box wallet A', 'Box wallet B'] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

/**
 * Framing found on the whole rendered document: copy blocks, attribute copy and the page title. "Grow the pool", the
 * format 2 flow's fee choice, is the one form of "grow" the rule allows (F23; templates.ts, wording-v2.test.tsx): Launch
 * opens that flow in every build. No template name is an exception (founder R47J: "To the creator", "To holders",
 * create/v2/templates.ts; test-support/template-wording.ts lists none).
 */
function framing(label: string): string[] {
  const copy = [...renderedCopy(document.body), document.title].map((text) => withoutTemplateNames(text.replace(/\bGrow the pool\b/g, 'Add to the pool')));
  return appCopyFraming(copy).map((clause) => `${label}: ${clause}`);
}

describe('every rendered route follows the safe wording rule (F23)', () => {
  it.each(ROUTES)('%s: disconnected and with each demo persona', async (path) => {
    const found: string[] = [];
    renderM3(path);
    await flush();
    expect(screen.getByRole('main')).toBeTruthy();
    // The lazy FIT pair page must have rendered, not its loading fallback.
    if (path.startsWith('/fit-pair')) expect(document.querySelector('.sh-fit-ca__address')?.textContent).toMatch(/^0x[0-9a-f]{40}$/);
    found.push(...framing(`${path} (disconnected)`));
    for (const persona of PERSONAS) {
      await connectAs(persona);
      found.push(...framing(`${path} (${persona})`));
    }
    expect(found).toEqual([]);
  });

  it('the demo wallet window (persona descriptions), and the Claims page name (unrouted since F134 R46B, mounted for its test)', async () => {
    renderM3('/rewards', { legacy: true });
    await flush();
    const banner = screen.getAllByRole('banner').find((element) => within(element).queryByRole('button', { name: /wallet/i }));
    await click(within(banner as HTMLElement).getByRole('button', { name: /wallet/i }));
    const dialog = screen.getByRole('dialog', { name: DEMO_WALLET_TITLE });
    expect(dialog.textContent).toContain('Has credited fees to claim');
    expect(appCopyFraming(renderedCopy(dialog))).toEqual([]);
    expect(dialog.textContent).toContain('During the curve: FIT, two sealed Misfits');
    expect(screen.getByRole('heading', { level: 1, name: 'Claims' })).toBeTruthy();
  });
});
