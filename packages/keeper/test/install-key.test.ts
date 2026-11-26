import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concat, hexToBytes, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decryptKeystore, installKey, KeyInstallError, passwordOf } from '../scripts/install-key';

// SH-259 review points 1 and 11: the keeper's key file is installed from a keystore through a password FILE, checked
// against the configured signer, written privately and renamed; a failure leaves the target as it was.
const KEY: Hex = `0x${'4f'.repeat(31)}01`;
const ADDRESS = privateKeyToAccount(KEY).address;

function keystore(password: string, kdf: 'scrypt' | 'pbkdf2' = 'scrypt'): string {
  const salt = randomBytes(32), iv = randomBytes(16);
  const derived = kdf === 'scrypt' ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 }) : pbkdf2Sync(password, salt, 1000, 32, 'sha256');
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(KEY)), cipher.final()]);
  const mac = keccak256(concat([derived.subarray(16, 32), ciphertext]));
  const kdfparams = kdf === 'scrypt' ? { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString('hex') }
    : { dklen: 32, c: 1000, prf: 'hmac-sha256', salt: salt.toString('hex') };
  return JSON.stringify({ version: 3, id: 'test', crypto: { cipher: 'aes-128-ctr', cipherparams: { iv: iv.toString('hex') },
    ciphertext: ciphertext.toString('hex'), kdf, kdfparams, mac: mac.slice(2) } });
}

function folder() {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/install-key-'));
  writeFileSync(join(dir, 'keystore.json'), keystore('correct horse'));
  writeFileSync(join(dir, 'password'), 'correct horse\n');
  return dir;
}

describe('SH-259: installing the keeper key from a keystore', () => {
  it('decrypts scrypt and pbkdf2 keystores and refuses a wrong password', () => {
    expect(decryptKeystore(keystore('pw'), 'pw')).toBe(KEY);
    expect(decryptKeystore(keystore('pw', 'pbkdf2'), 'pw')).toBe(KEY);
    expect(() => decryptKeystore(keystore('pw'), 'other')).toThrow(/wrong password/);
    expect(() => decryptKeystore('{"version":3}', 'pw')).toThrow(KeyInstallError);
    expect(() => decryptKeystore('not json', 'pw')).toThrow(/not JSON/);
    expect(passwordOf('secret\r\n')).toBe('secret');
    expect(passwordOf('secret\n\n')).toBe('secret\n');
  });

  it('writes one owner-only line for the configured signer, by rename, and leaves no staging file', () => {
    const dir = folder();
    const out = join(dir, 'gas.key');
    expect(installKey({ keystore: join(dir, 'keystore.json'), passwordFile: join(dir, 'password'), address: ADDRESS.toLowerCase(), out })).toBe(ADDRESS);
    expect(readFileSync(out, 'utf8')).toBe(`${KEY}\n`);
    expect(statSync(out).mode & 0o777).toBe(0o400);
    expect(statSync(out).size).toBe(67);
    expect(readdirSync(dir).sort()).toEqual(['gas.key', 'keystore.json', 'password']);
  });

  it('leaves the target untouched, and no staging file, on a wrong password, a wrong signer or a broken keystore', () => {
    for (const bad of ['password', 'signer', 'keystore', 'address'] as const) {
      const dir = folder();
      const out = join(dir, 'gas.key');
      writeFileSync(out, 'the previous key file\n');
      if (bad === 'password') writeFileSync(join(dir, 'password'), 'wrong horse\n');
      if (bad === 'keystore') writeFileSync(join(dir, 'keystore.json'), '{"version":3,"crypto":{}}');
      const address = bad === 'signer' ? '0x000000000000000000000000000000000000dEaD' : bad === 'address' ? 'not-an-address' : ADDRESS;
      expect(() => installKey({ keystore: join(dir, 'keystore.json'), passwordFile: join(dir, 'password'), address, out }), bad).toThrow(KeyInstallError);
      expect(readFileSync(out, 'utf8'), bad).toBe('the previous key file\n');
      expect(readdirSync(dir).filter((name) => name.endsWith('.new')), bad).toEqual([]);
    }
  });

  it('never creates a key file when the first install fails', () => {
    const dir = folder();
    writeFileSync(join(dir, 'password'), 'wrong horse\n');
    const out = join(dir, 'gas.key');
    expect(() => installKey({ keystore: join(dir, 'keystore.json'), passwordFile: join(dir, 'password'), address: ADDRESS, out })).toThrow(/wrong password/);
    expect(existsSync(out)).toBe(false);
  });

});
