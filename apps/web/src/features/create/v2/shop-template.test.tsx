/** SH-V21-FE13 item 2: the generic Shop template fills the Contents step's shop and holders on both sides (F128). */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests, updateDraft } from '../draft';
import { DEMO_LISTINGS } from './listings';
import { resetV2ForTests } from './v2-draft';

function renderFlow(path: string) {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}
const field = (name: string | RegExp) => screen.getByRole('textbox', { name });
const radio = (name: string | RegExp) => screen.getByRole('radio', { name });

beforeEach(() => { resetDraftForTests(); resetV2ForTests(); });
afterEach(cleanup);

describe('SH-V21-FE13 the Shop template', () => {
  it('the Shop template: the Shop tile with its defaults and holders on both sides; the price coin, name and ticker stay', async () => {
    renderFlow('/create/v2-basics');
    const name = (field('Name') as HTMLInputElement).value;
    await act(async () => fireEvent.click(within(screen.getByRole('region', { name: 'Start from a template' })).getByRole('button', { name: /^Shop/ })));
    expect(field('Name')).toHaveProperty('value', name);
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'Corner', ticker: 'CORN' } }));
    cleanup(); renderFlow('/create/v2-contents');
    expect(radio(/^Shop/)).toHaveProperty('checked', true);
    expect(field('Seed · CORN')).toHaveProperty('value', '');
    cleanup(); renderFlow('/create/v2-fees');
    for (const side of ['Buyers', 'Sellers']) expect(within(screen.getByRole('group', { name: new RegExp(`^${side}’ fees`) })).getByRole('button', { name: 'To holders' }).getAttribute('aria-pressed')).toBe('true');
    // A shop has no collection of its own: To items and To the pile are not offered.
    expect(within(screen.getByRole('group', { name: /^Buyers’ fees/ })).queryByRole('button', { name: 'To items' })).toBeNull();
    expect(within(screen.getByRole('group', { name: /^Buyers’ fees/ })).queryByRole('button', { name: 'To the pile' })).toBeNull();
  });
});
