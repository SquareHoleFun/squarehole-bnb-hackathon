import { linkSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { decodeAbiParameters, encodeAbiParameters, formatUnits, getCreate2Address, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
import { readLocalBox } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { sha256Hex, writeExampleArt } from '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { boxLeaf, buildBoxTree } from '../../../../../packages/artwork/src/box-commitment.ts';
import { ITEMS_INSIDE_POLICIES } from '../../../../../packages/box-spec/examples/v2/registry.mjs';
import { artifact, read, call as callLocal } from './chain.mjs';
import { EXAMPLE_ART, ROOT, chunkChain } from './support.mjs';

const CHOICE = { keep: [1, 2], burn: [2, 1], grow: [1, 4], holders: [1, 6], items: [1, 8], pile: [1, 7], shop: [2, 7], eat: [1, 1], 'holders-t': [2, 6], 'items-t': [2, 8] };
// The Fees step's buttons. Eating names the price coin: the local listings record no checked burn, so it locks (FE12).
const LABEL = { keep: 'Keep', grow: 'Grow the pool', holders: 'To holders', items: 'To items', pile: 'To the pile', shop: 'Into the shop', 'holders-t': 'To holders', 'items-t': 'To items' };
const labelOf = (example, choice) => (choice === 'burn' ? `Buy back and burn ${example.ticker}` : choice === 'eat' ? `Lock ${example.priceCoin.symbol}` : LABEL[choice]);
/** The Fees step's in-vault buttons (recipes.ts INSIDE_LABEL): Depth, v2.1 step 5, is Grow the pool. */
const INSIDE_LABEL = { keep: 'Keep', depth: 'Grow the pool' };
/** Each choice's exact destination parameters: an items side's in-vault rule, a holders side's currency (P 1, T 2). */
const destParamsOf = pick => pick.choice === 'shop' ? uint8(Number(pick.ceilingPreset)) : pick.choice === 'items' || pick.choice === 'items-t' ? uint8(ITEMS_INSIDE_POLICIES[pick.inside])
  : pick.choice === 'holders' ? uint8(1) : pick.choice === 'holders-t' ? uint8(2) : '0x';
const eqAddress = (a, b) => expect(a.toLowerCase()).toBe(b.toLowerCase());
const uint8 = n => encodeAbiParameters([{ type: 'uint8' }], [n]);

/** Verify what the real form encoded, before funding or sending. Never replace fields in the downloaded spec. */
export function checkSpec(example, spec, owner) {
  expect(spec.format).toBe(2); expect(spec.version).toBe(2);
  expect(spec.tokenName).toBe(example.name); expect(spec.tokenSymbol).toBe(example.ticker);
  expect(BigInt(spec.n)).toBe(BigInt(example.contents.size));
  expect(spec.raise).toBe(BigInt(example.raise.amount));
  expect(BigInt(spec.deadlineDays)).toBe(BigInt(example.deadline.days));
  expect(spec.creatorBuy).toBe(0n); expect(BigInt(spec.openAt)).toBe(0n);
  expect(spec.boxType).toBe({ collection: 1, token: 3, pile: 5 }[example.contents.kind]);
  expect(BigInt(spec.pickFeeBps)).toBe(BigInt(example.contents.pickFeeBps));
  if (example.contents.kind === 'collection') {
    expect(spec.artMode).toBe(example.contents.art.mode === 'open' ? 1 : 2);
    expect(spec.metadataTable).not.toBe('0x'); expect(spec.revealRoot).not.toBe(zeroHash);
  }
  for (const side of ['buyers', 'sellers']) {
    const wanted = example.fees[side]; const actual = spec[side];
    expect([actual.a.leg, actual.a.dest]).toEqual(CHOICE[wanted.choice]);
    expect(actual.split).toBe(1); expect(actual.a.legParams).toBe('0x');
    expect(actual.a.destParams).toBe(destParamsOf(wanted));
  }
  if (Object.values(example.fees).some(s => s.choice === 'keep') || example.royalties.bps !== '0') eqAddress(spec.creatorFeeRecipient, owner);
  const royalty = spec.addOns.find(a => a.id === 4);
  if (example.royalties.bps === '0') expect(royalty).toBeUndefined();
  else {
    const [bps, destination] = decodeAbiParameters([{ type: 'uint16' }, { type: 'uint8' }], royalty.params);
    expect(BigInt(bps)).toBe(BigInt(example.royalties.bps));
    expect(destination).toBe(1); // R53 G-J: fee handling, the only destination (F138)
  }
}

async function download(page, label) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const stream = await (await pending).createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function form(page, example, wallet) {
  await page.goto('/create/v2-basics');
  expect(wallet.requests).toEqual([]);
  await page.locator(`[data-template="${example.template.id}"]`).click();
  await expect(page.locator(`[data-template="${example.template.id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('radio', { name: new RegExp(`^${example.priceCoin.symbol}\\b`) }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(example.name);
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill(example.ticker);
  await page.locator('#create-logo').setInputFiles(new URL(example.logo, ROOT).pathname);
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next();
  await page.getByRole('radio', { name: example.contents.kind === 'collection' ? /^New collection/ : /^Token/ }).check();
  if (example.contents.kind === 'collection') {
    // Every item is the row's art source. Hard links in a fresh folder, passed as paths: a kit cover repeated 404 or 500
    // times is past Playwright's 50 MB in-memory upload limit, and links cost no disk.
    const source = fileURLToPath(new URL(example.contents.art.source, ROOT));
    mkdirSync(fileURLToPath(new URL('.cache/examples-e2e/', ROOT)), { recursive: true });
    const items = mkdtempSync(fileURLToPath(new URL(`.cache/examples-e2e/items-${example.id}-`, ROOT)));
    const files = [];
    for (let id = 1n; id <= BigInt(example.contents.size); id++) {
      const path = join(items, `${id}.png`);
      linkSync(source, path);
      files.push(path);
    }
    await page.getByLabel('Images + traits').setInputFiles(files);
    await expect(page.getByRole('button', { name: 'Change art', exact: true })).toBeVisible();
    await page.locator('#create-collection-cover').setInputFiles(new URL(example.contents.art.source, ROOT).pathname);
    await expect(page.locator('#create-collection-cover-action')).toHaveText('Change');
    await page.getByRole('radio', { name: example.contents.art.mode === 'open' ? 'Open' : 'Hidden until drawn', exact: true }).check();
    await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true }).check();
    const royalty = page.locator('#create-royalty');
    await royalty.getByRole('radio', { name: example.royalties.bps === '0' ? 'Off' : '2.5%', exact: true }).check();
    await expect(page.getByRole('group', { name: 'Royalty to', exact: true })).toHaveCount(0);
    await expect(page.locator('.sh-newbox-problems')).toHaveCount(0);
  } else if (example.contents.kind === 'pile') {
    await page.getByRole('group', { name: 'Seed coin', exact: true }).getByRole('radio', { name: example.contents.seed.symbol, exact: true }).check();
    await page.getByRole('textbox', { name: `Seed · ${example.contents.seed.symbol}` }).fill(formatUnits(BigInt(example.contents.seed.amount), example.contents.seed.symbol === 'ETH' ? 18 : 6));
    if (example.contents.leaveBehindBps) await page.getByRole('group', { name: 'Leave behind', exact: true }).getByRole('radio', { name: example.contents.leaveBehindBps === '500' ? '5%' : '0%', exact: true }).check();
  }
  await next();
  for (const side of ['buyers', 'sellers']) {
    const group = page.locator(`#create-v2-${side}`); const pick = example.fees[side];
    await group.getByRole('button', { name: labelOf(example, pick.choice), exact: true }).click();
    // v2.1 step 2: holders or items claim the box token, the second option next to the price coin.
    if (pick.choice.endsWith('-t')) await group.getByRole('button', { name: `Claimed in ${example.ticker}`, exact: true }).click();
    if (pick.inside) await group.getByRole('button', { name: `${pick.inside === 'burn' ? labelOf(example, 'burn') : INSIDE_LABEL[pick.inside]} in the vault`, exact: true }).click();
  }
  await next();
  await expect(page.locator('main')).toContainText(`${formatUnits(BigInt(example.raise.amount), example.priceCoin.decimals === '6' ? 6 : 18)} ${example.priceCoin.symbol}`);
  await page.getByRole('radio', { name: new RegExp(`^${example.deadline.days} days$`) }).check();
  await next();
  await page.getByRole('radio', { name: /^Now/ }).check();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  expect(wallet.requests).toEqual([]);
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Example local wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return download(page, 'Download BoxSpec');
}

/**
 * The pictures the spec commits, read (never written) from the page's draft: the browser re-encodes the logo and a
 * collection's cover, so these bytes exist only there. Items are hashed as uploaded: every numbered item is the
 * recipe's one source file (each reveal entry is checked against it below). Nothing else is committed: no banner or
 * teasers (add-on 6).
 */
export async function committedArt(page, example, spec) {
  const draft = await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    const { cover, collectionCover } = currentDraft();
    return { logo: cover?.data ?? null, collectionCover: collectionCover?.data ?? null };
  });
  const bytes = (data, role) => {
    expect(typeof data, `the draft keeps the processed ${role}`).toBe('string');
    const decoded = Buffer.from(data, 'base64');
    expect(decoded.toString('base64'), `the ${role} is plain base64`).toBe(data);
    return decoded;
  };
  expect(spec.addOns.some(addOn => addOn.id === 6), 'no banner or teasers are committed').toBe(false);
  const pictures = [{ role: 'logo', sha256: spec.coverSha256, bytes: bytes(draft.logo, 'logo') }];
  if (example.contents.kind !== 'collection') {
    expect(spec.collectionCoverSha256).toBe(zeroHash);
    return pictures;
  }
  pictures.push({ role: 'collection cover', sha256: spec.collectionCoverSha256, bytes: bytes(draft.collectionCover, 'collection cover') });
  const item = readFileSync(new URL(example.contents.art.source, ROOT));
  pictures.push({ role: 'item', sha256: sha256Hex(item), bytes: item });
  return pictures;
}

async function salts(chain, spec) {
  const limit = await read(chain, 'BoxFactoryV2', chain.factory, 'tokenAddressLimit', [spec.pricing.token]);
  for (let salt = 0n; salt < 4096n; salt++) {
    const cs = toHex(salt, { size: 32 });
    const [coordinator, token, initHash] = await read(chain, 'BoxFactoryV2', chain.factory, 'predictBox', [chain.accounts.actor, spec, cs]);
    if (BigInt(token) <= BigInt(spec.pricing.token) || BigInt(token) >= BigInt(limit)) continue;
    for (let hookSalt = 0n; hookSalt < 1_000_000n; hookSalt++) {
      const hs = toHex(hookSalt, { size: 32 });
      const hook = getCreate2Address({ from: coordinator, salt: hs, bytecodeHash: initHash });
      if ((BigInt(hook) & 0x3fffn) === 0x2ae0n && BigInt(hook) >> 152n !== 0x91n) return { cs, hs, coordinator, token, hook };
    }
    throw new Error('hook salt search exhausted');
  }
  throw new Error('coordinator salt search exhausted');
}

export async function createExample(page, chain, example, wallet, evidence) {
  if (example.contents.kind === 'shop' && example.id === 'junkyard') {
    const { createJunkyard } = await import('./junkyard-create.mjs');
    return createJunkyard(page, chain, example, wallet, evidence);
  }
  if (example.contents.kind === 'shop') {
    // Every other shop row is a one-collection shop with no curator (one-collection-shop.mjs refuses any other shape).
    const { createOneCollectionShop } = await import('./one-collection-shop.mjs');
    return createOneCollectionShop(page, chain, example, wallet, evidence);
  }
  const file = await form(page, example, wallet);
  expect(file.demo).not.toBe(true); expect(file.format).toBe('squarehole.boxspec/2');
  expect(keccak256(file.encoded)).toBe(file.specHash);
  const specAbi = artifact('BoxFactoryV2').abi.find(entry => entry.type === 'function' && entry.name === 'createBox').inputs[0];
  const [spec] = decodeAbiParameters([specAbi], file.encoded);
  checkSpec(example, spec, chain.accounts.actor);
  // Served by the example stack's art gateway before the box exists, so the indexer's first art check can pass.
  const art = await committedArt(page, example, spec);
  evidence.art = writeExampleArt(fileURLToPath(EXAMPLE_ART), example.id, art);
  const listings = await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry');
  const listing = await read(chain, 'ListingRegistry', listings, 'listing', [spec.pricing.listingId]);
  eqAddress(listing.token, spec.pricing.token); expect(listing.raise).toBe(spec.raise);
  expect(BigInt(listing.decimals)).toBe(BigInt(example.priceCoin.decimals));
  const p = spec.pricing.token;
  if (p !== zeroAddress) for (const actor of [chain.accounts.actor, chain.accounts.backup]) {
    await callLocal(chain, 'LocalPriceCoin', p, 'mint', [actor, spec.raise * 10n], chain.accounts.deployer);
  }
  const q = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [spec.pricing.listingId, spec.raise]);
  const predicted = await salts(chain, spec);
  const payment = q.bootstrapQ + spec.creatorBuy;
  if (p !== zeroAddress) await wallet.call('LocalERC20', p, 'approve', [chain.factory, payment]);
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const count = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  const receipt = await wallet.call('BoxFactoryV2', chain.factory, 'createBox', [spec, predicted.cs, predicted.hs], p === zeroAddress ? payment : 0n, 16_777_216n);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(count + 1n);
  expect(await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'specHash')).toBe(file.specHash);
  if (p !== zeroAddress) await wallet.call('LocalERC20', p, 'approve', [chain.factory, 0n]);
  await loadExampleChunks(chain, spec, predicted.coordinator, chain.accounts.actor, q, wallet.call);
  let box = await readLocalBox(chain, predicted.coordinator);
  if (example.contents.kind === 'pile') {
    const [asset, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], spec.contentsParams);
    eqAddress(asset, example.contents.seed.symbol === 'ETH' ? zeroAddress : chain.usdc); expect(amount).toBe(BigInt(example.contents.seed.amount));
    if (asset !== zeroAddress) await wallet.call('LocalERC20', asset, 'approve', [box.vault, amount]);
    await wallet.call('PileVaultV2', box.vault, 'loadSeed', [], asset === zeroAddress ? amount : 0n);
  }
  if (example.contents.kind === 'collection') {
    // Read-only extraction of the creator's actual upload commitment; no draft writes or synthetic chain data.
    const reveal = await page.evaluate(async () => {
      const { currentDraft } = await import('/src/features/create/draft.ts');
      const { commitArt, revealFile } = await import('/src/features/create/create-model.ts');
      const { art, form } = currentDraft();
      return JSON.parse(revealFile({ collectionName: form.name, collectionSymbol: form.ticker }, art, commitArt(art, form.artMode)).text);
    });
    const entries = reveal.items.map(item => ({ ...item, id: Number(item.id), traitsPacked: BigInt(item.traitsPacked) }));
    const served = art.find(picture => picture.role === 'item').sha256;
    expect(entries.length).toBe(Number(example.contents.size));
    for (const entry of entries) {
      expect(entry.imageSha256, `item ${entry.id} commits the served item picture`).toBe(served);
      expect([entry.avatarSha256, entry.modelSha256]).toEqual([zeroHash, zeroHash]);
    }
    const tree = buildBoxTree(entries.map(entry => boxLeaf(entry, entries.length)), entries.length);
    expect(tree.root).toBe(spec.revealRoot);
    const collection = await read(chain, 'BoxCoordinatorV2', box.coordinator, 'collection');
    const entry = entries[0];
    await wallet.call('BoxCollectionV2', collection, 'reveal', [BigInt(entry.id), entry.traitsPacked, entry.imageSha256, entry.avatarSha256, entry.modelSha256, entry.salt, tree.proof(entry.id)]);
  }
  box = await readLocalBox(chain, predicted.coordinator);
  expect(box.gateOpen).toBe(true); eqAddress(box.token, predicted.token);
  evidence.creation = { path: 'site form → downloaded BoxSpec → explicit browser wallet createBox (IR-1)', specHash: file.specHash,
    coordinator: box.coordinator, token: box.token, transaction: receipt.transactionHash, block: receipt.blockNumber };
  return { ...box, spec, p, decimals: listing.decimals };
}

/** Load the planner-committed text/table chunks for either an EOA or a contract creator. */
export async function loadExampleChunks(chain, spec, coordinator, creator, q, invoke) {
  const planner = await read(chain, 'BoxFactoryV2', chain.factory, 'planner');
  const parts = await read(chain, 'BoxFactoryV2Planner', planner, 'parts');
  // Read the real contract's texts encoding; the frontend plan labels it provisional at this pin. Texts depend on the
  // spec alone and no part arguments are built (no nonces); the context still carries the planner's own values
  // (BoxFactoryV2Planner: receiverImplementation is the release's receiver, implementation role 5).
  const empty = { roles: Array(24).fill(zeroAddress), q, boxId: 0n, registry: zeroAddress, listingRegistry: zeroAddress,
    weth: zeroAddress, randomness: zeroAddress, sqrtP1: 0n, nonces: '0x', creator,
    receiverImplementation: await read(chain, 'BoxFactoryV2', chain.factory, 'implementation', [5n]) };
  const context = artifact('BoxFactoryV2Parts').abi.find(entry => entry.type === 'function' && entry.name === 'partArgs').inputs[0];
  expect(Object.keys(empty).sort(), 'partArgs context fields (a new field needs its planner value here)')
    .toEqual(context.components.map(field => field.name).sort());
  const [, texts] = await read(chain, 'BoxFactoryV2Parts', parts, 'partArgs', [empty, spec]);
  for (const [part, bytes] of [[1, spec.metadataTable], [2, texts]]) {
    const chunks = chunkChain(bytes, 8192);
    const [root, length] = await read(chain, 'BoxCoordinatorV2', coordinator, 'chunkRoot', [part]);
    expect(root).toBe(chunks.root); expect(length).toBe(BigInt((bytes.length - 2) / 2));
    for (const chunk of chunks.chunks) await invoke('BoxCoordinatorV2', coordinator, 'loadChunk', [part, chunk.data, chunk.nextHash]);
  }
}
