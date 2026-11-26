/**
 * v2 T06 committed trace files (schema v2 since the placeholder tickets, stage 1): the canonical traces (`packages/domain/src/__traces__/v2-vault/`) and their Foundry
 * export for the T07 contracts (`packages/contracts/test/vectors/v2-vault/`) must be exactly what the seeds produce.
 *
 * To regenerate after an intended change: `pnpm traces:write` (SH_WRITE_TRACES=1), then review the diff.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DIR,
  committedCorpus,
  committedFilePaths,
  FORGE_DIR,
  readCommittedTraces,
  readRepoText,
  renderCorpusFiles,
  writeCorpusFiles,
} from './test-support/vault-trace/corpus';
import { custodyPairs, OP_KINDS, ticketHolder, VAULT_HOLDER, type VaultTrace } from './test-support/vault-trace/format';
import { ERROR_CODES, FORGE_SCHEMA, LIMIT_MAX_FIT, LIMIT_MIN_FIT, LIMIT_NONE } from './test-support/vault-trace/forge';

const corpus = committedCorpus();
const files = renderCorpusFiles(corpus);
if (process.env.SH_WRITE_TRACES === '1') writeCorpusFiles(files);

const MAX_UINT256 = (1n << 256n) - 1n;

type ForgeExport = Record<string, unknown> & {
  steps: number;
  numAccounts: number;
  accounts: string[];
  [column: string]: unknown;
};

const readForge = (id: string): ForgeExport => JSON.parse(readRepoText(`${FORGE_DIR}/${id}.json`)) as ForgeExport;
const column = <T>(f: ForgeExport, name: string): T[] => {
  const value = f[name];
  if (!Array.isArray(value)) throw new Error(`${name} is not a column`);
  return value as T[];
};

describe('committed trace files', () => {
  it('are exactly the files the seeds produce: no missing, stale or edited file', () => {
    expect(committedFilePaths()).toEqual([...files.keys()].sort());
    for (const [path, text] of files) expect(readRepoText(path) === text, `${path} differs; run pnpm traces:write`).toBe(true);
  });

  it('the canonical files parse strictly back into the generated traces', () => {
    const read = readCommittedTraces();
    const byId = new Map(corpus.map((t) => [t.id, t] as const));
    expect(read.map((t) => t.id).sort()).toEqual([...byId.keys()].sort());
    for (const trace of read) expect(trace).toEqual(byId.get(trace.id));
  });

  it('the forge index lists every trace', () => {
    const index = JSON.parse(readRepoText(`${FORGE_DIR}/index.json`)) as { files: string[]; traces: number; steps: number; canonical: string };
    expect(index.files).toEqual(corpus.map((t) => t.id));
    expect(index.traces).toBe(corpus.length);
    expect(index.steps).toBe(corpus.reduce((s, t) => s + t.steps.length, 0));
    expect(index.canonical).toBe(CANONICAL_DIR);
  });
});

describe('Foundry export squarehole.vault-trace.forge/v2', () => {
  const check = (trace: VaultTrace): void => {
    const f = readForge(trace.id);
    const k = trace.accounts.length;
    const steps = trace.steps.length;
    expect(f.schema).toBe(FORGE_SCHEMA);
    expect([f.id, f.steps, f.numAccounts, f.collectionSize, f.initialSupply]).toEqual([trace.id, steps, k, trace.collectionSize, trace.initialSupply]);
    expect(f.accounts).toEqual(trace.accounts);
    expect(f.opKinds).toEqual(OP_KINDS);
    expect(f.errorCodes).toEqual(ERROR_CODES);
    expect(f.rawBalanceDonations).toBe(trace.policy.unsolicitedFit === 'raw-balance');
    expect(f.policyConversionFees).toBe(trace.policy.conversionFees);
    const charged = trace.policy.conversionFees === 'flat-f23';
    expect([f.feeDrawBps, f.feePickBps, f.feeReturnBps]).toEqual(charged ? [100, 2500, 500] : [0, 0, 0]);
    for (const name of ['opKind', 'opA', 'opB', 'opAmount', 'opTokenId', 'opCount', 'opLimitKind', 'opLimit', 'opIdsStart', 'opIdsCount', 'expError', 'expPrincipal', 'expFee', 'expSupply', 'expEscrow', 'expUnsolicited', 'expInside', 'expHidden', 'expTickets', 'expGateOpen', 'expRevealed', 'expQuoteTake1', 'expQuoteTake1Error', 'expSurplusFloor', 'expCustodyStart', 'expCustodyCount']) {
      expect(column(f, name), `${trace.id} ${name}`).toHaveLength(steps);
    }
    for (const name of ['expBalances', 'expClaimable', 'expNftCounts', 'expTicketCounts']) expect(column(f, name), name).toHaveLength(steps * k);

    const opIds = column<number>(f, 'opIds');
    const custodyIds = column<number>(f, 'expCustodyId');
    const custodyHolders = column<number>(f, 'expCustodyHolder');
    const holderName = (index: number): string => (index === k ? VAULT_HOLDER : index > k ? ticketHolder(trace.accounts[index - k - 1] ?? '?') : (trace.accounts[index] ?? '?'));
    trace.steps.forEach((step, s) => {
      const op = step.op;
      expect(OP_KINDS[column<number>(f, 'opKind')[s] ?? -1]).toBe(op.op);
      const reserved = 'ok' in step.outcome ? (step.outcome.ok.ids ?? []) : [];
      const ids = op.op === 'take' ? reserved : 'ids' in op ? op.ids : [];
      const start = column<number>(f, 'opIdsStart')[s] ?? 0;
      expect(opIds.slice(start, start + (column<number>(f, 'opIdsCount')[s] ?? 0))).toEqual(ids);
      expect(column<number>(f, 'opCount')[s]).toBe(op.op === 'take' ? op.count : 0);
      const limitKind = column<number>(f, 'opLimitKind')[s];
      const maxFit = (op.op === 'take' || op.op === 'withdraw') ? op.maxFit : undefined;
      const minFit = (op.op === 'release' || op.op === 'return') ? op.minFit : undefined;
      if (maxFit !== undefined) expect([limitKind, column<string>(f, 'opLimit')[s]]).toEqual([LIMIT_MAX_FIT, maxFit]);
      else if (minFit !== undefined) expect([limitKind, column<string>(f, 'opLimit')[s]]).toEqual([LIMIT_MIN_FIT, minFit]);
      else expect(limitKind).toBe(LIMIT_NONE);
      const error = column<number>(f, 'expError')[s] ?? -1;
      expect(ERROR_CODES[error]).toBe('ok' in step.outcome ? '' : step.outcome.error);
      expect(column<string>(f, 'expFee')[s]).toBe('ok' in step.outcome ? (step.outcome.ok.fee ?? '0') : '0');

      const st = step.state;
      expect(column<string>(f, 'expSupply')[s]).toBe(st.supply);
      expect(column<string>(f, 'expEscrow')[s]).toBe(st.escrow);
      expect(column<string>(f, 'expUnsolicited')[s]).toBe(st.unsolicited);
      expect(column<number>(f, 'expInside')[s]).toBe(st.inside);
      expect([column<number>(f, 'expHidden')[s], column<number>(f, 'expTickets')[s], column<number>(f, 'expRevealed')[s]]).toEqual([st.hidden, st.tickets, st.revealed]);
      expect(column<number>(f, 'expGateOpen')[s]).toBe(st.gateOpen ? 1 : 0);
      const take1 = column<string>(f, 'expQuoteTake1')[s];
      const take1Error = column<number>(f, 'expQuoteTake1Error')[s] ?? -1;
      const wantTake1 = 'ok' in st.quoteTake1 ? [st.quoteTake1.ok, 0] : ['0', ERROR_CODES.indexOf(st.quoteTake1.error as (typeof ERROR_CODES)[number])];
      expect([take1, take1Error]).toEqual(wantTake1);
      trace.accounts.forEach((account, i) => {
        expect(column<string>(f, 'expBalances')[s * k + i]).toBe(st.balances[account]);
        expect(column<string>(f, 'expClaimable')[s * k + i]).toBe(st.claimable[account]);
        expect(column<number>(f, 'expNftCounts')[s * k + i]).toBe(st.nftCounts[account]);
        expect(column<number>(f, 'expTicketCounts')[s * k + i]).toBe(st.ticketCounts[account]);
      });
      // K = floor + remainder / n, exactly: E·n − m·A = floor·n + remainder.
      const n = BigInt(st.inside);
      const floor = BigInt(column<string>(f, 'expSurplusFloor')[s] ?? '0');
      const rest = BigInt(column<string>(f, 'expSurplusRemainder')[s] ?? '0');
      expect(floor * n + rest).toBe(BigInt(st.identities.Kn));
      expect(rest < n).toBe(true);
      const cStart = column<number>(f, 'expCustodyStart')[s] ?? 0;
      const cCount = column<number>(f, 'expCustodyCount')[s] ?? 0;
      const pairs = custodyIds.slice(cStart, cStart + cCount).map((id, j) => [id, holderName(custodyHolders[cStart + j] ?? -1)]);
      expect(pairs).toEqual(custodyPairs(st.custodyChanges));
    });
    const finalPairs = column<number>(f, 'finalOutsideIds').map((id, j) => [id, trace.accounts[column<number>(f, 'finalOutsideOwners')[j] ?? -1]]);
    expect(finalPairs).toEqual(custodyPairs(trace.final.outside));
    const finalTickets = column<number>(f, 'finalTicketIds').map((id, j) => [id, ticketHolder(trace.accounts[column<number>(f, 'finalTicketHolders')[j] ?? -1] ?? '?')]);
    expect(finalTickets).toEqual(custodyPairs(trace.final.tickets));
  };

  it('every column matches its canonical trace (ops, outcomes, states, custody, final map)', () => {
    for (const trace of corpus) check(trace);
  });

  it('every exported amount is a decimal string within uint256; indexes are small integers', () => {
    for (const trace of corpus) {
      const f = readForge(trace.id);
      for (const [name, value] of Object.entries(f)) {
        if (!Array.isArray(value)) continue;
        for (const item of value as unknown[]) {
          if (typeof item === 'string' && /^[0-9]+$/.test(item)) expect(BigInt(item) <= MAX_UINT256, `${trace.id} ${name}`).toBe(true);
          if (typeof item === 'number') expect(Number.isSafeInteger(item) && item >= 0, `${trace.id} ${name}`).toBe(true);
        }
      }
    }
  });
});
