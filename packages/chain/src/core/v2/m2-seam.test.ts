import { describe, expect, it } from 'vitest';
import { FROZEN_EVENTS_V2, NOT_READ_V2 } from './events-v2';
import { hookV2Abi, receiverV2Abi, holderBatchNoticeV2Abi } from './abi-v2';

describe('CQ11 M2 seams in the published v2 ABIs', () => {
  it('publishes batch identity and independent cumulative hook receipts', () => {
    const names = hookV2Abi.filter((item) => item.type === 'function').map((item) => item.name);
    expect(names).toContain('holderLedger');
    expect(names).toContain('currentTradeBatch');
    expect(names).toContain('tradeBatch');
    expect(holderBatchNoticeV2Abi).toContainEqual(expect.objectContaining({
      name: 'onTradeFeeBatch', type: 'function', inputs: [
        { internalType: 'uint256', name: 'batchId', type: 'uint256' },
        { internalType: 'address', name: 'swapper', type: 'address' },
        { internalType: 'bool', name: 'buy', type: 'bool' },
        { internalType: 'uint256', name: 'units', type: 'uint256' },
      ],
    }));
  });
  it('keeps the funding scalar and adds explicit receiver finality and source totals', () => {
    const names = receiverV2Abi.filter((item) => item.type === 'function').map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(['holderBatchPaid', 'holderBatchClosed', 'harvestedFees']));
  });
  it('indexes the merged M2 batch funding event', () => {
    expect(FROZEN_EVENTS_V2).toContainEqual({ source: 'receiver', container: 'IBoxReceiverV2', name: 'HolderBatchFunded' });
    expect(NOT_READ_V2.some(item => item.container === 'IBoxReceiverV2' && item.name === 'HolderBatchFunded')).toBe(false);
  });

});
