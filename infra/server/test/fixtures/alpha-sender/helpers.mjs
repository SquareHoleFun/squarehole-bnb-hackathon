import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { claimMessage } from '../../../services/alpha/message.mjs';
const require = createRequire(new URL('../../../../../packages/keeper/package.json', import.meta.url));
export const viem = require('viem');
export const { privateKeyToAccount } = require('viem/accounts');
// Public, deterministic fixture accounts only. Never funded outside local tests.
export const account = n => privateKeyToAccount(`0x${BigInt(n).toString(16).padStart(64, '0')}`);
export const desk = account(900);
export const token = account(901).address;
export const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export async function claim(n, overrides = {}) {
  const signer = account(n);
  const c = { v: 1, id: id(n), xId: String(n), privyDid: `did:privy:test${n}`, address: signer.address,
    requestedAt: '2026-10-29T12:00:00.000Z', ...overrides };
  c.message ??= claimMessage({ ...c, handle: `tester${n}`, origin: 'https://test-app.example.org' });
  c.signature ??= await signer.signMessage({ message: c.message });
  return c;
}
export function scratch() {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp/alpha-sender-'));
  const paths = Object.fromEntries(['queue', 'receipts', 'state'].map(k => [k, join(root, k)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  return { ...paths, put: c => writeFileSync(join(paths.queue, `${c.id}.json`), JSON.stringify(c)),
    receipt: n => JSON.parse(readFileSync(join(paths.receipts, `${id(n)}.json`), 'utf8')) };
}
export function fakeChain() {
  let nonce = 0;
  const mined = new Map(), raws = new Set(), admitted = new Set();
  const chain = {
    funds: 10n ** 20n, sent: [], prepares: [], broadcasts: [], latest: null, pending: null,
    chainId: async () => 11155111,
    balance: async () => chain.funds,
    admitted: async address => admitted.has(address),
    quote: async () => ({ admitGas: '100000', sendGas: '21000', maxFeePerGas: '2', maxPriorityFeePerGas: '1' }),
    nonces: async () => ({ latest: chain.latest ?? nonce, pending: chain.pending ?? nonce }),
    receipt: async hash => mined.get(hash) ?? null,
    // The engine names the nonce (SH-181: a claim's admission and starter are signed together, back to back).
    prepare: async (kind, c, quote, at) => {
      chain.prepares.push(kind);
      const raw = await desk.signTransaction({ chainId: 11155111, type: 'eip1559', nonce: at,
        to: kind === 'admit' ? token : c.address, value: kind === 'send' ? 50000000000000000n : 0n,
        gas: BigInt(kind === 'admit' ? quote.admitGas : quote.sendGas), maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
      return { raw, hash: viem.keccak256(raw), nonce: at, kind };
    },
    // Mines on receipt, in nonce order; a copy of a known transaction is accepted silently.
    broadcast: async tx => {
      chain.broadcasts.push(tx.hash);
      if (raws.has(tx.raw)) return;
      if (tx.nonce !== nonce) throw new Error('fixture: nonce out of order');
      raws.add(tx.raw); nonce++;
      const parsed = viem.parseTransaction(tx.raw);
      if (tx.kind === 'send') { chain.sent.push(parsed.to); chain.funds -= parsed.value; }
      mined.set(tx.hash, { status: 'success', confirmed: true });
    },
    known: async hash => mined.has(hash),
  };
  return { chain, admitted, mined };
}
/** What the engine before SH-181 left mid-claim: the admission signed and journaled alone, at the low fees. */
export async function legacyAdmission(paths, c, { day, nonce = 0, admitGas = 60001n, sendGas = 25201n,
  fees = { maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n } }) {
  const raw = await desk.signTransaction({ chainId: 11155111, type: 'eip1559', nonce, to: token, value: 0n, gas: admitGas, ...fees,
    data: viem.encodeFunctionData({ abi: viem.parseAbi(['function admitOne(address account)']), functionName: 'admitOne', args: [c.address] }) });
  const admit = { kind: 'admit', nonce, raw, hash: viem.keccak256(raw) };
  const quote = { admitGas: String(admitGas), sendGas: String(sendGas),
    maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas) };
  writeFileSync(join(paths.state, 'journal.json'), `${JSON.stringify({ v: 1, identity: `11155111:${desk.address}:${token}:live`,
    entries: [{ id: c.id, reserved: true, xId: c.xId, address: c.address, days: [day], needsAdmit: true, quote, admit }] })}\n`, { mode: 0o600 });
  return admit;
}
