# Dragon's Hoard

Load it: build with `node scripts/kits/bundle.mjs dragons-hoard`, then choose `settings/dragons-hoard-boxspec-v2.json` in Create → Load settings. First resolve its [public bindings](../../../scripts/kits/README.md#binding-the-setup); the generated inventory lists anything still unresolved.

A dragon so stingy that even when you take your share, it keeps one coin in twenty.

This is the brand kit for the Dragon's Hoard example box on Square Hole. The token is HOARD, priced in ETH, and the
box holds a pile of ETH. The creator puts the first coins on the pile. The buyers' share of every fee is kept for the
pile and goes onto it after the box graduates. The sellers' share buys HOARD in the box's own pool and burns it. After
graduation, anyone who holds HOARD can burn it to take its share of the pile. One twentieth of that share stays on the
pile for everyone who is still holding.

![Dragon's Hoard cover. DRAGON'S HOARD in gold letters. On the left, BUYERS FEED THE PILE, with a coin dropping onto a pile of coins that has a green scaly dragon tail curled around it. On the right, SELLERS FEED THE FIRE, with a green HOARD token dropping into a fire.](art/cover.png)

The kit is ready for review. Nothing in it is deployed or posted, and the founder checks it before any use.

## Files

| File | What it is |
| --- | --- |
| [README.md](README.md) | This page |
| [brand-book.md](brand-book.md) | Name, ticker, joke, cover line, voice, palette, fonts, logo rules, do and don't, accessibility, homage rules |
| [storybook.md](storybook.md) | The story in seven pictures, showing what the fees do |
| [details.md](details.md) | The box settings in plain words, what a holder gets, the risks, what still waits |
| [art-notes.md](art-notes.md) | How the art is built, so a creator can extend it |
| [build-art.mjs](build-art.mjs) | Builds every SVG in `art/` from `src/` and renders each PNG |
| [check.mjs](check.mjs) | Checks every file and pixel size, the clear space, the avatar corner, the storybook, the registry settings and the wording |
| [src/](src/) | The art source: palette, gilt alphabet, coins, scales and tail, the lair, props, the hoard, scenes and brand pieces |
| `art/logo.svg`, `art/logo.png` | The mark, 1024 x 1024 |
| `art/logo-48.png` | The same mark at 48 x 48, to show it still reads |
| `art/x-avatar.svg`, `art/x-avatar.png` | X profile picture, 400 x 400 |
| `art/x-banner.svg`, `art/x-banner.png` | X header, 1500 x 500, with a bare corner for the avatar |
| `art/cover.svg`, `art/cover.png` | Link card, 1200 x 630 |
| `art/box-banner.svg`, `art/box-banner.png` | Box page banner, 2400 x 600 |
| `art/scenes/scene-01` to `scene-07`, `.svg` and `.png` | The storybook pictures, 1200 x 1200 each |
| `art/reference/cover.png`, `box-banner.png`, `scenes/scene-01.png` to `scene-07.png` | The cover, the box banner and the scenes with no lettering, as reference pictures of the kit's world. PNG only |
| [SH-KIT-DRAGONS-HOARD.md](SH-KIT-DRAGONS-HOARD.md) | Work record for the integrator, with decisions, facts, commands and results |
| `.gitattributes` | Keeps the art bytes exact, so the freshness check holds on every checkout |

Every PNG has its SVG next to it. The SVGs hold only shapes. They load no fonts, images or scripts.

## No items in this box

Dragon's Hoard is a coin pile. It has no collection, so the kit has no item pictures, no `assign.mjs` and no
`assignment.json`, and `check.mjs` makes sure none appear by mistake. The pile holds one coin, the same coin the
box is priced in, fixed when the box is created.

## Rebuild and check

From the repository root, with Node 24 and the workspace installed:

```sh
node examples/boxes/dragons-hoard/build-art.mjs
node examples/boxes/dragons-hoard/check.mjs
```

`build-art.mjs` uses `@resvg/resvg-js`, which the workspace already pins in `packages/cards`. Nothing is
downloaded. The same source gives the same bytes every time, and `check.mjs` fails if any SVG or PNG differs
from a fresh build.

`node examples/boxes/dragons-hoard/build-art.mjs --no-words` builds only `art/reference/`, the same pictures with no
lettering ([art-notes.md](art-notes.md#word-free-references)). `check.mjs` does not read that folder, so rebuild it
after any change to the cover, the box banner or a scene.

## Using the kit

- Show live text next to the pictures. The brand book has the lines, and the storybook has the captions.
- Wherever the cover line "Buyers feed the pile. Sellers feed the fire." appears, the literal line goes next to it.
  The brand book has both.
- The pile and its leave-behind are the heart of this box. Every live HOARD page shows the pile, the fees still
  waiting to be moved onto it, and the 5% rule, in live text.
- Every live HOARD page shows the chain and the full contract address. Other tokens may use HOARD too. Until a
  contract exists, the line reads "Contract: not deployed".
- When Square Hole launches this box as one of its own, its address also goes on the list of Square Hole's own
  boxes, as decided in F133.
- On the create page: the Coin pile template, then To the pile for the buyers and 5% at Leave behind.
- The example registry still points at local test pictures. Wiring this art into a launch is a separate step.
- The kit grants no license yet. The open-source license for its code, text and art is still to be chosen.
