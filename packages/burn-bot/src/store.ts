import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { requireThat } from './schema';
import type { AppendStore } from './journal';

/** Node's bundled SQLite provides transactional compare-and-append across processes; no new package or listener. */
export class SqliteAppendStore implements AppendStore {
  private db: DatabaseSync;
  constructor(path: string | URL) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS journal (sequence INTEGER PRIMARY KEY, line TEXT NOT NULL);');
    // The normal storage interface has no update/delete path; DB-level triggers also refuse accidental rewrites.
    this.db.exec("CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'append only'); END;");
    this.db.exec("CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'append only'); END;");
  }
  read(): string { return this.db.prepare('SELECT line FROM journal ORDER BY sequence').all().map(row => String(row.line)).join(''); }
  append(expected: string, line: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      requireThat(this.read() === expected, 'stale journal writer');
      this.db.prepare('INSERT INTO journal(line) VALUES (?)').run(line);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** An immutable JSONL export: choose a new publication filename each time, publish its signed head separately. */
  publish(path: string | URL) { writeFileSync(path, this.read(), { flag: 'wx', mode: 0o600 }); }
  close() { this.db.close(); }
}
