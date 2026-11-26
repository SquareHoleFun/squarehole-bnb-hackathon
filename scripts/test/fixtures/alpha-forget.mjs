import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shLimit } from '../../../vitest.timeouts.mjs';

export const counts = { rows: { challenges: 1, claims: 2, decisions: 1, returning_browsers: 1, sessions: 1, signins: 1, signups: 1 }, files: 7, journals: 3, executed: true };
export function run({ failure = '', running = 'alpha-api\nalpha-sender', timer = 'active', input = 'private_tester\n', args = ['123456789', 'private_tester'], saved, root, stopLine = 0, fixture, commandStop = '', trace = false } = {}) {
  mkdirSync('.cache/lane/sh217-af3', { recursive: true });
  root ??= mkdtempSync(resolve('.cache/lane/sh217-af3/wrapper-'));
  const wrapper = join(root, 'alpha-forget.sh'), receipts = fixture?.receipts ?? root;
  const source = readFileSync(process.env.SH_FORGET_WRAPPER ?? 'infra/server/alpha-forget.sh', 'utf8')
    .replaceAll('/srv/squarehole/current/infra/server', root).replaceAll('/var/backups/squarehole', root)
    .replace('set -euo pipefail', `set -euo pipefail; trap '[[ $BASH_SOURCE != "$SCRIPT" || $LINENO != "$STOP_LINE" ]] || kill -KILL "$BASHPID"; [[ $BASH_SOURCE != "$SCRIPT" || $TRACE != true ]] || printf "%s\\n" "$LINENO" >> "$DIR/trace"' DEBUG`)
    .replaceAll('/forget-restore', root)
    .replaceAll('/srv/squarehole/alpha/receipts', receipts)
    .replaceAll('"/alpha/receipts/forget-tester.json', `"${receipts}/forget-tester.json`);
  writeFileSync(wrapper, source);
  writeFileSync(join(root, 'smoke-services.sh'), readFileSync('infra/server/smoke-services.sh'));
  if (!existsSync(join(root, 'timer'))) writeFileSync(join(root, 'timer'), timer);
  if (!existsSync(join(root, 'running'))) writeFileSync(join(root, 'running'), running);
  if (saved !== undefined) writeFileSync(join(root, 'alpha-forget.restore'), saved);
  writeFileSync(join(root, 'calls'), '');
  writeFileSync(join(root, 'trace'), '');
  if (fixture) writeFileSync(join(root, 'driver.mjs'), `
    import { forgetTester } from ${JSON.stringify(process.env.SH_FORGET_MODULE ?? new URL('../../../infra/server/services/alpha/forget-tester.mjs', import.meta.url).href)};
    const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
    const options = { ...${JSON.stringify(fixture)}, xId: value('--x-id'), handle: value('--handle'), execute: args.includes('--execute'), servicesStopped: args.includes('--services-stopped'),
      operation: args.includes('--operation') ? value('--operation') : undefined, completion: args.includes('--completion') ? value('--completion') : undefined };
    try { console.log(JSON.stringify(await forgetTester(options, { checkpoint(p) { if (p === process.env.COMMAND_STOP) process.kill(process.pid, 'SIGKILL'); } }))); }
    catch (error) { console.error(error.forgetGuard ? error.message : 'command failed'); process.exitCode = 1; }
  `);
  const harness = `
    docker() {
      printf 'docker %s\\n' "$*" >> "$CALLS"
      case "$*" in
        'compose ps --status running --services') [[ $FAILURE != ps ]] || return 1; cat "$DIR/running" ;;
        'compose stop '*) [[ $FAILURE != stop ]] || return 1; : > "$DIR/running" ;;
        'compose ps --all --quiet '*) [[ $FAILURE != missing-container ]] && printf 'container-id\\n' ;;
        'inspect --format {{.State.Running}} '*)
          [[ $FAILURE != inspect ]] || return 1
          if [[ $FAILURE == still-running || ! -e $DIR/inspect-waited ]]; then : > "$DIR/inspect-waited"; printf 'true 123 false\\n'; else printf 'false 0 false\\n'; fi ;;
        'inspect '*) if [[ $FAILURE == volume ]]; then printf 'bad volume\\n'; else printf 'sender-volume\\n'; fi ;;
        'compose images --quiet alpha-sender') [[ $FAILURE != image ]] && printf '%064d\\n' 1 ;;
        'compose start '*) [[ $FAILURE != restart ]] || return 1; if [[ $'\\n'"$(cat "$DIR/running")"$'\\n' != *$'\\n'"$3"$'\\n'* ]]; then printf '%s\\n' "$3" >> "$DIR/running"; fi ;;
        'compose exec -T '*) [[ $FAILURE != smoke ]] ;;
        'run '*)
          local selected= operation= completion= previous=
          for value in "$@"; do
            case $previous in --x-id) selected=$value ;; --operation) operation=$value ;; --completion) completion=$value ;; esac
            previous=$value
          done
          if [[ " $* " == *' -e '* ]]; then
            if [[ $FAILURE == manifest ]]; then printf 'unfinished' > "$DIR/forget-tester.json"; fi
            while [[ $1 != -e ]]; do shift; done
            node "$@"
          elif [[ $REAL_COMMAND == true ]]; then
            while [[ $1 != infra/server/services/alpha/forget-tester.mjs ]]; do shift; done
            shift
            node "$DIR/driver.mjs" "$@"
          elif [[ " $* " == *' --execute '* ]]; then
            [[ $FAILURE != execute ]] || return 1
            [[ ! -e $DIR/gone-$selected || -e $DIR/forget-tester.json ]] || return 1
            : > "$DIR/gone-$selected"
            if [[ -n $completion ]]; then
              head -n 5 "$completion" > "$completion.prepare"
              printf '{"v":1,"operation":"%s","counts":%s}\\n' "$operation" "$COUNTS" >> "$completion.prepare"
              mv "$completion.prepare" "$completion"
            fi
            if [[ -e $DIR/forget-tester.json ]]; then unlink "$DIR/forget-tester.json"; fi
            if [[ $FAILURE == counts ]]; then printf 'invalid' > "$completion"; printf '{"handle":"private_tester"}\\n'; else printf '%s\\n' "$COUNTS"; fi
          else
            [[ $FAILURE != plan ]] || return 1
            if [[ -e $DIR/gone-$selected && ! -e $DIR/forget-tester.json ]]; then printf '{"absent":true}\\n'; return; fi
            printf '{"handle":"pr***er","executed":false}\\n'
          fi ;;
        *) return 99 ;;
      esac
    }
    systemctl() {
      printf 'systemctl %s\\n' "$*" >> "$CALLS"
      case "$*" in
        'show --property=ActiveState --value squarehole-pg-backup.service')
          [[ $FAILURE != backup-inspect ]] || return 1
          if [[ $FAILURE == backup || ( $FAILURE == backup-race && -e $DIR/stopped-timer ) ]]; then printf 'active\\n'; else printf 'inactive\\n'; fi ;;
        'show --property=ActiveState --value squarehole-pg-backup.timer')
          if [[ $FAILURE == timer-state ]]; then printf 'activating\\n'; else cat "$DIR/timer"; fi ;;
        'stop squarehole-pg-backup.timer')
          [[ $FAILURE != timer-stop ]] || return 1
          : > "$DIR/stopped-timer"
          [[ $FAILURE == timer-running ]] || printf inactive > "$DIR/timer" ;;
        'start squarehole-pg-backup.timer') [[ $FAILURE != timer-restart ]] || return 1; printf active > "$DIR/timer" ;;
        *) return 99 ;;
      esac
    }
    flock() { printf 'flock %s\\n' "$*" >> "$CALLS"; [[ $FAILURE != lock ]]; }
    sleep() { :; }
    export -f docker systemctl flock sleep
    bash "$SCRIPT" "$@"
  `;
  const result = spawnSync('/bin/bash', ['-c', harness, 'harness', ...args], { encoding: 'utf8', input, stdio: input === '' ? ['ignore', 'pipe', 'pipe'] : undefined, timeout: shLimit(30000),
    env: { ...process.env, DIR: root, SCRIPT: wrapper, CALLS: join(root, 'calls'), FAILURE: failure, STOP_LINE: String(stopLine), REAL_COMMAND: String(Boolean(fixture)), COMMAND_STOP: commandStop, TRACE: String(trace), COUNTS: JSON.stringify(counts) } });
  assert.ok(!(result.stdout + result.stderr).includes('private_tester'), 'wrapper output retained the full handle');
  return { ...result, root, trace: readFileSync(join(root, 'trace'), 'utf8').trim().split('\n').filter(Boolean).map(Number), calls: readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').filter(Boolean) };
}

