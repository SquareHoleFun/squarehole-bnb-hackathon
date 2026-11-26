import { expect, test } from '@playwright/test';
import { localClient } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { description, testWallet, boxPath, read, readLocalBox, browserContractCall } from './helpers.mjs';

// The local life creates, loads and graduates these boxes before browser startup.
// Creation failures are actionable failures; these scenarios must never silently skip.
test('M3-32 every-item: owner claims the item credit from a real graduated box', async ({ page }) => {
  const chain = description(); const wallet = await testWallet(page, chain);
  const coordinator = chain.boxes.everyItem;
  const b = await readLocalBox(chain, coordinator);
  const ledger = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [16n]);
  const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'collection');
  const id = 1n; // M3 seed recipe picks open-art id 1 to the actor before collecting fees and sync(32).
  await page.goto(boxPath(chain, b.token));
  await expect(page.locator('.sh-v2-page')).toContainText('To items');
  expect(wallet.requests).toEqual([]);
  expect(await read(chain, 'BoxCoordinatorV2', coordinator, 'graduated')).toBe(true);
  expect(await read(chain, 'BoxCollectionV2', collection, 'ownerOf', [id])).toBe(chain.accounts.actor);
  const [outside, stash] = await read(chain, 'ItemLedgerV2', ledger, 'itemCredit', [id]);
  expect(outside + stash).toBeGreaterThan(0n);
  const before = await localClient(chain).getBalance({ address: chain.accounts.actor });
  const receipt = await browserContractCall(page, chain, 'ItemLedgerV2', ledger, 'claim', [[id], chain.accounts.actor]);
  const [afterOutside, afterStash] = await read(chain, 'ItemLedgerV2', ledger, 'itemCredit', [id]);
  expect(afterOutside + afterStash).toBe(0n);
  const after = await localClient(chain).getBalance({ address: chain.accounts.actor });
  expect(after + receipt.gasUsed * receipt.effectiveGasPrice - before).toBe(outside + stash);
});

test('M3-32 coin pile: approved T burns and exactly the quoted native seed reaches its owner', async ({ page }) => {
  const chain = description(); const wallet = await testWallet(page, chain);
  const b = await readLocalBox(chain, chain.boxes.coinPile);
  await page.goto(boxPath(chain, b.token));
  // SH-255: the phase in the picture's header (the old header's state band said Graduated; its chip row now does).
  await expect(page.locator('header.sh-bpic-head .sh-bpic-phase')).toHaveText('Graduated');
  expect(wallet.requests).toEqual([]);
  expect(await read(chain, 'PileVaultV2', b.vault, 'asset')).toBe('0x0000000000000000000000000000000000000000');
  const amount = b.actorT / 4n;
  const quote = await read(chain, 'PileVaultV2', b.vault, 'quoteRedeem', [amount]);
  expect(quote).toBeGreaterThan(0n);
  await browserContractCall(page, chain, 'BoxTokenV2', b.token, 'approve', [b.vault, amount]);
  const before = await localClient(chain).getBalance({ address: chain.accounts.actor });
  const pileBefore = await localClient(chain).getBalance({ address: b.vault });
  const receipt = await browserContractCall(page, chain, 'PileVaultV2', b.vault, 'redeem', [amount, quote, chain.accounts.actor]);
  const after = await readLocalBox(chain, b.coordinator);
  expect(after.supply + amount).toBe(b.supply); expect(after.actorT + amount).toBe(b.actorT);
  expect(await localClient(chain).getBalance({ address: b.vault })).toBe(pileBefore - quote);
  expect((await localClient(chain).getBalance({ address: chain.accounts.actor })) + receipt.gasUsed * receipt.effectiveGasPrice - before).toBe(quote);
});
