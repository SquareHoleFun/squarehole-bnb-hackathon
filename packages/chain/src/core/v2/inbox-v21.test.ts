import { expect, it } from 'vitest';
import { decodeEventLog, decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import recorded from '../../../../indexer/test/core/rc6-inbox/recorded.json';
import { cowSettlementV21Abi, inboxOrderIdV21, readInboxWiringV21 } from './inbox-v21';
import { royaltyRouterV2Abi } from './abi-v2';
import { walletClaimSchemaV2 } from './claims-types';

it('matches each recorded order ID to its coin without guessing from balance or decimals', () => {
  const ids = recorded.refreshLogs.flatMap(log => {
    try { const event = decodeEventLog({ abi: royaltyRouterV2Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      return event.eventName === 'OrderRefreshed' ? [event.args.id] : []; } catch { return []; }
  });
  expect(ids).toHaveLength(2);
  expect(ids).toEqual([recorded.wiring.weth, recorded.wiring.other].map(coin => inboxOrderIdV21(recorded.wiring.handler as Address, coin as Address)));
});

it('decodes the recorded settlement Trade with exact amounts and the inbox owner', () => {
  const log = recorded.saleLogs.find(log => log.emitter === recorded.wiring.settlement);
  if (!log) throw new Error('missing recorded sale');
  const sale = decodeEventLog({ abi: cowSettlementV21Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
  expect(sale.args).toEqual({ owner: recorded.wiring.router, sellToken: recorded.wiring.other,
    buyToken: recorded.wiring.p, sellAmount: 100000000n, buyAmount: 77n, feeAmount: 0n, orderUid: '0xaabb' });
});

it('reads settlement and handler from the inbox at one creation hash', async () => {
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const wiring = await readInboxWiringV21({ callAt: async (to, data, at) => {
    expect(to).toBe(recorded.wiring.router); expect(at).toBe(hash);
    const { functionName } = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
    if (functionName !== 'cowHandler' && functionName !== 'settlement') throw new Error('unexpected read');
    return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: (functionName === 'cowHandler' ? recorded.wiring.handler : recorded.wiring.settlement) as Address });
  } }, recorded.wiring.router as Address, hash);
  expect(wiring).toEqual({ router: recorded.wiring.router, handler: recorded.wiring.handler, settlement: recorded.wiring.settlement });
});

it('keeps a recorded final share with its inbox P in the chain schema, priced only (SH-RC7 item 29), never inflated', () => {
  const address = recorded.wiring.router;
  const hash = `0x${'ab'.repeat(32)}`;
  // RC6-RR-INBOX: the merged coordinator quotes the final share at its pot plus the inbox's readable P.
  const quoted = BigInt(recorded.pending.quote);
  expect(quoted).toBe(BigInt(recorded.pending.pot) + BigInt(recorded.pending.pendingP));
  const row = { id: 'failure', kind: 'failure', status: 'claimable', wallet: address, box: { registry: address, boxId: '1', token: address },
    roleAddress: address, asset: recorded.wiring.p, amountP: String(quoted), asOf: { block: '100', hash, timestamp: '1000', tier: 'head' },
    payout: 'unverified', payment: null, coinsT: recorded.pending.coinsT, allowanceT: '0', pot: recorded.pending.pot, tLeft: recorded.pending.tLeft,
    collectFirst: { pendingP: recorded.pending.pendingP, message: "the claim moves the inbox's P into the pot first" } };
  expect(walletClaimSchemaV2.parse(row).amountP).toBe(String(quoted));
  // An unpriced collect-first row (an inbox release before RC6-RR-INBOX) is refused: the merged coordinator prices it.
  for (const invalid of [{ ...row, amountP: String(quoted + 1n) }, { ...row, status: 'pending', payout: 'not_ready' },
    { ...row, status: 'pending', amountP: null, payout: 'not_ready' },
    { ...row, collectFirst: { ...row.collectFirst, pendingP: '0' } }, { ...row, coinsT: '1' }]) {
    expect(walletClaimSchemaV2.safeParse(invalid).success).toBe(false);
  }
});
