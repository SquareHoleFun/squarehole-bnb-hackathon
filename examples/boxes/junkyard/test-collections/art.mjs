// Original public workshop drawings. No fonts, external assets, brands or hidden editions.
export const collections = [
  { key: 'bent-cans', name: 'Test Junk Bent Cans', symbol: 'tJCAN', color: '#d47b43', material: 'Tin' },
  { key: 'lost-cogs', name: 'Test Junk Lost Cogs', symbol: 'tJCOG', color: '#baa059', material: 'Iron' },
  { key: 'split-boots', name: 'Test Junk Split Boots', symbol: 'tJBOOT', color: '#8c9b76', material: 'Rubber' },
  { key: 'cracked-mugs', name: 'Test Junk Cracked Mugs', symbol: 'tJMUG', color: '#73a7ac', material: 'Ceramic' },
  { key: 'tangled-wires', name: 'Test Junk Tangled Wires', symbol: 'tJWIRE', color: '#b48791', material: 'Copper' },
];
const ink = '#263b39';
const path = (d, fill = 'none', width = 7) => `<path d="${d}" fill="${fill}" stroke="${ink}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
const circle = (x, y, r, fill, width = 7) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${ink}" stroke-width="${width}"/>`;
function object(kind, color, variant) {
  switch (kind) {
    case 0: return path('M-84 -114 Q0 -138 84 -114 L76 -38 49 2 79 28 70 125 Q0 144 -70 125 L-85 47 -55 10 -82 -20Z', color)
      + `<ellipse cx="0" cy="-114" rx="84" ry="21" fill="#ded5af" stroke="${ink}" stroke-width="7"/>`
      + path('M-65 -65 L59 -65 M-57 82 L56 82 M-35 -8 L17 3 -11 35 48 47', 'none', 5)
      + circle(-25, -114, 12, ink, 0) + path(variant === 1 ? 'M25 -53 L50 -43' : 'M-35 66 L5 56 40 65', 'none', 4);
    case 1: return `<g transform="rotate(${variant === 1 ? 12 : -8})">`
      + Array.from({ length: 10 }, (_, i) => `<g transform="rotate(${i * 36})">${path('M-21 -87 L-21 -131 21 -131 21 -87Z', color)}</g>`).join('')
      + circle(0, 0, 103, color) + circle(0, 0, 39, '#e9e1c9')
      + path('M50 -81 L70 -57 54 -33 85 -16', 'none', 5)
      + [0, 120, 240].map(a => `<g transform="rotate(${a})">${circle(0, -69, 9, '#e9e1c9', 4)}</g>`).join('') + '</g>';
    case 2: return path('M-71 -126 L20 -126 30 -24 Q38 8 97 23 Q130 27 133 72 L130 103 -108 103 -101 25 -82 4Z', color)
      + path('M-108 103 L-113 129 -42 129 -22 110 -4 129 130 129 134 103Z', '#d1b98b')
      + path('M-69 -99 L21 -99 M-68 -72 L22 -72 M-65 -45 L25 -45 M-61 -18 L33 -18', 'none', 5)
      + path(variant === 1 ? 'M62 44 L45 61 62 78 48 99' : 'M-69 35 L-51 57 -67 78', '#e9e1c9', 5);
    case 3: return path('M65 -63 Q149 -85 145 -2 Q143 62 74 55 L75 18 Q112 26 113 -10 Q112 -44 77 -29Z', '#e9e1c9')
      + path('M-97 -94 L85 -94 77 104 Q-1 144 -83 104Z', color)
      + `<ellipse cx="-6" cy="-94" rx="91" ry="22" fill="#e9e1c9" stroke="${ink}" stroke-width="7"/>`
      + path('M-32 -93 L-18 -59 -42 -24 -16 7 -30 38 -6 76', 'none', 6)
      + path(variant === 1 ? 'M14 98 L40 91' : 'M-77 80 L-62 88', 'none', 5);
    default: return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">`
      + ['M-117 -91 C104 -165 151 107 -8 110 C-170 112 -126 -102 31 -73 C178 -51 139 115 27 102',
        'M-76 -116 C-143 82 166 133 90 -59 C33 -167 -139 -18 -64 80 C-9 151 135 69 111 -91']
        .map(d => `<path d="${d}" stroke="${ink}" stroke-width="22"/><path d="${d}" stroke="${color}" stroke-width="12"/>`).join('')
      + '</g>' + path('M-129 -112 L-104 -103 -117 -69 -142 -77Z', '#d1b98b')
      + path('M101 -117 L124 -114 119 -82 97 -86Z', '#d1b98b')
      + path('M109 -116 L112 -137 M120 -115 L126 -134', 'none', 5)
      + circle(variant === 1 ? -38 : 42, 27, 13, ink, 0);
  }
}
export function pieces() {
  return collections.flatMap((collection, kind) => [1, 2].map(variant => {
    const marks = Array.from({ length: 7 }, (_, i) => path(`M${64 + i * 64} 52 V460 M52 ${64 + i * 64} H460`, 'none', 1)).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img">`
      + `<title>${collection.name} ${variant}</title><desc>Public test stand-in: a discarded ${collection.key.replaceAll('-', ' ')} workshop object. No issuer or brand.</desc>`
      + '<rect width="512" height="512" fill="#e9e1c9"/><g opacity="0.1">' + marks + '</g>'
      + `<rect x="24" y="24" width="464" height="464" rx="30" fill="none" stroke="${ink}" stroke-width="3"/>`
      + '<ellipse cx="258" cy="407" rx="133" ry="17" fill="#c5bca3"/>'
      + `<g transform="translate(252 254) rotate(${variant === 1 ? -9 : 9})">${object(kind, collection.color, variant)}</g>`
      + `<path d="M48 54 H122 V102 H48Z" fill="${collection.color}" stroke="${ink}" stroke-width="3"/>`
      + Array.from({ length: kind + 1 }, (_, i) => path(`M${59 + i * 12} 66 V89`, 'none', 5)).join('')
      + [0, 1, 2].map(i => circle(406 + i * 18, 451, 4, i < variant ? ink : '#e9e1c9', 2)).join('')
      + '</svg>\n';
    return { kind, variant, base: `art/${collection.key}/${variant}`, svg };
  }));
}
