/**
 * SH-192 (BOXSPEC-AUTOSAVE, founder 2026-11-02): a box that commits a reveal root cannot be created without its reveal
 * data saved first. On a real build Create's press saves the box file (box-file-save.ts) and sends nothing until that
 * save succeeded: Create is disabled while it saves ("Saving your box file…"), the line names the saved file, and a
 * failed save keeps Create disabled with its line until "Save box file" saved it. Then the run, once it knows its
 * predicted token, keeps the reveal data in this browser's IndexedDB before it reads or sends anything (the page's
 * `keep`), and stops with a line, nothing sent, when it cannot. A token box (no reveal root) creates as before.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import * as dataSource from '../../data-source';
import * as wallet from '../../wallet';
import { createDemoWalletAdapter } from '../../wallet';
import type { V2Source } from '../../core/v2/indexer-v2';
import { CreatePage } from '../CreatePage';
import { commitArt } from '../create-model';
import { clearDraft, resetDraftForTests, updateDraft } from '../draft';
import { OWNER } from '../test-support/fixtures';
import * as fileSave from './box-file-save';
import { BOX_FILE_FIRST, BOX_FILE_SAVING, KEEP_FAILED, KEEP_NOT_HERE, boxFileSaved } from './CreateV2Flow';
import { specOfRun, CreateRefusal, type CreateRunV2 } from './create-send';
import { clearRunV2 } from './create-send-store';
import { DEMO_LISTINGS } from './listings';
import { buildSpecV2 } from './model';
import { readKept } from './reveal-keep';
import { encodeBoxSpecV2 } from './spec-types';
import { CHAIN, kinds, setup } from './test-support/create-send-fake';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of, seedV2 } from './test-support/v2-fixtures';
import { readRevealFile } from '../../core/v2/reveal-file';
import type { CreateSendInput, CreateSendView } from './useCreateSend';
import * as send from './useCreateSend';
import { resetV2ForTests } from './v2-draft';

/** SH-218 rail 2: no Create option switched off (the switches' own cases: create-options-send.test.ts). */
const NO_SWITCHES = async (): Promise<void> => undefined;

const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};
const TOKEN = '0x00000000000000000000000000000000000b0c51' as Address;

describe('SH-192 the page: Create saves the box file before anything is sent', () => {
  const useSource = dataSource.useDataSource;
  const useCurrentWallet = wallet.useWallet;
  let view: CreateSendView = { phase: 'idle' };
  let resumes = false;
  let given: CreateSendInput | null = null;
  const start = vi.fn(async () => undefined);
  beforeEach(() => {
    resetDraftForTests();
    resetV2ForTests();
    view = { phase: 'idle' };
    resumes = false;
    given = null;
    start.mockReset();
    start.mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => true) } });
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useChainSource() { return { ...useSource(), isDemo: false }; });
    vi.spyOn(wallet, 'useWallet').mockImplementation(function useBrowserWallet() {
      const current = useCurrentWallet();
      return { ...current, status: 'connected', kind: 'injected', account: wallet.DEMO_WALLET_A, chainId: 11155111, signer: { request: vi.fn(), walletName: 'Test' } };
    });
    vi.spyOn(send, 'useCreateSend').mockImplementation((input) => {
      given = input;
      return { available: true, view, run: null, runSpec: null, otherBox: null, resumes, created: false, start, stop: vi.fn(), forget: vi.fn() };
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const page = () => (
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-overview']}>
        <Routes><Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route></Routes>
      </MemoryRouter>
    </AppProviders>
  );
  const create = () => screen.getByRole('button', { name: 'Create', exact: true } as never) as HTMLButtonElement;
  const line = () => document.querySelector('[data-box-file]');

  it('open art: the press saves the box file first (Create disabled, "Saving your box file…"), then "Saved: …" and the run starts', async () => {
    seedV2(config('gas-guzzlers'));
    let finish!: (saved: fileSave.SavedBoxFile) => void;
    const save = vi.spyOn(fileSave, 'saveBoxFile').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(page());
    expect(line()?.textContent).toBe(BOX_FILE_FIRST);
    await act(async () => fireEvent.click(create()));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toBe('guzz-boxspec-v2.json');
    expect(create().disabled).toBe(true);
    expect(line()?.textContent).toBe(BOX_FILE_SAVING);
    // A second press while saving saves nothing more and sends nothing.
    await act(async () => fireEvent.click(create()));
    expect(save).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    await act(async () => finish({ name: 'rent-free-boxspec.json', via: 'picker' }));
    expect(line()?.textContent).toBe(boxFileSaved('rent-free-boxspec.json'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // The page hands its keep to the run (the IndexedDB copy, before the run reads or sends anything).
    expect(typeof given?.keep).toBe('function');
  });

  it.each(['unmount', 'replace draft', 'replace identical draft'] as const)('a deferred save cannot start creation after %s', async (leave) => {
    seedV2(config('gas-guzzlers'));
    let finish!: (saved: fileSave.SavedBoxFile) => void;
    vi.spyOn(fileSave, 'saveBoxFile').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const mounted = render(page());
    await act(async () => fireEvent.click(create()));
    if (leave === 'unmount') mounted.unmount();
    else if (leave === 'replace identical draft') act(() => { clearDraft(); seedV2(config('gas-guzzlers')); });
    else act(() => updateDraft((d) => ({ ...d, form: { ...d.form, name: 'Replacement' } })));
    await act(async () => finish({ name: 'old.json', via: 'picker' }));
    expect(start).not.toHaveBeenCalled();
  });

  it('a failed save keeps Create disabled with its line; "Save box file" saves again; then Create starts, with no second save', async () => {
    seedV2(config('gas-guzzlers'));
    const save = vi.spyOn(fileSave, 'saveBoxFile').mockRejectedValueOnce(new fileSave.BoxFileError(fileSave.SAVE_CLOSED));
    render(page());
    await act(async () => fireEvent.click(create()));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(fileSave.SAVE_CLOSED);
    expect(create().disabled).toBe(true);
    // Create stays disabled: pressing it saves nothing and sends nothing.
    await act(async () => fireEvent.click(create()));
    expect(save).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    save.mockResolvedValueOnce({ name: 'guzz-boxspec-v2.json', via: 'download' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save box file' })));
    expect(save).toHaveBeenCalledTimes(2);
    expect(line()?.textContent).toBe('Download requested: guzz-boxspec-v2.json');
    expect(start).not.toHaveBeenCalled();
    expect(create().disabled).toBe(false);
    await act(async () => fireEvent.click(create()));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('a picture the file cannot carry is a failed save: its own line, nothing sent', async () => {
    seedV2(config('gas-guzzlers'));
    vi.spyOn(fileSave, 'saveBoxFile').mockImplementation(async (_name, build) => { await build(); return { name: 'x', via: 'download' }; });
    // After a reload the page keeps only the item pictures' hashes, never their files.
    const { forgetItemFiles } = await import('../item-files');
    forgetItemFiles();
    render(page());
    await act(async () => fireEvent.click(create()));
    expect((await screen.findByRole('alert')).textContent).toContain('Add the item pictures again');
    expect(start).not.toHaveBeenCalled();
    expect(create().disabled).toBe(true);
  });

  it('a token box commits no reveal root: Create starts the run as before, no file saved by the press', async () => {
    seedV2(config('rug-rugs'));
    const save = vi.spyOn(fileSave, 'saveBoxFile');
    render(page());
    expect(line()).toBeNull();
    await act(async () => fireEvent.click(create()));
    expect(start).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('a press that resumes the saved run (Continue) saves no new file: it was saved before the run was prepared', async () => {
    seedV2(config('gas-guzzlers'));
    resumes = true;
    view = { phase: 'failed', progress: null, message: KEEP_FAILED };
    const save = vi.spyOn(fileSave, 'saveBoxFile');
    render(page());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(start).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(KEEP_FAILED);
  });

  // The page's keep, as the hook calls it once the run is known (prepared, or the saved one resumed).
  describe('the reveal data kept in this browser', () => {
    const runOf = (encoded: Hex): CreateRunV2 => ({ chainId: 11155111, creator: wallet.DEMO_WALLET_A, factory: CHAIN.factory, encoded, cs: `0x${'0'.repeat(64)}`, hs: `0x${'1'.repeat(64)}`,
      coordinator: CHAIN.factory, token: TOKEN, bootstrapQ: '10', sent: {} });
    const specOf = (id: string, salt = 0) => {
      const input = inputV2Of(config(id));
      const art = input.art && salt > 0 ? { ...input.art, salts: input.art.salts.map((_, i) => `0x${(i + salt).toString(16).padStart(64, '0')}` as const) } : input.art;
      return encodeBoxSpecV2(buildSpecV2({ ...input, art, commitment: commitArt(art, input.form.artMode), owner: wallet.DEMO_WALLET_A }));
    };
    const keepOf = () => {
      if (!given?.keep) throw new Error('no keep');
      const keep = given.keep;
      return (run: CreateRunV2, created: () => Promise<boolean>) => keep(run, created, crypto.randomUUID());
    };

    it('writes the run’s reveal data under its predicted token and reads it back; a second press finds it kept', async () => {
      const idb = new IDBFactory();
      vi.stubGlobal('indexedDB', idb);
      seedV2(config('gas-guzzlers'));
      render(page());
      const created = vi.fn(async () => false);
      await keepOf()(runOf(specOf('gas-guzzlers')), created);
      const kept = await readKept(11155111, TOKEN, idb);
      expect(kept).toMatchObject({ chainId: 11155111, token: TOKEN.toLowerCase(), creator: wallet.DEMO_WALLET_A, artMode: 'open', fileName: 'guzz-reveal-data-v2.json' });
      expect((JSON.parse(kept?.text ?? '{}') as { revealList: { items: unknown[] } }).revealList.items).toHaveLength(12);
      await keepOf()(runOf(specOf('gas-guzzlers')), created);
      expect(created).not.toHaveBeenCalled();
    });

    it.each(['gas-guzzlers', 'ultrasound-owls'])('a silent download with refused persistence blocks %s and offers saving again', async (id) => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => false) } });
      vi.spyOn(fileSave, 'saveBoxFile').mockResolvedValue({ name: 'box.json', via: 'download' });
      seedV2(config(id));
      const walletRequest = vi.fn();
      start.mockImplementation(async () => {
        try { await keepOf()(runOf(specOf(id)), async () => false); walletRequest(); }
        catch (error) { expect(error).toEqual(new CreateRefusal('refused', KEEP_FAILED)); }
      });
      render(page());
      const reveal = screen.queryByRole('button', { name: 'Save reveal file' });
      if (reveal) {
        vi.spyOn(fileSave, 'download').mockReturnValue(true);
        await act(async () => fireEvent.click(reveal));
      }
      await act(async () => fireEvent.click(create()));
      await act(async () => { await start.mock.results[0]?.value; });
      expect(start).toHaveBeenCalledTimes(1);
      expect(walletRequest).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save box file' })).toBeTruthy();
    });

    it('reload rechecks persistence even when a matching copy already exists', async () => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      seedV2(config('gas-guzzlers'));
      const first = render(page());
      await act(async () => keepOf()(runOf(specOf('gas-guzzlers')), async () => false));
      first.unmount();
      vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => false) } });
      render(page());
      await act(async () => { await expect(keepOf()(runOf(specOf('gas-guzzlers')), async () => false)).rejects.toEqual(new CreateRefusal('refused', KEEP_FAILED)); });
    });

    it.each(['gas-guzzlers', 'ultrasound-owls'])('a closed file carries the salts and permits %s without IndexedDB', async (id) => {
      vi.stubGlobal('indexedDB', undefined);
      seedV2(config(id));
      let contents = '';
      vi.spyOn(fileSave, 'saveBoxFile').mockImplementation(async (_name, build) => {
        contents = await new Blob([...await build()]).text();
        return { name: 'backup.json', via: 'picker' };
      });
      render(page());
      // Hidden art's existing separate download acknowledgement is not proof of durability.
      const reveal = screen.queryByRole('button', { name: 'Save reveal file' });
      if (reveal) {
        vi.spyOn(fileSave, 'download').mockReturnValue(true);
        await act(async () => fireEvent.click(reveal));
      }
      await act(async () => fireEvent.click(create()));
      await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const body = JSON.parse(contents) as { revealList: { items: { salt: string }[] } };
      expect(body.revealList.items.map((item) => item.salt)).toEqual(inputV2Of(config(id)).art?.salts);
      const runSpec = specOfRun(runOf(specOf(id)));
      const recovery = await readRevealFile(new Blob([contents]), runSpec.revealRoot, BigInt(runSpec.n));
      expect(recovery.revealOf(1n)?.salt).toBe(body.revealList.items[0]?.salt);
      await act(async () => { await expect(keepOf()(runOf(specOf(id)), async () => false)).resolves.toBeUndefined(); });
    });

    it('art that is not the run’s: the press stops before sending, unless the run’s box already exists', async () => {
      vi.stubGlobal('indexedDB', new IDBFactory());
      seedV2(config('gas-guzzlers'));
      render(page());
      await expect(keepOf()(runOf(specOf('gas-guzzlers', 7)), async () => false)).rejects.toEqual(new CreateRefusal('refused', KEEP_NOT_HERE));
      await expect(keepOf()(runOf(specOf('gas-guzzlers', 7)), async () => true)).resolves.toBeUndefined();
    });

    it('no IndexedDB here: the press stops with its line, nothing sent; a token box keeps nothing and goes on', async () => {
      vi.stubGlobal('indexedDB', undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      seedV2(config('gas-guzzlers'));
      render(page());
      await expect(keepOf()(runOf(specOf('gas-guzzlers')), async () => false)).rejects.toEqual(new CreateRefusal('refused', KEEP_FAILED));
      await expect(keepOf()(runOf(specOf('gas-guzzlers')), async () => { throw new Error('offline'); })).rejects.toEqual(new CreateRefusal('refused', KEEP_FAILED));
      await expect(keepOf()(runOf(specOf('gas-guzzlers')), async () => true)).resolves.toBeUndefined();
      await expect(keepOf()(runOf(specOf('rug-rugs')), async () => false)).resolves.toBeUndefined();
    });
  });
});

describe('SH-192 the run: keep comes before every read and wallet request of the run', () => {
  const SOURCE = {
    network: 'local', origin: 'http://127.0.0.1:1', rpc: 'http://127.0.0.1:1',
    manifest: { chainId: CHAIN.chainId, releases: [{ factory: { address: CHAIN.factory }, listingRegistry: { address: CHAIN.listingRegistry }, implementations: { coordinator: { address: CHAIN.coordinatorImplementation } } }] },
  } as unknown as V2Source;
  beforeEach(() => clearRunV2());
  afterEach(() => { cleanup(); clearRunV2(); });

  it('a keep that refuses: the run stops with its line and the wallet is asked nothing; the next press keeps, then sends', async () => {
    const { spec, fake } = setup('gas-guzzlers');
    let refuse = true;
    const keep = vi.fn(async (run: CreateRunV2) => {
      // The run is known (its predicted token) and nothing of it was sent yet.
      expect(run.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(fake.wallet).not.toHaveBeenCalled();
      if (refuse) throw new CreateRefusal('refused', KEEP_FAILED);
    });
    const hook = renderHook(() => send.useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads, keep }));
    await act(async () => { await hook.result.current.start(); });
    expect(hook.result.current.view).toMatchObject({ phase: 'failed', message: KEEP_FAILED });
    expect(fake.wallet).not.toHaveBeenCalled();
    expect(kinds(fake)).toEqual([]);
    refuse = false;
    await act(async () => { await hook.result.current.start(); });
    expect(keep).toHaveBeenCalledTimes(2);
    expect(hook.result.current.view.phase).toBe('done');
    expect(kinds(fake)).toContain('createBox');
  });
});
