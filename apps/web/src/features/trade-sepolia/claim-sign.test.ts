import { hexToString } from 'viem';
import { describe, expect, it } from 'vitest';
import { signClaimText } from './claim-sign';

/** F161 (4), SH-ALPHA-SITE: the claim's one signature request, and what a wallet's answer may be. */
const ACCOUNT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const RS = 'ab'.repeat(64);

describe('the claim’s signature (F161 (4), SH-ALPHA-SITE)', () => {
  it('asks once, personal_sign with the text as UTF-8 hex, then the account', async () => {
    const asked: { method: string; params?: unknown }[] = [];
    const result = await signClaimText(async (args) => { asked.push(args); return `0x${RS}1b`; }, ACCOUNT, 'Claim ID: x\nTime: y');
    expect(result).toEqual({ ok: true, signature: `0x${RS}1b` });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.method).toBe('personal_sign');
    const [hex, account] = asked[0]?.params as [`0x${string}`, string];
    expect(hexToString(hex)).toBe('Claim ID: x\nTime: y');
    expect(account).toBe(ACCOUNT);
  });

  it('takes a 65-byte signature only, with v 0 or 1 written as 27 or 28', async () => {
    expect(await signClaimText(async () => `0x${RS}00`, ACCOUNT, 't')).toEqual({ ok: true, signature: `0x${RS}1b` });
    expect(await signClaimText(async () => `0x${RS}01`, ACCOUNT, 't')).toEqual({ ok: true, signature: `0x${RS}1c` });
    for (const answer of [null, '0x', `0x${RS}`, `0x${RS}1b00`, 42, `${RS}1b`]) expect(await signClaimText(async () => answer, ACCOUNT, 't'), String(answer)).toEqual({ ok: false, reason: 'wallet' });
  });

  it('a refusal in the wallet is “declined”; any other failure “wallet”', async () => {
    expect(await signClaimText(async () => { throw Object.assign(new Error('no'), { code: 4001 }); }, ACCOUNT, 't')).toEqual({ ok: false, reason: 'declined' });
    expect(await signClaimText(async () => { throw new Error('boom'); }, ACCOUNT, 't')).toEqual({ ok: false, reason: 'wallet' });
  });
});
