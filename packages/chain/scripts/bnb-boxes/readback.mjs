#!/usr/bin/env node
/**
 * SH-261: read a created box back against its settings sheet, field by field; any difference fails. Run after every
 * creation, local or real (on the test site a box was once created with the form's default money rules instead of
 * the prepared ones; this is the guard).
 *
 * What is compared:
 *   1. The spec the creation actually sent (the createBox call, decoded from its transaction) with the sheet's spec,
 *      every top-level BoxSpec field. Only the creator's own fields differ by design: the marketplace owner and the
 *      creator's payee are the creator's address where the sheet names one (Load settings never loads them).
 *   2. Its hash with the box's own `specHash()` and the registry's `BoxCreated` record: what was sent is what the box is.
 *   3. The box's own reads, independent of the spec: the price coin and its listing, the raise, both fee sides as the
 *      receiver holds them, the deadline in days, a collection's item count and pick fee, a pile's coin, seed and
 *      leave-behind, the holder ledger where holders are paid, and the creator.
 *
 *   SH_TESTNET=bnb node packages/chain/scripts/bnb-boxes/readback.mjs --rpc <url> --manifest <core-v1/97.json> --box <coordinator>
 *     --settings <file> --creator <address> [--reveal-file <the box's own reveal file: a collection>]
 *     [--tx <createBox hash> | --from-block <n>] [--out <result.json>]
 *
 * Read-only: eth_call, eth_getLogs and eth_getTransactionByHash. Works against the real test network's public RPC.
 */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import './ts.mjs';

const viem = await import('viem');
const { createPublicClient, decodeAbiParameters, decodeFunctionData, getAddress, keccak256, zeroAddress } = viem;
const { readTransport } = await import('./chain.mjs');
const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { BOX_SPEC_V2_ABI_COMPONENTS, BoxTypeV2, encodeBoxSpecV2 } = await import('../../../../apps/web/src/features/create/v2/spec-types.ts');

const SPEC = [{ type: 'tuple', components: BOX_SPEC_V2_ABI_COMPONENTS }];
const text = value => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const same = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();
/** Fields the creator fills in themselves: the sheet's address there becomes the creating wallet's. */
export const CREATOR_FIELDS = Object.freeze(['marketplaceOwner', 'creatorFeeRecipient']);
const BOX_CREATED = coreV2.registryV2Abi.find(item => item.type === 'event' && item.name === 'BoxCreated');

/** The receiver's FeeChoice for a fee side, as the factory derives it (BoxFactoryV2Parts.sol `_choice`). */
export function feeChoiceOf(side) {
  const { leg, dest } = side.a;
  if (dest === 9) return 10; // Module
  if (leg === 2 && dest === 7) return 11; // ShopT
  if (leg === 2 && dest === 1) return 2; // Burn
  if (dest === 6) return leg === 2 ? 7 : 4; // HoldersT / Holders
  if (dest === 8) return leg === 2 ? 8 : 5; // ItemsT / Items
  return { 2: 1, 1: 6, 4: 3, 7: 9 }[dest] ?? 0; // Keep, EatPriceCoin, Grow, Pile
}

/** The sheet's spec: the settings file's `encoded`, checked against its own `specHash`. */
export function sheetSpec(settingsText) {
  const body = JSON.parse(settingsText);
  assert.equal(body.format, 'squarehole.boxspec/2', 'a settings file');
  assert.equal(keccak256(body.encoded).toLowerCase(), String(body.specHash).toLowerCase(), 'the settings file is damaged');
  return decodeAbiParameters(SPEC, body.encoded)[0];
}

/** Fields an open collection's creation deals afresh: its leaves' salts set the reveal root and the list's id. */
export const SALTED_FIELDS = Object.freeze(['revealRoot', 'revealListId']);

/**
 * The sheet as this creator's box must hold it. With the box's own reveal file (a collection), the salted fields are
 * that file's, and `itemRows` compares the file's items with the sheet's, everything but the salt.
 */
export function expectedSpec(sheet, creator, reveal = null) {
  const spec = { ...sheet };
  for (const field of CREATOR_FIELDS) if (spec[field].toLowerCase() !== zeroAddress) spec[field] = getAddress(creator);
  if (reveal) for (const field of SALTED_FIELDS) spec[field] = reveal.spec[field];
  return spec;
}

/** A settings or reveal file's spec and reveal list. */
export function fileOf(text) {
  const body = JSON.parse(text);
  return { spec: sheetSpec(text), list: body.revealList ?? null };
}

/** The reveal file's items against the sheet's: id, traits, picture, avatar and model hashes equal; salts the box's own. */
export function itemRows(sheetText, revealText) {
  const sheet = fileOf(sheetText).list;
  const own = fileOf(revealText).list;
  assert.ok(sheet && own, 'both files carry a reveal list');
  const strip = item => ({ id: item.id, traitsPacked: item.traitsPacked, imageSha256: item.imageSha256.toLowerCase(), avatarSha256: item.avatarSha256.toLowerCase(), modelSha256: item.modelSha256.toLowerCase() });
  const differing = sheet.items.map(strip).filter((item, i) => !own.items[i] || JSON.stringify(item) !== JSON.stringify(strip(own.items[i])));
  const salted = own.items.filter((item, i) => item.salt !== sheet.items[i]?.salt).length;
  return { count: [sheet.items.length, own.items.length], differing: differing.length, salted };
}

/** The createBox transaction of a box: given, or found by the registry's BoxCreated event (indexed by spec hash). */
async function creation(client, registry, specHash, creator, createTx, fromBlock) {
  if (createTx) return { hash: createTx, record: null };
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const step = 5_000n;
  for (let to = latest; to >= fromBlock; to -= step) {
    const from = to - step + 1n > fromBlock ? to - step + 1n : fromBlock;
    const logs = await client.getLogs({ address: registry, event: BOX_CREATED, args: { specHash }, fromBlock: from, toBlock: to });
    const hit = logs.find(log => log.args.record.creator.toLowerCase() === creator.toLowerCase());
    if (hit) return { hash: hit.transactionHash, record: hit.args.record };
    if (from === fromBlock) break;
  }
  return { hash: null, record: null };
}

export async function readBack({ client, manifest, coordinator, settingsText, creator, revealText = null, createTx = null, fromBlock = 0n }) {
  const release = manifest.releases[0];
  const rows = [];
  const row = (group, field, sheet, chain) => rows.push({ group, field, sheet, chain, same: same(sheet, chain) });
  const sheet = sheetSpec(settingsText);
  const reveal = revealText ? fileOf(revealText) : null;
  if (sheet.boxType === BoxTypeV2.NEW_COLLECTION) assert.ok(reveal, 'a collection is read back with its own reveal file');
  const expected = expectedSpec(sheet, creator, reveal);
  if (reveal) {
    // The reveal file is this box's: every field but the salted ones is the sheet's.
    for (const { name } of BOX_SPEC_V2_ABI_COMPONENTS) if (!SALTED_FIELDS.includes(name)) row('reveal file', name, expected[name], reveal.spec[name]);
    const items = itemRows(settingsText, revealText);
    row('reveal file', 'items (id, traits, picture, avatar, model)', { count: items.count[0], differing: 0 }, { count: items.count[1], differing: items.differing });
    row('reveal file', 'every item has a fresh salt', items.count[0], items.salted);
  }
  const at = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const box = (fn, args) => at(coordinator, coreV2.coordinatorV2Abi, fn, args);
  const chainHash = await box('specHash');

  // 1. What was sent.
  const found = await creation(client, release.registry.address, chainHash, creator, createTx, BigInt(fromBlock));
  assert.ok(found.hash, 'the createBox transaction of this box was not found');
  const tx = await client.getTransaction({ hash: found.hash });
  assert.equal(tx.to.toLowerCase(), release.factory.address.toLowerCase(), 'the box was created by this release\'s factory');
  const call = decodeFunctionData({ abi: coreV2.factoryV2Abi, data: tx.input });
  assert.equal(call.functionName, 'createBox');
  const sent = call.args[0];
  for (const { name } of BOX_SPEC_V2_ABI_COMPONENTS) row('spec sent', name, expected[name], sent[name]);

  // 2. The sent spec is the box's.
  const sentHash = keccak256(encodeBoxSpecV2(sent));
  row('spec hash', 'sheet (creator fields filled)', keccak256(encodeBoxSpecV2(expected)), chainHash);
  row('spec hash', 'createBox call', sentHash, chainHash);
  if (found.record) row('spec hash', 'registry BoxCreated', chainHash, found.record.specHash);

  // 3. The box's own reads.
  const receiverAddress = await box('receiver');
  const receiver = fn => at(receiverAddress, coreV2.receiverV2Abi, fn);
  const hook = await box('hook');
  row('box', 'creator', getAddress(creator), await box('creator'));
  row('box', 'factory', release.factory.address, await box('factory'));
  row('price coin', 'token (coordinator q)', sheet.pricing.token, await box('q'));
  row('price coin', 'token (receiver q)', sheet.pricing.token, await receiver('q'));
  row('price coin', 'listing id', sheet.pricing.listingId, await box('pricingListingId'));
  row('price coin', 'raise (coordinator)', sheet.raise, await box('raise'));
  row('price coin', 'raise (hook)', sheet.raise, await at(hook, coreV2.hookV2Abi, 'raise'));
  row('fees', 'buyers choice', feeChoiceOf(sheet.buyers), Number(await receiver('buyersChoice')));
  row('fees', 'sellers choice', feeChoiceOf(sheet.sellers), Number(await receiver('sellersChoice')));
  const holders = [sheet.buyers, sheet.sellers].some(side => side.a.dest === 6);
  const holderLedger = await receiver('holderLedger');
  row('fees', 'holder ledger present', holders, holderLedger.toLowerCase() !== zeroAddress);
  row('deadline', 'days', BigInt(sheet.deadlineDays), await box('deadlineDays'));
  if (sheet.boxType === BoxTypeV2.NEW_COLLECTION) {
    const vault = await box('vault');
    row('contents', 'item count', BigInt(sheet.n), await at(vault, coreV2.vaultV2Abi, 'collectionSize'));
    row('contents', 'pick fee (bps)', BigInt(sheet.pickFeeBps), BigInt(await at(vault, coreV2.vaultV2Abi, 'pickFeeBps')));
  }
  if (sheet.boxType === BoxTypeV2.PILE) {
    const vault = await box('vault');
    const pile = fn => at(vault, coreV2.pileVaultV2Abi, fn);
    const config = coreV2.pileConfigV2(sheet.contentsParams);
    row('contents', 'pile coin', config.asset, await pile('asset'));
    row('contents', 'pile seed', config.seedAmount, await pile('seedAmount'));
    if (config.leaveBehindBps !== undefined) row('contents', 'pile leave-behind (bps)', BigInt(config.leaveBehindBps), BigInt(await pile('leaveBehindBps')));
  }
  row('contents', 'box type', sheet.boxType, sent.boxType);
  // A side that goes through a module route (The Alchemist): the receiver holds exactly the module the sheet's route id
  // names in the release's directory, with its code hash, both read at the creation's block.
  const createdAt = (await client.getTransactionReceipt({ hash: found.hash })).blockNumber;
  for (const [sellers, side] of [[false, sheet.buyers], [true, sheet.sellers]]) {
    if (Number(side.a.dest) !== 9) continue;
    const id = Number(decodeAbiParameters([{ type: 'uint32' }], side.a.destParams)[0]);
    const [held, heldHash] = await client.readContract({ address: receiverAddress, abi: coreV2.receiverModulesV21Abi, functionName: 'sideModule', args: [sellers], blockNumber: createdAt });
    const [named, namedHash] = await client.readContract({ address: release.feeModuleDirectory.address, abi: coreV2.feeModuleDirectoryV21Abi, functionName: 'record', args: [id], blockNumber: createdAt });
    row('fees', `${sellers ? 'sellers' : 'buyers'} route ${id}: module`, named, held);
    row('fees', `${sellers ? 'sellers' : 'buyers'} route ${id}: code hash`, namedHash, heldHash);
    row('fees', `${sellers ? 'sellers' : 'buyers'} route ${id}: live code hash`, namedHash, keccak256(await client.getCode({ address: held, blockNumber: createdAt }) ?? '0x'));
  }
  return { ok: rows.every(r => r.same), createTx: found.hash, specHash: chainHash, rows };
}

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  try {
    for (const name of ['--rpc', '--manifest', '--box', '--settings', '--creator']) assert.ok(flag(name), `${name} is required`);
    const client = createPublicClient({ transport: readTransport(flag('--rpc')) });
    const result = await readBack({ client, manifest: JSON.parse(readFileSync(resolve(flag('--manifest')), 'utf8')), coordinator: getAddress(flag('--box')),
      settingsText: readFileSync(resolve(flag('--settings')), 'utf8'), creator: getAddress(flag('--creator')), revealText: flag('--reveal-file') ? readFileSync(resolve(flag('--reveal-file')), 'utf8') : null, createTx: flag('--tx'), fromBlock: BigInt(flag('--from-block') ?? '0') });
    if (flag('--out')) writeFileSync(resolve(flag('--out')), `${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
    for (const r of result.rows) process.stdout.write(`${r.same ? 'same' : 'DIFF'}  ${r.group} / ${r.field}${r.same ? '' : `: sheet ${text(r.sheet)}, chain ${text(r.chain)}`}\n`);
    process.stdout.write(`read-back ${result.ok ? 'GREEN' : 'RED'}: ${result.rows.filter(r => r.same).length} of ${result.rows.length} fields equal (createBox ${result.createTx})\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`read-back refused: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
