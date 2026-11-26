import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Abi, type Address } from 'viem';
import { formatBps, toDecimalString } from '../src/lib/amounts';

// READ-ONLY against the real BSC Testnet, with the page's own addresses file (public/addresses.json, written by
// scripts/make-addresses.mjs from the entry's deployment files) and its own read endpoints. No wallet, nothing sent.
// Run with REAL_CHAIN=1 (scripts/real-read.sh).
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-265');
const addresses = JSON.parse(fs.readFileSync(path.join(here, '../public/addresses.json'), 'utf8')) as {
  rpcUrls: string[];
  flap: { sales: { launcher: Address }[]; tokenQuote: { sales: { launcher: Address }[] } };
  openfour: { tokens: { token: Address; kind: 'preset' | 'tax' | 'tax-rules'; pile: Address; taxVaultClone?: Address }[] };
};
const launcherAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/CurveLauncher.json'), 'utf8')) as Abi;
const rulesTaxVaultAbi = JSON.parse(fs.readFileSync(path.join(here, '../../openfour/abi/RulesTaxVault.json'), 'utf8')) as Abi;
const pileAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/PileVault.json'), 'utf8')) as Abi;
const chain = createPublicClient({ transport: http(addresses.rpcUrls[0]) });
const read = <T,>(address: Address, abi: Abi, functionName: string) => chain.readContract({ address, abi, functionName }) as Promise<T>;

test.skip(process.env.REAL_CHAIN !== '1', 'reads the real chain: run with REAL_CHAIN=1');

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('the real first sale: the page shows the chain’s pile, paid out and circulating supply exactly', async ({ page }) => {
  const launcher = addresses.flap.sales[0]!.launcher;
  const [, , pileVault] = await read<readonly [Address, Address, Address]>(launcher, launcherAbi, 'launchInfo');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/');
  await expect(page.getByTestId('sale-line').first()).toContainText('Launched', { timeout: 60_000 });
  await expect(page.getByTestId('rail-openfour')).toHaveCount(1);
  // Both factories' sales and both OpenFour launches are listed (their events read in windows from the deploy
  // block), and once the page has settled nothing still says "Reading…" and no read error is shown.
  const listed = async () => (await page.getByTestId('sale-line').evaluateAll((as) => as.map((x) => (x.getAttribute('href') ?? '').toLowerCase()))).join(' ');
  await expect.poll(listed, { timeout: 90_000 }).toContain(addresses.flap.sales[0]!.launcher.toLowerCase());
  await expect.poll(listed, { timeout: 90_000 }).toContain(addresses.flap.tokenQuote.sales[0]!.launcher.toLowerCase());
  await expect(page.getByTestId('four-line')).toHaveCount(addresses.openfour.tokens.length, { timeout: 90_000 });
  await expect(page.getByText('Reading…')).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByTestId('launches-error')).toHaveCount(0);
  console.log(`REAL HOME sales listed ${await page.getByTestId('sale-line').count()}, OpenFour launches ${await page.getByTestId('four-line').count()}`);
  await shot(page, 'launches-home-real');
  await page.goto(`/#/flap/${launcher}`);
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 60_000 });
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', / BNB$/, { timeout: 60_000 });
  const [pile, paid, circ] = await Promise.all([
    read<bigint>(pileVault, pileAbi, 'pile'),
    read<bigint>(pileVault, pileAbi, 'totalPaidOut'),
    read<bigint>(pileVault, pileAbi, 'circulatingSupply'),
  ]);
  console.log(`REAL pile ${pile} paidOut ${paid} circulating ${circ}`);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', `${toDecimalString(pile, 18)} BNB`);
  await expect(page.getByTestId('paid-out').locator('.amount')).toHaveAttribute('title', `${toDecimalString(paid, 18)} BNB`);
  await expect(page.getByTestId('circulating').locator('.amount')).toHaveAttribute('title', new RegExp(`^${toDecimalString(circ, 18).replace('.', '\\.')} `));
  // The numbers after the orchestrator's last real transaction (25 November 2026, 17:27 +07).
  console.log(
    `MATCHES THE RUN'S NUMBERS: ${pile === 34700474883453682n && paid === 403238899039918n && circ === 1109724269256866685842627768n}`,
  );
  await shot(page, 'launches-sale-real');
});

/** The pile panel on screen against the pile's own reads, exactly (the amount's title carries every digit). */
async function pileMatches(page: Page, pileAddr: Address) {
  const [pile, paid, circ] = await Promise.all([
    read<bigint>(pileAddr, pileAbi, 'pile'),
    read<bigint>(pileAddr, pileAbi, 'totalPaidOut'),
    read<bigint>(pileAddr, pileAbi, 'circulatingSupply'),
  ]);
  const exact = (v: bigint) => new RegExp(`^${toDecimalString(v, 18).replace('.', '\\.')} `);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', exact(pile), { timeout: 60_000 });
  await expect(page.getByTestId('paid-out').locator('.amount')).toHaveAttribute('title', exact(paid));
  await expect(page.getByTestId('circulating').locator('.amount')).toHaveAttribute('title', exact(circ));
  return { pile, paid, circ };
}

test('the real token-quote sale: launched, verified, and its pile, paid out and circulating supply exactly', async ({ page }) => {
  const launcher = addresses.flap.tokenQuote.sales[0]!.launcher;
  const [, , pileVault] = await read<readonly [Address, Address, Address]>(launcher, launcherAbi, 'launchInfo');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/flap/${launcher}`);
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 60_000 });
  await expect(page.getByTestId('flap-sale')).toHaveAttribute('data-trusted', 'yes', { timeout: 90_000 });
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', / USDT \(test\)$/, { timeout: 60_000 });
  const { pile, paid, circ } = await pileMatches(page, pileVault);
  console.log(`REAL USDT pile ${pile} paidOut ${paid} circulating ${circ}`);
  // The orchestrator's numbers after his last transaction (25 November 2026, evening).
  console.log(
    `USDT MATCHES THE RUN'S NUMBERS: ${pile === 25729444279937824564n && paid === 231202394307737556n && circ === 1112853712305900101214014804n}`,
  );
  await shot(page, 'launches-usdt-sale-real');
});

test('the real OpenFour launches: each token page shows its pile exactly', async ({ page }) => {
  const want: Record<string, bigint> = { tax: 738293053413195n, preset: 1998610028941705n };
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const t of addresses.openfour.tokens) {
    await page.goto(`/#/four/${t.token}`);
    await expect(page.getByTestId('four-token')).toHaveAttribute('data-trusted', 'yes', { timeout: 90_000 });
    await expect(page.getByTestId('four-token')).toHaveAttribute('data-kind', t.kind);
    if (t.kind === 'tax-rules' && t.taxVaultClone) {
      // SH-301: a rules token shows its rules as its clone fixed them (creator, pile, buy back and burn), each with what
      // it has sent, and the share-out
      const clone = t.taxVaultClone;
      const bps = await Promise.all(['creatorBps', 'pileBps', 'burnBps'].map((f) => read<number>(clone, rulesTaxVaultAbi, f)));
      const panel = page.getByTestId('rules-panel');
      await expect(panel.locator('[data-testid$="-name"]')).toHaveText(['Creator', 'Pile', 'Buy back and burn'], { timeout: 60_000 });
      for (const [i, b] of bps.entries()) await expect(panel.getByTestId(`rule-${i}-bps`)).toHaveText(formatBps(BigInt(b)));
      await expect(panel.getByTestId('rule-0-delivered')).toBeVisible({ timeout: 90_000 });
      console.log(`REAL OpenFour rules token ${t.token}: rules ${bps.join(' / ')} bps shown`);
    }
    const { pile, paid, circ } = await pileMatches(page, t.pile);
    console.log(`REAL OpenFour ${t.kind} pile ${pile} paidOut ${paid} circulating ${circ}${t.kind in want ? `; MATCHES THE RUN'S PILE: ${pile === want[t.kind]}` : ''}`);
    await shot(page, `launches-four-${t.kind}-real`);
  }
});
