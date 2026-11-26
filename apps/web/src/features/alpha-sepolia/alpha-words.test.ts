// @vitest-environment node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { TRADE_PATTERN } from '../../../production-check';
import { appCopyFraming, unnegatedReturnFraming } from '../legal/wording';
import { BNB_STARTER_AMOUNT, CLAIM_WORDS, DESK_WORDS, JOIN_WORDS, SETUP_DETAILS, SETUP_WORDS, claimLine, claimReleased, decisionQuestion, refusalLine } from './alpha-words';
import { DRY_RUN_REASON, type ClaimState } from './alpha-api';

/** F161 (4), SH-ALPHA-SITE: the alpha's lines: short, under the app's wording rule, with no trade marker or Privy host. */
const claim = (status: ClaimState['status'], over: Partial<ClaimState> = {}): ClaimState => ({ id: '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60', status, admitTx: null, sendTx: null, reason: null, at: status === 'queued' ? null : '2026-10-29T12:00:00Z', ...over });

describe('the alpha’s words (F161 (4), SH-ALPHA-SITE)', () => {
  it('shows a refill wait separately from refusal and never offers a second claim', () => {
    expect(claimLine(claim('waiting'))).toBe('Waiting: the faucet is being refilled.');
    expect(claimLine(claim('refused'))).toBe('Refused. Nothing was sent.');
    expect(claimReleased(claim('waiting'))).toBe(false);
  });
  const lines = [
    ...Object.values(JOIN_WORDS), ...Object.values(CLAIM_WORDS), ...Object.values(DESK_WORDS),
    // F166 (SH-ALPHA-ONBOARDING): "Set me up" and what it does.
    ...Object.values(SETUP_WORDS), ...SETUP_DETAILS,
    ...[0, -1, 401, 403, 404, 409, 429, 400, 500, 503, 418].map((status) => refusalLine({ ok: false, status, error: 'x' })),
    refusalLine({ ok: false, status: 401, error: 'expired identity' }), refusalLine({ ok: false, status: 403, error: 'approval required' }),
    refusalLine({ ok: false, status: 400, error: 'invalid signature' }), refusalLine({ ok: false, status: 400, error: 'claim message mismatch' }),
    ...(['queued', 'waiting', 'sent', 'skipped', 'refused', 'failed'] as const).map((status) => claimLine(claim(status))), claimLine(claim('skipped', { reason: DRY_RUN_REASON })),
    ...(['approve', 'remove', 'reset'] as const).map((decision) => decisionQuestion(decision, 'tester')),
  ];

  it('follow the app’s wording rule and carry no trade marker and no host of Privy’s (the join page loads them at first paint)', () => {
    expect(unnegatedReturnFraming(lines)).toEqual([]);
    expect(appCopyFraming(lines)).toEqual([]);
    for (const line of lines) {
      expect(line).not.toMatch(new RegExp(TRADE_PATTERN.source, TRADE_PATTERN.flags));
      expect(line).not.toMatch(/auth\.privy\.io|privy\.systems|reward/i);
    }
  });

  it('are short: a status line or a button is at most a sentence or two', () => {
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('SH-220: the line under “Sign in with X” on phones is the founder’s approved sentence, exactly (15 November 2026)', () => {
    expect(JOIN_WORDS.phoneLogin).toBe('On a phone, X asks you to log in once. That’s X, not us.');
  });

  it('say each refusal of our server in its own words', () => {
    expect(refusalLine({ ok: false, status: 0, error: 'no answer' })).toBe('No answer from our server. Try again.');
    expect(refusalLine({ ok: false, status: 409, error: 'already claimed' })).toBe('This X account or wallet has claimed already.');
    expect(refusalLine({ ok: false, status: 429, error: 'daily claim cap reached' })).toBe('Today’s claims are used up. Try again tomorrow.');
    expect(refusalLine({ ok: false, status: 503, error: 'service unavailable' })).toBe('The alpha service is not available. Try again later.');
    expect(refusalLine({ ok: false, status: 403, error: 'same origin required' })).toBe('This page must be opened at its own address.');
  });

  it('a claim leaves room for a fresh one only after the sender’s exact dry-run receipt', () => {
    expect(claimReleased(null)).toBe(true);
    expect(claimReleased(claim('skipped', { reason: DRY_RUN_REASON }))).toBe(true);
    expect(claimReleased(claim('skipped', { reason: 'something else' }))).toBe(false);
    expect(claimReleased(claim('skipped', { reason: DRY_RUN_REASON, sendTx: `0x${'1'.repeat(64)}` }))).toBe(false);
    for (const status of ['queued', 'sent', 'refused', 'failed'] as const) expect(claimReleased(claim(status)), status).toBe(false);
  });
});


it('SH-198 says queue position or sending, without an ETA', () => {
  const c = { id: '11111111-1111-4111-8111-111111111111', status: 'queued' as const, position: 12, admitTx: null, sendTx: null, reason: null, at: null };
  expect(claimLine(c)).toBe('Claim queued: position 12.');
  expect(claimLine({ ...c, status: 'sending' })).toBe('Sending your starter coins.');
});

describe('SH-275: the alpha’s words on BNB Chain testnet', () => {
  it('the coin names from the profile; the faucet-opening words cut to the starter (its faucet is open to all)', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    try {
      const words = await import('./alpha-words');
      expect(words.JOIN_WORDS.claim).toBe('Claim test BNB');
      expect(words.CLAIM_WORDS.lead).toBe('Starter tBNB, for one wallet.');
      expect(words.claimLine(claim('sent'))).toBe('Sent: your starter tBNB.');
      expect(words.SETUP_WORDS.lead).toBe('A wallet, 0.015 tBNB for gas and 1 tETH to play with. One press.');
      // SH-284: the third step and its arriving line name the gas.
      expect([words.SETUP_WORDS.stepCoins, words.SETUP_WORDS.stepTeth, words.SETUP_WORDS.arriving]).toEqual(['tBNB', 'tETH', 'tBNB sent. Waiting for the chain…']);
      expect(words.SETUP_WORDS.onItsWay).toBe('On the list. Your starter tBNB is on its way.');
      expect(words.SETUP_WORDS.sepEth).toBe('tBNB');
      expect(words.SETUP_DETAILS[2]).toBe('Our server sends it starter tBNB.');
      const all = [...Object.values(words.JOIN_WORDS), ...Object.values(words.CLAIM_WORDS), ...Object.values(words.SETUP_WORDS), ...words.SETUP_DETAILS].join('\n');
      expect(all).not.toMatch(/SepETH|Sepolia|test ETH/);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    // Sepolia's words are the literal strings they were.
    expect([JOIN_WORDS.claim, CLAIM_WORDS.lead, SETUP_WORDS.lead, SETUP_WORDS.sepEth]).toEqual(['Claim test ETH', 'Starter SepETH and the tETH faucet, for one wallet.', 'A wallet, test ETH and your first tETH. One press.', 'SepETH']);
    expect([SETUP_WORDS.stepCoins, SETUP_WORDS.stepTeth, SETUP_WORDS.arriving]).toEqual(['Coins', 'tETH', 'Coins sent. Waiting for the chain…']);
  });

  it('SH-284: the starter the BNB words name is the one the alpha\'s sender sends on chain 97 (its chain table)', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const { ALPHA_CHAINS } = await import(/* @vite-ignore */ join(root, 'infra/server/services/alpha/chains.mjs')) as { ALPHA_CHAINS: Record<number, { starter: bigint; coin: string }> };
    const starter = ALPHA_CHAINS[97];
    expect(starter?.coin).toBe('tBNB');
    expect(formatEther(starter?.starter ?? 0n)).toBe(BNB_STARTER_AMOUNT);
    // SH-284b: 0.015 tBNB, the founder's figure of 26 November.
    expect(starter?.starter).toBe(15_000_000_000_000_000n);
    expect(BNB_STARTER_AMOUNT).toBe('0.015');
  });
});

