"""Test-only driver for the preserved v2 integer oracle (v2 T05 differential test).

Usage: PYTHONDONTWRITEBYTECODE=1 python3 -B vault_oracle_driver.py <scratch copy of reference/v0_1/model.py>
Reads {"traces": [...]} as JSON on stdin and writes {"traces": [...]} as JSON on stdout.

The model is loaded from a scratch copy, never from inside square-hole-core-v2/. Raw integers travel as decimal
strings. Every trace uses the oracle's `block_last` policy (F23: the last Misfit cannot leave).

F23 unsolicited FIT: the TypeScript ledger keeps FIT sent to the vault in its own bucket, outside E, so quotes do
not move. The oracle has no such bucket, so `sendFitToVault` becomes a plain transfer to the ordinary account
UNSOLICITED, which the oracle already counts inside A = S - E. Both sides must then agree exactly.
"""
import importlib.util
import json
import sys

UNSOLICITED = '__vault_unsolicited__'

# Oracle RuleViolation message -> TypeScript VaultRuleError code. Traces never send negative amounts or system
# accounts, so the oracle's combined "Burn not authorized" message can only mean a balance shortfall here.
CODES = {
    'Not enough available NFTs': 'invalid_quantity',
    'Last NFT withdrawal disabled by scenario policy': 'last_misfit',
    'No such number of outside NFTs': 'invalid_quantity',
    'Return quote below one raw unit per NFT': 'return_below_unit',
    'Insufficient balance': 'insufficient_fit',
    'Withdrawal max FIT exceeded': 'max_fit_exceeded',
    'Insufficient owner FIT': 'insufficient_fit',
    'NFT identity not eligible': 'ineligible_ids',
    'Empty/duplicate NFT list': 'invalid_id_list',
    'Caller does not own these outside NFTs': 'not_owner',
    'Return min FIT not met': 'min_fit_not_met',
    'Escrow insolvency': 'escrow_insolvent',
    'Invalid NFT owner or recipient': 'not_owner',
    'Burn not authorized from this inventory': 'insufficient_fit',
    'Burn would leave <1 raw FIT unit per vault NFT': 'dust_guard',
    'Revenue budget is not funded': 'stream_not_funded',
    'Revenue burn breaches dust guard': 'dust_guard',
}


def load_model(path):
    spec = importlib.util.spec_from_file_location('sh_v2_oracle_model', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def code_of(error):
    message = str(error)
    if message not in CODES:
        raise RuntimeError('unmapped oracle message: ' + message)
    return CODES[message]


def ratio(value):
    return {'num': str(value.numerator), 'den': str(value.denominator)}


def state(model, vault):
    def quote(fn):
        try:
            return {'ok': str(fn(1))}
        except model.RuleViolation as error:
            return {'error': code_of(error)}

    system = (model.ESCROW, model.CLAIMS)
    return {
        'supply': str(vault.total_supply),
        'escrow': str(vault.escrow),
        'active': str(vault.active),
        'inside': vault.n,
        'outside': vault.m,
        'rate': ratio(vault.rate),
        'surplus': ratio(vault.surplus),
        'burned': str(vault.total_burned),
        'claimsReserve': str(vault.balances.get(model.CLAIMS, 0)),
        'balances': {a: str(b) for a, b in sorted(vault.balances.items()) if a not in system and b},
        'claims': {a: str(c) for a, c in sorted(vault.claims.items())},
        'outsideOwners': {str(i): o for i, o in sorted(vault.outside.items())},
        'quoteWithdraw1': quote(vault.quote_withdraw),
        'quoteReturn1': quote(vault.quote_return),
    }


def optional_int(op, key):
    return int(op[key]) if key in op else None


def apply(model, vault, op):
    kind = op['op']
    if kind == 'withdraw':
        ids, principal = vault.withdraw(op['owner'], op['count'], max_fit=optional_int(op, 'maxFit'),
                                        ids=op.get('ids'))
        return {'ids': list(ids), 'principal': str(principal)}
    if kind == 'return':
        principal = vault.return_nfts(op['owner'], op['ids'], min_fit=optional_int(op, 'minFit'))
        return {'principal': str(principal)}
    if kind == 'transferMisfit':
        vault.transfer_nft(op['from'], op['to'], op['id'])
        return {}
    if kind == 'transferFit':
        vault.transfer(op['from'], op['to'], int(op['amount']))
        return {}
    if kind == 'sendFitToVault':
        vault.transfer(op['from'], UNSOLICITED, int(op['amount']))
        return {}
    if kind == 'burn':
        vault.burn(op['owner'], int(op['amount']))
        return {}
    if kind == 'accrue':
        result = vault.accrue_nft_fit_revenue(op['source'], int(op['budget']))
        return {'budget': str(result['budget']), 'burned': str(result['burned']),
                'credited': str(result['credited']), 'dust': str(result['dust_retained_by_source'])}
    if kind == 'claim':
        return {'paid': str(vault.claim(op['owner']))}
    raise RuntimeError('unknown op: ' + kind)


def run_trace(model, trace):
    allocations = {a: int(v) for a, v in trace['allocations'].items()}
    vault = model.Vault(allocations, nfts=trace['collectionSize'], empty_policy='block_last')
    steps = []
    for op in trace['ops']:
        try:
            outcome = {'ok': apply(model, vault, op)}
        except model.RuleViolation as error:
            outcome = {'error': code_of(error)}
        vault.assert_invariants(deep=True)
        steps.append({'outcome': outcome, 'state': state(model, vault)})
    return {'steps': steps}


def main():
    model = load_model(sys.argv[1])
    request = json.load(sys.stdin)
    json.dump({'traces': [run_trace(model, trace) for trace in request['traces']]}, sys.stdout)


if __name__ == '__main__':
    main()
