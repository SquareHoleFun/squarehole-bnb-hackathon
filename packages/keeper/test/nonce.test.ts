/**
 * Review round 1, finding H2: viem's `prepareTransactionRequest` reads its nonce manager from the request, not the
 * account, so each send took the public node's pending count, and a private send the node could not see shared its
 * nonce with the next public one. The keeper now keeps its own nonces, one counter per key, and private sends use a
 * second key.
 */
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ViemChain } from '../src/chain';
import { loadConfig, secretsOf } from '../src/config';
import { feesFor } from '../src/gas';
import { nextNonce, nonceAhead } from '../src/nonce';
import type { Candidate } from '../src/types';
import { fakeClient, fakeNode } from './support/fake-rpc';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const fees = feesFor(10n ** 9n, 10n ** 8n);
const snapshot: Candidate = { job: 'poke', key: 'poke:private', to: addr(900), fn: 'poke', args: [] };
const poke: Candidate = { job: 'poke', key: 'poke:5', to: addr(5), fn: 'poke', args: [] };

function setup() {
  const node = fakeNode();
  const pub = privateKeyToAccount(generatePrivateKey());
  const priv = privateKeyToAccount(generatePrivateKey());
  // A lagging public node: it never sees the keeper's sends, public or private.
  node.counts = { [pub.address.toLowerCase()]: 7, [priv.address.toLowerCase()]: 3 };
  const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid' });
  const chain = new ViemChain({ ...cfg, dryRun: false }, fakeClient(node), pub.address, { public: pub, private: priv }, fakeClient(node, 'private'), quiet);
  const sends = (endpoint: string) => Promise.all(node.sent.filter((s) => s.endpoint === endpoint).map(async (s) => ({
    nonce: parseTransaction(s.raw).nonce, from: await recoverTransactionAddress({ serializedTransaction: s.raw as TransactionSerialized }),
  })));
  return { node, chain, pub, priv, sends };
}

describe('the keeper\'s own nonces (review round 1, H2)', () => {
  it('numbers private sends the public node cannot see, then public ones, from two keys, never reusing a nonce', async () => {
    const { chain, pub, priv, sends } = setup();
    await chain.send(snapshot, 200_000n, fees, true);
    await chain.send(snapshot, 200_000n, fees, true);
    await chain.send(poke, 200_000n, fees, false);
    await chain.send(poke, 200_000n, fees, false);
    expect(await sends('private')).toEqual([{ nonce: 3, from: priv.address }, { nonce: 4, from: priv.address }]);
    expect(await sends('public')).toEqual([{ nonce: 7, from: pub.address }, { nonce: 8, from: pub.address }]);
  });

  it('never gives a send that may have reached the node its nonce back, and broadcasts it again (SH-249 A3)', async () => {
    const { node, chain, sends } = setup();
    await chain.send(poke, 200_000n, fees, false);
    node.onSend = () => {
      throw new Error('rejected');
    };
    // An error reply can follow acceptance (a retried request, a lost reply): nonce 8 stays with its saved bytes.
    await expect(chain.send(poke, 200_000n, fees, false)).rejects.toThrow();
    node.onSend = () => {};
    await chain.send(poke, 200_000n, fees, false);
    expect((await sends('public')).map((s) => s.nonce)).toEqual([7, 9]);
    node.block.number += 1n;
    await chain.read().catch(() => undefined);
    expect((await sends('public')).map((s) => s.nonce)).toEqual([7, 9, 8]);
  });

  it('signs for the configured chain', async () => {
    const { node, chain } = setup();
    await chain.send(poke, 200_000n, fees, false);
    expect(parseTransaction(node.sent[0]?.raw ?? '0x').chainId).toBe(11_155_111);
  });

  it('refuses a private send without its own key', async () => {
    const node = fakeNode();
    const pub = privateKeyToAccount(generatePrivateKey());
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid' });
    const chain = new ViemChain({ ...cfg, dryRun: false }, fakeClient(node), pub.address, { public: pub, private: null }, fakeClient(node, 'private'), quiet);
    await expect(chain.send(snapshot, 200_000n, fees, true)).rejects.toThrow('private');
    expect(node.sent).toHaveLength(0);
  });

  it('takes the record and the mined count; the pending count only raises it, and a quiet spell never lowers it (SH-249 A3)', () => {
    expect(nextNonce(5n, 5n)).toBe(5n);
    expect(nextNonce(5n, 5n, 6n)).toBe(6n);
    // A lagging pending count, for any number of blocks: the record holds.
    expect(nextNonce(5n, 3n, 10n)).toBe(10n);
    expect(nextNonce(12n, 5n, 10n)).toBe(12n);
    // Transactions the record does not know: never replaced by ours.
    expect(nextNonce(5n, 9n, 6n)).toBe(9n);
    expect(nonceAhead(5n, 9n, 6n)).toBe(true);
    expect(nonceAhead(5n, 6n, 6n)).toBe(false);
  });

  it('takes the private-send key from the environment, never the main key twice', () => {
    const key = generatePrivateKey();
    const other = generatePrivateKey();
    const env = { SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DRY_RUN: '0', SH_KEEPER_PRIVATE_KEY: key };
    const cfg = loadConfig({ ...env, SH_KEEPER_PRIVATE_SEND_KEY: other });
    expect(cfg.privateSendKey).toBe(other);
    expect(secretsOf(cfg)).toEqual(expect.arrayContaining([other, other.slice(2)]));
    expect(() => loadConfig({ ...env, SH_KEEPER_PRIVATE_SEND_KEY: key })).toThrow(/SH_KEEPER_PRIVATE_SEND_KEY/);
    expect(() => loadConfig({ ...env, SH_KEEPER_PRIVATE_SEND_KEY: key.toUpperCase().replace('0X', '0x') })).toThrow(/SH_KEEPER_PRIVATE_SEND_KEY/);
  });
});
