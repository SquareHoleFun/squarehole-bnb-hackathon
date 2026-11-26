/**
 * SH-AI-PLAN fix round 2 (review re-check): "reveal file saved" is bound to the commitment it was saved for (its format
 * and reveal root), never a bare yes. A draft saved before the sorted table (a legacy `revealSaved: true`, or an
 * acknowledgement for another root) restores as not saved, so Create asks for a new reveal file; any root change after
 * saving (new salts, another order) does the same.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { COMMITMENT_FORMAT, commitArt, revealAckFor, revealSavedFor, type ArtState } from '../create-model';
import { EMPTY_DRAFT, currentDraft, flushDraft, parseStoredDraft, resetDraftForTests, updateDraft } from '../draft';
import { forgetItemFiles } from '../item-files';
import { NOW, OWNER, artOf, formOf } from '../test-support/fixtures';
import { useCreateModel } from '../use-create-flow';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { seedV2 } from './test-support/v2-fixtures';
import { resetV2ForTests } from './v2-draft';

const KEY = 'sh.create.draft.v2';
const ART_KEY = 'sh.create.art.v2';
const HIDDEN = CONFIGURATIONS.find((config) => config.hidden === true);
const stored = (key: string) => JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as Record<string, unknown>;
const store = (key: string, value: unknown) => window.sessionStorage.setItem(key, JSON.stringify(value));

function renderOverview() {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-overview']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

async function connect() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
  const dialog = await screen.findByRole('dialog');
  await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** The Demo's primary action on the Overview once connected: "Save reveal file" while one is due, else "Create". */
const primary = () => (screen.queryByRole('button', { name: 'Save reveal file' }) ? 'Save reveal file' : screen.queryByRole('button', { name: /^Create$/ }) ? 'Create' : 'none');

/**
 * Reload the tab: a pending save written first (as the page does when it is hidden), the in-memory draft forgotten and
 * read back from storage, the page rendered and the wallet connected again.
 */
async function reload() {
  flushDraft();
  cleanup();
  resetDraftForTests();
  renderOverview();
  await connect();
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetDraftForTests();
  resetV2ForTests();
  forgetItemFiles();
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = vi.fn(() => 'blob:reveal'); static override revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the reveal file acknowledgement is bound to its commitment', () => {
  const art: ArtState = artOf(12);
  const sorted = commitArt(art, 'hidden');
  const oldOrder = commitArt(art, 'open');
  if (!sorted || !oldOrder) throw new Error('fixture');

  it('holds only for the same format and the same root', () => {
    expect(COMMITMENT_FORMAT).toBe(2);
    const ack = revealAckFor(sorted);
    expect(ack).toEqual({ format: 2, root: sorted.revealRoot });
    expect(revealSavedFor(ack, sorted)).toBe(true);
    expect(revealSavedFor({ ...ack, root: ack.root.toUpperCase().replace('0X', '0x') as `0x${string}` }, sorted)).toBe(true);
    // The old first-appearance order gives another root for the same art: a file saved for it is not this box's.
    expect(oldOrder.revealRoot).not.toBe(sorted.revealRoot);
    expect(revealSavedFor(revealAckFor(oldOrder), sorted)).toBe(false);
    expect(revealSavedFor({ format: 1, root: sorted.revealRoot }, sorted)).toBe(false);
    const resalted = commitArt({ ...art, salts: art.salts.map((salt, i) => (i === 0 ? (`0x${'7'.repeat(64)}` as const) : salt)) }, 'hidden');
    expect(revealSavedFor(ack, resalted)).toBe(false);
    expect(revealSavedFor(null, sorted)).toBe(false);
    expect(revealSavedFor(ack, null)).toBe(false);
  });

  it('a stored draft: a legacy yes or a malformed acknowledgement restores as not saved; a bound one is kept', () => {
    const choices = (patch: Record<string, unknown>) => JSON.stringify({ form: { ...formOf({ artMode: 'hidden' }), capPerEpoch: '0' }, cover: null, ...patch });
    const artText = JSON.stringify(art);
    expect(parseStoredDraft(choices({ revealSaved: true }), { art: artText })?.revealSavedFor).toBeNull();
    expect(parseStoredDraft(choices({ revealSavedFor: revealAckFor(sorted) }), { art: artText })?.revealSavedFor).toEqual(revealAckFor(sorted));
    for (const bad of [true, { root: sorted.revealRoot }, { format: 2, root: '0x12' }, { format: '2', root: sorted.revealRoot }, { format: 2.5, root: sorted.revealRoot }]) {
      expect(parseStoredDraft(choices({ revealSavedFor: bad }), { art: artText })?.revealSavedFor, JSON.stringify(bad)).toBeNull();
    }
    // No art, no acknowledgement.
    expect(parseStoredDraft(choices({ revealSavedFor: revealAckFor(sorted) }))?.revealSavedFor).toBeNull();
    // A new art voids it in memory too.
    updateDraft((draft) => ({ ...draft, art, revealSavedFor: revealAckFor(sorted) }));
    updateDraft((draft) => ({ ...draft, art: artOf(13) }));
    expect(currentDraft().revealSavedFor).toBeNull();
  });

  it('v1’s page model counts the file saved only for its own commitment', () => {
    const model = (revealSavedFor: ReturnType<typeof revealAckFor> | null) => renderHook(() => useCreateModel({ draft: { ...currentDraft(), form: formOf({ artMode: 'hidden' }), art, revealSavedFor }, step: 'overview', nowMs: NOW, demo: true, connected: OWNER, chainId: 31337, dataLabel: 'Local chain 31337', created: [], network: 'demo' })).result.current;
    expect(model(revealAckFor(sorted)).input.revealSaved).toBe(true);
    expect(model(revealAckFor(oldOrder)).input.revealSaved).toBe(false);
    expect(model(null).input.revealSaved).toBe(false);
  });
});

describe('Create asks for a new reveal file whenever the root is not the one saved', () => {
  it('a hidden draft saved before the sorted table (a bare yes) restores asking for the file again; saving it allows Create', async () => {
    if (!HIDDEN) throw new Error('no hidden configuration');
    seedV2(HIDDEN);
    // As an earlier page stored it: the reveal file saved, as a bare yes, for its first-appearance root.
    const choices = stored(KEY);
    delete choices.revealSavedFor;
    store(KEY, { ...choices, revealSaved: true });
    await reload();
    expect(primary()).toBe('Save reveal file');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save reveal file' })));
    expect(primary()).toBe('Create');
    flushDraft();
    expect(stored(KEY).revealSavedFor).toEqual(revealAckFor(commitArt(currentDraft().art, 'hidden') ?? (() => { throw new Error('art'); })()));
    // Saved and reloaded unchanged: still this root's file, Create stays.
    await reload();
    expect(primary()).toBe('Create');
  });

  it('a root change after saving (the old order) asks for a new file before Create; other salts in storage start clean', async () => {
    if (!HIDDEN) throw new Error('no hidden configuration');
    seedV2(HIDDEN);
    renderOverview();
    await connect();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save reveal file' })));
    expect(primary()).toBe('Create');
    // An acknowledgement for the old first-appearance root of this very art is not this box's.
    flushDraft();
    const art = currentDraft().art;
    const old = commitArt(art, 'open');
    if (!old) throw new Error('art');
    store(KEY, { ...stored(KEY), revealSavedFor: revealAckFor(old) });
    await reload();
    expect(primary()).toBe('Save reveal file');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save reveal file' })));
    expect(primary()).toBe('Create');
    // SH-256 (E3): the same art with one salt changed in the tab's storage is not the art the draft printed: before,
    // it came back with the acknowledgement and Create asked for a new file; now the draft starts clean.
    flushDraft();
    const saved = stored(ART_KEY) as unknown as ArtState;
    store(ART_KEY, { ...saved, salts: saved.salts.map((salt, i) => (i === 0 ? `0x${'5'.repeat(64)}` : salt)) });
    await reload();
    expect(currentDraft()).toBe(EMPTY_DRAFT);
  });
});
