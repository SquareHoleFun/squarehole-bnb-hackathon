#!/usr/bin/env node
/** SH-V2-MAINNET-RUNBOOK. Public reads only. No signer, environment secrets or transaction submission. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBoxSpecLibrary } from '../../packages/box-spec/scripts/lib/load-generated.mjs';
import { KNOWN_TEST_ROOTS } from '../../packages/box-spec/scripts/write-mainnet-box0-spec.mjs';
import { Refusal as ListingRefusal } from '../listing/common.mjs';
import { checkRoyaltyLot, rawAmount } from '../listing/royalty-lots.mjs';
import { realpathSync } from 'node:fs';

const { keccak256, toHex, parseAbi, encodeFunctionData, decodeFunctionResult } =
  createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
const ZERO = `0x${'0'.repeat(40)}`;
const SENTINEL = `0x${'0'.repeat(39)}1`;
const GENERATOR = `0x1a29e4a78b7ace9c3ffe5dff2b6fd4e6a7db0416${'0'.repeat(24)}`; // F125
const PLATFORM = '0xdce82e76456434d0f550b492ff212a862221e6c5';
const STEPS = ['edition', 'preflight', 'box0', 'v2', 'listing', 'open'];
// Core v1 BoxPhase, packages/contracts/src/box/interfaces/BoxTypes.sol.
const BOX0_PHASES = ['None', 'Upcoming', 'Window', 'Bonding', 'Closed', 'Graduated', 'Failed'];
const GATES = ['edition-sealed', 'counsel-terms', 'q16', 'box0-review', 'box0-rehearsal', 'v2-sepolia', 'v2-m3', 'hosting'];
const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);
const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
class Refusal extends Error {}
const need = (ok, reason) => { if (!ok) throw new Refusal(reason); };
const same = (a, b, label) => need(String(a).toLowerCase() === String(b).toLowerCase(), `${label} mismatch`);
const digest = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/.test(v);
const address = (v) => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && v.toLowerCase() !== ZERO;
const raw = (v) => {
  need(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v), 'expected decimal string');
  const n = BigInt(v); need(n < 1n << 256n, 'integer exceeds uint256'); return n;
};
const quantity = (v) => {
  need(typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(v), 'invalid RPC quantity');
  return BigInt(v);
};
async function readJson(path) {
  const stat = await lstat(path);
  need(stat.isFile() && stat.size <= 4_194_304, 'public JSON must be a regular file under 4 MiB');
  const bytes = await readFile(path);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}
async function attachment(base, ref) {
  need(ref && typeof ref.path === 'string' && !isAbsolute(ref.path) && !ref.path.split(/[\\/]/).includes('..')
    && digest(ref.sha256), 'invalid public attachment');
  const path = resolve(base, ref.path);
  const rel = relative(base, await realpath(path));
  need(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'attachment leaves public folder');
  const file = await readJson(path);
  same(sha256(file.bytes), ref.sha256, 'attachment hash');
  return file.value;
}
async function edition(m, base) {
  const [pub, table, doc, trustees] = await Promise.all(['commitment', 'table', 'spec', 'trustees'].map((name) => attachment(base, m.files?.[name])));
  need(pub.format === 'squarehole.box0-commitment/1' && table.format === 'squarehole.box-trait-table/1'
    && doc.format === 'squarehole.box0-spec/1' && doc.chainId === 1 && doc.build === 'mainnet', 'wrong public file format or chain/build');
  const lib = await loadBoxSpecLibrary();
  const spec = lib.decodeBoxSpecV1(doc.encoded);
  same(lib.encodeBoxSpecV1(spec), doc.encoded, 'canonical spec encoding');
  same(lib.specHash(spec), doc.specHash, 'spec hash');
  need(lib.validateBoxSpecV1(spec, lib.CONTEXT_V1).reason === 0, 'invalid box 0 spec');
  const count = raw(m.editionCount);
  need(count > 0n && count <= 8192n, 'edition count outside tree bounds');
  same(spec.n, count, 'encoded edition count'); same(pub.n, count, 'sealed edition count');
  let depth = 0n; while ((1n << depth) < count) depth++;
  same(pub.depth, depth, 'tree depth');
  need(digest(pub.root), 'invalid edition root'); same(spec.revealRoot, pub.root, 'root');
  // Known public fixture roots must never become launch inputs.
  need(!KNOWN_TEST_ROOTS.includes(pub.root.toLowerCase()), 'test root refused');
  same(spec.generatorHash, GENERATOR, 'F125 generator'); same(pub.generatorHash, GENERATOR, 'sealed generator');
  same(pub.generatorTree, GENERATOR.slice(2,42), 'generator tree'); same(pub.renderGeneratorTree, pub.generatorTree, 'render tree');
  same(spec.metadataTable, table.table, 'table bytes'); same(keccak256(table.table), pub.metadataTable?.hash, 'table hash');
  same((table.table.length - 2) / 2, pub.metadataTable?.bytes, 'table length');
  same(spec.marketplaceOwner, PLATFORM, 'mainnet platform');
  same(spec.raise, 4206980085000000000n, 'mainnet raise'); need(BigInt(spec.openAt) > 0n, 'clock opening required');
  need(pub.encoding?.image?.format === 'webp' && pub.encoding.image.size === 512 && pub.encoding.image.quality === 90
    && pub.encoding?.avatar?.format === 'webp' && pub.encoding.avatar.size === 256 && pub.encoding?.model?.format === 'glb', 'F115 encoding required');
  need(pub.archive?.escrowIntent === 'trustees-2-of-3' && pub.archive.keySplit === 'shamir-2-of-3', 'trustee split required');
  need(trustees.format === 'squarehole.box0-key-split-receipt/1' && trustees.scheme === 'shamir-2-of-3'
    && trustees.threshold === 2 && trustees.shareFiles?.length === 3 && trustees.verified?.length === 3, 'trustee recovery receipt required');
  need(digest(pub.archive.sha256) && digest(pub.archive.keyId), 'archive commitments required');
  same(trustees.archiveSha256, pub.archive.sha256, 'trustee archive'); same(trustees.keyId, pub.archive.keyId, 'trustee key id');
  need(new Set(trustees.shareFiles.map((s) => s.trustee)).size === 3
    && trustees.shareFiles.every((s) => [1,2,3].includes(s.trustee) && digest(s.sha256)), 'invalid trustee shares receipt');
  return { spec, specHash: doc.specHash };
}
async function gates(m, base, specHash, ids) {
  for (const id of ids) {
    const g = await attachment(base, m.gates?.[id]);
    need(g.id === id && g.result === 'pass' && g.candidate === m.candidate && g.specHash === specHash
      && typeof g.reviewer === 'string' && g.reviewer.trim() && typeof g.evidence === 'string' && g.evidence.trim(), 'missing or stale human gate');
  }
}
function reader(rpcUrl, fetch) {
  const url = new URL(rpcUrl);
  need(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)), 'RPC must be HTTPS or local HTTP');
  need(!url.username && !url.password && !url.hash, 'invalid RPC URL');
  let id = 0;
  return async (method, params) => {
    need(METHODS.has(method), 'RPC method refused');
    let result;
    try {
      const response = await fetch(url.href, { method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
        headers:{ 'content-type':'application/json' }, body:JSON.stringify({ jsonrpc:'2.0', id:++id, method, params }) });
      need(response.ok, 'RPC transport failed');
      const json = await response.json();
      need(json.jsonrpc === '2.0' && json.id === id && !json.error && json.result !== undefined && json.result !== null, 'RPC read failed');
      result = json.result;
    } catch { throw new Refusal('RPC read failed; details suppressed'); }
    return result;
  };
}
/**
 * Our keeper reads at most 32 frozen-list rows per inbox (`MAX_INBOX_COINS`, packages/keeper/src/chain.ts) and the
 * indexer 32 rows in all (`INBOX_COIN_READ_LIMIT`, packages/chain/src/core/v2/royalty-v21.ts), which also hold ETH, the
 * box's own T and coins learned from receipts. Every box freezes the sale list it is created with, so a longer list
 * would leave coins our keeper never refreshes and an inbox the site shows incomplete for the box's life (LIM-3).
 */
export const MAX_SALE_LIST = 28n;
async function saleLots(view, rpc, v, receipt, height, time) {
  need(receipt?.format === 'squarehole.royalty-lots/1' && receipt.chainId === '1', 'royalty lot receipt required');
  same(receipt.registry, v.listingRegistry, 'royalty lot registry');
  const weth = await view(v.listingRegistry, 'weth() view returns (address)');
  same(receipt.weth, weth, 'royalty lot WETH');
  same(await view(v.factory, 'weth() view returns (address)'), weth, 'factory WETH');
  need(Array.isArray(receipt.entries) && receipt.entries.length <= 1000, 'royalty lot entries required');
  const records = new Map();
  for (const entry of receipt.entries) {
    need(address(entry.token) && !records.has(entry.token.toLowerCase()), 'duplicate or invalid royalty lot coin');
    records.set(entry.token.toLowerCase(), entry);
  }
  const version = await view(v.listingRegistry, 'sellableVersion() view returns (uint256)');
  const count = await view(v.listingRegistry, 'sellableCount(uint256) view returns (uint256)', [version]);
  need(version > 0n && count > 0n && count <= 1000n, 'invalid royalty sale list size');
  need(count <= MAX_SALE_LIST, `royalty sale list holds ${count} coins, more than the ${MAX_SALE_LIST} our keeper and indexer read per inbox`);
  const seen = new Set(), priceBlocks = new Map();
  for (let i = 0n; i < count; i++) {
    const token = (await view(v.listingRegistry, 'sellableToken(uint256) view returns (address)', [i])).toLowerCase();
    need(address(token) && !seen.has(token), 'invalid royalty sale list coin');
    seen.add(token);
    if (token === weth.toLowerCase()) continue; // Native row 0 supplies WETH; no outside-market price is needed.
    const [listed, id] = await view(v.listingRegistry, 'newestListingOf(address) view returns (bool,uint32)', [token]);
    need(listed, 'royalty sale coin is not listed');
    const row = await view(v.listingRegistry, 'listing(uint32) view returns ((uint32 id,address token,uint8 decimals,uint8 class,uint8 kind,uint64 listedAt,uint256 raise,(uint256 bootstrapQ,uint256 batchMinQ,uint256 tipMaxQ,uint256 swapStepMinQ) q))', [id]);
    same(row.token, token, 'royalty listing token'); same(row.id, id, 'royalty listing id');
    need(row.kind === 1, 'royalty sale list contains a box token');
    const lot = await view(v.listingRegistry, 'sellableLotAt(address,uint256) view returns (uint256)', [token, version]);
    const entry = records.get(token);
    need(entry, `royalty lot price missing for ${token}`);
    const coinClass = { 3: 'STABLE', 4: 'STOCK', 5: 'OTHER' }[row.class];
    checkRoyaltyLot(lot, BigInt(row.decimals), coinClass, entry.price);
    same(rawAmount(entry.listingId), id, 'royalty lot listing id');
    same(rawAmount(entry.lot), lot, 'recorded royalty lot');
    const priceHeight = rawAmount(entry.price.blockNumber), priceTime = rawAmount(entry.price.timestamp);
    need(priceHeight <= height && priceTime <= time, 'royalty lot price is in the future');
    if (!priceBlocks.has(priceHeight)) priceBlocks.set(priceHeight, await rpc('eth_getBlockByNumber', [`0x${priceHeight.toString(16)}`, false]));
    const priceBlock = priceBlocks.get(priceHeight);
    same(quantity(priceBlock.number), priceHeight, 'royalty price block number');
    same(priceBlock.hash, entry.price.blockHash, 'royalty price block hash');
    same(quantity(priceBlock.timestamp), priceTime, 'royalty price block timestamp');
    records.delete(token);
  }
  need(seen.has(weth.toLowerCase()), 'royalty sale list missing WETH');
  need(records.size === 0, 'royalty lot receipt contains coins outside the sale list');
  return version.toString();
}
/**
 * The custody roles the Safe checks expect (F151 R68-SAFE, F164 D2), named in the public manifest as the burn bot's
 * configuration names them: `owners: { founder, bot, backup }`. Missing, partial or repeated roles are refused, so a
 * manifest that predates the 2-of-3 platform Safe cannot pass.
 */
export function custody(m) {
  const o = m.owners;
  need(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === 'backup,bot,founder'
    && ['founder','bot','backup'].every((k) => address(o[k]) && o[k].toLowerCase() !== SENTINEL), 'owners roles required: founder, bot, backup');
  const roles = { founder:o.founder.toLowerCase(), bot:o.bot.toLowerCase(), backup:o.backup.toLowerCase() };
  need(new Set(Object.values(roles)).size === 3, 'owners roles must be three distinct accounts');
  return roles;
}
async function chain(m, spec, step, rpc, now, royaltyLots) {
  same(quantity(await rpc('eth_chainId', [])), 1n, 'chain');
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
  const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
  need(digest(block.hash), 'missing finalized block');
  const time = quantity(block.timestamp), height = quantity(block.number), live = quantity(latest.timestamp);
  need(live <= now + 60n && live + 120n >= now && time <= live && time + 1800n >= live
    && height <= quantity(latest.number), 'stale or inconsistent RPC clock');
  const at = { blockHash:block.hash, requireCanonical:true };
  async function view(to, signature, args = []) {
    need(address(to), 'view address required');
    const abi = parseAbi([`function ${signature}`]);
    const functionName = abi[0].name;
    const data = encodeFunctionData({ abi, functionName, args });
    return decodeFunctionResult({ abi, functionName, data:await rpc('eth_call', [{ to, data }, at]) });
  }
  async function codeAt(a, pin, releasePart = false) {
    need(address(a) && digest(pin), 'code pin required');
    const bytes = await rpc('eth_getCode', [a, at]);
    need(typeof bytes === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(bytes), 'missing code');
    same(keccak256(bytes), pin, 'runtime code');
    if (releasePart) need((bytes.length - 2) / 2 <= 22118, 'release runtime exceeds 22,118 bytes');
  }
  const roles = custody(m);
  const safeAddresses = Object.values(m.safes ?? {}).map((s) => s.address?.toLowerCase());
  // RC5-C: two protocol Safes; royalties stay in each box's inbox (F136, F138).
  need(safeAddresses.length === 2 && new Set(safeAddresses).size === 2, 'two distinct Safes required');
  for (const name of ['fit','platform']) {
    const s = m.safes[name];
    need(s && ['1.4.1','1.5.0'].includes(s.version), 'reviewed Safe version required');
    await codeAt(s.address,s.codeHash); await codeAt(s.singleton,s.singletonCodeHash);
    same(await view(s.address,'masterCopy() view returns (address)'),s.singleton,'Safe singleton');
    same(await view(s.address,'VERSION() view returns (string)'),s.version,'Safe version');
    // F151 R68-SAFE: both Safes are 2-of-3 on mainnet. The expected owners are the manifest's (its `owners` roles name
    // the founder, the bot and the backup); the platform's other two are the founder's picks, never the bot (F164 D2).
    same(s.threshold,'2','Safe threshold pin');
    same(await view(s.address,'getThreshold() view returns (uint256)'),'2','Safe threshold');
    need(Array.isArray(s.owners), 'invalid Safe owners');
    const expected = s.owners.map((o) => String(o).toLowerCase()).sort();
    need(expected.length === 3 && new Set(expected).size === 3
      && expected.every((o) => address(o) && o !== SENTINEL), 'invalid Safe owners');
    if (name === 'fit') same(expected.join(),[roles.bot,roles.founder,roles.backup].sort().join(),'FIT owners (bot, founder, backup)');
    else {
      need(expected.includes(roles.founder),'founder missing from the platform Safe');
      need(!expected.includes(roles.bot),'the bot is never a platform Safe owner');
    }
    // Safe's getOwners() lists the newest owner first, so the founder may come last: compare as a set.
    same((await view(s.address,'getOwners() view returns (address[])')).map((o) => o.toLowerCase()).sort().join(),expected.join(),'Safe owners');
    const [modules,next] = await view(s.address,'getModulesPaginated(address,uint256) view returns (address[],address)',[SENTINEL,1n]);
    need(modules.length === 0 && next.toLowerCase() === SENTINEL,'Safe module enabled');
    for (const [field,label] of [['guard','guard_manager.guard.address'],['handler','fallback_manager.handler.address']]) {
      const value = await rpc('eth_getStorageAt',[s.address,keccak256(toHex(label)),at]);
      need(/^0x0{24}[0-9a-f]{40}$/i.test(value), 'invalid Safe storage');
      same(`0x${value.slice(-40)}`,s[field],`Safe ${field}`);
      if (s[field] !== ZERO) await codeAt(s[field],s[`${field}CodeHash`]);
    }
  }
  same(m.safes.platform.address,PLATFORM,'platform Safe');
  if (step === 'preflight') need(BigInt(spec.openAt) >= live + 2700n && BigInt(spec.openAt) <= live + 1209600n,'opening must be 45 minutes to 14 days ahead');
  if (['box0','v2','listing','open'].includes(step)) {
    const b = m.box0;
    const lib = await loadBoxSpecLibrary();
    for (const a of Object.values(b)) await codeAt(a,m.code?.[a.toLowerCase()]);
    same(await view(b.registry,'coordinatorOf(uint256) view returns (address)',[0n]),b.coordinator,'registry box 0');
    for (const field of ['factory','hook','collection','token','receiver','executor','randomness','poolManager'])
      same(await view(b.coordinator,`${field}() view returns (address)`),b[field],`box 0 ${field}`);
    // F143 (rc8 open item 76): box 0's source is the pinned BoxBackedSource and its DRAND() the pinned DrandSource, each
    // by address and runtime code at this finalized block, independent of the manifest's own code map.
    same(b.randomness,lib.RANDOMNESS_SOURCE,'box 0 randomness source');
    await codeAt(b.randomness,lib.RANDOMNESS_SOURCE_CODE_HASH);
    const drand = await view(b.randomness,'DRAND() view returns (address)');
    same(drand,lib.DRAND_SOURCE,'backed source DRAND');
    await codeAt(drand,lib.DRAND_SOURCE_CODE_HASH);
    for (const [signature,expected] of [['kind() view returns (uint8)',1],['boxId() view returns (uint256)',0n],
      ['q() view returns (address)',ZERO],['raise() view returns (uint256)',spec.raise],['specHash() view returns (bytes32)',keccak256(lib.encodeBoxSpecV1(spec))]])
      same(await view(b.coordinator,signature),expected,'box 0 identity');
    same(await view(b.hook,'openAt() view returns (uint256)'),spec.openAt,'box 0 open time');
    same(await view(b.hook,'windowEndsAt() view returns (uint256)'),BigInt(spec.openAt) + 384n,'launch window');
    for (const [signature,expected] of [['collectionSize() view returns (uint256)',spec.n],['revealRoot() view returns (bytes32)',spec.revealRoot],
      ['generatorHash() view returns (bytes32)',spec.generatorHash],['metadataTableHash() view returns (bytes32)',keccak256(spec.metadataTable)],['owner() view returns (address)',PLATFORM]])
      same(await view(b.collection,signature),expected,'collection commitment');
    same(await view(b.receiver,'platformSafe() view returns (address)'),PLATFORM,'box 0 platform');
  }
  let sellableVersion;
  if (['v2','listing','open'].includes(step)) {
    const v = m.v2;
    need(v.implementations?.length === 24, '24 implementation slots required');
    for (const role of [0,1,2,3,4,5,6,7,8,16,17,19,20,21,22]) need(address(v.implementations[role]),'M1-M3 release part missing');
    for (const role of [9,10,11,12,13,14,15,18,23]) same(v.implementations[role],ZERO,'reserved release slot');
    for (const a of [v.factory,v.registry,v.listingRegistry,...v.implementations.filter((a) => a !== ZERO)]) await codeAt(a,m.code?.[a.toLowerCase()],true);
    same(await view(v.factory,'VERSION() view returns (uint16)'),2,'v2 version');
    for (const field of ['registry','listingRegistry']) same(await view(v.factory,`${field}() view returns (address)`),v[field],`v2 ${field}`);
    same(await view(v.factory,'versionCodeHash() view returns (bytes32)'),v.versionCodeHash,'release commitment');
    same(await view(v.registry,'factory() view returns (address)'),v.factory,'v2 registry factory');
    const directory = await view(v.registry,'directory() view returns (address[])');
    need(directory.length === 1,'unexpected registry directory'); same(directory[0],m.box0.registry,'genesis registry');
    same(await view(v.listingRegistry,'lister() view returns (address)'),PLATFORM,'lister');
    for (const [role,a] of v.implementations.entries()) same(await view(v.factory,'implementation(uint256) view returns (address)',[BigInt(role)]),a,'implementation');
    for (const name of ['fit','platform']) same(await view(v.implementations[5],`${name.toUpperCase()}_SAFE() view returns (address)`),m.safes[name].address,'receiver Safe');
    // RC6 inbox (F138): the release's CoW wiring is immutable in the inbox implementation (role 8).
    const cow = v.cow ?? {};
    need(address(cow.composableCow) && address(cow.settlement) && address(cow.handler) && digest(cow.domainSeparator), 'CoW release inputs required');
    const inbox = v.implementations[8];
    for (const [field, want] of [['composableCow', cow.composableCow], ['settlement', cow.settlement], ['cowHandler', cow.handler]])
      same(await view(inbox,`${field}() view returns (address)`),want,`inbox ${field}`);
    same(await view(inbox,'minimumLot() view returns (uint256)'),raw(cow.minimumLot),'inbox WETH minimum');
    const relayer = await view(cow.settlement,'vaultRelayer() view returns (address)');
    same(await view(inbox,'vaultRelayer() view returns (address)'),relayer,'inbox VaultRelayer');
    same(await view(cow.settlement,'domainSeparator() view returns (bytes32)'),cow.domainSeparator,'CoW domain');
    for (const a of [cow.composableCow, cow.settlement, relayer]) await codeAt(a,m.code?.[a.toLowerCase()]);
    await codeAt(cow.handler,m.code?.[cow.handler.toLowerCase()],true);
    sellableVersion = await saleLots(view, rpc, v, royaltyLots, height, time);
  }
  let box0Phase;
  if (step === 'open') {
    need(time >= BigInt(spec.openAt),'box 0 not open at finalized block');
    const phase = await view(m.box0.hook,'phase() view returns (uint8)');
    same(await view(m.box0.coordinator,'phase() view returns (uint8)'),phase,'box 0 phase');
    box0Phase = BOX0_PHASES[phase];
    // V1 phase() gives migration precedence: closed() stays true after graduation.
    need(['Window','Bonding','Graduated'].includes(box0Phase),`box 0 phase ${box0Phase ?? phase} not tradable`);
  }
  same((await rpc('eth_getBlockByNumber',[block.number,false])).hash,block.hash,'canonical block');
  return { blockNumber:height.toString(), blockHash:block.hash, timestamp:time.toString(), box0Phase, sellableVersion };
}

export async function runCli(argv, { fetch = globalThis.fetch, now = () => BigInt(Math.floor(Date.now()/1000)),
  stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      stdout('Usage: node scripts/box/launch-check.mjs --step edition|preflight|box0|v2|listing|open --manifest PUBLIC.json [--rpc-url URL]\nPublic JSON and RPC reads only. See docs/runbooks/mainnet-core-v2.md for the input schema.\n'); return 0;
    }
    const o = {};
    for (let i = 0; i < argv.length; i += 2) {
      need(['--step','--manifest','--rpc-url'].includes(argv[i]) && !Object.hasOwn(o,argv[i]) && argv[i+1] && !argv[i+1].startsWith('--'),'invalid options; use --help');
      o[argv[i]] = argv[i+1];
    }
    const step = o['--step'];
    need(STEPS.includes(step) && o['--manifest'] && (step === 'edition' ? !o['--rpc-url'] : o['--rpc-url']),'step, public manifest and explicit RPC required (edition is offline)');
    const file = resolve(o['--manifest']); const base = await realpath(dirname(file));
    const { value:m } = await readJson(file);
    need(m.format === 'squarehole.mainnet-launch/1' && m.chainId === '1' && /^[0-9a-f]{40}$/.test(m.candidate),'invalid launch manifest');
    const { spec,specHash } = await edition(m,base);
    const ids = step === 'edition' ? ['edition-sealed'] : [...GATES, ...(step === 'open' ? ['release-published'] : [])];
    await gates(m,base,specHash,ids);
    const royaltyLots = ['v2','listing','open'].includes(step) ? await attachment(base, m.v2?.royaltyLots) : undefined;
    const observed = step === 'edition' ? {} : await chain(m,spec,step,reader(o['--rpc-url'],fetch),now(),royaltyLots);
    stdout(`${JSON.stringify({ result:'pass',step,chainId:'1',candidate:m.candidate,specHash,editionCount:m.editionCount,
      humanAttestations:ids, ...observed, limitation:'Public consistency checks; human gates and receipt effects require Claude review.' })}\n`);
    return 0;
  } catch (error) {
    stderr(`launch-check: ${error instanceof Refusal || error instanceof ListingRefusal ? error.message : 'check failed; details suppressed'}\n`); return 1;
  }
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exitCode = await runCli(process.argv.slice(2));
