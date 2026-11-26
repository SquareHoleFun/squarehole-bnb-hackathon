// Offline curl stand-in: real child descriptors and filesystem opens, no network.
import { openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
let config = '';
for await (const chunk of process.stdin) config += chunk;
try {
  const quoted = /^upload-file = (".*")$/m.exec(config)?.[1];
  const path = JSON.parse(quoted);
  const fd = openSync(path, 'r'); // Linux rejects the old socket-backed /dev/fd/3 here.
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || dirname(path) !== process.argv[2]) process.exit(41);
    const message = readFileSync(fd, 'utf8');
    const body = Buffer.from(message.split('\r\n\r\n')[1], 'base64').toString();
    if (!message.includes('Subject: Square Hole monitor') || body !== 'ALERT\ndisk: alert') process.exit(42);
    if (message.includes('FAKE_TEST_PASSWORD') || !config.includes('ssl-reqd')) process.exit(43);
  } finally { closeSync(fd); }
  process.exitCode = process.argv[3] === 'reject' ? 67 : 0;
} catch { process.exitCode = 44; }
