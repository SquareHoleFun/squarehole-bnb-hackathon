/** SH-SEND-FEES: a trade the wallet cannot pay (the executor's balance check) is not sent, and says the gas line. */
import { describe, expect, it } from 'vitest';
import { InsufficientGasFundsError } from '@squarehole/chain/write';
import { sendFailure } from './trade-run';

describe('SH-SEND-FEES trades', () => {
  it('a send the wallet cannot pay is not sent, for its gas', () => {
    expect(sendFailure(new InsufficientGasFundsError(2n, 1n, 11_155_111))).toEqual({ kind: 'not_sent', reason: 'gas_funds' });
  });
});
