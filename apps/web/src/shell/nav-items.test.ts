// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS, activeNavId, visibleNavItems } from './nav-items';

const ME = '0xDe00000000000000000000000000000000000A11';

describe('primary navigation items (launch set: boxes)', () => {
  it('lists Boxes, Launch, My Box (connected only), Settings and About & risks', () => {
    expect(NAV_ITEMS.map((item) => [item.label, item.to])).toEqual([
      ['Boxes', '/'],
      ['Launch', '/create'],
      ['My Box', '/my-box'],
      ['Settings', '/settings'],
      ['About & risks', '/about/risks'],
    ]);
    expect(visibleNavItems(false).map((item) => item.label)).toEqual(['Boxes', 'Launch', 'Settings', 'About & risks']);
    expect(visibleNavItems(true).map((item) => item.label)).toEqual(['Boxes', 'Launch', 'My Box', 'Settings', 'About & risks']);
  });

  it('marks exactly one item current', () => {
    expect(activeNavId('/', '')).toBe('boxes');
    expect(activeNavId('/', '?q=kites&state=bonding')).toBe('boxes');
    expect(activeNavId('/box/31337/0x000000000000000000000000000000000000f17e', '')).toBe('boxes');
    expect(activeNavId('/my-box', '', ME)).toBe('my-box');
    expect(activeNavId(`/wallet/${ME.toLowerCase()}`, '', ME)).toBe('my-box');
    expect(activeNavId(`/wallet/${ME.toLowerCase()}`, '', null)).toBeNull();
    expect(activeNavId('/wallet/0x0000000000000000000000000000000000000001', '', ME)).toBeNull();
    expect(activeNavId('/about/risks', '')).toBe('risks');
    expect(activeNavId('/settings/', '')).toBe('settings');
    expect(activeNavId('/create', '')).toBe('launch');
    expect(activeNavId('/create/review', '')).toBe('launch');
    expect(activeNavId('/created', '')).toBeNull();
  });

  it('marks nothing current on pages outside the navigation (the hidden routes keep working)', () => {
    for (const path of ['/pairs', '/launch', '/rewards', '/portfolio', '/fit-pair', '/pair/31337/0x0000000000000000000000000000000000000066', '/nope']) {
      expect(activeNavId(path, ''), path).toBeNull();
    }
  });

  it('F166 af2: Test coins only in a Sepolia trade build (a build literal); these tests’ build is none, and the mainnet bundle holds none', () => {
    // The Sepolia builds' item is checked in the browser (alpha-access setup.spec.mjs); production-check and
    // the mainnet bundle grep in the evidence hold the mainnet build to it.
    expect(NAV_ITEMS.some((item) => item.id === 'test-coins')).toBe(false);
    expect(activeNavId('/test-coins', '')).toBeNull();
  });

  it('never resolves names inherited from Object.prototype', () => {
    for (const path of ['__proto__', 'constructor', 'toString', '/__proto__', '/constructor']) {
      expect(activeNavId(path, '')).toBeNull();
    }
  });
});

describe('SH-291: My Box on both networks', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('BNB Chain testnet (no first box generation): My Box is in the navigation for a connected wallet, and active on /my-box', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const nav = await import('./nav-items');
    expect(nav.MY_BOX_SHOWN).toBe(true);
    expect(nav.visibleNavItems(true).map((item) => item.label)).toContain('My Box');
    expect(nav.visibleNavItems(false).map((item) => item.label)).not.toContain('My Box');
    expect(nav.activeNavId('/my-box', '', ME)).toBe('my-box');
  });

  it('the other network keeps it', async () => {
    vi.resetModules();
    const nav = await import('./nav-items');
    expect(nav.MY_BOX_SHOWN).toBe(true);
    expect(nav.visibleNavItems(true).map((item) => item.label)).toContain('My Box');
    expect(nav.visibleNavItems(false).map((item) => item.label)).not.toContain('My Box');
  });
});
