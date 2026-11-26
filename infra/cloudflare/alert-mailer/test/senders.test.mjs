import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './helpers.mjs';
import { boundedRequest } from '../../../server/monitor/collect.mjs';
import { configure } from '../../../server/monitor/config.mjs';
import { dispatch } from '../../../server/monitor/delivery.mjs';
import { main as monitor } from '../../../server/monitor/main.mjs';
import { mailer } from '../../../server/monitor/notify.mjs';
import { main as poster } from '../../../../scripts/box/drand-rescue/main.mjs';
import { fixture } from '../../../../scripts/box/drand-rescue/test/model.mjs';
import example from '../../../server/monitor/config.example.json' with { type: 'json' };

// SH-V21-RC8-INT rc8.1, the cross-ticket contract (SH-RC8-ALERT-MAILER request 3): each sender's own code builds
// its real request (URL, headers, JSON body) and it reaches the Worker's handler, with a fake EmailMessage and send
// binding, which must answer 202 and hand one message to the binding. The base URL is an origin, as a workers.dev
// deployment gives it: the Worker serves POST /alert only, and both senders append /alert to the base URL's path.
const base = 'https://mailer.invalid';
const subjectOf = raw => /^Subject: (.*)$/m.exec(raw)?.[1];

test('the monitor\'s and the second poster\'s senders get 202 from the Worker\'s handler', async () => {
  // The monitor: notify.mjs mailer() over the production boundedRequest, with only the fetcher faked.
  const monitorToken = 'monitor-contract-token';
  const worker = harness({ TOKEN_MONITOR: monitorToken, TOKEN_RESCUE: 'rescue-contract-token' });
  const statuses = [], logs = [];
  const fetcher = (url, init) => worker.fetch(new Request(url, init)).then(response => {
    statuses.push(response.status);
    return response;
  });
  const send = mailer({ SH_MONITOR_MAILER_URL: base, SH_MONITOR_MAILER_TOKEN: monitorToken },
    (url, init) => boundedRequest(url, init, fetcher), line => logs.push(line));
  const out = [];
  const ports = { senders: { mailer: send }, write: s => out.push(s), error: s => out.push(s) };
  // main.mjs's own two fixed texts: the delivery test and the internal failure.
  assert.equal(await monitor(['--notify-test', '--config', 'example'], {}, { ...ports, readConfig: async () => example }), 0);
  assert.equal(await monitor(['--run', '--config', 'broken'], {}, { ...ports, readConfig: async () => { throw new Error(); } }), 2);
  // delivery.mjs's rendered alert, at the renderer's 3,800-character cap.
  const report = Array.from({ length: 60 }, (_, i) => ({ id: 'drand-words', status: 'alert', level: i ? 'critical' : 'emergency',
    reason: i ? '24h' : 'past-deadline', subject: `0x${String(i).padStart(40, '0')}:0`,
    detail: `box 0 tickets key ${i} round ${32654000 + i}, not posted at the finalized block; 0 d ${i % 24} h 0 min left` }));
  const failed = await dispatch(report, { version: 1, channels: {} }, { mailer: send }, 1792586096n, configure(example, {}), async () => {});
  assert.deepEqual(failed, []);
  assert.deepEqual(statuses, [202, 202, 202]);
  assert.deepEqual(logs, []);
  assert.deepEqual(worker.sent.map(m => subjectOf(m.raw)), [
    '[Square Hole] INFO Square Hole monitor: DELIVERY TEST',
    '[Square Hole] ALERT Square Hole monitor: INTERNAL FAILURE',
    '[Square Hole] EMERGENCY Square Hole monitor: EMERGENCY',
  ]);

  // The second poster: main.mjs's notify() and mailer.mjs deliver() in whole runs on the offline chain model.
  const runs = [];
  for (const kind of ['result', 'heartbeat', 'failure']) {
    const m = fixture();
    m.env.MAIL_URL = base;
    const rescue = harness({ TOKEN_MONITOR: monitorToken, TOKEN_RESCUE: m.env.MAIL_TOKEN });
    const replies = [];
    m.mailer = (url, init) => rescue.fetch(new Request(url, init)).then(response => {
      replies.push(response.status);
      return response;
    });
    if (kind === 'failure') m.code = '0x';
    const argv = [...m.args, '--mailer-env', 'MAIL_URL,MAIL_TOKEN'];
    if (kind === 'heartbeat') argv.push('--heartbeat-hour', String((m.now / 3600n) % 24n));
    const exit = await poster(argv, m.io);
    runs.push({ kind, exit, mails: m.mail.length, replies, sent: rescue.sent.map(s => subjectOf(s.raw)), err: m.err });
    m.safe();
  }
  for (const run of runs) assert.doesNotMatch(run.err, /mailer/, run.kind);
  assert.deepEqual(runs.map(({ kind, exit, mails, replies, sent }) => ({ kind, exit, mails, replies, sent })), [
    { kind: 'result', exit: 0, mails: 1, replies: [202], sent: ['[Square Hole] INFO drand-rescue result'] },
    { kind: 'heartbeat', exit: 0, mails: 1, replies: [202], sent: ['[Square Hole] INFO drand-rescue alive'] },
    { kind: 'failure', exit: 1, mails: 1, replies: [202], sent: ['[Square Hole] ALERT drand-rescue result'] },
  ]);
});
