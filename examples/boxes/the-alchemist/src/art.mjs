// Original geometric workshop illustrations. Coordinates are pixels, never financial amounts.
export const C = Object.freeze({ paper: '#f3e5c3', ink: '#193833', gold: '#e5ac37', light: '#ffda77', lead: '#84969c', shade: '#516a71', green: '#65a38b', rust: '#c66540', white: '#fff5db' });
const { paper, ink, gold, light, lead, shade, green, rust, white } = C;
const rect = (x, y, w, h, fill, radius = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"/>`;
const path = (d, fill = 'none', stroke = ink, sw = 6) => `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
const circle = (x, y, r, fill, stroke = ink, sw = 5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const group = (x, y, scale, body) => `<g transform="translate(${x} ${y}) scale(${scale})">${body}</g>`;
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

// A small drawn alphabet: no fonts, external images or company lettering.
const GLYPHS = {
  A: ['01110','10001','10001','11111','10001','10001','10001'], B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'], D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'], F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'], J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'], L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'], N: ['10001','11001','11001','10101','10011','10011','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'], P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'], R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'], T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'], V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  0: ['01110','10001','10011','10101','11001','10001','01110'], 1: ['00100','01100','00100','00100','00100','00100','01110'],
  2: ['01110','10001','00001','00010','00100','01000','11111'], 3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['10010','10010','10010','11111','00010','00010','00010'], 5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'], 7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'], 9: ['01110','10001','10001','01111','00001','00001','01110'],
};
function letters(label, x, y, size, fill = ink) {
  return [...label].map((ch, i) => {
    if (ch === ' ') return '';
    if (!GLYPHS[ch]) throw new Error(`undrawn letter: ${ch}`);
    return GLYPHS[ch].map((row, r) => [...row].map((bit, c) => bit === '1' ? rect(x + (i * 6 + c) * size, y + r * size, size, size, fill) : '').join('')).join('');
  }).join('');
}
const star = (x, y, s, fill = gold) => group(x, y, s, path('M0 -28 Q5 -5 28 0 Q5 5 0 28 Q-5 5 -28 0 Q-5 -5 0 -28Z', fill, fill, 1));
const coin = (x, y, r, fill = gold) => circle(x, y, r, fill) + circle(x, y, r * .72, 'none', ink, 2) + path(`M${x-r*.3} ${y-r*.45} L${x+r*.25} ${y-r*.45}`, 'none', white, 3);
function ingot(x, y, s = 1, fill = lead) {
  return group(x, y, s, path('M-95 10 L-65 -48 H65 L95 10 L65 43 H-65Z', fill) + path('M-95 10 H95 M-65 -48 L-40 10 M65 -48 L40 10', 'none', ink, 4) + path('M-48 -34 H45', 'none', white, 4));
}
function flask(x, y, s = 1, fill = gold) {
  return group(x, y, s, path('M-42 -148 H42 V-72 L126 80 Q141 118 100 126 H-100 Q-141 118 -126 80 L-42 -72Z', paper)
    + path('M-74 -8 H74 L121 84 Q134 115 100 118 H-100 Q-134 115 -121 84Z', fill, 'none')
    + path('M-52 -148 H52 M-40 -120 H40 M-96 66 L-68 12', 'none', ink, 8)
    + circle(-44, 54, 12, 'none', white, 4) + circle(42, 82, 19, 'none', white, 4)
    + path('M-42 -148 H42 V-72 L126 80 Q141 118 100 126 H-100 Q-141 118 -126 80 L-42 -72Z'));
}
const arrow = (x, y, length, color = ink) => path(`M${x} ${y} h${length} m-18 -16 l18 16 -18 16`, 'none', color, 7);
function pile(x, y, s = 1) {
  return group(x, y, s, path('M-180 96 Q0 150 180 96', 'none', ink, 6)
    + [[-90,60],[-30,60],[30,60],[90,60],[-60,0],[0,0],[60,0],[-30,-60],[30,-60],[0,-120]].map(([a,b])=>coin(a,b,35)).join(''));
}
function furnace(x, y, s = 1) {
  return group(x, y, s, rect(-140,-150,280,310,ink,100) + rect(-160,120,320,40,shade,8)
    + path('M-95 100 Q-130 30 -50 -50 Q-40 0 0 -110 Q95 -35 105 35 Q120 120 30 120 H-30Z', rust, 'none')
    + path('M-40 102 Q-60 55 0 -5 Q0 35 30 5 Q85 105 15 112Z', gold, 'none'));
}
function frame(w, h, title, desc, body, dark = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"><title>${escape(title)}</title><desc>${escape(desc)}</desc>${rect(0,0,w,h,dark ? ink : paper)}${body}</svg>\n`;
}
function border(w,h) {
  return `<rect x="28" y="28" width="${w-56}" height="${h-56}" rx="8" fill="none" stroke="${ink}" stroke-width="3"/>`
    + [72,w-72].flatMap(x=>[72,h-72].map(y=>circle(x,y,5,ink,'none'))).join('');
}
function mark(x, y, s) {
  return group(x,y,s, circle(0,0,200,paper,light,8) + flask(0,20,1.05, gold)
    + ingot(-50,72,.52,lead) + star(100,-100,.9) + star(-108,-55,.45));
}

export const SCENES = [
  { n:'01', title:'THE START', desc:'A grey lead ingot and an empty vessel. LEAD names the box token; the pile starts empty.', caption:'LEAD is the box token. The gold pile starts empty.', draw:()=> ingot(305,600,1.65) + arrow(500,610,130) + flask(830,590,1.45,paper) },
  { n:'02', title:'FEES WAIT', desc:'Green fee coins drop into a sealed vessel beside a clock. Fees wait for graduation.', caption:'Buyers\' fees and inbox money feed the buyers\' choice. Conversion waits until graduation.', draw:()=>coin(360,400,52,green)+coin(420,530,42,green)+flask(620,670,1.5,green)+rect(540,437,160,22,ink,4)+circle(895,470,72,paper)+path('M895 425 V470 L925 490') },
  { n:'03', title:'ONE FIXED ROUTE', desc:'Three vessels joined in order: green price coin, pale intermediate coin and gold output. The route is fixed.', caption:'The route idea is PEPE to WETH to gold. On Sepolia, use Test PEPE and Test Gold stand-ins.', draw:()=>flask(240,620,.95,green)+arrow(380,620,90)+flask(600,620,.95,white)+arrow(740,620,90)+flask(960,620,.95,gold)+letters('PRICE',155,835,5)+letters('WETH',540,835,5)+letters('GOLD',900,835,5) },
  { n:'04', title:'GOLD JOINS', desc:'The output vessel pours gold coins onto a pile. Only delivered gold counts in the pile.', caption:'A successful Alchemist step buys gold and adds it to the pile. Pending fees are not gold yet.', draw:()=>flask(330,520,1.1,gold)+arrow(495,610,120)+coin(670,450,32)+coin(720,545,30)+pile(840,725,1.35)+star(950,440,1) },
  { n:'05', title:'SELLERS BURN', desc:'A grey LEAD coin enters a rust-red furnace. The gold pile remains separate.', caption:'Sellers\' fee share buys LEAD in the box\'s pool and burns it. This is a separate fee choice.', draw:()=>coin(285,420,70,lead)+arrow(280,550,150)+furnace(570,690,1.15)+pile(970,760,.65) },
  { n:'06', title:'TAKE A SHARE', desc:'Twenty gold coins form an illustrative share. Nineteen are grouped for the holder; one stays behind.', caption:'Hand in LEAD after graduation for its share of the pile. Five percent of a normal share stays for remaining holders, subject to raw-unit rounding.', draw:()=> rect(130,370,730,490,white,28)+rect(890,370,180,490,ink,28)+Array.from({length:19},(_,i)=>coin(215+(i%5)*131,450+Math.floor(i/5)*108,36)).join('')+coin(980,615,49)+letters('19 LEAVE',210,900,6)+letters('1 STAYS',890,900,4) },
  { n:'07', title:'YOUR NEXT RECIPE', desc:'An open recipe book holds a lead ingot, a green fee vessel and a gold pile. Change the ingredients only in a new reviewed recipe.', caption:'Reuse the pattern with other admitted coins and a reviewed fixed route. Each new box keeps the coins and route chosen at creation.', draw:()=>path('M140 410 Q350 340 600 415 Q850 340 1060 410 V860 Q840 790 600 865 Q350 790 140 860Z',white)+path('M600 415 V865')+ingot(360,520,.8)+flask(355,720,.6,green)+pile(830,665,.75)+star(980,490,.8) },
];
function scene(s) {
  return frame(1200,1200,`The Alchemist: ${s.title.toLowerCase()}`,s.desc,border(1200,1200)
    + letters('THE ALCHEMIST',100,105,5) + letters(s.n,980,100,8) + path('M100 195 H1100')
    + letters(s.title,100,235,s.title.length > 14 ? 8 : 10) + s.draw()
    + path('M100 1025 H1100') + letters('LEAD INTO GOLD',100,1075,5) + star(1060,1090,.5));
}
export function pieces() {
  return [
    { base:'art/logo', w:1024,h:1024,svg:frame(1024,1024,'The Alchemist mark','A workshop flask holds a grey lead ingot and gold liquid, with two sparks. An original metaphor for converting fees.',mark(512,512,1.8),true) },
    { base:'art/cover',w:1200,h:630,svg:frame(1200,630,'The Alchemist: lead into gold','A lead ingot, a fee vessel and a gold pile on a workshop bench. Buyers fees buy the pile coin.',border(1200,630)+letters('THE ALCHEMIST',80,80,10)+letters('LEAD INTO GOLD',82,188,5)+ingot(260,395,1.1)+arrow(390,400,110)+flask(640,395,.9,gold)+arrow(790,400,90)+pile(1005,440,.7)+letters('A COIN PILE RECIPE',80,540,4)) },
    { base:'art/box-banner',w:2400,h:600,svg:frame(2400,600,'The Alchemist box banner','The workshop mark, the name The Alchemist and a grey ingot becoming a gold pile. Illustration, not a promised return.',mark(290,300,1.12)+letters('THE ALCHEMIST',620,170,15,paper)+letters('LEAD INTO GOLD',624,350,7,light)+ingot(1900,320,1.2)+arrow(2050,330,80,paper)+pile(2260,370,.65),true) },
    ...SCENES.map(s=>({base:`art/scenes/scene-${s.n}`,w:1200,h:1200,svg:scene(s)})),
  ];
}
