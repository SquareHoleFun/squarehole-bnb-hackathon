# The 420 at mess night

This is the active unique cast for Link Marines. The joke stays the same: the General gets exactly the same ration as
the Private. Rank and Squad come directly from `../ranks.mjs`, for the same ids. None of these new traits affects
fees, ownership, allocation or box settings. The public seed is `Link Marines / mess night / same ration / proposal 1`.

`traits.json` is the machine-readable vocabulary and exact population. Counts are decimal strings; the dealer
counts with bigint. Each row below independently totals 420. “Each” applies to every listed value.

| Trait | Values | Count per value | Total |
| --- | --- | ---: | ---: |
| Rank | Private, Specialist, Corporal, Sergeant, Staff Sergeant, Master Sergeant, Sergeant Major, Lieutenant, Captain, Major, Colonel, General | 35 each | 420 |
| Squad | Every integer from 1 through 35 | 12 each | 420 |
| Face | Round, Long, Square, Pear, Broad | 84 each | 420 |
| Eyes | Dots, Wide, Happy, Sleepy, Squint, Wink | 70 each | 420 |
| Grooming | Clean, Freckles, Sideburns, Black moustache, White moustache, Single braid, Twin braids | 60 each | 420 |
| Collar | Bow tie, Napkin | 210 each | 420 |
| Mouth | Smile, Grin, Surprise, Cheer | 105 each | 420 |
| Prop | Spoon, Fork, Teacup, Bell, Salt, Menu | 70 each | 420 |
| Wall | Khaki, Crate, Paper | 140 each | 420 |

The five face silhouettes, six expressions in the eyes, seven grooming choices and two ways to dress for dinner
form exactly 5 × 6 × 7 × 2 = 420 characters. Each combination is used once. Mouth, Prop and Wall are separately
dealt exact-count decks. There is no rejection loop, weighted rounding or spare id. A character key excludes Rank,
Squad and Wall, so a new number, rank or background cannot disguise a duplicate. These traits do not change rations.

The dealer sorts the core combinations and each extra deck by labelled HMAC-SHA256 keys from the fixed seed.
Input order breaks a hash tie. Hex keys use code-unit comparison, never locale ordering. It then adds the original
base roster's rank and squad without shuffling ids. Output is ordered 1–420, with stable property order and a final
newline. Asset construction uses the traits alone; moving a character to another id does not change its bytes.

The visual language comes from the existing mess-hall cast, not a new uniform system:

- Paper faces, round orange cheeks, oversized white peaked caps, navy dress cloth and boot-black contours.
  Rank retains its existing cap grade and the original cream plate with the kit's stencil rank lettering.
  There are no new words, numbers, names, claims, military insignia, logos or weapons.
- The sleepy diner, eager wide eyes, wink, grinning mouth, moustaches, sideburns and plaits extend the existing
  face parts. Hair uses the kit's brown mix so black braid marks remain visible. Braids have orange ties.
- Napkins and bow ties split the table evenly. Every portrait has the same plate and gold coin, in the same place.
  Every model carries the same ration plate and coin, with its rank plate on a small table below that hand.
  Props are mess-hall tools: steel cutlery, a cup, a service bell,
  salt or an unlettered menu. The cook's flannel and the banner's quiet seven remain reserved to their original scenes.
- Walls use only the existing warm Khaki, Crate and Paper schemes. Blue stays on cloth. Wall belongs to the
  portrait environment and does not add a room to the portable model. Squad is a grouping in the data,
  with no text or badge on either asset.

The picture imports `../src/` parts and retains their 10 px major outlines, flat fills, highlights and right-side
halftone. The model translates the same face geometry, eyes, mouth, grooming, collar, rank cap and prop into
faceted solids with geometry outlines. It omits printed halftone, since the GLB carries no textures.

The 48 picture samples cover every value, including all 35 squads. The 24 model samples cover every value except
all squads: 24 models cannot cover 35 different squad numbers. Selection is deterministic greedy coverage, then
maximum minimum character distance, with original id order breaking ties. `samples.json` records the exact ids.
