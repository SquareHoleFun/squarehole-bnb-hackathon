/**
 * M1-53-a wording tests (F99, F100; F23; UI-01; the founder's minimal-text rule): no v2 string or rendered step says
 * "refund" (a failed box pays the closing price from its closing pool); every step passes the app's copy rule; no label,
 * legend, option or accessible name says buy, sell or swap except SH-194's named buyback fee rule (never a
 * trading control); and each step shows few words outside its (i) panels, numbers first.
 */
import { forbiddenLabelNames, RECIPE_CHOICES } from '../../../../e2e/trading-controls';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests } from '../draft';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { withoutTemplateNames } from './test-support/template-wording';
import { V2_STEPS } from './v2-steps';
import { resetV2ForTests } from './v2-draft';
import { seedV2 } from './test-support/v2-fixtures';

const DIR = dirname(fileURLToPath(import.meta.url));
const shipped = readdirSync(DIR).filter((name) => /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name));
/** The words a step may show outside its (i) panels and the chips' own labels (the phone budget of v1's flow is 40). */
const PROSE_BUDGET = 40;

function renderStep(step: string) {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={[`/create/${step}`]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

/** Sentences shown in the step's form: paragraphs not inside a closed (i) panel, an error or a chip. */
function proseWords(): number {
  const form = document.querySelector('.sh-newbox__form');
  if (!form) return 0;
  return Array.from(form.querySelectorAll('p'))
    .filter((p) => !p.closest('[hidden], details:not([open]), .sh-info-panel, .sh-newbox-chip, .sh-newbox-error'))
    .map((p) => (p.textContent ?? '').split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length)
    .reduce((sum, count) => sum + count, 0);
}

beforeEach(() => {
  resetDraftForTests();
  resetV2ForTests();
});
afterEach(cleanup);

describe('v2 sources', () => {
  it('no v2 file says refund or earn', () => {
    expect(shipped.length).toBeGreaterThan(5);
    for (const name of shipped) {
      const text = readFileSync(join(DIR, name), 'utf8');
      expect(/refund/i.test(text), name).toBe(false);
      // No exception since founder R47J renamed the creator's and the holders' templates (templates.ts).
      expect(/\bearn/i.test(text), name).toBe(false);
    }
  });
  it('no v2 page implies an endorsement or hard-codes the ETH raise (it follows the build’s RAISE)', () => {
    const pages = shipped.filter((name) => name.endsWith('.tsx'));
    expect(pages.length).toBeGreaterThan(3);
    for (const name of pages) {
      const text = readFileSync(join(DIR, name), 'utf8');
      expect(/Square Hole (listed|lists|picked|approved|chose)/i.test(text), name).toBe(false);
      expect(/4\.206980085/.test(text), name).toBe(false);
    }
  });
});

describe.each(['depth-reward', 'ultrasound-owls', 'stock-priced', 'box-token-priced', 'rug-rugs', 'bag-holders', 'dragons-hoard', 'curio-corner', 'scrap-shop'])('%s: every rendered v2 step', (id) => {
  it.each(V2_STEPS.map((step) => step.id))('%s', (step) => {
    const config = CONFIGURATIONS.find((entry) => entry.id === id);
    if (!config) throw new Error(id);
    seedV2(config);
    renderStep(step);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/refund/i);
    expect(appCopyFraming(renderedCopy(document.body).map((text) => withoutTemplateNames(text.replace(/\bGrow the pool\b/g, 'Add to the pool'))))).toEqual([]);
    expect(forbiddenLabelNames(document.body, RECIPE_CHOICES)).toEqual([]);
    expect(document.querySelectorAll('input[type="number"], input[type="range"]')).toHaveLength(0);
    expect(proseWords()).toBeLessThanOrEqual(PROSE_BUDGET);
  });
});
