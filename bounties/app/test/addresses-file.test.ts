import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfig } from '../src/lib/config';

// The committed addresses file is the deployment files' (scripts/make-addresses.mjs), never typed by hand.
const here = path.dirname(fileURLToPath(import.meta.url));
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('public/addresses.json for chain 97', () => {
  const file = json('../public/addresses.json');
  const dep = json('../../flap/deployments/97.json');
  const sale = json('../../flap/deployments/97-sale.json');

  it('is a valid addresses file with both public read endpoints, in order', () => {
    const r = checkConfig(file);
    expect(r.ok).toBe(true);
    expect(file.chainId).toBe(97);
    expect(file.rpcUrls).toEqual(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org']);
  });

  it('carries the Flap entry deployment exactly, from its deploy block', () => {
    const usdtFile = path.join(here, '../../flap/deployments/97-usdt.json');
    const usdt = fs.existsSync(usdtFile) ? json('../../flap/deployments/97-usdt.json') : undefined;
    expect('tokenQuote' in file.flap).toBe(Boolean(usdt));
    const { tokenQuote: _t, rules: _r, ...nativePart } = file.flap;
    expect(nativePart).toEqual({
      portal: dep.portal,
      tokenImpl: dep.tokenImpl,
      pileVaultFactory: dep.pileVaultFactory,
      curveLauncherFactory: dep.curveLauncherFactory,
      sales: [{ launcher: sale.launcher, token: sale.token }],
    });
  });

  it('has an OpenFour part only once that entry has a deployment file', () => {
    const four = path.join(here, '../../openfour/deployments/97.json');
    expect('openfour' in file).toBe(fs.existsSync(four));
  });

  it('maps every token-quote and OpenFour value exactly from its deployment file', () => {
    const usdt = json('../../flap/deployments/97-usdt.json');
    const usdtSale = json('../../flap/deployments/97-usdt-sale.json');
    expect(file.flap.tokenQuote).toEqual({
      quote: usdt.quote,
      label: 'USDT (test)',
      launcherFactory: usdt.tokenCurveLauncherFactory,
      pileVaultFactory: usdt.tokenPileVaultFactory,
      sales: [{ launcher: usdtSale.launcher, token: usdtSale.token }],
    });
    expect(usdtSale.quote).toBe(usdt.quote);
    const o = json('../../openfour/deployments/97.json');
    expect(o.chainId).toBe(97);
    expect(file.openfour).toEqual({
      core: o.core,
      tools: o.tools,
      wbnb: o.wbnb,
      presetId: o.presetId,
      taxPresetId: o.taxPresetId,
      taxTemplate: o.taxTemplate,
      ...(o.rulesTemplate ? { rulesTemplate: o.rulesTemplate } : {}),
      quotes: o.quotes,
      tokens: o.tokens.map((t: Record<string, string>) => ({
        token: t.token, kind: t.kind, pile: t.pile,
        ...(t.taxVaultClone ? { taxVaultClone: t.taxVaultClone } : {}),
        ...(typeof t.tokenUri === 'string' ? { tokenUri: t.tokenUri } : {}),
      })),
    });
    // the rules pairs, the shop and the stake factories: present exactly when their deployment files are
    const opt = (rel: string) => (fs.existsSync(path.join(here, rel)) ? json(rel) : undefined);
    const rn = opt('../../flap/deployments/97-rules-native.json');
    const ru = opt('../../flap/deployments/97-rules-usdt.json');
    expect(file.flap.rules).toEqual(
      rn || ru
        ? {
            ...(rn ? { native: { launcherFactory: rn.launcherFactory, rulesVaultFactory: rn.rulesVaultFactory, sales: expect.any(Array) } } : {}),
            ...(ru ? { token: { launcherFactory: ru.launcherFactory, rulesVaultFactory: ru.rulesVaultFactory, sales: expect.any(Array) } } : {}),
          }
        : undefined,
    );
    expect(file.shops).toEqual(opt('../../core/deployments/97-rail-shop.json') ? { factory: opt('../../core/deployments/97-rail-shop.json').factory } : undefined);
    expect(file.railStake).toEqual(opt('../../flap/deployments/97-stake.json') ? { factory: opt('../../flap/deployments/97-stake.json').factory } : undefined);
    const firsts = [json('../../flap/deployments/97.json').deployBlock, usdt.deployBlock, rn?.deployBlock, ru?.deployBlock, Number(o.fromBlock)].filter((b) => typeof b === 'number');
    expect(Number(file.fromBlock)).toBe(Math.min(...firsts));
  });
});
