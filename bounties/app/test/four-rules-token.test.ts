import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConfig } from '../src/lib/config';

// SH-301: the Four.meme copy's real rules token ("Snip", kind tax-rules) through the generator and the parser; an entry
// the page cannot read is left out and the rest stays; one entry never stops the page.
const here = path.dirname(fileURLToPath(import.meta.url));
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(here, rel), 'utf8'));
type Gen = { addressesFor: (i: Record<string, unknown>) => Record<string, unknown> };
const gen = async () => (await import(pathToFileURL(path.join(here, '../scripts/make-addresses.mjs')).href)) as Gen;

// The run's own entry for Snip and its rules template, as its writer put them into openfour/deployments/97.json
// (26 Nov 2026; the real run's record), on top of the committed file's two tokens.
const SNIP = {
  token: '0xdc787179a96bC8A826F5D5b618B6361c90e4215A',
  kind: 'tax-rules',
  quote: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
  splitter: '0x422805D2135A99302728D3201a2c33b2303f79F1',
  pile: '0x7d167fba8b90f4823097CBcF3d65A56922B39B01',
  taxVaultClone: '0x2dEBd754FDE1Eab70EB8447377BaC058e795d074',
  forwardVault: '0x61C2cA08910a3F14ef59B40960aeF27D2aE01cA3',
  vault: '0xF99DC4Da8F806F58431CB6218f662772F30172c3',
  rules: { creator: '0xd5D5633737f2fFd8E79E0AAf008795aB43215530', creatorBps: 2000, pileBps: 5000, burnBps: 3000 },
  name: 'Snip',
  symbol: 'SNIP',
  tokenUri: 'https://arweave.net/NsBB0qXX3l8SNYmdBaOQNKUhPRf6NkG4EA3ReWI3BGU#sha256=c7d2bf3b151db24a1a637b51728842bdd7f1cc4cc35f9216926688cf15dff09f',
  createTx: '0x2620e1b10308d01fe4a30c44766fa598ef98549bdbfea420367ef493f1a43680',
};
const RULES_TEMPLATE = '0x0B41E31f8D98796fE1DB09fB8d3c4B26aCe4502A';
// The committed file's two tokens (before the run's file lands; with it, its own copy of Snip is set aside here).
const fileNow = json('../../openfour/deployments/97.json');
const openfourNow = { ...fileNow, tokens: fileNow.tokens.filter((t: { kind?: string }) => t.kind !== 'tax-rules') };
const withSnip = { ...openfourNow, rulesTemplate: RULES_TEMPLATE, tokens: [...openfourNow.tokens, SNIP] };
const inputs = (openfour: unknown) => ({
  flap: json('../../flap/deployments/97.json'),
  sale: json('../../flap/deployments/97-sale.json'),
  usdt: json('../../flap/deployments/97-usdt.json'),
  usdtSale: json('../../flap/deployments/97-usdt-sale.json'),
  openfour,
});

afterEach(() => vi.restoreAllMocks());

describe('the Four.meme rules token in the addresses file', () => {
  it('the real entry through the generator and the parser: three tokens, the third a tax-rules token, the template named', async () => {
    const { addressesFor } = await gen();
    const out = addressesFor(inputs(withSnip)) as { openfour: { tokens: Record<string, string>[]; rulesTemplate?: string } };
    const expected = { token: SNIP.token, kind: 'tax-rules', pile: SNIP.pile, taxVaultClone: SNIP.taxVaultClone, tokenUri: SNIP.tokenUri };
    expect(out.openfour.tokens[2]).toEqual(expected);
    const r = checkConfig(out);
    if (!r.ok) throw new Error(r.problem);
    expect(r.value.openfour?.tokens).toHaveLength(3);
    expect(r.value.openfour?.tokens[2]).toEqual(expected);
    expect(r.value.openfour?.rulesTemplate).toBe(RULES_TEMPLATE);
  });
  it('an entry of a kind the page does not know is left out with a note naming it; the other two stay, the page starts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { addressesFor } = await gen();
    const out = addressesFor(inputs({ ...withSnip, tokens: [...openfourNow.tokens, { ...SNIP, kind: 'auction' }] }));
    const r = checkConfig(out);
    if (!r.ok) throw new Error(r.problem);
    expect(r.value.openfour?.tokens.map((t) => t.token)).toEqual(openfourNow.tokens.map((t: { token: string }) => t.token));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openfour.tokens[2].kind'));
  });
  it('a broken entry in any list (a token, a sale, a pile) is left out the same way; a wrong chain still stops the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { addressesFor } = await gen();
    const good = addressesFor(inputs(withSnip)) as Record<string, unknown> & { flap: { sales: unknown[] }; openfour: { tokens: unknown[] } };
    const broken = {
      ...good,
      piles: [{ pile: '0x12', rail: 'core' }],
      flap: { ...good.flap, sales: [...good.flap.sales, { launcher: 'not an address' }] },
      openfour: { ...good.openfour, tokens: [...good.openfour.tokens, { token: '0x0000000000000000000000000000000000000001', kind: 'tax', extra: 1 }] },
    };
    const r = checkConfig(broken);
    if (!r.ok) throw new Error(r.problem);
    expect(r.value.piles).toEqual([]);
    expect(r.value.flap?.sales).toHaveLength(good.flap.sales.length);
    expect(r.value.openfour?.tokens).toHaveLength(3);
    expect(checkConfig({ ...good, chainId: 56 })).toEqual({ ok: false, problem: 'chainId: must be 97' });
    expect(checkConfig({ ...good, openfour: { ...good.openfour, core: '0x12' } }).ok).toBe(false);
  });
});
