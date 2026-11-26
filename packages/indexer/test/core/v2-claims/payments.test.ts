import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeEventLog, type Address, type Hex } from 'viem';
import { EVENT_ABI_V2 } from '../../../src/core/v2/chain-v2';
import { claimPaymentsV2, CLAIMS_RECENT_BLOCKS } from '../../../src/core/v2/claims-events-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { m2Fixture, H } from '../../../src/core/v2/m2-fixture.test-support';
import { applyV2Block } from '../../../src/core/v2/views-v2';
import { required } from '../../../src/core/v2/m3-fixture.test-support';

const fixtures = JSON.parse(readFileSync(new URL('./events.json', import.meta.url), 'utf8')) as Record<string, { address: Address; topics: [Hex, ...Hex[]]; data: Hex }>;
const role = { holder: 'holderLedger', item: 'itemLedger', creator: 'receiver', failure: 'coordinator', no_buyer: 'coordinator' } as const;
const f = m2Fixture(false);
const route = { ...routeV2(f.release, f.manifest, [], [f.record]), parts: new Map(Object.entries(fixtures).map(([kind, log]) => [log.address, { boxId: f.row.boxId, role: role[kind as keyof typeof role] }])) };
// Contract deployments can share an address across isolated fixture worlds: route each fixture independently.
function events(kind: keyof typeof role, block = 101n, hash = H(101)) {
  const log = required(fixtures[kind]);
  return decodeV2Logs([{ ...log, blockNumber: block, blockHash: hash, transactionHash: H(200), transactionIndex: 0, logIndex: 7, removed: false }],
    { ...route, parts: new Map([[log.address, { boxId: f.row.boxId, role: role[kind] }]]) });
}

describe('CLAIMS-02 real payment receipts', () => {
  it.each(Object.keys(role) as (keyof typeof role)[])('keeps %s attributed to the claimant, distinct from the recipient', kind => {
    const es = events(kind);
    expect(es).toHaveLength(1);
    const payments = claimPaymentsV2([], es, 101n, f.row.boxId);
    expect(payments).toHaveLength(1);
    const payment = required(payments[0]); const log = required(fixtures[kind]);
    const args = decodeEventLog({ abi: required(EVENT_ABI_V2[role[kind]]), topics: log.topics, data: log.data }).args as unknown as Record<string, unknown>;
    expect(payment).toMatchObject({ kind, wallet: String(args.holder ?? args.owner ?? args.payee).toLowerCase(), to: String(args.to).toLowerCase(), amountP: args.grossP ?? args.amount ?? args.p, roleAddress: log.address, block: 101n, hash: H(101) });
    expect(payment.wallet).not.toBe(payment.to);
    expect(claimPaymentsV2(payments, es, 101n, f.row.boxId)).toEqual(payments);
  });

  it('retains receipts in pipeline snapshots for reload, drops orphans by replay, and expires only by block window', () => {
    const es = events('creator');
    const h = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
    const parent = applyV2Block(undefined, { ...h, number: 100n, hash: H(100) }, [], f.row).state;
    const old = applyV2Block(parent, h, es, f.row).state;
    expect(old.claimPayments).toHaveLength(1);
    const canonical = applyV2Block(parent, { ...h, hash: H(999) }, [], f.row).state;
    expect(canonical.claimPayments).toEqual([]);
    expect(parent.claimPayments).toEqual([]);
    expect(claimPaymentsV2(old.claimPayments ?? [], [], 101n + CLAIMS_RECENT_BLOCKS - 1n, f.row.boxId)).toHaveLength(1);
    expect(claimPaymentsV2(old.claimPayments ?? [], [], 101n + CLAIMS_RECENT_BLOCKS, f.row.boxId)).toEqual([]);
  });
});
