# Link Marines brand book

## Identity

**Name:** Link Marines. **Ticker:** MARINE, the founder's choice, as in the registry (`MARINE`). **Price coin:** a community coin, LINK in the example registry. **In the box:** 420 marines.

**One-sentence joke:** These marines love their coin so much that they eat it.

**Cover line:** "420 marines eat the fees."

**The literal line next to it:** "In plain words, after graduation ten of every fifteen fee coins are locked away for good."

**Story hook:** Every buy and every sale pays a small fee in LINK. Ten of its fifteen parts go into the marines' mess
tin. After the box graduates, anyone can ring the bell, and the marines eat what is in the tin. Eaten coins go to an
address that nobody has a key for, so they are out of circulation for good. The marines get nothing for it, and
neither does anyone else.

"Link Marines" is the nickname a coin's community uses for its keenest fans. This box takes the nickname at its word
and draws the fans as a squad of cartoon marines with a big appetite. Using the box is what feeds them. The joke is on
the marines and their appetite. It is never on real service members, on the coin's community or on the people who
buy, sell or hold.

## Voice and tone

We sound like the cook at a field kitchen, explaining the menu at the table. Short, cheerful, a little proud of the
marines' appetite. Pictures and numbers come first, words second. We say what happens in the order it happens. When
something can go wrong, we say it plainly and leave the joke out.

- Use the plain words: box, fee, coin, eat, lock, pool, holder, marine. Put the literal word next to every joke.
  "Eaten" always means sent to an address nobody has a key for.
- For LINK we say "eaten" or "locked", the words the founder's notes ask for, and we never say LINK's supply goes
  down. The avoid list below has the word we leave out.
- No urgency, no countdowns, no prices, and no talk about what MARINE, LINK or a marine might be worth. We never say
  that eating LINK helps anyone who holds it.
- In pictures the price coin is a plain gold coin with no name. In text, name it LINK where a sentence needs a name.
  Never name the project or company behind it.
- Art lettering is in stencil capitals. Everywhere else we write in sentence case.

| Where | Example line |
| --- | --- |
| Greeting | "Welcome to the mess hall. Today's menu is LINK." |
| Cover | "420 marines eat the fees." |
| X bio | "420 cartoon marines with one job. Every buy and every sale pays a small fee in LINK, and the marines eat it." |
| Pinned post | "Every trade pays a 1% fee in LINK. Ten of its 15 parts go to the mess tin, and after graduation they are locked away for good." |
| Before graduation | "The coins wait in the mess tin until the box graduates. Nobody eats before that." |
| The eat step | "Ring the bell. The marines eat what is in the tin, and it goes to a locker nobody can open." |
| Eaten total | "Eaten so far. This LINK is locked away and can never be spent." |
| A marine's page | "This marine eats with the squad. It gets no share of the fees." |
| Taking a marine out | "Pick any marine still in the box by its number. It costs MARINE, plus a 1% pick fee that is burned." |
| Nothing to eat | "No trades, no fees, nothing to eat. The mess hall is quiet." |
| Not affiliated | "Link Marines is a joke box on Square Hole. The people behind LINK did not make it, approve it or endorse it." |
| Risk line | "MARINE and the marines can lose all their value. Eating LINK gives nothing back to anyone." |

<!-- avoid-list:start -->
Words and shapes we never use: earn, yield, returns, gains, profit, income, passive, investment, dividend, reward,
prize, jackpot, wealth, moon, 100x, APY, ROI, guaranteed, "get in early", "floor price", pump, unlock, seamless,
revolutionary, journey, hodl. "Burned" for LINK: say eaten or locked. Any claim that LINK's supply goes down, or that
eating LINK helps people who hold LINK. No dash asides, no emoji decoration, and no prices, dates or wallet addresses
in posts or pictures. No name of the project or company behind the price coin, none of its product words, and never
its logo, its blue, a hexagon or a chain. No real service's names, mottos, emblems, ranks or camouflage, and no jokes
about real service members, the old one about crayons included. Three lines from the first idea stay out as well:
"pumping their bags" and "positive for all holders" read as promises, and "eats all the supply" is a claim about
supply that the numbers do not back.
<!-- avoid-list:end -->

`check.mjs` scans every doc and every SVG title and description for these words. The list above is the only
place they may appear.

## Palette

A field mess hall with a tiled wall, drawn like a screen-printed poster with flat inks, a boot-black outline and halftone
dots for shade.

| Name | Hex | Use |
| --- | --- | --- |
| Field olive | `#56622F` | Uniforms, helmets, the main wall. Links on light grounds |
| Boot black | `#1D2013` | Every outline, text on light grounds |
| Ration paper | `#F2E8CF` | Faces, the story's wall, text on olive |
| Coin gold | `#F2BE3C` | The price coin, the raise bar |
| Signal orange | `#E2622B` | MARINE dog tags, print shadows, crosses |
| Khaki | `#C8B07A` | Caps, fur, the patch on the mark, the second wall |
| Mess steel | `#A3A99C` | The mess tin, trays, the footlocker, the bell. Decoration only |
| Crate wood | `#B9874F` | The box's crate, the mess table, the floor |
| Water sage | `#8DAA8B` | The box's own pool |
| Night olive | `#2B3219` | The night watch, deep grounds |

The tile grout, the halftone dots and the shades inside each shape are fixed mixes, listed in `src/palette.mjs`.
Every color in every picture comes from that file, and `check.mjs` refuses any other. It also refuses any blue or
cyan, even as a shade, because blue is the look of the project behind the price coin.

In the story, gold coins stand for the price coin and orange dog tags stand for MARINE. A coin with a bite out of it is
a coin the marines have eaten. They are plain symbols. The coins carry no letters, no symbol and no hexagon. When a
page shows real balances, it also writes the coin's name in text.

## Typography

Live text uses three free font families under the SIL Open Font License 1.1, all on Google Fonts.

| Use | Family and weights | Fallback stack |
| --- | --- | --- |
| Titles | Saira Stencil One, 400 | `"Saira Stencil One", "Arial Black", Impact, system-ui, sans-serif` |
| Body and buttons | Barlow, 400 to 700 | `"Barlow", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numbers, counts, ids | Courier Prime, 400 and 700 | `"Courier Prime", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Saira Stencil One is a clean stencil display face that sits well next to the stencil letters in the art. Barlow is
plain and easy to read at small sizes. Courier Prime looks like a typed ration label, and its numbers are all the same
width, so amounts, counts and marine ids line up.

The pictures need no font at all. Every letter in the art is drawn from the kit's own stencil alphabet, described in
[art-notes.md](art-notes.md). This kit ships no font files. A site that uses these fonts self-hosts pinned files with
their license notice. Body text is at least 16 px with a line height of 1.5.

## Logo

The mark is a round khaki patch with a stitched edge. On it, a marine in a steel helmet pulled down over the eyes
bites a gold coin. The patch sits on the olive tile wall. The files are `art/logo.svg` and `art/logo.png` (1024),
`art/x-avatar.png` (400) and `art/logo-48.png`, which shows the mark still reads at 48 px.

- **Construction.** One module is 1/32 of the square, 32 px on the 1024 px logo. The patch is a circle of 13 modules
  radius in the middle of the square, with an outline of 0.62 modules. Its stitches run 1.1 modules inside the rim.
  The marine is the collection's first variant, scaled so the helmet's top sits 4.7 modules down, and cut off by
  the patch's circle at the shoulders.
- **Clear space.** Keep at least 2 modules free on every side of the patch. The square files already include it, and
  `check.mjs` proves that the border holds only bare wall.
- **Round crop.** In a round avatar, the whole patch sits inside 95% of the circle. `check.mjs` proves this too.
- **Smallest size.** 48 px. Below that, write MARINE in live text instead.
- **Keep** the khaki patch, its stitches, the helmet and the coin together.
- **Don't** recolor the patch or the helmet, add words or the ticker to the patch, swap the coin for a coin with a
  symbol, stretch, rotate or outline the mark, or set it on a light ground without its olive square.

On the X banner, the bottom-left corner (x 0 to 420, y 270 to 500) holds only bare wall, so the avatar can overlap it.
`check.mjs` renders the banner and its bare wall and compares that corner pixel by pixel. Keep words at least 60 px
from every edge of the banner and 48 px from the edges of every other piece. The wide box banner can be cropped on
narrow screens, so the page also shows the name in live text.

## Do and don't

| Do | Don't |
| --- | --- |
| Draw marines as cartoon busts in generic helmets, caps and plain uniforms | Copy a real service's emblem, insignia, ranks, flags, unit patches or camouflage |
| Give the marines cutlery, a bugle, a cup or a wrench | Draw weapons, fights or anyone getting hurt |
| Show the price coin as a plain gold coin, bitten once it is eaten | Draw the price coin's logo, its blue, a hexagon, chains or a coin with a symbol |
| Show MARINE as an orange dog tag with a hole and three stamped lines | Write the ticker or a number on the dog tags |
| Draw every letter from the kit's stencil alphabet | Use a font in a picture |
| Say eaten LINK is locked away for good | Use the avoid list's word for LINK, or say that LINK's supply goes down |
| Put each fee picture next to its caption | Show price charts, rockets or anything rising in value |
| Keep the joke on the marines and their appetite | Make fun of real service members, the coin's community or the people behind the coin |

## Accessibility

Contrast ratios for the solid colors, by the WCAG 2.2 formula, rounded down:

| Pair | Ratio | Use |
| --- | --- | --- |
| Boot black on ration paper | 13.57:1 | Body text on light |
| Ration paper on night olive | 10.94:1 | Body text on dark |
| Boot black on coin gold | 9.62:1 | Text on gold |
| Boot black on khaki | 7.84:1 | Text on khaki |
| Coin gold on night olive | 7.75:1 | Numbers and highlights on dark |
| Boot black on mess steel | 6.86:1 | Text on steel |
| Boot black on water sage | 6.50:1 | Text on sage |
| Ration paper on field olive | 5.40:1 | Text on olive, and olive links on paper |
| Boot black on crate wood | 5.23:1 | Text on wood |
| Boot black on signal orange | 4.74:1 | Text on orange |
| Coin gold on field olive | 3.83:1 | Large text and highlights only |
| Khaki on field olive | 3.12:1 | Large text only |

The first ten pass WCAG AA for normal text. The last two are for large text and decoration. Signal orange on ration
paper (2.86:1) and boot black on field olive (2.51:1) are below 3:1. In the art, orange words always carry a
boot-black print shadow, and black lines on olive are outlines, never words. On a page, orange is never text on
paper, and black is never text on olive. `check.mjs` recomputes every ratio in this table.

- Every SVG carries a title and a description. The storybook uses the same words as alt text.
- Repeat any words from a banner or the cover as live text on the page.
- Never show eaten, waiting or locked by color alone. Say it in words.
- The art is still. If a site animates a coin or a marine, keep it gentle and turn it off for people who ask for
  reduced motion.
- Amounts, marine ids, the eaten total and the contract address are selectable text, never only pictures. Controls
  are at least 44 by 44 px with a visible focus ring, black on light grounds and paper on olive.

## Homage and IP

- The name borrows a community's nickname for its keenest fans. The homage is in the idea only. The founder reports
  that counsel cleared the name (F82 LM5), and the counsel pack records that clearance as the name only.
- The project and company behind LINK are never named. Their logo, their blue, their hexagon and their product words
  never appear, and the art has no chains. LINK is named in plain text only, as the registry's price
  coin, and every public page carries the "not affiliated" line from the voice table.
- The marines are caricatures of nobody. The helmets, caps and uniforms are generic shapes with no emblem, insignia,
  rank, flag, unit patch, motto or camouflage of any real service. No marine is drawn after a real person, and none
  holds a weapon.
- Every face is the same ration-paper color, the unprinted paper of a screen print, so no marine stands for a real
  group of people. Braids, a mustache, freckles and hats tell the squad apart.
- No known meme characters, mascots or characters appear. The squad is drawn for this kit.
- All art here is original and drawn in code for this kit. Nothing is traced, downloaded or generated from other
  images, and the pictures use no font.
- Square Hole is named as the platform. This kit names no other Square Hole token or collection.
- Other tokens may use the ticker MARINE too. Live pages always show the chain and the full
  contract address.
- Counsel still has to look at the joke, the "not affiliated" line, the ticker and the license for publishing this
  kit. See [details.md](details.md).
