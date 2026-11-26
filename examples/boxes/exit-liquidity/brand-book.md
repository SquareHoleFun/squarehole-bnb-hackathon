# Exit Liquidity brand book

## Identity

**Name:** Exit Liquidity. **Ticker:** EXIT. **Price coin:** USDC. **In the box:** 404 signs.

**One-sentence joke:** 404 exit signs, and not one of them knows the way out.

**Story hook:** Every trade pays a small fee in USDC. Buyers' fees make the box's own pool deeper, and that
depth stays in the pool for good. Sellers' fees go to the signs. A sign out in the world keeps its share until
its owner claims it. The share of the signs still in the box buys EXIT and burns it.

"Exit liquidity" is trader slang for the people who buy while someone else sells. This box turns the phrase
into a hallway full of exit signs that point nowhere. The joke is on the signs. It is never on the people who
buy or sell.

## Voice and tone

We sound like a friend explaining the box at a table. Short, dry, a little deadpan. Pictures and numbers come
first, words second. We say what happens in the order it happens. When something can go wrong, we say it
plainly and leave the joke out.

- Use the plain words: sign, fee, pool, claim, burn, holder. Put the literal word next to every joke.
- Never call a buyer "exit liquidity", a bag holder or anything like it.
- No urgency, no countdowns, no prices, and no talk about what EXIT or a sign might be worth.
- Signs speak in capitals inside the art. Everywhere else we write in sentence case.

| Where | Example line |
| --- | --- |
| Greeting | "Welcome to the hallway. Mind the signs." |
| Cover | "404 signs. Exit not found." |
| X bio | "404 signs that point nowhere. Buyers fill the pool. Sellers pay the signs." |
| A sign outside the box | "This sign is out in the world. Its USDC share waits here until you claim it." |
| A sign inside the box | "Still in the box. Its share buys EXIT and burns it." |
| Claim button | "Claim" |
| Nothing to claim | "No new fees. The hallway is quiet." |
| Claim still syncing | "The fee records are catching up. Your claim has not gone through yet." |
| Risk line | "EXIT and the signs can lose all their value. A deep pool does not mean a good price." |
| Post about the pool | "Buys add to the pool. That part never leaves." |

<!-- avoid-list:start -->
Words and shapes we never use: earn, yield, returns, gains, profit, income, passive, investment, moon, 100x,
APY, guaranteed, "get in early", "floor price", pump, unlock, seamless, revolutionary, journey. No dash asides,
no emoji decoration, and no prices, dates or wallet addresses in posts or pictures.
<!-- avoid-list:end -->

`check.mjs` scans every doc and every SVG title and description for these words. The list above is the only
place they may appear.

## Palette

A hallway at night, lit only by its signs.

| Name | Hex | Use |
| --- | --- | --- |
| Hallway ink | `#0E1316` | Every background, and the letters on lit sign faces |
| Housing slate | `#1F292E` | Sign housings, crates, panels |
| Rim grey | `#3A4A52` | Rims, rods, chains. Decoration only |
| Exit green | `#22D47B` | Lit signs, the main accent, focus rings |
| Glow mint | `#A8F3CB` | Small labels and highlights on dark |
| Alarm red | `#FF5A47` | Errors, selling, burns |
| Signal amber | `#FFB43F` | USDC coins in the story, warnings |
| Paper | `#F3F0E7` | Light grounds, text on dark |
| Deep green | `#0B6B3C` | Green text and links on paper |

A sign glows in one of four colors: exit green, glow mint, alarm red or signal amber. Each lit color has one
fixed unlit shade for LED dots, listed in `src/palette.mjs`. In the story, amber discs stand for USDC and green
squares with an arrow stand for EXIT. They are plain symbols. When a page shows real balances, it also writes
the coin's name in text.

## Typography

Live text uses three free font families under the SIL Open Font License 1.1, all on Google Fonts.

| Use | Family and weights | Fallback stack |
| --- | --- | --- |
| Titles | Barlow Condensed, 600 to 700 | `"Barlow Condensed", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif` |
| Body and buttons | Barlow, 400 to 600 | `"Barlow", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numbers, counts, ids | JetBrains Mono, 500 to 700 | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Barlow takes its look from California's road signs and plates, so it sits well next to a hallway of signs.
JetBrains Mono keeps numbers the same width, so amounts and counts line up.

The pictures need no font at all. Every letter in the art is drawn from the kit's own pixel alphabet, described
in [art-notes.md](art-notes.md). This kit ships no font files. A site that uses these fonts self-hosts pinned
files with their license notice. Body text is at least 16 px with a line height of 1.5.

## Logo

The mark is a green light-box sign that reads 404 in heavy pixel numerals. It hangs from a short bar on a
hallway-ink square. The files are `art/logo.svg` and `art/logo.png` (1024), `art/x-avatar.png` (400) and
`art/logo-48.png`, which shows the mark still reads at 48 px.

- **Construction.** One module is one cell of the heavy numerals, 44 px on the 1024 px logo. The housing is
  16.4 by 9.4 modules.
- **Clear space.** Keep at least 2 modules free on every side of the housing. The square files already
  include it. In a round crop the whole housing sits well inside the circle.
- **Smallest size.** 48 px. Below that, write EXIT in live text instead.
- **Keep** the ink square, the green face, the ink numerals and the bar together.
- **Don't** recolor the face, add words or the ticker to the plate, stretch, rotate or outline the mark, or set
  it on a light ground without its ink square.

On the X banner, the bottom-left corner (x 0 to 420, y 270 to 500) is plain wall, so the avatar can overlap
it. Keep important parts at least 60 px from every edge. The wide box banner can be cropped on narrow screens,
so the page also shows the name in live text.

## Do and don't

| Do | Don't |
| --- | --- |
| Keep the hallway at night, lit only by its signs | Draw people, mascots or characters |
| Draw every letter from the kit's pixel alphabet | Use a running-figure exit pictogram or copy any real safety sign |
| Show USDC as plain amber discs and EXIT as green squares | Use a real coin logo, a banknote or any brand |
| Put each fee picture next to its caption | Suggest a sign gets a fixed amount or gets paid on a schedule |
| Say a sign owner claims the sign's share | Say a sign sends money by itself |
| Show a burn as EXIT squares breaking into bits | Show price charts, rockets or anything rising in value |
| Keep the joke on the signs | Make fun of buyers or sellers |

## Accessibility

Contrast ratios for the solid colors, by the WCAG 2.2 formula:

| Pair | Ratio | Use |
| --- | --- | --- |
| Paper on hallway ink | 16.40:1 | Body text on dark |
| Glow mint on hallway ink | 14.55:1 | Labels on dark |
| Signal amber on hallway ink | 10.55:1 | Warnings on dark |
| Exit green on hallway ink | 9.59:1 | Accents and large text on dark |
| Alarm red on hallway ink | 6.06:1 | Errors on dark |
| Hallway ink on exit green | 9.59:1 | Letters on a lit face |
| Hallway ink on paper | 16.40:1 | Body text on light |
| Deep green on paper | 5.79:1 | Links on light |

All of these pass WCAG AA for normal text. Rim grey on hallway ink is 2.03:1, so it stays decoration and never
marks a control. Exit green, alarm red and signal amber on paper are below 3:1, so they are never text on light
grounds.

- Every SVG carries a title and a description. The storybook uses the same words as alt text.
- Repeat any words from a banner or the cover as live text on the page.
- Never show inside or outside the box by color alone. Say it in words.
- The art is still. If a site makes a sign flicker, keep it below three flashes a second and turn it off for
  people who ask for reduced motion.
- Amounts, ids, claim states and the contract address are selectable text, never only pictures. Controls are
  at least 44 by 44 px with a visible focus ring in exit green.

## Homage and IP

- The idea nods to the trader phrase "exit liquidity" and to the 404 error that every web user knows. Both are
  common phrases. The homage is in the idea only.
- All art here is original and drawn in code for this kit. Nothing is traced, downloaded or generated from
  other images, and the pictures use no font.
- No real brands, logos, products, people, mascots or characters. No coin logos, no banknotes, no
  safety-standard pictograms and no copies of real signage.
- USDC is named in plain text because it is the price coin. Its logo never appears.
- Square Hole is named as the platform. This kit names no other Square Hole token or collection.
- EXIT is a common word, and other tokens may use the same ticker. Live pages always show the chain and the
  full contract address.
- Counsel still has to look at the name and the joke, how a sign's fee share is described, and the license
  for publishing this kit. See [details.md](details.md).
