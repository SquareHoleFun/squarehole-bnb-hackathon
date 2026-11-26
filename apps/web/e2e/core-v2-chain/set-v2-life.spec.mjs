// SH-EXISTING-NFTS-E08C: the existing-NFTs add-on through the page on the local chain, with the browser test wallet
// and the add-on's real contracts (E-08B deploys its release beside core v2, with an issuer-minted local ERC-721, and
// serves its boxes under /v2/sets/*; the chain suite's stack runs none of E-08B's own set life, so every box here is this
// spec's). Create a set of 40 sparse ids: list file, Create, the first page of 16, a reload in the middle of loading,
// Continue from the chain (no mined step sent again), complete, Revoke. Then that box, filled after its launch window
// with E-08B's local helpers and graduated by a holder through the page: pick 2 named ids and return 1. Then a set box
// whose loading never completes: past the gate's cap anyone closes it, and its loaded items go back to the creator.
// Every send goes through E-08B's executor.
//
// It reads E-08B's local chain description (`needs`, below: `setManifest`, `setRelease.nft`); without the add-on every
// test here skips, so the suite stays green on a stack that has none.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi } from 'viem';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { assertLocalRpc, mineTo, rpc, runLocalStep, waitLocalReceipt } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localClient, recipe } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { afterSetWindow } from '../../../../packages/chain/scripts/lib/set-v2-local-actions.mjs';
import { hookV2Abi } from '../../../../packages/chain/src/core/v2/abi-v2.ts';
import {
  setCoordinatorV2Abi, setFactoryV2Abi, setRegistryV2Abi, setStarterSetLoaderV2Abi, setTokenV2Abi, setVaultV2Abi,
} from '../../../../packages/chain/src/core/set-v2/index.ts';
import { description, followedIndexer } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

const ERC721 = parseAbi([
  'function ownerOf(uint256 id) view returns (address)', 'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)', 'function approve(address to, uint256 id)',
  'function mintBatch(address to, uint256[] ids)',
]);
const MAX = (1n << 256n) - 1n;
/**
 * 40 sparse ids across the full width in a committed order: 1, the largest uint256 but one, and large spread ids (0 and
 * the largest are E-08B's own set life's, already in its boxes).
 */
const IDS = [1n, MAX - 1n, ...Array.from({ length: 38 }, (_, i) => BigInt(i + 1) * 1_000_003n + (BigInt(i + 1) << 200n))];

/**
 * What this spec needs from E-08B's local chain description (.cache/core-v2-local/run/local-core-v2-chain.json, written
 * by packages/chain/scripts/local-core-v2-chain.mjs): the add-on's manifest (`setManifest`, deployLocalSet) and its
 * local ERC-721 (`setRelease.nft`), whose issuer, the deployer account, mints ids to the actor.
 */
const needs = (chain) => {
  if (!chain.setManifest || !chain.setRelease?.nft) return null;
  const manifest = JSON.parse(readFileSync(chain.setManifest, 'utf8'));
  return {
    manifest,
    factory: getAddress(manifest.factory.address),
    registry: getAddress(manifest.registry.address),
    collection: getAddress(chain.setRelease.nft),
    issuer: chain.accounts.deployer,
  };
};

const read = (chain, abi, address, functionName, args = []) => localClient(chain).readContract({ abi, address, functionName, args });
const send = async (chain, to, abi, functionName, args, from = chain.accounts.actor) => {
  await assertLocalRpc(chain.rpcUrl);
  return runLocalStep(chain, `set.${functionName}@${to}`, async () => {
    const hash = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from, to, data: encodeFunctionData({ abi, functionName, args }) }]);
    await waitLocalReceipt(chain.rpcUrl, hash);
    return hash;
  });
};

/** The add-on's boxes as the set registry records them: each box's roles by number. */
async function setBoxes(chain, set) {
  const count = await read(chain, setRegistryV2Abi, set.registry, 'boxCount');
  const boxes = [];
  for (let id = 0n; id < count; id += 1n) {
    const record = await read(chain, setRegistryV2Abi, set.registry, 'recordOf', [id]);
    boxes.push({ id, coordinator: record.contracts[0], token: record.contracts[1], hook: record.contracts[2], vault: record.contracts[3], loader: record.contracts[19] });
  }
  return boxes;
}

/**
 * The browser test wallet for the add-on: the actor's one account, only calls to the add-on's factory, its collection,
 * and the boxes its registry records (refreshed before each send); only createBox may carry value. `decline(name, n)`
 * lets `n` calls of that function through, then refuses the next as a person would (EIP-1193 4001). Navigation must
 * never reach it.
 */
async function setWallet(page, chain, set) {
  // SH-229: the set pages answer only while the indexer follows the chain; an earlier test's backlog is waited out first.
  await followedIndexer(chain);
  const requests = []; const sent = []; const declined = new Map();
  const targets = async () => {
    const allowed = new Map([[set.factory.toLowerCase(), setFactoryV2Abi], [set.collection.toLowerCase(), ERC721]]);
    for (const box of await setBoxes(chain, set)) {
      allowed.set(box.coordinator.toLowerCase(), setCoordinatorV2Abi);
      allowed.set(box.token.toLowerCase(), setTokenV2Abi);
      allowed.set(box.vault.toLowerCase(), setVaultV2Abi);
      allowed.set(box.loader.toLowerCase(), setStarterSetLoaderV2Abi);
    }
    return allowed;
  };
  await page.exposeFunction('setLocalWalletRequest', async ({ method, params = [] }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [chain.accounts.actor];
    if (method === 'eth_chainId') return rpc(chain.rpcUrl, method);
    if (method !== 'eth_sendTransaction') throw new Error(`unsupported test wallet method ${method}`);
    const tx = params[0];
    const allowed = await targets();
    const abi = allowed.get(tx?.to?.toLowerCase() ?? '');
    const valued = BigInt(tx?.value ?? '0') !== 0n;
    if (!tx || tx.from?.toLowerCase() !== chain.accounts.actor.toLowerCase() || !abi || (valued && tx.to.toLowerCase() !== set.factory.toLowerCase())) {
      throw new Error('the set test wallet sends only the add-on’s calls from its one account');
    }
    const action = decodeFunctionData({ abi, data: tx.data }).functionName;
    if (declined.has(action)) {
      const through = declined.get(action);
      if (through === 0) { declined.delete(action); throw new Error('test-wallet-4001: declined in the test wallet'); }
      declined.set(action, through - 1);
    }
    return runLocalStep(chain, `set.${action}@${tx.to}`, async () => {
      const hash = await rpc(chain.rpcUrl, 'eth_sendTransaction', [tx]);
      sent.push({ ...tx, hash, action });
      await waitLocalReceipt(chain.rpcUrl, hash);
      return hash;
    });
  });
  await page.addInitScript(() => {
    const provider = { request: (request) => window.setLocalWalletRequest(request).catch((error) => {
      if (String(error?.message).includes('test-wallet-4001')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      throw error;
    }), on() {}, removeListener() {} };
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '8bd3a0e2-5d0e-4c55-9c62-6a6c1f8f7a11', name: 'Local set test wallet', rdns: 'org.example.set-local', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  return { requests, sent, decline: (name, through = 0) => declined.set(name, through) };
}

async function connect(page) {
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local set test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** The ids are the actor's: the local ERC-721's issuer mints those nobody holds yet, in one batch. */
async function own(chain, set, ids) {
  const missing = [];
  for (const id of ids) {
    const owner = await read(chain, ERC721, set.collection, 'ownerOf', [id]).catch(() => null);
    if (owner === null) missing.push(id);
    else expect(owner.toLowerCase(), `#${id} is not the actor's`).toBe(chain.accounts.actor.toLowerCase());
  }
  if (missing.length > 0) await send(chain, set.collection, ERC721, 'mintBatch', [chain.accounts.actor, missing], set.issuer);
}

/** Fills Basics, Items and Raise through the page and lands on the Overview. */
async function fillFlow(page, set, name, ticker, ids) {
  await page.goto('/create/set-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Ticker' }).fill(ticker);
  await page.locator('#create-set-logo').setInputFiles({ name: 'set.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-set-logo-action')).toHaveText('Change');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('textbox', { name: 'Collection' }).fill(set.collection);
  await page.getByRole('textbox', { name: 'Ids' }).fill(ids.map(String).join('\n'));
  await expect(page.getByText(`${ids.length} ids`)).toBeVisible();
  await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '5%', exact: true }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box of existing NFTs, step 4 of 4: Overview');
}

let chain; let set;
/** The first test's set box (its registry roles), for the second. */
let made = null;
test.beforeAll(() => { chain = description(); set = needs(chain); });

test('a set of 40 sparse ids: list file, Create, one page, a reload mid-loading, Continue from the chain, complete, Revoke', async ({ page }) => {
  test.skip(!set, 'the local chain has no existing-NFTs add-on (E-08B)');
  test.setTimeout(600_000);
  const wallet = await setWallet(page, chain, set);
  await own(chain, set, IDS);
  const before = await read(chain, setRegistryV2Abi, set.registry, 'boxCount');
  await fillFlow(page, set, 'Local Set', 'LSET', IDS);
  // Every parameter and the full list, before anything is sent.
  await expect(page.getByRole('heading', { name: 'List · 40' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Items' }).getByText(set.collection, { exact: false })).toBeVisible();
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);
  // The list file first: its acknowledgement is bound to the set hash.
  await connect(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save list file' }).click();
  const file = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
  expect(file).toMatchObject({ schema: 'squarehole.set-list/1', count: 40, ids: IDS.map(String) });
  // The wallet lets the first page of 16 through and declines the second: loading stops at 16 of 40. Then a reload.
  wallet.decline('load', 1);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-error]')).toHaveText(/Declined in the wallet\./, { timeout: 180_000 });
  const created = async () => (await setBoxes(chain, set))[Number(before)] ?? null;
  const stopped = await created();
  expect(Number((await read(chain, setStarterSetLoaderV2Abi, stopped.loader, 'progress'))[0])).toBe(16);
  await page.reload();
  const connectButton = page.getByRole('button', { name: 'Connect to create' });
  await expect(page.locator('[data-create-status]').or(connectButton)).toBeVisible();
  if (await connectButton.isVisible()) await connect(page);
  await expect(page.locator('[data-create-status]')).toHaveText('Stopped', { timeout: 60_000 });
  const sentBefore = wallet.sent.length;
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Created · trading open', { timeout: 300_000 });
  const box = await created();
  made = box;
  const loads = wallet.sent.filter((tx) => tx.action === 'load').map((tx) => decodeFunctionData({ abi: setStarterSetLoaderV2Abi, data: tx.data }).args[1]);
  expect(loads.flat().map(String), 'every id loaded once, in the committed order').toEqual(IDS.map(String));
  expect(loads.every((page) => page.length <= 16)).toBe(true);
  expect(wallet.sent.filter((tx) => tx.action === 'createBox')).toHaveLength(1);
  expect(wallet.sent.slice(sentBefore).some((tx) => tx.action === 'createBox' || tx.action === 'setApprovalForAll')).toBe(false);
  expect(await read(chain, ERC721, set.collection, 'ownerOf', [IDS[0]])).toBe(getAddress(box.vault));
  await page.getByRole('button', { name: 'Revoke loading approval' }).click();
  await expect(page.locator('[data-revoke-status]')).toHaveText('Loading approval revoked', { timeout: 60_000 });
  expect(await read(chain, ERC721, set.collection, 'isApprovedForAll', [chain.accounts.actor, box.vault])).toBe(false);
  // The box page: its numbers, no wallet request on navigation.
  const requests = wallet.requests.length;
  await page.getByRole('link', { name: 'Open your box' }).click();
  await expect(page.locator('[data-set-state]')).toHaveText('LSET · Open', { timeout: 90_000 });
  expect(wallet.requests).toHaveLength(requests);
  await expect(page.getByRole('button', { name: /^(buy|sell|swap|draw|reveal)/i })).toHaveCount(0);
});

test('the first test’s set box, filled, graduated through the page by a holder: pick 2 named ids, then return 1', async ({ page }) => {
  test.skip(!set || !made, 'needs the first test’s set box');
  test.setTimeout(600_000);
  const box = made;
  // E-08B's local helpers: ordinary buys fill the curve once the box's launch window has passed (its 'fill' recipe).
  // The actor bought all of it, so it holds the T a pick of 2 costs.
  await afterSetWindow({
    effectiveOpenAt: () => read(chain, setCoordinatorV2Abi, box.coordinator, 'effectiveOpenAt'),
    windowSeconds: () => read(chain, hookV2Abi, box.hook, 'WINDOW_SECONDS'),
    mineTo: (at) => mineTo(chain.rpcUrl, at),
    recipe: () => recipe(chain, 2, box.coordinator),
  });
  expect(await read(chain, hookV2Abi, box.hook, 'closed')).toBe(true);
  expect(await read(chain, setCoordinatorV2Abi, box.coordinator, 'graduated')).toBe(false);
  const wallet = await setWallet(page, chain, set);
  // A holder graduates the full box through the page (E-09C: any wallet may; the box page offers it only now).
  await page.goto(`/box/${chain.chainId}/${box.token.toLowerCase()}`);
  const graduate = page.getByRole('region', { name: 'Graduate' });
  await expect(graduate).toBeVisible({ timeout: 90_000 });
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);
  await graduate.getByRole('button', { name: 'Graduate' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local set test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await graduate.getByRole('button', { name: 'Graduate' }).click();
  await expect(page.locator('[data-set-state]')).toHaveText('LSET · Graduated', { timeout: 120_000 });
  expect(await read(chain, setCoordinatorV2Abi, box.coordinator, 'graduated')).toBe(true);
  expect(wallet.sent.map((tx) => tx.action)).toEqual(['graduate']);
  wallet.sent.length = 0;
  const loaded = await read(chain, setVaultV2Abi, box.vault, 'loaded');
  const members = [];
  for (let i = 0n; i < loaded; i += 1n) members.push(await read(chain, setVaultV2Abi, box.vault, 'memberAt', [i]));
  const inside = [];
  for (const id of members) if (!(await read(chain, setVaultV2Abi, box.vault, 'isOutside', [id]))) inside.push(id);
  const [first, second] = inside.slice(-2);
  await page.goto(`/box/${chain.chainId}/${box.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Pick and return' });
  await expect(panel).toBeVisible({ timeout: 90_000 });
  for (const id of [first, second]) {
    await panel.getByRole('textbox', { name: 'Find id' }).fill(String(id));
    await panel.getByRole('button', { name: `#${id}`, exact: true }).click();
  }
  await expect(panel.locator('[data-set-quote]')).toHaveText(/ · at most /);
  // The holder connected to graduate the box and stays connected: the panel offers the pick itself.
  await panel.getByRole('button', { name: 'Pick 2' }).click();
  await expect(panel.locator('[data-set-status]')).toHaveText('Picked 2', { timeout: 120_000 });
  expect(await read(chain, ERC721, set.collection, 'ownerOf', [first])).toBe(getAddress(chain.accounts.actor));
  await panel.getByRole('button', { name: 'Return', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Find id' }).fill(String(first));
  await panel.getByRole('button', { name: `#${first}`, exact: true }).click();
  await expect(panel.locator('[data-set-quote]')).toHaveText(/ · at least /);
  await panel.getByRole('button', { name: 'Return 1' }).click();
  await expect(panel.locator('[data-set-status]')).toHaveText('Returned 1', { timeout: 120_000 });
  expect(await read(chain, ERC721, set.collection, 'ownerOf', [first])).toBe(getAddress(box.vault));
  expect(wallet.sent.map((tx) => tx.action)).toEqual(['approve', 'withdrawBatch', 'approve', 'returnItems']);
});

test('a set box whose loading never completes: past the gate’s cap anyone closes it; its loaded items go back to the creator', async ({ page }) => {
  test.skip(!set, 'the local chain has no existing-NFTs add-on (E-08B)');
  test.setTimeout(600_000);
  const ids = Array.from({ length: 10 }, (_, i) => (7n << 240n) + BigInt(i));
  const wallet = await setWallet(page, chain, set);
  await own(chain, set, ids);
  await fillFlow(page, set, 'Local Fail', 'LFAIL', ids);
  await connect(page);
  await page.getByRole('button', { name: 'Save list file' }).click();
  // Decline the completion: the gate keeps holding with every item loaded.
  wallet.decline('complete');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-error]')).toHaveText(/Declined in the wallet\./, { timeout: 180_000 });
  const box = (await setBoxes(chain, set)).at(-1);
  const openAt = await read(chain, setCoordinatorV2Abi, box.coordinator, 'openAt');
  await mineTo(chain.rpcUrl, openAt + 1_209_600n + 1n);
  await page.goto(`/box/${chain.chainId}/${box.token.toLowerCase()}`);
  await expect(page.locator('[data-set-state]')).toHaveText('LFAIL · Loading 10/10', { timeout: 90_000 });
  await page.getByRole('region', { name: 'Close' }).getByRole('button', { name: 'Close box' }).click();
  await expect(page.locator('[data-set-state]')).toHaveText('LFAIL · Failed', { timeout: 120_000 });
  await page.getByRole('region', { name: 'Back to the creator' }).getByRole('button', { name: 'Send back 10' }).click();
  await expect(page.locator('[data-set-state]')).toHaveText('LFAIL · Failed · all back', { timeout: 120_000 });
  for (const id of ids) expect(await read(chain, ERC721, set.collection, 'ownerOf', [id])).toBe(getAddress(chain.accounts.actor));
  await page.getByRole('region', { name: 'Loading approval' }).getByRole('button', { name: 'Revoke loading approval' }).click();
  await expect.poll(() => read(chain, ERC721, set.collection, 'isApprovedForAll', [chain.accounts.actor, box.vault])).toBe(false);
  expect(wallet.sent.filter((tx) => ['failClosed', 'releaseToCreator'].includes(tx.action)).map((tx) => tx.action)).toEqual(['failClosed', 'releaseToCreator']);
});
