/**
 * SH-EX-O1 (L1's integrator request 1) on the page: Load settings takes a hidden kit's public template together with
 * its plan file (both picked at once), refuses the template alone and a plan.csv that is not its own, then takes the
 * plan's twelve pictures and plan.csv; the setup loads with its 420 items hidden, and the reveal file is saved before
 * Create, as for every loaded hidden setup.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import type { ArtEnvironment } from '../art-files';
import { currentDraft, resetDraftForTests } from '../draft';
import { forgetItemFiles } from '../item-files';
import { testRandomWords } from '../test-support/test-words';
import { DEMO_LISTINGS, NATIVE_TOKEN } from './listings';
import { LOAD_WORDS } from './load-settings';
import { LOADED_LINE, LoadSettings } from './LoadSettings';
import { currentV2Loaded, resetV2ForTests } from './v2-draft';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const KIT = 'examples/boxes/frog-kiln';
const two = (i: number) => String(i + 1).padStart(2, '0');
const fileAt = (path: string, name: string, type: string) => new File([new Uint8Array(readFileSync(join(ROOT, path))).slice().buffer], name, { type });
const SETTINGS = () => fileAt(`${KIT}/settings/frog-kiln-boxspec-v2.json`, 'frog-kiln-boxspec-v2.json', 'application/json');
const PLAN_FILE = () => fileAt(`${KIT}/settings/frog-kiln-plan.json`, 'frog-kiln-plan.json', 'application/json');
const PICTURES = () => Array.from({ length: 12 }, (_, i) => fileAt(`${KIT}/art/items/variant-${two(i)}.png`, `variant-${two(i)}.png`, 'image/png'));
const PLAN_CSV = () => fileAt(`${KIT}/plan.csv`, 'plan.csv', 'text/csv');
const env: ArtEnvironment = { digest: async (bytes) => sha256Hex(bytes), thumbnail: async () => null, encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }), salt: () => sha256Hex(crypto.getRandomValues(new Uint8Array(32))), randomWords: testRandomWords('hidden-plan-ui') };

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}
function renderFlow() {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-basics']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} env={env} />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </AppProviders>,
  );
}
const choose = async (input: HTMLElement, files: File[]) => act(async () => { fireEvent.change(input, { target: { files } }); });
const next = async () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const problem = async () => (await screen.findByRole('alert')).textContent ?? '';
/** The file names the line keeps whole (SH-APP8: a span that does not wrap, create-v2.css `.sh-v2-load__name`). */
const fileNames = () => Array.from(screen.getByRole('alert').querySelectorAll('.sh-v2-load__name')).map((name) => name.textContent);

beforeEach(() => { resetDraftForTests(); resetV2ForTests(); forgetItemFiles(); });
afterEach(cleanup);

describe('Load settings: a hidden kit’s public template with its plan file', () => {
  it('asks for the plan file, takes only its own plan, loads the dealt items and asks for the reveal file before Create', async () => {
    renderFlow();
    expect(field('create-load-settings').multiple).toBe(true);
    // The template alone: its plan file goes with it.
    await choose(field('create-load-settings'), [SETTINGS()]);
    expect(await problem()).toBe(`! ${LOAD_WORDS.templateNeedsPlan}`);
    // SH-APP8: the plan file's name sits whole in a span that does not wrap; the words stay LOAD_WORDS' plain text.
    expect(fileNames()).toEqual(['-plan.json']);
    expect(currentV2Loaded()).toBeNull();
    // Both at once, in either order.
    await choose(field('create-load-settings'), [PLAN_FILE(), SETTINGS()]);
    await screen.findByText('Item pictures · 420');
    // Another plan.csv (one trait value changed) is refused before anything is read.
    const edited = new File([readFileSync(join(ROOT, `${KIT}/plan.csv`), 'utf8').replace('Bisque', 'Biscuit')], 'plan.csv', { type: 'text/csv' });
    await choose(field('create-load-items'), [...PICTURES(), edited]);
    expect(await problem()).toContain(LOAD_WORDS.planNotTemplate);
    expect(currentV2Loaded()).toBeNull();
    // The plan's twelve pictures and its own plan.csv: dealt here, 420 hidden items, the file's name kept.
    await choose(field('create-load-items'), [...PICTURES(), PLAN_CSV()]);
    await screen.findByText(LOADED_LINE);
    expect(currentV2Loaded()).toMatchObject({ items: 420, hidden: true });
    expect(currentDraft().art?.planned).toBe(true);
    expect(currentDraft().art?.items).toHaveLength(420);
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Frog Kiln');
    await next(); await next(); await next(); await next();
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' })); });
    await next();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/create/v2-overview'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fireEvent.click(within(dialog).getAllByRole('radio')[0] as HTMLElement));
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: /sample wallet$/ })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The new box's own salts and root: its reveal file is saved before Create.
    expect(screen.getByRole('button', { name: 'Save reveal file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  }, shLimit(60_000));

  it('a plan file that belongs to another kit’s template is refused', async () => {
    renderFlow();
    const other = fileAt('examples/boxes/paper-certificates/settings/paper-certificates-plan.json', 'paper-certificates-plan.json', 'application/json');
    await choose(field('create-load-settings'), [SETTINGS(), other]);
    expect(await problem()).toContain(LOAD_WORDS.planFileNotSetup);
    expect(currentV2Loaded()).toBeNull();
  });

  it('a plan file that names another plan under the template’s marker is refused (XR-SH-EX-O1 F1)', async () => {
    // The committed plan file with only its plan's hash changed, to a plan with one item moved between two pictures.
    const [head = '', first = '', second = '', ...rest] = readFileSync(join(ROOT, `${KIT}/plan.csv`), 'utf8').trimEnd().split('\n');
    const shift = (row: string, by: number) => row.replace(/^([^,]+),([0-9]+),/, (_, file: string, count: string) => `${file},${Number(count) + by},`);
    const moved = new TextEncoder().encode(`${[head, shift(first, -1), shift(second, 1), ...rest].join('\n')}\n`);
    const body = JSON.parse(readFileSync(join(ROOT, `${KIT}/settings/frog-kiln-plan.json`), 'utf8')) as Record<string, unknown> & { plan: Record<string, unknown> };
    const renamed = new File([JSON.stringify({ ...body, plan: { ...body.plan, sha256: sha256Hex(moved) } })], 'frog-kiln-plan.json', { type: 'application/json' });
    renderFlow();
    await choose(field('create-load-settings'), [SETTINGS(), renamed]);
    expect(await problem()).toContain(LOAD_WORDS.planFileNotSetup);
    expect(screen.queryByText('Item pictures · 420')).toBeNull();
    expect(currentV2Loaded()).toBeNull();
  });
});

describe('Load settings: a pick of the wrong files says what to pick (SH-APP7-HIDE-LOAD)', () => {
  const OTHER_SETTINGS = () => fileAt('examples/boxes/gpu-poor/settings/gpu-poor-boxspec-v2.json', 'gpu-poor-boxspec-v2.json', 'application/json');
  const OTHER_PLAN = () => fileAt('examples/boxes/paper-certificates/settings/paper-certificates-plan.json', 'paper-certificates-plan.json', 'application/json');
  const NOT_SETTINGS = () => new File(['{"format":"other"}'], 'x.json', { type: 'application/json' });
  // Two more files that are no settings file: another JSON file of this repo, and a text that is no JSON.
  const LISTINGS_FILE = () => fileAt('packages/box-spec/listings.demo.json', 'listings.demo.json', 'application/json');
  const NOTES = () => new File(['not json'], 'notes.json', { type: 'application/json' });
  const mount = () => {
    const onLoaded = vi.fn();
    render(<LoadSettings env={env} listings={DEMO_LISTINGS} pricing={NATIVE_TOKEN} demo checkCollections={null} onLoaded={onLoaded} optionsCheck={null} />);
    return onLoaded;
  };
  /** The page's line once this pick is read (the picker is free again). */
  const lineAfter = async (files: File[]) => {
    await choose(field('create-load-settings'), files);
    await waitFor(() => expect(field('create-load-settings').disabled).toBe(false));
    return (await screen.findByRole('alert')).textContent ?? '';
  };

  it.each([
    ['two settings files', () => [SETTINGS(), OTHER_SETTINGS()]],
    ['two settings files and the plan file', () => [SETTINGS(), OTHER_SETTINGS(), PLAN_FILE()]],
    ['two plan files', () => [SETTINGS(), PLAN_FILE(), OTHER_PLAN()]],
    ['a plan file alone', () => [PLAN_FILE()]],
    ['two plan files alone', () => [PLAN_FILE(), OTHER_PLAN()]],
  ])('%s: one line says what to pick; nothing loads', async (_name, files) => {
    const onLoaded = mount();
    const line = await lineAfter(files());
    expect(line).toBe(`! ${LOAD_WORDS.pickOne}`);
    expect(fileNames()).toEqual(['-plan.json']);
    expect(line).not.toContain('Not a settings file');
    expect(screen.queryByText('Item pictures · 420')).toBeNull();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it.each([
    ['two files that are no settings file', () => [LISTINGS_FILE(), NOTES()]],
    ['a settings file and a file that is no settings file', () => [SETTINGS(), LISTINGS_FILE()]],
    ['a file that is no settings file, then a settings file', () => [NOT_SETTINGS(), SETTINGS()]],
    ['a plan file and a file that is no settings file', () => [PLAN_FILE(), NOT_SETTINGS()]],
  ])('%s: "Not a settings file" stays; nothing loads', async (_name, files) => {
    const onLoaded = mount();
    const line = await lineAfter(files());
    expect(line).toBe(`! ${LOAD_WORDS.notJson}`);
    expect(fileNames()).toEqual([]);
    expect(line).not.toContain('Pick one');
    expect(screen.queryByText('Item pictures · 420')).toBeNull();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('a file that is no settings file keeps its own line; after a wrong pick the right one goes on, the line gone', async () => {
    const onLoaded = mount();
    expect(await lineAfter([NOT_SETTINGS()])).toBe(`! ${LOAD_WORDS.notJson}`);
    expect(await lineAfter([PLAN_FILE()])).toBe(`! ${LOAD_WORDS.pickOne}`);
    await choose(field('create-load-settings'), [PLAN_FILE(), SETTINGS()]);
    await screen.findByText('Item pictures · 420');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
