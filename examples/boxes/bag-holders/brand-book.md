# Bag Holders brand book

## Identity

**Name:** Bag Holders. **Ticker:** TOTE. **Price coin:** a community coin, LINK in the example registry.
**In the box:** 420 bags.

**One-sentence joke:** Nobody wants to be left holding the bag, so in this box the bags get the fees.

**Story hook:** Every buy and every sale pays a small fee in the price coin. On both sides, ten of its fifteen parts
are shared equally by the 420 bags. A bag outside the box keeps its share until its owner claims it. A bag still
inside the box keeps its share in the bag, for whoever takes it out.

"Bag holder" is trader slang for someone stuck with a token that fell. "Left holding the bag" is the older saying
behind it. This box turns the phrase around. The bags are the box's items, and the box's share of every fee goes to
them. The joke is on the phrase and on the bags. It is never on the people who buy, sell or hold.

## Voice and tone

We sound like a friend at a market stall, explaining the box at a table. Cheerful, dry, a little proud of the bags.
Pictures and numbers come first, words second. We say what happens in the order it happens. When something can go
wrong, we say it plainly and leave the joke out.

- Use the plain words: bag, box, fee, share, claim, pool, holder. Put the literal word next to every joke.
- "Bag holder" only ever means someone who owns one of the 420 bags, in the friendly sense of the name. Never use
  it for someone who lost money, and never to tease a buyer or a seller.
- No urgency, no countdowns, no prices, and no talk about what TOTE or a bag might be worth.
- In pictures the price coin is a plain gold coin with no name. In text, name it LINK where a sentence needs a
  name. Never name the project or company behind it.
- Art lettering is in capitals. Everywhere else we write in sentence case.

| Where | Example line |
| --- | --- |
| Greeting | "Welcome to the bag wall. Every bag here is held." |
| Cover | "420 bags share the fees." |
| X bio | "420 bags on a wall. Every buy and every sale pays a small fee, and the bags share it." |
| Pinned post | "Every trade pays a 1% fee in LINK. Ten of its 15 parts are split equally across all 420 bags." |
| A bag outside the box | "This bag is out in the world. Its share waits here until its owner claims it." |
| A bag inside the box | "Still in the box. Its share stays in the bag for whoever takes it out." |
| Claim button | "Claim" |
| Nothing to claim | "No new fees. The bag hangs quietly." |
| Claim still syncing | "The fee records are catching up. Your claim has not gone through yet." |
| Before graduation | "Until the box graduates, the bags' share waits. Then every bag gets the same part of it." |
| Selling a bag | "Its unclaimed share goes with the bag." |
| Putting a bag back | "Claim first. A bag you put back keeps its share for the next person who takes it out." |
| Risk line | "TOTE and the bags can lose all their value. One bag's share of a fee can be smaller than the gas to claim it." |

<!-- avoid-list:start -->
Words and shapes we never use: earn, yield, returns, gains, profit, income, passive, investment, dividend, reward,
prize, jackpot, wealth, moon, 100x, APY, guaranteed, "get in early", "floor price", pump, unlock, seamless,
revolutionary, journey. No dash asides, no emoji decoration, and no prices, dates or wallet addresses in posts or
pictures. No name of the project or company behind the price coin. The idea's first line, "the insult becomes the
prize", stays out of pictures and posts too, because "prize" reads as a promise.
<!-- avoid-list:end -->

`check.mjs` scans every doc and every SVG title and description for these words. The list above is the only
place they may appear.

## Palette

A shop wall of plum pegboard, with bags on steel hooks, drawn like a printed sticker sheet.

| Name | Hex | Use |
| --- | --- | --- |
| Pegboard plum | `#7B3B6A` | Every background. Links on light grounds |
| Ink | `#24171F` | Every outline, text on light grounds |
| Canvas | `#F7EEDC` | Totes, light grounds, text on plum |
| Coin gold | `#F5C342` | The price coin in the story, highlights on plum |
| Tomato | `#E5533D` | TOTE chips, pockets, sales |
| Pool aqua | `#63C7C2` | The box's own pool |
| Leaf | `#3E9B5A` | The claim button, buys, a full raise |
| Steel | `#A7AFB6` | Hooks, rails and zips. Decoration only |
| Kraft | `#C08A52` | The cardboard box, paper bags |
| Night plum | `#3A1D33` | The quiet night, deep grounds |

The pegboard holes, the shadows on the wall and the shades inside each bag are fixed mixes, listed in
`src/palette.mjs`. Every color in every picture comes from that file, and `check.mjs` refuses any other.

In the story, gold coins stand for the price coin and tomato chips with a little bag stand for TOTE. They are plain
symbols. The coins carry no letters and no hexagon. When a page shows real balances, it also writes the coin's name
in text.

## Typography

Live text uses three free font families under the SIL Open Font License 1.1, all on Google Fonts.

| Use | Family and weights | Fallback stack |
| --- | --- | --- |
| Titles | Lilita One, 400 | `"Lilita One", "Arial Rounded MT Bold", "Trebuchet MS", system-ui, sans-serif` |
| Body and buttons | Rubik, 400 to 700 | `"Rubik", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numbers, counts, ids | Space Mono, 400 and 700 | `"Space Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Lilita One is a heavy, rounded display face that sits well next to the sticker letters in the art. Rubik's soft
corners match the bags. Space Mono keeps numbers the same width, so amounts, counts and bag ids line up.

The pictures need no font at all. Every letter in the art is drawn from the kit's own sticker alphabet, described in
[art-notes.md](art-notes.md). This kit ships no font files. A site that uses these fonts self-hosts pinned files with
their license notice. Body text is at least 16 px with a line height of 1.5.

## Logo

The mark is a canvas tote with a tomato pocket, hanging from a steel hook on plum pegboard. The hook is the holder.
The files are `art/logo.svg` and `art/logo.png` (1024), `art/x-avatar.png` (400) and `art/logo-48.png`, which
shows the mark still reads at 48 px.

- **Construction.** One module is 1/32 of the square, 32 px on the 1024 px logo. The tote is 16 by 13.5 modules,
  its top 13.5 modules from the top edge. The hook sits in a pegboard hole 3.4 modules from the top, and the holes
  are 4 modules apart.
- **Clear space.** Keep at least 2 modules free on every side of the hook, the tote and its shadow. The square
  files already include it, and `check.mjs` proves that the border holds only bare pegboard.
- **Round crop.** In a round avatar, the whole mark and its shadow sit inside 95% of the circle.
- **Smallest size.** 48 px. Below that, write TOTE in live text instead.
- **Keep** the plum ground, the canvas tote, the tomato pocket and the hook together.
- **Don't** recolor the tote or the pocket, add words or the ticker to the tote, take the hook away, stretch,
  rotate or outline the mark, or set it on a light ground without its plum square.

On the X banner, the bottom-left corner (x 0 to 420, y 270 to 500) holds only bare pegboard, so the avatar can
overlap it. `check.mjs` renders the banner and its bare wall and compares that corner pixel by pixel. Keep important
parts at least 60 px from every edge. The wide box banner can be cropped on narrow screens, so the page also shows
the name in live text.

## Do and don't

| Do | Don't |
| --- | --- |
| Hang every bag on a hook that sits in a pegboard hole | Draw people, hands, mascots or characters |
| Draw every letter from the kit's sticker alphabet | Copy a real brand's bag, stripes, monogram, tag or print |
| Show the price coin as a plain gold coin with no name | Draw the price coin's logo, its colors or any hexagon coin |
| Show TOTE as a tomato chip with a little bag | Show price charts, rockets or anything rising in value |
| Put each fee picture next to its caption | Suggest a bag gets a fixed amount or gets paid on a schedule |
| Say an owner claims a bag's share | Say a bag sends money by itself |
| Keep the joke on the phrase and on the bags | Call a buyer, a seller or someone who lost money a bag holder |

## Accessibility

Contrast ratios for the solid colors, by the WCAG 2.2 formula:

| Pair | Ratio | Use |
| --- | --- | --- |
| Ink on canvas | 14.97:1 | Body text on light |
| Canvas on night plum | 12.98:1 | Body text on dark |
| Ink on coin gold | 10.49:1 | Text on gold |
| Ink on pool aqua | 8.61:1 | Text on aqua |
| Canvas on pegboard plum | 6.81:1 | Text on plum |
| Pegboard plum on canvas | 6.81:1 | Links on light |
| Ink on kraft | 5.75:1 | Text on cardboard |
| Ink on leaf | 4.96:1 | Button labels |
| Coin gold on pegboard plum | 4.77:1 | Highlights and numbers on plum |
| Ink on tomato | 4.63:1 | Text on tomato |

All of these pass WCAG AA for normal text. Pool aqua on plum (3.92:1) and steel on plum (3.53:1) are for large text
and decoration only. Tomato, leaf and kraft on plum are below 3:1, so in the art they always carry an ink outline,
and on a page they are never text on plum.

- Every SVG carries a title and a description. The storybook uses the same words as alt text.
- Repeat any words from a banner or the cover as live text on the page.
- Never show inside or outside the box by color alone. Say it in words.
- The art is still. If a site animates a bag or a coin, keep it gentle and turn it off for people who ask for
  reduced motion.
- Amounts, bag ids, claim states and the contract address are selectable text, never only pictures. Controls are
  at least 44 by 44 px with a visible focus ring, ink on light grounds and canvas on plum.

## Homage and IP

- The idea nods to the trader phrase "bag holder" and the old saying "left holding the bag". Both are common
  phrases. The homage is in the idea only.
- All art here is original and drawn in code for this kit. Nothing is traced, downloaded or generated from other
  images, and the pictures use no font.
- No real brands, logos, products, people, mascots or characters. The twelve bags are generic kinds of bag. None
  copies a brand's shape, stripes, monogram pattern, tag color or print. The duffel bag has two stripes, never
  three.
- LINK is named in plain text because it is the registry's price coin. Its logo, its colors and the name of the
  project behind it never appear. The coins in the pictures are plain gold discs, so the art also fits a copy of
  this box priced in another community coin.
- Square Hole is named as the platform. This kit names no other Square Hole token or collection.
- TOTE is a common word, and other tokens may use the same ticker. Live pages always show the chain and the full
  contract address.
- Counsel still has to look at the name and the joke, how a bag's share is described, the ticker, and the license
  for publishing this kit. See [details.md](details.md).
