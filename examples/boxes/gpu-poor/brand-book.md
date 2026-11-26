# GPU Poor brand book

## Identity

**Name:** GPU Poor. **Ticker:** VRAM. **Price coin:** $NVDA, Nvidia's stock. The exact setting is NVDAon, Ondo's
tokenized Nvidia stock. **In the box:** the token, with no items.

The ticker is VRAM, because the token is the VRAM the box burns. The example registry uses the same ticker. See
[details.md](details.md).

**Headline (the founder's words):** "Sell a stock to prop up a memecoin."

**One-sentence joke:** Too poor for a GPU, so it burns VRAM to stay warm.

**Story hook:** Every trade pays a small fee in $NVDA, Nvidia's stock. The box sells ten of every 15 fee parts in its
own pool for VRAM, and burns the VRAM. Buyers and sellers both feed the same fire.

"GPU poor" is internet slang for having too little computing power. VRAM is the memory on a graphics card. This box
cannot afford a graphics card at all, so all it has is the VRAM, and it keeps burning that to stay warm. Nvidia makes
GPUs, and the box is priced in Nvidia's stock. It still cannot afford a GPU. The joke is on the box. It is never on
Nvidia, never on the people who buy or sell, and never on anyone short of money.

The headline tells the fee's path. Money often leaves memecoins for stocks. Here ten of every 15 fee parts go from
$NVDA into a memecoin, VRAM, to burn. Wherever the headline appears, the literal line goes next to it: "In plain
words, ten of every 15 fee parts buy VRAM and burn it." A burn makes the supply smaller. It sets no price.

The box really uses Nvidia's stock, so the kit names it, the way people name a stock they trade. Text writes $NVDA,
and Nvidia where a sentence needs the company. The pictures may letter $NVDA. This is version 2 of the kit. Version 1
never named the stock and stays at the git tag `kit-gpu-poor-v1`.

## Voice and tone

We sound like a friend who builds computers from spare parts, explaining the box at a table. Thrifty, dry, a little
warm. Pictures and numbers come first, words second. We say what happens in the order it happens. When something
can go wrong, we say it plainly and leave the joke out.

- Use the plain words: fee, $NVDA, pool, burn, holder. Put the literal word next to every joke.
- Say how much of the fee buys VRAM to burn: ten of every 15 parts. Two go into the box's own pool and three go to
  Square Hole (its platform and its buy-back).
- In pictures and posts the price coin is $NVDA. Write NVDAon only where a setting needs it, and say once that it is
  Ondo's tokenized Nvidia stock.
- Write the names the same way every time: Nvidia for the company, $NVDA for the stock, NVDAon for the setting and
  Ondo for the issuer. Name Ondo only as the issuer.
- Every page or post that names $NVDA, Nvidia or Ondo carries the US persons line and the not-affiliated line. The
  box page also carries the issuer line. The X bio below already holds both lines.
- No urgency, no countdowns, no prices, and no talk about what VRAM or $NVDA might be worth.
- Never call anyone "GPU poor" except the box itself.
- Art lettering is in capitals. Everywhere else we write in sentence case.

| Where | Example line |
| --- | --- |
| Greeting | "Come in and warm up by the fire." |
| Cover | "Sell a stock to prop up a memecoin." |
| Next to the headline | "In plain words, ten of every 15 fee parts buy VRAM and burn it." |
| X bio | "Too poor for a GPU. Ten of 15 fee parts burn VRAM. The stock coin may not be offered to US persons. Nvidia and Ondo did not make, approve or endorse this box." |
| Pinned post | "Every trade pays a 1% fee in $NVDA. Ten of its 15 parts buy VRAM in the box's own pool, and that VRAM burns. The stock coin may not be offered to US persons. Nvidia and Ondo did not make, approve or endorse this box." |
| A burn step ran | "$NVDA in, VRAM out, VRAM burned." |
| Before graduation | "The fee coins wait in the jar until the box graduates." |
| No trades | "No trades, no fire. The room stays cold." |
| Risk line | "VRAM can lose all its value. A burn makes the supply smaller and sets no price." |
| Not a share | "VRAM is a memecoin. It is no share in Nvidia and no claim on one." |
| Issuer line | "Ondo can pause the stock coin. Then this box waits too." |
| US persons line | "The stock coin may not be offered to US persons." |
| Not affiliated | "Nvidia and Ondo did not make, approve or endorse this box." |

<!-- avoid-list:start -->
Words and shapes we never use: earn, yield, returns, gains, profit, income, passive, investment, moon, 100x,
APY, guaranteed, "get in early", "floor price", pump, unlock, seamless, revolutionary, journey. No dash asides,
no emoji decoration, and no prices, dates or wallet addresses in posts or pictures. The names are always Nvidia,
$NVDA, NVDAon and Ondo, never NVIDIA in capitals, a bare NVDA, $NVDAon or ONDO. Never Nvidia's logo or any part of
it, its green as a brand color, its product names such as GeForce, RTX, GTX or CUDA, or its CEO's name or face, and
never Ondo's logo. No other company names, such as other chip makers or graphics card brands.
<!-- avoid-list:end -->

`check.mjs` scans every doc, every SVG title and description, and every word the pictures draw for these words and
forms. The list above is the only place the avoided words may appear. Elsewhere a sentence names Nvidia's or Ondo's
logo, color or people only to say that the kit never uses them.

## Palette

The world seen through a heat camera. Cold things are ice blue. Warm things climb the heat ramp.

| Name | Hex | Use |
| --- | --- | --- |
| Night | `#0D0A1A` | Every background |
| Panel | `#1C1636` | GPU shrouds, chips, plates, jars |
| Rim | `#3B3170` | Outlines, frames, grilles. Decoration only |
| Ice | `#6CD8FF` | $NVDA, the stock coin, and everything cold |
| Violet | `#9A6BFF` | The cool end of the heat ramp, labels and links on dark |
| Magenta | `#FF4D8D` | Burns, sales, errors |
| Orange | `#FF8A2A` | Heat, and VRAM under the fee loop |
| Amber | `#FFC94A` | Hot spots, warnings |
| White-hot | `#FFF4DC` | The hottest point, text on dark |
| Paper | `#F5F1FF` | Light grounds |
| Deep violet | `#4A22B5` | Violet text and links on paper |

The heat ramp runs violet, magenta, orange, amber, white-hot, always in that order. A warm thing is a stack of
bands, cool outside and hot inside. Cold things are ice. In the story, ice discs with a small columned building
stand for $NVDA, and small dark chips with a warm middle stand for VRAM. A stock coin 160 px wide or more letters
$NVDA under its building in deep ice, `#174E70`. A smaller coin carries no letters, because they would not read in a
post. Where a scene names it, $NVDA goes under it in ice. When a page shows real balances, it also writes the coin's
name in text.

There is no green anywhere in the kit, Nvidia's brand green included. Green belongs to too many brands in this
space, and the kit stays clear of all of them. `check.mjs` refuses any green color in the palette or the docs.

## Typography

Live text uses three free font families under the SIL Open Font License 1.1, all on Google Fonts.

| Use | Family and weights | Fallback stack |
| --- | --- | --- |
| Titles | Quicksand, 600 to 700 | `"Quicksand", "Nunito", "Trebuchet MS", system-ui, sans-serif` |
| Body and buttons | Inter, 400 to 600 | `"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Numbers, counts, ids | DM Mono, 400 to 500 | `"DM Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Quicksand's round single strokes sit well next to the tube letters in the art. DM Mono keeps numbers the same
width, so amounts and counts line up.

The pictures need no font at all. Every letter in the art is drawn from the kit's own tube alphabet, described in
[art-notes.md](art-notes.md), and that includes the dollar sign of $NVDA. This kit ships no font files. A site that
uses these fonts self-hosts pinned files with their license notice. Body text is at least 16 px with a line height
of 1.5.

## Logo

The mark is a VRAM chip that runs hot. A dark square chip has four pins on each side and a flame in its middle,
banded violet, magenta, orange, amber and white-hot. It sits on a night square. The files are `art/logo.svg` and
`art/logo.png` (1024), `art/x-avatar.png` (400) and `art/logo-48.png`, which shows the mark still reads at 48 px.

- **Construction.** The square is 32 modules wide. One module is 32 px on the 1024 px logo. The chip is 16 by 16
  modules with corners rounded at 1.8. The pins are 1.3 by 2.6 modules, four on each side, 3.5 modules apart. The
  flame is 9.6 modules wide and 11.8 tall, with its base 5.6 modules below the centre.
- **Clear space.** Keep at least 2 modules free beyond the pins on every side. The square files already include
  it. In a round crop the whole chip, pins and all, sits inside the circle.
- **Smallest size.** 48 px. Below that, write VRAM in live text instead.
- **Keep** the night square, the chip, the pins and the flame together, and keep the flame's bands in ramp order.
- **Don't** recolor the flame, put letters, VRAM or $NVDA on the chip, stretch, rotate or outline the mark, or set it
  on a light ground without its night square. The mark is the token, VRAM, and it stays the same in version 2.

On the X banner, the bottom-left corner (x 0 to 420, y 270 to 500) is plain ground, and the frame leaves that corner
out, so the avatar can overlap it. Keep important parts at least 60 px from every edge. The names under the fee loop
keep that distance too. The wide box banner can be cropped on narrow screens, so the page also shows the name in live
text.

## Do and don't

| Do | Don't |
| --- | --- |
| Draw the world through the heat camera, cold things in ice and warm things in heat bands | No green, no part of Nvidia's or Ondo's logos, and no colors, logos or shapes of any other chip maker or card brand |
| Draw every letter from the tube alphabet, $NVDA included | Write Nvidia, Ondo or NVDAon in a picture. A picture names the stock only as $NVDA |
| Show $NVDA as an ice disc with a small columned building, and letter $NVDA on coins 160 px wide or more and under smaller ones | Use a real coin logo, a stock chart, a ticker tape or a banknote |
| Show VRAM as small chips, and a burn as chips breaking up in the fire | Draw people, mascots, characters or faces, Nvidia's CEO included, and never let fans look like eyes |
| Name the two coins under the fee loop and in the first scene, $NVDA in ice and VRAM in orange | Name a GPU, an item or a post after one of Nvidia's products |
| Put each fee picture next to its caption | Show prices, charts, rockets or anything rising in value |
| Put the literal line next to the headline | Say a burn holds up a price, or that $NVDA backs VRAM |
| Put the US persons line and the not-affiliated line with every page or post that names $NVDA | Say or show that Nvidia or Ondo made, approved or endorsed the box |
| Keep the joke on the box | Make fun of Nvidia, buyers, sellers or anyone short of money |

## Accessibility

Contrast ratios for the solid colors, by the WCAG 2.2 formula:

| Pair | Ratio | Use |
| --- | --- | --- |
| White-hot on night | 17.88:1 | Body text on dark |
| Paper on night | 17.58:1 | Body text on dark |
| Amber on night | 12.74:1 | Warnings and hot labels on dark |
| Ice on night | 12.00:1 | Stock coin labels on dark, $NVDA under the fee loop |
| Orange on night | 8.30:1 | Large text on dark, VRAM under the fee loop |
| Magenta on night | 6.23:1 | Errors and burn labels on dark |
| Violet on night | 5.51:1 | Labels and links on dark |
| Night on amber | 12.74:1 | Letters on an amber button |
| Night on ice | 12.00:1 | Letters on an ice button |
| Night on paper | 17.58:1 | Body text on light |
| Deep violet on paper | 8.65:1 | Links on light |
| Deep ice on ice | 5.47:1 | $NVDA lettered on the stock coin, in the art only |

All of these pass WCAG AA for normal text. Rim on night is 1.73:1, so it stays decoration and never marks a control.
Ice, amber, orange, magenta and violet on paper are all below 4.5:1, so they are never text on light grounds.

- Every SVG carries a title and a description. The storybook uses the same words as alt text.
- Repeat any words from a banner or the cover as live text on the page, $NVDA and VRAM included.
- Never show hot or cold by color alone. The stock coin is a disc with a building, VRAM is a chip, a burn is a
  flame, and the words say it too.
- The art is still. If a site makes the fire flicker or the fans spin, keep it slow, never flash more than three
  times a second, and turn it off for people who ask for reduced motion.
- Amounts, burn counts and the contract address are selectable text, never only pictures. Controls are at least
  44 by 44 px with a visible focus ring in amber or ice.

## Homage and IP

- The idea nods to the "GPU poor" meme about having too little computing power, and to the years when Ethereum
  was mined with graphics cards. Both are common culture. The homage is in the idea only.
- The price coin is $NVDA, Nvidia's stock, as NVDAon, Ondo's tokenized Nvidia stock. The box really uses it, so the
  kit names it. Text writes $NVDA, and Nvidia where a sentence needs the company. The pictures may letter $NVDA in the
  tube alphabet, on a big stock coin, under small ones and under the fee loop.
- The kit never uses Nvidia's logo or any part of it, its brand green, its product names as branding, or its CEO's
  name or likeness. It never uses Ondo's logo. The pictures never letter Nvidia, Ondo or NVDAon.
- Nvidia and Ondo did not make, approve or endorse this box. That line goes with every page or post that names
  $NVDA, Nvidia or Ondo.
- NVDAon is written only where a setting needs it, and never in a picture.
- All art here is original and drawn in code for this kit. Nothing is traced, downloaded or generated from other
  images, and the pictures use no font.
- Apart from the $NVDA lettering, the art shows no real brand, logo, product, person, mascot or character. The GPU is
  a plain card, a box with round fans, a bracket and gold contacts. It copies no real card's shroud, model name,
  number or logo.
- Square Hole is named as the platform. This kit names no other Square Hole token or collection.
- VRAM is a common computing word, and other tokens may use the same ticker. Live pages always show the chain and
  the full contract address.
- Counsel still has to look at the headline, $NVDA as the price coin, naming Nvidia and Ondo and lettering $NVDA in
  the art, the name and ticker, and the license for publishing this kit. See [details.md](details.md).
