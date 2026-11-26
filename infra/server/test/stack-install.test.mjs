// SH-248: a stack ship refused before the switch leaves the server as it was and says so; one that stops at the switch
// says what changed and what did not; a whole ship ends as before, its changes in the same order. The installer runs
// whole on stand-ins (stack-install-fixture.mjs); no server, Docker daemon, root or network.
import { describe, expect, it } from 'vitest';
import { spawnSync } from './local-command.mjs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { A, B, builtImages, movedInstaller, stackServer } from './stack-install-fixture.mjs';

const CADDY = 'squarehole-caddy:2.11.6-ratelimit';
const LIMIT = shLimit(120000);
const UNITS = ['squarehole-stack.service', 'squarehole-pg-backup.service', 'squarehole-pg-backup.timer', 'squarehole-origin-firewall.service',
  'squarehole-indexer-heal.service', 'squarehole-indexer-heal.timer'];
const SCRIPTS = { 'squarehole-alpha-backup-flags.sh': 'alpha-backup-flags.sh', 'squarehole-alpha-backup': 'alpha-backup.sh',
  'squarehole-pg-backup': 'pg-backup.sh', 'squarehole-origin-firewall': 'origin-firewall.sh' };

/** Every shared input after a refused run equals its state before; the candidate's own new image tags may remain. */
function expectUnchanged(before, after, candidate) {
  const { images: tagsBefore, ...restBefore } = before;
  const { images: tagsAfter, ...restAfter } = after;
  expect(restAfter).toEqual(restBefore);
  for (const [name, id] of Object.entries(tagsBefore)) expect(tagsAfter[name], name).toBe(id);
  for (const name of Object.keys(tagsAfter).filter(name => !(name in tagsBefore))) expect(name).toMatch(new RegExp(`:${candidate}$`));
}

/** A fixture server's end state, comparable across fixtures; install.log (the kept lines) is left out. */
function endState(f) {
  const state = JSON.parse(JSON.stringify(f.shared()).replaceAll(f.root, '<root>'));
  state.files = Object.fromEntries(Object.entries(state.files).filter(([key]) => !key.startsWith('srv/squarehole/install.log')));
  return state;
}

// [case, what fails, ship options, whether the build had moved the shared Caddy tag, the failure's own line]
// [case, what fails, ship options, whether the build had moved the shared Caddy tag, the failure's own line, how many
// image tags the build newly made for B]
const REFUSALS = [
  ['tools', 'the host tools cannot be installed', { fault: 'tools' }, false, 'apt-get: fixture failure', 0],
  ['unpack', 'the uploaded archive is cut short', { release: { cut: true } }, false, 'tar', 0],
  ['landing', 'a landing file is missing', { release: { landing: false } }, false, 'install.sh: landing file missing: styles.css', 0],
  ['manifest', 'the manifest is not JSON', { release: { manifest: 'broken' } }, false, 'Unfinished JSON term', 0],
  ['compose', 'Compose cannot read the project', { fault: 'config' }, false, 'fixture: compose cannot read the project', 0],
  ['listing', 'Docker cannot list the image tags before the build', { fault: 'listing' }, false, 'fixture listing failure', 0],
  ['build', 'the image build fails after it moved the Caddy tag', { fault: 'build' }, true, `fixture: the build failed after ${CADDY}`, 0],
  ['sighup', 'the installer gets SIGHUP during the build', { fault: 'signal-HUP' }, true, '', 7],
  ['sigint', 'the installer gets SIGINT during the build', { fault: 'signal-INT' }, true, '', 7],
  ['sigterm', 'the installer gets SIGTERM during the build', { fault: 'signal-TERM' }, true, '', 7],
  ['caddy', 'Caddy refuses the Caddyfile', { fault: 'validate' }, true, "install.sh: the release's Caddyfile was refused", 7],
  ['allowlist', 'the origin allowlist is malformed', { release: { allowlist: 'broken' } }, true,
    'origin-firewall: not a range in trusted_proxies: private_ranges; nothing changed', 7],
  ['preflight', 'the enabled alpha sender has no desk key', { env: { FAKE_SENDER_ENABLED: '1' } }, true,
    "install.sh: enabled alpha-sender requires the founder's root:root 0600 desk.key", 7],
  ['desk-key', "the enabled alpha sender's desk key has another owner or mode than root:root 0600",
    { env: { FAKE_SENDER_ENABLED: '1' }, deskKey: true }, true, "install.sh: enabled alpha-sender requires the founder's root:root 0600 desk.key", 7],
  ['preflight-compose', 'Compose cannot read the project for the sender preflight', { fault: 'preflight-config' }, true,
    'fixture: compose cannot read the project for the preflight', 7],
  ['preflight-json', "the sender preflight cannot read Compose's answer", { fault: 'preflight-json' }, true, 'parse error', 7],
];
const SIGNALS = { sighup: 129, sigint: 130, sigterm: 143 };

describe('a stack ship refused before the switch changes nothing the running release reads (SH-248 P1, P2)', () => {
  it.each(REFUSALS)('%s: %s', (name, _what, options, moved, cause, tags) => {
    const f = stackServer();
    expect(f.ship(A).status, 'release A installs').toBe(0);
    const { deskKey, ...shipOptions } = options;
    // A key file the preflight reads with stat: 0640 is refused for any owner, root included.
    if (deskKey) writeFileSync(f.at('etc/squarehole/alpha-sender/desk.key'), 'fixture-key-not-a-secret\n', { mode: 0o640 });
    // A's folders now differ from what the candidate's installer applies: a refusal must not apply it.
    f.drift();
    const before = f.shared();
    const r = f.ship(B, shipOptions);
    expect(r.status, r.out).not.toBe(0);
    if (name in SIGNALS) expect(r.status).toBe(SIGNALS[name]);
    // B's manifest, units, scripts, journald limits, allowlist and Caddy image all differ from A's: none of them landed.
    expect(r.release.manifest).not.toEqual(readFileSync(f.at('srv/squarehole/manifests/11155111.json')));
    expectUnchanged(before, f.shared({ candidate: B }), B);
    // Not even for a moment: the run only checked, unpacked into its own folder and put a moved tag back.
    for (const line of r.effects) {
      expect(line.startsWith('check: ') || line.startsWith(`mv srv/squarehole/releases/${B}`) || line === `docker tag ${CADDY}`
        || (name === 'tools' && line.startsWith('apt-get ')), line).toBe(true);
    }
    expect(r.effects.includes(`docker tag ${CADDY}`)).toBe(moved);
    // The message says what happened.
    expect(r.out).toContain(cause);
    const inputs = `its manifest, folders, units, scripts, allowlist, current -> ${A}, stack and image tags`;
    expect(r.out).toContain(moved ? `install.sh: refused before the switch; everything the running release reads is as before (${inputs})\n`
      : `install.sh: refused before the switch; nothing the running release reads changed (${inputs} are as before)\n`);
    expect(r.out.includes(`install.sh: put back to the image it named before the build: image tag ${CADDY}\n`)).toBe(moved);
    const kept = [...(['tools', 'unpack'].includes(name) ? [] : ['the unpacked release']), ...(tags ? [`${tags} new image tags from this build`] : [])];
    if (kept.length) expect(r.out).toContain(`install.sh: kept for a retry: ${kept.join('; ')}\n`);
    else expect(r.out).not.toContain('kept for a retry');
    expect(r.out.includes(`install.sh: kept for diagnosis: the interrupted unpack ${f.at(`srv/squarehole/releases/${B}`)}.new (the next run moves it aside)\n`)).toBe(name === 'unpack');
    expect(r.out).not.toMatch(/made because|stopped at the switch|manifest installed|current -> b{40}|NOT put back|not known/);
  }, LIMIT);

  it('a refused ship of the running commit again puts back every tag its rebuild moved', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const before = f.shared();
    const r = f.ship(A, { fault: 'validate', env: { FAKE_BUILD_SALT: 'a rebuild that differs' } });
    expect(r.status).not.toBe(0);
    expect(f.shared()).toEqual(before);
    const commitTags = builtImages().filter(image => image.includes('{c}')).map(image => image.replace('{c}', A)).sort();
    expect(r.out).toContain(`install.sh: put back to the image it named before the build: ${commitTags.map(tag => `image tag ${tag}`).join('; ')}\n`);
    // The images this rebuild made are no longer tagged: only the unpacked release is kept.
    expect(r.out).toContain('install.sh: kept for a retry: the unpacked release\n');
  }, LIMIT);

  it('a put-back Docker refuses is reported as NOT put back, with the command that puts it back by hand', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const caddyA = f.images()[CADDY];
    const before = f.shared();
    const r = f.ship(B, { fault: 'validate', env: { FAKE_TAG_FAULT: '1' } });
    expect(r.status).not.toBe(0);
    expect(f.images()[CADDY]).not.toBe(caddyA);
    const byHand = ['tag', caddyA, CADDY];
    expect(r.out).toContain(`install.sh: refused before the switch; NOT put back: image tag ${CADDY} (by hand: docker ${byHand.join(' ')})\n`
      + 'install.sh: everything else the running release reads is as before\n');
    expect(r.out).not.toMatch(/put back to|nothing the running release reads changed|is as before \(/);
    // The command the line names puts it back.
    expect(f.docker(...byHand).status).toBe(0);
    expectUnchanged(before, f.shared({ candidate: B }), B);
  }, LIMIT);

  it('an inspect that fails once during the put-back still ends with every tag put back', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const before = f.shared();
    const r = f.ship(A, { fault: 'validate', env: { FAKE_BUILD_SALT: 'a rebuild that differs', FAKE_INSPECT_FAIL_ONCE: `squarehole-cards:${A}` } });
    expect(r.status, r.out).toBe(1);
    expect(existsSync(join(f.state, 'inspect-failed'))).toBe(true);
    expect(r.out).toMatch(new RegExp(`install.sh: put back to the image it named before the build: .*image tag squarehole-cards:${A}`));
    expect(r.out).not.toContain('NOT put back');
    expect(f.shared()).toEqual(before);
  }, LIMIT);

  it('Docker gone during the build: the put-back is tried for every tag it cannot read, and each refused one is named', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const caddyA = f.images()[CADDY];
    const before = f.shared();
    const r = f.ship(B, { fault: 'daemon' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`install.sh: refused before the switch; NOT put back: image tag ${CADDY} (by hand: docker tag ${caddyA} ${CADDY})\n`
      + 'install.sh: everything else the running release reads is as before\n');
    expect(r.out).not.toMatch(/not known|new image tags|put back to/);
    expectUnchanged(before, f.shared({ candidate: B }), B);
  }, LIMIT);

  it('a first install whose Postgres password cannot be written is refused before the switch', () => {
    const f = stackServer();
    // A folder where the new password file goes: the write fails for any user, root included.
    mkdirSync(f.at('etc/squarehole/db.env.new'), { recursive: true });
    const r = f.ship(B);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('install.sh: refused before the switch; apart from what was made because it was missing (below), nothing the running '
      + 'release reads changed (its manifest, folders, units, scripts, allowlist, current, stack and image tags are as before)\n');
    expect(r.out).toContain(`install.sh: made because it was missing: ${['srv/squarehole', 'srv/squarehole/releases', 'srv/squarehole/app'].map(path => f.at(path)).join('; ')}\n`);
    expect(existsSync(f.at('etc/squarehole/db.env'))).toBe(false);
    expect(r.effects).toEqual(['install -d srv/squarehole', 'install -d srv/squarehole/releases', 'install -d srv/squarehole/app']);
  }, LIMIT);

  it('a refused first install names what it made because it was missing, and installs nothing else', () => {
    const f = stackServer();
    const before = Object.keys(f.shared().files);
    const r = f.ship(B, { fault: 'validate' });
    expect(r.status).not.toBe(0);
    const made = ['srv/squarehole', 'srv/squarehole/releases', 'srv/squarehole/app', 'etc/squarehole', 'etc/squarehole/db.env'];
    expect(r.out).toContain('install.sh: refused before the switch; apart from what was made because it was missing (below), nothing the running '
      + 'release reads changed (its manifest, folders, units, scripts, allowlist, current, stack and image tags are as before)\n');
    expect(r.out).toContain(`install.sh: made because it was missing: ${made.map(path => f.at(path)).join('; ')}\n`);
    expect(Object.keys(f.shared({ candidate: B }).files).sort()).toEqual([...before, 'srv', ...made].sort());
    expect(f.readState('systemd') + f.readState('iptables-SH-ORIGIN') + f.readState('stack')).toBe('');
  }, LIMIT);
});

describe('a cut session or a second signal does not stop the putting back (SH-248 P2)', () => {
  it('the reader of the installer\'s output leaves after its first line (SIGPIPE): the moved Caddy tag is put back', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const before = f.shared();
    const r = f.ship(B, { reader: 'leaves' });
    expect(r.stdout).toBe(`install.sh: unpacked ${B}\n`);
    expect(r.status).not.toBe(0);
    expect(r.effects).toContain(`docker tag ${CADDY}`);
    expectUnchanged(before, f.shared({ candidate: B }), B);
  }, LIMIT);

  it('a session cut just before the switch: the switch runs to its end as an uncut ship does, and its lines are kept', () => {
    const cut = stackServer(), whole = stackServer();
    for (const f of [cut, whole]) expect(f.ship(A).status).toBe(0);
    const r = cut.ship(B, { reader: 'leaves-before-switch' });
    expect(r.stdout.trim().split('\n').at(-1)).toMatch(/origin-firewall: the list in .* \(checked, not applied\)$/);
    expect(r.status, r.out).toBe(0);
    expect(whole.ship(B).status).toBe(0);
    // The same end state as the uncut ship; the kept file is compared on its own (its lines name each fixture's folder).
    expect(endState(cut)).toEqual(endState(whole));
    const kept = (f) => readFileSync(f.at('srv/squarehole/install.log'), 'utf8').replaceAll(f.root, '<root>');
    expect(kept(cut)).toBe(kept(whole));
    expect(kept(cut).split('\n')[0]).toBe(`install.sh: the switch to ${B} begins; its lines are kept in <root>/srv/squarehole/install.log`);
    expect(kept(cut)).toContain(`install.sh: current -> ${B}; stack up\n`);
    expect(kept(cut)).toMatch(/install.sh: healthz: .*\n$/);
    expect(lstatSync(cut.at('srv/squarehole/install.log')).mode & 0o777).toBe(0o600);
  }, LIMIT);

  it('a cut session and a kept file that cannot be written: the switch still runs to its end as an uncut ship does', () => {
    const cut = stackServer(), whole = stackServer();
    for (const f of [cut, whole]) expect(f.ship(A).status).toBe(0);
    // A folder where the kept file goes: tee cannot write it for any user, root included.
    rmSync(cut.at('srv/squarehole/install.log'));
    mkdirSync(cut.at('srv/squarehole/install.log'));
    const r = cut.ship(B, { reader: 'leaves-before-switch' });
    expect(r.stdout.trim().split('\n').at(-1)).toMatch(/origin-firewall: the list in .* \(checked, not applied\)$/);
    expect(r.status, r.out).toBe(0);
    expect(whole.ship(B).status).toBe(0);
    expect(endState(cut)).toEqual(endState(whole));
  }, LIMIT);

  it('a hangup during the switch (a manual run from a terminal that closes) does not stop it: it ends as an uncut ship does', () => {
    const hup = stackServer(), whole = stackServer();
    for (const f of [hup, whole]) expect(f.ship(A).status).toBe(0);
    const r = hup.ship(B, { env: { FAKE_HUP_AT: 'daemon-reload' } });
    expect(r.status, r.out).toBe(0);
    expect(r.effects).toContain('systemctl daemon-reload');
    expect(whole.ship(B).status).toBe(0);
    expect(endState(hup)).toEqual(endState(whole));
  }, LIMIT);

  it('a second signal during the put-back does not stop it: all seven moved tags of a re-ship come back', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const before = f.shared();
    const r = f.ship(A, { fault: 'validate', env: { FAKE_BUILD_SALT: 'a rebuild that differs', FAKE_SIGNAL_ON_TAG: 'TERM' } });
    expect(r.status, r.out).toBe(1);
    expect(r.effects.filter(line => line.startsWith('docker tag '))).toHaveLength(7);
    expect(f.shared()).toEqual(before);
  }, LIMIT);
});

describe('a stack ship that stops at the switch says what changed and what did not (SH-248 P3)', () => {
  it('a refused allowlist apply: the inputs before it are B\'s, current and the stack are still A\'s', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const r = f.ship(B, { fault: 'firewall' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('install.sh: stopped at the switch, during: the origin allowlist (it may be partly applied)\n');
    expect(r.out).toContain(`install.sh: changed: image tag ${CADDY}; folder modes, owners and ACLs; the Sepolia manifest (status deployed -> deployed); units, backup and firewall scripts, journald limits\n`);
    expect(r.out).toContain('install.sh: not changed: current; the stack and its timers\n');
    expect(r.out).toContain(`install.sh: current points to ${A}; the stack was not (re)started: what runs is what ran before (${A}), with the changed inputs above\n`);
    expect(r.out).toContain(`install.sh: next: fix the cause and ship ${B} again, or go back with infra/server/ship.sh ${A}\n`);
    expect(r.out).not.toMatch(/nothing the running release reads changed|is as before/);
    // The state is what the lines say.
    expect(readFileSync(f.at('srv/squarehole/manifests/11155111.json'))).toEqual(r.release.manifest);
    for (const unit of UNITS) expect(readFileSync(f.at(`etc/systemd/system/${unit}`)), unit).toEqual(r.release.file(`infra/server/systemd/${unit}`));
    expect(f.current()).toBe(f.at(`srv/squarehole/releases/${A}`));
    expect(f.readState('stack')).toMatch(new RegExp(`^release ${A} `));
  }, LIMIT);

  it('a refused stack reload: current is B\'s, and the line says the stack may not have restarted', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const r = f.ship(B, { fault: 'reload' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('install.sh: stopped at the switch, during: the stack and its timers (it may be partly applied)\n');
    expect(r.out).toContain(`install.sh: changed: image tag ${CADDY}; folder modes, owners and ACLs; the Sepolia manifest (status deployed -> deployed); units, backup and firewall scripts, journald limits; the origin allowlist; current -> ${B}\n`);
    expect(r.out).toContain('install.sh: not changed: nothing\n');
    expect(r.out).toContain(`install.sh: current points to ${B}; the stack may not have (re)started: cd ${f.at('srv/squarehole')}/current/infra/server && sudo docker compose ps\n`);
    expect(f.current()).toBe(f.at(`srv/squarehole/releases/${B}`));
    expect(f.readState('stack')).toMatch(new RegExp(`^release ${A} `));
  }, LIMIT);

  it('an unchanged manifest is listed as not changed, not as changed', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    // A placeholder never replaces a deployed manifest: the switch keeps A's.
    const r = f.ship(B, { release: { manifest: 'placeholder' }, fault: 'firewall' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`install.sh: changed: image tag ${CADDY}; folder modes, owners and ACLs; units, backup and firewall scripts, journald limits\n`);
    expect(r.out).toContain('install.sh: not changed: the Sepolia manifest (kept the deployed one); current; the stack and its timers\n');
  }, LIMIT);

  it('a stop at the switch of the running commit again offers no way back to itself', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const r = f.ship(A, { fault: 'firewall' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`install.sh: next: fix the cause and ship ${A} again\n`);
    expect(r.out).not.toContain('go back');
  }, LIMIT);

  it('a failed check after the stack started names the installed release and the way back', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const r = f.ship(B, { fault: 'smoke' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('smoke-services: fixture worker unhealthy');
    expect(r.out).toContain(`install.sh: release ${B} is installed and current, and the stack runs it; this check failed after the switch and nothing was rolled back\n`);
    expect(r.out).toContain(`install.sh: to go back: infra/server/ship.sh ${A}\n`);
    expect(f.readState('stack')).toMatch(new RegExp(`^release ${B} `));
  }, LIMIT);
});

describe('a whole stack ship ends as before (SH-248 P4)', () => {
  it('B over A: B\'s inputs, A\'s drift undone, every check before the first change, the changes in their order', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const caddyA = f.images()[CADDY];
    f.drift();
    const r = f.ship(B);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('install.sh: healthz: ');
    expect(readFileSync(f.at('srv/squarehole/manifests/11155111.json'))).toEqual(r.release.manifest);
    for (const unit of UNITS) expect(readFileSync(f.at(`etc/systemd/system/${unit}`)), unit).toEqual(r.release.file(`infra/server/systemd/${unit}`));
    for (const [installed, source] of Object.entries(SCRIPTS)) expect(readFileSync(f.at(`usr/local/sbin/${installed}`)), installed).toEqual(r.release.file(`infra/server/${source}`));
    expect(readFileSync(f.at('etc/systemd/journald.conf.d/50-squarehole.conf'))).toEqual(r.release.file('infra/server/journald.conf'));
    expect(f.current()).toBe(f.at(`srv/squarehole/releases/${B}`));
    const shared = f.shared();
    expect(f.readState('stack')).toBe(`release ${B} caddy ${shared.images[CADDY]}\n`);
    expect(shared.images[CADDY]).not.toBe(caddyA);
    const ranges = readFileSync('infra/server/Caddyfile', 'utf8').match(/^\s*trusted_proxies static (.*)$/m)[1].split(' ').filter(word => word.includes('.'));
    expect(shared.firewall['SH-ORIGIN']).toBe(['*filter', ':SH-ORIGIN - [0:0]', '-F SH-ORIGIN', '-A SH-ORIGIN -i docker0 -j RETURN', '-A SH-ORIGIN -i br-+ -j RETURN',
      ...ranges.map(range => `-A SH-ORIGIN -s ${range} -j RETURN`), '-A SH-ORIGIN -j DROP', 'COMMIT', ''].join('\n'));
    expect(shared.files['srv/squarehole/alpha/queue']).toBe('folder 2750');
    expect(shared.owners['srv/squarehole/withheld']).toBe('root:root');
    expect(shared.acl).toContain('srv/squarehole/alpha/queue u:2101:rwx');
    expect(shared.systemd.units).toEqual(['active squarehole-indexer-heal.timer', 'active squarehole-origin-firewall.service', 'active squarehole-pg-backup.timer',
      'active squarehole-stack.service', 'enabled squarehole-indexer-heal.timer', 'enabled squarehole-origin-firewall.service', 'enabled squarehole-pg-backup.timer',
      'enabled squarehole-stack.service']);
    // Order: every check, then the changes as they came when the checks followed them.
    const staging = (line) => line.startsWith('check: ') || line.startsWith(`mv srv/squarehole/releases/${B}`);
    const firstChange = r.effects.findIndex(line => !staging(line));
    expect(r.effects.slice(0, firstChange)).toEqual([`mv srv/squarehole/releases/${B}`, `mv srv/squarehole/releases/${B}/infra/server/.env`,
      'check: compose config', 'check: compose build', 'check: caddy validate', 'check: compose config']);
    expect(r.effects.slice(firstChange).filter(staging)).toEqual([]);
    const order = ['install -d etc/squarehole var/backups/squarehole', 'setfacl -m u:2101:rwx srv/squarehole/alpha/queue', 'chmod 0600 etc/squarehole/db.env',
      'install srv/squarehole/manifests/.11155111.json.new', 'mv srv/squarehole/manifests/11155111.json', 'install usr/local/sbin/squarehole-alpha-backup-flags.sh',
      `install ${UNITS.slice(0, 4).map(unit => `etc/systemd/system/${unit}`).join(' ')}`, 'systemctl restart systemd-journald', 'systemctl daemon-reload',
      'iptables-restore', 'ln srv/squarehole/.current.new', 'mv srv/squarehole/current', 'systemctl start squarehole-origin-firewall.service',
      'systemctl reload squarehole-stack.service', 'systemctl start squarehole-pg-backup.timer', 'systemctl enable --now squarehole-indexer-heal.timer'];
    const at = order.map(line => r.effects.indexOf(line));
    expect(at.every(index => index >= firstChange), JSON.stringify(r.effects, null, 1)).toBe(true);
    expect(at).toEqual([...at].sort((x, y) => x - y));
  }, LIMIT);
});

describe('the manifest is compared where it is applied (SH-248 P5)', () => {
  it('one changed on the server during the build is replaced at the switch, and the line says so', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const edited = join(f.dir, 'edited.json');
    writeFileSync(edited, '{"status": "deployed", "edited": "during the build"}\n');
    const r = f.ship(A, { env: { FAKE_MANIFEST_EDIT: edited } });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('install.sh: manifest installed (status deployed -> deployed)\n');
    expect(readFileSync(f.at('srv/squarehole/manifests/11155111.json'))).toEqual(r.release.manifest);
  }, LIMIT);
});

describe('the running release\'s own .env is never half written (SH-248 P1)', () => {
  it('a ship of the running commit again replaces it by a rename with the same bytes', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    const env = f.at(`srv/squarehole/releases/${A}/infra/server/.env`);
    const r = f.ship(A);
    expect(r.status, r.out).toBe(0);
    expect(r.effects).toContain(`mv srv/squarehole/releases/${A}/infra/server/.env`);
    expect(readFileSync(env, 'utf8')).toBe(`SH_RELEASE=${A}\n`);
    expect(existsSync(`${env}.new`)).toBe(false);
  }, LIMIT);
});

describe('going back is a ship of the older commit (SH-248 P4)', () => {
  it('A, then B, then A again: every shared input is A\'s again; only B\'s own folder and image tags remain', () => {
    const f = stackServer();
    expect(f.ship(A).status).toBe(0);
    // install.log is the installer's record of its last switch, which no release reads: left out here.
    const read = (options) => { const s = f.shared(options); delete s.files['srv/squarehole/install.log']; return s; };
    const installedA = read();
    expect(f.ship(B).status).toBe(0);
    const back = f.ship(A);
    expect(back.status, back.out).toBe(0);
    expect(back.out).not.toContain(`unpacked ${A}`);
    expectUnchanged(installedA, read({ candidate: B }), B);
  }, LIMIT);
});

describe('the fixture and the allowlist check', () => {
  it('moves every host path of the installer and refuses one it does not know', () => {
    const installer = readFileSync('infra/server/install.sh', 'utf8');
    expect(() => movedInstaller(installer, '/fixture-root')).not.toThrow();
    expect(() => movedInstaller(`${installer}\ncp x /opt/elsewhere\n`, '/fixture-root')).toThrow(/\/opt\/elsewhere/);
    expect(builtImages()).toEqual(expect.arrayContaining([CADDY, 'squarehole-indexer:{c}', 'squarehole-keeper:{c}']));
    expect(builtImages()[0]).toBe(CADDY);
  });

  it('origin-firewall.sh --check reads the list without root or iptables and applies nothing', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const dir = mkdtempSync(resolve('.cache/tmp/origin-check-'));
    for (const name of ['iptables', 'iptables-restore']) writeFileSync(join(dir, name), '#!/bin/sh\necho "UNEXPECTED $0" >&2\nexit 99\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const ok = spawnSync('bash', ['infra/server/origin-firewall.sh', '--check', 'infra/server/Caddyfile'], { encoding: 'utf8', env });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('origin-firewall: the list in infra/server/Caddyfile holds 15 Cloudflare IPv4 ranges (checked, not applied)\n');
    const broken = join(dir, 'Caddyfile');
    writeFileSync(broken, readFileSync('infra/server/Caddyfile', 'utf8').replace(/^(\s*trusted_proxies\s+static)\s.*$/m, '$1 0.0.0.0/0'));
    const refused = spawnSync('bash', ['infra/server/origin-firewall.sh', '--check', broken], { encoding: 'utf8', env });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe('origin-firewall: IPv4 range too wide or malformed: 0.0.0.0/0; nothing changed\n');
    expect(ok.stderr + refused.stderr).not.toContain('UNEXPECTED');
  });
});
