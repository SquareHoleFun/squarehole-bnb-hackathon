import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { HANG_BLOCKS, REBROADCAST_BLOCKS, UNDERPRICED_HEADS, bump, journalHashes, type SentEntry, type SentTx } from './sent';
import { inspectBooks } from './state';

/**
 * SH-249 read-only report: given a COPY of a keeper journal (with its `.starts` and `.sent` sidecars beside it, when they
 * exist) and a public endpoint, prints per signer the mined and pending counts, every saved transaction by nonce with its
 * state and what the keeper would do with it, and every reservation without a hash (box, job, age, cost). It needs no key
 * and no settings file, signs nothing, broadcasts nothing and writes nothing.
 *
 *   SH_KEEPER_RPC_URL=<public endpoint> pnpm --filter @squarehole/keeper sent <copy of keeper.json>
 */
export const USAGE = 'usage: SH_KEEPER_RPC_URL=<public endpoint> pnpm --filter @squarehole/keeper sent <copy of keeper.json>';

interface Reads {
  chainId(): Promise<number>;
  head(): Promise<{ number: bigint; timestamp: bigint; baseFeePerGas?: bigint }>;
  finalized(): Promise<{ number: bigint; hash: string } | null>;
  blockHash(n: bigint): Promise<string | null>;
  count(address: string, tag: 'latest' | 'pending'): Promise<bigint>;
  receipt(hash: string): Promise<{ from: string; blockNumber: bigint; blockHash: string; status: string } | null>;
  /** The wallet's balance at the latest block. */
  balance(address: string): Promise<bigint>;
  /** What this endpoint knows of a hash: in its pool, in a block, or nothing (null when it does not answer). */
  known(hash: string): Promise<'pool' | 'block' | 'unknown' | null>;
}

export function viemReads(pub: PublicClient): Reads {
  return {
    chainId: () => pub.getChainId(),
    head: async () => {
      const b = await pub.getBlock({ blockTag: 'latest' });
      return { number: b.number ?? 0n, timestamp: b.timestamp, ...(typeof b.baseFeePerGas === 'bigint' ? { baseFeePerGas: b.baseFeePerGas } : {}) };
    },
    finalized: async () => { const b = await pub.getBlock({ blockTag: 'finalized' }); return b.number === null || b.hash === null ? null : { number: b.number, hash: b.hash }; },
    blockHash: async n => (await pub.getBlock({ blockNumber: n })).hash,
    count: async (address, tag) => BigInt(await pub.getTransactionCount({ address: address as Address, blockTag: tag })),
    balance: async address => pub.getBalance({ address: address as Address }),
    known: async hash => {
      try {
        const tx = await pub.request({ method: 'eth_getTransactionByHash', params: [hash as Hex] }) as { blockNumber?: string | null } | null;
        return tx === null ? 'unknown' : tx.blockNumber ? 'block' : 'pool';
      } catch { return null; }
    },
    receipt: async hash => {
      try {
        const r = await pub.getTransactionReceipt({ hash: hash as Hex });
        return { from: r.from.toLowerCase(), blockNumber: r.blockNumber, blockHash: r.blockHash, status: r.status };
      } catch { return null; }
    },
  };
}

const ago = (now: bigint, at: bigint) => now >= at ? `${now - at}s` : 'in the future';

/** The report lines; `file` is a copy, never the live journal. */
export async function sentReport(file: string, reads: Reads): Promise<string[]> {
  const { identity, state, sent } = inspectBooks(file);
  const [chain, keeper] = identity.split(':');
  const id = await reads.chainId();
  if (String(id) !== chain) throw new Error('the endpoint is on another chain than the journal');
  const head = await reads.head();
  const named = journalHashes(state);
  const out = [`journal chain ${chain}, head ${head.number} at ${head.timestamp}`];
  const signers = [...new Set([keeper ?? '', ...sent.entries.map(e => e.signer)].filter(s => /^0x[0-9a-f]{40}$/.test(s)))];
  let final: { number: bigint; hash: string } | null | undefined;
  for (const signer of signers) {
    const [latest, pending] = await Promise.all([reads.count(signer, 'latest'), reads.count(signer, 'pending')]);
    const balance = await reads.balance(signer).then(b => `${b} wei`, () => 'not answered');
    const mine = sent.entries.filter(e => e.signer === signer).sort((a, b) => a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0);
    let recorded = sent.next[signer];
    for (const e of mine) if (recorded === undefined || e.nonce + 1n > recorded) recorded = e.nonce + 1n;
    const open = mine.filter(e => e.state === 'signed' || e.nonce >= latest).length;
    const privately = mine.some(e => e.privately);
    out.push(`signer ${signer}${privately ? ' (private sends: their pending transactions never show in this public count)' : ''}: latest ${latest}, pending ${pending}, balance ${balance}, saved ${mine.length}, open ${open}`
      + (recorded !== undefined ? `, next from record ${recorded}` : '')
      + (pending > (recorded !== undefined && recorded > latest ? recorded : latest) ? ', PENDING ABOVE THE RECORD (a transaction this record does not hold)' : ''));
    if (open === 0) out.push('  no open entry: nothing saved waits at an unused nonce (a rollback or a hand send may proceed)');
    for (const e of mine) {
      const tx = e.txs[e.txs.length - 1];
      if (!tx) continue;
      const r = e.reservation;
      // A private send goes to the private endpoint only: a public endpoint never sees it in a pool (re-check R3).
      const known = e.privately ? 'private' : await reads.known(tx.hash);
      const where = (k: typeof known) => k === 'private' ? 'a private send, not visible on a public endpoint' : k === null ? 'did not answer' : k === 'pool' ? 'in its pool' : k === 'block' ? 'in a block' : 'does not know it';
      // SH-250: a nonce with replacements or a takeover lists every transaction signed for it.
      const many = e.txs.length > 1;
      const txLines = !many ? [] : await Promise.all(e.txs.map(async (t, i) => `      tx ${i + 1} ${t.hash} maxFee ${t.maxFeePerGas} priority ${t.maxPriorityFeePerGas}`
        + `${t.call ? ` takeover by ${t.call.job}` : ''}${t.state === 'signed' ? ' (saved, not yet broadcast)' : ''}, signed ${head.number >= t.block ? head.number - t.block : 0n} blocks ago, this endpoint: ${where(e.privately ? 'private' : await reads.known(t.hash))}`));
      const head2 = (many ? `  nonce ${e.nonce}: ${e.txs.length} transactions,` : `  nonce ${e.nonce} ${tx.hash}`) + ` job ${e.job}${e.privately ? ' (private)' : ''} to ${e.to} gas ${tx.gas} maxFee ${tx.maxFeePerGas}`
        + (r ? ` reserved ${r.costWei} on day ${r.day}${r.income ? ` box ${r.income.box}${r.income.start ? ` start ${r.income.start}` : ''}` : ''}${r.bounty ? ` bounty ${r.bounty}` : ''}` : ' (no reservation)')
        + (many ? '' : `, signed ${head.number >= tx.block ? head.number - tx.block : 0n} blocks ago, this endpoint: ${where(known)}`)
        + (many ? `\n${txLines.join('\n')}` : '');
      let what: string;
      if (e.state === 'signed') {
        what = e.txs.some(t => named.has(t.hash)) ? 'signed, the journal names it: at start it is marked sent and its saved bytes are broadcast'
          : 'signed, never broadcast and never reserved: dropped at start, its nonce is free';
      } else if (latest <= e.nonce) {
        what = `pending: the keeper broadcasts the saved bytes again (at start, after a lost reply, then every ${REBROADCAST_BLOCKS} blocks)`
          + `\n    next: ${nextStep(e, tx, head.baseFeePerGas)}`;
      } else {
        const receipt = await reads.receipt(tx.hash);
        if (!receipt) what = 'nonce used, no readable receipt for this hash: kept, its reservation stays charged, no broadcast'
          + '\n    next: released with its charges once the transaction that used the nonce is found in a final block and is not ours';
        else {
          final ??= await reads.finalized();
          const canonical = final !== null && receipt.blockNumber <= final.number && await reads.blockHash(receipt.blockNumber) === receipt.blockHash;
          what = receipt.from !== e.signer ? 'receipt from another sender: kept, charged'
            : canonical ? `final (${receipt.status}) in block ${receipt.blockNumber}: the keeper retires the entry; the journal settles it`
            : `mined in block ${receipt.blockNumber}, not final yet: wait`;
        }
      }
      out.push(`${head2}\n    ${what}`);
    }
  }
  const hashless: string[] = [];
  for (const p of state.budget?.pending ?? []) {
    if (p.hash === undefined) hashless.push(`  daily reservation day ${state.budget?.day ?? '?'}: job unknown, box ${p.box ?? 'none'}, cost ${p.costWei}${p.counter ? ` (${p.counter})` : p.ours ? ` (${p.ours})` : ''}`);
  }
  for (const s of state.incomeSpend ?? []) {
    if (s.hash === undefined) hashless.push(`  income spend: box ${s.box.toLowerCase()}, job ${s.start ? `${s.start.job} (first collection${s.start.settledAt !== undefined || s.start.repaidAt !== undefined ? ', paid' : ', unpaid: its box waits'})` : 'unknown'}, age ${ago(head.timestamp, s.at)}, cost ${s.costWei}`);
  }
  for (const [key, b] of Object.entries(state.drandBounties ?? {})) {
    if (b.hash === undefined) hashless.push(`  drand bounty ${key}: job drandGraduationBounty, box 0, value reserved`);
  }
  out.push(`reservations without a hash: ${hashless.length} (kept as they are; only a reviewed operator step may resolve them)`, ...hashless);
  return out;
}

/**
 * What the keeper would do next with an unused nonce (SH-250 B2), with the default fee settings (3 gwei, 50 gwei for a
 * random-number job's rescue charge, 0.05 gwei priority): the report reads no settings file.
 */
function nextStep(e: SentEntry, tx: SentTx, base: bigint | undefined): string {
  if (base === undefined || tx.maxFeePerGas >= base) return `wait; broadcast again every ${REBROADCAST_BLOCKS} blocks`;
  if (e.reservation?.income?.start) return 'a first collection is never replaced: waits for the base fee (or a random-number takeover)';
  if (!e.reservation || e.txs.some(t => t.call)) return 'waits for the base fee';
  const cap = e.reservation.counter === 'drandRescue' ? 50_000_000_000n : 3_000_000_000n;
  const step = bump(tx.maxFeePerGas);
  const priority = bump(tx.maxPriorityFeePerGas) > 50_000_000n ? bump(tx.maxPriorityFeePerGas) : 50_000_000n;
  const wanted = 2n * base + priority > step ? 2n * base + priority : step;
  const fee = wanted > cap ? cap : wanted;
  if (fee < step || priority > fee) return 'at its fee ceiling; waits for the base fee or a random-number takeover';
  return `replace at maxFee ${fee} priority ${priority} once it hangs (${HANG_BLOCKS} blocks unmined or ${UNDERPRICED_HEADS} heads below the base fee; default settings)`;
}

async function cli() {
  const file = process.argv[2];
  const url = process.env.SH_KEEPER_RPC_URL;
  if (!file || process.argv.length !== 3 || !url) { process.stderr.write(`${USAGE}\n`); process.exitCode = 2; return; }
  const pub = createPublicClient({ transport: http(url, { retryCount: 1, timeout: 15_000 }) });
  try { process.stdout.write(`${(await sentReport(file, viemReads(pub))).join('\n')}\n`); }
  catch (error) {
    // Node text is untrusted and may carry the endpoint: print only the class and our own fixed messages.
    const message = error instanceof Error && /^(journal copy missing|the endpoint is on another chain than the journal|keeper (state|starts|sent record) invalid)/.test(error.message) ? error.message : 'report failed';
    process.stderr.write(`${message}\n`); process.exitCode = 1;
  }
}

if (process.argv[1] && /sent-report\.ts$/.test(process.argv[1])) void cli();
