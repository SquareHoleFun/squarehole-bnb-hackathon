import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { boxLinksDigest, boxLinksTypedData, canonicalWebsite, canonicalX, canonicalTelegram, displayHost, ERC1271_MAGIC_WORD, BOX_LINKS_LIMITS } from './box-links-v2';

describe('LINKS-SRV §1/3: the shared signing contract', () => {
  it.each([
    'https://1.2.3.4', 'https://localhost', 'https://a.localhost', 'https://u:p@a.com', 'http://a.com',
    'https://a.com:8443', 'https://a.com\\b.com', 'https://é.com', 'https://xn--80ak6aa92e.com',
    'https://a.xn--p1ai', `https://a.com/${'a'.repeat(187)}`, 'https://[::1]',
    ...['local', 'internal', 'test', 'invalid', 'example', 'onion', 'arpa'].map(tld => `https://a.${tld}`),
  ])('refuses website %s', (input) => expect(canonicalWebsite(input)).toBeNull());

  it.each([
    ['', ''], ['  ', ''], [' https://A.com/ ', 'https://a.com'],
    ['https://a.com/x/../y', 'https://a.com/y'], ['https://a.com/%2e%2e/y', 'https://a.com/y'],
    ['https://a.com/?a=1#x', 'https://a.com/?a=1#x'],
    [`https://a.com/${'a'.repeat(186)}`, `https://a.com/${'a'.repeat(186)}`],
  ])('canonicalizes website %s', (input, expected) => expect(canonicalWebsite(input)).toBe(expected));

  it.each([
    ['', ''], [' @Junk_yard ', 'Junk_yard'], ['h', 'h'], ['h/', 'h'], ['@h/', 'h'], ['https://mobile.twitter.com/h/', 'h'],
    ['https://twitter.com/h', 'h'], ['https://www.twitter.com/h/', 'h'], ['https://www.x.com/h', 'h'],
    ['x.com/a/status/1', null], ['https://x.com/a/status/1', null], ['https://x.com/a?b', null],
    ['https://mobile.x.com/h', null], ['abcdefghijklmnop', null], ['@', null],
  ])('canonicalizes X %s', (input, expected) => expect(canonicalX(input)).toBe(expected));

  it.each([
    ['', ''], ['t.me/name', 'name'], ['https://t.me/name/', 'name'], [' @Name ', 'Name'], ['name', 'name'], ['@name/', 'name'], ['name/', 'name'],
    ['t.me/+abc', null], ['t.me/joinchat/abc', null], ['1234', null], ['abc', null], ['a'.repeat(33), null],
    ['https://t.me/name?x', null],
  ])('canonicalizes Telegram %s', (input, expected) => expect(canonicalTelegram(input)).toBe(expected));

  it('shows the entire hostname and pins every limit', () => {
    expect(displayHost('https://junkyard.fun.other.com/a')).toBe('junkyard.fun.other.com');
    expect(displayHost('')).toBe('');
    expect(ERC1271_MAGIC_WORD).toBe(`0x1626ba7e${'0'.repeat(56)}`);
    expect(BOX_LINKS_LIMITS).toEqual({ bodyBytes: 4096, bodyTimeoutMs: 5000, websiteChars: 200, signatureBytes: 1024,
      issuedAtMax: (1n << 64n) - 1n, aheadSeconds: 300n, rpcConcurrent: 4, rpcPerMinute: 20,
      rpcTimeoutMs: 3000, rpcGas: 1_000_000n, postPerMinute: 10, reloadMs: 60_000, retryAfterSeconds: 10 });
  });

  it('pins the Anvil account 0 vector, domain, exact field order and JSON-safe signing object', async () => {
    const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const token = '0x1111111111111111111111111111111111111111';
    const links = { website: 'https://junkyard.fun', x: 'Junk_yard', telegram: 'junkyard' };
    const data = boxLinksTypedData(11155111, token, links, 1761300000n);
    expect(data).toEqual({ domain: { name: 'Square Hole', version: '1', chainId: 11155111 }, primaryType: 'BoxLinks',
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
        BoxLinks: [{ name: 'token', type: 'address' }, { name: 'website', type: 'string' }, { name: 'x', type: 'string' }, { name: 'telegram', type: 'string' }, { name: 'issuedAt', type: 'uint64' }] },
      message: { token, ...links, issuedAt: '1761300000' } });
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    const digest = '0x3ee7daa83f48c332b7fccac94f8e94f89f6352e8072583318e2e72097bed86f1';
    const signature = '0xc2d0a83af6fe0e097b39a042b1e5fe56184a621be711cc968e0263d7a2ed4f590cea0ad7e60e38f02a6a9652805470c19e68dc0484b741c5ab06df3df62ea73e1c';
    expect(boxLinksDigest(11155111, token, links, 1761300000n)).toBe(digest);
    const typed = { ...data, domain: { ...data.domain, chainId: 11155111n }, message: { ...data.message, issuedAt: 1761300000n } };
    expect(hashTypedData(typed)).toBe(digest);
    expect(await account.signTypedData(typed)).toBe(signature);
    expect(await recoverAddress({ hash: digest, signature })).toBe(account.address);
  });
});
