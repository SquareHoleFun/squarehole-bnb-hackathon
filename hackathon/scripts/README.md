# hackathon/scripts

## judge-walk.mjs: the judge's walk (SH-274)

The BNB Chain testnet site driven the way a first-time judge would: Chromium opens the site, accepts the notice,
connects a browser wallet in the site's own wallet window and then uses the site's own controls. The wallet is
injected (an EIP-6963 announcement and `window.ethereum`), and every request it gets is answered by the script:

- reads go to the chain's endpoint unchanged;
- `eth_requestAccounts` answers the walk's one account; `wallet_switchEthereumChain` to 0x61 answers null; message
  signatures are refused;
- `eth_sendTransaction` is checked (from the walk's account, chain 97, a destination, hex quantities), printed, and then
  signed and sent by `cast send --async` with exactly the request's fields. The script never holds a key: in live mode
  cast reads the keystore; in fork mode the fork sends from its first unlocked account.

Every send is logged with its hash; its receipt is read from the chain by the script, whatever the page says.

The steps: (1) open, accept, connect; (2) test coins: the drip and the swaps to tNVDA and tUSDC; (3) GPU Poor: buy, then
sell half; (4) Rent Free: buy; (5) Card Shop: buy CARD, pick the cheapest card, read its owner back; (6) launch a box
with the Visual form's defaults (fork mode, or live with `--create`); (7) disconnect and connect again: nothing sent.

```
# The proof: an anvil fork of chain 97 and a local BNB build reading it (and an index on the fork):
node hackathon/scripts/judge-walk.mjs --fork http://127.0.0.1:<port> --site http://localhost:<port> --index http://127.0.0.1:<port> --out <dir>

# The live site (test coins only, a fresh test wallet holding test BNB):
node hackathon/scripts/judge-walk.mjs --live <https origin> --account <keystore name> --password-file <file> [--create] --out <dir>

# A dry live run: checks both endpoints answer chain 97 and the gas price, lists the steps, sends nothing.
node hackathon/scripts/judge-walk.mjs --live <https origin> --out <dir>
```

Live mode is refused unless both public endpoints answer chain 97 and the gas price is at most 0.5 gwei. The walk
stops at the first step that does not end as expected and says what to look at; a rerun recognises from the chain what
an earlier run already did (a drip inside its day, a coin already held, a card already big enough to pick) and does not
send it again. Each step leaves a screenshot before and after in `--out`, and `walk.json` holds every row and send.
