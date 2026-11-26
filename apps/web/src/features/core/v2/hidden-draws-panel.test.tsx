/**
 * TA-50: the hidden-art draws panel through the real component, model and sender. Only the chain reads (`read`), the
 * RPC edge (`ioFor`), the wallet and the art gateway are doubles. Placeholders show until the chain says an item is
 * revealed; only then is its picture asked for, by the chain's hash, and shown once its bytes hash to it.
 */
import { pictureFixture } from '../../../../../../packages/artwork/src/picture-fixtures';
import { rawCidV1, sha256Hex } from '@squarehole/artwork';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import type { BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2';
import { resetPicturesForTests } from '../../boxes/box-pictures';
import { resetWithheldForTests } from '../../pictures/withheld';
import { buildSpec, revealFile } from '../../create/create-model';
import { formOf, inputOf } from '../../create/test-support/fixtures';
import { DRAW, PHASE } from '../box0/box0-model';
import { HiddenDrawsV2, REVEAL_FILE_LINE } from './HiddenDrawsV2';
import type { HiddenDraw, HiddenIO, HiddenReads } from './hidden-draws';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';
import type { HiddenOpeningHandle } from './reveal-hidden';
import { HIDDEN_OPEN_WORDS as O, REASON_WORDS, REVEAL_WORDS as W, ethUp } from './reveal-words';
import { doubleFactory } from './test-support/reveal-session-double';

const a = (n: bigint) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) as Address;
const me = a(100n);
const creator = a(50n);
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 11155111, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } as { request: ReturnType<typeof vi.fn>; walletName?: string; confirmsInPage?: true } | null,
  onAccountsChanged: () => () => undefined, onChainChanged: () => () => undefined }));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetPicturesForTests(); resetWithheldForTests(); });

// Synthetic wiring, never a recorded/deployed address fixture.
const record: BoxRecordV2 = {
  boxId: 1n, templateId: zeroHash, specHash: zeroHash, creator, pricingListingId: 0, q: zeroAddress,
  raise: 1n, poolManager: a(51n), poolId: zeroHash, creationBlock: 7n, openAt: 1n, randomness: a(52n),
  contracts: Array.from({ length: 24 }, (_, i) => a(BigInt(i + 1))), codeHashes: Array.from({ length: 24 }, () => zeroHash),
};
const GATEWAY = 'http://127.0.0.1:5421';
const source = { network: 'sepolia', manifest: { chainId: 11155111 }, origin: GATEWAY, rpc: 'http://127.0.0.1:1', art: [GATEWAY] } as unknown as V2Source;
const viewOf = (artMode: number) => ({ record, spec: { artMode } }) as unknown as V2Snapshot;

const input = inputOf({ form: formOf({ artMode: 'hidden' }) });
const commitment = input.commitment as NonNullable<typeof input.commitment>;
const revealText = revealFile(buildSpec(input), input.art as NonNullable<typeof input.art>, commitment).text;

const PICTURE = pictureFixture('ordinary.png');
const PICTURE_SHA = sha256Hex(PICTURE) as Hex;
const OTHER_SHA = `0x${'ab'.repeat(32)}` as Hex;

function gateway() {
  const asked: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    asked.push(String(url));
    return String(url).endsWith(rawCidV1(PICTURE_SHA)) ? new Response(PICTURE.slice(), { status: 200 }) : new Response(new Uint8Array(64), { status: 200 });
  }) as unknown as typeof fetch;
  resetPicturesForTests(fetcher);
  return asked;
}

const draw = (patch: Partial<HiddenDraw>): HiddenDraw => ({ id: 1n, drawer: me, status: DRAW.Requested, round: 5n, posted: false, itemId: 0n, imageHash: null, ...patch });
const readsOf = (draws: readonly HiddenDraw[], over: Partial<HiddenReads> = {}): HiddenReads => ({ phase: PHASE.Drawing, quote: 1_010n * 10n ** 18n, revealRoot: commitment.revealRoot, collectionSize: BigInt(commitment.n), firstId: 1n, draws, ...over });

/** `reads`: the panel's chain reads (default: `state.reads`); `io`: the send edge's overrides (fix round 1). */
function mount(state: { reads: HiddenReads }, artMode = 2, over: { reads?: () => Promise<HiddenReads>; io?: Partial<HiddenIO>; createSession?: ReturnType<typeof doubleFactory>['factory'] } = {}) {
  const submit = vi.fn(async () => `0x${'ef'.repeat(32)}` as Hex);
  const io: HiddenIO = {
    feeReader: TEST_FEE_READER, chainId: async () => 11155111,
    request: (async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0xaa36a7' : [wallet.account])) as never,
    read: async (_to, fn, args) => {
      if (fn === 'drawTicket') return state.reads.draws.find((d) => d.id === args?.[0]) ?? { status: 0 };
      if (fn === 'revealRoot') return commitment.revealRoot;
      throw new Error(fn);
    },
    drawsOf: async () => [],
    block: async () => ({ timestamp: 1_800_000_000n, baseFee: 0n }),
    simulate: async () => undefined,
    estimate: async () => 300_000n,
    receipt: async () => ({ status: 'success', logs: [] }),
    submit: submit as never,
    ...over.io,
  };
  const read = vi.fn(over.reads ?? (async () => state.reads));
  const client = createQueryClient();
  render(
    <MemoryRouter>
      <AppProviders queryClient={client}>
        <HiddenDrawsV2 view={viewOf(artMode)} source={source} ticker="OWL" disabled={false} read={read} ioFor={() => io} {...(over.createSession ? { createSession: over.createSession } : {})} />
      </AppProviders>
    </MemoryRouter>,
  );
  return { submit, read, client };
}

/** A drawing box's reads for a draw's preparation (fix round 1): the quote 1,010 OWL, ample allowance and balance. */
const drawingRead: HiddenIO['read'] = async (_to, fn) => {
  if (fn === 'phase') return PHASE.Drawing;
  if (fn === 'quoteTake') return [1_000n * 10n ** 18n, 10n * 10n ** 18n];
  if (fn === 'allowance' || fn === 'balanceOf') return 10n ** 30n;
  throw new Error(fn);
};

describe('TA-50 hidden draws panel', () => {
  it('shows nothing on an open-art box', async () => {
    wallet.status = 'disconnected'; wallet.account = null;
    const r = mount({ reads: readsOf([]) }, 1);
    await act(async () => undefined);
    expect(r.read).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Draws' })).toBeNull();
  });

  it('a visitor sees the draw’s price; the press opens the wallet window, nothing is sent', async () => {
    wallet.status = 'disconnected'; wallet.account = null; wallet.signer = null;
    const r = mount({ reads: readsOf([]) });
    const button = await screen.findByRole('button', { name: 'Draw one · 1,010 OWL' });
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(r.submit).not.toHaveBeenCalled();
  });

  it('placeholders until revealed: waiting, settling and waiting for the reveal fetch no picture; a revealed item shows its checked picture', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    const asked = gateway();
    mount({ reads: readsOf([
      draw({ id: 1n }),
      draw({ id: 2n, posted: true }),
      draw({ id: 3n, status: DRAW.Settled, itemId: 4n, round: null }),
      draw({ id: 4n, status: DRAW.Opened, itemId: 6n, round: null, imageHash: PICTURE_SHA }),
      draw({ id: 5n, status: DRAW.Opened, itemId: 7n, round: null, imageHash: OTHER_SHA }),
    ]) });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    expect(within(panel).getByText('Draw 1 · waiting for its random number')).toBeTruthy();
    expect(within(panel).getByText('Draw 2 · settling')).toBeTruthy();
    expect(within(panel).getByText('Item 4 · waiting for the reveal')).toBeTruthy();
    expect(within(panel).getByRole('img', { name: 'Draw 1 · placeholder' })).toBeTruthy();
    expect(within(panel).getByRole('img', { name: 'Item 4 · placeholder' })).toBeTruthy();
    // SH-NO-PICTURE-GATE: a placeholder is a plain tile, with no glyph, word or badge in it.
    for (const tile of within(panel).getAllByRole('img', { name: /· placeholder$/ })) expect(tile.textContent).toBe('');
    const picture = await within(panel).findByRole('img', { name: 'Item 6' });
    expect(picture.closest('[data-hash-checked]')).not.toBeNull();
    expect(within(panel).getByText('Hash checked')).toBeTruthy();
    // A picture whose bytes do not hash to the chain's record stays a placeholder.
    await waitFor(() => expect(asked.some((url) => url.endsWith(rawCidV1(OTHER_SHA)))).toBe(true));
    expect(within(panel).getByRole('img', { name: 'Item 7 · placeholder' })).toBeTruthy();
    // Only revealed hashes were ever asked for; no Open without the creator's file.
    expect(asked.map((url) => url.slice(url.lastIndexOf('/') + 1)).sort()).toEqual([rawCidV1(PICTURE_SHA), rawCidV1(OTHER_SHA)].sort());
    expect(within(panel).queryByRole('button', { name: 'Open' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Load reveal file' })).toBeNull();
  });

  it('SH-WITHHELD-SITE: a revealed item whose picture our withheld list names is the neutral tile; its picture is never asked', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    const listed = createHash('sha256').update(`sh-withheld-v1:ipfs:${rawCidV1(PICTURE_SHA)}`).digest('hex');
    resetWithheldForTests({ origin: 'https://api.example.test', fetcher: (async () => Response.json({ version: 1, hashes: [listed] })) as unknown as typeof fetch });
    const asked = gateway();
    mount({ reads: readsOf([draw({ id: 4n, status: DRAW.Opened, itemId: 6n, round: null, imageHash: PICTURE_SHA })]) });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    const tile = await within(panel).findByRole('img', { name: 'Item 6 · picture withheld' });
    expect(tile.hasAttribute('data-withheld')).toBe(true);
    expect(tile.textContent).toBe('Picture withheld');
    expect(within(panel).queryByText('Hash checked')).toBeNull();
    expect(asked).toEqual([]);
  });

  // SH-203 (SH-202 af2 H): the opening goes through the reveal session on two presses; the proof and the recipient are
  // the session's (hidden-draws.test.ts pins them on that path). Kept from the old test: the file line, the one-line
  // refusal of another box's file, the confirmation before anything is sent, and no picture fetched from the file's hashes.
  // af5 (R4-L3b): also with a wallet that signs on the press (`confirmsInPage`): the sending button says the page's own
  // busy line, not "Waiting for confirmation…".
  it.each([false, true])('the creator loads the reveal file and opens a settled draw on the session: Open prepares, the approval shows, Confirm open opens that handle (signs on the press: %s)', async (inPage) => {
    wallet.status = 'connected'; wallet.account = creator; wallet.signer = { request: vi.fn(), walletName: 'test', ...(inPage ? { confirmsInPage: true } : {}) };
    const asked = gateway();
    const opener = doubleFactory(() => ({ mode: 'hidden' }));
    const state = { reads: readsOf([draw({ id: 3n, drawer: creator, status: DRAW.Settled, itemId: 5n, round: null })]) };
    const r = mount(state, 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    expect(within(panel).getByText(REVEAL_FILE_LINE)).toBeTruthy();
    expect(within(panel).getByText('Item 5 · waiting for the reveal')).toBeTruthy();
    // af1 M1: the creator's session exists before any file (its recovery surface needs none); it has no file.
    await waitFor(() => expect(opener.made).toHaveLength(1));
    expect(opener.last().options.file).toBeUndefined();
    // Another box's file is refused in one line, and no session is made for it.
    const input = within(panel).getByLabelText('Reveal file') as HTMLInputElement;
    await act(async () => fireEvent.change(input, { target: { files: [new File([revealText.replace(commitment.revealRoot, `0x${'cd'.repeat(32)}`)], 'x.json')] } }));
    await waitFor(() => expect(within(panel).getByText('This reveal file is for another box.')).toBeTruthy());
    expect(opener.made.filter((d) => d.options.file !== undefined)).toHaveLength(0);
    const chosen = new File([revealText], 'owl-reveal-file.json');
    await act(async () => fireEvent.change(input, { target: { files: [chosen] } }));
    await waitFor(() => expect(within(panel).getByText(`Reveal file · ${commitment.n} items`)).toBeTruthy());
    // The session gets the creator, this box's network and the very file.
    const session = opener.last();
    expect(session.options).toMatchObject({ chainId: 11155111, account: creator, file: chosen });
    // First press: prepare only.
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: O.open })));
    expect(session.calls).toEqual([{ action: 'prepareOpening', args: [3n], granted: true }]);
    expect(within(panel).getByText(O.preparing)).toBeTruthy();
    expect((within(panel).getByRole('button', { name: O.confirm }) as HTMLButtonElement).disabled).toBe(true);
    const handle = Object.freeze({ ticket: 3n, itemId: 5n, spentWei: 1_000n, capWei: 2_000n, ceilingWei: 3_000n, gasLimit: 400_000n, fee: {} }) as unknown as HiddenOpeningHandle;
    session.set({ opening: handle });
    await session.resolve('prepareOpening', handle);
    // The approval: this opening's most, what earlier sends for the item could cost, and their sum.
    const group = within(panel).getByRole('group', { name: 'Confirm transaction' });
    // af1 M6: the approval names the handle's item.
    expect(within(group).getByText(O.ask(5n))).toBeTruthy();
    expect(group.textContent).toContain(`${O.cost}${ethUp(2_000n)}`);
    expect(group.textContent).toContain(`${O.spentBefore}${ethUp(1_000n)}`);
    expect(group.textContent).toContain(`${O.together}${ethUp(3_000n)}`);
    expect(session.calls.map((c) => c.action)).toEqual(['prepareOpening']);
    // Second press: exactly the shown handle.
    await act(async () => fireEvent.click(within(group).getByRole('button', { name: O.confirm })));
    expect(session.calls.at(-1)).toEqual({ action: 'open', args: [handle], granted: true });
    // The session clears its displayed handle as it sends; the panel keeps the approval, waiting (af1 L5).
    session.set({ opening: undefined, busy: true });
    expect(within(group).getByRole('button', { name: inPage ? W.busy : O.waiting })).toBeTruthy();
    expect(group.textContent).not.toContain(inPage ? O.waiting : W.busy);
    expect(within(group).getByText(O.ask(5n))).toBeTruthy();
    session.set({ busy: false });
    await session.resolve('open', { reason: 'sent', hash: `0x${'ef'.repeat(32)}`, attempt: 'x' });
    await waitFor(() => expect(within(panel).getByText(O.sent(5n))).toBeTruthy());
    // Nothing went through the retired direct opener, and the file's picture hashes were never asked for.
    expect(r.submit).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('SH-203: the opener says why an opening waits, and a wallet that is not the creator’s makes no session', async () => {
    wallet.status = 'connected'; wallet.account = creator; wallet.signer = { request: vi.fn(), walletName: 'test' };
    gateway();
    const opener = doubleFactory(() => ({ mode: 'hidden' }));
    mount({ reads: readsOf([draw({ id: 3n, drawer: creator, status: DRAW.Settled, itemId: 5n, round: null })]) }, 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await act(async () => fireEvent.change(within(panel).getByLabelText('Reveal file') as HTMLInputElement, { target: { files: [new File([revealText], 'f.json')] } }));
    await waitFor(() => expect(opener.last().options.file).toBeDefined());
    const session = opener.last();
    session.api.prepareOpening.mockImplementationOnce(() => Promise.reject(new Error('finality')));
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: O.open })));
    await waitFor(() => expect(within(panel).getByText('Not final yet when you pressed.')).toBeTruthy());
    expect(within(panel).queryByRole('button', { name: O.confirm })).toBeNull();
    cleanup();
    expect(session.api.dispose).toHaveBeenCalledTimes(1);
    wallet.account = me;
    const other = doubleFactory();
    mount({ reads: readsOf([draw({ id: 3n, drawer: creator, status: DRAW.Settled, itemId: 5n, round: null })]) }, 2, { createSession: other.factory });
    await screen.findByRole('region', { name: 'Draws' });
    expect(screen.queryByLabelText('Reveal file')).toBeNull();
    expect(other.made).toHaveLength(0);
  });
});

describe('SH-203 af1: the hidden panel on the reveal session', () => {
  const settled = () => ({ reads: readsOf([draw({ id: 3n, drawer: creator, status: DRAW.Settled, itemId: 5n, round: null })]) });
  const handleOf = (itemId: bigint) => Object.freeze({ ticket: 3n, itemId, spentWei: 0n, capWei: 2_000n, ceilingWei: 2_000n, gasLimit: 400_000n, fee: {} }) as unknown as HiddenOpeningHandle;
  const decision = (patch: object) => Object.freeze({ token: null, attempt: 'h1', account: creator, ids: ['5'], ticket: '3', persistedAt: 0, capWei: 2_000n, eligible: false, waitRemainingMs: 60_000,
    facts: ['send-may-still-land', 'second-send-may-spend-both-caps', 'confirm-no-pending-wallet-transaction'] as const, ...patch });
  /** A reveal file whose reading waits for `open()`: a slow file read, to choose another file meanwhile. */
  const slowFile = (name: string) => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const file = new File([revealText], name);
    const slice = file.slice.bind(file);
    Object.defineProperty(file, 'slice', { value: (start?: number, end?: number) => { const part = slice(start, end); return { arrayBuffer: async () => { await gate; return part.arrayBuffer(); } }; } });
    return { file, open };
  };
  const load = async (panel: HTMLElement, file: File) => act(async () => fireEvent.change(within(panel).getByLabelText('Reveal file') as HTMLInputElement, { target: { files: [file] } }));
  beforeEach(() => { wallet.status = 'connected'; wallet.account = creator; wallet.signer = { request: vi.fn(), walletName: 'test' }; gateway(); });

  it('M1: the sends it checks, both reason owners, the two release presses and the run record, also while the draws read fails', async () => {
    const opener = doubleFactory(() => ({ mode: 'hidden', pollReason: 'read-failed', actionReason: 'unknown-send', unresolved: [Object.freeze({ attempt: 'h1', ids: ['5'], ticket: '3', account: creator, createdAt: 0, capWei: '2000', status: 'unknown' as const })] }));
    mount(settled(), 2, { createSession: opener.factory, reads: async () => { throw new Error('offline'); } });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await waitFor(() => expect(within(panel).getByText('Unavailable')).toBeTruthy());
    expect(within(panel).getByText(`${W.pollOwner}: Could not read the chain. Trying again.`)).toBeTruthy();
    expect(within(panel).getByText(`${W.actionOwner}: ${REASON_WORDS['unknown-send']}`)).toBeTruthy();
    expect(within(panel).getByRole('region', { name: W.attempts }).textContent).toContain(W.attemptNoHash);
    expect(within(panel).getByRole('button', { name: W.exportRecord })).toBeTruthy();
    const session = opener.last();
    fireEvent.click(within(panel).getByRole('button', { name: W.release }));
    expect(session.calls).toEqual([{ action: 'askRelease', args: ['h1'], granted: true }]);
    const token = Object.freeze({});
    await session.resolve('askRelease', decision({ token, eligible: true, waitRemainingMs: 0 }));
    const group = within(panel).getByRole('group', { name: W.release });
    fireEvent.click(within(group).getByRole('button', { name: W.releaseConfirm }));
    expect(session.calls.at(-1)).toEqual({ action: 'confirmRelease', args: [token], granted: true });
  });

  it('M1: a saved and a live-only transaction id show as such, with no release', async () => {
    const hash = `0x${'ab'.repeat(32)}` as Hex;
    const opener = doubleFactory(() => ({ mode: 'hidden', unresolved: [
      Object.freeze({ attempt: 's', ids: ['5'], account: creator, createdAt: 0, capWei: '1', status: 'submitted' as const, hash, hashDurable: true }),
      Object.freeze({ attempt: 'l', ids: ['6'], account: creator, createdAt: 0, capWei: '1', status: 'submitted' as const, hash, hashDurable: false })] }));
    mount(settled(), 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await waitFor(() => expect(panel.querySelector('[data-attempt="s"]')?.getAttribute('data-attempt-hash')).toBe('saved'));
    expect(panel.querySelector('[data-attempt="l"]')?.getAttribute('data-attempt-hash')).toBe('live');
    expect(within(panel).getByText(W.attemptNotSaved)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: W.release })).toBeNull();
  });

  it('M6: a prepared handle for another item than the row pressed is not offered; it asks to open again', async () => {
    const opener = doubleFactory(() => ({ mode: 'hidden' }));
    mount(settled(), 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await load(panel, new File([revealText], 'f.json'));
    await waitFor(() => expect(opener.last().options.file).toBeDefined());
    const session = opener.last();
    fireEvent.click(within(panel).getByRole('button', { name: O.open }));
    const other = handleOf(6n);
    session.set({ opening: other });
    await session.resolve('prepareOpening', other);
    expect(within(panel).queryByRole('button', { name: O.confirm })).toBeNull();
    expect(within(panel).queryByText(O.ask(5n))).toBeNull();
    expect(within(panel).getByText(REASON_WORDS.changed ?? '')).toBeTruthy();
    expect(session.calls.map((c) => c.action)).toEqual(['prepareOpening']);
  });

  it('M5 and L1: another file ends the earlier session and its approval at the choice; only the latest choice publishes; late answers change nothing', async () => {
    const opener = doubleFactory(() => ({ mode: 'hidden' }));
    mount(settled(), 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    const first = new File([revealText], 'first.json');
    await load(panel, first);
    await waitFor(() => expect(opener.last().options.file).toBe(first));
    const a = opener.last();
    fireEvent.click(within(panel).getByRole('button', { name: O.open }));
    // A slow second file: at the choice itself, the first session is disposed and its pending approval is gone.
    const slow = slowFile('slow.json');
    await load(panel, slow.file);
    expect(a.api.dispose).toHaveBeenCalledTimes(1);
    expect(within(panel).queryByRole('group', { name: 'Confirm transaction' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: O.open })).toBeNull();
    expect(panel.querySelector('[data-reveal-file]')?.textContent).toBe(O.readingFile);
    // L1: the first session's late answer shows nothing in the panel.
    const handle = handleOf(5n);
    await a.resolve('prepareOpening', handle);
    expect(within(panel).queryByRole('group', { name: 'Confirm transaction' })).toBeNull();
    expect(panel.querySelector('[data-draws-message]')).toBeNull();
    // A third choice finishes first; the slow one finishing afterwards publishes nothing.
    const third = new File([revealText], 'third.json');
    await load(panel, third);
    await waitFor(() => expect(opener.last().options.file).toBe(third));
    const sessions = opener.made.length;
    slow.open();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(opener.made).toHaveLength(sessions);
    expect(opener.last().options.file).toBe(third);
    expect(opener.made.some((d) => d.options.file === slow.file)).toBe(false);
  });
});

describe('SH-203 af2: the hidden panel', () => {
  beforeEach(() => { wallet.status = 'connected'; wallet.account = creator; wallet.signer = { request: vi.fn(), walletName: 'test' }; gateway(); });
  const settled = () => ({ reads: readsOf([draw({ id: 3n, drawer: creator, status: DRAW.Settled, itemId: 5n, round: null })]) });

  it('R2-L2: an approval the session withdrew is not "Working out the cost…": it asks for Open again, with no confirmation', async () => {
    const opener = doubleFactory(() => ({ mode: 'hidden' }));
    mount(settled(), 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await act(async () => fireEvent.change(within(panel).getByLabelText('Reveal file') as HTMLInputElement, { target: { files: [new File([revealText], 'f.json')] } }));
    await waitFor(() => expect(opener.last().options.file).toBeDefined());
    const session = opener.last();
    fireEvent.click(within(panel).getByRole('button', { name: O.open }));
    const handle = Object.freeze({ ticket: 3n, itemId: 5n, spentWei: 0n, capWei: 2_000n, ceilingWei: 2_000n, gasLimit: 400_000n, fee: {} }) as unknown as HiddenOpeningHandle;
    session.set({ opening: handle });
    await session.resolve('prepareOpening', handle);
    expect(within(panel).getByRole('button', { name: O.confirm })).toBeTruthy();
    // A poll sees a changed journal and clears the displayed handle; no preparation runs.
    session.set({ opening: undefined });
    expect(within(panel).queryByText(O.preparing)).toBeNull();
    expect(within(panel).queryByRole('button', { name: O.confirm })).toBeNull();
    expect(within(panel).getByText(O.withdrawn)).toBeTruthy();
    // Open again is one more press of its own.
    fireEvent.click(within(panel).getByRole('button', { name: O.open }));
    expect(session.calls.map((c) => c.action)).toEqual(['prepareOpening', 'prepareOpening']);
    expect(within(panel).getByText(O.preparing)).toBeTruthy();
  });

  it('a pending first draws read shows the panel only when the session has something to recover', async () => {
    const quiet = doubleFactory(() => ({ mode: 'hidden' }));
    mount(settled(), 2, { createSession: quiet.factory, reads: () => new Promise<HiddenReads>(() => undefined) });
    await waitFor(() => expect(quiet.made).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Draws' })).toBeNull();
    cleanup();
    const pending = doubleFactory(() => ({ mode: 'hidden', unresolved: [Object.freeze({ attempt: 'h1', ids: ['5'], ticket: '3', account: creator, createdAt: 0, capWei: '2000', status: 'unknown' as const })] }));
    mount(settled(), 2, { createSession: pending.factory, reads: () => new Promise<HiddenReads>(() => undefined) });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    expect(within(panel).getByRole('region', { name: W.attempts })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: W.exportRecord })).toBeTruthy();
    expect(within(panel).queryByText('Unavailable')).toBeNull();
  });
});

describe('TA-50 fix round 1 (XR-SH-TA-50): the panel', () => {
  // F1: prepared at 2 gwei the page showed 0.003 ETH; at 20 gwei Confirm draw once sent 0.0246 ETH without asking.
  it('F1: Confirm draw sends exactly the bounty shown; a fee that needs more shows the new amount and asks again', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    const fee = { now: 2_000_000_000n };
    const r = mount({ reads: readsOf([]) }, 2, { io: { read: drawingRead, block: async () => ({ timestamp: 1_800_000_000n, baseFee: fee.now }) } });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Draw one · 1,010 OWL' })));
    const group = await within(panel).findByRole('group', { name: 'Confirm transaction' });
    expect(group.textContent).toContain('+ up to 0.003 ETH for the random number');
    fee.now = 20_000_000_000n;
    await act(async () => fireEvent.click(within(group).getByRole('button', { name: 'Confirm draw' })));
    await waitFor(() => expect(within(panel).getByText('The network fee rose. Check the new amount and confirm again.')).toBeTruthy());
    expect(r.submit).not.toHaveBeenCalled();
    expect(within(panel).getByRole('group', { name: 'Confirm transaction' }).textContent).toContain('+ up to 0.0246 ETH for the random number');
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Confirm draw' })));
    await waitFor(() => expect(r.submit).toHaveBeenCalledTimes(1));
    const sent = (r.submit.mock.calls[0] as unknown as [{ target: { drawValue?: bigint }; call: { value: bigint } }])[0];
    expect(sent.call.value).toBe(24_600_000_000_000_000n);
    expect(sent.target.drawValue).toBe(24_600_000_000_000_000n);
  });

  it('F2: a failed first read shows the panel as Unavailable with Retry, never nothing; Retry reads again', async () => {
    wallet.status = 'disconnected'; wallet.account = null; wallet.signer = null;
    let fail = true;
    const state = { reads: readsOf([]) };
    mount(state, 2, { reads: async () => { if (fail) throw new Error('offline'); return state.reads; } });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /^Draw one/ })).toBeNull();
    fail = false;
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Read failed. Retry' })));
    expect(await within(panel).findByRole('button', { name: 'Draw one · 1,010 OWL' })).toBeTruthy();
    expect(within(panel).queryByText('Unavailable')).toBeNull();
  });

  it('F2: an unreadable price keeps the draw, disabled, as Unavailable; the vault’s own "no draw" still hides it', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    const unread = mount({ reads: readsOf([], { quote: 'unavailable' as never }) });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    expect((within(panel).getByRole('button', { name: 'Draw one · Unavailable' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Read failed. Retry' })).toBeTruthy();
    expect(unread.submit).not.toHaveBeenCalled();
    cleanup();
    const refused = mount({ reads: readsOf([], { quote: null }) });
    await waitFor(() => expect(refused.read).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: 'Draws' })).toBeNull();
  });

  it('F2: a later read that fails keeps every press disabled until a read succeeds again', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    let fail = false;
    const state = { reads: readsOf([]) };
    const r = mount(state, 2, { reads: async () => { if (fail) throw new Error('offline'); return state.reads; } });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    const drawButton = () => within(panel).getByRole('button', { name: 'Draw one · 1,010 OWL' }) as HTMLButtonElement;
    expect(drawButton().disabled).toBe(false);
    fail = true;
    await act(async () => { await r.client.refetchQueries({ queryKey: ['v2-hidden-draws'] }); });
    await waitFor(() => expect(within(panel).getByText('Unavailable')).toBeTruthy());
    expect(drawButton().disabled).toBe(true);
    fail = false;
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Read failed. Retry' })));
    await waitFor(() => expect(drawButton().disabled).toBe(false));
    expect(within(panel).queryByText('Unavailable')).toBeNull();
  });
});


describe('SH-203 af4 hidden observations', () => {
  it('D: the last draw message follows the latest draws read', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    const state = { reads: readsOf([draw({})]) };
    const topics = encodeEventTopics({ abi: boxTicketsAbi, eventName: 'DrawRequested', args: { ticketId: 1n, drawer: me } }) as Hex[];
    const r = mount(state, 2, { io: { read: drawingRead, receipt: async () => ({ status: 'success', logs: [{ address: a(8n), topics,
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 1n, 5n, 0n]) }] }) } });
    await screen.findByRole('region', { name: 'Draws' });
    const panel = () => screen.getByRole('region', { name: 'Draws' });
    await act(async () => fireEvent.click(within(panel()).getByRole('button', { name: 'Draw one · 1,010 OWL' })));
    await act(async () => fireEvent.click(within(panel()).getByRole('button', { name: 'Confirm draw' })));
    await waitFor(() => expect(panel().querySelector('[data-draws-message]')?.textContent).toBe('Drawn · waiting for its random number'));
    state.reads = readsOf([draw({ posted: true })]);
    await act(async () => { await r.client.refetchQueries({ queryKey: ['v2-hidden-draws'] }); });
    await waitFor(() => expect(panel().querySelector('[data-draws-message]')?.textContent).toBe('Drawn.'));
    expect(panel().textContent).not.toContain('waiting for its random number');
    state.reads = readsOf([draw({ status: DRAW.Settled, itemId: 1n, round: null })]);
    await act(async () => { await r.client.refetchQueries({ queryKey: ['v2-hidden-draws'] }); });
    expect(panel().querySelector('[data-draws-message]')?.textContent).toBe('Drawn.');
  });
  it('F: the explanation conditions pictures on verified bytes and withholding', async () => {
    wallet.status = 'connected'; wallet.account = me; wallet.signer = { request: vi.fn() };
    mount({ reads: readsOf([]) });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    expect(panel.textContent).toContain('After reveal, its picture can show when verified bytes are available and the picture is not withheld.');
    expect(panel.textContent).not.toContain('Its picture shows once revealed');
  });
});

describe('SH-203 af6 C-L3', () => {
  it('A7: a wallet change while the opening is at the wallet says it may still go out; the change line once the opening settles', async () => {
    wallet.status = 'connected'; wallet.account = creator; wallet.signer = { request: vi.fn(), walletName: 'test' };
    gateway();
    const opener = doubleFactory(() => ({ mode: 'hidden' }));
    mount({ reads: readsOf([draw({ id: 3n, drawer: creator, status: DRAW.Settled, itemId: 5n, round: null })]) }, 2, { createSession: opener.factory });
    const panel = await screen.findByRole('region', { name: 'Draws' });
    await waitFor(() => expect(opener.made).toHaveLength(1));
    await act(async () => fireEvent.change(within(panel).getByLabelText('Reveal file') as HTMLInputElement, { target: { files: [new File([revealText], 'f.json')] } }));
    await waitFor(() => expect(within(panel).getByText(`Reveal file · ${commitment.n} items`)).toBeTruthy());
    const session = opener.last();
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: O.open })));
    const handle = Object.freeze({ ticket: 3n, itemId: 5n, spentWei: 0n, capWei: 2_000n, ceilingWei: 2_000n, gasLimit: 400_000n, fee: {} }) as unknown as HiddenOpeningHandle;
    session.set({ opening: handle });
    await session.resolve('prepareOpening', handle);
    await act(async () => fireEvent.click(within(within(panel).getByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: O.confirm })));
    expect(session.calls.at(-1)?.action).toBe('open');
    // The account changes while the opening's request is at the wallet: the session stops, the request may still go out.
    session.set({ opening: undefined, cancelled: true, actionReason: 'account-changed' });
    expect(panel.textContent).toContain(`${W.actionOwner}: ${REASON_WORDS['unknown-send']}`);
    expect(panel.textContent).not.toContain(REASON_WORDS['account-changed']);
    // The opening settles: now nothing more is sent, and the line says why.
    await session.resolve('open', { reason: 'account-changed' });
    await waitFor(() => expect(panel.textContent).toContain(`${W.actionOwner}: ${REASON_WORDS['account-changed']}`));
    expect(panel.textContent).not.toContain(`${W.actionOwner}: ${REASON_WORDS['unknown-send']}`);
  });
});
