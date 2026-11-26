// SH-259 rule E: preloaded by compose.yaml (`node --import /check/bin/start.mjs`) before the keeper's service at every
// start; on a refusal the process exits 78 and the service never runs (check.mjs says what is checked).
import { readFileSync } from 'node:fs';
import { atlasCheck, startCheck } from './check.mjs';

let why;
try {
  why = startCheck(process.env, readFileSync('/check/97.json'), readFileSync('/check/approved-97.sha256', 'utf8'),
    readFileSync('/check/keeper-fees-97.json'))
    ?? atlasCheck(process.env, readFileSync('/check/97-atlas.json'), readFileSync('/check/approved-atlas.sha256', 'utf8'));
} catch {
  why = 'the manifest or the approved digests are unreadable';
}
if (why) {
  process.stderr.write(`keeper: start refused: ${why}\n`);
  process.exit(78);
}
process.stdout.write('keeper: start check ok (chain 97, the approved manifest, the approved fee policy, the approved Atlas settings)\n');
