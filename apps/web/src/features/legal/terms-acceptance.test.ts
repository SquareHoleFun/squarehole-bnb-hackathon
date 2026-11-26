import { describe, expect, it, vi } from 'vitest';
import {
  TERMS_ACCEPTANCE_KEY,
  TERMS_COOKIE_NAME,
  createTermsAcceptanceStore,
  parseTermsAcceptance,
  termsCookie,
  type TermsAcceptanceEnv,
} from './terms-acceptance';

const NOW = new Date('2026-09-27T12:34:56.000Z');

/** A Storage double backed by a Map. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const blocked = () => {
  throw new DOMException('blocked', 'SecurityError');
};

/** A cookie jar double: `read()` returns "a=1; b=2" like document.cookie. */
function cookieJar(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  const written: string[] = [];
  return {
    written,
    read: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    write: (cookie: string) => {
      written.push(cookie);
      const [pair] = cookie.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      jar.set(name ?? '', rest.join('='));
    },
  };
}

interface EnvOptions {
  storage?: Storage | null | 'throws';
  cookies?: ReturnType<typeof cookieJar> | 'throws';
  secure?: boolean;
}

function env({ storage = memoryStorage(), cookies = cookieJar(), secure = false }: EnvOptions = {}): TermsAcceptanceEnv {
  return {
    storage: storage === 'throws' ? blocked : () => storage,
    readCookies: cookies === 'throws' ? blocked : cookies.read,
    writeCookie: cookies === 'throws' ? blocked : cookies.write,
    secure: () => secure,
    now: () => NOW,
    events: () => null,
  };
}

const record = (version: string, acceptedAt = '2026-09-27T00:00:00.000Z') => JSON.stringify({ version, acceptedAt });

describe('parseTermsAcceptance', () => {
  it('reads a valid record', () => {
    expect(parseTermsAcceptance(record('v1'))).toEqual({ version: 'v1', acceptedAt: '2026-09-27T00:00:00.000Z' });
  });

  it.each([
    ['missing', null],
    ['corrupt JSON', '{"version":'],
    ['not an object', '"v1"'],
    ['an array', '["v1"]'],
    ['no version', JSON.stringify({ acceptedAt: '2026-09-27T00:00:00.000Z' })],
    ['empty version', record('')],
    ['non-string version', JSON.stringify({ version: 1, acceptedAt: '2026-09-27T00:00:00.000Z' })],
    ['no acceptedAt', JSON.stringify({ version: 'v1' })],
    ['acceptedAt not a date', record('v1', 'yesterday')],
  ])('rejects %s', (_name, raw) => {
    expect(parseTermsAcceptance(raw)).toBeNull();
  });
});

describe('terms acceptance store (F19)', () => {
  it('is not accepted when nothing is stored', () => {
    expect(createTermsAcceptanceStore('v1', env()).isAccepted()).toBe(false);
  });

  it('is accepted when the stored version matches', () => {
    const storage = memoryStorage({ [TERMS_ACCEPTANCE_KEY]: record('v1') });
    expect(createTermsAcceptanceStore('v1', env({ storage })).isAccepted()).toBe(true);
  });

  it('is not accepted when the stored version differs (a new version asks again)', () => {
    const storage = memoryStorage({ [TERMS_ACCEPTANCE_KEY]: record('v0') });
    expect(createTermsAcceptanceStore('v1', env({ storage })).isAccepted()).toBe(false);
  });

  it('is not accepted when the stored value is corrupt', () => {
    const storage = memoryStorage({ [TERMS_ACCEPTANCE_KEY]: 'not json at all' });
    expect(createTermsAcceptanceStore('v1', env({ storage })).isAccepted()).toBe(false);
  });

  it('accept stores {version, acceptedAt} under one localStorage key and writes no cookie', () => {
    const storage = memoryStorage();
    const cookies = cookieJar();
    const store = createTermsAcceptanceStore('v1', env({ storage, cookies }));
    expect(store.accept()).toBe('saved');
    expect(store.isAccepted()).toBe(true);
    expect(storage.length).toBe(1);
    expect(JSON.parse(storage.getItem(TERMS_ACCEPTANCE_KEY) ?? 'null')).toEqual({ version: 'v1', acceptedAt: NOW.toISOString() });
    expect(cookies.written).toEqual([]);
    // A reload (a new store over the same storage) stays accepted.
    expect(createTermsAcceptanceStore('v1', env({ storage })).isAccepted()).toBe(true);
  });

  it('a version bump after acceptance asks again', () => {
    const storage = memoryStorage();
    createTermsAcceptanceStore('v1', env({ storage })).accept();
    expect(createTermsAcceptanceStore('v2', env({ storage })).isAccepted()).toBe(false);
  });

  it('survives a throwing localStorage accessor: falls back to a first-party cookie', () => {
    const cookies = cookieJar();
    const store = createTermsAcceptanceStore('v1', env({ storage: 'throws', cookies }));
    expect(store.isAccepted()).toBe(false);
    expect(store.accept()).toBe('saved_cookie');
    expect(store.isAccepted()).toBe(true);
    expect(cookies.written).toHaveLength(1);
    // A reload reads the cookie while localStorage still throws.
    expect(createTermsAcceptanceStore('v1', env({ storage: 'throws', cookies })).isAccepted()).toBe(true);
  });

  it('survives getItem/setItem that throw (quota, blocked site data)', () => {
    const storage = memoryStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(blocked);
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const cookies = cookieJar();
    const store = createTermsAcceptanceStore('v1', env({ storage, cookies }));
    expect(() => store.isAccepted()).not.toThrow();
    expect(store.accept()).toBe('saved_cookie');
    expect(store.isAccepted()).toBe(true);
  });

  it('when nothing can be stored, acceptance lasts for this page session only', () => {
    const store = createTermsAcceptanceStore('v1', env({ storage: 'throws', cookies: 'throws' }));
    expect(store.accept()).toBe('session_only');
    expect(store.isAccepted()).toBe(true);
    expect(createTermsAcceptanceStore('v1', env({ storage: 'throws', cookies: 'throws' })).isAccepted()).toBe(false);
  });

  it('a cookie the browser silently refused counts as not stored', () => {
    const refusing = { ...cookieJar(), write: () => undefined };
    const store = createTermsAcceptanceStore('v1', env({ storage: null, cookies: { ...refusing, written: [] } }));
    expect(store.accept()).toBe('session_only');
    expect(store.isAccepted()).toBe(true);
  });

  it('accepts a matching record from the cookie even when localStorage works (the E2E pre-acceptance path)', () => {
    const cookies = cookieJar({ other: 'x', [TERMS_COOKIE_NAME]: encodeURIComponent(record('v1')) });
    expect(createTermsAcceptanceStore('v1', env({ cookies })).isAccepted()).toBe(true);
    expect(createTermsAcceptanceStore('v2', env({ cookies })).isAccepted()).toBe(false);
  });

  it('ignores a corrupt or undecodable cookie', () => {
    expect(createTermsAcceptanceStore('v1', env({ cookies: cookieJar({ [TERMS_COOKIE_NAME]: '%E0%A4%A' }) })).isAccepted()).toBe(false);
    expect(createTermsAcceptanceStore('v1', env({ cookies: cookieJar({ [TERMS_COOKIE_NAME]: 'v1' }) })).isAccepted()).toBe(false);
  });

  it('notifies subscribers on accept and on a change from another tab', () => {
    const target = new EventTarget();
    const store = createTermsAcceptanceStore('v1', { ...env(), events: () => target });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.accept();
    expect(listener).toHaveBeenCalledTimes(1);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: TERMS_ACCEPTANCE_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'squarehole.settings.v1' }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.accept();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('never writes anything until Accept', () => {
    const storage = memoryStorage();
    const cookies = cookieJar();
    const store = createTermsAcceptanceStore('v1', env({ storage, cookies }));
    store.isAccepted();
    store.subscribe(() => undefined)();
    expect(storage.length).toBe(0);
    expect(cookies.written).toEqual([]);
  });
});

describe('termsCookie', () => {
  it('is first-party, path-wide, Lax, long-lived, and Secure only on https', () => {
    const plain = termsCookie({ version: 'v1', acceptedAt: NOW.toISOString() }, false);
    expect(plain.startsWith(`${TERMS_COOKIE_NAME}=`)).toBe(true);
    expect(plain).toContain('; Path=/');
    expect(plain).toContain('; SameSite=Lax');
    expect(plain).toMatch(/; Max-Age=\d+/);
    expect(plain).not.toContain('Secure');
    expect(plain).not.toMatch(/Domain=/i);
    expect(termsCookie({ version: 'v1', acceptedAt: NOW.toISOString() }, true)).toContain('; Secure');
  });
});
