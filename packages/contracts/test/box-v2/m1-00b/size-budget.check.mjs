// CQ11-0: the surviving release parts all have the same 22,118-byte admission gate.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../../../', import.meta.url);
const budget = JSON.parse(readFileSync(new URL('size-budget.v2.json', root), 'utf8'));
const parts = Object.entries(budget.gates);
assert.ok(parts.length > 0, 'manifest must list release gates');
assert.equal(budget.limitBytes, 24576);
assert.equal(budget.minReserveBytes, 2458);
assert.equal(budget.gates.BoxReceiverV2.roomGateBytes, 18500);
for (const [name, gate] of parts) {
  assert.equal(gate.m1GateBytes, 22118, name);
  assert.equal(gate.reserveBytes, 2458, name);
  assert.match(gate.source, /^src\/box-v2\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_]+\.sol$/, name);
  assert.ok(existsSync(new URL(gate.source, root)), gate.source);
}
process.stdout.write(`CQ11-0: ${parts.length} surviving parts pinned at 22,118 bytes; runtime checked by SizeBudget.t.sol\n`);
