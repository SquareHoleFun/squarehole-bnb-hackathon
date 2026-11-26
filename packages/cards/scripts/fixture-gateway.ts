/**
 * Local testing only: a stand-in indexer gateway that answers `/v1/boxes/11155111/<box 0>` with the answers recorded
 * during box 0's life on a local twin (apps/web/e2e/fixtures/core-local/life.json), one stage at a time, so the card
 * service can be run against it with the twin's manifest (docs/evidence/SH-cards-droplet.md):
 *
 *   SH_FIXTURE_PORT=5381 pnpm --filter @squarehole/cards fixture-gateway
 *   GET /__stage/<name>     switches the stage (upcoming, window, bonding, closed, graduated, ...); 404 for an unknown one
 *
 * Listens on 127.0.0.1 only. Never part of the service or its image.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIFE = JSON.parse(readFileSync(join(resolve(HERE, '../../../apps/web/e2e/fixtures/core-local'), 'life.json'), 'utf8')) as { token: string; stages: Record<string, { box: unknown }> };
const TOKEN = LIFE.token.toLowerCase();
const port = Number(process.env.SH_FIXTURE_PORT ?? '5381');
let stage = process.env.SH_FIXTURE_STAGE ?? 'bonding';

createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const switchTo = /^\/__stage\/([a-z]+)$/.exec(path)?.[1];
  if (switchTo !== undefined) {
    if (LIFE.stages[switchTo] === undefined) return send(404, { error: `no stage ${switchTo}` });
    stage = switchTo;
    return send(200, { stage });
  }
  if (path === `/v1/boxes/11155111/${TOKEN}`) return send(200, LIFE.stages[stage]?.box);
  if (path === '/healthz') return send(200, { ok: true, stage });
  return send(404, { error: 'no shown box with that token' });
}).listen(port, '127.0.0.1', () => process.stdout.write(`fixture gateway on 127.0.0.1:${port}, box 0 ${TOKEN}, stage ${stage}\n`));
