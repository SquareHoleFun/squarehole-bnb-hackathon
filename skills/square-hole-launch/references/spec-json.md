# The BoxSpec draft JSON

What the assistant hands the creator: one file, `<ticker>-boxspec-draft.json`, that `scripts/check.mjs` validates
with the factory's own check. The creator follows it step by step in the launch flow (Launch, `/create`); an
"Import BoxSpec" step is planned. The launch flow fills in what only it can compute.

## Shape

```json
{
  "format": "squarehole.boxspec-draft/1",
  "context": "v2",
  "brief": "One or two lines: what the creator asked for, in their words.",
  "site": { "links": ["https://example.org"] },
  "spec": { "...": "the 29 fields, in any order" }
}
```

- `format` and `context` are fixed: `"v2"` is every new box (version 2).
- `brief` and `site` are for people: the checker ignores the brief and only checks that each link starts with
  https:// (an X @handle is fine too). Links are not part of the spec: the creator enters them in the launch flow's
  Basics (Website, X, Telegram), and `site.links` keeps them for that. For a new collection the launch flow also puts
  the Website link on the collection page: write it as the collection-metadata add-on's `externalLink` too (or the
  creator clears it there).
- Never put a private key or recovery phrase anywhere in the file: the checker stops without repeating it (exit 4).
- Copy a worked example from [examples/](examples/README.md) and change it; that is faster and safer than starting
  from nothing. The examples' descriptions start with "Demo:" because they are the Demo boxes; drop it for a
  creator's own box (P).

## Writing values

| Kind | Write | Example |
|---|---|---|
| A choice | the value's name in quotes | `"qStream": "TO_CREATOR"` |
| The pricing asset | its short name or its address | `"q": "ETH"` |
| An amount (raise, creator buy, fee cap) | `{ "decimal": "..." }` in whole units of the pricing asset, or the raw integer as a string | `"creatorBuy": { "decimal": "0.05" }` |
| A count | a plain number | `"n": 100` |
| The opening time | 0 for Now, or a UTC time as text ending in `Z`, at most 14 days after Create (`{ "utc": "2026-10-20T18:00:00Z" }` and Unix seconds also work) | `"openAt": 0`, `"openAt": "2026-10-20T18:00:00Z"` |
| Text | a string of printable ASCII, no `"` or `\` (a ticker without a leading `$`) | `"tokenSymbol": "GUZZ"` |
| An SVG setting (`hiddenSvg`) | one line of printable ASCII; quotes are allowed, written `\"` in JSON; no line breaks or tabs; up to 4,096 characters | `"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"` |
| An address | a public `0x` address, or the marker | `"marketplaceOwner": "FROM_LAUNCH_FLOW"` |
| A fingerprint (logo, collection cover, art, banner, teasers) | the marker | `"coverSha256": "FROM_LAUNCH_FLOW"` |
| The generator hash | zero, or the marker (the launch flow writes zero) | `"generatorHash": "0x0"` |
| Zero / none | `"0x0"` for a fingerprint or an address, `"0"` for an amount | `"creatorFeeRecipient": "0x0"` |
| The trait table | the marker, the traits, or none | `{ "formatV1": { "traitTypes": [ { "name": "Fuel", "values": ["Jet"] } ] } }`, `{ "formatV1": { "traitTypes": [] } }` |
| Add-ons | a list by catalog id order, each by key with its settings | `{ "addOn": "royalties", "params": { "bps": 250, "destination": "FEE_HANDLING" } }` |
| Hidden art's tickets | the launch flow's own texts and picture, or the two texts it lets the creator change | `{ "addOn": "placeholders", "params": "FROM_LAUNCH_FLOW" }` |
| The collection page | the marker per picture, the link or `""` | `{ "addOn": "collection-metadata", "params": { "bannerSha256": "FROM_LAUNCH_FLOW", "teaserSha256s": ["FROM_LAUNCH_FLOW"], "externalLink": "https://example.org" } }` |
| A fee cap | an amount per 30 days (1, 4, 8, 16 or 32 ETH) and where the rest goes | `{ "addOn": "creator-fee-cap", "params": { "capPerEpoch": { "decimal": "4" }, "excess": "BURN" } }` |

Never write a JSON number for an amount (`"raise": 1` is refused: JSON numbers lose precision; `"raise": "1"` would
be 1 wei). The trait table repeats the description unless `formatV1` names its own. A `formatV1` table is a preview
the checker can test (16 types, 255 values, plain text); the table stored is the one the launch flow builds from the
traits file, so the marker is just as good when the traits are not settled.

## `FROM_LAUNCH_FLOW`

The marker stands for a value only the launch flow can make: the fingerprints of the logo, the collection cover, the
art, the banner and the teasers (it re-encodes each picture and salts the art), the reveal list, and the owner
address (the wallet the creator connects, or the address pasted under Your address on the Overview page). The checker
validates a draft with stand-ins for them, says which they are, and prints a
**draft hash** that only tells two drafts apart; the final spec hash appears in the launch flow. In the placeholders
add-on the marker means the launch flow's own ticket name ("<Name> ticket"), symbol ("<TICKER>-T"), texts and
neutral picture: the checker writes those exact values. In every other text the marker is refused (it would become
the text).

Where it goes:

- `coverSha256` (the logo): always. `collectionCoverSha256` (the collection cover, a separate upload) and
  `revealRoot`: every collection.
- `revealListId`: open art; hidden art writes `"0x0"` (the list stays secret).
- `metadataTable`: unless the traits are known (then `formatV1`).
- `marketplaceOwner` (a collection) and `creatorFeeRecipient` (with a creator option on a fee side, or royalties to
  the creator, which are paid to it): unless the creator gives a public address. The launch flow uses one address
  for both, so write the same one (or the marker) in each; the checker warns otherwise.
- The collection-metadata add-on's `bannerSha256` and each of its `teaserSha256s`.
- The placeholders add-on's `params` (hidden art), or its `placeholderName`, `placeholderSymbol` and `hiddenSvg`
  when the creator writes the two texts. The checker warns about own values the launch flow cannot enter.

## Just the token

A box with no NFTs writes `"boxType": "TOKEN_ONLY"` and zero in every collection field: `"collectionName": ""`,
`"collectionSymbol": ""`, `"n": 0`, `"artMode": 0`, `"revealRoot": "0x0"`, `"metadataTable": "0x"`,
`"revealListId": "0x0"`, `"marketplaceOwner": "0x0"`, `"collectionCoverSha256": "0x0"`. Its only possible add-on is
the fee cap. The logo is the token's picture (`"coverSha256": "FROM_LAUNCH_FLOW"`). See
[examples/gm-coin.json](examples/gm-coin.json).

## Fields set by the version

Write them exactly like this: `"version": 2`, `"firstId": "1"`, `"raise": { "decimal": "4.206980085" }` (the one
raise every box has), `"layout": "CURVE_V1"`, `"gradLayout": "ASK_FULL_BID_SENTINEL"`, `"launchFormat": "CURVE"`,
`"generatorHash": "0x0"` (unless the art has a published generator).

## Other files the checker reads

- The launch flow's **Download BoxSpec** file (`"format": "squarehole.boxspec/1"`): it checks the spec and that its
  `specHash` and `encoded` still match (an edited download is refused). The file's own fingerprints (the logo, the
  collection cover, banner and teasers, the reveal list and the rights record's spec hash) are where the format puts
  them, so they never count as a key.
- A bare spec in wire form (numbers for choices, raw integers as strings), and the package fixtures.

## Checking

From the skill's folder (`pnpm box-spec:check` in the folder the skill ships in takes the same arguments):

```sh
node scripts/check.mjs GUZZ-boxspec-draft.json                 # valid? hash, overview, notes
node scripts/check.mjs GUZZ-boxspec-draft.json --json          # the same for a program
node scripts/check.mjs GUZZ-boxspec-draft.json --network demo  # a Demo box: holder payouts too (pending legal review)
node scripts/check.mjs --menu                                  # every choice offered today
node scripts/check.mjs --field ticker '$GUZZ'                  # one text, every problem at once
node scripts/check.mjs --numbers --items 100 --buy 0.05 --eth-usd 2500
```

`--network` is `mainnet` by default, the factory's own check; `demo` also accepts holder payouts, which only the Demo
offers for now ("pending legal review"); `sepolia` is the testnet's: what core v1 builds there (no holder payouts yet,
and no conversion or `BURN_Q` until the swap module and S12; the menu marks them "not on Sepolia yet").
A Download BoxSpec file is checked for the network it names (its `network` key; the first line says "as the file
says") unless `--network` is given. Hand a creator who will launch on testnet or mainnet a draft that passes without
`--network demo`.

Exit codes: **0** valid · **1** refused by the factory's check · **2** usage error (arguments, no such file) ·
**3** not a readable BoxSpec (invalid JSON, a missing field, an unknown choice, a bad add-on id, an edited download)
· **4** stopped: something looks like a private key or recovery phrase (never repeated). A refusal names the field,
says why in one sentence and gives the fix; the check stops at the first refusal, so run it again after each fix (a
text with several bad characters lists them all). Problems in the JSON itself are all listed at once. A valid draft
can still print **Check first** lines. "The launch flow cannot enter this yet" (a generator hash, royalties at 0%,
an empty collection page, too many series, different addresses, own ticket names) means the creator could not
create it: change the draft. A ticker with `$` or a link without https: fix it or confirm it with the creator. A
trait table written as raw bytes, or a fingerprint written as 64 hex characters: a draft cannot know them, so write
the marker (and never paste a key there).
