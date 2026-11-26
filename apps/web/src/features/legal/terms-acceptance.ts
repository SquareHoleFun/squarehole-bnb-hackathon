/**
 * Whether this viewer has accepted the current Terms of Use (F19), remembered on their own device as a convenience.
 *
 * Accept writes `{ version, acceptedAt }` (ISO time) under one localStorage key. Nothing is sent anywhere. Storage can
 * be missing or throw (private windows, blocked site data, a full quota), so every access is guarded:
 *   1. localStorage `squarehole.terms`;
 *   2. only if that cannot be written: the same record in a first-party cookie (Path=/, SameSite=Lax, no Domain,
 *      Secure on https), so a browser that blocks localStorage is not asked again on every load;
 *   3. only if neither can be written: in memory, for this page session. The viewer still gets in.
 * Reading accepts a matching record from any of the three. A record for another version (or a malformed one) is not an
 * acceptance, so publishing a new TERMS_VERSION asks everyone again. Declining stores nothing.
 */
import { useSyncExternalStore } from 'react';
import { TERMS_VERSION } from './terms';

export const TERMS_ACCEPTANCE_KEY = 'squarehole.terms';
export const TERMS_COOKIE_NAME = 'squarehole.terms';
/** 400 days, the longest lifetime current browsers keep a cookie. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export interface TermsAcceptanceRecord {
  readonly version: string;
  /** ISO 8601 time of acceptance on the viewer's clock. */
  readonly acceptedAt: string;
}

/** Where an acceptance was kept: localStorage, the fallback cookie, or only this page session. */
export type AcceptResult = 'saved' | 'saved_cookie' | 'session_only';

/** Browser access, injectable for tests. Every function may throw; the store guards each call. */
export interface TermsAcceptanceEnv {
  readonly storage: () => Storage | null;
  readonly readCookies: () => string;
  readonly writeCookie: (cookie: string) => void;
  readonly secure: () => boolean;
  readonly now: () => Date;
  /** Where other tabs' `storage` events arrive (window), or null. */
  readonly events: () => EventTarget | null;
}

export interface TermsAcceptanceStore {
  readonly version: string;
  isAccepted(): boolean;
  /** Records acceptance of `version`. Never throws. */
  accept(): AcceptResult;
  subscribe(listener: () => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A validated record from a stored string, or null (missing, malformed JSON, wrong shape, or a time that is not a date). */
export function parseTermsAcceptance(raw: string | null): TermsAcceptanceRecord | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { version, acceptedAt } = parsed;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof acceptedAt !== 'string' || Number.isNaN(Date.parse(acceptedAt))) return null;
  return Object.freeze({ version, acceptedAt });
}

/** The `document.cookie` assignment for a record: first-party, whole site, Lax, 400 days; Secure on https. */
export function termsCookie(record: TermsAcceptanceRecord, secure: boolean): string {
  const value = encodeURIComponent(JSON.stringify(record));
  return `${TERMS_COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function cookieValue(cookies: string, name: string): string | null {
  for (const part of cookies.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function browserTermsEnv(): TermsAcceptanceEnv {
  const hasWindow = typeof window !== 'undefined';
  return {
    storage: () => (hasWindow ? window.localStorage : null),
    readCookies: () => (typeof document === 'undefined' ? '' : document.cookie),
    writeCookie: (cookie) => {
      if (typeof document !== 'undefined') document.cookie = cookie;
    },
    secure: () => hasWindow && window.location.protocol === 'https:',
    now: () => new Date(),
    events: () => (hasWindow ? window : null),
  };
}

export function createTermsAcceptanceStore(version: string, env: TermsAcceptanceEnv = browserTermsEnv()): TermsAcceptanceStore {
  // Accepted in this page session (always set on accept, so the gate opens even when nothing could be stored).
  let sessionVersion: string | null = null;
  const listeners = new Set<() => void>();

  const storedRecord = () => parseTermsAcceptance(guarded(() => env.storage()?.getItem(TERMS_ACCEPTANCE_KEY) ?? null, null));
  const cookieRecord = () => {
    const raw = guarded(() => cookieValue(env.readCookies(), TERMS_COOKIE_NAME), null);
    if (raw === null) return null;
    return parseTermsAcceptance(guarded(() => decodeURIComponent(raw), null));
  };

  const notify = () => [...listeners].forEach((listener) => listener());
  const onStorage = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key === null || key === undefined || key === TERMS_ACCEPTANCE_KEY) notify();
  };

  function saveToStorage(record: TermsAcceptanceRecord): boolean {
    return guarded(() => {
      const storage = env.storage();
      if (storage === null) return false;
      storage.setItem(TERMS_ACCEPTANCE_KEY, JSON.stringify(record));
      return true;
    }, false);
  }

  function saveToCookie(record: TermsAcceptanceRecord): boolean {
    return guarded(() => {
      env.writeCookie(termsCookie(record, env.secure()));
      // Browsers that refuse cookies drop the write silently: only a read-back proves it was kept.
      return cookieRecord()?.version === record.version;
    }, false);
  }

  return {
    version,
    isAccepted: () => sessionVersion === version || storedRecord()?.version === version || cookieRecord()?.version === version,
    accept: () => {
      const record: TermsAcceptanceRecord = Object.freeze({ version, acceptedAt: guarded(() => env.now().toISOString(), new Date(0).toISOString()) });
      sessionVersion = version;
      const result: AcceptResult = saveToStorage(record) ? 'saved' : saveToCookie(record) ? 'saved_cookie' : 'session_only';
      notify();
      return result;
    },
    subscribe: (listener) => {
      if (listeners.size === 0) guarded(() => env.events()?.addEventListener('storage', onStorage), undefined);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) guarded(() => env.events()?.removeEventListener('storage', onStorage), undefined);
      };
    },
  };
}

/** The app's store: the current TERMS_VERSION in this browser. */
export const termsAcceptance: TermsAcceptanceStore = createTermsAcceptanceStore(TERMS_VERSION);

/** Whether `store`'s version is accepted; follows accepts in this tab and in other tabs. */
export function useTermsAccepted(store: TermsAcceptanceStore = termsAcceptance): boolean {
  return useSyncExternalStore(store.subscribe, store.isAccepted, store.isAccepted);
}
