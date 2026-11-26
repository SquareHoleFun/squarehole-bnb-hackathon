import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address } from 'viem';
import { boxTokenAbi } from '../../chain/src/abi/boxToken';
import { fitBuybackExecutorAbi } from '../../chain/src/abi/fitBuybackExecutor';
import { wethAbi } from './builders';
import { Bot } from './bot';
import { decodeLog, type ChainLog, type ChainObservation, type ViemChainReader } from './chain';
import { safeReadAbi } from './chain-abi';
import { safeDigest } from './safe';
import { address, present, requireThat, uint } from './schema';
import type { ReconciledExecution } from './runner';
import type { SafeTransaction } from './types';

function tokenNet(logs: ChainLog[], asset: Address, safe: Address) {
  let incoming = 0n, outgoing = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== asset) continue;
    const e = decodeLog(boxTokenAbi, log); if (e?.eventName !== 'Transfer') continue;
    const amount = uint.parse(e.args.amount);
    if (address.parse(e.args.to) === safe) incoming += amount;
    if (address.parse(e.args.from) === safe) outgoing += amount;
  }
  return { incoming, outgoing };
}
function nativeIn(logs: ChainLog[], safe: Address) {
  let total = 0n;
  for (const log of logs) if (log.address.toLowerCase() === safe) {
    const e = decodeLog(safeReadAbi, log);
    if (e?.eventName === 'SafeReceived') total += uint.parse(e.args.value);
  }
  return total;
}
export async function reconcileExecutions(reader: ViemChainReader, bot: Bot, observation: ChainObservation): Promise<ReconciledExecution[]> {
  const state = bot.inspect(), m = bot.manifest, result: ReconciledExecution[] = [];
  for (const { lot } of [...state.lots, ...state.quarantined]) {
    const block = await reader.rpc.getBlock({ blockNumber: lot.source.blockNumber });
    if (block.hash !== lot.source.blockHash) { bot.freeze(lot.source.blockHash); throw new Error('orphaned journal receipt'); }
  }
  for (const p of state.proposals.filter(p => p.status === 'pending')) {
    await reader.remember(p.snapshot.block);
    if (p.draft.request.kind === 'sale') await reader.remember(p.draft.request.quote.block);
    const snapshot = observation.snapshots[p.draft.role];
    const replacement = state.cancellations.find(c => c.replaces === p.id && c.status === 'pending');
    const logs = await reader.logs(snapshot.safe, snapshot.block);
    const execution = logs.find(l => {
      const e = decodeLog(safeReadAbi, l);
      return (e?.eventName === 'ExecutionSuccess' || e?.eventName === 'ExecutionFailure')
        && (e.args.txHash === p.id || e.args.txHash === replacement?.id);
    });
    if (!execution) {
      requireThat(snapshot.nonce <= p.transaction.nonce, 'consumed nonce has no known canonical execution'); continue;
    }
    const event = present(decodeLog(safeReadAbi, execution), 'invalid execution event');
    const txHash = present(execution.transactionHash, 'missing execution transaction');
    const receipt = await reader.rpc.getTransactionReceipt({ hash: txHash });
    requireThat(receipt.status === 'success' && receipt.blockHash === execution.blockHash && receipt.blockNumber === execution.blockNumber,
      'execution receipt finality mismatch');
    requireThat(snapshot.nonce > p.transaction.nonce, 'execution nonce not consumed');
    const tx = await reader.rpc.getTransaction({ hash: txHash });
    requireThat(tx.to?.toLowerCase() === snapshot.safe, 'nested Safe execution requires independent effect reconciliation');
    const decoded = decodeFunctionData({ abi: safeReadAbi, data: tx.input });
    requireThat(decoded.functionName === 'execTransaction', 'unexpected Safe transaction');
    const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = decoded.args;
    const actual: SafeTransaction = { to, value, data, operation: operation as 0 | 1, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce: p.transaction.nonce };
    const id = safeDigest(m.chainId, snapshot.safe, actual);
    requireThat(id === event.args.txHash && (id === p.id || id === replacement?.id), 'Safe calldata/hash mismatch');
    const executions = receipt.logs.filter(l => l.address.toLowerCase() === snapshot.safe
      && ['ExecutionSuccess', 'ExecutionFailure'].includes(decodeLog(safeReadAbi, l)?.eventName ?? ''));
    requireThat(executions.length === 1 && executions[0]?.data === execution.data && executions[0]?.logIndex === execution.logIndex,
      'ambiguous Safe execution effects');
    requireThat(uint.parse(event.args.payment) === 0n && actual.gasPrice === 0n, 'unexpected Safe gas reimbursement');
    const success = event.eventName === 'ExecutionSuccess';
    const common = { chainId: m.chainId, safe: snapshot.safe, txHash, logIndex: BigInt(present(execution.logIndex, 'missing execution index')),
      safeTxHash: id, nonce: p.transaction.nonce, nonceAfter: snapshot.nonce, canonical: true, effectsVerified: true, status: success ? 'success' : 'failed' };
    if (id === replacement?.id) {
      requireThat(success && actual.to.toLowerCase() === snapshot.safe && actual.value === 0n && actual.data === '0x' && actual.operation === 0,
        'cancellation effects not verified');
      result.push({ kind: 'cancellation', id, result: common }); continue;
    }
    if (!success) { result.push({ kind: 'action', id: p.id, result: common }); continue; }
    const draft = p.draft, effect: Record<string, unknown> = { ...common, amountIn: draft.amountIn, amountOut: 0n };
    if (draft.inputAsset !== zeroAddress) {
      const delta = tokenNet(receipt.logs, draft.inputAsset, snapshot.safe);
      requireThat(delta.outgoing - delta.incoming === draft.amountIn, 'execution input transfer mismatch');
    }
    if (draft.request.kind === 'sale') {
      effect.amountOut = draft.outputAsset === zeroAddress ? nativeIn(receipt.logs, snapshot.safe)
        : tokenNet(receipt.logs, draft.outputAsset, snapshot.safe).incoming - tokenNet(receipt.logs, draft.outputAsset, snapshot.safe).outgoing;
      if (draft.inputAsset === zeroAddress) {
        requireThat(nativeIn(receipt.logs, snapshot.safe) === 0n, 'partial native input needs reconciliation');
        const deposit = encodeFunctionData({ abi: wethAbi, functionName: 'deposit' });
        // The signed calls survive route retirement and are the authority for the original wrap.
        if (draft.calls.some(call => call.to === m.weth && call.data === deposit && call.value === draft.amountIn)) {
          const wrapped = tokenNet(receipt.logs, m.weth, snapshot.safe);
          requireThat(wrapped.outgoing - wrapped.incoming === draft.amountIn, 'partial wrapped input needs reconciliation');
        }
      }
      requireThat(uint.parse(effect.amountOut) >= draft.minimumOut, 'execution output below minimum');
    } else if (draft.request.kind === 'fund') {
      const events = receipt.logs.filter(l => l.address.toLowerCase() === m.box0.executor).map(l => decodeLog(fitBuybackExecutorAbi, l))
        .filter(e => e?.eventName === 'BudgetFunded' && address.parse(e.args.from) === snapshot.safe);
      requireThat(events.length === 1 && uint.parse(events[0]?.args.amount) === draft.amountIn, 'executor funding receipt mismatch');
      effect.budgetFunded = draft.amountIn;
    } else {
      const burned = receipt.logs.filter(l => l.address.toLowerCase() === m.box0.fit).map(l => decodeLog(boxTokenAbi, l))
        .filter(e => e?.eventName === 'Transfer' && address.parse(e.args.from) === snapshot.safe && address.parse(e.args.to) === zeroAddress)
        .reduce((n, e) => n + uint.parse(e?.args.amount), 0n);
      requireThat(burned === draft.amountIn, 'FIT burn receipt mismatch');
      const block = await reader.block({ blockNumber: receipt.blockNumber });
      const before = uint.parse(await reader.read(m.box0.fit, boxTokenAbi, 'totalSupply', { ...block, number: block.number - 1n }));
      const after = uint.parse(await reader.read(m.box0.fit, boxTokenAbi, 'totalSupply', block));
      requireThat(before - after >= burned, 'FIT supply reduction not verified'); effect.supplyReduction = burned;
    }
    result.push({ kind: 'action', id: p.id, result: effect });
  }
  await reader.canonical(observation.snapshots.fit.block); return result;
}
