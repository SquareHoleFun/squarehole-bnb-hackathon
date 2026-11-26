# Exit Liquidity: traits for the unique proposal

The signs are the cast. There are no people, faces, mascots or safety-standard figures. The world is still
a hallway at night with no working exit. All traits are cosmetic; they change no fees, claims or rights.

The base `sign` is exactly `variantFor(id)` from `../assign.mjs`. Values 01–08 have 34 signs each;
09–12 have 33 each. Id 404 is still sign 08. The other five layers each contain four values at 101 signs
per value. Every layer sums to **404**. Counts and ids are decimal strings in data and bigint in count logic.

| Trait | Value | Meaning | Signs |
| --- | --- | --- | ---: |
| Original sign | `01` | Exit? | 34 |
| Original sign | `02` | Not found | 34 |
| Original sign | `03` | No exit | 34 |
| Original sign | `04` | Both ways | 34 |
| Original sign | `05` | Burnt out | 34 |
| Original sign | `06` | Backwards | 34 |
| Original sign | `07` | Down | 34 |
| Original sign | `08` | 404 | 34 |
| Original sign | `09` | Up | 33 |
| Original sign | `10` | Loop | 33 |
| Original sign | `11` | Error | 33 |
| Original sign | `12` | Try again | 33 |
| Housing | `plain` | Plain rim | 101 |
| Housing | `visor` | Rain visor indoors | 101 |
| Housing | `guards` | Corner guards | 101 |
| Housing | `fins` | Cooling fins | 101 |
| Route plate | `dogleg` | One more corner | 101 |
| Route plate | `switchback` | Long way round | 101 |
| Route plate | `fork` | Two wrong turns | 101 |
| Route plate | `coil` | Back to the start | 101 |
| Repair | `clean` | Still under inspection | 101 |
| Repair | `patch` | Spare plate | 101 |
| Repair | `staples` | Held together | 101 |
| Repair | `tape` | Temporary forever | 101 |
| Hallway equipment | `reel` | Cable to nowhere | 101 |
| Hallway equipment | `case` | Locked spare exit | 101 |
| Hallway equipment | `lamp` | Backup light | 101 |
| Hallway equipment | `tray` | Empty claim tray | 101 |
| Power feed | `left` | Left elbow | 101 |
| Power feed | `right` | Right elbow | 101 |
| Power feed | `twin` | Double feed | 101 |
| Power feed | `loop` | Service loop | 101 |

## Physical meaning

- **Housing:** the plain slate/rim housing, an indoor rain visor, oversized corner guards, or cooling fins.
  The visor and fins change the side silhouette and depth; guards wrap the corners.
- **Route plate:** a dogleg, switchback, fork or coiled path on a separate 128 × 80 px wall plate,
  below the signs and left of the doors and equipment. Its paper-coloured bars and arrow add no words or
  numerals. The plate never sits on a sign face. All four original values and counts are retained.
- **Repair:** a clean inspected rim, a bolted spare plate, two paper-coloured staples, or broad corner tape.
  Repairs and corner guards sit outside the sign face, preserving the lettering and its clear space.
- **Equipment:** a cable reel, locked case, backup lamp or empty claim tray. These borrow the hallway's hardware,
  padlock and tray vocabulary. They are not quantities of USDC, fee forecasts or actual claim states.
- **Conduit:** a left elbow, right elbow, double feed or service loop. Each connects to a junction box.
  Cables and junctions are physical geometry, so identity does not depend on a background recolour.

Every value changes both pixels and geometry. `lib/scene.mjs` is the shared form description, in the original
1024 px coordinate space. There are no id-dependent marks, arbitrary noise, hidden seeds or token numbers
inside either asset. Images and models rebuild from the six traits alone.

## Keeping the twelve original signs

| Base | Features retained in both formats |
| --- | --- |
| 01 Exit? | Green LED `EXIT?`, bracket, tiny arched door |
| 02 Not found | Red LED `NOT` / `FOUND`, ceiling rods |
| 03 No exit | Red block `NO EXIT`, bracket, brick wall |
| 04 Both ways | Amber LED `EXIT` / `← →`, flag arm |
| 05 Burnt out | Green LED `E·IT`: original X cells unlit, one red fault dot, painted door |
| 06 Backwards | Mint block `EXIT` mirrored exactly (visually `TIXƎ`), rods |
| 07 Down | Green LED `EXIT ↓`, rods, bolted lower hatch |
| 08 404 | Green light box with original heavy `404` numerals, rods, bricked doorway |
| 09 Up | Mint LED `EXIT ↑`, rods, bolted upper hatch |
| 10 Loop | Two green LED signs, `EXIT →` and `← EXIT` |
| 11 Error | Red LED `ERROR` tilted nine degrees about the original pivot, broken chain |
| 12 Try again | Amber block `TRY` / `AGAIN`, rods |

The af1 correction supersedes the earlier no-lettering interpretation: **no new words, numbers, names or
claims beyond the kit's own sign lettering**. The picture calls `../src/sign.mjs` with the original variant
records: letters, arrows, module size, placement, colours, LED substrate/glow, mirror and tilt come directly
from the kit. Every generated face is checked against its shipped original PNG, including clear space.
The parent assignment and storybook are unchanged.

Models use the same `signBox` glyph cells as raised hexagonal LEDs or merged rectangular block bars.
Burnt cells are absent and the single red dot stays in its original cell. Model letters retain the same
size, position, colour and tilt; unlit substrate dots and soft glow remain 2D details. The compact raised
LEDs keep all 404 models within the original geometry and byte limits. 2D remains the founder's default;
the 3D samples are for comparison.

## Deterministic dealing and proof

The one fixed public seed is `exit-liquidity/404-signs/no-way-out/v1`. For each added layer, build its exact
count deck, rank its positions by SHA-256 of `seed + NUL + layer + NUL + decimal index`, and sort by that
hex digest, then index for a tie. No locale sorting, clock, random API or external input is used.

A separately ranked repair order chooses partners for in-layer swaps. The score is the sum of
`max(0, 2 - trait distance)` against the other signs. A swap must strictly lower that score and leave its
partner clear of near twins. Counts never change and the base sign never moves. The finite improving search
throws if no swap exists; it never silently relaxes uniqueness. `verifyDeal` independently checks all 81,406
pairs, counts, ordered ids, allowed keys and the original assignment. Every pair differs in at least two traits.

The manifest pins the resulting 404 rows and hashes. The full check additionally proves 404 distinct decoded
1024 px pictures, 404 distinct decoded 128 px pictures, and 404 distinct mesh buffers. Hashes do not merely
differ because of names or embedded ids.

## Review selection

Start with id 404. Greedily cover missing values, then favour underrepresented values, with ties broken by
id order, until there are exactly two models per base sign. Expand to four pictures per base, preferring
maximum minimum trait distance within that base. The 24 model ids are a subset of the 48 picture ids.
Both sets cover all 32 values; no value had to be left out. The exact ids live in `manifest.json`.
