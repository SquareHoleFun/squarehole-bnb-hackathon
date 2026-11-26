import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cwd = fileURLToPath(new URL('../../../', import.meta.url));
const inspect = name => JSON.parse(execFileSync('forge', ['inspect', name, 'storageLayout', '--offline', '--json'], { cwd, encoding: 'utf8' }));
const receiver = inspect('BoxReceiverV2');
const fields = layout => layout.storage.map(({ label, slot, offset, type }) => [label, slot, offset, layout.types[type].label]);

// c0d416dc9's persistent slots, followed only by this release's seller cursor.
test('FEEPATH storage: every existing receiver slot retains its offset and type', () => {
  assert.deepEqual(fields(receiver), [
    ['_p', '0', 0, 'uint256[10]'], ['_reservedFormerConversion', '10', 0, 'uint256'],
    ['_payee', '11', 0, 'address'], ['_pendingPayee', '12', 0, 'address'], ['_burnPending', '13', 0, 'uint256'],
    ['_initialized', '14', 0, 'bool'], ['_graduationSettled', '14', 1, 'bool'], ['_failureSettled', '14', 2, 'bool'],
    ['_holderBatchPaid', '15', 0, 'mapping(uint256 => uint256)'], ['_holderBatchClosed', '16', 0, 'mapping(uint256 => bool)'],
    ['_harvestedBuyers', '17', 0, 'uint256'], ['_harvestedSellers', '18', 0, 'uint256'], ['_harvestedReserve', '19', 0, 'uint256'],
    ['_lastHolderBatch', '20', 0, 'uint256'], ['_itemVault', '21', 0, 'address'], ['_itemCount', '21', 20, 'uint32'],
    ['_itemPolicies', '21', 24, 'uint16'], ['_itemsBuyersHeld', '22', 0, 'uint256'], ['_itemFunding', '23', 0, 'struct ItemFundingV2[]'],
    ['_eatPendingP', '24', 0, 'uint256'], ['_eatenP', '25', 0, 'uint256'], ['_rewards', '26', 0, 'struct RewardAccountingV21.State'],
    ['_pilePendingP', '36', 0, 'uint256'], ['_pileMovedP', '37', 0, 'uint256'], ['_modulePending', '38', 0, 'uint256[2]'],
    ['_sourceAllocatedP', '40', 0, 'uint256'], ['_lastSellerBatch', '41', 0, 'uint256'],
  ]);
});

// Compiler AST ids differ between the receiver and the library witness; storage does not.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'astId' && key !== 'contract')
    .map(([key, item]) => [key.replace(/(t_(?:struct|enum)\([^)]*\))\d+/g, '$1'), normalize(item)]));
  return typeof value === 'string' ? value.replace(/(t_(?:struct|enum)\([^)]*\))\d+/g, '$1') : value;
}
test('FEEPATH storage: the fixed library overlay matches every receiver member and nested type', () => {
  const actual = normalize(receiver);
  const raw = inspect('FeeCoreStorageWitness');
  const wrapper = raw.storage[0].type;
  // Both libraries call their struct State. Keep the wrapper's id distinct before removing AST ids.
  const witness = normalize(JSON.parse(JSON.stringify(raw).replaceAll(wrapper, 't_struct(CoreOverlay)_storage')));
  assert.deepEqual(witness.types[witness.storage[0].type].members, actual.storage);
  for (const [name, type] of Object.entries(actual.types)) assert.deepEqual(witness.types[name], type);
});
