// The stack installer (infra/server/install.sh) run whole on this machine (SH-248). Its host paths are moved under a
// scratch root, and every command that would touch the host (Docker, systemd, iptables, apt, owners and ACLs) is a
// stand-in that keeps its state in files there. No server path, Docker daemon, root, network or secret is used.
import { execFileSync, spawnSync } from './local-command.mjs';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const A = 'a'.repeat(40);
export const B = 'b'.repeat(40);

// The installer's absolute host paths, each moved under the scratch root.
const HOST = ['/srv/squarehole', '/etc/squarehole', '/var/backups/squarehole', '/usr/local/sbin/', '/etc/systemd/'];
// Absolute paths that name places inside a container (the Caddy check's mounts and config), never the host.
const CONTAINER = ['/etc/caddy/Caddyfile', '/srv/landing', '/srv/app'];

/** The installer with its host paths under `root`; any other absolute host path stops here, before anything runs. */
export function movedInstaller(text, root) {
  let moved = text;
  for (const path of HOST) moved = moved.replaceAll(path, `${root}${path}`);
  for (const line of moved.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const [path] of line.matchAll(/(?<![\w.$}-])\/(?:etc|srv|usr|var|opt|lib|bin|sbin|run|tmp|home|root|boot|mnt)\/[\w./-]*/g)) {
      if (path.startsWith(root) || CONTAINER.some(place => path === place || path.startsWith(`${place}/`))) continue;
      throw new Error(`install.sh names a host path the fixture does not move: ${path} (in: ${line.trim()})`);
    }
  }
  return moved;
}

/** The images compose.yaml builds, with `{c}` for the commit, fixed tags first (the build stand-in moves them first). */
export function builtImages(compose = readFileSync('infra/server/compose.yaml', 'utf8')) {
  const images = [];
  for (const block of compose.split(/\n(?= {2}[\w-]+:\n)/)) {
    if (!/\n {4}build:\n/.test(block)) continue;
    const image = block.match(/\n {4}image: (.+)\n/)?.[1];
    if (!image) throw new Error('a built service without an image name');
    images.push(image.replace(/\$\{SH_RELEASE:\?[^}]*\}/, '{c}'));
  }
  return [...new Set(images)].sort((x, y) => Number(x.includes('{c}')) - Number(y.includes('{c}')));
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const real = (name) => execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();

// Each stand-in writes what it changes to $FAKE_STATE/effects (`check:` for the installer's checks) and keeps the state
// it stands for in $FAKE_STATE/<name>. Paths in the effects are relative to the scratch root.
const PRELUDE = 'set -euo pipefail\ns=$FAKE_STATE\nrel() { local p; for p in "$@"; do printf \' %s\' "${p#"$FAKE_ROOT"/}"; done; }\n'
  + 'effect() { printf \'%s\\n\' "$*" >>"$s/effects"; }\n'
  + `installer_pid() { # the installer's main process: the topmost parent that runs it (a subshell runs it too)
  local pid=$PPID main=''
  for _ in 1 2 3 4; do
    [[ $(ps -o args= -p "$pid") == *"$FAKE_INSTALLER"* ]] || break
    main=$pid pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  done
  [[ -n $main ]] || { echo "fixture: no installer among the parents" >&2; exit 99; }
  echo "$main"
}
`;
const FAKES = {
  id: 'echo 0',
  dpkg: '[[ ${FAKE_FAULT:-} != tools ]]',
  'apt-get': 'effect "apt-get $*"\n[[ ${FAKE_FAULT:-} != tools ]] || { echo "apt-get: fixture failure" >&2; exit 100; }',
  openssl: '[[ "$*" == "rand -hex 32" ]] || exit 99\necho fixture-password-not-a-secret',
  sleep: ':',
  curl: 'echo \'{"ok":true,"fixture":true}\'',
  // Owners are recorded, never applied (the tests do not run as root); modes are applied by the real install.
  install: `mode='' owner='' group='' dirs=false args=()
while (($#)); do case $1 in -d) dirs=true; shift ;; -m) mode=$2; shift 2 ;; -o) owner=$2; shift 2 ;; -g) group=$2; shift 2 ;; *) args+=("$1"); shift ;; esac; done
if $dirs; then targets=("\${args[@]}"); else
  dest=\${args[\${#args[@]}-1]} targets=()
  dest=\${dest%/}
  if [[ -d $dest ]]; then for src in "\${args[@]:0:\${#args[@]}-1}"; do targets+=("$dest/\${src##*/}"); done; else targets=("$dest"); fi
fi
effect "install$($dirs && echo ' -d')$(rel "\${targets[@]}")"
if [[ -n $owner$group ]]; then for t in "\${targets[@]}"; do printf '%s %s:%s\\n' "\${t#"$FAKE_ROOT"/}" "\${owner:-root}" "\${group:-root}" >>"$s/owners"; done; fi
exec "$REAL_INSTALL" \${mode:+-m "$mode"} $($dirs && echo -d) "\${args[@]}"`,
  chown: 'who=$1; shift\neffect "chown $who$(rel "$@")"\nfor p in "$@"; do printf \'%s %s\\n\' "${p#"$FAKE_ROOT"/}" "$who" >>"$s/owners"; done',
  chmod: 'effect "chmod $1$(rel "${@:2}")"\nexec "$REAL_CHMOD" "$@"',
  setfacl: `effect "setfacl $1 $2$(rel "\${@:3}")"
touch "$s/acl"
if [[ $1 == -b && $2 == -k ]]; then shift 2; for p in "$@"; do grep -v "^\${p#"$FAKE_ROOT"/} " "$s/acl" >"$s/acl.next" || true; cat "$s/acl.next" >"$s/acl"; done
elif [[ $1 == -m ]]; then printf '%s %s\\n' "\${3#"$FAKE_ROOT"/}" "$2" >>"$s/acl"; else exit 99; fi`,
  // GNU mv -T is BSD's mv -h on a Mac (one rename of a link), as in install.test.mjs.
  mv: 'effect "mv$(rel "${@: -1}")"\nif [[ $(uname) == Darwin && ${1:-} == -T ]]; then shift; exec "$REAL_MV" -fh "$@"; fi\nexec "$REAL_MV" "$@"',
  ln: 'effect "ln$(rel "${@: -1}")"\nexec "$REAL_LN" "$@"',
  'iptables-restore': 'effect iptables-restore\n[[ ${FAKE_FAULT:-} != firewall ]] || { echo "iptables-restore: fixture failure" >&2; exit 1; }\ncat >"$s/iptables-SH-ORIGIN"',
  iptables: `[[ $1 == -w ]] && shift
case $1 in
  -n) [[ -f $s/iptables-DOCKER-USER ]] ;;
  -N) effect "iptables -N $2"; : >>"$s/iptables-DOCKER-USER" ;;
  -C) grep -qxF -- "\${*:3}" "$s/iptables-DOCKER-USER" ;;
  -I) effect "iptables -I $2"; printf '%s\\n' "\${*:4}" >>"$s/iptables-DOCKER-USER" ;;
  *) echo "UNEXPECTED iptables $*" >&2; exit 99 ;;
esac`,
  // systemd: enabled and active units, what daemon-reload loaded and journald's limits, and the running stack (the
  // release that `current` named at its last start or reload, and the Caddy image it would run).
  systemctl: `sum() { cat "$@" 2>/dev/null | cksum | cut -d' ' -f1; }
add() { printf '%s\\n' "$@" >>"$s/systemd"; sort -u "$s/systemd" >"$s/systemd.next"; cat "$s/systemd.next" >"$s/systemd"; }
stack() { local now; now=$(readlink "$FAKE_ROOT/srv/squarehole/current"); printf 'release %s caddy %s\\n' "\${now##*/}" "$(awk '$1 == "squarehole-caddy:2.11.6-ratelimit" { print $2 }' "$s/images")" >"$s/stack"; }
if [[ $1 == is-active ]]; then grep -qx "active \${*: -1}" "$s/systemd" 2>/dev/null; exit; fi
effect "systemctl $*"
# FAKE_HUP_AT: the installer gets a hangup when this verb runs (the switch's daemon-reload, say).
if [[ \${FAKE_HUP_AT:-} == "$1" ]]; then kill -HUP "$(installer_pid)"; fi
[[ \${FAKE_FAULT:-} != "$1" ]] || { echo "fixture: systemctl $1 failed" >&2; exit 1; }
case $1 in
  daemon-reload) echo "loaded $(sum "$FAKE_ROOT"/etc/systemd/system/*)" >"$s/systemd-loaded" ;;
  enable) now=false; for u in "\${@:2}"; do case $u in --quiet) ;; --now) now=true ;; *) add "enabled $u"; if $now; then add "active $u"; fi ;; esac; done ;;
  start|reload) for u in "\${@:2}"; do add "active $u"; [[ $u != squarehole-stack.service ]] || stack; done ;;
  restart) if [[ $2 == systemd-journald ]]; then echo "journald $(sum "$FAKE_ROOT"/etc/systemd/journald.conf.d/*)" >"$s/journald"; else exit 99; fi ;;
  *) echo "UNEXPECTED systemctl $*" >&2; exit 99 ;;
esac`,
  // Docker: image tags in $FAKE_STATE/images ("name id"). The build tags FAKE_BUILT in order (fixed tags first); a
  // fixed tag's image follows the release's caddy.Dockerfile, a commit tag's its commit (FAKE_BUILD_SALT: a rebuild that
  // differs). FAKE_FAULT: listing (docker image ls before the build), config (the first compose config), preflight-config or preflight-json (the second one, the
  // sender preflight's: refused, or an answer that is not JSON), build (after the first tag), daemon (the daemon goes
  // away as the build starts),
  // validate, signal-HUP|INT|TERM (the installer gets that signal mid-build). FAKE_MANIFEST_EDIT: a manifest written
  // over the server's during the build. FAKE_SIGNAL_ON_TAG: the installer gets that signal at the first docker tag.
  // FAKE_READER_GONE, FAKE_READER_WAIT: the build (build) or the preflight's compose config (preflight) goes on only once
  // the reader of the installer's output has left (that file exists). FAKE_TAG_FAULT: docker tag
  // is refused. FAKE_INSPECT_FAIL_ONCE: the first docker image inspect of that tag fails.
  docker: `printf '%s\\n' "$*" >>"$s/docker-calls"
touch "$s/images"
gone() { echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; }
[[ ! -e $s/daemon-down ]] || gone
id_of() { awk -v n="$1" '$1 == n { print $2 }' "$s/images"; }
set_tag() { { awk -v n="$1" '$1 != n' "$s/images"; printf '%s %s\\n' "$1" "$2"; } | sort >"$s/images.$$"; "$REAL_MV" "$s/images.$$" "$s/images"; }
commit() { sed -n 's/^SH_RELEASE=//p' .env; }
wait_reader() {
  [[ \${FAKE_READER_WAIT:-} == "$1" ]] || return 0
  for _ in $(seq 1 300); do [[ ! -e $FAKE_READER_GONE ]] || return 0; "$REAL_SLEEP" 0.1; done
}
case "$1 $2" in
  "compose config")
    effect "check: compose config"
    n=$(($(cat "$s/config-calls" 2>/dev/null || echo 0) + 1)); echo "$n" >"$s/config-calls"
    [[ \${FAKE_FAULT:-} != config ]] || { echo "fixture: compose cannot read the project" >&2; exit 1; }
    [[ \${FAKE_FAULT:-}-$n != preflight-config-2 ]] || { echo "fixture: compose cannot read the project for the preflight" >&2; exit 1; }
    [[ \${FAKE_FAULT:-}-$n != preflight-json-2 ]] || { echo "fixture: not JSON"; exit 0; }
    [[ $n != 2 ]] || wait_reader preflight
    c=$(commit) json='' i=0
    for t in $FAKE_BUILT; do json+="\\"built-$i\\":{\\"build\\":{\\"context\\":\\".\\"},\\"image\\":\\"\${t//\\{c\\}/$c}\\"},"; i=$((i + 1)); done
    printf '{"services":{%s"alpha-sender":{"image":"squarehole-keeper:%s","environment":{"SH_SERVICE_ENABLED":"%s"}}}}\\n' "$json" "$c" "\${FAKE_SENDER_ENABLED:-0}" ;;
  "compose build")
    effect "check: compose build"
    [[ \${FAKE_FAULT:-} != daemon ]] || { : >"$s/daemon-down"; gone; }
    if [[ -n \${FAKE_MANIFEST_EDIT:-} ]]; then cat "$FAKE_MANIFEST_EDIT" >"$FAKE_ROOT/srv/squarehole/manifests/11155111.json"; fi
    c=$(commit)
    for t in $FAKE_BUILT; do
      image=\${t//\\{c\\}/$c}
      if [[ $t == *'{c}'* ]]; then id="fixture:$(printf '%s %s' "$image" "\${FAKE_BUILD_SALT:-}" | cksum | cut -d' ' -f1)"
      else id="fixture:$(cat caddy.Dockerfile | cksum | cut -d' ' -f1)"; fi
      set_tag "$image" "$id"
      [[ \${FAKE_FAULT:-} != build ]] || { echo "fixture: the build failed after $image" >&2; exit 1; }
      if [[ \${FAKE_FAULT:-} == signal-* ]]; then kill -"\${FAKE_FAULT#signal-}" "$(installer_pid)"; FAKE_FAULT=''; fi
    done
    wait_reader build ;;
  "image ls")
    [[ \${FAKE_FAULT:-} != listing ]] || { echo "Error response from daemon: fixture listing failure" >&2; exit 1; }
    id_of "\${*: -1}" ;;
  "image inspect")
    if [[ \${FAKE_INSPECT_FAIL_ONCE:-} == "\${*: -1}" && ! -e $s/inspect-failed ]]; then
      : >"$s/inspect-failed"; echo "Error response from daemon: fixture: a passing error" >&2; exit 1
    fi
    id=$(id_of "\${*: -1}"); [[ -n $id ]] || { echo "Error: No such image: \${*: -1}" >&2; exit 1; }; echo "$id" ;;
  "tag "*)
    effect "docker tag $3"
    if [[ -n \${FAKE_SIGNAL_ON_TAG:-} && ! -e $s/signalled ]]; then : >"$s/signalled"; kill -"$FAKE_SIGNAL_ON_TAG" "$(installer_pid)"; fi
    [[ -z \${FAKE_TAG_FAULT:-} ]] || { echo "Error response from daemon: fixture refusal of the tag" >&2; exit 1; }
    id=$(id_of "$2"); id=\${id:-$2}; set_tag "$3" "$id" ;;
  "run --rm")
    [[ "$*" == *" caddy validate "* && -n $(id_of squarehole-caddy:2.11.6-ratelimit) ]] || { echo "UNEXPECTED docker $*" >&2; exit 99; }
    effect "check: caddy validate"
    [[ \${FAKE_FAULT:-} != validate ]] || { echo "Error: adapting config using caddyfile: fixture refusal"; exit 1; }
    echo "Valid configuration" ;;
  *) echo "UNEXPECTED docker $*" >&2; exit 99 ;;
esac`,
};

// The release files install.sh reads, from this checkout; each release appends its commit to them, so every shared
// input a candidate carries differs from the running release's.
const SERVER_FILES = ['Caddyfile', 'origin-firewall.sh', 'alpha-backup-flags.sh', 'alpha-backup.sh', 'pg-backup.sh', 'journald.conf',
  'caddy.Dockerfile', 'compose.yaml', ...readdirSync('infra/server/systemd').map(name => `systemd/${name}`)];
const SMOKE = '#!/usr/bin/env bash\n[[ ${FAKE_FAULT:-} != smoke ]] || { echo "smoke-services: fixture worker unhealthy" >&2; exit 1; }\necho "smoke-services: $1 fixture healthy"\n';

/**
 * A scratch server: `ship(commit, options)` builds that commit's release tarball and runs the installer on it, as ship.sh
 * does on the droplet. options: release { manifest: 'placeholder' | 'broken', landing: false, allowlist: 'broken',
 * cut: true }, fault (FAKE_FAULT), env, reader: whoever reads the installer's output (as ssh does without a terminal)
 * goes away as a cut session does, after the first line ('leaves', during the build) or after the allowlist check's line
 * ('leaves-before-switch', before the switch).
 */
export function stackServer({ script = 'infra/server/install.sh' } = {}) {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/stack-install-'));
  const root = join(dir, 'root'), bin = join(dir, 'bin'), state = join(dir, 'state');
  for (const path of [root, bin, state]) mkdirSync(path);
  // The host's own folders, there before any install.
  for (const path of ['etc/systemd/system', 'usr/local/sbin', 'var/backups']) mkdirSync(join(root, path), { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${PRELUDE}${body}\n`, { mode: 0o755 });
  const installer = join(dir, 'install.sh');
  writeFileSync(installer, movedInstaller(readFileSync(script, 'utf8'), root));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ROOT: root, FAKE_STATE: state, FAKE_BUILT: builtImages().join(' '), FAKE_INSTALLER: installer,
    REAL_INSTALL: real('install'), REAL_CHMOD: real('chmod'), REAL_MV: real('mv'), REAL_LN: real('ln'), REAL_SLEEP: real('sleep'), LC_ALL: 'C' };
  const effectsFile = join(state, 'effects');
  const effects = () => existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8').trim().split('\n').filter(Boolean) : [];

  function release(commit, { manifest = 'deployed', landing = true, allowlist = 'cloudflare', cut = false } = {}) {
    const src = join(dir, `src-${commit}-${manifest}-${landing}-${allowlist}`);
    for (const file of SERVER_FILES) {
      const target = join(src, 'infra/server', file);
      mkdirSync(join(target, '..'), { recursive: true });
      let text = readFileSync(join('infra/server', file), 'utf8');
      if (file === 'Caddyfile' && allowlist === 'broken') text = text.replace(/^(\s*trusted_proxies\s+static)\s.*$/m, '$1 private_ranges');
      writeFileSync(target, `${text}\n# release ${commit}\n`);
    }
    writeFileSync(join(src, 'infra/server/smoke-services.sh'), SMOKE);
    const pub = join(src, 'apps/landing/public');
    mkdirSync(pub, { recursive: true });
    for (const name of ['index.html', '404.html', '_headers', ...(landing ? ['styles.css'] : [])]) writeFileSync(join(pub, name), `${name} of ${commit}\n`);
    const deployments = join(src, 'packages/contracts/deployments/core-v1');
    mkdirSync(deployments, { recursive: true });
    writeFileSync(join(deployments, '11155111.json'), manifest === 'broken' ? '{"status": "deployed",\n'
      : `${JSON.stringify({ chainId: 11155111, status: manifest === 'placeholder' ? 'awaiting-broadcast' : 'deployed', release: commit }, null, 2)}\n`);
    const tarball = `${src}.tar.gz`;
    execFileSync('tar', ['-czf', tarball, '-C', src, 'apps', 'packages', 'infra']);
    if (cut) truncateSync(tarball, Math.floor(lstatSync(tarball).size / 2));
    return { tarball, manifest: readFileSync(join(deployments, '11155111.json')), file: (path) => readFileSync(join(src, path)) };
  }

  function ship(commit, { release: shape = {}, fault = '', env: extra = {}, reader = 'stays' } = {}) {
    const made = release(commit, shape);
    const start = effects().length;
    writeFileSync(join(state, 'config-calls'), '0');
    const gone = join(state, `reader-gone-${start}`);
    const leaves = { leaves: ['', 'build'], 'leaves-before-switch': ['checked, not applied', 'preflight'] }[reader];
    const args = leaves
      ? ['-c', 'bash "$0" "$1" "$2" 2>&1 | { while IFS= read -r line; do printf "%s\\n" "$line"; [[ -n $4 && $line != *"$4"* ]] || break; done; '
        + 'exec 0<&-; : >"$3"; }; exit "${PIPESTATUS[0]}"', installer, made.tarball, commit, gone, leaves[0]]
      : [installer, made.tarball, commit];
    const result = spawnSync('bash', args, { encoding: 'utf8', timeout: 60000,
      env: { ...env, FAKE_FAULT: fault, ...(leaves ? { FAKE_READER_GONE: gone, FAKE_READER_WAIT: leaves[1] } : {}), ...extra } });
    return { ...result, out: `${result.stdout}${result.stderr}`, release: made, effects: effects().slice(start) };
  }

  const at = (path) => join(root, path);
  const readState = (name) => existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : '';
  const lines = (name) => readState(name).split('\n').filter(Boolean);
  const images = () => Object.fromEntries(lines('images').map(line => line.split(' ')));

  /**
   * Every shared input the running release reads, as data: each file, folder and link under the scratch root (type,
   * mode, bytes or target), recorded owners (last write wins), ACL entries, both firewall chains, systemd's enabled,
   * active and loaded state, journald's loaded limits, the running stack and the image tags. `candidate` leaves out
   * that commit's own unpacked release (staging the running release never reads).
   */
  function shared({ candidate } = {}) {
    const files = {};
    const walk = (path) => {
      for (const name of readdirSync(path).sort()) {
        const full = join(path, name), rel = relative(root, full);
        if (candidate && rel.startsWith(`srv/squarehole/releases/${candidate}`)) continue;
        const stat = lstatSync(full), mode = (stat.mode & 0o7777).toString(8);
        if (stat.isSymbolicLink()) files[rel] = `link ${readlinkSync(full)}`;
        else if (stat.isDirectory()) { files[rel] = `folder ${mode}`; walk(full); }
        else files[rel] = `file ${mode} ${hash(readFileSync(full))}`;
      }
    };
    walk(root);
    return {
      files,
      owners: Object.fromEntries(lines('owners').map(line => line.split(' '))),
      acl: [...new Set(lines('acl'))].sort(),
      firewall: { 'SH-ORIGIN': readState('iptables-SH-ORIGIN'), 'DOCKER-USER': readState('iptables-DOCKER-USER') },
      systemd: { units: lines('systemd'), loaded: readState('systemd-loaded'), journald: readState('journald') },
      stack: readState('stack'),
      images: images(),
    };
  }

  /** A's folders as they would be before an installer that sets other modes, owners and ACLs than they now have. */
  function drift() {
    execFileSync('chmod', ['0750', at('srv/squarehole/alpha/queue')]);
    writeFileSync(join(state, 'owners'), `${readState('owners')}srv/squarehole/withheld 2103:2103\n`);
    writeFileSync(join(state, 'acl'), lines('acl').filter(line => !line.endsWith(' u:2101:rwx')).map(line => `${line}\n`).join(''));
  }

  const docker = (...args) => spawnSync(join(bin, 'docker'), args, { encoding: 'utf8', env });
  return { dir, root, state, at, ship, shared, drift, effects, images, readState, docker, current: () => readlinkSync(at('srv/squarehole/current')) };
}

/** Copies the repository files a release carries into a scratch folder (used by the origin-firewall checks). */
export function scratchCopy(prefix, files) {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve(`.cache/tmp/${prefix}`));
  for (const file of files) { mkdirSync(join(dir, file, '..'), { recursive: true }); cpSync(file, join(dir, file)); }
  return dir;
}
