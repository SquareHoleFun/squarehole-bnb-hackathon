#!/usr/bin/env node
// SH-TA-20: unsigned Safe Transaction Builder files; no RPC, wallet, signing or sending.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { encodeFunctionData, erc20Abi, getAddress, isAddress, parseAbi, zeroAddress } from 'viem';

// Pinned to docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY/reviewed-plan.json (core-v21-rc8).
const CHAIN_ID = '11155111';
const LISTINGS = '0x84Dc1E9Cd7da248f85133E5e03EF3A303a51072D';
const SAFE = '0x9432380a67745b453886698F9539aC035DF80B34';
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const DEFAULT_RAISE = '100000000000000000'; // Founder choice for Sepolia, 2026-10-23.
const BURN_SELECTOR = '0x42966c68'; // CheckedBurn.SELECTOR: burn(uint256).
const CLASSES = new Map([['STANDARD', 2n], ['STABLE', 3n], ['STOCK', 4n], ['OTHER', 5n]]);
// TA-30: proposed small test-box raises, in each stand-in's raw units. No live token addresses are guessed.
export const TEST_COINS = new Map([
  ['tLINK', { action: 'add', class: 'OTHER', raise: '100000000000000000000' }],
  ['tUSDC', { action: 'add', class: 'STABLE', raise: '100000000' }],
  ['tNVDA', { action: 'add', class: 'STOCK', raise: '100000000000000000000' }],
  ['tGOLD', { action: 'add', class: 'OTHER', raise: '1000000000000000000' }],
  ['tPEPE', { action: 'add', class: 'OTHER', raise: '100000000000000000000000' }],
  ['tFROG', { action: 'addWithBurn', class: 'OTHER', raise: '100000000000000000000000' }],
]);
// SH-ALPHA-TETH: deployed later. Keep the original six-coin launch pack and merged batch intact.
const PRESETS = new Map([
  ...TEST_COINS,
  ['tETH', { action: 'add', class: 'OTHER', raise: '1000000000000000000' }],
]);
// IListingRegistry / IListingBurnV21. Tests decode against the committed forge-generated ABIs.
const listingAbi = parseAbi([
  'function updateRaise(uint32 id, uint256 raise)',
  'function add(address token, uint8 class, uint256 raise) returns (uint32 id)',
  'function addWithBurn(address token, uint8 class, uint256 raise, bytes4 selector) returns (uint32 id)',
]);

const HELP = `Usage: node packages/chain/scripts/sepolia-listing-batch.mjs --out FILE [flags]

--coins FILE                        Merged step 4: JSON object with all six symbol/address
                                    bindings; use only with --out. Updates row 0 first.

--action updateRaise|add|addWithBurn  Default: updateRaise, always native row 0.
--test-coin ${[...PRESETS.keys()].join('|')}
                                    Test-set preset; requires --token. Sets action,
                                    class and 10000-unit approval; --raise may override.
--chain-id 11155111                  Sepolia only; this is also the default.
--raise RAW                         Decimal raw units. Default 100000000000000000
                                    (0.1 ETH) for updateRaise; required for add*.
--token ADDRESS                     Required for add*; coin being listed.
--class STANDARD|STABLE|STOCK|OTHER   Required for add*. STANDARD is for box coins.
--amount RAW                        add* approval, default 10000 raw token units.
--burn-selector 0x42966c68           addWithBurn only; default burn(uint256).
--out FILE                          New JSON file in an existing directory.
--help                              Show this text.

Registry: ${LISTINGS}
Platform Safe: ${SAFE}
Import into that Safe on Sepolia, review every call, and execute all entries together.
Coin batches: approve(amount), add/addWithBurn, approve(0). The Safe needs at least
10000 raw token units for reverting probes; existing allowance must permit approve.
This only packages calldata. It does not check live state, simulate, sign or send.
`;

function need(condition, message) {
  if (!condition) throw new Error(message);
}

function raw(value, flag, minimum, maximum) {
  need(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), `${flag} requires a decimal raw-unit integer`);
  const amount = BigInt(value);
  need(amount >= minimum && amount <= maximum, `${flag} must be between ${minimum} and ${maximum}`);
  return amount;
}

function parseArgs(argv) {
  const allowed = new Set(['action', 'chain-id', 'raise', 'token', 'class', 'amount', 'burn-selector', 'out', 'test-coin']);
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    need(typeof flag === 'string' && flag.startsWith('--') && allowed.has(flag.slice(2)), `unknown flag: ${flag}`);
    const key = flag.slice(2);
    need(!flags.has(key), `duplicate flag: ${flag}`);
    const value = argv[i + 1];
    need(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${flag} needs a value`);
    flags.set(key, value);
  }
  need((flags.get('chain-id') ?? CHAIN_ID) === CHAIN_ID, 'only Sepolia chain-id 11155111 is allowed');
  if (flags.has('test-coin')) {
    const preset = PRESETS.get(flags.get('test-coin'));
    need(preset, `--test-coin must name ${[...PRESETS.keys()].join(', ')}`);
    for (const key of ['action', 'class', 'amount', 'burn-selector']) {
      need(!flags.has(key), `--${key} conflicts with --test-coin`);
    }
    flags.set('action', preset.action);
    flags.set('class', preset.class);
    if (!flags.has('raise')) flags.set('raise', preset.raise);
  }
  const action = flags.get('action') ?? 'updateRaise';
  need(['updateRaise', 'add', 'addWithBurn'].includes(action), 'action must be updateRaise, add or addWithBurn');
  const admission = action !== 'updateRaise';
  if (!admission) {
    for (const key of ['token', 'class', 'amount', 'burn-selector']) {
      need(!flags.has(key), `--${key} is not used by updateRaise`);
    }
  }
  const raise = raw(flags.get('raise') ?? (admission ? undefined : DEFAULT_RAISE), '--raise', 1000000n, (1n << 128n) - 1n);
  if (!admission) return { action, raise, out: flags.get('out') };
  const tokenInput = flags.get('token');
  need(typeof tokenInput === 'string' && isAddress(tokenInput), '--token requires a valid address');
  const token = getAddress(tokenInput);
  need(token !== zeroAddress && token !== WETH, '--token cannot be native ETH or WETH (use row 0)');
  const listingClass = CLASSES.get(flags.get('class'));
  need(listingClass !== undefined, '--class must be STANDARD, STABLE, STOCK or OTHER');
  const amount = raw(flags.get('amount') ?? '10000', '--amount', 10000n, (1n << 256n) - 1n);
  if (action === 'add') need(!flags.has('burn-selector'), '--burn-selector is only used by addWithBurn');
  else need((flags.get('burn-selector') ?? BURN_SELECTOR) === BURN_SELECTOR, '--burn-selector must be 0x42966c68 (burn(uint256))');
  return { action, raise, token, listingClass, amount, out: flags.get('out') };
}

function transaction(to, abi, name, args) {
  const method = abi.find(entry => entry.type === 'function' && entry.name === name);
  return {
    to,
    value: '0',
    data: encodeFunctionData({ abi, functionName: name, args }),
    contractMethod: { inputs: method.inputs.map(({ name, type }) => ({ name, type })), name, payable: false },
    contractInputsValues: Object.fromEntries(method.inputs.map((input, i) => [input.name, String(args[i])])),
  };
}

/** Offline builder. Inputs use the same flags as the CLI; all amounts remain bigint until serialized. */
export function buildBatch(argv) {
  const { action, raise, token, listingClass, amount } = parseArgs(argv);
  const transactions = [];
  if (action === 'updateRaise') transactions.push(transaction(LISTINGS, listingAbi, action, [0n, raise]));
  else {
    transactions.push(transaction(token, erc20Abi, 'approve', [LISTINGS, amount]));
    const args = [token, listingClass, raise];
    if (action === 'addWithBurn') args.push(BURN_SELECTOR);
    transactions.push(transaction(LISTINGS, listingAbi, action, args));
    // Admission probes revert their token operations, so they do not consume the approval.
    transactions.push(transaction(token, erc20Abi, 'approve', [LISTINGS, 0n]));
  }
  return {
    version: '1.0',
    chainId: CHAIN_ID,
    createdAt: Date.now(), // Safe schema timestamp, never a financial amount.
    meta: {
      name: `Square Hole Sepolia: ${action}`,
      description: `Unsigned Sepolia listing batch. Review and execute all entries together in the platform Safe. ${
        action === 'updateRaise' ? `Native row 0 raise: ${raise} wei, for future boxes only.`
          : `${token}: class ${listingClass}, raise ${raise}, approval ${amount} raw units; final approval zero.`
      } No live-state checks or simulation performed.`,
      txBuilderVersion: '1.18.0',
      createdFromSafeAddress: SAFE,
      createdFromOwnerAddress: '',
    },
    transactions,
  };
}

/** One atomic platform Safe batch, with no guessed coin addresses or listing ids. */
export function buildMergedBatch(coins) {
  need(coins && Object.keys(coins).sort().join(',') === [...TEST_COINS.keys()].sort().join(','), 'all six coin bindings required');
  need(new Set(Object.values(coins).map(a => String(a).toLowerCase())).size === 6, 'coin addresses must be distinct');
  const batch = buildBatch([]);
  for (const [symbol] of TEST_COINS) batch.transactions.push(...buildBatch(['--test-coin', symbol, '--token', coins[symbol]]).transactions);
  batch.meta.name = 'Square Hole Sepolia: native raise and six test listings';
  batch.meta.description = 'Execute all 19 entries atomically before creating boxes: native raise 0.1 ETH; six admission triples, each approve(10000), add/addWithBurn, approve(0). No live-state checks or simulation performed.';
  return batch;
}

function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntry()) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === '--help') process.stdout.write(HELP);
    else if (argv.includes('--coins')) {
      need(argv.length === 4 && argv[0] === '--coins' && argv[2] === '--out' && argv[1] && argv[3], 'use --coins FILE --out NEW_FILE');
      const batch = buildMergedBatch(JSON.parse(readFileSync(argv[1], 'utf8')));
      writeFileSync(argv[3], `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write('Wrote merged unsigned Sepolia listing batch. Nothing signed or sent.\n');
    } else {
      const { out } = parseArgs(argv);
      need(out, '--out is required; choose a new JSON file');
      const batch = buildBatch(argv);
      writeFileSync(out, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write('Wrote unsigned Sepolia Safe Transaction Builder JSON. Nothing signed or sent.\n');
    }
  } catch (error) {
    console.error(`sepolia-listing-batch: ${error.message}`);
    process.exitCode = 1;
  }
}
