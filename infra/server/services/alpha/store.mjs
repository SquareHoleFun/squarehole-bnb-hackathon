import { DatabaseSync } from 'node:sqlite';

/** One local DB, durable transactions, unique claim constraints, no Postgres or wallet credentials. */
export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS signups (
      xId TEXT PRIMARY KEY, privyDid TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL, picture TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','removed')), signedUpAt TEXT NOT NULL, lastSignIn TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY, xId TEXT NOT NULL REFERENCES signups(xId), decision TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signins (seq INTEGER PRIMARY KEY, xId TEXT NOT NULL REFERENCES signups(xId), at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, xId TEXT NOT NULL REFERENCES signups(xId), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS returning_browsers (hash TEXT PRIMARY KEY, xId TEXT NOT NULL REFERENCES signups(xId), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (sessionHash TEXT PRIMARY KEY REFERENCES sessions(hash), id TEXT NOT NULL UNIQUE, address TEXT NOT NULL, message TEXT NOT NULL, requestedAt TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, xId TEXT NOT NULL UNIQUE REFERENCES signups(xId), address TEXT NOT NULL UNIQUE COLLATE NOCASE,
      payload TEXT NOT NULL, acceptedAt TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0);`);
  // Preserve every payload, timestamp and outbox flag. Only a proven dry-run outcome may release a reservation.
  // Rebuild atomically because SQLite cannot drop the legacy unconditional UNIQUE constraints in place.
  if (!db.prepare('PRAGMA table_info(claims)').all().some(c => c.name === 'reserved')) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE claims_next (id TEXT PRIMARY KEY, xId TEXT NOT NULL REFERENCES signups(xId),
          address TEXT NOT NULL COLLATE NOCASE, payload TEXT NOT NULL, acceptedAt TEXT NOT NULL,
          published INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 1 CHECK(reserved IN (0,1)));
        INSERT INTO claims_next(id,xId,address,payload,acceptedAt,published)
          SELECT id,xId,address,payload,acceptedAt,published FROM claims ORDER BY rowid;
        DROP TABLE claims; ALTER TABLE claims_next RENAME TO claims;
        CREATE UNIQUE INDEX claims_x ON claims(xId) WHERE reserved = 1;
        CREATE UNIQUE INDEX claims_address ON claims(address) WHERE reserved = 1;
        COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, get, all, run, transaction, close: () => db.close() };
}
