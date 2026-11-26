import { createDataItem, dataItemSize, loadArweaveKey } from './ans104.mjs';
import { arBlockHash, arId, decimal, exact, fail, hash, httpsUrl, MAX_FILE, object, request, sha256 } from './common.mjs';
import { CONTENT_TYPES, deployment, readRevealedItems } from './revealed-source.mjs';
import { turboProvider } from './turbo.mjs';
import { verifyFile } from './verify.mjs';

const ROLES = Object.keys(CONTENT_TYPES);
const FORMAT = 'squarehole.arweave-state/1';
const timestamp = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s));

function validateState(value, scope) {
  if (!exact(value, ['format', 'scope', 'items']) || value.format !== FORMAT || !exact(value.scope, Object.keys(scope))
      || Object.keys(scope).some((k) => value.scope[k] !== scope[k]) || !object(value.items) || Object.keys(value.items).length > 8192) fail('state is corrupt or scope differs');
  for (const [id, item] of Object.entries(value.items)) {
    if (!decimal(id) || BigInt(id) < 1n || BigInt(id) > 8192n || !exact(item, ['event', 'files'])
        || !exact(item.event, ['transactionHash', 'logIndex', 'blockNumber', 'blockHash']) || !hash(item.event.transactionHash) || !hash(item.event.blockHash)
        || !decimal(item.event.logIndex) || !decimal(item.event.blockNumber) || !exact(item.files, ROLES)) fail('invalid saved item');
    for (const [role, file] of Object.entries(item.files)) {
      if (!exact(file, ['sha256', 'size', 'contentType', 'intent', 'receipt', 'verification']) || !hash(file.sha256) || !decimal(file.size)
          || BigInt(file.size) < 1n || BigInt(file.size) > BigInt(MAX_FILE) || file.contentType !== CONTENT_TYPES[role]) fail('invalid saved file');
      const { intent, receipt, verification } = file;
      if (intent !== null && (!exact(intent, ['id', 'quoteWinc', 'quotedAt', 'time']) || !arId(intent.id) || !decimal(intent.quoteWinc)
          || !timestamp(intent.time) || !timestamp(intent.quotedAt))) fail('invalid saved upload intent');
      if (receipt !== null && (!intent || !exact(receipt, ['id', 'sha256', 'size', 'time']) || receipt.id !== intent.id || receipt.sha256 !== file.sha256
          || receipt.size !== file.size || !timestamp(receipt.time))) fail('invalid saved receipt');
      if (verification !== null) {
        const fields = verification.status === 'final' ? ['status', 'time', 'bundleId', 'blockHeight', 'blockHash', 'confirmations'] : ['status', 'time'];
        if (!intent || !exact(verification, fields) || !['pending', 'final'].includes(verification.status) || !timestamp(verification.time)
            || (verification.status === 'final' && (!receipt || !arId(verification.bundleId) || !decimal(verification.blockHeight) || !decimal(verification.confirmations)
              || !arBlockHash(verification.blockHash)))) fail('invalid saved verification');
      }
    }
  }
  return value;
}

function tagsFor(scope, item, role, file) {
  return Object.entries({ 'App-Name': 'Square Hole', 'Format-Version': '1', 'Chain-Id': scope.chainId, Collection: scope.collection,
    'Item-Id': item.id, Role: role, 'Content-Type': CONTENT_TYPES[role], 'Content-SHA256': file.sha256,
    ...(file.cid ? { 'IPFS-CID': file.cid } : {}) }).map(([name, value]) => ({ name, value }));
}

/** Public provider/store/fetch/key-loader seams allow an entirely in-process test.
 * All pending payloads and quotes are preflighted before any signing or upload.
 */
export async function runArchive({ mode, allowMainnet = false, env, publicFile, feed, pinState, store,
  fetch = globalThis.fetch, provider, loadKey = loadArweaveKey, now = () => new Date(), onResult = () => {} }) {
  if (!['dry-run', 'upload', 'check'].includes(mode)) fail('choose dry-run, upload or check');
  const chain = deployment(env, allowMainnet);
  const gateways = [httpsUrl(env.SH_ARWEAVE_GATEWAY_1), httpsUrl(env.SH_ARWEAVE_GATEWAY_2)];
  if (new URL(gateways[0]).hostname === new URL(gateways[1]).hostname) fail('two independent gateway hosts required');
  if (!decimal(env.SH_ARWEAVE_MIN_CONFIRMATIONS) || BigInt(env.SH_ARWEAVE_MIN_CONFIRMATIONS) < 1n) fail('explicit positive confirmation depth required');
  const minConfirmations = BigInt(env.SH_ARWEAVE_MIN_CONFIRMATIONS);
  const bundler = provider ?? turboProvider({ uploadOrigin: env.SH_ARWEAVE_UPLOAD_ORIGIN, paymentOrigin: env.SH_ARWEAVE_PAYMENT_ORIGIN, fetch });
  if (typeof bundler.identity !== 'string' || typeof bundler.quote !== 'function' || typeof bundler.upload !== 'function') fail('invalid provider interface');
  const scope = { ...chain, root: publicFile?.root, provider: sha256(bundler.identity), gateway1: sha256(gateways[0]), gateway2: sha256(gateways[1]) };
  const state = validateState(await store.load() ?? { format: FORMAT, scope, items: {} }, scope);
  const items = await readRevealedItems({ env, publicFile, feed, pinState, scope, fetch });
  if (!items.length) return true;
  const time = () => {
    const value = now().toISOString();
    if (!timestamp(value)) fail('invalid clock');
    return value;
  };
  for (const item of items) {
    const saved = state.items[item.id];
    if (saved) {
      if (Object.keys(item.event).some((k) => saved.event[k] !== item.event[k]) || ROLES.some((role) => saved.files[role].sha256 !== item.files[role].sha256 || saved.files[role].size !== item.files[role].size)) fail('published files or reveal conflict with saved state');
    } else {
      state.items[item.id] = { event: item.event, files: Object.fromEntries(ROLES.map((role) => [role, {
        sha256: item.files[role].sha256, size: item.files[role].size, contentType: CONTENT_TYPES[role], intent: null, receipt: null, verification: null,
      }])) };
    }
  }
  const check = async (file) => {
    if (!file.intent) return false;
    file.verification = await verifyFile({ fetch, gateways, id: file.intent.id, file, minConfirmations, time: time() });
    if (file.verification.status === 'final' && !file.receipt) file.receipt = { id: file.intent.id, sha256: file.sha256, size: file.size, time: time() };
    await store.save(state);
    return file.verification.status === 'final';
  };
  if (mode === 'check') {
    let all = true;
    for (const item of items) {
      let final = true;
      for (const file of Object.values(state.items[item.id].files)) if (!await check(file)) final = false;
      onResult({ id: item.id, status: final ? 'final' : 'pending', files: state.items[item.id].files });
      if (!final) all = false;
    }
    return all;
  }
  if (!decimal(env.SH_ARWEAVE_MAX_WINC)) fail('founder-set decimal winc ceiling required');
  const ceiling = BigInt(env.SH_ARWEAVE_MAX_WINC);
  let reserved = 0n;
  for (const item of Object.values(state.items)) for (const file of Object.values(item.files)) if (file.intent) reserved += BigInt(file.intent.quoteWinc);
  if (reserved > ceiling) fail('saved reserved cost exceeds founder ceiling');
  if (mode === 'upload') {
    for (const item of items) for (const file of Object.values(state.items[item.id].files)) {
      if (file.intent && !file.receipt && !await check(file)) fail('unresolved upload intent; check again without re-uploading');
    }
  }
  const pending = [];
  let readable = true;
  for (const item of items) {
    let estimate = 0n; let complete = true;
    const plan = {};
    for (const role of ROLES) {
      const saved = state.items[item.id].files[role];
      if (saved.intent) { plan[role] = { status: saved.receipt ? 'receipt' : 'unresolved', quoteWinc: '0' }; continue; }
      const source = item.files[role];
      let bytes;
      try {
        bytes = source.bytes ?? await request(fetch, `${httpsUrl(env.SH_ARWEAVE_IPFS_GATEWAY)}/ipfs/${source.cid}`, { limit: MAX_FILE });
        if (String(bytes.length) !== source.size || sha256(bytes) !== source.sha256) throw new Error();
      } catch {
        plan[role] = { status: 'unreadable' }; complete = false; readable = false;
        if (mode === 'upload') fail('cannot read exact published payload; no upload started');
        continue;
      }
      const tags = tagsFor(scope, item, role, source);
      const quoteWinc = await bundler.quote(dataItemSize(BigInt(bytes.length), tags).toString());
      if (!decimal(quoteWinc)) fail('invalid price from provider');
      const quotedAt = time();
      estimate += BigInt(quoteWinc); reserved += BigInt(quoteWinc);
      pending.push({ item, role, bytes, tags, quoteWinc, quotedAt });
      plan[role] = { status: 'readable', size: source.size, quoteWinc };
    }
    onResult({ id: item.id, status: complete ? 'planned' : 'incomplete', estimateWinc: complete ? estimate.toString() : null, readableSubtotalWinc: estimate.toString(), files: plan });
  }
  if (reserved > ceiling) fail('estimated cumulative cost exceeds founder ceiling');
  if (mode === 'dry-run') return readable;
  await store.save(state);
  let key;
  for (const entry of pending) {
    // Turbo has no signed maximum-charge field. Refuse stale planning quotes;
    // never invent a fee cap in ANS-104 tags or automatically top up the wallet.
    const age = Date.parse(time()) - Date.parse(entry.quotedAt);
    if (age < 0 || age > 60_000) fail('price quote expired; rerun to reprice remaining files');
    key ??= await loadKey(env);
    const signed = createDataItem(entry.bytes, entry.tags, key);
    const file = state.items[entry.item.id].files[entry.role];
    file.intent = { id: signed.id, quoteWinc: entry.quoteWinc, quotedAt: entry.quotedAt, time: time() };
    await store.save(state);
    const result = await bundler.upload(signed);
    if (result?.id !== signed.id) fail('upload id mismatch; preserve intent');
    file.receipt = { id: signed.id, sha256: file.sha256, size: file.size, time: time() };
    await store.save(state);
  }
  let all = true;
  for (const item of items) {
    let final = true;
    for (const file of Object.values(state.items[item.id].files)) if (!await check(file)) final = false;
    onResult({ id: item.id, status: final ? 'final' : 'pending', files: state.items[item.id].files });
    if (!final) all = false;
  }
  return all;
}
