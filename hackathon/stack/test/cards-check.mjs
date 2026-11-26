// The card shop's sixteen pictures through the stack's picture service (SH-259): for every card of the catalog, the
// collection's on-chain imageURI(n) must be ipfs://<the catalog's raw CID>, and <origin>/ipfs/<cid> must answer 200
// image/png with exactly the catalog's SHA-256. Reads only: eth_call through the profile's keyless endpoint.
//   node hackathon/stack/test/cards-check.mjs <catalog.json> <97-cards.json> <origin>
// (the trial's origin is https://127-0-0-1.sslip.io:18584, served with Caddy's own certificate: run it with
// NODE_TLS_REJECT_UNAUTHORIZED=0 there, never against the live site.)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [catalogPath, cardsPath, origin] = process.argv.slice(2);
if (!catalogPath || !cardsPath || !/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(origin ?? '')) {
  console.error('usage: cards-check.mjs <catalog.json> <97-cards.json> <https origin>');
  process.exit(2);
}
const RPC = 'https://bsc-testnet-rpc.publicnode.com';
const IMAGE_URI = '0x8f742d16'; // imageURI(uint256)
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));

async function imageUri(address, id) {
  const data = IMAGE_URI + BigInt(id).toString(16).padStart(64, '0');
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }) });
  const { result } = await r.json();
  if (typeof result !== 'string' || result.length < 130) return null;
  const length = Number(BigInt(`0x${result.slice(66, 130)}`));
  return Buffer.from(result.slice(130, 130 + length * 2), 'hex').toString('utf8');
}

let good = 0, total = 0;
for (const c of catalog.collections) {
  const address = cards.collections[c.key.replace(/-cards$/, '')];
  for (const item of c.items) {
    total++;
    const onChain = await imageUri(address, item.id).catch(() => null);
    const r = await fetch(`${origin}/ipfs/${item.cid}`, { redirect: 'error' }).catch(() => null);
    const body = r ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    const digest = `0x${createHash('sha256').update(body).digest('hex')}`;
    const ok = onChain === `ipfs://${item.cid}` && r?.status === 200 && r.headers.get('content-type') === 'image/png' && digest === item.sha256;
    if (ok) good++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.key}/${item.id} ${item.cid} chain=${onChain === `ipfs://${item.cid}` ? 'same' : onChain} `
      + `site=${r?.status ?? 'none'} ${r?.headers.get('content-type') ?? ''} sha256=${digest === item.sha256 ? 'same' : 'differs'}\n`);
  }
}
process.stdout.write(`cards: ${good} of ${total} pictures: on chain as in the catalog, served as image/png with the catalog's bytes\n`);
process.exit(good === total ? 0 : 1);
