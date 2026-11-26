# M1 feed acceptance tests (SH-005 / SH-006 / SH-007)

Spec-derived Playwright tests for the M1 feed, written by QA **without seeing the implementation**. They are an
independent oracle: expectations come only from the handoff documents, the accepted ADRs, the SH-002/003/004/008
evidence and the fixture `square-hole-handoff/fixtures/feed.json` (served byte-for-byte by the mock provider).

- **Sources:** `00-DECISIONS`, `01-PRODUCT`, `02-DESIGN`, `03-FEED-AND-DATA`, `04-EXTERNAL-TRADING`,
  `08-SECURITY-AND-TESTS`, `design/REFERENCE_OVERRIDES.md`, ADR-0003 (incl. "Semantics fixed before M1"),
  ADR-0004/0005/0007, `docs/evidence/SH-002/003/004/008.md`, plus the **shared UI contract** given to both the
  implementer and QA (roles, names, URL parameters, `data-pair-id`, state texts).
- **Not used:** `@squarehole/domain` (`selectFeed`, `matchSearch`, formatters). `expected.ts` re-derives the orders
  with exact bigint decimal comparison, so a bug in those helpers is caught here too.

## Running
```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
E2E_PORT=5449 pnpm --filter @squarehole/web exec playwright test e2e/acceptance
```
Use any free port (never 4173/5173; on the authoring machine 5432 is held by PostgreSQL, so `vite preview
--strictPort` cannot bind it). Both projects from `apps/web/playwright.config.ts` run: `desktop` (1440×900) and
`mobile` (Pixel 7, 390×844). Tests that only make sense at one width skip themselves in the other project. Because
`testDir` is `./e2e`, a plain `pnpm e2e` also runs this suite, so it stays red until the M1 feed lands.

## Validation of the tests themselves
- **Against the M0 placeholder feed** (commit `2569874`): 152 failed, 22 passed, 4 skipped. Every failure is a missing
  contract element (no "Launched pairs" container, pin region, count status, state headings/alert; a header searchbox
  still exists off the feed). The 22 passes are the 6 oracle checks and the 16 "no trading surface / no wallet
  request" scans, which the placeholder already satisfies.
- **Against a throwaway contract stub** (server-rendered, scratch only, not committed): 174 passed, 4 skipped. This
  exercised the parts the placeholder never reaches (scroll restore, fake clock, accessible-text parsing, regexes)
  and found one test-side bug (`rowIds` threw during a navigation instead of letting `expect.poll` retry; fixed).
- **Mutation check** (desktop project, one injected contract violation at a time): each of 12 was caught — tie order
  swapped, `$0` for null, platform inside the results, wallet request on load, ages from `Date.now()`, "#1" on the
  pin, typing pushes history, stale notice without time, nulls sorted first, missing "Not a search match", pin
  counted, unknown reward address passed through.

## Oracle cross-check
`expected.ts` was compared with `square-hole-handoff/reference/feed_model.py` (Python 3.11.13) over a grid of
3 sorts × 18 searches × 3 types × 5 reward filters × 4 lifecycles × 4 scenario datasets (default, stale, partial,
ranking-updated) = **12,960 cases: 0 differences**. `feed_model.select` has no lifecycle or own-token filter, so those
were applied as post-filters on the reference output (filters do not change relative order). Scenario datasets
follow SH-004: stale = launches at or before `asOf − 2h`; partial = curve-stage turnover `null`; ranking-updated =
top two market caps swapped. The literal orders in `VERIFIED_ORDERS` come from that run, and `oracle.spec.ts`
asserts the module still reproduces them.

## Test → requirement map
| File › test | Requirement IDs | What it asserts |
|---|---|---|
| `oracle.spec.ts` (3) | FEED-02, FEED-03, FEED-06 | Oracle reproduces the Python-verified orders; SOFT CORNERS / WRONG ANGLE is a real tie; decimal, age and USD helpers. No browser. |
| `feed-order` › default order | FEED-02 | Market cap desc `66…70`; tie → pairId asc (6b before 6c); NO PRICE YET last with "Not available", never `$0`; "11 pairs"; Market cap radio checked. |
| `feed-order` › default sort omitted | FEED-02, FEED-05 | Choosing Market cap removes `sort` from the URL. |
| `feed-order` › New / Turnover (+ direct URL) | FEED-03 | New = launchedAt desc (unpriced included, first); Turnover desc with null last; `?sort=new|turnover`. |
| `feed-pin` › pinned once | FEED-01, UI-02 | One "Platform pin" region, heading "Square Hole", "Platform" label, "Ticker not set", no `UNSET-DEMO`/`HOLE`/`#1`/rank/crown; pin precedes and is outside "Launched pairs"; not a row; not counted. |
| `feed-pin` › searching "orch" | FEED-01, FEED-04 | Pin stays, "Not a search match", 2 rows, "2 pairs". |
| `feed-pin` › 7 filter/search cases | FEED-01 | Label appears exactly when the platform fails the query (type, lifecycle, reward T/AAPLx vs USDC, name, quote address); the pin is never inserted into results even when it matches. |
| `feed-pin` › collapse remembered | 03-FEED "collapsing it is a remembered local preference" | Hide/Show button names + `aria-expanded`, survives reload both ways. |
| `feed-pin` › localStorage throws | Contract (storage in try/catch) | Feed renders and the toggle works with a throwing `localStorage` accessor; no uncaught error. |
| `feed-pin` › root_unlaunched | 01-PRODUCT root card, ADR-0003 | "Coming soon", no `$`, no metric words, no trade/venue CTA, organic rows unchanged. |
| `feed-pin` › accent integration | UI-07, SH-008 notes | No wizard accent on the feed, at most one pin accent, never inside a link/button; no nested controls in the pin. |
| `feed-search-filters` › controls contract | FEED-04, 02-DESIGN | Single `type=search` searchbox; 3 sort radios, 3 type radios; Rewards options `Any reward`, `Own token (T)`, `AAPLx-DEMO`, `USDC-DEMO` (values `''`, `T`, lowercase addresses); Lifecycle options; DOM order pin → search → results; no "Load more" (11 < 20). |
| `feed-search-filters` › one search controller | UI-02 (two search bars), 02-DESIGN | No searchbox off the feed; top-bar "Search pairs" trigger navigates to `/` and focuses the input; `/` shortcut on `/` and on another route. |
| `feed-search-filters` › typing | FEED-04, FEED-05 | `?q=` within 2 s, other params kept, history **replaced** (Back leaves the feed). |
| `feed-search-filters` › 10 search cases | FEED-04 | Name substring (any case, trimmed), symbol-only, exact T address in mixed case, Q address → all 5 AAPLx-DEMO pairs, mixed-case USDC address, pair-id address, mirror address, partial address → no match ("No pairs match" + "Clear search"). Row order and count each time. |
| `feed-search-filters` › Clear search | FEED-04, 02-DESIGN empty search | Clears input and `q`, keeps the sort, restores rows. |
| `feed-search-filters` › 12 combined cases | FEED-04 | Search × type × reward (T / address) × lifecycle × sort from the URL: rows, count and every control state. Includes `graduating` (0 rows). |
| `feed-search-filters` › through the controls | FEED-04 | Same combination built by clicking/selecting/typing; final URL has exactly the five parameters. |
| `feed-url` › reload | FEED-05 | All five parameters and results survive reload. |
| `feed-url` › Back/Forward | FEED-05 | Each sort/filter change is a history entry; Back ×4 and Forward ×2 restore controls, rows and counts. |
| `feed-url` › scroll restore | FEED-05, 03-FEED "Back/forward restores scroll and query" | At 600 px height, scroll to the end, open ORCHARD, Back: URL, controls, rows and scroll offset (±24 px). |
| `feed-url` › 8 hostile URLs | FEED-05, contract (invalid values ignored) | `__proto__`/`constructor`/`bogus`/empty values, unknown params, bad scenario, a real non-reward address and a malformed address all render the default feed with no alert, page error or console error. |
| `feed-rows` › row content | Contract rows, FEED-06, FEED-09, C14, ADR-0003 | For all 11 rows: name, symbol (besides name), asset type, pairing symbol (besides the reward text), "Holders earn <asset>", market cap and turnover as honest USD (`$600K` or `$600,000`), "—" + "Not available" when null, no `$0`, age from snapshot `asOf` with the wall clock set to 2031, "Route unverified" not a control; ORCHARD "Showcase concept · not deployed"; no rank/trend/7D column, no crown. |
| `feed-rows` › row links | FEED-08, ADR-0003 routes | Link name starts with the pair name, `href` = `/pair/31337/<lowercase address>`, every row link is its own route; click navigates. |
| `feed-rows` › 5 scenario scans | FEED-09, UI-04, FEED-10 | No Demo badge or word in the top bar (F130 supersedes UI-04's Demo label); no "verified"/check marks on rows; no non-http(s) links; any link carrying a fixture address is an app `/pair/` route; no APY/APR, guarantee, `%`, "sustainable growth", "organic volume", "7D". |
| `feed-rows` › unpriced | FEED-06 | NO PRICE YET: two "Not available", "—", never `$0`. |
| `feed-rows` › partial | FEED-06 | "Partial coverage", no Demo word (F130), curve turnover unavailable (not `$0`), Turnover order puts the 6 nulls last. |
| `feed-rows` › stale | FEED-06 | "Stale data" with the 10:00 UTC as-of time in one notice; 8 rows (launches after 10:00 absent). Runs with `timezoneId: 'UTC'`. |
| `feed-states` › loading | 02-DESIGN loading skeleton | `aria-busy="true"` stays; no rows, no empty heading, no alert, no "0 pairs". |
| `feed-states` › no_launches | 02-DESIGN no launches | "No launches yet", 0 rows, "0 pairs", pin still there. |
| `feed-states` › unavailable | 02-DESIGN failed RPC, FEED-06 | `role=alert` "Feed unavailable" + "Try again"; no rows, no empty-state heading, no count; retry keeps the honest state. |
| `feed-states` › ranking_updated | 03-FEED "Ranking updated", FEED-05, FEED-08 | Button appears (clock advanced ≤ 5 simulated min + focus/visibility events); rows unchanged until pressed; then ROUND TRIP above ORCHARD, button gone, "11 pairs". |
| `feed-safety` › load | UI-09, EXT-04 | Fake EIP-1193 + EIP-6963 provider records zero calls; no dialogs. |
| `feed-safety` › browse flow | FEED-08, EXT-04 | Search, sorts, type/reward/lifecycle filters, open ORCHARD, Back: zero `request`/`enable`/`send` calls. |
| `feed-safety` › 8 scenarios | UI-01, EXT-01, UI-09 | No control named/labelled buy/sell/swap/amount, no number input, iframe/object/embed or dialog; zero wallet calls. |
| `feed-safety` › pair route | UI-01 | Same scan on a detail route reached from a row. |
| `feed-layout` › UI-05 (desktop) | UI-05 | 1440×900, reduced motion: pin and the first six rows fully inside the viewport; no overflow. |
| `feed-layout` › desktop table | 02-DESIGN semantic tables | Results are a `table` named "Launched pairs" with column headers. |
| `feed-layout` › UI-06 390×844 and 360×800 (mobile) | UI-06, 02-DESIGN mobile | No horizontal overflow on `/`, root_unlaunched, an address search and a 120-char search; list (not table) named "Launched pairs"; banner 56–64 px; cards ≥ viewport − 48 px wide; searchbox visible. |

## Interpretations recorded (contract gaps)
- **Zero count:** the count status reads "0 pairs" for an empty search/filter and for `no_launches` (the contract's
  "`<n> pairs`" with n = 0). While loading or unavailable, no count is claimed.
- **Unknown reward address:** a well-formed address that is not a reward-filter option (e.g. WETH-DEMO, which only
  backs R=T pairs) is "unknown" and ignored, so the select and the results agree.
- **Ranking check timing:** not specified; the test tolerates any interval up to 5 simulated minutes or a
  focus/visibility trigger.
- **Mobile filter disclosure:** not in the contract; if the sort group is hidden, `revealControls` opens a button named
  like "Filters" before interacting. No assertion is relaxed.
- **Accessible text:** "Not available" may be an `aria-label` or visually hidden text; `helpers.accessibleText` accepts
  both and ignores `aria-hidden` content.
- **USD rendering:** compact (`$84.2K`, `$84K`) or full (`$84,200`) is accepted as long as it is the fixture value
  truncated, never rounded up, and never `$0`.
- **Pairing vs reward:** the row must show the pairing asset symbol in addition to the "Holders earn …" text, so an
  R=Q row names its quote twice (e.g. pairing "AAPLx-DEMO" and "Holders earn AAPLx-DEMO"). Likewise the symbol must
  appear apart from the name ("NEW" for NEW SHAPE).
- **Search shortcut off the feed:** "/" on another route behaves like the trigger button (navigate to `/`, focus).
- **Table vs list:** a `table` at 1440 px and a `list` (no visible table) at 390/360 px, as the contract states.
- **Existing `shell.spec.ts`:** several SH-003 tests assume the old header search input (`searchbox` on every route,
  Enter → `?q=`, the "Search “…”" chip, `.sh-search` measurements). They contradict the shared contract and are the
  implementer's to update; this suite does not touch them.
