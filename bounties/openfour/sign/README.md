# The creation signer

Lets a visitor create a launch on our OpenFour copy from the browser, with their own wallet. OpenFour's Core accepts
`createToken(createArgs, signature)` only with a signature of the copy's configured signer (in production Four.meme's
API signs; on a developer-owned copy the copy's owner chooses the key with `Core.setSigner`, here `pile.js
set-signer`). This folder is that signer as a function. The HTTP route, its rate limits and its logs belong to the
host; the form belongs to the page.

**What is signed.** The EIP-191 personal-message signature of the 32 bytes

    keccak256(abi.encodePacked("createOpenFourToken", uint256 chainId, address creator, keccak256(createArgs)))

with chainId 97. This is OpenFour's own format (Core is theirs and closed); it names the chain and the creator but no
Core address. So a signature is valid for that creator and those exact arguments on ANY Core on chain 97 that
trusts the same key (each such Core still checks its own presets, request ids and expiry). That is why this key is
intended for this one copy alone (nothing can stop another Core's owner from trusting it too), holds no coins, and
signs nothing but these requests.

## For the host (lane b)

```js
const { createSignService } = require("bounties/openfour/sign/service");
const { SignRefused } = require("bounties/openfour/sign/sign-create");
const signer = await createSignService({
  rpc: "https://bsc-testnet-rpc.publicnode.com",
  outDir: "<bounties/openfour/out of the real run>",          // fork-deployment.json, preset-registration.json, tax-template.json
  keystore: "<keystore file>", passwordFile: "<password file>", // the signer's own key: never funded, signs only these requests
  quotes: ["0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", "0x860822580d4eb2529de0c74c3e2b1d6d7c183302"], // WBNB, tETH
  raiseMin: "0.1", raiseMax: "2",
});
// per request (after your body cap and your rate limit: per creator address and per IP, plus a daily cap):
try {
  const answer = await signer.sign(body);           // body: the parsed JSON the page sent; sign takes nothing else
  // 200 with answer
} catch (e) {
  if (e instanceof SignRefused) /* 400 with { error: e.code, message: e.message }: fixed texts, nothing of the request */;
  else /* 500 with a fixed text of your own: log it; never show e.message */;
}
```

`createSignService` takes the key only from the keystore and password file, and refuses a keystore that holds the run
wallet's key (the copy's owner; before `set-signer` Core would trust it, so both signer checks alone would pass). It
reads the copy from the real run's records as ONE object: the deployment file the anchor (`lib/anchor.js`) validated
on chain (the Registry, FeeRouter, CreateDeployer, Core and Tools are the contracts the wallet's first five
transactions created; of these the Registry's owner is read and must be the wallet; the start nonce and block are
non-negative integers), and every lookup after that (Registry, Core, Tools, presets) uses that object;
`preset-registration.json`, `tax-template.json` and the three `ops/` records must carry exactly its run (endpoint,
chain, block-1 hash, wallet, Registry). The preset is proven by the run's recorded registration transaction: it must
be an `upsertPreset` call from the wallet to that Registry, writing the expected preset id, and the Registry's
`getPreset` must equal the written tuple in all 15 fields (and be open). The template is the contract the run's
recorded deployment created, and the tax launch's receipt shows the tax preset created by the wallet on that Core
with a ForwardVault cloning that template. Every quote coin must answer `decimals()` = 18. The schemas must hold every
field the signer sets (for `tax`: founder, the two rates, the four shares, `minShare`, the vault type and its
parameters; for `preset`: the two fees), and each kind's values go only to their module (the preset's fees to Trade,
the tax settings to Token). Last, **Core's signer must be this key** (after the scripted launches the copy's owner
runs `pile.js set-signer --keystore` with this key's keystore). The raise bounds are parsed once here: two decimal
strings above zero, the lower first, or the start stops (`CONFIG`). Every step of the start, the key's loading, the
records' addresses and the endpoint's construction included, runs inside its stage.

A refusal at startup is a `StartupRefused` whose message is one fixed text per stage (`STAGES` in `service.js`); no
provider, endpoint or file-system message passes through:

| stage | text |
| --- | --- |
| `KEY_FILES` | the signer needs a keystore and a password file |
| `KEYSTORE` | keystore: decryption failed |
| `RUN_WALLET` | this keystore holds the run wallet's key: the service needs a key of its own |
| `RECORDS` | the run's records are missing, unreadable or not all of one run and copy |
| `CHAIN` | the endpoint is not the chain the run was made on, or did not answer |
| `ANCHOR` | the deployment is not confirmed on chain as this run's copy |
| `ANCHOR_UNSURE` | the deployment could not be confirmed now (a lookup failed or found no receipt): try again |
| `PRESET` | the Registry's preset is not the one this run's recorded upsertPreset transaction wrote |
| `TEMPLATE` | the template is not the one this run deployed |
| `TAX_LAUNCH` | the tax preset or template is not the one of this run's tax launch |
| `TAX_RULES` | the rules template is not the one this run deployed and launched with |
| `TAX_RULES_RECORDS` | taxRules: true needs the rules launch's three records: finish scripts/rules-run.sh first, or start without taxRules |
| `QUOTES` | every quote coin must be a contract on this chain with decimals() = 18 |
| `CONFIG` | the presets are not open, or their schemas lack a field the signer sets, or the settings are invalid |
| `CORE_SIGNER` | Core's signer is not this key: the copy's owner runs pile.js set-signer with this key's address first |

The service's clock is its own (`Date.now()`); `sign` takes the request body and nothing else. A test clock can only
be given when the service is constructed (`testClock`, used by the rehearsal); the host passes none.

### The tax-rules kind (SH-287): what a ship sets, in this order

1. On chain, from the run's folder (`scripts/rules-run.sh`, the coordinator): the rules template deployed by the run
   wallet (`pile tax-rules-template`), Core's signer back to the run wallet, the scripted rules launch
   (`pile create-tax-rules`), Core's signer back to the service's key; the records above are written by these steps.
2. The service's new configuration: `taxRules: true` in `createSignService({...})`, and the three record files
   mounted beside the eight.
3. The release of this code. Without `taxRules: true` the service is today's (the kind is refused with `BAD_KIND`);
   with it, it starts only when the three records prove the template (`TAX_RULES`).

Set `taxRules: true` ONLY after `scripts/rules-run.sh` printed "the rules run is complete": started with it before
the records exist, the service refuses to start at all (`TAX_RULES_RECORDS`), so the two existing kinds would be down
too. The release itself is safe at any time without the option.

### What the host mounts

The service reads, at start only, exactly these eight files of the real run's `out/`, read-only, in the same
layout:

    fork-started.json   fork-deployment.json   kit-sends.jsonl
    preset-registration.json   tax-template.json
    ops/register.upsert-preset.json   ops/tax-template.json   ops/launch-tax.create.json

With `taxRules: true` (SH-287, below) three more:

    tax-rules-template.json   ops/tax-rules-template.json   ops/launch-tax-rules.create.json

Nothing else of `out/` should be mounted: not `actions/`, not the other `ops/` records, not `.lock`, not the logs.
The service writes nothing. Its keystore and password file are separate and belong to the service's own key
(`hack-foursigner` on the machine). It starts only after `pile.js set-signer` has handed Core's signer to that key.

**The `set-signer` target** comes from the service keystore itself: `pile.js set-signer --keystore <service keystore>
--password-file <its password file>` decrypts it, keeps only its address and uses that (it prints the address before
sending). The form `set-signer <0x address>` stays for a key without a keystore file there (a hardware or foreign
key). The service proves the handoff again: it decrypts its keystore and refuses to start unless Core's signer equals
that key's address. What `set-signer` itself refuses on a real run: the run wallet, and the 81 addresses of the one
public test mnemonic (`test test ... junk`) at indices 0 to 19 and 4240 to 4300 (`testKeyAddresses` in
`lib/run.js`). Any other publicly known key is NOT caught by that list; taking the target from the freshly made
service keystore is what keeps it out.

### What the host must do

- **Cap the body in bytes while reading it, BEFORE parsing:** at most **2048 bytes** (`MAX_BODY_BYTES` in
  `sign-create.js`). The largest valid request is 673 bytes (preset), 670 bytes (tax) and 724 bytes (tax-rules) as
  `JSON.stringify` writes it (measured in `sign/test/sign.test.js`: every field at its longest, an `ipfs://` URI
  whose 193 other characters all need escapes), so 2048 is 2.8 times the largest. A longer body is refused (413)
  without being parsed.
- **JSON only:** accept `Content-Type: application/json`, parse with `JSON.parse`, and hand `sign` the parsed value.
  Nothing else (no form decoding, no objects built by other code: those could carry getters or prototypes).
- With the cap in place, `sign` does no unbounded work: on a body of at most 2048 bytes it lists at most that many
  keys, runs fixed regular expressions without backtracking on strings it has length-checked or that are at most that
  long, and then does one encoding, one hash and one signature. It makes no network call per request.
- The rate limit (per creator address and per IP, plus a daily cap) and the logs are the host's; log the code of a
  refusal, never the body or `e.message` of a 500.

## The call (lane h)

POST a JSON body, one of:

```json
{ "kind": "preset", "creator": "0xVisitor", "name": "My Pile", "symbol": "PILE", "tokenUri": "",
  "quote": "0x8608…", "raiseAmount": "1", "buyFeeBps": 100, "sellFeeBps": 100 }

{ "kind": "tax", "creator": "0xVisitor", "name": "My Tax Pile", "symbol": "TPILE", "tokenUri": "",
  "quote": "0xae13…", "raiseAmount": "0.3", "taxBuyBps": 300, "taxSellBps": 300 }
```

- `preset`: our Pile Bonding preset; `buyFeeBps`, `sellFeeBps` go into the holders' pile on every curve trade.
- `tax`: OpenFour's Bonding Tax V1; its tax goes (100%) through ForwardVault into our PileTaxVault template and into
  the holders' pile, on the curve and after graduation.
- `creator` must be the wallet that will send the transaction: the signature is bound to it.
- `tax-rules` (SH-287; only when the service runs with `taxRules: true`, else `BAD_KIND`): the `tax` body plus
  `"creatorBps": 2000, "pileBps": 5000, "burnBps": 3000` (JSON integers, 0 to 10000 each, summing to 10000). The
  tax goes through ForwardVault into our RulesTaxVault template, whose splitter shares it: the creator part paid to
  `creator` (never another address), the pile part into the holders' pile, the buy-and-burn part buying the token on
  PancakeSwap after its migration and sending it to the dead address. The rules are inside the signed createArgs:
  final before the token exists. After `createToken`, anyone calls the clone's `createRules()` (event
  `RulesCreated(token, splitter, pile, asset, creator, creatorBps, pileBps, burnBps)`; the clone is
  `ForwardVault(token.founder()).clonedVault()`), and later the splitter's `distribute()`. ABIs:
  `abi/RulesTaxVault.json`, `abi/RuleSplitter.json`.
- `tokenUri` is optional.

The answer:

```json
{ "createArgs": "0x…", "signature": "0x…", "requestId": "…", "validUntil": 1764100000,
  "kind": "preset", "presetId": "1778027700001", "quote": "0x…", "creator": "0xVisitor" }
```

Then, from the visitor's wallet: `Core.createToken(createArgs, signature)` with no value (simulate it first; for
`tax`, give it a gas limit of 12,000,000: the tax token's creation runs code an estimate can undercount). Core's
address is in the real run's `out/fork-deployment.json` (`addresses.core`) and `abi/OpenFourCore.json`. The new
token is in the `TokenCreated` event. Each signature is good for one creation, by that creator, for 10 minutes.

What is fixed and not up to the request: supply 1,000,000,000 tokens, of which 800,000,000 are sold on the curve; no
creation fee, no presale, no anti-sniper, no partner; for `tax` the founder share of 100% to our template and nothing
to holders, burn or liquidity.

## Errors (HTTP 400: `{ "error": <code>, "message": <text> }`)

| code | message |
| --- | --- |
| `BAD_BODY` | the request must be a JSON object |
| `UNKNOWN_FIELD` | the request has a field that is not allowed |
| `BAD_KIND` | kind must be preset or tax, or tax-rules where it is offered |
| `BAD_CREATOR` | creator must be a wallet address |
| `BAD_NAME` | name: 1 to 32 letters, digits, spaces, dots or dashes |
| `BAD_SYMBOL` | symbol: 1 to 10 capital letters or digits |
| `BAD_URI` | tokenUri: empty, or https:// or ipfs:// and at most 200 characters |
| `BAD_QUOTE` | quote is not one of the allowed coins |
| `BAD_RAISE` | raiseAmount: a decimal number within the allowed range |
| `BAD_PRESET_FEES` | buyFeeBps and sellFeeBps: whole numbers from 0 to 1000, not both 0 |
| `BAD_TAX_FEES` | taxBuyBps: a whole number from 0 to 1000; taxSellBps: a whole number from 100 to 1000 |
| `BAD_RULES` | creatorBps, pileBps and burnBps: whole numbers from 0 to 10000 that sum to 10000 |

Core's own refusals when the visitor sends: `CoreErrRequestAlreadyUsed()` (the signature was used),
`CoreErrRequestExpired()` (older than 10 minutes), `SignatureVerifier: invalid signature` (sent by another wallet
than `creator`, or signed by a key that is no longer Core's signer).

## If the key is stolen

It can authorise creations, outside the service's bounds, on any Core on chain 97 that trusts it: our copy's Core
(any preset registered there, within that preset's own validator), and any other Core whose owner chose to trust this
address (nothing stops another owner from doing so), by whoever then sends them. It
moves nobody's funds: it holds none, and the signer role shown in Core's ABI only gates creation. The copy's owner
replaces it with `Core.setSigner`.

## Tests

- `node --test sign/test/sign.test.js`: the signature checked against Core's digest computed in the test itself (and
  refused for another creator or chain); unequal tax rates, so a swap of buy and sell fails; every refusal with its
  literal text, through `check()` and through `signCreate()`; every bound at and past its edge (longest name, symbol
  and URI, 19 decimals); each kind's values only in its own module; the startup's schema check (`minShare` and the
  others missing) and preset check (each of the 15 fields changed, another id, another call); the body cap.
- `test/SignCreate.fork.test.js` (in `scripts/test-local.sh`): on a fork, the owner hands Core's signer to a fresh
  key; a visitor creates both kinds with its signatures; a replay (`CoreErrRequestAlreadyUsed`), an expired request
  (`CoreErrRequestExpired`), another sender and the previous signer's signature are refused; a 6-decimal quote coin
  is refused when the configuration loads.
- `scripts/service-proof.js` (in the rehearsal, `scripts/rehearse-local.sh`): the production factory from the
  rehearsal's records with a test clock; `sign(body, 1)` still signs with that clock; a visitor creates; and each
  startup refusal with its exact text: a wrong password, the run wallet's keystore, a preset record of another
  Registry, a foreign template, the registration record pointing at another Registry transaction, the registration
  record naming another preset, Core and Tools swapped.
