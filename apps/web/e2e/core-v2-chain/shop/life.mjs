/**
 * The chain-backed shop and fee lives' shared steps (SH-V21-FE13, SH-V21-FE14): reads and node-side sends on the local
 * anvil (unlocked accounts only), the factory's salts, the BoxSpec download, and the page at 1440 px and 375 px (nothing
 * past an edge, no sideways scroll; with SH_EVIDENCE_SCREENSHOTS=1 a picture in SH_EVIDENCE_OUT, outside the
 * repository by default). No TypeScript import: the specs load it as they are.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { encodeFunctionData, getCreate2Address, toHex } from 'viem';
import { artifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { assertLocalRpc, hex, rpc, waitLocalReceipt } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localClient } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';

export const E18 = 10n ** 18n;
export const read = (chain, name, address, functionName, args = [], blockNumber) => localClient(chain).readContract({ abi: artifact(name).abi, address, functionName, args, blockNumber });
export async function send(chain, from, to, data, value = 0n, gas = 15_000_000n) {
  await assertLocalRpc(chain.rpcUrl);
  const hash = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from, ...(to ? { to } : {}), data, value: hex(value), gas: hex(gas) }]);
  return waitLocalReceipt(chain.rpcUrl, hash);
}
export const call = (chain, from, name, to, functionName, args = [], value = 0n, gas) => send(chain, from, to, encodeFunctionData({ abi: artifact(name).abi, functionName, args }), value, gas);
export const boxPath = (chain, token) => `/box/${chain.chainId}/${token.toLowerCase()}`;
/** The page names a collection by its own name with its address beside it. */
export const labelOf = (name, address) => `${name} · ${address.slice(0, 6)}…${address.slice(-4)}`;
const width = (viewport) => (viewport.width === 375 ? '375' : 'desktop');
/**
 * The page at 1440 px and at 375 px: at each width nothing in it reaches past its own edge (no clipped button or
 * amount), and with SH_EVIDENCE_SCREENSHOTS=1 its picture, the sticky bars kept in the flow for a full-page one.
 */
export async function shots(page, name, target = null) {
  const before = page.viewportSize();
  const pictures = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
  const out = process.env.SH_EVIDENCE_OUT ?? join(tmpdir(), 'sh-v21-fe13-shots');
  if (pictures) mkdirSync(out, { recursive: true });
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const scope = target ? target() : page.locator('main');
    const past = await scope.evaluate((root) => {
      const edge = root.getBoundingClientRect().right;
      return Array.from(root.querySelectorAll('button, dd, p, li, label, input'))
        .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > edge + 1).map((el) => (el.textContent || el.getAttribute('aria-label') || el.tagName).slice(0, 60));
    });
    expect(past, `${name} at ${viewport.width} px: nothing past its edge`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${name} at ${viewport.width} px: no sideways scroll`).toBeLessThanOrEqual(0);
    if (!pictures) continue;
    const path = join(out, `${name}-${width(viewport)}.png`);
    if (target) await target().screenshot({ path, scale: 'css' });
    else await page.screenshot({ path, fullPage: true, scale: 'css' });
  }
  await style.evaluate((node) => node.remove());
  if (before) await page.setViewportSize(before);
}
export async function download(page, label) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const stream = await (await pending).createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** The salts the factory needs: T sorts above the price coin and below its limit; the hook carries the v4 flags. */
export async function salts(chain, spec) {
  const limit = await read(chain, 'BoxFactoryV2', chain.factory, 'tokenAddressLimit', [spec.pricing.token]);
  for (let salt = 0n; salt < 4096n; salt++) {
    const cs = toHex(salt, { size: 32 });
    const [coordinator, token, initHash] = await read(chain, 'BoxFactoryV2', chain.factory, 'predictBox', [chain.accounts.actor, spec, cs]);
    if (BigInt(token) <= BigInt(spec.pricing.token) || BigInt(token) >= BigInt(limit)) continue;
    for (let hookSalt = 0n; hookSalt < 1_000_000n; hookSalt++) {
      const hs = toHex(hookSalt, { size: 32 });
      const hook = getCreate2Address({ from: coordinator, salt: hs, bytecodeHash: initHash });
      if ((BigInt(hook) & 0x3fffn) === 0x2ae0n && BigInt(hook) >> 152n !== 0x91n) return { cs, hs, coordinator, token };
    }
    throw new Error('hook salt search exhausted');
  }
  throw new Error('coordinator salt search exhausted');
}
export const figure = (scope, label) => scope.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
