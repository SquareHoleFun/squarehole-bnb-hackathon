#!/usr/bin/env node
/** Offline, unsigned packs. Public bindings only; no RPC, key access, signing or sending. */
import './register-ts.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, erc20Abi, erc721Abi, isAddress, keccak256, parseAbi, zeroAddress } from 'viem';
import { RELEASE } from './buy-v2.mjs';
import { buildBatch, buildMergedBatch, TEST_COINS } from './sepolia-listing-batch.mjs';
import { readExampleSettings, assertRecipeSettings } from './create-example-v2-settings.mjs';
import { quoteJunkyardCreatorBuy, estimateJunkyardTokensOut, junkyardMinimumTokensOut, JUNKYARD_TARGET_T } from './create-example-v2-quote.mjs';
import { buildExampleSpec, priceSymbol, stringify } from './create-example-v2.mjs';
import { loadExamples } from '../../box-spec/examples/v2/registry.mjs';
const { OPEN_REVEAL_SETS } = await import('./reveal-open-v2.ts');
const { buildCreateCallsV2 } = await import('../src/core/v2/create-calls-v2.ts');
const { encodeBoxSpecV2 } = await import('../../box-spec/src/generated/box-spec.v2.ts');
const { pileConfigV2 } = await import('../src/core/v2/m3-spec-v2.ts');
const { shopConfigV2 } = await import('../src/core/v2/m2-spec-v2.ts');

export const KIT_IDS = Object.freeze(['gpu-poor', 'one-dollar', 'rent-free', 'bag-holders', 'exit-liquidity', 'link-marines-v2',
  'frog-kiln', 'paper-certificates', 'dragons-hoard', 'junkyard', 'one-collection-shop', 'the-alchemist', 'lake-house']);
const CHAIN = '11155111';
const NATIVE_RAISE = '100000000000000000';
const BASE_RAISE = 4206980085000000000n; // ListingRaises uses the immutable release reference.
const raw = (v, label, max = (1n << 256n) - 1n) => {
  assert.ok(typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v), `${label}: decimal string required`);
  const n = BigInt(v); assert.ok(n <= max, `${label}: overflow`); return n;
};
const address = (v, label) => { assert.ok(typeof v === 'string' && isAddress(v) && !/^0x0{40}$/i.test(v), `${label}: nonzero address required`); return v; };
const hash = v => assert.match(v, /^0x[0-9a-fA-F]{64}$/);
const count = (v, label, max = 0xffffffffn) => Number(raw(v, label, max)); // bounded ABI enum/id only
const poolAbi = parseAbi(['function seed((address coin,uint160 sqrtPriceX96,int24 tickLower,int24 tickUpper,uint256 amount0Max,uint256 amount1Max,uint256 deadline) s) payable returns (uint128)']);
const registerAbi = parseAbi(['function register()']);
const POOLS = {
  tLINK: ['792281625142643375935439503360', '100000000000000000000'],
  tUSDC: ['792281625142643375935439', '100000000'],
  tNVDA: ['792281625142643375935439503360', '100000000000000000000'],
  tGOLD: ['79228162514264337593543950336', '1000000000000000000'],
  tPEPE: ['79228162514264337593543950336000', '1000000000000000000000000'],
  tFROG: ['79228162514264337593543950336000', '1000000000000000000000000'],
};
const call = (to, abi, functionName, args = [], value = 0n, kind = functionName) =>
  ({ to, value: value.toString(), data: encodeFunctionData({ abi, functionName, args }), kind });
const approval = (token, spender, amount) => call(token, erc20Abi, 'approve', [spender, amount]);
function safeBatch(safe, name, calls) {
  return { version: '1.0', chainId: CHAIN, createdAt: 0,
    meta: { name, description: 'Unsigned. Verify bindings at one block, simulate every call in order, then founder signs.',
      txBuilderVersion: '1.18.0', createdFromSafeAddress: safe, createdFromOwnerAddress: '' },
    transactions: calls.map(({ to, value, data, kind }) => ({ to, value: value.toString(), data, ...(kind ? { kind } : {}) })) };
}

/** TA-30's six full-range pools, each 1 SepETH maximum, followed by exact probe funding. */
export function buildInfrastructure({ coins, helper, owner, deadline }) {
  address(helper, 'helper'); address(owner, 'owner');
  const end = raw(deadline, 'deadline'); assert.ok(end > 0n, 'deadline required');
  const listings = buildMergedBatch(coins);
  const pools = [], transfers = [];
  for (const symbol of TEST_COINS.keys()) {
    const coin = address(coins[symbol], symbol);
    const [price, amount] = POOLS[symbol].map(BigInt);
    const seed = { coin, sqrtPriceX96: price, tickLower: -887220, tickUpper: 887220,
      amount0Max: 10n ** 18n, amount1Max: amount, deadline: end };
    pools.push(...[approval(coin, helper, amount), call(helper, poolAbi, 'seed', [seed], seed.amount0Max), approval(coin, helper, 0n)]
      .map(t => ({ ...t, from: owner, chainId: CHAIN })));
    transfers.push({ ...call(coin, erc20Abi, 'transfer', [listings.meta.createdFromSafeAddress, 10000n]), from: owner, chainId: CHAIN });
  }
  return { listings, pools, transfers, preflight: [
    'Deploy the founder-owned TestPoolLiquidity helper once using SepoliaTestPools.deployHelper().',
    'Check helper owner/manager/codehash, coin metadata, balances, uninitialized pool keys and helper.quote at a pinned current block.',
    'Each pool triple requires initial allowance zero; after any failed seed, clear approval before investigating.',
    'Transfers are from the named owner, who must hold the coins; top up from the issuance recipient when different.',
    'Check newestListingOf before the single listing batch: existing rows require an integrator-reviewed update, not another add.',
  ] };
}


/** Consume L1's FINAL bound settings verbatim. Values come from a pinned read, not guessed deployment slots. */
export async function buildKitPack(f) {
  assert.equal(f.chainId, CHAIN, 'Sepolia only');
  assert.ok(KIT_IDS.includes(f.id), 'unknown kit');
  const e = loadExamples().find(e => e.id === f.id);
  const spec = readExampleSettings(f.settingsText);
  const listing = { ...f.listing, id: count(f.listing.id, 'listing id'), decimals: count(f.listing.decimals, 'decimals', 18n),
    class: count(f.listing.class, 'class', 5n), kind: count(f.listing.kind, 'kind', 2n), raise: raw(f.listing.raise, 'raise', (1n << 128n) - 1n) };
  assert.deepEqual(spec.pricing, { listingId: listing.id, token: listing.token }, 'settings listing mismatch');
  assert.equal(spec.raise, listing.raise, 'settings listing raise mismatch');
  assert.equal(f.nativeRaise, NATIVE_RAISE, 'native listing must be updated before creation');
  const bootstrapQ = raw(f.bootstrapQ, 'bootstrap');
  assert.equal(bootstrapQ, (listing.raise * 1500000000000000n + BASE_RAISE - 1n) / BASE_RAISE, 'factory bootstrap mismatch');
  const { creator, factory } = f.inputs;
  address(creator, 'creator'); address(factory, 'factory'); hash(f.cs); hash(f.hs); raw(f.evidenceBlock, 'block');
  const { spec: expected, starter } = buildExampleSpec(e, { ...f.inputs,
    art: { metadataTable: spec.metadataTable, revealRoot: spec.revealRoot, generatorHash: spec.generatorHash, revealListId: spec.revealListId } },
  listing, raw(f.nativeRaise, 'native raise'), bootstrapQ);
  assertRecipeSettings(spec, expected, listing);
  const roles = f.roles;
  const addresses = [creator, factory, ...Object.values(roles)];
  assert.equal(new Set(addresses.map(a => String(a).toLowerCase())).size, addresses.length, 'roles must be distinct');
  address(roles.coordinator, 'coordinator'); address(roles.token, 'token');
  if (Object.values(e.fees).some(s => ['holders', 'holders-t'].includes(s.choice))) address(roles.holderLedger, 'holder ledger');
  if (spec.boxType === 4) address(roles.starterLoader, 'starter loader');
  if ([4, 5].includes(spec.boxType)) address(roles.vault, 'vault');
  const calls = buildCreateCallsV2({ chainId: 11155111, creator, factory, spec, cs: f.cs, hs: f.hs, bootstrapQ,
    coordinator: roles.coordinator, vault: roles.vault, starterLoader: roles.starterLoader, starterItems: starter });
  const creation = calls.filter(c => ['approve', 'createBox'].includes(c.kind));
  if (spec.pricing.token !== zeroAddress) {
    creation.unshift(approval(spec.pricing.token, factory, 0n));
    creation.push(approval(spec.pricing.token, factory, 0n));
  }
  const post = [];
  for (const c of calls.filter(c => !['approve', 'createBox'].includes(c.kind))) {
    if (c.kind === 'loadStarter') {
      // ERC721 transfer is pulled by ShopVault, not by the loader. Exact per-id approval clears on transfer.
      if (!post.some(t => t.kind === 'approveNFT')) for (const item of starter) post.push(call(item.collection, erc721Abi, 'approve', [roles.vault, item.id], 0n, 'approveNFT'));
    }
    let seedCoin, seedAmount;
    if (c.kind === 'loadSeed') { const pile = pileConfigV2(spec.contentsParams); seedCoin = pile.asset; seedAmount = pile.seedAmount; }
    if (c.kind === 'fundSeed') { seedCoin = roles.token; seedAmount = shopConfigV2(spec.contentsParams).seedT; }
    if (seedCoin && seedCoin !== zeroAddress) post.push(approval(seedCoin, roles.vault, 0n), approval(seedCoin, roles.vault, seedAmount));
    post.push(c);
    if (seedCoin && seedCoin !== zeroAddress) post.push(approval(seedCoin, roles.vault, 0n));
  }
  if (roles.holderLedger) post.push(call(address(roles.holderLedger, 'holder ledger'), registerAbi, 'register'));
  const verify = { chainId: CHAIN, evidenceBlock: f.evidenceBlock, id: f.id, creator, factory,
    specHash: keccak256(encodeBoxSpecV2(spec)), priceCoin: spec.pricing.token, roles,
    checks: ['creator', 'factory', 'specHash', 'token', 'q', 'gateOpen', 'failed', 'graduated'],
    roleNumbers: { token: '1', vault: '3', holderLedger: '17', starterLoader: '19' },
    keeper: { schema: 'squarehole.monitor-keeper.v1', chainId: CHAIN, complete: true, maxAgeSeconds: '300',
      view: '/var/lib/docker/volumes/squarehole_keeper_state/_data/monitor.json', requireDrandComplete: spec.artMode === 2 } };
  return { id: f.id, listing: { ...f.listing, symbol: priceSymbol(e.priceCoin.symbol, CHAIN) },
    create: safeBatch(creator, `${e.name}: create`, creation), afterCreate: safeBatch(creator, `${e.name}: load and register`, post),
    starter, verify, buy: buyPlan(spec.raise.toString(), roles.coordinator), openReveals: openRevealPlan(e, roles.coordinator),
    preflight: ['All snapshot fields require fresh same-block reads before signing; this offline compiler attests no deployed state.',
      'Verify Safe owners/threshold/receiving support. Sign create first; verify receipt, predicted coordinator/token and roles before the second batch.',
      'Compare settings specHash, factory listing, bootstrap and predictBox using the supplied salts. Use findCreateSaltsV2/create-example-v2 to obtain valid salts.',
      'Check NFT ownership, token balances and zero final allowances; simulate the entire after-create batch from the creator Safe.',
      'Schedule openAt with time for preparation. openAt=0 may open immediately after the last load; launch window lasts only 384 seconds.',
      ...(f.id === 'the-alchemist' ? ['Resolve the mature Alchemist directory row at the same block and validate its release, codehash, tPEPE/tGOLD route, cap and trigger with create-example-v2 before signing.'] : [])] };
}

function buyPlan(raise, coordinator = null) {
  return { tool: 'packages/chain/scripts/buy-v2.mjs', protocol: 'v2',
    box: coordinator, mode: 'launch', amountIn: raise === null ? null : (BigInt(raise) * 16n).toString(),
    reason: 'Gross ceiling covers even the first 93.1974% launch-tax step and 1% LP fee. Closing fills refund unused input. This is a budget, not the spend quote.',
    sequence: ['Read effectiveOpenAt, gateOpen, hook.closed and windowEndsAt; stop buying when closed.',
      'Use buy-v2 --quote-only with a fresh deadline inside the 384-second window. Execute exact approvals, then re-quote at a NEW block.',
      'Use returned buy eth_call output with --quote-out, --quote-block and --slippage-bps 100. Review unsigned transaction before signing.',
      'Clear remaining approval after success or failure. Do not buy again once hook.closed, even while graduation is pending.',
      'Run keeper processing and hidden-kit drand/reveal prerequisites; acceptance requires coordinator.graduated, not just hook.closed.'],
    fixedArgs: ['--chain-id', CHAIN, '--mode', 'launch'],
    runtimeArgs: ['--box', '--from', '--amount-in', '--deadline', '--rpc', '--key-file'],
    keyFile: 'UNUSED-OFFLINE', note: 'buy-v2 requires a printed-only key-file argument. Use UNUSED-OFFLINE for unsigned preparation; it is never read. Do not run its printed send commands in this lane.' };
}
function openRevealPlan(e, coordinator = null) {
  if (e.contents.kind !== 'collection' || e.contents.art.mode !== 'open') return null;
  const expected = OPEN_REVEAL_SETS[e.id];
  assert.ok(expected, 'open kit needs reviewed art expectations');
  const { itemCount, modelHashes } = expected;
  return { tool: 'packages/chain/scripts/reveal-open-v2.ts', protocol: 'v2', status: 'after-creation-required',
    kit: e.id, box: coordinator, source: 'created-box-download',
    art: { kind: 'one-of-a-kind', itemCount, imageHashes: 'distinct', modelHashes,
      modelFormat: modelHashes === 'nonzero' ? 'GLB' : null, animationUrl: modelHashes === 'nonzero' ? 'required' : 'absent' },
    revealSends: itemCount, modelUploadTransactions: '0', prepareArgs: ['--kit', e.id], senderSheet: null,
    gas: { status: 'fresh-simulation-required', totalGas: null, maxFeePerGasWei: null, fundingWei: null },
    sequence: ['Require T01/T02 acceptance of the FINAL created-box format-2 download and its complete public list. Load settings deals fresh salts; a portable kit template is not the final download.',
      'After creation, verify the receipt, chain, coordinator, collection, specHash, revealRoot and revealListId against finalized registry and collection reads. Never substitute another box’s download or rebuild its salts.',
      'Prepare unsigned calls with reveal-open-v2.ts and prepareArgs from this FINAL download. Inspect all six leaf fields (id, traits, image, avatar, model, salt) and each rebuilt proof.',
      'Publish/pin the emitted canonical reveal-list.json bytes without a trailing newline; check SHA-256 against revealListId bound by the finalized registry specHash. The template CAR list is not automatically this box’s list.',
      'Require T04 checks that the exact list, pictures and every nonzero model are reachable and hash-correct. Model assets are off-chain GLBs, with no extra model-upload transactions.',
      'Require the actual step 7 W sender sheet path and inspect its behavior before any signing; senderSheet remains null until supplied and reviewed.',
      'Simulate each remaining individual reveal from the actual sender before founder signing. Re-estimate gas and funding for nonzero model storage; calculate gas limits times fee caps and balances with bigint, serialize raw values as decimal strings.',
      'Retain receipts; verify every id’s revealed state, traits, image and model hashes, and tokenJSON image/animation_url against the final list (animation_url absent for zero models).',
      'Resume by rerunning preparation at a fresh finalized block, never from a local cursor. Already revealed ids are skipped; the full canonical list is still emitted.'],
    note: 'Preparation plan only. Across four kits: 1744 individual reveals, 920 with models and 824 without. Final lists, hashes, calldata and gas/funding values are pending creation and simulation. The helper never signs, sends or pins.' };
}
const jsonFile = (path, value) => writeFileSync(path, `${stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
export function writePack(directory, pack, settingsText) {
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'settings.json'), settingsText, { flag: 'wx', mode: 0o600 });
  for (const [file, value] of [['listing', pack.listing], ['create-safe', pack.create], ['after-create-safe', pack.afterCreate],
    ['starter', pack.starter], ['buy-v2', pack.buy], ['verify', pack.verify], ['preflight', pack.preflight]]) jsonFile(join(directory, `${file}.json`), value);
  if (pack.openReveals) jsonFile(join(directory, 'open-reveals.json'), pack.openReveals);
}

/** Address-free folders are requests, never falsely executable settings or placeholder Safe transactions. */
export function writeTemplates(directory) {
  mkdirSync(directory, { mode: 0o700 });
  jsonFile(join(directory, 'infrastructure-inputs.json'), { coins: Object.fromEntries([...TEST_COINS.keys()].map(s => [s, null])), helper: null, owner: null, deadline: null });
  jsonFile(join(directory, 'pool-parameters.json'), Object.fromEntries(Object.entries(POOLS).map(([symbol, [sqrtPriceX96, amount1Max]]) =>
    [symbol, { coin: null, sqrtPriceX96, amount0Max: '1000000000000000000', amount1Max, tickLower: '-887220', tickUpper: '887220', deadline: null, calls: ['approve(helper,amount1Max)', 'seed(parameters)', 'approve(helper,0)'] }])));
  const native = buildBatch([]);
  jsonFile(join(directory, 'platform-batch-parameters.json'), { chainId: CHAIN, safe: native.meta.createdFromSafeAddress,
    first: native.transactions[0], listings: [...TEST_COINS].map(([symbol, preset]) => ({ symbol, ...preset, token: null, approval: '10000', finalApproval: '0', ...(symbol === 'tFROG' ? { selector: '0x42966c68' } : {}) })) });
  for (const id of KIT_IDS) {
    const e = loadExamples().find(row => row.id === id);
    const symbol = priceSymbol(e.priceCoin.symbol, CHAIN);
    const raise = symbol === 'ETH' ? NATIVE_RAISE : TEST_COINS.get(symbol)?.raise ?? null;
    const kit = join(directory, id); mkdirSync(kit, { mode: 0o700 });
    const openReveals = openRevealPlan(e);
    const common = { id, status: 'inputs-required', protocol: 'v2', chainId: CHAIN,
      settingsFile: null, source: `examples/boxes/${id}/${openReveals ? 'build' : 'settings'}/`, settingsOwner: 'L1 final settings, fully bound; existing templates are not final launch inputs' };
    jsonFile(join(kit, 'request.json'), { ...common,
      listing: { id: symbol === 'ETH' ? '0' : null, symbol, token: symbol === 'ETH' ? zeroAddress : null, decimals: e.priceCoin.decimals,
        class: symbol === 'ETH' ? '1' : ({ STANDARD: '2', STABLE: '3', STOCK: '4', OTHER: '5' })[TEST_COINS.get(symbol)?.class], kind: '1', raise,
        ...(symbol === 'tFROG' ? { burnSelector: '0x42966c68' } : {}) },
      nativeRaise: NATIVE_RAISE, bootstrapQ: null, evidenceBlock: null, cs: null, hs: null,
      inputs: { creator: null, factory: RELEASE.factory, listingId: symbol === 'ETH' ? '0' : null, assets: e.contents.seed && e.contents.seed.symbol !== 'ETH' ? { [e.contents.seed.symbol]: null } : {},
        collections: Object.fromEntries((e.contents.shop?.collections ?? []).map(c => [c.id, null])), ...(id === 'the-alchemist' ? { alchemistId: null } : {}) },
      roles: { coordinator: null, token: null, ...(['pile', 'shop'].includes(e.contents.kind) ? { vault: null } : {}),
        ...(e.contents.kind === 'shop' ? { starterLoader: null } : {}),
        ...(Object.values(e.fees).some(s => ['holders', 'holders-t'].includes(s.choice)) ? { holderLedger: null } : {}) },
      pileSeed: e.contents.seed, hidden: e.contents.art.mode === 'hidden', ...(id === 'paper-certificates' ? { edition: 'specimen-0' } : {}) });
    jsonFile(join(kit, 'buy-v2.json'), buyPlan(raise));
    if (openReveals) jsonFile(join(kit, 'open-reveals.json'), openReveals);
    if (id === 'junkyard') {
      const q = BigInt(raise), bootstrap = (q * 1500000000000000n + BASE_RAISE - 1n) / BASE_RAISE;
      const creatorBuy = quoteJunkyardCreatorBuy(q, bootstrap), estimatedTokensOut = estimateJunkyardTokensOut(q, bootstrap, creatorBuy);
      const minimumTokensOut = junkyardMinimumTokensOut(q, bootstrap, creatorBuy);
      const seedTokens = BigInt(e.contents.shop.seedT);
      jsonFile(join(kit, 'creator-buy.json'), { symbol, raise, bootstrap, creatorBuy, factoryPayment: bootstrap + creatorBuy,
        outputPolicy: 'minimum-for-measured-preset', targetTokens: JUNKYARD_TARGET_T, estimatedTokensOut, minimumTokensOut,
        targetShortfallBound: JUNKYARD_TARGET_T - minimumTokensOut, estimateShortfallBound: estimatedTokensOut - minimumTokensOut,
        seedTokens, minimumHolderRemainder: minimumTokensOut - seedTokens,
        assumptions: ['Saved raise/bootstrap/creatorBuy only; Q currency0, initial curve endpoints, bootstrap then creator swap.',
          '10000-pip LP fee and zero protocol fee; bound reproduced by the af1 local EVM and independent PoolManager step vector.'],
        note: 'Historical target and analytical estimate are not guaranteed outputs. Minimum applies only to this measured preset. Obtain a fresh actual-chain quote and simulation before binding final settings or signing.' });
    }
    writeFileSync(join(kit, 'README.md'), `# ${e.name}\n\nInputs pending. Follow docs/runbooks/sepolia-examples.md.\nSupply final L1 settings and pinned public bindings, then compile into a new folder.\n${id === 'link-marines-v2' ? 'The version 2 kit means 420 marines, MARINE and tLINK rations on both fee sides (Items/Depth); inside shares deepen the box’s own pool. It uses BoxSpecV2, the v2 factory and buy-v2. Its registry row is ready: the local contract and browser lives pass. That is not a Sepolia deployment.\n' : ''}${openReveals ? 'After creation, follow open-reveals.json using the created box’s own download and the reviewed reveal-open-v2.ts tool.\n' : ''}${e.contents.art.mode === 'hidden' ? 'Keep hidden items, salts and reveals private; settings may contain only public commitments and placeholders.\n' : ''}${id === 'lake-house' ? 'Lake House (SH-LAKE-HOUSE) is created by its company Safe. Its tUSDC pile starts empty, so there is no seed transfer and the after-create batch is empty; both fee sides go to the pile and nothing is left behind. Its registry row waits on EXAMPLE-LIFE.\n' : ''}`, { flag: 'wx' });
  }
}
function isEntry() { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } }
if (isEntry()) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--templates') writeTemplates(args[1]);
    else {
      assert.ok(args.length === 4 && ['--inputs', '--infrastructure'].includes(args[0]) && args[2] === '--out', 'usage');
      const input = JSON.parse(readFileSync(args[1], 'utf8'));
      if (args[0] === '--infrastructure') {
        const plan = buildInfrastructure(input); mkdirSync(args[3], { mode: 0o700 });
        for (const [name, value] of Object.entries(plan)) jsonFile(join(args[3], `${name}.json`), value);
      } else {
        const settingsText = readFileSync(input.settingsFile, 'utf8');
        writePack(args[3], await buildKitPack({ ...input, settingsText }), settingsText);
      }
    }
    process.stdout.write('Wrote unsigned pack files. No chain reads, signatures or transactions.\n');
  } catch { process.stderr.write('Launch pack refused. Use --templates NEW_DIR, --infrastructure PUBLIC_JSON --out NEW_DIR, or --inputs PUBLIC_JSON --out NEW_DIR; check bindings and final settings.\n'); process.exitCode = 1; }
}
