import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, zeroHash } from 'viem';
import { prepareExample } from '../../../../../packages/chain/scripts/create-example-v2.mjs';
import { localClient, readLocalBox } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { writeExampleArt } from '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { artifact, read, call, balance } from './chain.mjs';
import { loadExampleChunks } from './create.mjs';
import { EXAMPLE_ART, ROOT } from './support.mjs';

/** Contract-holder authority: the unlocked owner asks the local Safe double to call; no impersonation. */
export const safeCall = (chain, name, to, functionName, args = [], value = 0n) => call(chain, 'JunkyardSafeDouble', chain.junkyard.safe, 'execute',
  [to, value, encodeFunctionData({ abi: artifact(name).abi, functionName, args })], chain.accounts.actor);

export async function createJunkyard(page, chain, example, wallet, evidence) {
  assert.ok(chain.junkyard, 'local Junkyard fixtures required');
  // The only browser connection is this explicit test click; creation itself uses the chain package.
  await page.goto('/');
  assert.deepEqual(wallet.requests, []);
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Example local wallet' }).click();
  const safe = chain.junkyard.safe;
  const plan = await prepareExample(example, { factory: chain.factory, creator: safe, listingId: chain.junkyard.listingId, collections: chain.junkyard.collections },
    { chainId: String(chain.chainId), client: localClient(chain) });
  const { spec, predicted, starter } = plan;
  assert.equal(spec.raise, BigInt(example.raise.amount), 'local listing matches the example');
  assert.equal(spec.pricing.token.toLowerCase(), chain.junkyard.gold.toLowerCase());
  evidence.art = writeExampleArt(fileURLToPath(EXAMPLE_ART), example.id,
    [{ role: 'logo', sha256: spec.coverSha256, bytes: readFileSync(new URL(example.logo, ROOT)) }]);
  const beforeGold = await balance(chain, spec.pricing.token, safe);
  await safeCall(chain, 'LocalERC20', spec.pricing.token, 'approve', [chain.factory, BigInt(plan.approval.amount)]);
  const receipt = await call(chain, 'JunkyardSafeDouble', safe, 'execute', [plan.transaction.to, BigInt(plan.transaction.value), plan.transaction.data], chain.accounts.actor);
  await safeCall(chain, 'LocalERC20', spec.pricing.token, 'approve', [chain.factory, 0n]);
  assert.equal(beforeGold - await balance(chain, spec.pricing.token, safe), BigInt(plan.approval.amount));
  assert.equal(await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'specHash'), plan.specHash);
  assert.equal((await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'creator')).toLowerCase(), safe.toLowerCase());
  const q = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [spec.pricing.listingId, spec.raise]);
  await loadExampleChunks(chain, spec, predicted.coordinator, safe, q, (...args) => safeCall(chain, ...args));
  let box = await readLocalBox(chain, predicted.coordinator);
  const safeT = await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [safe]);
  const seed = BigInt(example.contents.shop.seedT);
  assert.ok(safeT > seed, 'creator buy funds seed and leaves tokens at Safe');
  await safeCall(chain, 'HolderLedgerV2', box.holderLedger, 'register');
  await safeCall(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, seed]);
  for (const collection of new Set(starter.map(item => item.collection))) await safeCall(chain, 'JunkyardCollection', collection, 'setApprovalForAll', [box.vault, true]);
  const loader = await read(chain, 'BoxCoordinatorV2', box.coordinator, 'starterSetLoader');
  for (let offset = 0; offset < starter.length; offset += 32) {
    const page = starter.slice(offset, offset + 32);
    await safeCall(chain, 'StarterSetLoaderV2', loader, 'load', [page.map(i => i.collection), page.map(i => i.id), page.map(i => i.tier), page.at(-1).nextHash]);
  }
  await safeCall(chain, 'ShopVaultV2', box.vault, 'fundSeed');
  await call(chain, 'StarterSetLoaderV2', loader, 'complete');
  assert.deepEqual(await read(chain, 'StarterSetLoaderV2', loader, 'progress'), [starter.length, zeroHash, true]);
  assert.equal(await read(chain, 'ShopVaultV2', box.vault, 'budgetT'), seed);
  assert.equal(await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [safe]), safeT - seed);
  for (const item of starter) assert.equal((await read(chain, 'JunkyardCollection', item.collection, 'ownerOf', [item.id])).toLowerCase(), box.vault.toLowerCase());
  for (const collection of new Set(starter.map(item => item.collection))) await safeCall(chain, 'JunkyardCollection', collection, 'setApprovalForAll', [box.vault, false]);
  await safeCall(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, 0n]);
  box = await readLocalBox(chain, predicted.coordinator); assert.equal(box.gateOpen, true);
  evidence.creation = { path: 'registry → chain prepareExample → local contract-holder createBox', specHash: plan.specHash, coordinator: box.coordinator,
    token: box.token, transaction: receipt.transactionHash, creator: safe, creatorBuyP: spec.creatorBuy, seedT: seed, starterCount: starter.length,
    ceilingPreset: example.fees.sellers.ceilingPreset, custody: chain.junkyard.custody };
  return { ...box, spec, p: spec.pricing.token, decimals: 18, starter, creator: safe };
}

/** F127: only the registered Safe can claim its own gold; settling a batch never sends it automatically. */
export async function claimSafeGold(chain, box, batch, evidence) {
  const safe = chain.junkyard.safe;
  const quote = await read(chain, 'HolderLedgerV2', box.holderLedger, 'claimable', [batch, safe]);
  assert.ok(quote > 0n, 'registered creator must earn a real holder credit');
  const before = await balance(chain, box.p, safe);
  const receipt = await safeCall(chain, 'HolderLedgerV2', box.holderLedger, 'claim', [batch, safe]);
  assert.equal(await balance(chain, box.p, safe) - before, quote);
  assert.equal(await read(chain, 'HolderLedgerV2', box.holderLedger, 'claimable', [batch, safe]), 0n);
  evidence.safeHolderClaim = { batch, quote, hash: receipt.transactionHash, capEnforcement: 'operator-policy; no on-chain humble cap in this release' };
}
