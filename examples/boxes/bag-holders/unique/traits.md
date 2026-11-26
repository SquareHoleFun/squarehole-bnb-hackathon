# Bag Holders: traits for the unique edition

This is the active edition's public vocabulary; it does not claim deployed NFT metadata.
[traits.json](traits.json) is its machine-readable source. Counts and supply are decimal strings; the dealer
uses bigint for IDs and supply. The seed retains its historical proposal wording to preserve reviewed bytes.

The joke is still “the bags get the fees.” These are the twelve familiar objects from the kit, kept in service with patches and blank tags. They are not new mascot characters, wealth ranks, fee multipliers or promises of returns. The tote, tea bag, punching bag, chips and lemons retain their original roles in the storybook.

## Exact edition

| Trait | Values | Bags per value | Total |
| --- | --- | ---: | ---: |
| kind | `01` (Tote), `02` (Paper bag), `03` (Tea bag), `04` (Sandbag), `05` (Bean bag), `06` (Punching bag), `07` (Sleeping bag), `08` (Gift bag), `09` (Duffel bag), `10` (Backpack), `11` (Bag of chips), `12` (Bag of lemons) | 35 | 420 |
| trim | Tomato (`tomato`), Aqua (`aqua`), Leaf (`leaf`), Gold (`gold`), Canvas (`canvas`) | 84 | 420 |
| repair | Square patch (`square`), Round patch (`round`), Twin patches (`twin`), Diagonal darn (`slash`), Ladder mend (`ladder`), Corner patches (`corners`), Patch pocket (`pocket`) | 60 | 420 |
| tag | Clipped ticket (`ticket`), Round tag (`round`), Swallowtail tag (`swallowtail`) | 140 | 420 |
| stitch | Running stitch (`running`), Cross stitch (`crossed`) | 210 | 420 |

Every row totals 420 separately. A bag has one value from each row. These are balanced counts, not rarity claims.

- **Kind** keeps `assign.mjs`'s picture number for every ID: `((id - 1) % 12) + 1`. No old ID changes bags. Primary material colours and recognisable silhouettes stay with their kind.
- **Trim** uses the kit's existing tomato, aqua, leaf, gold and canvas. It colours the repair and blank tag, plus the kind's appropriate detail: tote/backpack pocket, punching band, sleeping strap, gift dots or lemon net. The original aqua TEA tag and tomato CHIPS label keep their colours. Paper, sand, bean and duffel retain their established body colours.
- **Repair** gives an ordinary bag its own history. A crooked square patch, round patch, overlapping pair, diagonal darn, ladder mend, reinforced corners or patch pocket extends the kit's heavy ink line work. The same joke applies to cloth, paper and foil; a patched snack packet is intentionally silly. Placement avoids the original lettering and its clear space, the roll's spiral, zips, tea flecks and potato drawings. Printed kinds use smaller repairs on the tote pocket, above the paper/chips labels or below the sand stamp.
- **Tag** is an unlettered clipped ticket, round disc or swallowtail, attached with a canvas tether. It is a visual prop, not a price, ticker, inventory number or financial status.
- **Stitch** changes the geometry inside each repair. Running stitches and crossed stitches are visible seams; diagonal darns have larger transverse seams. At 128 px the bag, colour and repair lead; the fine stitches are secondary.

## Exact dealing and uniqueness

The seed is fixed and public:

```text
Bag Holders / every bag is held / proposal 1 / 2026-10-27
```

For each of the twelve kinds, construct the full five-trim by seven-repair product: 35 combinations. With zero-based indexes `k`, `c`, `r` into the JSON arrays, choose tag index `(k + c + r) % 3` and stitch index `(k + c + r) % 2`. These accessory traits are intentionally correlated, not independently sampled.

Rank each combination by HMAC-SHA256 with that seed as key and `bag-holders/deal/v1/` plus `kind|trim|repair|tag|stitch` as the message. Sort by hex rank, breaking ties by the full trait key, using plain character comparisons (no locale or random API). Deal each kind's deck in increasing original ID order. The seed changes the ID permutation, not the counts or permitted combinations.

Proof:

1. Each kind receives all 35 distinct trim/repair pairs, so no two complete trait sets can match.
2. Each trim appears seven times per kind: `7 × 12 = 84`. Each repair appears five times per kind: `5 × 12 = 60`.
3. For each of the 35 trim/repair pairs, the twelve kind indexes hit each tag residue four times and each stitch residue six times: `35 × 4 = 140`, `35 × 6 = 210`.
4. For a fixed kind and repair, the five trim indexes occupy five distinct tag/stitch pairs out of six. Thus even the mesh geometry differs when trim is the only varying pair coordinate; uniqueness does not rely on material colours or GLB names.

`validateDeal()` independently recounts the finished edition and compares every ID to the existing assignment. Tests also require 420 distinct decoded PNGs, 420 distinct decoded 128 px thumbnails and 420 distinct GLB geometry buffers. IDs are never drawn into assets to manufacture uniqueness.

## Shared visual construction

`picture.mjs` imports the kit's `Doc`, pegboard, hooks, bag silhouettes, palette, pen and original lettering. `lib/details.mjs` defines repair and tag paths once for both SVG and mesh generation. The only rendered words are the original TOTE, PAPER, TEA, SAND and CHIPS prints. Their lettering, colours, sizes and positions remain unchanged. No external images, textures or fonts are embedded in an NFT picture.

`model.mjs` gives all twelve kinds depth, with flat kit colours and physical ink outlines. The shared reference scale is 760 artwork pixels per world unit, including hooks. Only centring and grounding are applied per model; no model gets a separate scale. Models face +z and sit at y = 0. `lib/prints.mjs` reads the original item SVGs and turns their print strokes into raised geometry with the same colours and transforms; it adds no font or copied alphabet. The lemon net joins at its perimeter; lemons use faceted ellipsoids. Bags use solid panels and straps, rather than fabric simulation.

The public seed is suitable for this open-art edition. It is not a hidden reveal secret and must not be reused as one.
