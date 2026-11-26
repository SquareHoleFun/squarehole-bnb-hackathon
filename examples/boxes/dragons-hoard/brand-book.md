# Dragon's Hoard brand book

## Identity

**Name:** Dragon's Hoard. **Ticker:** HOARD. **Price coin:** ETH. **In the box:** a pile of ETH.

**One-sentence joke:** A dragon so stingy that even when you take your share, it keeps one coin in twenty.

**Story hook:** Every trade pays a small fee in ETH. Buyers' fees go onto the dragon's pile, and sellers' fees buy
HOARD and burn it in the dragon's fire. After graduation, anyone can burn HOARD to take its share of the pile, and one
coin in twenty of that share stays behind for everyone still holding.

Dragons in old stories sleep on piles of coins and never share. This box has a pile too, and it does share, by one
fixed rule. Burn a part of all the HOARD there is, and take that part of the pile. The dragon keeps one coin in twenty
of every share, and that coin stays on the pile for the holders who stay. The dragon is the joke, and the dragon is
the box. It is never a buyer, a seller, a holder or the creator.

The dragon is never drawn. Only its tail shows, curled around the pile and covered in the same scales as the HOARD
tokens.

**Cover line:** "Buyers feed the pile. Sellers feed the fire."

Wherever the cover line appears, the literal line goes next to it. Feeding is the joke, and the literal line is the
rule. It reads "In plain words, buyers' fees go to the pile, and sellers' fees buy HOARD and burn it."

## Voice and tone

We sound like an old guild treasurer telling the story by the fire. Calm, exact, a little dry, fond of the dragon.
Pictures and numbers come first, words second. We say what happens in the order it happens. When something can go
wrong, we say it plainly and leave the joke out.

- Use the plain words: fee, pile, share, burn, pool, holder. Put the literal word next to every joke.
- The dragon is the box. Never call a person a dragon, and never make fun of someone for selling or for taking a
  share.
- No urgency, no countdowns, no prices, and no talk about what HOARD or a share might be worth. Never suggest that
  waiting longer pays off.
- In pictures the price coin is a plain coin with no name. In text, name it ETH where a sentence needs a name.
- Art lettering is in capitals. Everywhere else we write in sentence case.

| Where | Example line |
| --- | --- |
| Greeting | "Welcome to the hoard. Mind the tail." |
| Cover | "Buyers feed the pile. Sellers feed the fire." |
| Next to the cover line | "In plain words, buyers' fees go to the pile, and sellers' fees buy HOARD and burn it." |
| X bio | "A pile of ETH with a dragon's tail around it. Buyers' fees go onto the pile, sellers' fees burn HOARD, and HOARD can be burned for its share." |
| Pinned post | "Every trade pays a 1% fee in ETH. On a buy, ten of its 15 parts go to the pile. On a sale, ten of its 15 parts buy HOARD and burn it." |
| Taking a share | "Burn HOARD, take its share of the pile. One coin in twenty stays behind." |
| A share was taken | "Share taken. One coin in twenty stayed on the pile." |
| Fees waiting | "Some fees are still waiting outside the pile. Anyone can move them in." |
| Before graduation | "The pile opens when the box graduates. Until then the fee coins wait in the chest." |
| No trades | "No trades, no new coins. The dragon sleeps." |
| Risk line | "HOARD can lose all its value. A share of the pile is not a price, and every share taken makes the pile smaller." |

<!-- avoid-list:start -->
Words and shapes we never use: earn, yield, returns, gains, profit, income, passive, investment, interest, dividend,
reward, prize, jackpot, wealth, riches, fortune, treasure, loot, upside, grow, increase, rise, appreciate, accrue,
backed, scarce, deflationary, flywheel, "fair share", moon, 100x, APY, APR, ROI, guaranteed, "get in early",
"floor price", "price floor", "number go up", pump, hodl, "diamond hands", "paper hands", unlock, seamless,
revolutionary, journey. No dash asides, no emoji decoration, and no prices, dates or wallet addresses in posts or
pictures. No name of the project behind the guild-bank idea and no named dragon from any story, film or game.
<!-- avoid-list:end -->

`check.mjs` scans every doc and every SVG title and description for these words. The list above is the only
place they may appear.

## Palette

A lair of deep lapis, lit by a pile of coins.

| Name | Hex | Use |
| --- | --- | --- |
| Lapis night | `#111A44` | Every background |
| Lapis | `#26388C` | Plates and panels, the frame's inner rule, links on vellum |
| Ink | `#090D24` | Every outline, text on vellum |
| Gold | `#F5BE3B` | The coins and the pile, gilt letters, highlights and focus rings on dark |
| Jade | `#38C79E` | HOARD tokens and the dragon's tail, HOARD labels on dark |
| Vermilion | `#F25A3C` | Fire, burns, sales, errors |
| Ember | `#FF9B42` | The middle of a flame, warnings on dark |
| Vellum | `#F8EDD5` | Text on dark, light grounds |
| Stone | `#4A5AA6` | The pool's basin and the brazier's rim. Decoration only |
| Deep jade | `#0E6A50` | Jade text and links on vellum |
| Deep red | `#A62A1B` | Errors and burn labels on vellum |

A flame always runs vermilion, ember, gold and vellum from the outside in. The shades inside coins, scales, stone,
wood and water are fixed mixes, listed in `src/palette.mjs`. Every color in every picture comes from that file, and
`check.mjs` refuses any other.

In the story, plain gold coins stand for ETH and jade tokens covered in scales stand for HOARD. They are plain
symbols. The coins carry no letters, no symbol and no picture, and nothing in the art copies the price coin's logo.
When a page shows real balances, it also writes the coin's name in text.

## Typography

Live text uses three free font families under the SIL Open Font License 1.1, all on Google Fonts.

| Use | Family and weights | Fallback stack |
| --- | --- | --- |
| Titles | Cinzel, 500 to 700 | `"Cinzel", "Cormorant SC", Georgia, "Times New Roman", serif` |
| Body and buttons | Alegreya Sans, 400 to 700 | `"Alegreya Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numbers, amounts, counts | Inconsolata, 400 to 600 | `"Inconsolata", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Cinzel's carved capitals sit well next to the gilt letters in the art. It draws lowercase as small capitals, so it
stays in titles and short labels and never sets body text. Alegreya Sans is warm and easy to read at small sizes.
Inconsolata keeps every digit the same width, so the pile, a share and the fees waiting line up.

The pictures need no font at all. Every letter in the art is drawn from the kit's own gilt alphabet, described in
[art-notes.md](art-notes.md). This kit ships no font files. A site that uses these fonts self-hosts pinned files with
their license notice. Body text is at least 16 px with a line height of 1.5.

## Logo

The mark is the hoard. A heap of plain gold coins sits on a lapis night square, and the dragon's scaly tail sweeps
out from behind it, down its right side and around its front to a spade tip. A few gold glints shine above. The files
are `art/logo.svg` and `art/logo.png` (1024), `art/x-avatar.png` (400) and `art/logo-48.png`, which shows the mark
still reads at 48 px.

- **Construction.** The square is 32 modules wide. One module is 32 px on the 1024 px logo. The pile is 17.6 modules
  wide and 11 tall, its middle 14.4 modules from the left edge and its base 23.6 modules from the top. Its coins are
  about 2.9 modules across. The tail is 4.2 modules thick at its root, which hides behind the pile, and 1.85 modules
  where the spade starts. The spade is 3.8 modules long.
- **Clear space.** Keep at least 2 modules of bare ground on every side. The square files already include it, and
  `check.mjs` proves it by comparing the logo with its bare ground, pixel by pixel.
- **Round crop.** In a round avatar, the whole mark sits inside 95% of the circle. `check.mjs` proves that the same
  way.
- **Smallest size.** 48 px. Below that, write HOARD in live text instead.
- **Keep** the night square, the pile and the tail together, and keep the tail jade with its scales.
- **Don't** recolor the coins or the tail, put letters or the ticker on the mark, add a head, wings or claws, mirror,
  stretch, rotate or outline the mark, or set it on a light ground without its night square.

On the X banner, the bottom-left corner (x 0 to 420, y 270 to 500) is bare ground, and the frame leaves that corner
out, so the avatar can overlap it. `check.mjs` compares that corner with the bare ground pixel by pixel. Keep words at
least 60 px from every edge of the X banner and 48 px from every edge of the other pieces. `check.mjs` measures every
word it draws. The wide box banner can be cropped on narrow screens, so the page also shows the name in live text.

## Do and don't

| Do | Don't |
| --- | --- |
| Draw the pile as a heap of plain coins, and keep the tail around it | Put a letter, a symbol or a picture on a coin, or draw any coin's real logo |
| Draw HOARD as jade tokens covered in scales | Draw the dragon's head, face, eyes, wings or claws. Only the tail shows |
| Draw every letter from the gilt alphabet | Copy a known dragon from a story, film, game or flag |
| Show a burn as a fire in the iron brazier, and waiting fees in the chest | Show prices, charts, rockets, arrows that climb, or a pile that gets bigger by itself |
| Put each fee picture next to its caption | Say a share of the pile sets HOARD's price, or that the pile protects it |
| Put the literal line next to the cover line | Make fun of buyers, sellers or anyone who takes a share |
| Show the 5% rule wherever a share is offered | Hide the fees that are still waiting outside the pile |

## Accessibility

Contrast ratios for the solid colors, by the WCAG 2.2 formula:

| Pair | Ratio | Use |
| --- | --- | --- |
| Vellum on lapis night | 14.39:1 | Body text on dark |
| Gold on lapis night | 9.81:1 | Highlights, focus rings and labels on dark |
| Ember on lapis night | 7.98:1 | Warnings on dark |
| Jade on lapis night | 7.83:1 | HOARD labels and links on dark |
| Vermilion on lapis night | 5.02:1 | Errors and burn labels on dark |
| Lapis night on gold | 9.81:1 | Letters on a gold button |
| Lapis night on jade | 7.83:1 | Letters on a jade button |
| Ink on vellum | 16.50:1 | Body text on light |
| Lapis on vellum | 8.91:1 | Links on light |
| Vellum on lapis | 8.91:1 | Letters on a lapis plate |
| Deep red on vellum | 6.09:1 | Errors on light |
| Deep jade on vellum | 5.65:1 | Jade text on light |

All of these pass WCAG AA for normal text. Stone on lapis night is 2.63:1 and lapis on lapis night 1.61:1, so they
stay decoration and never mark a control. Gold, jade, ember and vermilion on vellum are all below 3:1, so they are
never text on light grounds.

- Every SVG carries a title and a description. The storybook uses the same words as alt text.
- Repeat any words from a banner or the cover as live text on the page.
- Never show meaning by color alone. ETH is a plain coin, HOARD a token with scales, a burn a fire, waiting fees a
  chest, and the words say it too.
- The art is still. If a site makes the fire flicker or the glints shine, keep it slow, never flash more than three
  times a second, and turn it off for people who ask for reduced motion.
- The pile, a share quote, the fees waiting and the contract address are selectable text, never only pictures.
  Controls are at least 44 by 44 px with a visible focus ring in gold.

## Homage and IP

- The idea nods to the guild banks of early on-chain clubs, where any member could leave at any time and take their
  share of the bank with them. Here, any holder can burn HOARD and take its share of the pile. The homage is in the
  idea only. The kit names no project, club or person, and copies no look, logo or wording from any of them.
- Dragons sleeping on piles of coins are an old idea found in many stories. The kit names no story, book, film, game
  or flag, and draws no known dragon. Only a tail is drawn, and it was made for this kit.
- All art here is original and drawn in code for this kit. Nothing is traced, downloaded or generated from other
  images, and the pictures use no font.
- No real brands, logos, products, people, mascots or characters. The coins are plain discs, and nothing copies the
  price coin's logo.
- ETH is written in plain text only where a sentence or a setting needs it. It never appears in a picture.
- Square Hole is named as the platform. This kit names no other Square Hole token or collection.
- HOARD is a common word, and other tokens may use the same ticker. Live pages always show the chain and the full
  contract address.
- Counsel still has to look at the pile and its share rule, the name and ticker, and the license for publishing this
  kit. See [details.md](details.md).
