# Demo pictures (SH-295)

Eight square logos made the way GPU Poor's logo is made (`examples/boxes/gpu-poor/src/brand.mjs`): SVG drawn by hand
on a 1024 square, a night ground with three faint contour rings and a glow in the picture's own colour, a flat emblem
in nested bands with a dark outline, rendered to PNG by resvg (`examples/boxes/gpu-poor/src/render.mjs`). No
lettering, no real company, product or mascot. `node hackathon/demo-pictures/build.mjs` rebuilds them (the same bytes
every time) and `contact-sheet.png` (each at 256 and 48 pixels on the dark ground, with its name).

Each PNG is the largest side from 1024 down that stays within Turbo's free upload (107,520 bytes,
`apps/web/src/features/pictures/arweave-hosts.ts`); Create takes a logo of 256 to 4,096 pixels (`art-files.ts`).

| File | For | Side, bytes | Picture |
|---|---|---|---|
| `honey-jar.png` | the Flap launch in BNB with rules (a pile its holders redeem) | 1024, 99,727 | an amber jar of honey, a drip over the rim |
| `rainy-day.png` | the Flap launch in the test dollar with rules (a pile in dollars) | 896, 105,046 | a blue umbrella upside down, catching coins |
| `snip.png` | a Four.meme tax launch with rules (a buy-back that burns) | 896, 101,709 | magenta scissors cutting a coin in two |
| `pay-packet.png` | a Four.meme tax launch with rules (holders paid) | 896, 90,244 | a green pay envelope, a coin rising out |
| `the-alchemist.png` | The Alchemist box: a spare; its sheet keeps the kit's own logo (`examples/boxes/the-alchemist/art/logo.png`, already on Arweave) | 896, 89,954 | a violet flask, teal liquid, a coin above |
| `pile-furnace.png` | the Pile Furnace box (eats PILE) | 1024, 97,027 | a brick furnace, its mouth glowing, a coin dropping in |
| `card-trade.png` | a Flap launch with a card shop attached (cards given and picked for the token; lane e names it) | 896, 96,365 | a small lavender deck, two arrows turning around it |
| `quick-deck.png` | the new card shop box whose gives open after ten minutes (SH-300) | 768, 90,750 | a lime card with a stopwatch in front of it |

`<id>.svg` is each picture's source, `<id>-48.png` its 48-pixel check.

A box created by script shows its logo once the logo's exact bytes are on Arweave with the site's tags (the indexer
finds them by `SHA-256`): `packages/chain/scripts/bnb-boxes/publish-picture.mjs --file <png> --expect <sha> [--send]`
does what the Create press does (a free Turbo upload, a throwaway key made and dropped in the process).
