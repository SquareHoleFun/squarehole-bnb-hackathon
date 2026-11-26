/**
 * Site links and the collection page's link (box creation flow § 4.1, § 5): the checks the creation page reports and
 * the box page re-applies before it draws a link (stored data is untrusted), and the spec's URL rule for field 603.
 */
import { Reason } from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import { cleanLinks, linkCount, linkHref, linkProblem, pageLinkReason } from './site-links';

describe('site links (§ 4.1)', () => {
  it('Website: https with a host; X: an @handle or an x.com link; Telegram: a t.me link; empty is fine', () => {
    expect(['', 'https://moons.example', 'https://moons.example/about?x=1#top'].map((text) => linkProblem('website', text))).toEqual([null, null, null]);
    expect(['http://moons.example', 'https://', 'https://localhost', 'javascript:alert(1)', 'moons.example', 'https://moons.example/a b'].map((text) => linkProblem('website', text))).toEqual(Array(6).fill('website'));
    expect(['@moons', 'https://x.com/moons', 'https://www.x.com/moons/'].map((text) => linkProblem('x', text))).toEqual([null, null, null]);
    expect(['moons', '@', 'https://twitter.com/moons', 'https://x.com/moons/status/1'].map((text) => linkProblem('x', text))).toEqual(Array(4).fill('x'));
    expect(['https://t.me/paper_moons', 'https://t.me/moons/'].map((text) => linkProblem('telegram', text))).toEqual([null, null]);
    expect(['https://t.me/abc', 'https://telegram.me/moons', 't.me/moons'].map((text) => linkProblem('telegram', text))).toEqual(Array(3).fill('telegram'));
    expect(linkProblem('website', `https://moons.example/${'a'.repeat(200)}`)).toBe('too-long');
  });

  it('only usable links are kept and drawn (an X handle links to its x.com page)', () => {
    const links = { website: ' https://moons.example ', x: '@moons', telegram: 'https://evil.example' };
    expect(cleanLinks(links)).toEqual({ website: 'https://moons.example', x: '@moons', telegram: '' });
    expect(linkCount(cleanLinks(links))).toBe(2);
    expect(linkHref('x', '@moons')).toEqual({ href: 'https://x.com/moons', text: '@moons' });
    expect(linkHref('website', 'https://moons.example')).toEqual({ href: 'https://moons.example', text: 'moons.example' });
    expect(linkHref('telegram', 'javascript:alert(1)')).toBeNull();
    expect(linkHref('website', '')).toBeNull();
  });
});

describe('the collection page link (field 603, the spec’s URL rule)', () => {
  it('https:// first, RFC 3986 characters, at most 128 bytes; empty is none', () => {
    expect(pageLinkReason('')).toBe(Reason.OK);
    expect(pageLinkReason('https://moons.example/about')).toBe(Reason.OK);
    expect(pageLinkReason('http://moons.example')).toBe(Reason.BAD_CHARACTER);
    expect(pageLinkReason('HTTPS://moons.example')).toBe(Reason.BAD_CHARACTER);
    expect(pageLinkReason('https://moons.example/a b')).toBe(Reason.BAD_CHARACTER);
    expect(pageLinkReason('https://moons.example/"x"')).toBe(Reason.BAD_CHARACTER);
    expect(pageLinkReason(`https://${'a'.repeat(120)}`)).toBe(Reason.OK);
    expect(pageLinkReason(`https://${'a'.repeat(121)}`)).toBe(Reason.LENGTH_OUT_OF_RANGE);
  });
});
