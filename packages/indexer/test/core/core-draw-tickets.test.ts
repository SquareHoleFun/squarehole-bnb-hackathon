/**
 * SH-BOX0-ACTIONS: the wallet answer lists each address's open draw tickets (requested or settled, not yet opened or
 * cancelled), so box 0's page can show "Your draws" and offer the drawer's own open. A draw ticket is no NFT: it is
 * keyed by `DrawRequested.drawer` and closed by `Opened` (kind 2) or `TicketCancelled`. A placeholder's `Opened`
 * (kind 1, same ids) closes no draw.
 */
import { labelHash } from '@squarehole/chain/core/test-support';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { boxRowToJson } from '../../src/core/core-row';
import { parseWalletView } from '../../src/core/core-views';
import type { CoreEvent } from '../../src/core/core-events';
import { applyCoreBlock, drawsOf, initialCoreState, type CoreBoxState } from '../../src/core/derive-core';
import type { BlockHeader } from '../../src/model';
import { synthBox } from './core-synth';

const row = synthBox({ boxId: 0n, creationBlock: 100n }).row;
const carol = '0x00000000000000000000000000000000000ca401';
const dave = '0x00000000000000000000000000000000000da7e1';
let logIndex = 0;

function e(name: string, args: Record<string, unknown>, n: bigint): CoreEvent {
  return { source: 'tickets', name, args, address: row.contracts.tickets as Address, ref: { blockNumber: n, blockHash: labelHash(`draws:${n}`), txHash: labelHash(`draws:tx:${n}`), txIndex: 0, logIndex: logIndex++ } };
}
const header = (n: bigint): BlockHeader => ({ number: n, hash: labelHash(`draws:${n}`) as Hex, parentHash: labelHash(`draws:${n - 1n}`) as Hex, timestamp: 1_800_000_000n + n * 12n });
const requested = (id: bigint, drawer: string, n: bigint) => e('DrawRequested', { ticketId: id, drawer, principal: 10n, fee: 1n, round: 9n, bounty: 0n }, n);

describe('SH-BOX0-ACTIONS open draw tickets per drawer', () => {
  it('keeps requested and settled draws, drops opened and cancelled ones, and ignores a placeholder opened with the same id', () => {
    let s: CoreBoxState = initialCoreState(row);
    s = applyCoreBlock(s, header(200n), [requested(1n, carol, 200n), requested(2n, dave, 200n), requested(3n, carol, 200n)], row).state;
    expect(drawsOf(s, carol)).toEqual([1n, 3n]);
    expect(drawsOf(s, dave.toUpperCase().replace('0X', '0x'))).toEqual([2n]);
    s = applyCoreBlock(s, header(201n), [e('DrawSettled', { ticketId: 1n, itemId: 4100n, word: labelHash('w') }, 201n)], row).state;
    expect(drawsOf(s, carol)).toEqual([1n, 3n]);
    // A placeholder (kind 1) with token id 3 opening is not draw ticket 3.
    s = applyCoreBlock(s, header(202n), [e('Opened', { tokenOrTicket: 3n, kind: 1, itemId: 4200n, holder: dave, revealed: true, outsideSince: 0n }, 202n)], row).state;
    expect(drawsOf(s, carol)).toEqual([1n, 3n]);
    s = applyCoreBlock(s, header(203n), [e('Opened', { tokenOrTicket: 1n, kind: 2, itemId: 4100n, holder: carol, revealed: true, outsideSince: 0n }, 203n), e('TicketCancelled', { ticketId: 2n, drawer: dave, principal: 10n }, 203n)], row).state;
    expect(drawsOf(s, carol)).toEqual([3n]);
    expect(drawsOf(s, dave)).toEqual([]);
  });

  it('the wallet answer carries draws; one from an older gateway without them parses as none known', () => {
    const options = { chainId: row.chainId, box0Registry: row.registry, registries: [row.registry] };
    const box = { token: (row.contracts.token as string).toLowerCase(), row: boxRowToJson(row), t: '0', items: [], tickets: [], streamOwed: null };
    const answer = (b: object) => ({ schema: 'sh.core-wallet.v1', chainId: row.chainId, address: carol, asOf: null, boxes: [b] });
    expect(parseWalletView(answer({ ...box, draws: ['3', '7'] }), options).boxes[0]?.box.draws).toEqual(['3', '7']);
    expect(parseWalletView(answer(box), options).boxes[0]?.box.draws).toBeUndefined();
    expect(() => parseWalletView(answer({ ...box, draws: ['x'] }), options)).toThrow();
  });
});
