import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, getAddress, zeroAddress } from 'viem';
import { artifact } from '../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { ROOT, TX_GAS, assertLocalRpc, hex, rpc, runLocalStep, waitIndexerFollows, waitLocalReceipt } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localClient, readLocalBox } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { claimPotLine } from './claim-line.mjs';

export const description = () => {
  const chain = JSON.parse(readFileSync(join(ROOT, '.cache/core-v2-local/run/local-core-v2-chain.json'), 'utf8'));
  chain.accounts = Object.fromEntries(Object.entries(chain.accounts).map(([key, address]) => [key, getAddress(address)]));
  chain.boxes = Object.fromEntries(Object.entries(chain.boxes).map(([key, address]) => [key, getAddress(address)]));
  return chain;
};
/**
 * SH-229: a test starts from an indexer that follows the chain. The test before it may have sent hundreds of
 * transactions (a kit's 420 reveals), and on a slow machine the indexer then needs minutes for that backlog; this
 * test's own waits for a new box were never meant to cover it. The time waited is the earlier test's, so the running
 * test gets it on top of its own limit (`info`: the running test's, for a caller outside a test body). A wait of five
 * seconds or more is said in the run's output and kept with the test as an annotation, so that a change in the
 * indexer's speed shows in the runs. The wait ends early when the indexer stops moving (waitIndexerFollows).
 */
const INDEXER_BACKLOG_MS = 900_000;
export async function followedIndexer(chain, info = test.info()) {
  const own = info.timeout;
  info.setTimeout(own + INDEXER_BACKLOG_MS);
  const waited = await waitIndexerFollows(chain, { timeout: INDEXER_BACKLOG_MS });
  info.setTimeout(own + waited);
  if (waited >= 5_000) {
    const line = `waited ${Math.round(waited / 1000)} s for the indexer to follow the chain`;
    info.annotations.push({ type: 'indexer backlog', description: line });
    console.warn(`[indexer] ${line} before: ${info.title.slice(0, 70)}`);
  }
  return waited;
}
/**
 * SH-255 (the full run of 25 November): waits until the local index follows the chain's head now, before a reload loop
 * that waits for the page's settled state (no Stale notice). The limit follows what is waited for: the blocks the
 * index is behind (head less the gateway's /healthz block) at 0.5 blocks a second (the index's measured slow rate on
 * this laptop), plus a minute, capped at five minutes, through shLimit; the running test's own limit grows by it. The
 * wait itself is the suite's (waitIndexerFollows): it ends as soon as the index follows, and fails early when the index
 * stops moving. Returns the milliseconds waited.
 */
export const INDEX_BLOCK_MS = 2_000;
export async function indexCaughtUp(chain, info = test.info()) {
  const head = BigInt(await rpc(chain.rpcUrl, 'eth_blockNumber'));
  let behind = head;
  try {
    const health = await (await fetch(`http://127.0.0.1:${chain.ports.gatewayPort}/healthz`, { signal: AbortSignal.timeout(5_000) })).json();
    if (/^[0-9]+$/.test(String(health?.asOf?.block))) behind = head > BigInt(health.asOf.block) ? head - BigInt(health.asOf.block) : 0n;
  } catch { /* no answer yet: wait as for the whole chain, within the cap */ }
  const limit = shLimit(Math.min(Number(behind) * INDEX_BLOCK_MS + 60_000, 300_000)); // a block count, not an amount
  info.setTimeout(info.timeout + limit);
  return waitIndexerFollows(chain, { timeout: limit });
}

export const boxPath = (chain, token) => `/box/${chain.chainId}/${token.toLowerCase()}`;
export const read = (chain, name, address, functionName, args = [], blockNumber) => localClient(chain).readContract({ abi: artifact(name).abi, address, functionName, args, blockNumber });
export { readLocalBox, formatUnits };

/**
 * TA-22 (`create: true`): the page's own Create may also reach the factory, the listed price coins (their approval) and
 * the roles of boxes the registry records after this wallet was installed (their chunks, seed approval and pull). Only
 * the factory, a new pile box's role 3 (a native pile seed) and a new collection's tickets (a draw's round bounty, TA-50)
 * may receive value. `decline(name)` makes the wallet refuse
 * the next call of that function as a person would (EIP-1193 4001), before anything is sent.
 *
 * SH-192 (`create: true`): for a box that commits a reveal root, Create first saves the box file through the browser's
 * save window, and sends nothing until that write is closed. The test browser has no window a person could answer: its
 * picker ends as if the creator had closed it ("Not saved: the save window was closed. Nothing was sent."). So with
 * `create` the page gets a stand-in for a creator who picks a place: every part is taken and the write is closed, which
 * is what the page counts as a saved file. As the browser's own window it opens only while the press still counts as
 * the person's gesture; asked with no gesture at all, it refuses as the browser does. That is a weak check here: in a
 * Playwright run the test's own reads of the page count as gestures too, so a page that asks late is not caught, only
 * one that asks with no activation whatever. `savedFiles` lists the saved files in order as
 * { name, bytes, sendsAsked }, where `sendsAsked` is how many sends this wallet had been asked for when the write
 * closed (asked, not answered: a send in flight counts).
 *
 * SH-229 (`follow`): the wait that every test starts with (followedIndexer). It needs a running Playwright test, so a
 * unit test of this wallet passes its own.
 */
async function creationTargets(chain, allowed) {
  const [registry, listings] = await Promise.all(['registry', 'listingRegistry'].map((fn) => read(chain, 'BoxFactoryV2', chain.factory, fn)));
  allowed.set(chain.factory.toLowerCase(), { owner: 'factory', abi: artifact('BoxFactoryV2').abi });
  const count = Number(await read(chain, 'ListingRegistry', listings, 'listingCount'));
  for (let id = 0; id < count; id += 1) {
    const listing = await read(chain, 'ListingRegistry', listings, 'listing', [id]);
    if (listing.token !== zeroAddress) allowed.set(listing.token.toLowerCase(), { owner: `listing${id}.coin`, abi: erc20Abi });
  }
  const payable = new Set([chain.factory.toLowerCase()]);
  let seen = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  return {
    payable: (to) => payable.has(to),
    refresh: async () => {
      for (const total = await read(chain, 'BoxRegistryV2', registry, 'boxCount'); seen < total; seen += 1n) {
        const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [seen]);
        allowed.set(coordinator.toLowerCase(), { owner: `new${seen}.coordinator`, abi: artifact('BoxCoordinatorV2').abi });
        const token = await read(chain, 'BoxCoordinatorV2', coordinator, 'token');
        allowed.set(token.toLowerCase(), { owner: `new${seen}.token`, abi: erc20Abi });
        // TA-50: a new collection's tickets (role 7: draw, with its round's bounty; openDraw) and collection (role 4).
        const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]);
        for (const [role, contract] of [[3n, collection === zeroAddress ? 'PileVaultV2' : 'BoxVaultV2'], [4n, 'BoxCollectionV2'], [7n, 'BoxTicketsV2'], [19n, 'StarterSetLoaderV2']]) {
          const address = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [role]);
          if (address === zeroAddress) continue;
          if (!allowed.has(address.toLowerCase())) allowed.set(address.toLowerCase(), { owner: `new${seen}.role${role}`, abi: artifact(contract).abi });
          if ((role === 3n && collection === zeroAddress) || role === 7n) payable.add(address.toLowerCase());
        }
      }
    },
  };
}

/** How many sends a wallet has been asked for: counted when the request arrives, before anything is checked or sent. */
const sendsAsked = (requests) => requests.filter((method) => method === 'eth_sendTransaction').length;

/** No provider ever ships in the app. Only this Playwright context can access these local unlocked accounts. */
export async function testWallet(page, chain, { create = false, follow = followedIndexer } = {}) {
  await assertLocalRpc(chain.rpcUrl);
  await follow(chain);
  const requests = []; const sent = [];
  const allowed = new Map();
  for (const [box, coordinator] of Object.entries(chain.boxes)) {
    const b = await readLocalBox(chain, coordinator);
    const itemLedger = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [16n]);
    // SH-RC7-SITE-INBOX: the box page's public inbox controls (role 8) and launch-tax sweep (role 6) send to these.
    const [inbox, launchRouter] = await Promise.all([8n, 6n].map((role) => read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [role])));
    // SH-TA-33: an item box's collection (role 4) takes the item approval before a put-back.
    const collection = box === 'everyItem' ? await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]) : zeroAddress;
    for (const [address, role, contract] of [[coordinator, 'coordinator', 'BoxCoordinatorV2'],
      [b.token, 'token', 'BoxTokenV2'], [b.holderLedger, 'holderLedger', 'HolderLedgerV2'],
      [b.vault, 'vault', box === 'coinPile' ? 'PileVaultV2' : box === 'shop' ? 'ShopVaultV2' : 'BoxVaultV2'],
      [itemLedger, 'itemLedger', 'ItemLedgerV2'], [inbox, 'inbox', 'BoxRoyaltyRouterV2'], [launchRouter, 'launchRouter', 'BoxLaunchRouterV2'],
      [collection, 'collection', 'BoxCollectionV2']]) {
      if (address && address !== zeroAddress) allowed.set(address.toLowerCase(), {
        owner: chain.addressLabels?.[address.toLowerCase()] ?? `${box}.${role}`, abi: artifact(contract).abi,
      });
    }
  }
  const creation = create ? await creationTargets(chain, allowed) : null;
  const declined = new Set();
  const savedFiles = [];
  if (create) {
    await page.exposeFunction('coreV2BoxFileSaved', (file) => { savedFiles.push({ ...file, sendsAsked: sendsAsked(requests) }); });
    await page.addInitScript(() => {
      window.showSaveFilePicker = async ({ suggestedName }) => {
        // The browser opens its save window only inside a person's gesture; a page that asks later is refused.
        if (!navigator.userActivation?.isActive) throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError');
        return {
          name: suggestedName,
          createWritable: async () => {
            let bytes = 0;
            return {
              write: async (part) => { bytes += new Blob([part]).size; },
              close: async () => { await window.coreV2BoxFileSaved({ name: suggestedName, bytes }); },
              abort: async () => undefined,
            };
          },
        };
      };
    });
  }
  await page.exposeFunction('coreV2LocalWalletRequest', async ({ method, params = [] }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [chain.accounts.actor];
    if (method === 'eth_chainId') return rpc(chain.rpcUrl, method);
    if (method !== 'eth_sendTransaction') throw new Error(`unsupported test wallet method ${method}`);
    await assertLocalRpc(chain.rpcUrl);
    const tx = params[0];
    if (creation && tx && !allowed.has(tx.to?.toLowerCase())) await creation.refresh();
    const valued = BigInt(tx?.value ?? '0') !== 0n;
    if (!tx || tx.from?.toLowerCase() !== chain.accounts.actor.toLowerCase() || !allowed.has(tx.to?.toLowerCase()) || (valued && !creation?.payable(tx.to.toLowerCase()))) {
      throw new Error('test wallet only sends zero-value local box calls from its one account');
    }
    const target = allowed.get(tx.to.toLowerCase());
    let action = tx.data?.slice(0, 10) ?? 'empty calldata';
    try { action = decodeFunctionData({ abi: target.abi, data: tx.data }).functionName; }
    catch { /* Unknown calldata must still produce a named box/role/selector diagnostic. */ }
    if (declined.delete(action)) throw new Error('test-wallet-4001: declined in the test wallet');
    return runLocalStep(chain, `${target.owner}.${action}@${tx.to}`, async () => {
      const hash = await rpc(chain.rpcUrl, method, [tx]);
      sent.push({ ...tx, hash });
      // Diagnose on the Node side before Playwright strips RPC error fields at the browser binding.
      // This covers UI sends too, even if the page handles the rejected request instead of failing the test.
      await waitLocalReceipt(chain.rpcUrl, hash);
      return hash;
    });
  });
  await page.addInitScript(() => {
    // The binding drops error fields; a decline comes back as the person's EIP-1193 refusal (code 4001).
    const provider = { request: request => window.coreV2LocalWalletRequest(request).catch((error) => {
      if (String(error?.message).includes('test-wallet-4001')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      throw error;
    }), on() {}, removeListener() {} };
    // Explicit test actions can use this provider; production navigation must never request it.
    window.coreV2TestWallet = provider;
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'Local v2 test wallet', rdns: 'org.example.core-v2-local', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
  // Do not let an accidental fallback contact a public RPC or gateway. Nothing is fulfilled with a fixture.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, route => route.abort());
  // A contract a test names (an outside collection a page-created shop lists, say): its calls are sent too, diagnosed by name.
  // SH-203: `contract` may also be an ABI for a contract the stack has no artifact of (Multicall3), then with its `owner` name.
  const allow = (address, contract, owner = contract) => allowed.set(address.toLowerCase(), { owner, abi: typeof contract === 'string' ? artifact(contract).abi : contract });
  // SH-203 af2 R2-L3: every send request the page made, accepted or refused (`sent` holds only those the RPC accepted).
  const sendRequests = () => sendsAsked(requests);
  return { requests, sent, sendRequests, savedFiles, decline: (name) => declined.add(name), allow };
}

/** Where a wallet stands right before a press of Create: the box files saved and the sends asked for so far. */
export const saveMark = (wallet) => ({ files: wallet.savedFiles.length, asked: sendsAsked(wallet.requests) });
/**
 * SH-192: the press of Create after `mark` (saveMark, read right before the press) saved exactly one box file with
 * content under the page's own name for it, and that write was closed before the wallet was asked for any send. What
 * the file holds is not read here: the standard suite reads it (e2e/create-v2-boxspec-autosave.spec.ts).
 */
export function expectBoxFileSaved(wallet, mark) {
  const files = wallet.savedFiles.slice(mark.files);
  expect(files.map((file) => file.name), 'one box file per Create press').toEqual([expect.stringMatching(/^[a-z0-9]+-boxspec-v2\.json$/)]);
  expect(files[0].bytes, 'the saved box file has content').toBeGreaterThan(1000);
  expect(files[0].sendsAsked, 'the wallet is asked for no send before the box file is saved').toBe(mark.asked);
}

export async function openBox(page, chain, name, wallet) {
  const before = await readLocalBox(chain, chain.boxes[name]);
  await page.goto(boxPath(chain, before.token));
  await expect(page.locator('.sh-v2-page')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Local ${name === 'holders' ? 'Holders' : name === 'failure' ? 'Failure' : name === 'shop' ? 'Shop' : 'Plain'}`);
  // SH-255 round 3 (D18): the settled page (the picture's header, past its loading heading) before any negative check.
  await expect(page.locator('header.sh-bpic-head')).toBeVisible({ timeout: 60_000 });
  expect(wallet.requests, 'navigation must never touch the wallet').toEqual([]);
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  return readLocalBox(chain, chain.boxes[name]); // Fresh chain state AFTER navigation, never the text fixture.
}

export async function feedCard(chain, token) {
  const origin = `http://127.0.0.1:${chain.ports.gatewayPort}`;
  const target = BigInt(await rpc(chain.rpcUrl, 'eth_blockNumber'));
  let card;
  await expect.poll(async () => {
    const feed = await (await fetch(`${origin}/v2/feed?chain=${chain.chainId}`, { signal: AbortSignal.timeout(5000) })).json();
    card = feed.cards.find(c => c.token.toLowerCase() === token.toLowerCase());
    return card?.verified && !card.stale && BigInt(card.asOf.block) >= target;
  }).toBe(true);
  return card;
}

export async function assertNumbers(page, chain, state) {
  const indexed = await feedCard(chain, state.token);
  const at = await readLocalBox(chain, state.coordinator, BigInt(indexed.asOf.block));
  expect(indexed.graduated).toBe(at.graduated);
  expect(indexed.failed !== null).toBe(at.failed);
  expect(BigInt(indexed.row.record.raise)).toBe(at.raise);
  if (at.failed) {
    expect(BigInt(indexed.closing.pot)).toBe(at.pot);
    expect(BigInt(indexed.closing.tLeft)).toBe(at.left);
    // The exact pot as a visitor reads it: behind Claim details, opened (round 3, D18).
    const claim = page.getByRole('region', { name: 'Failure claim' });
    await openDetails(claim, 'Claim details');
    // The page's line, coin included (round 3b, G1): ETH for the native coin, else the coin's own symbol and decimals.
    const q = indexed.row.record.q;
    const native = /^0x0{40}$/i.test(q);
    const coin = native ? 'ETH' : await localClient(chain).readContract({ address: q, abi: erc20Abi, functionName: 'symbol' });
    const decimals = native ? 18 : Number(await localClient(chain).readContract({ address: q, abi: erc20Abi, functionName: 'decimals' }));
    await expect(claim.getByText(claimPotLine({ pot: at.pot, left: at.left, decimals, coin }))).toBeVisible();
  }
  // SH-255: the recorded raise behind the Raise sheet's (?) (once the Fees card's Fee details).
  expect(await recordedRaise(page)).toContain(`Recorded raise: ${formatUnits(at.raise, 18)}`);
}

/** Opens a closed details by its summary, as a visitor does (a click); one already open stays open. */
export async function openDetails(scope, summary) {
  const details = scope.locator('details', { has: scope.page().getByText(summary, { exact: true }) }).first();
  if (await details.getAttribute('open') === null) await details.getByText(summary, { exact: true }).first().click();
  await expect(details).toHaveAttribute('open', '');
}

/**
 * SH-255: the recorded raise lives behind the box page's Raise sheet (?) (the picture's raise part; once the Fees
 * card's Fee details): opens the sheet and its (?), returns the sheet's text, and shuts both.
 */
export async function recordedRaise(page) {
  // By keyboard, as the picture's own browser spec opens every part: a pointer at the Raise group's middle lands on the
  // price coin's spot, which lies between Raise's two (review job290 finding 11).
  await page.locator('.sh-bpic [data-part="raise"]').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'About the target' }).click();
  const text = await sheet.innerText();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return text;
}

export async function connectClaimWallet(page) {
  await page.getByRole('button', { name: 'Approve coins', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
export async function confirm(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
}

/** Explicit owner action through the browser's test wallet for contract features without a site button yet. */
export async function browserContractCall(page, chain, name, to, functionName, args) {
  const data = encodeFunctionData({ abi: artifact(name).abi, functionName, args });
  const hash = await page.evaluate(tx => window.coreV2TestWallet.request({ method: 'eth_sendTransaction', params: [tx] }),
    { from: chain.accounts.actor, to, data, gas: hex(TX_GAS), value: '0x0' });
  // The wallet already diagnoses send rejection before returning a hash. Guard receipt failures here as well,
  // preserving the mined hash if the receipt waiter throws; never send the transaction again.
  const owner = chain.addressLabels?.[to.toLowerCase()] ?? name;
  return runLocalStep(chain, `${owner}.${functionName}@${to}`, async () => {
    try {
      const receipt = await localClient(chain).waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 100 });
      if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
      return receipt;
    } catch (error) { throw Object.assign(error, { transactionHash: hash }); }
  });
}
export function decoded(name, tx) { return decodeFunctionData({ abi: artifact(name).abi, data: tx.data }); }
