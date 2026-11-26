# The alpha's sign-in and "Set me up" on the hackathon site (SH-275): the operator's steps

What it is: the test site's two alpha services (`infra/server/services/alpha-api.mjs`, `alpha-sender.mjs`) in their
chain-97 mode, as an addition to the stack (`hackathon/stack/alpha.compose.yaml`) behind one switch, `SH_BNB_ALPHA` in
`<ETC>/stack.env`. With 0 (the default) the stack and the site are exactly as without it. With 1:

- `alpha-api` at `https://<host>/alpha/`: a visitor signs in with X through the site's Privy app; a NEW sign-up is
  approved at once (up to `SH_ALPHA_SIGNUP_CAP`, default 100 sign-ups in all); there is no desk (`/desk` and
  `/desk/api/*` answer 404); 100 claims a day are accepted, the 101st gets "daily claim cap reached" until the next
  UTC day.
- `alpha-sender`: pays each accepted claim 0.015 tBNB from its own wallet, at most 100 a day, after twelve confirmations
  each; no admission step (chain 97's test coin faucet is open). Fixed in code (`infra/server/services/alpha/chains.mjs`,
  `sender/chain.mjs`): nothing in a settings file raises them.
- The join page at `https://<host>/join/` (built by the site, lane m), no page lock: the site stays open to everyone.

`<ETC>` and `<SRV>` are the stack's settings and deployment folders (`hackathon/runbooks/machine.md`); every command runs
as the stack's user (uid 1000). The host name in `stack.env` must be lower case (the API checks its origin that way).

## 1. The Privy app (done on 25 November)

- App id (public): `cmwwb2y9p00gv0gl9m9im0uve`. Login by X only, identity tokens on, no wallet at login, allowed origin
  exactly `https://<SH_BNB_HOST>`.
- The keys line. The API checks each identity token offline against the app's public keys, so it needs them as one
  settings line. Save the app's key set, `https://auth.privy.io/api/v1/apps/<app id>/jwks.json`, to a file, then

      node infra/server/services/alpha/privy-keys.mjs <saved jwks.json>

  prints `SH_ALPHA_PRIVY_VERIFICATION_KEY=<line>`. How the line is made: every key of the set must be an EC P-256 key
  (`kty` EC, `crv` P-256, no private part `d`, `alg` ES256 or absent, `use` sig or absent; 1 to 4 keys); each becomes
  its SPKI public key in PEM form (`-----BEGIN PUBLIC KEY-----` ... `-----END PUBLIC KEY-----`); the PEMs are joined
  by line ends, and every line end is written as the two characters `\n`, so the whole set is one line without quotes.
  The script then checks the result with the API's own reader (distinct P-256 keys, at most four). No network, no
  secret. A key rotation at Privy: make the line again, put it in `alpha-api.env`, restart `alpha-api` (step 6).

## 2. The settings files (once)

    install -m 0600 <SRV>/current/hackathon/stack/alpha-api.env.example <ETC>/alpha-api.env
    install -m 0600 <SRV>/current/hackathon/stack/alpha-sender.env.example <ETC>/alpha-sender.env
    install -d -m 0700 <ETC>/alpha-sender

- `alpha-api.env`: the app id is filled in; replace the `SH_ALPHA_PRIVY_VERIFICATION_KEY` placeholder with the line of
  step 1 (everything after `=`); `SH_ALPHA_ENABLED=1`. Compose sets the rest itself: chain 97, automatic approval, the
  origin `https://<SH_BNB_HOST>`, the cookie key's place.
- `alpha-sender.env`: the sender's address (`0xF7A6383a473747B6Cf80b331E204e7e273191A4d`, keystore `hack-sender`), the
  RPC (publicnode, as the keeper) and chain 97's test coin are filled in. Leave `SH_SERVICE_ENABLED=0` for now.

## 3. The cookie key: nothing to do

The API signs its session cookies with a 32-byte key. It is made on the first start by the one-shot `alpha-folders`
(32 random bytes, 64 hex digits, root only, 0600) inside the volume `alpha_config`, and never printed or copied out.
To renew it (everyone is signed out): stop the stack's alpha services and remove that volume
(`docker volume rm squarehole-bnb_alpha_config`); the next start makes a new one.

## 4. The sender's key (after a ship of a release that has `hackathon/stack/sender-key.sh`)

    SH_BNB_ETC=<ETC> bash <SRV>/current/hackathon/stack/sender-key.sh <keystore file of hack-sender> <password file>

As `keeper-key.sh`: decrypts in a throwaway container of the shipped keeper image (no network, read-only, no
capabilities, uid 1000), checks the key belongs to `SH_ALPHA_DESK_ADDRESS` of `alpha-sender.env`, writes
`<ETC>/alpha-sender/desk.key` (0400, uid 1000, 67 bytes) by a rename, prints only the address. Keystore and password
file outside `<SRV>` and outside any checkout.

## 5. The float

0.015 tBNB per claim plus its gas (a plain transfer, 21,000 gas at about 0.1 gwei: 0.0000021 tBNB): a full day of 100
claims is about 1.5002 tBNB. The sender waits (the person sees "waiting") while its balance is below one claim's
starter and gas; it reports a low float below 0.075 tBNB, five starters (`SH_ALPHA_LOW_FLOAT_WEI` changes that alert
only).

## 6. Switching it on

1. `SH_BNB_ALPHA=1` in `<ETC>/stack.env`, then the next ship (`ship.sh <commit>`): the ship checks the two settings
   files and the key folder, adds `alpha.compose.yaml`, and starts `alpha-api` and `alpha-sender` at promotion (never
   in the candidate). The site build must carry the Privy app id (lane m's build setting) for the join page to sign in.
2. Check: `curl -s https://<host>/alpha/health` answers `{"ok":true}`; `/alpha/intake` answers `{"open":true,...}`;
   `/desk/api/signups` answers 404; `docker ps` shows `alpha-api` and `alpha-sender` healthy.
3. The sender live, when the wallet is funded and `desk.key` is in place: in `alpha-sender.env` set
   `SH_SERVICE_ENABLED=1` and `SH_SERVICE_MODE=live`, then recreate only the sender:

       cd <SRV>/current/hackathon/stack && SH_RELEASE=$(basename "$(readlink -f <SRV>/current)") docker compose \
         --project-name squarehole-bnb --env-file <ETC>/stack.env --env-file <SRV>/current/.derived.env \
         --file compose.yaml --file alpha.compose.yaml --profile alpha up --detach alpha-sender

   Its log says `alpha-sender: live`, then one line a cycle (`queue=… dayCount=… floatWei=… lastError=…`). Dry-run
   (`SH_SERVICE_MODE=dry-run`) signs nothing and answers each claim "dry run", after which the person may claim again:
   use it only before visitors come. The same command with `alpha-api` restarts the API after a settings change.

Off: `SH_BNB_ALPHA=0` and a ship: the two services are removed with the other orphans; their volumes (sign-ups,
claims, the sender's journal, the cookie key) stay.

## What the operator never does

Print, copy or paste a key or the cookie key; put the sender's keystore or password inside a release or a checkout;
raise the starter, the daily cap or the confirmations (they are code).
