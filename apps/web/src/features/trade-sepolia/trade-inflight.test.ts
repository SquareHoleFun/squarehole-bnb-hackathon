import { beforeEach, describe, expect, it } from 'vitest';
import type { TradeCall, TradePlan } from '@squarehole/chain/trade-sepolia';
import { beginInFlight, clearInFlight, endInFlight, inFlightOf, sendKey, updateInFlight } from './trade-inflight';

const step = { step: 'trade' as const, plan: {} as TradePlan, call: { to: '0x0000000000000000000000000000000000000001', data: '0x', value: 0n } as TradeCall, gasLimit: 1n };
const track = { nonceBefore: 1n, hash: null, quietReads: 0, quietSince: null };

beforeEach(() => clearInFlight());

describe('the account’s one send slot', () => {
  it('is keyed by chain and account, in any letter case', () => {
    expect(sendKey(31337, '0xAbC0000000000000000000000000000000000001')).toBe('31337|0xabc0000000000000000000000000000000000001');
  });
  it('holds one send at a time: a second begin is refused until the first ends', () => {
    const id = beginInFlight('k', { sent: step, asking: true, track });
    expect(id).not.toBeNull();
    expect(beginInFlight('k', { sent: step, asking: true, track })).toBeNull();
    // Another account or chain has its own slot.
    expect(beginInFlight('other', { sent: step, asking: true, track })).not.toBeNull();
    endInFlight('k', id as number);
    expect(inFlightOf('k')).toBeNull();
    expect(beginInFlight('k', { sent: step, asking: true, track })).not.toBeNull();
  });
  it('only the entry’s own id updates or ends it: a late finisher never touches a later send', () => {
    const first = beginInFlight('k', { sent: step, asking: true, track }) as number;
    endInFlight('k', first);
    const later = beginInFlight('k', { sent: step, asking: true, track }) as number;
    // The first send's box finishes late: its id no longer holds the slot.
    updateInFlight('k', first, { asking: false });
    endInFlight('k', first);
    expect(inFlightOf('k')).toMatchObject({ id: later, asking: true });
    updateInFlight('k', later, { asking: false });
    expect(inFlightOf('k')?.asking).toBe(false);
    endInFlight('k', later);
    expect(inFlightOf('k')).toBeNull();
  });
});
