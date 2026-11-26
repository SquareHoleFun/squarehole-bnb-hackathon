// The kit's one picture: an original shop front drawn from plain shapes. Coordinates are pixels, never amounts.
// No fonts, letters, external images or brand marks; the window shows one generic framed picture (one collection).
export const C = Object.freeze({ night: '#1d2b45', ink: '#101828', cream: '#f6efdc', mustard: '#f0b93a', sky: '#bfe0dc', leaf: '#4f9a7c' });
const { night, ink, cream, mustard, sky, leaf } = C;
const line = (stroke, sw) => (sw ? ` stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"` : '');
const rect = (x, y, w, h, fill, sw = 0, r = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${line(ink, sw)}/>`;
const circle = (x, y, r, fill, sw = 0) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"${line(ink, sw)}/>`;
const polygon = (points, fill) => `<polygon points="${points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${fill}"/>`;

/** Eight awning stripes with a scallop each: outlined scallops first, the stripes over their tops, then one outline. */
function awning() {
  const top = 300; const bottom = 430; const left = 172; const stripes = 8; const w = 85;
  const fill = i => (i % 2 ? cream : mustard);
  const scallops = Array.from({ length: stripes }, (_, i) => circle(left + i * w + w / 2, bottom, w / 2, fill(i), 12)).join('');
  const bands = Array.from({ length: stripes }, (_, i) => rect(left + i * w, top, w, bottom - top, fill(i))).join('');
  return scallops + bands + rect(left, top, stripes * w, bottom - top, 'none', 14, 4) + rect(150, 270, 724, 36, night, 14, 10);
}

/** The window holds one framed picture, a sun over two hills: a stand-in for any one collection's item. */
function windowWithPicture() {
  return rect(252, 520, 320, 250, sky, 14, 10)
    + rect(322, 562, 180, 166, cream, 0, 6)
    + circle(452, 606, 22, mustard)
    + polygon([[334, 716], [386, 640], [428, 698], [454, 670], [490, 716]], leaf)
    + rect(322, 562, 180, 166, 'none', 10, 6);
}

const door = () => rect(612, 520, 160, 320, mustard, 14, 8) + rect(642, 556, 100, 112, sky, 10, 6) + circle(742, 704, 12, ink);

export function logoSvg() {
  // The shop spans y 270 to 864; moving it up 55 px centres it on the square.
  const shop = rect(196, 420, 632, 420, cream, 16, 6)
    + awning() + windowWithPicture() + door()
    + rect(140, 834, 744, 30, ink, 0, 15);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img"><title>One-collection shop mark</title><desc>A shop front with a striped awning, a door and one framed picture in the window: a shop for one outside collection.</desc>${rect(0, 0, 1024, 1024, night)}<g transform="translate(0 -55)">${shop}</g></svg>\n`;
}

/** Every committed picture of the kit, by its path without extension. */
export const pieces = () => [{ base: 'art/logo', w: 1024, h: 1024, svg: logoSvg() }];
