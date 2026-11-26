import { PENDING_VAULT_MOVES_KEY, resetPendingVaultMovesForTests, expireVaultMoves } from './vault-operations';
/**
 * SH-TA-33 the items panel: numbers first, the vault's items with hash-checked pictures, Take out and Put back with their
 * states (waiting, confirmed, failed). The chain reads are a double (`VaultItemsIO`); the sends (vault-items.ts) and the
 * shared sender behind them are real, so each press reaches the wallet double only through the guard. Rendering the
 * panel asks the wallet nothing.
 */
import { pictureFixture } from '../../../../../../packages/artwork/src/picture-fixtures';
import { createHash } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatUnits } from '@squarehole/domain';
import { sha256Hex } from '@squarehole/artwork';
import { submitWrite } from '@squarehole/chain/write';
import { QueryClient } from '@tanstack/react-query';
import { AppProviders } from '../../../app-providers';
import { resetPicturesForTests } from '../../boxes/box-pictures';
import { resetWithheldForTests } from '../../pictures/withheld';
import { vaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { A, B, ETH, H, publishedItems } from './test-support/m3-published';
import { required } from './test-support/required';
import { nodeUnavailable, vaultRpcFetch } from './test-support/vault-rpc';
import { VaultItemsV2, runText } from './VaultItemsV2';
import { LIMIT_BPS, READ_LIMIT_MS, REFRESH_LINE, takeLimit, vaultRolesOf, type VaultItemV2, type VaultItemsIO, type VaultQuoteV2 } from './vault-items';
import { ROLE_V2 } from '../../../../../../packages/chain/src/core/roles';
import { visibleText } from '../../fit-pair/test-support/visible-text';
import { rawCidV1 } from '@squarehole/artwork';
import type { ItemModelLoader } from '../../scene/ItemModelView';
import { bagHoldersItem, rentFreeItem } from './test-support/item-models';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';
import { ITEM_NOT_REVEALED } from './reveal-words';
import type { ReactNode } from 'react';
import { publishedVaultInventory } from '../../../../../../packages/indexer/src/core/v2/vault-inventory-fixture.test-support';
import type { V2Source } from './indexer-v2';

const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 0, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));

const GATEWAY = 'https://gateway.test';
const PNG = pictureFixture('ordinary.png');
const GOOD = sha256Hex(PNG).toLowerCase() as Hex;
const TAKE = 300_000_000n * ETH + 1n;
const BACK = 290_000_000n * ETH;
const t = (raw: bigint) => `${formatUnits(raw, 18)} ITEM`;
type Tx = { to: Address; data: Hex };

/**
 * A stateful chain double: items 2 and 3 on the shelf (3 with a picture that does not match), item 1 out and the wallet's.
 * `failing` holds the ids whose reads fail (an RPC that does not answer), until a test clears it.
 */
function chain(quote: Partial<VaultQuoteV2> = {}, patch: Readonly<Record<string, Partial<VaultItemV2>>> = {}, failing: readonly string[] = []) {
  const items = new Map<string, VaultItemV2>([
    ['1', { id: 1n, owner: A, onShelf: false, outside: true, revealed: true, imageHash: GOOD, modelHash: null, ...patch['1'] }],
    ['2', { id: 2n, owner: null, onShelf: true, outside: false, revealed: true, imageHash: GOOD, modelHash: null, ...patch['2'] }],
    ['3', { id: 3n, owner: null, onShelf: true, outside: false, revealed: true, imageHash: H(3), modelHash: null, ...patch['3'] }],
  ]);
  const down = new Set(failing);
  const sent: Tx[] = [];
  let hold: Promise<void> | null = null;
  // SH-235: the chain is ahead of the published feed; each confirmed transaction mines one block.
  let block = 1_000_000n;
  const io = (request: VaultItemsIO['request']): VaultItemsIO => ({
    receiptOnce: async () => null,
    head: async () => block, counts: async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: 0n }),
    balanceOf: async (account) => BigInt([...items.values()].filter((item) => item.outside && item.owner?.toLowerCase() === account.toLowerCase()).length),
    feeReader: TEST_FEE_READER, chainId: async () => 31337, request, simulate: async () => undefined, estimate: async () => 100_000n, submit: submitWrite,
    receipt: async (hash) => {
      await hold;
      const tx = required(sent.at(-1));
      // The double moves the item as the vault would.
      const call = (() => { try { return decodeFunctionData({ abi: vaultV2Abi, data: tx.data }); } catch { return null; } })();
      if (call?.functionName === 'withdraw') { const id = call.args[0] as bigint; items.set(id.toString(), { ...required(items.get(id.toString())), owner: A, onShelf: false, outside: true }); }
      if (call?.functionName === 'returnItem') { const id = call.args[0] as bigint; items.set(id.toString(), { ...required(items.get(id.toString())), owner: null, onShelf: true, outside: false }); }
      block += 1n;
      return { transactionHash: hash, blockNumber: block, blockHash: H(9), status: 'success' as const };
    },
    quote: async () => ({ takeT: TAKE, returnT: BACK, inside: 3n, pickFeeBps: 100n, returnFeeBps: 100n, lastItem: false, ...quote }),
    item: async (id) => {
      if (down.has(id.toString())) throw new Error('The request took too long to respond.');
      return items.get(id.toString()) ?? { id, owner: null, onShelf: false, outside: false, revealed: false, imageHash: null, modelHash: null };
    },
    coins: async () => ({ balance: 10n * TAKE, allowance: 0n, block }),
    itemApproved: async (id) => sent.some((tx) => { try { const c = decodeFunctionData({ abi: erc20Abi, data: tx.data }); return c.functionName === 'approve' && c.args[1] === id; } catch { return false; } }),
    now: async () => 1_800_000_000n,
  });
  return { io, sent, items, down, holdNext: () => { let release = () => {}; hold = new Promise<void>((done) => { release = done; }); return () => { release(); hold = null; }; } };
}

async function rig({ account = A as string | null, patch = {} as Partial<V2Snapshot>, quote = {} as Partial<VaultQuoteV2>, disabled = false,
  items = {} as Readonly<Record<string, Partial<VaultItemV2>>>, failing = [] as readonly string[], art = [GATEWAY] as readonly string[], modelLoader = undefined as ItemModelLoader | undefined,
  reveal = undefined as ReactNode } = {}) {
  const { body, source } = await publishedItems({ known: { '1': { inside: false, sequence: 2n } } });
  const parsed = parseSnapshotV2(body, source);
  const view: V2Snapshot = { ...parsed, gate: { ...parsed.gate, open: true }, spec: { ...parsed.spec, firstId: 1n, n: 4 }, ...patch };
  const withArt = { ...source, art };
  wallet.account = account; wallet.status = account ? 'connected' : 'disconnected'; wallet.chainId = source.manifest.chainId;
  const c = chain(quote, items, failing);
  wallet.signer.request.mockImplementation(async ({ method, params }: { method: string; params?: readonly Tx[] }) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_accounts') return [A];
    if (method === 'eth_sendTransaction') { c.sent.push(required(params?.[0])); return H(70 + c.sent.length); }
    throw new Error(`unexpected ${method}`);
  });
  render(<AppProviders><MemoryRouter><VaultItemsV2 view={view} source={withArt} ticker="ITEM" disabled={disabled} io={c.io} modelLoader={modelLoader} reveal={reveal} /></MemoryRouter></AppProviders>);
  return { view, chain: c, roles: required(vaultRolesOf(view)) };
}
const panel = () => screen.getByRole('region', { name: 'Items in the vault' });
const figure = (label: string) => within(panel()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
const press = async (name: string) => act(async () => { fireEvent.click(within(panel()).getByRole('button', { name })); });
const walletMethods = () => wallet.signer.request.mock.calls.map(([call]) => (call as { method: string }).method);
/** Every URL the picture reader asked for (box-pictures.ts), in order. */
const pictureAsks: string[] = [];

beforeEach(() => { resetPendingVaultMovesForTests(); localStorage.clear();
  wallet.signer.request.mockReset();
  pictureAsks.length = 0;
  resetPicturesForTests((async (url: string) => {
    pictureAsks.push(String(url));
    return String(url).startsWith(`${GATEWAY}/ipfs/`) ? new Response(PNG.slice(), { headers: { 'content-type': 'image/png' } }) : new Response(null, { status: 404 });
  }) as typeof fetch);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); resetPicturesForTests(); resetWithheldForTests(); });

describe('SH-TA-33 items panel', () => {
  it('numbers first: the price to take one out, what one brings back, how many are inside; the wallet is asked nothing', async () => {
    await rig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    expect(figure('One back pays')).toBe(t(BACK));
    expect(figure('In the vault')).toBe('3');
    expect(figure('Your ITEM')).toBe(t(10n * TAKE));
    expect(walletMethods()).toEqual([]);
    expect(panel().textContent).not.toMatch(/\b(buy|sell|swap|demo)\b/i);
  });
  it('each item shows its picture only when the bytes hash to the committed hash; otherwise the placeholder', async () => {
    await rig();
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    await waitFor(() => expect(within(shelf).getByRole('img', { name: 'Item #2' }).tagName).toBe('IMG'));
    expect(within(shelf).getByRole('img', { name: 'Item #3, picture unavailable' }).tagName).toBe('SPAN');
    // SH-NO-PICTURE-GATE (fix round 1): a placeholder shows no words or badge; only its accessible name says what it is.
    expect(within(shelf).getByRole('img', { name: 'Item #3, picture unavailable' }).textContent).toBe('');
    const mine = await screen.findByRole('list', { name: 'Your items' });
    await waitFor(() => expect(within(mine).getByRole('button', { name: 'Put back item 1' }).hasAttribute('disabled')).toBe(false));
  });
  it('SH-WITHHELD-SITE: an item whose picture our withheld list names is the neutral tile, on the shelf and under Yours; it is never asked', async () => {
    const listed = createHash('sha256').update(`sh-withheld-v1:ipfs:${rawCidV1(GOOD)}`).digest('hex');
    resetWithheldForTests({ origin: 'https://api.example.test', fetcher: (async () => Response.json({ version: 1, hashes: [listed] })) as unknown as typeof fetch });
    await rig();
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    const tile = await within(shelf).findByRole('img', { name: 'Item #2, picture withheld' });
    expect(tile.tagName).toBe('SPAN');
    expect(tile.textContent).toBe('Picture withheld');
    expect(within(shelf).queryByRole('img', { name: 'Item #2' })).toBeNull();
    // Another item's picture is not touched: the one that does not verify keeps its own placeholder.
    expect(within(shelf).getByRole('img', { name: 'Item #3, picture unavailable' })).toBeTruthy();
    const mine = await screen.findByRole('list', { name: 'Your items' });
    expect(await within(mine).findByRole('img', { name: 'Item #1, picture withheld' })).toBeTruthy();
    await waitFor(() => expect(pictureAsks.some((url) => url.endsWith(rawCidV1(H(3))))).toBe(true));
    expect(pictureAsks.filter((url) => url.endsWith(rawCidV1(GOOD)))).toEqual([]);
  });

  it('an unread price shows as unavailable, never zero, and the last item stays', async () => {
    await rig({ quote: { takeT: null, returnT: null, inside: null, lastItem: true } });
    await waitFor(() => expect(figure('Take one out')).toBe('Last item stays'));
    expect(figure('One back pays')).toBe('Unavailable');
    expect(figure('In the vault')).toBe('Unavailable');
    expect(within(panel()).getByRole('button', { name: 'Take out item 2' }).hasAttribute('disabled')).toBe(true);
  });
  it('Take out: one press, an exact approval and the take, each one confirmation; waiting, then confirmed, then listed as yours', async () => {
    const { chain: c, roles, view } = await rig();
    await screen.findByRole('button', { name: 'Take out item 2' });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const release = c.holdNext();
    await press('Take out item 2');
    await waitFor(() => expect(within(panel()).getByText('Waiting for confirmation…')).toBeTruthy());
    expect(within(panel()).getByRole('button', { name: 'Take out item 3' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #2 is in your wallet')).toBeTruthy());
    expect(c.sent.map((tx) => tx.to)).toEqual([view.token, roles.vault]);
    expect(decodeFunctionData({ abi: erc20Abi, data: required(c.sent[0]).data }).args).toEqual([roles.vault, takeLimit(TAKE)]);
    expect(decodeFunctionData({ abi: vaultV2Abi, data: required(c.sent[1]).data })).toMatchObject({ functionName: 'withdraw', args: [2n, takeLimit(TAKE), 1_800_001_200n] });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your items' })).getByRole('button', { name: 'Put back item 2' })).toBeTruthy());
  });
  it('Put back: approve the item, then return it; confirmed, and it leaves your list', async () => {
    const { chain: c, roles } = await rig();
    const mine = await screen.findByRole('list', { name: 'Your items' });
    await waitFor(() => expect(figure('One back pays')).toBe(t(BACK)));
    await act(async () => { fireEvent.click(within(mine).getByRole('button', { name: 'Put back item 1' })); });
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is back in the vault')).toBeTruthy());
    expect(c.sent.map((tx) => tx.to)).toEqual([roles.collection, roles.vault]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Put back item 1' })).toBeNull());
  });
  it('a declined wallet ends in Failed with the reason; nothing else is sent', async () => {
    const { chain: c } = await rig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      return method === 'eth_chainId' ? '0x7a69' : [A];
    });
    await press('Take out item 2');
    await waitFor(() => expect(within(panel()).getByText('Failed · Declined in your wallet.')).toBeTruthy());
    expect(c.sent).toEqual([]);
  });
  it('without a wallet, Take out opens the wallet chooser and sends nothing; Yours is not shown', async () => {
    await rig({ account: null });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    expect(screen.queryByRole('heading', { name: 'Yours' })).toBeNull();
    await press('Take out item 2');
    expect(await screen.findByRole('dialog', { name: 'Connect a browser wallet' })).toBeTruthy();
    expect(walletMethods()).toEqual([]);
  });
  it('a stale or unverified read keeps every action disabled', async () => {
    await rig({ disabled: true });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    expect(within(panel()).getByRole('button', { name: 'Take out item 2' }).hasAttribute('disabled')).toBe(true);
    expect(within(await screen.findByRole('list', { name: 'Your items' })).getByRole('button', { name: 'Put back item 1' }).hasAttribute('disabled')).toBe(true);
  });
  it('XR-SH-TA-33 F3: every shelf read failed: unavailable with Retry, never an empty claim; Retry reads them again', async () => {
    const { chain: c } = await rig({ failing: ['2', '3', '4'] });
    const retry = await within(panel()).findByRole('button', { name: 'Read failed. Retry' });
    expect(within(panel()).getByText('Items unavailable.')).toBeTruthy();
    expect(within(panel()).queryByText('No items to take out on this page.')).toBeNull();
    expect(within(panel()).queryByRole('list', { name: 'In the vault' })).toBeNull();
    c.down.clear();
    await act(async () => { fireEvent.click(retry); });
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    expect(within(shelf).getByRole('button', { name: 'Take out item 2' })).toBeTruthy();
    await waitFor(() => expect(within(panel()).queryByText('Items unavailable.')).toBeNull());
    expect(within(panel()).queryByRole('button', { name: 'Read failed. Retry' })).toBeNull();
  });
  it('XR-SH-TA-33 F3: a partly failed shelf shows what answered and says the rest is unavailable', async () => {
    await rig({ failing: ['3'] });
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    expect(within(shelf).getByRole('button', { name: 'Take out item 2' })).toBeTruthy();
    expect(within(shelf).queryByRole('button', { name: 'Take out item 3' })).toBeNull();
    expect(await within(panel()).findByText('Some items unavailable.')).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Read failed. Retry' })).toBeTruthy();
  });
  it('XR-SH-TA-33 F3: the wallet’s item reads failed: Yours is unavailable with Retry, not empty; Retry reads them again', async () => {
    const { chain: c } = await rig({ failing: ['1'] });
    await screen.findByRole('list', { name: 'In the vault' });
    const retry = await within(panel()).findByRole('button', { name: 'Read failed. Retry' });
    expect(within(panel()).getByText('Items unavailable.')).toBeTruthy();
    expect(within(panel()).queryByText('None of this box’s items in this wallet.')).toBeNull();
    c.down.clear();
    await act(async () => { fireEvent.click(retry); });
    const mine = await screen.findByRole('list', { name: 'Your items' });
    expect(within(mine).getByRole('button', { name: 'Put back item 1' })).toBeTruthy();
    await waitFor(() => expect(within(panel()).queryByRole('button', { name: 'Read failed. Retry' })).toBeNull());
  });
  it('XR-SH-TA-33 F3: empty lists are claimed only after every read answered', async () => {
    await rig({ items: { '1': { owner: B }, '2': { onShelf: false, outside: true, owner: B }, '3': { onShelf: false, outside: true, owner: B } } });
    expect(await within(panel()).findByText('No items to take out on this page.')).toBeTruthy();
    expect(await within(panel()).findByText('None of this box’s items in this wallet.')).toBeTruthy();
    expect(within(panel()).queryByText(/unavailable\.$/)).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Read failed. Retry' })).toBeNull();
  });
  it('XR-SH-TA-33 F3: without the indexer’s item history (and, SH-235, without its vault inventory: an older server) the wallet’s list is not claimed empty', async () => {
    await rig({ patch: { m3: undefined } });
    await screen.findByRole('list', { name: 'In the vault' });
    expect(await within(panel()).findByText('Items unavailable.')).toBeTruthy();
    expect(within(panel()).queryByText('None of this box’s items in this wallet.')).toBeNull();
  });
  it('XR-SH-TA-33-R2 F3: through the real item reader, only the wallet’s item owner unread: Yours is unavailable with Retry, and Retry reads the owner again', async () => {
    const { body, source } = await publishedItems({ known: { '1': { inside: false, sequence: 2n } } });
    const parsed = parseSnapshotV2(body, source);
    const view: V2Snapshot = { ...parsed, gate: { ...parsed.gate, open: true }, spec: { ...parsed.spec, firstId: 1n, n: 4 } };
    const roles = required(vaultRolesOf(view));
    wallet.account = A; wallet.status = 'connected'; wallet.chainId = source.manifest.chainId;
    const ZERO = `0x${'0'.repeat(64)}` as Hex;
    let ownerDown = true;
    // Item 1 is out and the wallet's, 2 and 3 are on the shelf, 4 is hidden; only item 1's ownerOf fails, until it answers.
    const rpc = vaultRpcFetch({
      inside: () => 3n, pickFeeBps: () => 100n, returnFeeBps: () => 100n, quoteWithdraw: () => TAKE, quoteReturn: () => BACK,
      isOnShelf: ([id]) => id === 2n || id === 3n, isOutside: ([id]) => id === 1n,
      ownerOf: ([id]) => { if (id !== 1n) return roles.vault; if (ownerDown) throw nodeUnavailable(); return A; },
      traitsOf: ([id]) => [id !== 4n, 0n, id === 4n ? ZERO : GOOD, ZERO],
      balanceOf: () => 10n * TAKE, allowance: () => 0n,
    });
    vi.stubGlobal('fetch', rpc.fetch);
    render(<AppProviders><MemoryRouter><VaultItemsV2 view={view} source={{ ...source, art: [GATEWAY] }} ticker="ITEM" disabled={false} /></MemoryRouter></AppProviders>);
    await screen.findByRole('list', { name: 'In the vault' });
    const retry = await within(panel()).findByRole('button', { name: 'Read failed. Retry' });
    expect(within(panel()).getByText('Items unavailable.')).toBeTruthy();
    expect(within(panel()).queryByText('None of this box’s items in this wallet.')).toBeNull();
    expect(within(panel()).queryByRole('list', { name: 'Your items' })).toBeNull();
    const ownerReads = () => rpc.asked.filter((read) => read.name === 'ownerOf' && read.args[0] === 1n).length;
    const before = ownerReads();
    ownerDown = false;
    await act(async () => { fireEvent.click(retry); });
    const mine = await screen.findByRole('list', { name: 'Your items' });
    expect(within(mine).getByRole('button', { name: 'Put back item 1' })).toBeTruthy();
    expect(ownerReads()).toBeGreaterThan(before);
    await waitFor(() => expect(within(panel()).queryByRole('button', { name: 'Read failed. Retry' })).toBeNull());
    expect(within(panel()).queryByText('Items unavailable.')).toBeNull();
    expect(walletMethods()).toEqual([]);
  });
  it('the state words', () => {
    const base = { id: 4n, account: A as Address } as const;
    expect(runText({ ...base, kind: 'take', state: 'waiting', step: 'checking' })).toBe('Take out #4 · checking…');
    expect(runText({ ...base, kind: 'take', state: 'waiting', step: 'withdraw' })).toBe('Waiting · Take out #4 in your wallet…');
    expect(runText({ ...base, kind: 'return', state: 'waiting', step: 'approve' })).toBe('Waiting · approve the item in your wallet…');
    expect(runText({ ...base, kind: 'return', state: 'failed', reason: 'Declined in your wallet.' })).toBe('Failed · Declined in your wallet.');
  });
});

describe('T06 View 3D on the items panel', () => {
  const rent = rentFreeItem(); const bags = bagHoldersItem();
  const ZERO = `0x${'0'.repeat(64)}` as Hex;
  /** Item 2 on the shelf is a Rent Free house (3D), item 3 a 2D item, item 1 (out, the wallet's) a Bag Holders bag (3D). */
  const ART = { '1': { modelHash: bags.modelSha256 }, '2': { modelHash: rent.modelSha256 }, '3': { modelHash: null } } as const;
  /** A model loader double: each call kept with its signal; `answer` decides how it ends. */
  function loader(answer: () => Promise<() => void> = () => new Promise(() => undefined)) {
    const calls: { host: HTMLElement; url: string; sha256: string; signal: AbortSignal; options: unknown }[] = [];
    const load: ItemModelLoader = (host, url, sha256, signal, options) => { calls.push({ host, url, sha256, signal, options }); return answer(); };
    return { load, calls };
  }
  const sheet = () => screen.getByRole('dialog', { name: 'Item #2' });
  const modelBox = () => sheet().querySelector('.sh-vault-model') as HTMLElement;

  it('a 3D button only on revealed items with a model; nothing of a model is asked for on navigation', async () => {
    const { load, calls } = loader();
    await rig({ items: ART, modelLoader: load });
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    await waitFor(() => expect(within(shelf).getByRole('img', { name: 'Item #2' }).tagName).toBe('IMG'));
    expect(within(shelf).getByRole('button', { name: 'View 3D model of item 2' }).textContent).toBe('3D');
    expect(within(shelf).queryByRole('button', { name: 'View 3D model of item 3' })).toBeNull();
    const mine = await screen.findByRole('list', { name: 'Your items' });
    expect(within(mine).getByRole('button', { name: 'View 3D model of item 1' })).toBeTruthy();
    expect(calls).toEqual([]);
    const modelCids = [rawCidV1(rent.modelSha256), rawCidV1(bags.modelSha256)];
    expect(pictureAsks.length).toBeGreaterThan(0);
    expect(pictureAsks.filter((url) => modelCids.some((cid) => url.includes(cid)))).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(walletMethods()).toEqual([]);
  });
  it('an unrevealed item, or a box whose source names no gateway, offers no 3D', async () => {
    await rig({ items: { ...ART, '2': { revealed: false, imageHash: null, modelHash: null } } });
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    expect(within(shelf).getByRole('img', { name: 'Item #2, not revealed' })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: /^View 3D model of item [23]$/ })).toBeNull();
    cleanup();
    await rig({ items: ART, art: [] });
    await screen.findByRole('list', { name: 'In the vault' });
    expect(within(panel()).queryByRole('button', { name: /^View 3D model/ })).toBeNull();
    expect(ZERO).toMatch(/^0x0{64}$/);
  });
  it('the press opens the sheet: the picture until the model is drawn, the model from the gateway by its raw CID, with the arrow keys; Close aborts and disposes, and focus goes back', async () => {
    let finish: (cleanup: () => void) => void = () => undefined;
    const dispose = vi.fn();
    const { load, calls } = loader(() => new Promise((resolve) => { finish = resolve; }));
    await rig({ items: ART, modelLoader: load });
    const button = await screen.findByRole('button', { name: 'View 3D model of item 2' });
    await act(async () => { button.focus(); fireEvent.click(button); });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${GATEWAY}/ipfs/${rawCidV1(rent.modelSha256)}`, sha256: rent.modelSha256, options: { keyboard: true, anonymous: true } });
    expect(modelBox().dataset.model).toBe('loading');
    expect(within(sheet()).queryByText('Drag, or use the arrow keys, to turn it.')).toBeNull();
    expect(modelBox().getAttribute('aria-busy')).toBe('true');
    expect(within(sheet()).getByRole('img', { name: 'Item #2' }).tagName).toBe('IMG');
    expect(within(sheet()).getByRole('img', { name: '3D model of item #2' })).toBe(calls[0]?.host);
    await act(async () => { finish(dispose); await Promise.resolve(); });
    expect(modelBox().dataset.model).toBe('shown');
    expect(within(sheet()).queryByRole('img', { name: 'Item #2' })).toBeNull();
    // Drawn, the view is a widget a screen reader passes the arrow keys to (it was an image while loading).
    const view = within(sheet()).getByRole('application', { name: '3D model of item #2' });
    expect(view).toBe(calls[0]?.host);
    expect(view.getAttribute('tabindex')).toBe('0');
    expect(document.getElementById(view.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Drag, or use the arrow keys, to turn it.');
    await act(async () => { fireEvent.click(within(sheet()).getByRole('button', { name: 'Close' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect(walletMethods()).toEqual([]);
  });
  it('a model that cannot be drawn: the picture stays, with “3D unavailable”; Escape closes and aborts', async () => {
    const { load, calls } = loader(async () => { throw new Error('model hash mismatch'); });
    await rig({ items: ART, modelLoader: load });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'View 3D model of item 2' })); });
    expect(await within(sheet()).findByRole('status')).toHaveProperty('textContent', '3D unavailable');
    expect(modelBox().dataset.model).toBe('failed');
    expect(within(sheet()).queryByText('Drag, or use the arrow keys, to turn it.')).toBeNull();
    expect(within(sheet()).getByRole('img', { name: 'Item #2' }).tagName).toBe('IMG');
    expect(within(sheet()).getByRole('img', { name: '3D model of item #2' }).hasAttribute('tabindex')).toBe(false);
    await act(async () => { fireEvent.keyDown(sheet(), { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls[0]?.signal.aborted).toBe(true);
    // The grid's picture never left.
    expect(within(screen.getByRole('list', { name: 'In the vault' })).getByRole('img', { name: 'Item #2' }).tagName).toBe('IMG');
  });
  it('the wallet’s own 3D item opens the same way (Yours)', async () => {
    const { load, calls } = loader();
    await rig({ items: ART, modelLoader: load });
    const mine = await screen.findByRole('list', { name: 'Your items' });
    await act(async () => { fireEvent.click(within(mine).getByRole('button', { name: 'View 3D model of item 1' })); });
    expect(screen.getByRole('dialog', { name: 'Item #1' })).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: `${GATEWAY}/ipfs/${rawCidV1(bags.modelSha256)}`, sha256: bags.modelSha256 });
  });
  it('XR-ITEM-3D-V2 F3: with two gateways the model is asked of the first only, once; after a failure (missing, or another model’s bytes) no other gateway is asked, and the picture stays with “3D unavailable”', async () => {
    const SECOND = 'https://second.test';
    const model = `${GATEWAY}/ipfs/${rawCidV1(rent.modelSha256)}`;
    for (const answer of [404, bags.model] as const) {
      // The real loader (scene/ItemModelView.tsx loadModel, controller.ts loadItemModel) over this fetch.
      const asks: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        asks.push(String(url));
        return typeof answer === 'number' ? new Response(null, { status: answer })
          : new Response(answer.slice(), { headers: { 'content-type': 'model/gltf-binary', 'content-length': String(answer.length) } });
      }));
      await rig({ items: ART, art: [GATEWAY, SECOND] });
      await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'View 3D model of item 2' })); });
      expect(await within(sheet()).findByRole('status', {}, { timeout: 5_000 })).toHaveProperty('textContent', '3D unavailable');
      expect(asks).toEqual([model]);
      expect(modelBox().dataset.model).toBe('failed');
      expect(within(sheet()).getByRole('img', { name: 'Item #2' }).tagName).toBe('IMG');
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});

describe('SH-203 on the line: an unrevealed item says why its button is off', () => {
  /** The tile of item `id` in `list`, and its one button. */
  const tile = (list: HTMLElement, id: number) => within(list).getByText(`#${id}`, { selector: '.sh-vault-item__id' }).closest('li') as HTMLElement;
  const describedBy = (button: HTMLElement) => (button.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent);

  it('each unrevealed tile has the one line, tied to its disabled button; a revealed tile has none', async () => {
    // Item 2 (on the shelf) and item 1 (out, this wallet's) are not revealed; item 3 is.
    await rig({ items: { '1': { revealed: false, imageHash: null }, '2': { revealed: false, imageHash: null } } });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    const mine = await screen.findByRole('list', { name: 'Your items' });
    const take2 = within(tile(shelf, 2)).getByRole('button', { name: 'Take out item 2' }) as HTMLButtonElement;
    expect(take2.disabled).toBe(true);
    expect(within(tile(shelf, 2)).getByText(ITEM_NOT_REVEALED)).toBeTruthy();
    expect(describedBy(take2)).toEqual([ITEM_NOT_REVEALED]);
    const back1 = within(tile(mine, 1)).getByRole('button', { name: 'Put back item 1' }) as HTMLButtonElement;
    expect(back1.disabled).toBe(true);
    expect(describedBy(back1)).toEqual([ITEM_NOT_REVEALED]);
    // The revealed item: no line, nothing describes its button, and it can be taken out.
    const take3 = within(tile(shelf, 3)).getByRole('button', { name: 'Take out item 3' }) as HTMLButtonElement;
    expect(within(tile(shelf, 3)).queryByText(ITEM_NOT_REVEALED)).toBeNull();
    expect(take3.hasAttribute('aria-describedby')).toBe(false);
    expect(take3.disabled).toBe(false);
    // One line per unrevealed tile, each with its own id; no other new text in the card.
    const lines = [...panel().querySelectorAll('[data-not-revealed]')];
    expect(lines.map((line) => line.textContent)).toEqual([ITEM_NOT_REVEALED, ITEM_NOT_REVEALED]);
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
    expect(walletMethods()).toEqual([]);
  });

  it('every item revealed: no line anywhere', async () => {
    await rig();
    await screen.findByRole('list', { name: 'In the vault' });
    await screen.findByRole('list', { name: 'Your items' });
    expect(panel().querySelector('[data-not-revealed]')).toBeNull();
    expect(within(panel()).queryByText(ITEM_NOT_REVEALED)).toBeNull();
  });

  it('the card holds the reveal entry it is given, above the items', async () => {
    await rig({ items: { '2': { revealed: false, imageHash: null } }, reveal: <p data-entry=""><button type="button">Reveal items</button></p> });
    const shelf = await screen.findByRole('list', { name: 'In the vault' });
    const entry = within(panel()).getByRole('button', { name: 'Reveal items' });
    expect(entry.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the line is the one proposal constant (the founder’s answer is a change of it)', () => {
    expect(ITEM_NOT_REVEALED).toBe('Not revealed yet');
  });
});

describe('SH-235 a vault whose fees do not pay its items (burn/burn): both lists from the vault inventory', () => {
  const N = 500;
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => BigInt(from + i));
  /**
   * The part 1 publication (packages/indexer vault-inventory fixture: 500 items from 1, no m3), its record replaced by
   * `out` (newest first) with their owners (default A), and a chain double that agrees with it: every other id is on
   * the shelf, revealed. Its receipts mine blocks after the feed's, and move the item as the vault would.
   */
  async function burnRig({ out = [] as readonly bigint[], owners = {} as Readonly<Record<string, Address>>, account = A as Address, record = true, history = false, wrap = (io: VaultItemsIO) => io, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) } = {}) {
    const { view: body, manifest } = await publishedVaultInventory();
    const source: V2Source = { network: 'local', origin: 'https://indexer.invalid', rpc: 'http://127.0.0.1:8599', manifest, art: [GATEWAY] };
    const vaultItems = { firstId: '1', n: String(N), known: out.map((id, i) => ({ id: String(id), inside: false, sequence: String(10_000 - i) })),
      owners: Object.fromEntries(out.map((id) => [String(id), (owners[String(id)] ?? A).toLowerCase()])) };
    const parsed = parseSnapshotV2(record ? { ...body, vaultItems } : body, source);
    const oldHistory = history ? parseSnapshotV2((await publishedItems()).body, source).m3 : undefined;
    const view: V2Snapshot = { ...parsed, ...(oldHistory ? { m3: { ...oldHistory, items: { ...required(oldHistory.items), known: required(parsed.vaultItems).known, owners: required(parsed.vaultItems).owners } } } : {}), gate: { ...parsed.gate, open: true }, verified: true, stale: false };
    const place = new Map<string, Address>(out.map((id) => [String(id), (owners[String(id)] ?? A) as Address]));
    const sent: Tx[] = []; let block = view.block + 50n;
    let refresh: Promise<void> | null = null; let holdRefresh = false; let release = () => {};
    const io = (request: VaultItemsIO['request']): VaultItemsIO => ({
      receiptOnce: async () => null,
      head: async () => block, counts: async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: 0n }),
      balanceOf: async (who) => BigInt([...place.values()].filter((owner) => owner.toLowerCase() === who.toLowerCase()).length),
      feeReader: TEST_FEE_READER, chainId: async () => 31337, request, simulate: async () => undefined, estimate: async () => 100_000n, submit: submitWrite,
      receipt: async (hash) => {
        const tx = required(sent.at(-1));
        const call = (() => { try { return decodeFunctionData({ abi: vaultV2Abi, data: tx.data }); } catch { return null; } })();
        if (call?.functionName === 'withdraw') place.set(String(call.args[0]), account);
        if (call?.functionName === 'returnItem') place.delete(String(call.args[0]));
        // After the take or the put-back, the card's refresh waits here while the test holds it.
        if (call && holdRefresh) refresh = new Promise<void>((done) => { release = () => { refresh = null; done(); }; });
        block += 1n;
        return { transactionHash: hash, blockNumber: block, blockHash: H(Number(block % 200n)), status: 'success' as const };
      },
      quote: async () => { await refresh; return { takeT: TAKE, returnT: BACK, inside: BigInt(N - place.size), pickFeeBps: 100n, returnFeeBps: 100n, lastItem: false }; },
      item: async (id) => {
        const owner = place.get(String(id)) ?? null;
        return { id, owner, onShelf: owner === null && id >= 1n && id <= BigInt(N), outside: owner !== null, revealed: true, imageHash: null, modelHash: null };
      },
      coins: async () => ({ balance: 100n * TAKE, allowance: 0n, block }),
      itemApproved: async (id) => sent.some((tx) => { try { const c = decodeFunctionData({ abi: erc20Abi, data: tx.data }); return c.functionName === 'approve' && c.args[1] === id; } catch { return false; } }),
      now: async () => 1_800_000_000n,
    });
    wallet.account = account; wallet.status = 'connected'; wallet.chainId = source.manifest.chainId;
    wallet.signer.request.mockImplementation(async ({ method, params }: { method: string; params?: readonly Tx[] }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') { sent.push(required(params?.[0])); return H(70 + sent.length); }
      throw new Error(`unexpected ${method}`);
    });
    const mount = (queryClient = client) => render(<AppProviders queryClient={queryClient}><MemoryRouter><VaultItemsV2 view={view} source={source} ticker="ITEM" disabled={false} io={(request) => wrap(io(request))} /></MemoryRouter></AppProviders>);
    mount();
    return { view, source, sent, place, mount, client, hold: () => { holdRefresh = true; }, release: () => { holdRefresh = false; release(); } };
  }
  /** The item ids shown in one list, in order. */
  const shown = (name: 'In the vault' | 'Your items') => (screen.queryByRole('list', { name }) ? within(screen.getByRole('list', { name })).queryAllByText(/^#\d+$/, { selector: '.sh-vault-item__id' }) : [])
    .map((node) => BigInt(required(node.textContent).slice(1)));
  const yoursMore = () => within(panel()).getAllByRole('button', { name: /^More items, page \d+ of \d+$/ }).at(-1) as HTMLElement;

  it('the floor survives more than five idle minutes and a card remount', async () => {
    const r = await burnRig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await press('Take out item 1');
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy();
      const floor = required(r.client.getQueryCache().findAll().find((q) => q.queryKey.includes('floor')));
      expect(floor.state.data).toBeGreaterThan(r.view.block);
      r.client.setQueryData(['expiry-control'], 1);
      cleanup(); await vi.advanceTimersByTimeAsync(301_000);
      expect(r.client.getQueryData(['expiry-control'])).toBeUndefined();
      expect(r.client.getQueryData(floor.queryKey)).toBe(floor.state.data);
    } finally { vi.useRealTimers(); }
    r.mount();
    await waitFor(() => expect(shown('Your items')).toEqual([1n]));
  });
  it.each([false, true])('a timeout holds a move until expiry; a pending count also blocks another take, approval=%s', async (approval) => {
    let pending = false; let reads = 0; let now = 1_800_000_000n;
    const r = await burnRig({ wrap: (io) => ({ ...io,
      counts: async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: pending ? 1n : 0n }),
      now: async () => now,
      coins: async (...args) => ({ ...await io.coins(...args), allowance: approval ? 0n : takeLimit(TAKE) }),
      receipt: async () => { reads++; pending = true; throw new Error('receipt timeout'); },
    }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText('Failed · Sent, but not confirmed. Check your wallet before trying again.')).toBeTruthy());
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Take out item 1' }).hasAttribute('disabled')).toBe(false));
    await press(approval ? 'Take out item 2' : 'Take out item 1');
    await waitFor(() => expect(within(panel()).getByText(approval ? 'Failed · An earlier transaction is still under way.' : 'Failed · Sent, but not confirmed. Check your wallet before trying again.')).toBeTruthy());
    expect(reads).toBe(1); expect(r.sent).toHaveLength(1);
    cleanup(); r.mount(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText(approval ? 'Failed · An earlier transaction is still under way.' : 'Failed · Sent, but not confirmed. Check your wallet before trying again.')).toBeTruthy());
    expect(reads).toBe(1); expect(r.sent).toHaveLength(1);
    pending = false; now += 1201n; // The vault now refuses the old move; equal counts allow a new press.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take out item 1' }).hasAttribute('disabled')).toBe(false));
    await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText('Failed · Sent, but not confirmed. Check your wallet before trying again.')).toBeTruthy());
    expect(reads).toBe(2); expect(r.sent).toHaveLength(2);
  });
  it.each([false, true])('both lists clamp after their last tile leaves, items history=%s', async (history) => {
    const r = await burnRig({ out: ids(1, 487), history });
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(488, 499)));
    await press('More items, page 2 of 2');
    await waitFor(() => expect(shown('In the vault')).toEqual([500n]));
    await press('Take out item 500');
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(488, 499)));
    expect(r.sent).toHaveLength(2);
    cleanup();
    await burnRig({ out: ids(1, 13), history });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
    await act(async () => { fireEvent.click(yoursMore()); });
    await waitFor(() => expect(shown('Your items')).toEqual([13n]));
    await press('Put back item 13');
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
  });
  it('the same item can leave and come back in one visit over a lagging feed', async () => {
    await burnRig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await press('Take out item 1');
    await waitFor(() => expect(shown('Your items')).toEqual([1n]));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Put back item 1' }).hasAttribute('disabled')).toBe(false));
    await press('Put back item 1');
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(1, 12)));
    expect(shown('Your items')).toEqual([]);
  });
  it('two cards sharing the visit cannot send overlapping runs', async () => {
    const r = await burnRig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    r.mount();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Take out item 1' })).toHaveLength(2));
    const buttons = screen.getAllByRole('button', { name: 'Take out item 1' });
    await act(async () => { for (const button of buttons) button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(() => expect(screen.getAllByText('Confirmed · #1 is in your wallet').length).toBeGreaterThan(0));
    expect(r.sent).toHaveLength(2);
  });
  it('a same-call speed-up displays the confirmed sentence and moves the item', async () => {
    const r = await burnRig({ wrap: (io) => ({ ...io,
      coins: async (...args) => ({ ...await io.coins(...args), allowance: takeLimit(TAKE) }),
      receipt: async (hash, onReplaced) => {
        const calls = wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: Tx[] });
        const tx = required(calls.filter((call) => call.method === 'eth_sendTransaction').at(-1)?.params?.[0]);
        const original = { hash, from: A, to: tx.to, input: tx.data, value: 0n, nonce: 7 };
        const receipt = { ...await io.receipt(hash), transactionHash: H(99) };
        onReplaced?.({ reason: 'repriced', replacedTransaction: original, transaction: { ...original, hash: H(99) }, transactionReceipt: receipt } as import('./vault-operations').VaultReplacementV2);
        return receipt;
      },
    }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy());
    await waitFor(() => expect(shown('Your items')).toEqual([1n]));
    expect(shown('In the vault')).not.toContain(1n); expect(r.sent).toHaveLength(1);
  });
  it('a second press in the same tick sends one run only', async () => {
    const r = await burnRig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const button = within(panel()).getByRole('button', { name: 'Take out item 1' });
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy());
    expect(r.sent).toHaveLength(2);
  });
  it.each(['refusal', 'decline', 'revert', 'success', 'refresh throws'] as const)('releases the card after %s, including a throwing refresh without an unhandled rejection', async (path) => {
    const r = await burnRig({ wrap: (io) => ({ ...io,
      simulate: async () => { if (path === 'refusal') throw new Error('upstream request timed out'); },
      submit: async (request) => { if (path === 'decline') throw new (await import('@squarehole/chain/write')).WalletRejectedError(); return io.submit(request); },
      receipt: async (...args) => { const receipt = await io.receipt(...args); return path === 'revert' ? { ...receipt, status: 'reverted' } : receipt; },
    }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    if (path === 'refresh throws') vi.spyOn(r.client, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByRole('status').textContent).toMatch(/^(Failed|Confirmed) ·/));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Take out item 2' }).hasAttribute('disabled')).toBe(false));
  });
  it('no-history shelf refills after the first twelve leave: 1-12 out, page one shows 13-24, Yours all twelve', async () => {
    await burnRig({ out: ids(1, 12) });
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(13, 24)));
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
    // Twelve fit one page of Yours: only the vault's More items (488 inside: 41 pages).
    expect(within(panel()).getAllByRole('button', { name: /^More items/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['More items, page 2 of 41']);
  });
  it('a fresh page load finds every owned item: no session memory, the record alone', async () => {
    const first = await burnRig({ out: ids(1, 12) });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
    cleanup();
    // A new query client (a reload, or another browser): nothing of the first visit is kept.
    first.mount(new QueryClient());
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
    expect(within(panel()).queryByText('Items unavailable.')).toBeNull();
    expect(walletMethods()).toEqual([]);
  });
  it('an item received by transfer shows in Yours (the part 1 record as published: item 1 passed on to the second wallet)', async () => {
    await burnRig({ account: B, record: false });
    await waitFor(() => expect(shown('Your items')).toEqual([]));
    cleanup();
    // The fixture's own record has 1 with B; this chain double has 1 out with B too.
    const { view: body, manifest } = await publishedVaultInventory();
    expect((body as { vaultItems?: { owners: Record<string, string> } }).vaultItems?.owners['1']?.toLowerCase()).toBe(B.toLowerCase());
    await burnRig({ account: B, out: [1n], owners: { '1': B } });
    await waitFor(() => expect(shown('Your items')).toEqual([1n]));
    expect(shown('In the vault')).not.toContain(1n);
    expect(manifest.chainId).toBe(31337);
  });
  it('a lagging record never shows an item in both lists: a take and a put-back of this visit lie over it', async () => {
    await burnRig({ out: ids(1, 12) });
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(13, 24)));
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await press('Take out item 13');
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #13 is in your wallet')).toBeTruthy());
    // The feed has not reached the take (the view is the same): the card's own record of it decides.
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(14, 25)));
    await waitFor(() => expect(shown('Your items')).toEqual([13n, ...ids(1, 11)]));
    await act(async () => { fireEvent.click(within(screen.getByRole('list', { name: 'Your items' })).getByRole('button', { name: 'Put back item 5' })); });
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #5 is back in the vault')).toBeTruthy());
    await waitFor(() => expect(shown('In the vault')).toEqual([5n, ...ids(14, 24)]));
    await waitFor(() => expect(shown('Your items')).toEqual([13n, ...ids(1, 4), ...ids(6, 12)]));
    const both = shown('In the vault').filter((id) => shown('Your items').includes(id));
    expect(both).toEqual([]);
  });
  it('Yours pages beyond 24: thirty owned items, twelve at a time, with the existing More items words', async () => {
    await burnRig({ out: ids(1, 30) });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
    expect(yoursMore().getAttribute('aria-label')).toBe('More items, page 2 of 3');
    expect(yoursMore().textContent).toBe('More items');
    await act(async () => { fireEvent.click(yoursMore()); });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(13, 24)));
    await act(async () => { fireEvent.click(yoursMore()); });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(25, 30)));
    expect(yoursMore().getAttribute('aria-label')).toBe('More items, page 1 of 3');
    await act(async () => { fireEvent.click(yoursMore()); });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
  });
  it('busy lasts through the refresh: after the confirmation every action waits until the card has read again', async () => {
    const r = await burnRig({ out: ids(1, 12) });
    await waitFor(() => expect(shown('In the vault')).toEqual(ids(13, 24)));
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    r.hold();
    await press('Take out item 13');
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #13 is in your wallet')).toBeTruthy());
    const take14 = () => within(panel()).getByRole('button', { name: 'Take out item 14' });
    await waitFor(() => expect(take14()).toBeTruthy());
    expect(take14().hasAttribute('disabled')).toBe(true);
    expect(within(screen.getByRole('list', { name: 'Your items' })).getByRole('button', { name: 'Put back item 1' }).hasAttribute('disabled')).toBe(true);
    // A second press while it refreshes sends nothing.
    const before = r.sent.length;
    await act(async () => { fireEvent.click(take14()); });
    expect(r.sent.length).toBe(before);
    await act(async () => { r.release(); });
    await waitFor(() => expect(take14().hasAttribute('disabled')).toBe(false));
  });
  it.each(['take', 'return'] as const)('R3 pending counts survive a reload with cleared module memory: %s', async (kind) => {
    const r = await burnRig({ out: kind === 'return' ? [1n] : [], wrap: (io) => ({ ...io, counts: async () => ({ mined: 3n, latest: 3n, latestAfter: 3n, pending: 4n }) }) });
    const button = kind === 'take' ? 'Take out item 1' : 'Put back item 1';
    for (let reload = 0; reload < 2; reload++) {
      await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
      await screen.findByRole('button', { name: button }); await press(button);
      await waitFor(() => expect(within(panel()).getByText('Failed · An earlier transaction is still under way.')).toBeTruthy());
      expect(r.sent).toHaveLength(0);
      if (reload === 0) { cleanup(); r.client.clear(); vi.resetModules(); await import('./vault-operations'); r.mount(new QueryClient({ defaultOptions: { queries: { retry: false } } })); }
    }
  });
  it('R3 two spellings share the count and floor; lower counts allow fresh runs, higher counts raise the floor, lower heads refresh', async () => {
    const account = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'); let mined = 3n; let block = 1_000_000n;
    const r = await burnRig({ account, wrap: (io) => ({ ...io, head: async () => block, counts: async () => ({ mined, latest: mined, latestAfter: mined, pending: mined }),
      coins: async (...args) => ({ ...await io.coins(...args), block }) }) });
    await waitFor(() => expect(shown('In the vault')).toHaveLength(12));
    mined = 4n; block = 1_000_010n;
    await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    const floors = r.client.getQueryCache().findAll().filter((q) => q.queryKey.includes('floor'));
    expect(floors).toHaveLength(1); expect(floors[0]?.state.data).toBe(block);
    expect(floors[0]?.queryKey.at(-1)).toBe(account.toLowerCase());
    cleanup(); wallet.account = account.toLowerCase();
    r.mount(); await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const counts = r.client.getQueryCache().findAll().filter((q) => q.queryKey.includes('count'));
    expect(counts).toHaveLength(1); expect(counts[0]?.queryKey.at(-1)).toBe(account.toLowerCase());
    expect(counts[0]?.state.data).toEqual({ mined: 4n, block });
    expect(r.client.getQueryCache().findAll().filter((q) => q.queryKey.includes('floor'))).toEqual(floors);
    // A lower count at a later named block replaces memory; this press uses its own reads.
    mined = 3n; block = 1_000_011n;
    await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByRole('status').textContent).toMatch(/^(Confirmed|Failed) · /));
    expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy();
    expect(within(panel()).queryByText(`Failed · ${REFRESH_LINE}`)).toBeNull(); expect(r.sent).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: required(r.sent[0]).data }).functionName).toBe('approve');
    expect(decodeFunctionData({ abi: vaultV2Abi, data: required(r.sent[1]).data }).functionName).toBe('withdraw');
    expect(counts[0]?.state.data).toEqual({ mined, block }); expect(floors[0]?.state.data).toBe(1_000_010n);
    // Returning to the old count is an increase from the lower count and raises the floor again.
    mined = 4n; block = 1_000_020n;
    await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    expect(counts[0]?.state.data).toEqual({ mined, block }); expect(floors[0]?.state.data).toBe(block);
    // Equal pending/mined counts still cannot use a head below the same account's remembered floor.
    block = 10n;
    await press('Take out item 2');
    await waitFor(() => expect(within(panel()).getByText(`Failed · ${REFRESH_LINE}`)).toBeTruthy()); expect(r.sent).toHaveLength(2);
  });
  it.each([false, true])('R3 pending count is independent of checksum spelling: lowercase=%s', async (lower) => {
    const checksum = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    const r = await burnRig({ account: (lower ? checksum.toLowerCase() : checksum) as Address,
      wrap: (io) => ({ ...io, counts: async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: 1n }) }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE))); await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText('Failed · An earlier transaction is still under way.')).toBeTruthy()); expect(r.sent).toHaveLength(0);
  });
  it('R3 the card passes put-back the approval floor on the next press', async () => {
    let lag = false; let approved = false; const floors: bigint[] = [];
    const r = await burnRig({ out: [1n], wrap: (io) => ({ ...io,
      head: async (floor = 0n) => { floors.push(floor); return lag ? 10n : io.head(floor); },
      itemApproved: async () => { if (approved) throw new Error('read failed after approval'); return false; },
      receipt: async (...args) => { approved = true; return io.receipt(...args); },
    }) });
    await waitFor(() => expect(figure('One back pays')).toBe(t(BACK))); await screen.findByRole('button', { name: 'Put back item 1' });
    await press('Put back item 1');
    await waitFor(() => expect(within(panel()).getByText(`Failed · ${REFRESH_LINE}`)).toBeTruthy()); expect(r.sent).toHaveLength(1);
    const floor = floors.at(-1); expect(floor).toBeGreaterThan(10n); lag = true; approved = false;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Put back item 1' }).hasAttribute('disabled')).toBe(false));
    await press('Put back item 1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Put back item 1' }).hasAttribute('disabled')).toBe(false));
    expect(floors).toContain(floor); expect(floors.filter((value) => value === 0n)).toHaveLength(1);
    expect(within(panel()).getByText(`Failed · ${REFRESH_LINE}`)).toBeTruthy(); expect(r.sent).toHaveLength(1);
  });
  it.each([false, true])('R3 take success retires after transfer, off the selected page=%s', async (offPage) => {
    const r = await burnRig({ out: offPage ? ids(2, 13) : [] });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE))); await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy());
    if (offPage) { await act(async () => { fireEvent.click(yoursMore()); }); await waitFor(() => expect(shown('Your items')).not.toContain(1n)); }
    r.place.set('1', B); await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    await waitFor(() => expect(within(panel()).queryByText('Confirmed · #1 is in your wallet')).toBeNull()); expect(r.sent).toHaveLength(2);
  });
  it('R3 return success retires when another wallet takes the item', async () => {
    const r = await burnRig({ out: [1n] });
    await waitFor(() => expect(figure('One back pays')).toBe(t(BACK))); await screen.findByRole('button', { name: 'Put back item 1' }); await press('Put back item 1');
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is back in the vault')).toBeTruthy());
    r.place.set('1', B); await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    await waitFor(() => expect(within(panel()).queryByText('Confirmed · #1 is back in the vault')).toBeNull()); expect(r.sent).toHaveLength(2);
  });
  it.each(['older', 'failed'] as const)('R3 a %s read cannot retire success', async (mode) => {
    let bad = false;
    const r = await burnRig({ wrap: (io) => ({ ...io, head: async (...args) => bad && mode === 'older' ? 10n : io.head(...args),
      item: async (...args) => { if (bad && mode === 'failed') throw new Error('unread'); return io.item(...args); } }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE))); await press('Take out item 1');
    await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy());
    bad = true; r.place.set('1', B); await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy(); expect(r.sent).toHaveLength(2);
  });
  it.each(['take', 'return'] as const)('R3 not-confirmed line retires when the %s arrives', async (kind) => {
    const r = await burnRig({ out: kind === 'return' ? [1n] : [], wrap: (io) => ({ ...io,
      coins: async (...args) => ({ ...await io.coins(...args), allowance: takeLimit(TAKE) }), itemApproved: async () => true,
      receipt: async () => { throw new Error('receipt lost'); },
    }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE))); await screen.findByRole('button', { name: kind === 'take' ? 'Take out item 1' : 'Put back item 1' });
    await press(kind === 'take' ? 'Take out item 1' : 'Put back item 1');
    const line = 'Failed · Sent, but not confirmed. Check your wallet before trying again.';
    await waitFor(() => expect(within(panel()).getByText(line)).toBeTruthy());
    if (kind === 'take') r.place.set('1', A); else r.place.delete('1');
    await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    await waitFor(() => expect(within(panel()).queryByText(line)).toBeNull());
    await waitFor(() => expect(shown(kind === 'take' ? 'Your items' : 'In the vault')).toContain(1n)); expect(r.sent).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]')).toHaveLength(1);
  });
  it.each(['positive', 'zero', 'unread'] as const)('R3 empty selected page uses collection balance: %s', async (balance) => {
    const balanceReads: bigint[] = [];
    const r = await burnRig({ out: ids(1, 13), wrap: (io) => ({ ...io, balanceOf: async (...args) => { balanceReads.push(args[1]); if (balance === 'unread') throw new Error('unread'); return io.balanceOf(...args); } }) });
    await waitFor(() => expect(shown('Your items')).toEqual(ids(1, 12)));
    expect(balanceReads).toEqual([]);
    for (const id of ids(1, balance === 'zero' ? 13 : 12)) r.place.set(String(id), B);
    await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    await waitFor(() => expect(shown('Your items')).toEqual([]));
    expect(within(panel()).queryByText('None of this box’s items in this wallet.') !== null).toBe(balance === 'zero');
    if (balance !== 'zero') expect(within(panel()).getByText('Items unavailable.')).toBeTruthy();
    expect(balanceReads).toEqual([r.view.block + 50n]);
    expect(yoursMore().getAttribute('aria-label')).toBe('More items, page 2 of 2'); expect(r.sent).toHaveLength(0);
  });
  it.each(['take approval', 'return approval', 'take move', 'return move'])('R3 status follows each held boundary: %s', async (path) => {
    const take = path.startsWith('take'); const approval = path.endsWith('approval');
    const holds = Object.fromEntries(['head', 'start count', 'item', 'price', 'asset', 'time', 'simulation', 'estimate', 'check', 'wallet', 'receipt', 'after approval'].map((key) => {
      let release = () => {}; const promise = new Promise<void>((done) => { release = done; }); return [key, { promise, release }];
    }));
    const held = (phase: string) => { const value = holds[phase]; if (!value) throw new Error(`Unknown held boundary: ${phase}`); return value; };
    let at = ''; let checks = 0; let first = true; let walletAsks = 0; let active = false; let afterApproval = false;
    const entered = new Set<string>();
    const holdRead = async (phase: string) => { if (active && first) { entered.add(phase); await held(phase).promise; } };
    const r = await burnRig({ out: take ? [] : [1n], wrap: (io) => ({ ...io,
      head: async (...args) => { await holdRead('head'); if (active && approval && !first && !afterApproval) { afterApproval = true; entered.add('after approval'); await held('after approval').promise; } return io.head(...args); },
      item: async (...args) => { await holdRead('item'); return io.item(...args); },
      quote: async (...args) => { await holdRead('price'); return io.quote(...args); },
      coins: async (...args) => { await holdRead('asset'); return { ...await io.coins(...args), allowance: approval ? 0n : takeLimit(TAKE) }; },
      itemApproved: async (...args) => { await holdRead('asset'); return !approval || io.itemApproved(...args); },
      now: async (...args) => { await holdRead('time'); return io.now(...args); },
      simulate: async (...args) => { if (first) { at = 'simulation'; await held('simulation').promise; } return io.simulate(...args); },
      estimate: async (...args) => { if (first) { at = 'estimate'; await held('estimate').promise; } return io.estimate(...args); },
      counts: async (...args) => { await holdRead('start count'); if (at === 'estimate' && ++checks === 1) { at = 'check'; await held('check').promise; } return io.counts(...args); },
      request: async (request) => { if (request.method === 'eth_sendTransaction') walletAsks++; if (first && request.method === 'eth_sendTransaction') { at = 'wallet'; await held('wallet').promise; } return io.request(request); },
      receipt: async (...args) => { if (first) { at = 'receipt'; await held('receipt').promise; first = false; } return io.receipt(...args); },
    }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE))); const button = take ? 'Take out item 1' : 'Put back item 1';
    await screen.findByRole('button', { name: button }); active = true; await press(button);
    const checking = `${take ? 'Take out' : 'Put back'} #1 · checking…`;
    for (const phase of ['head', 'start count', 'item', 'price', 'asset', 'time', 'simulation', 'estimate', 'check', 'wallet', 'receipt', ...(approval ? ['after approval'] : [])]) {
      await waitFor(() => expect(entered.has(phase) || at === phase).toBe(true));
      const line = phase === 'receipt' ? 'Waiting for confirmation…' : phase === 'wallet'
        ? `Waiting · ${approval ? (take ? 'approve coins' : 'approve the item') : `${take ? 'Take out' : 'Put back'} #1`} in your wallet…` : checking;
      expect(within(panel()).getByText(line)).toBeTruthy(); expect(walletAsks).toBe(['wallet', 'receipt', 'after approval'].includes(phase) ? 1 : 0);
      await act(async () => { held(phase).release(); });
    }
    await waitFor(() => expect(within(panel()).getByText(take ? 'Confirmed · #1 is in your wallet' : 'Confirmed · #1 is back in the vault')).toBeTruthy());
    expect(r.sent).toHaveLength(approval ? 2 : 1);
  });
  it('R3 a run read that never answers is bounded and releases the run lock', async () => {
    let hang = false; const r = await burnRig({ wrap: (io) => ({ ...io, head: (...args) => hang ? new Promise<bigint>(() => {}) : io.head(...args) }) });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE))); await screen.findByRole('button', { name: 'Take out item 1' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); hang = true;
    try {
      await press('Take out item 1'); expect(within(panel()).getByText('Take out #1 · checking…')).toBeTruthy(); expect(r.sent).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_LIMIT_MS + 1); });
      expect(within(panel()).getByText(`Failed · ${REFRESH_LINE}`)).toBeTruthy();
      hang = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_LIMIT_MS + 1); });
      await press('Take out item 1'); await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy(); expect(r.sent).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('R3 a thrown refresh releases the shared run lock for the next press', async () => {
    const r = await burnRig(); await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    vi.spyOn(r.client, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    await press('Take out item 1'); await waitFor(() => expect(within(panel()).getByText('Confirmed · #1 is in your wallet')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take out item 2' }).hasAttribute('disabled')).toBe(false));
    await press('Take out item 2'); await waitFor(() => expect(within(panel()).getByText('Confirmed · #2 is in your wallet')).toBeTruthy()); expect(r.sent).toHaveLength(4);
  });

  it('R4 a revealed item without a picture says picture unavailable and can be taken', async () => {
    await burnRig();
    expect(await screen.findByRole('img', { name: 'Item #1, picture unavailable' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Item #1, not revealed' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Take out item 1' }).hasAttribute('disabled')).toBe(false);
  });
  it.each(['positive', 'zero', 'unread'] as const)('R4 a rejected duplicate inventory uses only a proved zero balance for empty Yours: %s', async (balance) => {
    const blocks: bigint[] = [];
    const r = await burnRig({ out: [1n, 1n], wrap: (io) => ({ ...io, balanceOf: async (_a, block) => {
      blocks.push(block); if (balance === 'unread') throw new Error('unread'); return balance === 'zero' ? 0n : 1n;
    } }) });
    expect(r.view.vaultItems).toBeUndefined();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Yours' }).nextElementSibling?.textContent).toBe(balance === 'zero' ? 'None of this box’s items in this wallet.' : 'Items unavailable.'));
    expect(blocks).toEqual([r.view.block + 50n]); expect(shown('Your items')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Put back item 1' })).toBeNull(); expect(r.sent).toHaveLength(0);
  });
  it.each(['same', 'reload', 'spelling'] as const)('R4 an omitted take stays held on the next press: %s', async (again) => {
    const account = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    const r = await burnRig({ account, wrap: (io) => ({ ...io,
      coins: async (...args) => ({ ...await io.coins(...args), allowance: takeLimit(TAKE) }),
      receipt: async () => { throw new Error('unseen receipt'); },
    }) });
    const failed = 'Failed · Sent, but not confirmed. Check your wallet before trying again.';
    await screen.findByRole('button', { name: 'Take out item 1' }); await press('Take out item 1');
    await screen.findByText(failed);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take out item 1' }).hasAttribute('disabled')).toBe(false));
    if (again !== 'same') {
      cleanup(); r.client.clear(); resetPendingVaultMovesForTests();
      if (again === 'spelling') wallet.account = account.toLowerCase();
      r.mount(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      await screen.findByRole('button', { name: 'Take out item 1' });
    }
    await press('Take out item 1'); await screen.findByText(failed);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take out item 1' }).hasAttribute('disabled')).toBe(false));
    expect(r.sent).toHaveLength(1);
  });
  it.each(['account', 'network'] as const)('R4 an unanswered approval keeps its waiting line across a wallet %s change', async (change) => {
    let release = () => {}; let entered = false;
    const held = new Promise<void>((done) => { release = done; });
    const r = await burnRig({ wrap: (io) => ({ ...io, request: async (request) => {
      if (request.method === 'eth_sendTransaction' && !entered) { entered = true; await held; }
      return io.request(request);
    } }) });
    await screen.findByRole('button', { name: 'Take out item 1' }); await press('Take out item 1');
    const line = 'Waiting · approve coins in your wallet…'; await screen.findByText(line);
    const chain = wallet.chainId;
    await act(async () => { if (change === 'account') wallet.account = B; else wallet.chainId = 1; await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    await waitFor(() => expect(screen.queryByText(line)).toBeNull());
    await act(async () => { wallet.account = A; wallet.chainId = chain; await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    await screen.findByText(line);
    expect(screen.getByRole('button', { name: 'Take out item 1' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { release(); }); await screen.findByText('Confirmed · #1 is in your wallet');
    expect(r.sent).toHaveLength(2);
  });

  it('R5 the card must keep its record after an older placement read', async()=>{
    let offset=0n;let base=0n;
    const r=await burnRig({wrap:io=>({...io,
      head:async()=>{base=await io.head();return base+offset;},
      counts:async()=>({mined:7n,latest:7n, latestAfter: 7n,pending:7n}),
      coins:async(_a,_f,at)=>({balance:TAKE*100n,allowance:takeLimit(TAKE),block:at??base+offset}),
      item:async(id,at)=>({...await io.item(id,at),...(id===1n&&at===base+1n?{owner:A,onShelf:false,outside:true}:{})}),
      now:async(at)=>1_800_000_000n+12n*((at??base)-base),
      receipt:async()=>{throw Error('receipt omitted');},
    })});
    await screen.findByRole('button',{name:'Take out item 1'});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(false));
    offset=2n;await press('Take out item 1');
    await screen.findByText('Failed · Sent, but not confirmed. Check your wallet before trying again.');
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(false));
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toHaveLength(1);
    offset=1n;await press('Take out item 1');
    await screen.findByText('Failed · Item #1 is no longer in the vault.');
    await waitFor(()=>expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toHaveLength(1));
    offset=2n;await act(async()=>{await r.client.invalidateQueries({queryKey:['v2-vault']});});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(false));
    await press('Take out item 1');
    await screen.findByText('Failed · Sent, but not confirmed. Check your wallet before trying again.');
    expect(r.sent).toHaveLength(1);
  });

  it('R5 an unanswered wallet must keep the run and buttons held after chain expiry until its late answer', async()=>{
    let now=1_800_000_000n;let release=()=>{};let entered=false;let requests=0;
    const held=new Promise<void>(done=>{release=done;});
    const r=await burnRig({wrap:io=>({...io,
      head:async()=>await io.head()+(now>1_800_000_000n?100n:0n),
      now:async()=>now,
      coins:async(...args)=>({...await io.coins(...args),allowance:takeLimit(TAKE)}),
      receipt:async hash=>({transactionHash:hash,blockNumber:await io.head()+100n,blockHash:H(100),status:'reverted'}),
      request:async request=>{if(request.method==='eth_sendTransaction'){entered=true;requests++;await held;}return io.request(request);},
    })});
    await screen.findByRole('button',{name:'Take out item 1'});await press('Take out item 1');
    await screen.findByText('Waiting · Take out #1 in your wallet…');expect(entered).toBe(true);
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toHaveLength(1);
    now+=1201n;
    await act(async()=>{await r.client.invalidateQueries({queryKey:['v2-vault']});});
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toEqual([]);
    expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button',{name:'Take out item 2'}).hasAttribute('disabled')).toBe(true);
    await press('Take out item 2');expect(r.sent).toHaveLength(0);
    expect(screen.getByText('Waiting · Take out #1 in your wallet…')).toBeTruthy();
    await act(async()=>{release();});await screen.findByText('Failed · The vault refused it. Refresh and try again.');
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 2'}).hasAttribute('disabled')).toBe(false));
    expect(requests).toBe(1);expect(r.sent).toHaveLength(1);
    expect(decodeFunctionData({abi:vaultV2Abi,data:required(r.sent[0]).data}).args[2]).toBeLessThan(now);
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toEqual([]);
  });

  it.each(['take', 'return'] as const)('R5 a late %s hash must not restore an expired record while its receipt waits', async (kind) => {
    const sentAt = 1_800_000_000n; const take = kind === 'take';
    let now = sentAt; let releaseWallet = () => {}; let releaseReceipt = () => {}; let requests = 0;
    const walletWait = new Promise<void>((done) => { releaseWallet = done; });
    const receiptWait = new Promise<void>((done) => { releaseReceipt = done; });
    const r = await burnRig({ out: take ? [] : [1n], wrap: (io) => ({ ...io,
      head: async () => await io.head() + (now > sentAt ? 100n : 0n), now: async () => now,
      coins: async (...args) => ({ ...await io.coins(...args), allowance: takeLimit(TAKE) }),
      itemApproved: async () => true,
      request: async (request) => { if (request.method === 'eth_sendTransaction') { requests++; await walletWait; } return io.request(request); },
      receipt: async () => { await receiptWait; throw Error('receipt unreadable'); },
    }) });
    const button = take ? 'Take out item 1' : 'Put back item 1';
    const stored = () => JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]') as unknown;
    await screen.findByRole('button', { name: button }); await press(button);
    await screen.findByText(`Waiting · ${take ? 'Take out' : 'Put back'} #1 in your wallet…`);
    expect(requests).toBe(1); expect(stored()).toHaveLength(1);
    now += 1201n; await act(async () => { await r.client.invalidateQueries({ queryKey: ['v2-vault'] }); });
    expect(stored()).toEqual([]);
    // The old send time cannot prune a resurrected record and hide the fault.
    expect(expireVaultMoves(r.source.manifest.chainId, sentAt)).toEqual([]);
    await act(async () => { releaseWallet(); }); await screen.findByText('Waiting for confirmation…');
    expect(stored()).toEqual([]);
    expect(expireVaultMoves(r.source.manifest.chainId, sentAt)).toEqual([]);
    await press(button); await press('Take out item 2'); expect(requests).toBe(1);
    await act(async () => { releaseReceipt(); });
    await screen.findByText('Failed · Sent, but not confirmed. Check your wallet before trying again.');
    expect(stored()).toEqual([]);
    expect(expireVaultMoves(r.source.manifest.chainId, sentAt)).toEqual([]);
    expect(requests).toBe(1); expect(r.sent).toHaveLength(1);
  });

  it('R5 the card must keep its record after another actor delivers and returns the item', async()=>{
    let offset=0n;let base=0n;
    const r=await burnRig({wrap:io=>({...io,
      head:async()=>{base=await io.head();return base+offset;},
      counts:async()=>({mined:7n,latest:7n, latestAfter: 7n,pending:7n}),
      coins:async(_a,_f,at)=>({balance:TAKE*100n,allowance:takeLimit(TAKE),block:at??base+offset}),
      item:async(id,at)=>({...await io.item(id,at),...(id===1n&&at===base+3n?{owner:A,onShelf:false,outside:true}:{})}),
      now:async(at)=>1_800_000_000n+12n*((at??base)-base),
      receipt:async()=>{throw Error('receipt omitted');},
    })});
    await screen.findByRole('button',{name:'Take out item 1'});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(false));
    offset=2n;await press('Take out item 1');
    await screen.findByText('Failed · Sent, but not confirmed. Check your wallet before trying again.');
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(false));
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toHaveLength(1);
    offset=3n;await press('Take out item 1');
    await screen.findByText('Failed · Item #1 is no longer in the vault.');
    await waitFor(()=>expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY)??'[]')).toHaveLength(1));
    offset=4n;await act(async()=>{await r.client.invalidateQueries({queryKey:['v2-vault']});});
    await waitFor(()=>expect(screen.getByRole('button',{name:'Take out item 1'}).hasAttribute('disabled')).toBe(false));
    await press('Take out item 1');
    await screen.findByText('Failed · Sent, but not confirmed. Check your wallet before trying again.');
    expect(r.sent).toHaveLength(1); // The first request is still valid; all node heads advance.
  });
});

describe('SH-235 the Items card’s details behind its info button (founder, 17 Nov 2026)', () => {
  const infoButton = () => within(panel()).getByRole('button', { name: 'Item details' });
  const infoPanel = () => required(document.getElementById(required(infoButton().getAttribute('aria-controls'))));
  const shown = () => [...infoPanel().children].map((child) => child.textContent);
  const LIMIT_LINE = 'A price that moves more than 1% against you stops the move.';
  const LAST_LINE = 'The last item stays when you take one out.';
  const DRAWS_LINE = 'Items still hidden for draws are not listed; only items that came back can be taken out by number.';
  const WITH_FEES = 'Taking one out costs one item’s share of the ITEM in circulation, plus a 25% fee that is burned. Putting one back pays that share, less a 5% fee that is burned.';
  const GONE = ['Each starts with an approval', 'exactly the coins', 'separate wallet confirmation', 'The price may move by at most', 'or nothing happens', 'The last item always stays in the vault'];
  /** The box with the draw add-on: the record names a tickets contract (role 7). */
  const withTickets = async (): Promise<Partial<V2Snapshot>> => {
    const { body, source } = await publishedItems({ known: { '1': { inside: false, sequence: 2n } } });
    const { record } = parseSnapshotV2(body, source);
    const contracts = [...record.contracts]; contracts[ROLE_V2.tickets] = B;
    return { record: { ...record, contracts } };
  };
  const open = async () => { await press('Item details'); expect(infoPanel().hidden).toBe(false); };

  it('starts closed: one info button beside the heading, its panel hidden right after that row, none of its words on the screen; no disclosure left', async () => {
    const { roles } = await rig({ quote: { pickFeeBps: 2500n, returnFeeBps: 500n } });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const button = infoButton();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toBe('sh-info-button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const heading = within(panel()).getByRole('heading', { level: 2, name: 'Items' });
    expect(button.parentElement).toBe(heading.parentElement);
    expect(heading.parentElement?.className).toBe('sh-box-block-head');
    expect(heading.parentElement?.nextElementSibling).toBe(infoPanel());
    expect(infoPanel().className).toBe('sh-info-panel');
    expect(infoPanel().hidden).toBe(true);
    const seen = visibleText(panel());
    for (const line of [WITH_FEES, LIMIT_LINE, LAST_LINE, roles.vault, roles.collection]) expect(seen).not.toContain(line);
    expect(panel().querySelectorAll('details, summary')).toHaveLength(0);
    expect(within(panel()).getAllByRole('button', { name: 'Item details' })).toHaveLength(1);
  });

  it('a press shows exactly the details, in order: the costs with both fee figures, the price limit, the last item, the two addresses', async () => {
    const { roles } = await rig({ quote: { pickFeeBps: 2500n, returnFeeBps: 500n } });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await open();
    expect(infoButton().getAttribute('aria-expanded')).toBe('true');
    expect(shown()).toEqual([WITH_FEES, LIMIT_LINE, LAST_LINE, roles.vault, roles.collection]);
    expect([...infoPanel().children].slice(-2).map((child) => child.className)).toEqual(['sh-v2-address', 'sh-v2-address']);
    expect(visibleText(panel())).toContain(`${WITH_FEES} ${LIMIT_LINE} ${LAST_LINE} ${roles.vault} ${roles.collection}`);
  });

  it.each([[null, null], [2500n, null], [null, 500n]])('an unread fee figure must hide the cost sentence: %s / %s', async (pickFeeBps, returnFeeBps) => {
    const { roles } = await rig({ quote: { pickFeeBps, returnFeeBps } });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await open();
    expect(shown()).toEqual([LIMIT_LINE, LAST_LINE, roles.vault, roles.collection]);
    expect(infoPanel().textContent).not.toContain('Taking one out costs');
    expect(infoPanel().textContent).not.toContain('Putting one back pays');
  });

  it('with draws: the draws sentence comes after the last item and before the addresses; without them it is not there', async () => {
    const { roles } = await rig({ patch: await withTickets(), quote: { pickFeeBps: 2500n, returnFeeBps: 500n } });
    expect(roles.tickets).toBe(B);
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await open();
    expect(shown()).toEqual([WITH_FEES, LIMIT_LINE, LAST_LINE, DRAWS_LINE, roles.vault, roles.collection]);
    cleanup();
    await rig({ quote: { pickFeeBps: 2500n, returnFeeBps: 500n } });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await open();
    expect(panel().textContent).not.toContain(DRAWS_LINE);
  });

  it('the approval sentence and the two old sentences are nowhere in the card, closed or open (hidden text included)', async () => {
    await rig({ patch: await withTickets() });
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const all = () => panel().textContent ?? '';
    for (const words of GONE) expect(all()).not.toContain(words);
    await open();
    for (const words of GONE) expect(all()).not.toContain(words);
  });

  it('the percentage is LIMIT_BPS, the limit the sends use (100 basis points: 1%)', async () => {
    await rig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    await open();
    expect(shown()[1]).toBe(`A price that moves more than ${formatUnits(LIMIT_BPS, 2)}% against you stops the move.`);
    expect(LIMIT_BPS).toBe(100n);
    expect(shown()[1]).toBe(LIMIT_LINE);
  });

  it('keyboard, as every info button: a second press closes it; Escape on the button or inside the panel closes it and puts focus back on the button; Escape while closed does nothing', async () => {
    await rig();
    await waitFor(() => expect(figure('Take one out')).toBe(t(TAKE)));
    const button = infoButton();
    await open();
    await act(async () => { fireEvent.click(button); });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(infoPanel().hidden).toBe(true);
    // Escape on the button.
    await open();
    await act(async () => { fireEvent.keyDown(button, { key: 'Escape' }); });
    expect(infoPanel().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    // Escape inside the panel.
    await open();
    await act(async () => { fireEvent.keyDown(required(infoPanel().firstElementChild), { key: 'Escape' }); });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(infoPanel().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    // Escape while closed does nothing (and lets the key through to the page).
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    button.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });
});
