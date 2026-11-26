// @vitest-environment node
/**
 * SH-258: the web app under `SH_TESTNET=bnb` (BNB Chain testnet, chain 97, as the test-network slot `sepolia`). The
 * modules are loaded again with the setting stubbed (the chain package picks the profile once, when it loads); the
 * default build's behaviour is pinned by every other suite, unchanged. The record and manifest values below are fakes
 * (0x97…), never a deployment.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TESTNET_PROFILES } from '@squarehole/chain/write/wallet';
import { PICTURE_ORIGINS } from '../pictures/arweave-hosts';
import sepoliaCore from '../../../../../packages/contracts/deployments/core-v1/11155111.json' with { type: 'json' };

const ZERO = '0x0000000000000000000000000000000000000000';
const fake = (n: number) => `0x97${'0'.repeat(34)}${n.toString(16).padStart(4, '0')}`;
const HASH = `0x${'97'.repeat(32)}`;
async function bnb<T>(load: () => Promise<T>): Promise<T> {
  vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  return load();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('SH_TESTNET=bnb: names, coin and chain', () => {
  it('the data source: chain 97, the badge, the label and the hints name BNB Chain', async () => {
    const ds = await bnb(() => import('./data-source'));
    expect(ds.SEPOLIA_CHAIN_ID).toBe(97);
    expect(ds.DATA_SOURCE_BADGES.sepolia).toEqual({ lead: 'Testnet', rest: ' · BNB Chain', short: ' · BNB Chain' });
    expect(ds.DATA_LABELS.sepolia).toBe('BNB Chain testnet');
    expect(ds.PRODUCTION_NOT_DEPLOYED).toBe('No BNB Chain Testnet deployment in this build.');
    const [option] = ds.dataSourceOptions({ localManifest: null, sepoliaManifest: null, localRpcUrl: '', coreSepolia: 'deployed', production: true });
    expect(option).toMatchObject({ id: 'sepolia', title: 'BNB Chain testnet', chainId: 97, available: true });
    expect(option?.hint).not.toMatch(/Sepolia|box 0/);
    expect(option?.hint).toMatch(/BNB Chain Testnet/);
  });

  it('the native coin is BNB at the central spots; gas asks for tBNB', async () => {
    const [native, price, feeWords, kinds, gas] = await bnb(() => Promise.all([
      import('./native-coin'), import('../core/v2/price-coin'), import('../create/v2/fee-words'), import('../boxes/fee-kinds'), import('../tx/gas-words'),
    ]));
    expect([native.NATIVE_SYMBOL, native.WRAPPED_NATIVE_SYMBOL]).toEqual(['BNB', 'WBNB']);
    expect(price.coinLabelV2(ZERO, null)).toBe('BNB');
    expect(feeWords.coinName(ZERO, [])).toBe('BNB');
    expect(kinds.qSymbol(ZERO)).toBe('BNB');
    expect(gas.gasFundsLine(97)).toBe('Needs a little more tBNB for gas.');
    expect(gas.gasFundsLine(11_155_111)).toBe('Needs a little more ETH for gas.');
  });

  it('BoxSpec rules: 97 takes Sepolia’s rule set (holder payouts are not hidden)', async () => {
    const network = await bnb(() => import('../boxes/spec-network'));
    expect(network.specNetwork({ isDemo: false, chainId: 97 })).toBe('sepolia');
    expect(network.specNetwork({ isDemo: false, chainId: 11_155_111 })).toBe('mainnet');
  });

  it('the default build gives 97 mainnet’s rules', async () => {
    const network = await import('../boxes/spec-network');
    expect(network.specNetwork({ isDemo: false, chainId: 97 })).toBe('mainnet');
    expect(network.specNetwork({ isDemo: false, chainId: 11_155_111 })).toBe('sepolia');
  });

  it('box ids and explorer links on 97 go to BscScan’s testnet', async () => {
    const [ids, net] = await bnb(() => Promise.all([import('../boxes/box-id'), import('./testnet')]));
    expect(ids.parseBoxId(`97-${fake(5)}`)).toMatchObject({ chainId: 97 });
    expect(ids.parseBoxId(`11155111-${fake(5)}`)).toBeNull();
    expect(net.testnetExplorerHref({ chainId: 97, txHash: HASH })).toBe(`https://testnet.bscscan.com/tx/${HASH}`);
    expect(net.testnetExplorerHref({ chainId: 11_155_111, txHash: HASH })).toBeNull();
    expect(net.testnetContractHref('sepolia', fake(5))).toBe(`https://testnet.bscscan.com/address/${fake(5)}`);
  });
});

describe('SH_TESTNET=bnb: the box page’s words and clock', () => {
  it('the checking line, the next block’s launch tax and the wrapped coin follow BNB Chain testnet', async () => {
    const [page, life, clock, ways] = await bnb(() => Promise.all([import('../core/v2/V2BoxPage'), import('../core/v2/life-state'), import('./chain-clock'), import('../create/picture/examples-entry')]));
    const view = { audited: false, verified: false, block: 10n, record: { creationBlock: 5n } } as unknown as Parameters<typeof page.statusLine>[0];
    const line = page.statusLine(view, false);
    expect(line).toBe('Checking · a new box is checked within 32 blocks, about 14 seconds on BNB Chain Testnet.');
    expect(clock.NEXT_BLOCK_SECONDS).toBe(1n);
    expect(clock.blocksDuration(32)).toBe('about 14 seconds');
    // The tax at the last block's own second (the contract's steps are 12 s): at 11 s into the window still step 0, as
    // the next block may carry the same second; step 1 from 12 s on. Sepolia's next block, 12 s on, reads 12 s ahead.
    expect(life.windowTaxV2(1_000n, 1_011n)).toBe(life.windowTaxV2(1_000n, 1_000n));
    expect(life.windowTaxV2(1_000n, 1_012n)).not.toBe(life.windowTaxV2(1_000n, 1_000n));
    // SH-324: the way to the Examples shows on BNB Chain testnet too (the page in its BNB version).
    expect(ways.EXAMPLES_IN_APP).toBe(true);
  });
});

describe('SH_TESTNET=bnb: the security policy, the feed without a deployment, the launch form', () => {
  it('the policy names BNB Chain testnet’s read RPCs, the build’s index and picture origins, Arweave’s four (SH-285), and no Sepolia host', async () => {
    const [headers, output] = await bnb(() => Promise.all([import('../../share/share-headers'), import('../../../build/testnet-output')]));
    expect(headers.SITE_CSP_ORIGINS.rpc).toEqual(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org']);
    const policy = output.testnetHeadersPolicy(TESTNET_PROFILES.bnb, { SH_CORE_SEPOLIA_INDEXER_ORIGIN: 'https://index.example.org', SH_CORE_SEPOLIA_ART_GATEWAY: 'https://art.example.org' });
    expect(policy).toContain("connect-src 'self' https://index.example.org https://art.example.org https://bsc-testnet-rpc.publicnode.com https://bsc-prebsc-dataseed.bnbchain.org https://upload.ardrive.io https://turbo-gateway.com https://arweave.net https://goldsky.arweave.net;");
    // SH-285: the pictures are read as bytes and drawn from blob: URLs, so img-src gains no Arweave host.
    expect(policy).toContain("img-src 'self' data: blob: https://index.example.org https://art.example.org;");
    expect(headers.SITE_CSP_ORIGINS.pictures).toEqual([...PICTURE_ORIGINS]);
    expect(policy).not.toMatch(/sepolia|tenderly/);
    // A profile that keeps no pictures on Arweave names none of its hosts.
    const without = output.testnetHeadersPolicy({ ...TESTNET_PROFILES.bnb, switches: { ...TESTNET_PROFILES.bnb.switches, arweavePictures: false } }, {});
    expect(without).not.toMatch(/arweave|ardrive/);
    const rewritten = output.rewriteHeaders("/*\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: default-src 'self'; connect-src https://sepolia.gateway.tenderly.co\n\n/nft/*\n  Cache-Control: x\n", policy);
    expect(rewritten).toContain(`  Content-Security-Policy: ${policy}\n`);
    expect(rewritten).toContain('/nft/*\n  Cache-Control: x');
  });

  it('a BNB source without a deployment says so in its own words, never the FIT market’s', async () => {
    const [sources, ds] = await bnb(() => Promise.all([import('../boxes/box-sources'), import('./data-source')]));
    const result = sources.boxesFor('sepolia', { markets: [], localRpcUrl: '' } as never);
    expect(result.missing).toBe(ds.SEPOLIA_NOT_DEPLOYED);
    expect(result.launch).toBeNull();
    expect(result.missing).not.toMatch(/market|FIT|Sepolia/);
  });

  it('draws and sales: an imported hidden-art spec is off, and the inbox shows no sale rows', async () => {
    const [options, inbox] = await bnb(() => Promise.all([import('../create/v2/create-options'), import('../core/v2/InboxV2')]));
    const document = { off: [] } as never;
    const hiddenKey = options.HIDDEN_KEYS[0] as string;
    expect(options.offKeysOf(document).has(hiddenKey)).toBe(true);
    const history = { lastSale: { sellAmount: 5n, buyAmount: 6n, at: 0n }, lastRefresh: { balance: 1n, at: 0n }, inKindClaimed: 0n, funded: 0n, flushed: 0n, unwrapped: 2n } as never;
    const rows = inbox.historyRows(history, 86_400n, (amount: bigint) => `${amount} P`);
    expect(rows.map(([name]) => name)).toEqual(['Unwrapped from WBNB']);
  });
});

describe('SH_TESTNET=bnb: the re-read (round 2)', () => {
  it('the wallet companion says "item", never "Misfit"', async () => {
    const wallet = await bnb(() => import('../boxes/wallet-box'));
    const empty = { ...wallet.coreWalletBox('0x00000000000000000000000000000000000000a1', [], 1n) };
    expect(wallet.companionOf(empty, true).lead).toBe('No item held');
    // Round 3: nothing read, or no holdings read on this page (BNB: no core v1), says nothing about what is held.
    expect(wallet.companionOf(null, true)).toEqual({ slot: 'Empty', lead: 'No companion selected', line: 'Choosing a companion is not in this app yet.' });
    expect(wallet.companionOf({ ...empty, holdingsRead: false }, true).lead).toBe('No companion selected');
  });

  it('a production BNB build names no market record; the output leaves out nft/orchard and nft/the-misfits, keeps examples/ (SH-324)', async () => {
    const [plugin, output, fs, os, path] = await Promise.all([import('../../../deployments-plugin'), import('../../../build/testnet-output'), import('node:fs'), import('node:os'), import('node:path')]);
    expect(() => plugin.fitMarketPaths({ devServer: false, env: { SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia', SH_FIT_MARKET: 'hackathon/rehearsals/plain-97/core-v1/97.json' } })).toThrow(/takes no market record/);
    expect(plugin.fitMarketPaths({ devServer: false, env: { SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia', SH_FIT_MARKET: 'none' } })).toEqual([]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sh258-out-'));
    for (const dir of ['examples', 'nft/orchard', 'nft/the-misfits', 'assets', 'build/examples-bnb']) fs.mkdirSync(path.join(out, dir), { recursive: true });
    fs.writeFileSync(path.join(out, 'examples/index.html'), '<p>2 ETH</p>');
    fs.writeFileSync(path.join(out, 'build/examples-bnb/index.html'), '<p>2 BNB</p>');
    fs.writeFileSync(path.join(out, '_headers'), "/*\n  Content-Security-Policy: default-src 'self'\n");
    // The overlay's default place: build/examples-bnb under the app's folder (the config's root).
    const plugin97 = output.testnetOutput(TESTNET_PROFILES.bnb, {}) as unknown as { configResolved(c: unknown): void; closeBundle(): void };
    plugin97.configResolved({ root: out, build: { outDir: out } });
    plugin97.closeBundle();
    expect(['examples', 'nft/orchard', 'nft/the-misfits', 'assets'].map((dir) => fs.existsSync(path.join(out, dir)))).toEqual([true, false, false, true]);
    expect(fs.readFileSync(path.join(out, 'examples/index.html'), 'utf8')).toBe('<p>2 BNB</p>');
    expect(fs.readFileSync(path.join(out, '_headers'), 'utf8')).toContain('https://bsc-testnet-rpc.publicnode.com');
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('SH-324: the overlay replaces the files it names, leaves the others, adds new ones, and the build fails without it', async () => {
    const [output, fs, os, path] = await Promise.all([import('../../../build/testnet-output'), import('node:fs'), import('node:os'), import('node:path')]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh324-'));
    const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true }); fs.writeFileSync(path.join(tmp, file), text); };
    const read = (file: string) => fs.readFileSync(path.join(tmp, file), 'utf8');
    write('out/examples/index.html', 'ETH page');
    write('out/examples/pager.js', 'ETH pager');
    write('out/examples/styles.css', 'kept');
    write('out/examples/art/slide-a.webp', 'ETH picture');
    write('out/examples/art/logo.webp', 'kept picture');
    write('overlay/index.html', 'BNB page');
    write('overlay/pager.js', 'BNB pager');
    write('overlay/art/slide-a.webp', 'BNB picture');
    write('overlay/art/new/slide-b.webp', 'new picture');
    expect(output.layExamplesOverlay(path.join(tmp, 'out/examples'), path.join(tmp, 'overlay'))).toEqual(['art/new/slide-b.webp', 'art/slide-a.webp', 'index.html', 'pager.js'].map((file) => file.split('/').join(path.sep)));
    expect(['index.html', 'pager.js', 'art/slide-a.webp', 'art/new/slide-b.webp', 'styles.css', 'art/logo.webp'].map((file) => read(`out/examples/${file}`)))
      .toEqual(['BNB page', 'BNB pager', 'BNB picture', 'new picture', 'kept', 'kept picture']);
    // No overlay, or one without its index.html: a clear failure, and the ETH page is not shipped as it is.
    write('fresh/examples/index.html', 'ETH page');
    expect(() => output.layExamplesOverlay(path.join(tmp, 'fresh/examples'), path.join(tmp, 'nowhere'))).toThrow(/needs the explainer's BNB files in .*nowhere; it is missing, and the ETH page must not ship/);
    write('partial/pager.js', 'BNB pager');
    expect(() => output.layExamplesOverlay(path.join(tmp, 'fresh/examples'), path.join(tmp, 'partial'))).toThrow(/needs .*partial.index\.html; the ETH page must not ship/);
    expect(read('fresh/examples/index.html')).toBe('ETH page');
    expect(fs.existsSync(path.join(tmp, 'fresh/examples/pager.js'))).toBe(false);
    // An output without the explainer (public/examples not copied) fails too, and nothing may sit at the demo boxes' address.
    expect(() => output.layExamplesOverlay(path.join(tmp, 'none/examples'), path.join(tmp, 'overlay'))).toThrow(/has no .*index\.html \(public\/examples not copied\)/);
    write('shadow/index.html', 'BNB page');
    write('shadow/boxes/index.html', 'a page over the app');
    expect(() => output.layExamplesOverlay(path.join(tmp, 'fresh/examples'), path.join(tmp, 'shadow'))).toThrow(/examples\/boxes is the app's address of the demo boxes/);
    // The plugin: a BNB build without the overlay stops; a Sepolia build is not touched (no overlay asked for).
    write('site/examples/index.html', 'ETH page');
    const site = path.join(tmp, 'site');
    const plugin97 = output.testnetOutput(TESTNET_PROFILES.bnb, {}, { examplesOverlay: path.join(tmp, 'nowhere') }) as unknown as { configResolved(c: unknown): void; closeBundle(): void };
    plugin97.configResolved({ root: site, build: { outDir: site } });
    expect(() => plugin97.closeBundle()).toThrow(/SH-324: the BNB build needs the explainer's BNB files/);
    const sepolia = output.testnetOutput(TESTNET_PROFILES.sepolia, {}, { examplesOverlay: path.join(tmp, 'nowhere') }) as unknown as { configResolved(c: unknown): void; closeBundle(): void };
    sepolia.configResolved({ root: site, build: { outDir: site } });
    sepolia.closeBundle();
    expect(read('site/examples/index.html')).toBe('ETH page');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('SH-324: the strict search reads the overlaid page: a forbidden word the overlay brings stops the build', async () => {
    const [output, fs, os, path] = await Promise.all([import('../../../build/testnet-output'), import('node:fs'), import('node:os'), import('node:path')]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh324-search-'));
    for (const dir of ['site/examples', 'clean', 'flagged']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'site/examples/index.html'), '<p>Pay in ETH</p>');
    fs.writeFileSync(path.join(tmp, 'clean/index.html'), '<p>Pay in BNB</p>');
    fs.writeFileSync(path.join(tmp, 'flagged/index.html'), '<p>Pay in BNB, then meet the Misfits</p>');
    const site = path.join(tmp, 'site');
    const run = (overlay: string) => {
      const plugin97 = output.testnetOutput(TESTNET_PROFILES.bnb, {}, { examplesOverlay: path.join(tmp, overlay) }) as unknown as { configResolved(c: unknown): void; closeBundle(): void };
      plugin97.configResolved({ root: site, build: { outDir: site } });
      plugin97.closeBundle();
    };
    run('clean');
    expect(output.bnbOutputHits(site)).toEqual([]);
    expect(() => run('flagged')).toThrow(/SH-258: the BNB output holds box 0's words or files \(1\):\nexamples.index\.html: …<p>Pay in BNB, then meet the Misfit/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('SH-324: no file of the explainer sits at the demo boxes’ address, so the host hands /examples/boxes to the app', async () => {
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    const page = await import('../examples/examples-page');
    expect(page.DEMO_BOXES_PATH).toBe('/examples/boxes');
    const publicDir = fileURLToPath(new URL('../../../public', import.meta.url));
    expect(fs.existsSync(path.join(publicDir, page.DEMO_BOXES_PATH))).toBe(false);
    expect(fs.existsSync(path.join(publicDir, page.EXAMPLES_PAGE))).toBe(true);
  });

  it('About names the reviewed sites of its own network: Sepolia the list it named before SH-258, BNB its explorer', async () => {
    const sepolia = await import('../../pages/about-content');
    expect(sepolia.NO_TRADING_CARD.details[0]).toBe('Box pages link only to reviewed sites (Uniswap web app, DEX Screener, Etherscan, Etherscan (Sepolia), Blockscout (Sepolia)), with the exact chain and contract address. A name or picture proves nothing.');
    const about = await bnb(() => import('../../pages/about-content'));
    expect(about.NO_TRADING_CARD.details[0]).toBe('Box pages link only to reviewed sites (Uniswap web app, DEX Screener, Etherscan, BscScan (Testnet)), with the exact chain and contract address. A name or picture proves nothing.');
  });

  it('Sepolia: an empty versions list gives both issues, as before SH-258', async () => {
    const { parseCoreManifest } = await import('../../../../../packages/chain/src/config/core-manifest');
    const manifest = JSON.parse(JSON.stringify(sepoliaCore)) as Record<string, unknown>;
    manifest.versions = [];
    delete manifest.releases;
    expect(() => parseCoreManifest(manifest)).toThrow(/versions: Too small: expected array to have >=1 items; versions: version 1 \(box 0's factory\) is missing/);
  });
});

describe('SH_TESTNET=bnb: the chain glyph', () => {
  it('cards and the chain chip draw a plain square on its point, not Ethereum’s mark', async () => {
    const [{ createElement }, { renderToStaticMarkup }, parts] = await bnb(() => Promise.all([import('react'), import('react-dom/server'), import('../boxes/BoxParts')]));
    expect(renderToStaticMarkup(createElement(parts.EthGlyph))).toContain('data-glyph="testnet"');
  });
});

describe('SH_TESTNET=bnb: the switches', () => {
  it('the profile switches cowSales, box0 and draws off; SH-275: the alpha on, as an open-site alpha; SH-285: Arweave pictures on', () => {
    expect(TESTNET_PROFILES.bnb.switches).toEqual({ alphaGate: true, alphaOpen: true, cowSales: false, box0: false, draws: false, arweavePictures: true });
  });

  it('draws: "Hidden until drawn" is switched off in the launch form, with or without the release list', async () => {
    const options = await bnb(() => import('../create/v2/create-options'));
    expect([...options.offKeysOf(null)]).toEqual([...options.HIDDEN_KEYS]);
    const defaults = await (async () => { vi.unstubAllEnvs(); vi.resetModules(); return import('../create/v2/create-options'); })();
    expect([...defaults.offKeysOf(null)]).toEqual([]);
  });

  it('alphaGate: a reveal never uploads pictures to the alpha server (the upload is not built)', async () => {
    const session = await bnb(() => import('../core/v2/reveal-session'));
    expect(session.revealUploadAllowed(TESTNET_PROFILES.bnb.switches)).toBe(false);
    expect(session.revealUploadAllowed(TESTNET_PROFILES.sepolia.switches)).toBe(true);
  });

  it('box0: About & risks has no Misfits card, no list of our boxes and no FIT, Misfits or box 0 sentence', async () => {
    const about = await bnb(() => import('../../pages/about-content'));
    expect([about.MISFITS_SHOWN, about.OURS_SHOWN]).toEqual([false, false]);
    expect(about.ABOUT_CARDS.map((card) => card.id)).toEqual(['risks-box', 'risks-curve', 'risks-fees', 'risks-failure', 'risks-coins', 'risks-trading']);
    const words = [...about.ABOUT_CARDS.flatMap((card) => [card.title, card.lead, ...card.details, ...card.figures.map((f) => `${f.value} ${f.label}`)]),
      ...about.MORE_RISKS.map((risk) => risk.text)].join('\n');
    expect(words).not.toMatch(/\bFIT\b|Misfit|[Bb]ox 0|Privy|ETH raise/);
    expect(about.MORE_RISKS).toHaveLength(12);
    // The fee bar: no FIT burn; the release's FIT share is drawn with Square Hole's (both go to the deploy wallet's holders).
    expect(about.V2_SPLIT_SHOWN.map((part) => [part.label, part.fifteenths])).toEqual([['Creator’s choice', 10n], ['Square Hole', 3n], ['Box pool', 2n]]);
  });

  it('the test network notice names BNB Chain and has no alpha, Privy, X, Sepolia or Arweave line (without the sign-in and Arweave)', async () => {
    const { buildTestNetworkNotice } = await import('../legal/test-network');
    const noArweave = { ...TESTNET_PROFILES.bnb, switches: { ...TESTNET_PROFILES.bnb.switches, arweavePictures: false } };
    const notice = buildTestNetworkNotice(noArweave, false);
    const text = [notice.lede, ...notice.points, ...notice.privacy.bullets, notice.privacy.device, notice.gate.status].join('\n');
    expect(notice.version).toBe('2026-11-25-bnb-test-1');
    expect(notice.lede).toBe('This is the Square Hole test site. It runs on the BNB Chain test network only.');
    expect(text).not.toMatch(/Sepolia|SepETH|Privy|\bX\b|Arweave|alpha|claim with/);
    expect(text).toMatch(/Tokens, BNB and NFTs on BNB Chain Testnet are test tokens/);
    expect(text).toMatch(/The app reads BNB Chain Testnet through PublicNode and BNB Chain\./);
    // Sepolia's text is unchanged: version 6.
    expect(buildTestNetworkNotice(TESTNET_PROFILES.sepolia).version).toBe('2026-11-20-sepolia-test-6');
  });

  it('SH-285: with Arweave pictures, Sepolia’s two Arweave sentences word for word, as a new version (with and without the sign-in)', async () => {
    const { buildTestNetworkNotice } = await import('../legal/test-network');
    const sepolia = buildTestNetworkNotice(TESTNET_PROFILES.sepolia);
    const noArweave = { ...TESTNET_PROFILES.bnb, switches: { ...TESTNET_PROFILES.bnb.switches, arweavePictures: false } };
    const arweaveLine = sepolia.privacy.bullets.find((bullet) => bullet.startsWith('Box pictures are published to Arweave'));
    const picturesPoint = sepolia.points.find((point) => point.startsWith('**Pictures.**'));
    expect(arweaveLine).toBe('Box pictures are published to Arweave through ArDrive Turbo and load from turbo-gateway.com, arweave.net and goldsky.arweave.net, which see your IP address and which picture you asked for.');
    expect(picturesPoint).toBe('**Pictures.** We hide a picture on this site only if it is illegal or comes with a legal notice. Its copies on Arweave stay where they are.');
    for (const [signIn, version, earlier] of [[true, '2026-11-26-bnb-test-3', '2026-11-26-bnb-test-2'], [false, '2026-11-26-bnb-test-4', '2026-11-25-bnb-test-1']] as const) {
      const notice = buildTestNetworkNotice(TESTNET_PROFILES.bnb, signIn);
      const before = buildTestNetworkNotice(noArweave, signIn);
      expect([notice.version, notice.dateText, before.version]).toEqual([version, '26 November 2026', earlier]);
      expect(notice.privacy.bullets).toEqual([...before.privacy.bullets.slice(0, -1), arweaveLine, before.privacy.bullets.at(-1)]);
      expect(notice.points).toEqual(before.points.map((point) => (point.startsWith('**Pictures.**') ? picturesPoint : point)));
      expect([notice.lede, notice.privacy.device]).toEqual([before.lede, before.privacy.device]);
    }
  });

  it('SH-275: with the sign-in, the notice brings back Sepolia’s sign-in sentences that are true on 97, as a new version', async () => {
    const { buildTestNetworkNotice } = await bnb(() => import('../legal/test-network'));
    // The default: this build's switch (alpha-on.ts), on with the BNB site's own Privy app.
    const notice = buildTestNetworkNotice();
    const sepolia = buildTestNetworkNotice(TESTNET_PROFILES.sepolia);
    expect(notice.version).toBe('2026-11-26-bnb-test-3');
    expect(notice.versionLine).toBe('Version 2026-11-26-bnb-test-3 · 26 November 2026');
    // No "Closed alpha" point (a first sign-in is approved at once), the points otherwise as version 1.
    expect(notice.points).toEqual(buildTestNetworkNotice(TESTNET_PROFILES.bnb, false).points);
    expect(notice.points.join('\n')).not.toMatch(/Closed alpha|SepETH|Sepolia/);
    // Privacy: Sepolia's X and Privy sentences word for word; the claim's without "The two transactions to it are public."
    for (const bullet of [sepolia.privacy.bullets[0], sepolia.privacy.bullets[1], sepolia.privacy.bullets[3], sepolia.privacy.bullets[6]]) expect(notice.privacy.bullets).toContain(bullet);
    expect(notice.privacy.bullets).toContain('To claim, your wallet signs a message that links your X account to that address. Only we keep that link, and Privy too for a wallet it made.');
    expect(notice.privacy.bullets.join('\n')).not.toMatch(/two transactions|Sepolia/);
    // The device line: Sepolia's, without the notice's cookie.
    expect(notice.privacy.device).toBe(sepolia.privacy.device.replace('; so does the notice’s cookie, if the browser cannot store your acceptance otherwise.', '.'));
    expect(notice.privacy.device).not.toMatch(/notice’s cookie/);
  });
});

describe('SH_TESTNET in the web build (build-target.ts, deployments-plugin.ts)', () => {
  it('the setting: names the test network; a BNB production build is the test site only; a misspelling fails', async () => {
    const target = await import('../../../build-target');
    expect(target.testnetOf({})).toBe('sepolia');
    expect(target.testnetOf({ SH_TESTNET: 'bnb' })).toBe('bnb');
    expect(target.testnetOf({ SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia' })).toBe('bnb');
    expect(() => target.testnetOf({ SH_TESTNET: 'bnb', SH_BUILD: 'production' })).toThrow(/needs SH_TARGET=sepolia/);
    expect(() => target.testnetOf({ SH_TESTNET: 'bsc' })).toThrow(/SH_TESTNET must be unset/);
    expect(target.buildDefines({ SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia' }, 'build').__SH_TESTNET__).toBe('"bnb"');
    expect(target.buildDefines({ SH_TESTNET: 'bnb' }, 'serve')).toEqual({ __SH_TESTNET__: '"bnb"', 'import.meta.env.SH_BNB': 'true' });
    expect(target.buildDefines({}, 'build')).not.toHaveProperty('__SH_TESTNET__');
    // The trade box and test-coin page stay on in the BNB test site; SH-275: the alpha's join page as well, no desk.
    const bnbSite = { SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia' };
    expect([target.sepoliaTradeOf(bnbSite), target.alphaGateOf(bnbSite), target.alphaDeskOf(bnbSite), target.legalModeOf(bnbSite)]).toEqual([true, true, false, 'test-network']);
    expect([target.alphaGateOf({ SH_BUILD: 'production', SH_TARGET: 'sepolia' }), target.alphaDeskOf({ SH_BUILD: 'production', SH_TARGET: 'sepolia' })]).toEqual([true, true]);
    expect([target.alphaGateOf({ SH_BUILD: 'production' }), target.alphaDeskOf({ SH_BUILD: 'production' })]).toEqual([false, false]);
  });

  it('the files: core-v1/97.json, the coin record beside Sepolia’s, the art gateway setting', async () => {
    const plugin = await import('../../../deployments-plugin');
    const bnbSite = { SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia' };
    // 97.json exists only once the release is deployed; Sepolia's file is never read for the BNB slot.
    for (const path of plugin.coreManifestPaths({ devServer: false, env: bnbSite })) expect(path.endsWith('core-v1/97.json')).toBe(true);
    expect(plugin.testnetCoinRecordPath(bnbSite)?.endsWith('packages/chain/src/trade-sepolia/coin-deployment-97.json')).toBe(true);
    expect(plugin.testnetCoinRecordPath({})).toBeNull();
    expect(plugin.sepoliaArtGateways(bnbSite)).toEqual([]);
    expect(plugin.sepoliaArtGateways({ ...bnbSite, SH_CORE_SEPOLIA_ART_GATEWAY: 'https://art.example.org' })).toEqual(['https://art.example.org']);
    expect(() => plugin.sepoliaArtGateways({ ...bnbSite, SH_CORE_SEPOLIA_ART_GATEWAY: 'http://127.0.0.1:9000' })).toThrow(/https origin on a public host/);
    // Sepolia ignores the setting, as before SH-258 (its gateway is pinned).
    expect(plugin.sepoliaArtGateways({ SH_BUILD: 'production', SH_TARGET: 'sepolia', SH_CORE_SEPOLIA_ART_GATEWAY: 'https://art.example.org' })).toEqual(['https://api.squarehole.fun']);
    expect(plugin.sepoliaArtGateways({ SH_BUILD: 'production', SH_TARGET: 'sepolia' })).toEqual(['https://api.squarehole.fun']);
    // SH-285: the BNB test site keeps its v2 logos and covers on Arweave, as the Sepolia test site does.
    expect(plugin.arweavePictures(bnbSite)).toEqual({ local: false, sepolia: true });
    expect(plugin.arweavePictures({ SH_TESTNET: 'bnb', SH_ARWEAVE_PICTURES: '1' })).toEqual({ local: true, sepolia: true });
    expect(plugin.arweavePictures({ SH_TESTNET: 'bnb' })).toEqual({ local: false, sepolia: false });
    expect(plugin.arweavePictures({ SH_ARWEAVE_PICTURES: '1' })).toEqual({ local: true, sepolia: true });
  });

  it('a BNB production build embeds the real core-v1/97.json and the real coin record; no override, no rehearsal file', async () => {
    const plugin = await import('../../../deployments-plugin');
    const bnbSite = { SH_TESTNET: 'bnb', SH_BUILD: 'production', SH_TARGET: 'sepolia' };
    const { code } = plugin.deploymentsModule({ devServer: false, env: bnbSite });
    expect(code).toMatch(/"chainId":97,"network":"bnb-testnet"/);
    expect(code).toMatch(/export const TESTNET_COIN_RECORD = \{"chainId":97,"status":"deployed"/);
    const fixture = fileURLToPath(new URL('../../../../../packages/chain/test/fixtures/bnb-testnet/core-manifest-97.json', import.meta.url));
    expect(() => plugin.deploymentsModule({ devServer: false, env: { ...bnbSite, SH_CORE_SEPOLIA_MANIFEST: fixture } })).toThrow(/reads only packages\/contracts\/deployments\/core-v1\/97\.json/);
    const rehearsal = fileURLToPath(new URL('../../../../../hackathon/rehearsals/plain-97/core-v1/97.json', import.meta.url));
    expect(() => plugin.deploymentsModule({ devServer: false, env: { SH_BUILD: 'production', SH_TARGET: 'sepolia', SH_CORE_SEPOLIA_MANIFEST: rehearsal } })).toThrow(/never takes a rehearsal/);
    // A development build may still embed a fixture (the browser suites' way).
    expect(plugin.deploymentsModule({ devServer: false, env: { SH_TESTNET: 'bnb', SH_CORE_SEPOLIA_MANIFEST: fixture } }).code).toMatch(/"chainId":97/);
  });
});
