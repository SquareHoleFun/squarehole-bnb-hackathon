import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { vi } from 'vitest';

export const address = n => `0x${n.toString(16).padStart(40, '0')}`;
export function config() {
  return { version: 1, chainId: '11155111', safe: address(1), module: address(2), token: address(3), inbox: address(4),
    pricingReviewed: true,
    manager: { model: 'claude-haiku-4-5-20251001', address: address(5), weeklyCapRaw: '300000000',
      payees: { cleaner: address(6), repairs: address(7) }, inputUsdPerMillion: '1', outputUsdPerMillion: '5' },
    bookkeeper: { model: 'claude-sonnet-5-5', inputUsdPerMillion: '3', outputUsdPerMillion: '15' } };
}
export const prompts = { manager: 'Manage the mock rental. Output JSON only.', bookkeeper: 'Write a monthly statement. Output JSON only.' };
export const guest = (id = 'guest-1') => ({ id, kind: 'guest', guestId: 'alice', message: 'When is check-in?' });
export const expense = (id = 'expense-1') => ({ id, kind: 'expense', message: 'Pay the cleaner for this week.' });
export const month = { id: 'month-2026-09', kind: 'month', month: '2026-09', incomeRaw: '900000000', expensesRaw: '200000000' };
export const pay = { action: 'pay', payee: 'cleaner', amountRaw: '100000000' };
export function response(action, usage = { input_tokens: 100, output_tokens: 50 }) {
  return { content: [{ type: 'text', text: typeof action === 'string' ? action : JSON.stringify(action) }], stop_reason: 'end_turn', usage };
}
export function scratch() {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp/agents-'));
  for (const dir of ['state', 'replies', 'statements', 'proposals']) mkdirSync(join(root, dir));
  return { root, journal: () => JSON.parse(readFileSync(join(root, 'state/journal.json'), 'utf8')) };
}
export function fakeChain() {
  return { chainId: vi.fn(async () => 11155111), remaining: vi.fn(async () => 300000000n),
    prepare: vi.fn(async () => ({ raw: '0x01', hash: '0x' + 'a'.repeat(64), nonce: 0 })),
    broadcast: vi.fn(async tx => tx.hash), receipt: vi.fn(async () => null) };
}
