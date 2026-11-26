import { pileConfigV2 } from '../../../../chain/src/core/v2/m3-spec-v2';
import type { CoreEventV2 } from './events-v2';
import type { BoxViewContextV2 } from './views-v2';
/**
 * The conversions' totals, each in its own units: P spent on conversions (`inputP`), pile coin they delivered
 * (`receivedAsset`), and P a step too small to convert moved as claims to the box hook instead (`dustToDepthP`,
 * RC5-B's `DustToDepth`). Dust is neither converted P nor anything the pile received.
 */
export interface AlchemistGrowthV21 { readonly inputP: bigint; readonly receivedAsset: bigint; readonly dustToDepthP: bigint }
const same = (a: unknown,b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/**
 * Canonical ordered block only. Authenticate each pinned module/receiver/pile and consume the following
 * core execution exactly once. Reorg rewind and log deduplication remain in applyV2Block.
 */
export function alchemistGrowthV21(events: readonly CoreEventV2[], ctx: BoxViewContextV2, prior?: AlchemistGrowthV21): AlchemistGrowthV21 | undefined {
  if (!ctx.spec || ctx.spec.boxType !== 5 || !ctx.pile || !ctx.feeModules?.length) return prior;
  const asset = pileConfigV2(ctx.spec.contentsParams).asset;
  let inputP = prior?.inputP ?? 0n, receivedAsset = prior?.receivedAsset ?? 0n, dustToDepthP = prior?.dustToDepthP ?? 0n;
  const used = new Set<CoreEventV2>();
  /** The receiver's own ModuleExecuted for this module and amount, later in the same transaction, used once. */
  const execution = (e: CoreEventV2, amount: bigint) => events.find(d => !used.has(d) && d.boxId === ctx.boxId && d.source === 'receiver' && d.name === 'ModuleExecuted'
    && same(d.address,ctx.receiver) && same(d.args.module,e.address) && d.args.amount === amount
    && d.ref.txHash === e.ref.txHash && d.ref.logIndex > e.ref.logIndex);
  for (const e of events) {
    if (e.boxId !== ctx.boxId || e.source !== 'feeModule') continue;
    const a = e.args;
    if (e.name === 'DustToDepth') {
      // The authenticated coordinator supplies the hook; verify it against this box's recorded hook too.
      if (!ctx.feeModules.some(m => same(m.module,e.address)) || !same(a.receiver,ctx.receiver) || !same(a.asset,ctx.p) || !same(a.hook,ctx.hook)) throw new Error('dust identity mismatch');
      if (typeof a.amount !== 'bigint' || a.amount <= 0n) throw new Error('invalid dust amount');
      const done = execution(e, a.amount);
      if (!done) throw new Error('dust has no matching module execution');
      used.add(done); dustToDepthP += a.amount;
      continue;
    }
    if (e.name !== 'PileConverted') continue;
    if (!ctx.feeModules.some(m => same(m.module,e.address)) || !same(a.receiver,ctx.receiver)
      || !same(a.pile,ctx.pile) || !same(a.asset,asset)) throw new Error('conversion identity mismatch');
    if (typeof a.amountIn !== 'bigint' || a.amountIn <= 0n || typeof a.amountOut !== 'bigint' || a.amountOut <= 0n) throw new Error('invalid conversion amounts');
    const done = execution(e, a.amountIn);
    if (!done) throw new Error('conversion has no matching module execution');
    used.add(done); inputP += a.amountIn; receivedAsset += a.amountOut;
  }
  return { inputP,receivedAsset,dustToDepthP };
}
