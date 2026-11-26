# One Dollar is all you need

The Sepolia price coin is tUSDC. In the portable settings, the pile follows the selected price coin and holds exactly one unit of it; the unbound ETH template is not the final Sepolia setup.

Load it: build with `node scripts/kits/bundle.mjs one-dollar`, then choose `settings/one-dollar-boxspec-v2.json` in Create → Load settings. First resolve its [public bindings](../../../scripts/kits/README.md#binding-the-setup); the generated inventory lists anything still unresolved.

The token is 1. The dollar is in the box.

This is the brand kit for the One Dollar is all you need example box on Square Hole, version 2. The token's ticker is
1. It is priced in USDC, and the box holds exactly one USDC as its coin pile. That USDC is the
dollar, and the pictures show it as a cartoon one-dollar bill, framed under glass on a gallery wall. Every trade pays
a small fee in USDC. On both sides, ten of its 15 parts buy the token in the box's own pool and burn it. No fee goes into the
coin pile, so fees never add to the dollar. After graduation, anyone who holds the token can burn it to take its slice of the
dollar.

![One Dollar is all you need cover. ONE DOLLAR IS ALL YOU NEED in ivory capitals across the top of a dark red gallery. On the left, THE TOKEN IS 1, with a pink token falling into a marble fireplace. In the middle, a green cartoon one-dollar bill hangs framed under glass in a spotlight, behind a velvet rope. On the right, a museum label reads THE DOLLAR IS IN THE BOX.](art/cover.png)

The kit is ready for review. Nothing in it is deployed or posted, and the founder checks it before any use. Version 1,
with the name One Dollar, the ticker ONE and a silver coin under a glass dome, stays at the git tag `kit-one-dollar-v1`.

## Files

| File | What it is |
| --- | --- |
| [README.md](README.md) | This page |
| [brand-book.md](brand-book.md) | Name, ticker, joke, cover line, voice, palette, fonts, logo rules, do and don't, accessibility, homage rules and the bill rules |
| [storybook.md](storybook.md) | The story in seven pictures, showing what the fees do |
| [details.md](details.md) | The box settings in plain words, the ticker's trade-offs, what a holder gets, the risks, what still waits |
| [art-notes.md](art-notes.md) | How the art is built, so a creator can extend it |
| [build-art.mjs](build-art.mjs) | Builds every SVG in `art/` from `src/` and renders each PNG |
| [check.mjs](check.mjs) | Checks every file and pixel size, the clear space, the avatar corner, the storybook, the registry settings, the trade-offs, the lettered words, the contrast table and the wording |
| [src/](src/) | The art source: palette, salon alphabet, the bill, coins, tokens, the gallery, the frame and exhibit, props, scenes and brand pieces |
| `art/logo.svg`, `art/logo.png` | The mark, 1024 x 1024 |
| `art/logo-48.png` | The same mark at 48 x 48, to show it still reads |
| `art/x-avatar.svg`, `art/x-avatar.png` | X profile picture, 400 x 400 |
| `art/x-banner.svg`, `art/x-banner.png` | X header, 1500 x 500, with a bare corner for the avatar |
| `art/cover.svg`, `art/cover.png` | Link card, 1200 x 630 |
| `art/box-banner.svg`, `art/box-banner.png` | Box page banner, 2400 x 600 |
| `art/scenes/scene-01` to `scene-07`, `.svg` and `.png` | The storybook pictures, 1200 x 1200 each |
| `art/reference/cover.png`, `box-banner.png`, `scenes/scene-01.png` to `scene-07.png` | The cover, the box banner and the scenes with no lettering, as reference pictures of the kit's world. PNG only |
| [SH-KIT-ONE-DOLLAR.md](SH-KIT-ONE-DOLLAR.md) | Work record for the integrator, with what changed in version 2, decisions, facts, commands and results |
| `.gitattributes` | Keeps the art bytes exact, so the freshness check holds on every checkout |

Every PNG has its SVG next to it. The SVGs hold only shapes. They load no fonts, images or scripts.

## No items in this box

One Dollar is all you need is a coin pile. It has no collection, so the kit has no item pictures, no `assign.mjs` and
no `assignment.json`, and `check.mjs` makes sure none appear by mistake. The pile holds one coin, the same coin the box
is priced in, fixed when the box is created.

## Rebuild and check

From the repository root, with Node 24 and the workspace installed:

```sh
node examples/boxes/one-dollar/build-art.mjs
node examples/boxes/one-dollar/check.mjs
```

`build-art.mjs` uses `@resvg/resvg-js`, which the workspace already pins in `packages/cards`. Nothing is downloaded.
The same source gives the same bytes every time, and `check.mjs` fails if any SVG or PNG differs from a fresh build.

`node examples/boxes/one-dollar/build-art.mjs --no-words` builds only `art/reference/`, the same pictures with no
lettering ([art-notes.md](art-notes.md#word-free-references)). `check.mjs` reads those files only for the phrase it
refuses everywhere, so rebuild them after any change to the cover, the box banner or a scene.

## Using the kit

- Show live text next to the pictures. The brand book has the lines, and the storybook has the captions.
- Wherever the cover line "The token is 1. The dollar is in the box." appears, the literal line goes next to it. The
  brand book has both.
- The token is 1. It is not a dollar, and every post and every live page says what the token is. The page also shows the
  dollar in the box, a slice quote and the least amount in live text.
- The ticker 1 has trade-offs on X, in wallets and on chart sites. [details.md](details.md) lists them.
- Every live page shows the chain and the full contract address. Other tokens may use 1 too. Until a contract
  exists, the line reads "Contract: not deployed".
- When Square Hole launches this box as one of its own, its address also goes on the list of Square Hole's own boxes,
  as decided in F133.
- The example registry still points at local test pictures. Wiring this art into a launch is a separate step.
- The kit grants no license yet. The open-source license for its code, text and art is still to be chosen.
