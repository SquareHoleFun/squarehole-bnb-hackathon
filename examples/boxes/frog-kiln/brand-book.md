# Frog Kiln brand book

## Identity

**Name:** Frog Kiln. **Ticker:** KILN. **Price coin:** the frog coin, a frog-themed meme coin with a real burn.
**In the box:** 420 clay toads, hidden until drawn, and 24 of them cracked.

**One-sentence joke:** Every trade fires the kiln.

**Cover line:** "Every trade fires the kiln."

**The literal line next to it:** "In plain words, after graduation the buyers' share of every fee burns the frog coin, and the sellers' share buys KILN for the toads."

**Story hook:** Behind the pond there is a potter's studio with a brick kiln, and the kiln runs on frog coins. Every
buy and every sale pays a small fee in the frog coin. The buyers' coins wait by the kiln, and after the box
graduates, anyone can fire the kiln and burn them for good. The sellers' coins buy KILN, the box's token, and the
KILN is shared by the 420 clay toads that came out of the kiln. A toad on a shelf outside the box keeps its part. The
part of a toad still wrapped up in the box goes into the fire too.

The frog coin has a big crowd. This box sends that crowd's coins into a kiln and hands back clay toads. The joke is on
the kiln and its appetite. It is never on the frog coin's crowd, on the people behind it, or on the people who buy, sell
or hold.

## Voice and tone

We sound like a potter at the wheel who explains the firing to a friend, calm, warm and a little dry. Pictures and
numbers come first, words second. We say what happens in the order it happens. When something can go wrong, we say it
plainly and leave the joke out.

- Use the plain words: box, fee, coin, burn, pool, holder, toad, draw. Put the literal word next to every joke.
  "Fired" always means burned with the frog coin's own burn.
- No urgency, no countdowns, no prices, and no talk about what KILN, the frog coin or a toad might fetch. We never
  say that burning the frog coin helps anyone who holds it.
- In pictures the frog coin is a plain green coin with no letters, no face and no symbol. In kit texts it is "the
  frog coin". A live page names it by the ticker its listing shows.
- A cracked toad is part of a small special series. We never say it is better, and we never tell people which toad
  they will draw.
- Art lettering is cut in capitals. Everywhere else we write in sentence case.

| Where | Example line |
| --- | --- |
| Greeting | "Welcome to the studio. The kiln runs on frog coins." |
| Cover | "Every trade fires the kiln." |
| Literal line | "In plain words, after graduation the buyers' share of every fee burns the frog coin, and the sellers' share buys KILN for the toads." |
| X bio | "420 clay toads, hidden until drawn. Buys feed the kiln with the frog coin, and sales buy KILN for the toads." |
| Pinned post | "Every trade pays a 1% fee in the frog coin. After graduation, ten of every fifteen coins from buyers' fees are burned, and ten of every fifteen from sellers' fees buy KILN for the toads." |
| Before graduation | "The coins wait by the kiln until the box graduates. Nothing is fired before that." |
| The firing | "Fire the kiln. The buyers' frog coins burn for good, and the counter moves." |
| Fired counter | "Frog coin fired so far. These coins are burned and gone for good." |
| Drawing a toad | "Draw a toad with KILN. A public random number picks which one, and it shows when it is unwrapped." |
| A cracked toad | "This one cracked in the kiln. It gets the same part as every other toad." |
| A toad's page | "This toad is out of the box. Its KILN waits here for its owner to claim." |
| Putting a toad back | "Claim first. A toad you put back keeps its unclaimed KILN for whoever takes it out next." |
| Nothing to fire | "No trades, no fees, nothing to fire. The kiln is cold today." |
| Not affiliated | "Frog Kiln is a joke box on Square Hole. The people behind the frog coin did not make it, approve it or endorse it." |
| Risk line | "KILN and the toads can lose all their value. Burning the frog coin gives nothing back to anyone." |

<!-- avoid-list:start -->
Words and shapes we never use: earn, yield, returns, gains, profit, income, passive, investment, dividend, reward,
prize, jackpot, wealth, moon, 100x, APY, ROI, guaranteed, "get in early", "floor price", pump, unlock, seamless,
revolutionary, journey, hodl. For the toads: rare, rarity, grail, valuable, worth, lottery, gamble, loot. No dash
asides, no emoji decoration, and no prices, dates or wallet addresses in posts or pictures. No claim that a burn
sets a price or helps people who hold the frog coin.
<!-- avoid-list:end -->

Some names never appear at all. The frog coin's own name and ticker, any known frog character, cartoon frog or frog
mascot, the people who drew them, and any well-known frog or toad collection stay out of everything. `check.mjs` holds
their SHA-256 fingerprints and refuses them in every doc, every SVG title and description, every lettered word and every
source file, so the kit never spells them, not even in its own check. The avoid list above is the only place the words
in it may appear.

## Palette

A potter's studio, with a limewashed wall, a brick kiln, a plank floor and glazes on clay. Every shape is a flat glaze
with a soot outline. Shade is the same shape in a darker glaze, never a gradient.

| Name | Hex | Use |
| --- | --- | --- |
| Soot | `#2B1D17` | Every outline, text on light grounds |
| Bisque | `#F4E9D8` | The studio wall, carved letters, text on dark grounds |
| Slab | `#3D2B24` | The name plaque and the clay tags, dark grounds |
| Clay | `#C66A3D` | KILN tiles, the raw clay feet of the toads, bowls |
| Brick | `#8C3B27` | The kiln's bricks |
| Ember | `#F2A43C` | Fire, arrows, highlights on dark |
| Flame | `#DE5A2B` | Flames, the cross of a failed raise |
| Frog | `#6AA247` | The frog coin, the raise bar, the check mark |
| Celadon | `#A7C7A1` | The celadon glaze of the brand toad, soft accents |
| Pond | `#4C8C90` | The box's own pool |
| Wood | `#A7733F` | Ware boards, shelves, the floor, the crate |
| Ash | `#9C948B` | Smoke, ash, steel straps and staples. Decoration only |
| Gold | `#D6AC47` | The mended crack of the Gold seam toad |

The glazes of the twelve toads, the tints behind them and the light and shade of each ink are fixed mixes, listed in
`src/palette.mjs`. Every color in every picture comes from that file, and `check.mjs` refuses any other, any named
color, any gradient, filter or opacity.

In the story, green coins stand for the frog coin and small orange clay tiles stand for KILN. The big stoneware crock
marked 420 is the box, the pond is the box's own pool, and the kiln burns what goes into it. They are plain symbols.
When a page shows real balances, it also writes the coin's name in text.

## Typography

Live text uses three free font families under the SIL Open Font License 1.1, all on Google Fonts.

| Use | Family and weights | Fallback stack |
| --- | --- | --- |
| Titles | Fraunces, 600 to 800 | `"Fraunces", "Iowan Old Style", Georgia, "Times New Roman", serif` |
| Body and buttons | Figtree, 400 to 700 | `"Figtree", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numbers, counts, ids | Azeret Mono, 400 to 600 | `"Azeret Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Fraunces is a soft, warm serif with round ends, close to letters pressed into clay. Figtree is plain and easy to read
at small sizes. Azeret Mono keeps every digit the same width, so the fired total, counts and toad ids line up.

The pictures need no font at all. Every letter in the art is cut from the kit's own loop-tool alphabet, described in
[art-notes.md](art-notes.md). This kit ships no font files. A site that uses these fonts self-hosts pinned files with
their license notice. Body text is at least 16 px with a line height of 1.5.

## Logo

The mark shows the kiln from the front. It is a brick dome with a chimney and an arched door full of fire, and the
celadon toad sits in the doorway. It stands on the bisque wall. The files are `art/logo.svg` and `art/logo.png` (1024),
`art/x-avatar.png` (400) and `art/logo-48.png`, which shows the mark still reads at 48 px.

- **Construction.** One module is 1/32 of the square, 32 px on the 1024 px logo. The kiln is 20 modules wide. Its
  dome springs from walls 14 modules down and rises 8.9 modules, its footing is 1.6 modules tall, and its chimney is 4
  modules wide under a cap of 5.2. The door is an arch 9.2 modules wide and 10.6 tall, in a ring of wedge bricks. The
  toad is drawn 11.6 modules wide on the footing. The whole kiln sits 0.8 modules lower on the grid, so it looks
  centred in a round crop. The outline is half a module.
- **Clear space.** Keep at least 2 modules free on every side. The square files already include it, and `check.mjs`
  proves that the border holds only bare wall.
- **Round crop.** In a round avatar, the whole kiln sits inside 95% of the circle. `check.mjs` proves this too.
- **Smallest size.** 48 px. Below that, write KILN in live text instead.
- **Keep** the dome, the fire in the door and the toad together.
- **Don't** recolor the bricks, the fire or the toad, put out the fire, add words or the ticker to the mark, swap the
  toad for another animal or character, stretch, rotate or outline the mark, or set it on a dark ground without its
  bisque square.

On the X banner, the bottom-left corner (x 0 to 420, y 270 to 500) holds only bare wall and floor, so the avatar can
overlap it. `check.mjs` renders the banner and its bare ground and compares that corner pixel by pixel. Keep words at
least 60 px from every edge of the banner and 48 px from the edges of every other piece. The wide box banner can be
cropped on narrow screens, so the page also shows the name in live text.

## The hidden picture

Until a toad is drawn, it and every ticket show one picture, a toad wrapped in paper, with a twist on top and a clay
seal with a question mark. A box with hidden art keeps this picture on chain, where it must be one line of printable
ASCII of at most 4,096 bytes. `art/hidden.svg` is that line, under 2,000 bytes, and `check.mjs` holds it to the
limit. `art/hidden.png` is the same picture rendered for previews. Today's create page fills the field with its own
default picture. When the page takes a custom picture, this file goes in as it is.

## Do and don't

| Do | Don't |
| --- | --- |
| Draw toads as clay figurines: a squat body, two eye bumps, golden eyes, a wide smile, three toes on each front foot | Draw a known frog character, a cartoon frog with lips or a human face, a frog mascot, or anything from a frog meme |
| Keep the toads animals on a shelf | Give them clothes, hands, crowns, weapons or speech |
| Show the frog coin as a plain green coin | Draw the coin's logo, a face, a letter or a symbol on any coin |
| Show KILN as a small clay tile with the kiln's arch pressed into it | Write the ticker or a number on the tiles |
| Cut every letter from the kit's loop-tool alphabet | Use a font in a picture |
| Say the buyers' frog coins are burned, and that a burn sets no price | Say that burning helps anyone who holds the frog coin |
| Call a cracked toad part of a special series, with the same part of the fees | Call it better, or hint at which toad a draw gives |
| Put each fee picture next to its caption | Show price charts, rockets or anything rising in value |
| Keep the joke on the kiln and its appetite | Make fun of the frog coin's crowd or the people behind it |

## Accessibility

Contrast ratios for the solid colors, by the WCAG 2.2 formula, rounded down:

| Pair | Ratio | Use |
| --- | --- | --- |
| Soot on bisque | 13.55:1 | Body text on light |
| Bisque on slab | 11.14:1 | Body text on dark, the carved letters |
| Soot on celadon | 8.77:1 | Text on celadon |
| Soot on ember | 7.86:1 | Text on ember buttons |
| Soot on gold | 7.63:1 | Text on gold |
| Ember on slab | 6.46:1 | The fired total and numbers on dark |
| Bisque on brick | 6.31:1 | Text on brick |
| Soot on ash | 5.44:1 | Text on ash |
| Soot on frog | 5.32:1 | Text on the frog coin's green |
| Soot on flame | 4.34:1 | Large text only |
| Soot on clay | 4.28:1 | Large text only |
| Soot on pond | 4.23:1 | Large text only |
| Soot on wood | 4.00:1 | Large text only |

The first nine pass WCAG AA for normal text. The last four pass for large text, and on a page they carry headings and
labels only. Bisque on clay, flame, pond or wood is only about 3:1, so light text never sits on those grounds in
small sizes. `check.mjs` recomputes every ratio in this table.

- Every SVG carries a title and a description. The storybook uses the same words as alt text.
- Repeat any words from a banner or the cover as live text on the page.
- Never show burned, waiting, hidden or cracked by color alone. Say it in words.
- The art is still. If a site animates the fire or a coin, keep it gentle and turn it off for people who ask for
  reduced motion.
- Amounts, toad ids, the fired total and the contract address are selectable text, never only pictures. Controls are
  at least 44 by 44 px with a visible focus ring, soot on light grounds and bisque on slab.

## Homage and IP

- The box is a nod to the frog coin's crowd, by idea only. It is a kiln that burns their coin and makes clay toads. Its
  name and ticker do not use the coin's name, and nothing in it suggests an official product of the coin.
- The frog coin is never named in the kit, and no known frog character, cartoon frog or frog mascot is drawn, named or
  quoted. The coin's logo and the people behind it never appear. Every public page carries the "not affiliated"
  line from the voice table.
- The toads are animal figurines drawn for this kit, with squat clay bodies, golden eyes and glazes from real pottery.
  They have no lips, no eyebrows, no human face, no clothes and no catchphrase, and they copy no famous frog or toad.
- Glaze names (bisque, celadon, tenmoku, shino, oxblood, ash, cobalt, honey, raku) are common pottery words, and the
  gold seam is a common way to mend a crack. None of them names a brand.
- All art here is original and drawn in code for this kit. Nothing is traced, downloaded or generated from other
  images, and the pictures use no font.
- Square Hole is named as the platform. This kit names no other Square Hole token or collection.
- KILN may be used by other tokens. Live pages always show the chain and the full contract address.
- Counsel still has to look at the homage, the "not affiliated" line, the paid draws, the toads' part of the fees, the
  ticker and the license for publishing this kit. See [details.md](details.md).
