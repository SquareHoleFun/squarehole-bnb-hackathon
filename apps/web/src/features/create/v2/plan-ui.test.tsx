/**
 * SH-AI-PLAN on the page: the Contents step's hidden-art line (numbered files tell whoever named them the map; a plan
 * lets the page pick), its link to the plan guide, pictures with any names plus a plan read into a dealt collection,
 * the plan's problems by row and column, and the guide itself with the prompt to copy.
 */
import { sha256Hex } from '@squarehole/artwork';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePng } from '../../../../../../packages/artwork/src/test-support/images';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import type { ArtEnvironment } from '../art-files';
import { CreatePage } from '../CreatePage';
import { currentDraft, resetDraftForTests } from '../draft';
import { forgetItemFiles } from '../item-files';
import { PlanGuidePage } from '../PlanGuidePage';
import { HIDDEN_NUMBERED_LINE, HIDDEN_PLANNED_LINE, PLAN_EXAMPLE, PLAN_PATH, PLAN_PROMPT, PLAN_TITLE } from '../plan-guide';
import { testRandomWords } from '../test-support/test-words';
import { resetV2ForTests } from './v2-draft';

let salts = 0;
const ENV: ArtEnvironment = {
  digest: async (bytes) => sha256Hex(bytes),
  thumbnail: async () => null,
  encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }),
  salt: () => sha256Hex(new TextEncoder().encode(`salt-${(salts += 1)}`)),
  randomWords: testRandomWords('plan-ui'),
};

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

function renderAt(path: string) {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/plan" element={<PlanGuidePage />} />
            <Route path="create/:step" element={<CreatePage env={ENV} demoStepMs={0} />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </AppProviders>,
  );
}

const file = (name: string, bytes: Uint8Array | string, type = 'image/png') => new File([typeof bytes === 'string' ? bytes : bytes.slice().buffer], name, { type });
const pictures = () => [file('bisque.png', makePng({ width: 24, height: 24, decodable: true })), file('celadon.png', makePng({ width: 25, height: 24, decodable: true })), file('gold-seam.png', makePng({ width: 26, height: 24, decodable: true }))];
const plan = (text: string) => file('plan.csv', text, 'text/csv');
const where = () => screen.getByTestId('where').textContent;
const note = () => document.querySelector('[data-plan-note]');

async function choose(files: File[]) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Art Images + traits'), { target: { files } });
  });
}

beforeEach(() => {
  // A fresh draft each time: storage too, or the last test's art would load again.
  window.sessionStorage.clear();
  resetDraftForTests();
  resetV2ForTests();
  forgetItemFiles();
});
afterEach(cleanup);

describe('the plan path on Contents', () => {
  it('hidden art: one line on numbered files with the link to the guide; a plan deals the collection and says so', async () => {
    renderAt('/create/v2-contents');
    fireEvent.click(screen.getByRole('radio', { name: /^New collection/ }));
    expect(note()).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Hidden until drawn' }));
    expect(note()?.getAttribute('data-plan-note')).toBe('numbered');
    expect(note()?.textContent).toBe(`${HIDDEN_NUMBERED_LINE} Use a plan instead`);
    expect(within(note() as HTMLElement).getByRole('link', { name: 'Use a plan instead' }).getAttribute('href')).toBe(PLAN_PATH);
    // The art's (i) names the plan beside the numbered files.
    fireEvent.click(screen.getByRole('button', { name: 'About the art files' }));
    expect(screen.getByText(/any names and a plan/)).toBeTruthy();

    await choose([...pictures(), plan(PLAN_EXAMPLE)]);
    await waitFor(() => expect(screen.getByText('96 items · 2 traits')).toBeTruthy());
    expect(note()?.getAttribute('data-plan-note')).toBe('planned');
    expect(note()?.textContent).toBe(HIDDEN_PLANNED_LINE);
    const art = currentDraft().art;
    expect(art?.planned).toBe(true);
    expect(art?.items).toHaveLength(96);
    expect(new Set(art?.items.map((item) => item.imageSha256)).size).toBe(3);
    // The plan's numbers never come from it: no file is named by a number, yet ids run 1..96.
    expect(art?.items.map((item) => item.id)).toEqual(Array.from({ length: 96 }, (_, i) => i + 1));
  });

  it('a plan with a problem: the lines point at the row and column, and nothing is dealt', async () => {
    renderAt('/create/v2-contents');
    fireEvent.click(screen.getByRole('radio', { name: /^New collection/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Hidden until drawn' }));
    await choose([...pictures(), plan('file,count,id,Glaze\nbisque.png,44,1,Bisque\nceladon.png,44,2,Celadon\ngold-seam.png,8,3,Celadon')]);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Art problems' })).toBeTruthy());
    expect(within(screen.getByRole('list', { name: 'Art problems' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Leave the numbers out. The page picks them.']);
    expect(screen.getByText('Not ready · 1 problem')).toBeTruthy();
    await choose([...pictures(), plan('file,count,Glaze\nbisque.png,44,Bisque\nceladon.png,44,"Gold ✨"\ngold-seam.png,8,Celadon')]);
    await waitFor(() => expect(screen.getByText('Row 3, Glaze: "Gold ✨" has a character the box cannot store.')).toBeTruthy());
    expect(currentDraft().art?.items).toEqual([]);
    expect(note()?.getAttribute('data-plan-note')).toBe('numbered');
    // Next names the art: fix the files listed.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Next' })));
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((link) => link.textContent)).toContain('Fix the art files listed');
  });

  it('the link opens the guide: the format, its rules, the prompt to copy; Back returns to Contents', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt('/create/v2-contents');
    fireEvent.click(screen.getByRole('radio', { name: /^New collection/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Hidden until drawn' }));
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Use a plan instead' })));
    expect(where()).toBe('/create/plan');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(PLAN_TITLE);
    expect(document.querySelector('[data-plan-example]')?.textContent).toBe(PLAN_EXAMPLE);
    expect(document.querySelector('[data-plan-prompt]')?.textContent).toBe(PLAN_PROMPT);
    expect(PLAN_PROMPT).toContain('Never choose item numbers, ids, salts or seeds.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy the prompt' })));
    expect(writeText).toHaveBeenCalledWith(PLAN_PROMPT);
    await waitFor(() => expect(screen.getByText('Copied.')).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Back to Contents' })));
    expect(where()).toBe('/create/v2-contents');
  });
});
