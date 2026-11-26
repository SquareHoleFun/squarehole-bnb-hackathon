import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type AbiEvent } from 'viem';
import { coordinatorV2Abi, hookV2Abi, receiverV2Abi } from '../../src/abi';
import { receiverPayInTV21Abi } from '../../../chain/src/core/v2/abi-v2';
import type { ReceiptLog } from '../../src/income-read';

const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const claim = parseAbiItem('event Transfer(address caller,address indexed from,address indexed to,uint256 indexed id,uint256 amount)');
const safe = parseAbiItem('event SafeReceived(address indexed sender,uint256 value)');
const events = ([...receiverV2Abi, ...coordinatorV2Abi, ...hookV2Abi, ...receiverPayInTV21Abi, safe] as readonly { type: string }[])
  .filter(e => e.type === 'event') as unknown as readonly AbiEvent[];

/**
 * SH-190, ported for SH-247: a transaction receipt's logs as a node returns them, from the decoded rows a test also
 * serves through getLogs. The keeper reads every payment proof from the paying transaction's receipt.
 */
export function receiptLogs(rows: readonly ReceiptLog[]) {
  return rows.map(l => {
    const event: AbiEvent | undefined = l.eventName === 'Transfer' ? ('id' in l.args ? claim : transfer)
      : events.find(e => e.name === l.eventName);
    if (!event) throw new Error(`missing fixture event ${l.eventName}`);
    const args = Object.fromEntries(event.inputs.map(i => [i.name, l.args[i.name ?? '']
      ?? (i.type === 'address' ? '0x0000000000000000000000000000000000000000'
        : i.type === 'bytes32' ? `0x${'00'.repeat(32)}` : i.type === 'bool' ? false : 0n)]));
    return { ...l,
      topics: encodeEventTopics({ abi: [event], eventName: event.name, args } as never),
      data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name ?? ''])),
    };
  });
}

/** A successful receipt of `tx` holding `rows` (the transaction's own logs), at their block. */
export function receiptOf(tx: string, rows: readonly ReceiptLog[], fallback: { blockNumber: bigint; blockHash: string }) {
  const first = rows[0];
  return { transactionHash: tx, status: 'success' as const, blockNumber: first?.blockNumber ?? fallback.blockNumber,
    blockHash: first?.blockHash ?? fallback.blockHash, logs: receiptLogs(rows) };
}
