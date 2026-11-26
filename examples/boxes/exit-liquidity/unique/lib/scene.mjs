// Shared authored forms in the kit's 1024 px coordinate system. No id or random noise enters the art.
import { C } from '../../src/palette.mjs';
import { VARIANTS } from '../../src/items.mjs';
import { signBox } from '../../src/sign.mjs';
import { validateTraits } from '../deal.mjs';

export const PIXELS_PER_UNIT = 800;
export const FLOOR = 908;
const rectangle = (x, y, w, h) => [[x,y], [x+w,y], [x+w,y+h], [x,y+h]];
const disc = (x, y, r, n = 12) => Array.from({ length: n }, (_, i) => [x+r*Math.cos(i*2*Math.PI/n), y+r*Math.sin(i*2*Math.PI/n)]);
const bevel = (x, y, w, h, r = 8) => [[x+r,y],[x+w-r,y],[x+w,y+r],[x+w,y+h-r],[x+w-r,y+h],[x+r,y+h],[x,y+h-r],[x,y+r]];

export function scene(traits) {
  validateTraits(traits);
  const variant = VARIANTS.find(v => v.n === traits.sign);
  const parts = [], lamps = [], panels = [];
  const add = (points, color, back, front, extra = {}) => {
    const part = { points, color, back, front, ...extra }; parts.push(part); return part;
  };
  const rect = (x,y,w,h,color,back=0,front=6,extra) => add(rectangle(x,y,w,h),color,back,front,extra);
  const circle = (x,y,r,color,back=0,front=6,n=12) => add(disc(x,y,r,n),color,back,front);
  const box = (x,y,w,h,color,back,front,r=8) => add(bevel(x,y,w,h,r),color,back,front);
  const line = (points, width, color, back=0, front=6) => {
    for(let i=1;i<points.length;i++) {
      const [a,b] = [points[i-1],points[i]], dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy);
      if (!l) continue;
      const nx=-dy/l*width/2,ny=dx/l*width/2;
      add([[a[0]+nx,a[1]+ny],[a[0]-nx,a[1]-ny],[b[0]-nx,b[1]-ny],[b[0]+nx,b[1]+ny]],color,back,front);
    }
  };
  const pipe = points => { line(points,22,C.ink,-58,-36); line(points,12,C.rim,-36,-28); };
  const frame = (x,y,w,h,color=C.slate,z=0) => {
    box(x,y,w,h,C.ink,z,z+10);
    box(x+7,y+7,w-14,h-14,color,z+10,z+14,4);
  };
  const bolts = (x,y,w,h,z) => { for(const dx of [12,w-12]) for(const dy of [12,h-12]) circle(x+dx,y+dy,4,C.paper,z,z+3,6); };
  // A cropped hallway section gives the hanging signs a physical support and one shared ground.
  box(112,108,800,784,C.rim,-90,-70);
  rect(124,120,776,760,C.ink,-70,-60);
  rect(112,108,800,16,C.slate,-60,-30);
  box(82,880,860,28,C.ink,-130,140,6);
  rect(94,880,836,14,C.rim,140,148);

  const brickwork = (x,y,w,h) => {
    rect(x,y,w,h,C.ink,-59,-52);
    for(let row=0;row<Math.floor(h/40);row++) {
      const offset=row%2?40:0;
      for(let col=-1;col<Math.ceil(w/80);col++) {
        const left=Math.max(x,x+col*80+offset),right=Math.min(x+w,x+(col+1)*80+offset-5);
        if(right-left>5)rect(left,y+row*40+3,right-left,32,C.slate,-52,-42);
      }
    }
  };
  if(traits.sign==='03') brickwork(132,135,760,725);
  if(traits.sign==='01') {
    const arch = (x,y,w,h) => [[x,y+h],[x,y+w/2],...Array.from({length:9},(_,i)=>[x+w/2+w/2*Math.cos(Math.PI+i*Math.PI/8),y+w/2+w/2*Math.sin(Math.PI+i*Math.PI/8)]),[x+w,y+h]];
    // Convex arch has a straight bottom; remove the duplicated left curve endpoint.
    add(arch(473,766,78,114).filter((p,i)=>i!==1),C.rim,-60,-30);
    add(arch(481,776,62,104).filter((p,i)=>i!==1),C.slate,-30,-24);
    circle(529,840,5,C.amber,-24,-19,8);
  }
  if(traits.sign==='05') {
    // Painted door is thin raised paint in the model, never a real opening.
    for(let y=554;y<864;y+=36)for(const x of [397,627])rect(x,y,7,22,C.paper,-59,-58);
    for(let x=397;x<634;x+=36)rect(x,554,22,7,C.paper,-59,-58);
    line([[425,690],[425,586],[601,586],[601,690],[425,690]],5,C.rim,-59,-58);
    circle(599,744,8,C.paper,-58,-57,8);
  }
  if(traits.sign==='08') {
    frame(382,540,260,340,C.ink,-60);
    line([[389,880],[389,547],[635,547],[635,880]],7,C.rim,-45,-40);
    brickwork(396,554,232,326);
  }
  const hatch = (x,y,w,h,z) => {
    frame(x,y,w,h,C.slate,z); bolts(x,y,w,h,z+15);
    rect(x+w*0.32,y+h/2-4,w*0.36,8,C.rim,z+14,z+25);
  };
  if(traits.sign==='07') hatch(362,814,300,56,-20);
  if(traits.sign==='09') hatch(372,132,280,74,-60);

  // Power feeds end at junction boxes. Nothing suggests a functioning exit.
  const cableY=680;
  if(['left','twin'].includes(traits.conduit))pipe([[192,800],[192,220],[310,220]]);
  if(['right','twin'].includes(traits.conduit))pipe([[832,800],[832,244],[714,244]]);
  if(traits.conduit==='loop')pipe([[192,800],[192,cableY],[252,cableY],[252,576],[160,576],[160,212],[310,212]]);
  for(const x of traits.conduit==='twin'?[192,832]:[traits.conduit==='right'?832:192]) {
    frame(x-22,780,44,66,C.slate,-58);
    circle(x,804,6,C.amber,-44,-38,8);
    rect(x-10,822,20,5,C.rim,-44,-38);
  }

  for(const original of variant.signs) {
    const s={cx:512, ...original};
    const {x,y,w,h,fx,fy,fw,fh,block}=signBox(s);
    const lit=C[s.color];
    lamps.push({cx:s.cx,cy:s.cy,w,h,color:lit,at:parts.length});
    // Original mount type and proportions survive. Supports meet the wall section.
    if(s.mount==='rods') for(const dx of [0.2,0.8]) {
      rect(x+w*dx-4,120,8,y-116,C.rim,-58,12);
      rect(x+w*dx-12,120,24,8,C.rim,-58,18);
    }
    if(s.mount==='bracket') {
      rect(s.cx-5,y-40,10,44,C.rim,-58,12);
      rect(s.cx-34,y-48,68,12,C.rim,-58,18);
    }
    if(s.mount==='flag') {
      rect(124,y-66,18,92,C.rim,-58,6);
      rect(124,y-46,x+w*0.8-124,12,C.rim,-20,14);
      for(const dx of [0.22,0.78])rect(x+w*dx-4,y-40,8,44,C.rim,-20,14);
    }
    if(s.mount==='chain') {
      for(const [cx,end] of [[x+14,y+6],[x+w-14,254]]) {
        for(let cy=126;cy<end-10;cy+=23) {
          line([[cx-5,cy],[cx-5,cy+16],[cx+5,cy+16],[cx+5,cy],[cx-5,cy]],4,C.rim,-5,2);
        }
      }
    }
    const start=parts.length;
    if(traits.housing==='visor') {
      box(x-20,y-22,w+40,36,C.ink,0,66,6);
      rect(x-12,y-20,w+24,12,C.rim,66,72);
    }
    if(traits.housing==='fins') for(let i=0;i<4;i++) {
      rect(x-28,y+22+i*(h-54)/3,28,14,C.rim,0,38);
      rect(x+w,y+22+i*(h-54)/3,28,14,C.rim,0,38);
    }
    box(x-6,y-6,w+12,h+12,C.ink,-16,34,12);
    box(x,y,w,h,C.rim,34,40,10);
    box(x+4,y+4,w-8,h-8,C.slate,40,44,8);
    const panel=box(fx,fy,fw,fh,s.style==='box'?lit:C.ink,44,48,6);
    panel.face=s; panels.push(panel);
    if(traits.housing==='guards') for(const [cx,cy] of [[x-34,y-34],[x+w-4,y-34],[x-34,y+h-4],[x+w-4,y+h-4]]) {
      box(cx,cy,38,38,C.ink,40,57,6); rect(cx+6,cy+6,26,26,C.rim,57,60);
    }
    // Exact kit glyph cells, at the original module size and position. The picture uses
    // src/sign.mjs itself; these raised forms supply the same letters to the GLB.
    const ox=s.cx-block.cols*s.m/2, oy=s.cy-block.rows*s.m/2;
    if(s.style==='led') {
      for(const cell of block.cells.filter(cell=>!s.burnt?.(cell))) {
        add(disc(ox+(cell.c+0.5)*s.m,oy+(cell.r+0.5)*s.m,0.39*s.m,6),lit,48,51,{modelOnly:true,dome:true});
      }
      for(const cell of s.flicker??[]) {
        add(disc(ox+(cell.c+0.5)*s.m,oy+(cell.r+0.5)*s.m,0.36*s.m,6),C.red,48,51,{modelOnly:true,dome:true});
      }
    } else {
      // Merge equal runs across adjacent rows into bars, without changing the glyph outline.
      const cells=new Set(block.cells.map(({c,r})=>`${s.mirror?block.cols-1-c:c},${r}`));
      const bars=[];
      for(let r=0;r<block.rows;r++)for(let c=0;c<block.cols;c++) {
        if(!cells.has(`${c},${r}`))continue;
        const left=c;
        while(c+1<block.cols&&cells.has(`${c+1},${r}`))c++;
        const width=c-left+1,previous=bars.find(b=>b.left===left&&b.width===width&&b.top+b.height===r);
        if(previous)previous.height++;
        else bars.push({left,top:r,width,height:1});
      }
      for(const b of bars)rect(ox+b.left*s.m,oy+b.top*s.m,b.width*s.m,b.height*s.m,C.ink,48,51,{modelOnly:true});
    }
    // Repairs sit outside the face, including the smallest dual-sign housing.
    if(traits.repair==='patch') {
      frame(x-38,y+h*0.42,42,66,C.rim,54);
      bolts(x-38,y+h*0.42,42,66,69);
    }
    if(traits.repair==='staples') for(const cy of [y+h*0.25,y+h*0.7]) {
      rect(x+w-4,cy,28,12,C.paper,54,66);
      rect(x+w+12,cy,12,26,C.rim,44,54);
    }
    if(traits.repair==='tape') {
      line([[x-20,y+28],[x+28,y-20]],16,C.paper,58,traits.housing==='visor'?76:63);
      line([[x+w-28,y+h+20],[x+w+20,y+h-28]],16,C.paper,58,63);
    }
    if(traits.repair==='clean')for(const cx of [x+10,x+w-10])circle(cx,y+h-9,3,C.paper,44,49,6);
    if(s.tilt) {
      const radians=s.tilt*Math.PI/180, pivot=[x+0.8*s.m,y+0.3*s.m];
      for(const part of parts.slice(start))part.points=part.points.map(([px,py])=>{
        const dx=px-pivot[0],dy=py-pivot[1];
        return [pivot[0]+dx*Math.cos(radians)-dy*Math.sin(radians),pivot[1]+dx*Math.sin(radians)+dy*Math.cos(radians)];
      });
    }
  }

  // A small wall plate below every sign, left of the doors and floor equipment.
  // Its path never shares the sign face or adds words/numbers to the kit.
  frame(244,720,128,80,C.slate,-50);
  const routes={
    dogleg:[[260,779],[294,779],[294,741],[351,741]],
    switchback:[[260,779],[260,741],[304,741],[304,779],[351,779]],
    fork:[[260,760],[299,760],[299,741],[351,741]],
    coil:[[260,779],[351,779],[351,741],[260,741],[260,760],[312,760]],
  };
  const route=routes[traits.route];
  const routeLine=points=>{
    line(points,5,C.paper,-35,-30);
    for(const [x,y] of points.slice(1,-1))rect(x-2.5,y-2.5,5,5,C.paper,-35,-30);
  };
  routeLine(route);
  if(traits.route==='fork')routeLine([[299,760],[299,779],[351,779]]);
  const [a,b]=route.slice(-2), dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy),ux=dx/len,uy=dy/len;
  add([[b[0]+ux*6,b[1]+uy*6],[b[0]-ux*4-uy*7,b[1]-uy*4+ux*7],[b[0]-ux*4+uy*7,b[1]-uy*4-ux*7]],C.paper,-35,-29);
  circle(...route[0],5,C.paper,-35,-29,8);

  // Equipment is a physical prop on the floor, with no coins or balance-like quantities.
  const ex=740, bottom=880;
  if(traits.equipment==='reel') {
    frame(ex-68,bottom-30,136,30,C.rim,12);
    circle(ex,bottom-87,61,C.ink,0,48);
    circle(ex,bottom-87,50,C.rim,48,54);
    circle(ex,bottom-87,36,C.ink,54,58);
    circle(ex,bottom-87,14,C.amber,58,64);
    line([[ex+47,bottom-58],[ex+78,bottom-40],[ex+78,bottom-8]],10,C.rim,40,50);
  }
  if(traits.equipment==='case') {
    line([[ex-26,bottom-132],[ex-26,bottom-155],[ex+26,bottom-155],[ex+26,bottom-132]],12,C.rim,-5,9);
    frame(ex-70,bottom-132,140,132,C.slate,0);
    rect(ex-62,bottom-90,124,7,C.rim,14,20);
    frame(ex-20,bottom-100,40,48,C.paper,20);
    circle(ex,bottom-78,5,C.ink,34,38,8);
  }
  if(traits.equipment==='lamp') {
    frame(ex-62,bottom-28,124,28,C.rim,0);
    rect(ex-8,bottom-128,16,100,C.rim,0,20);
    box(ex-48,bottom-194,96,90,C.ink,0,48,12);
    box(ex-38,bottom-184,76,70,C.amber,48,54,10);
    rect(ex-54,bottom-204,108,16,C.rim,0,70);
    for(const dx of [-19,19])rect(ex+dx-3,bottom-186,6,74,C.ink,54,60);
  }
  if(traits.equipment==='tray') {
    for(const dx of [-42,42])rect(ex+dx-4,bottom-168,8,144,C.rim,-58,14);
    frame(ex-72,bottom-46,144,46,C.rim,0);
    rect(ex-62,bottom-44,124,13,C.ink,14,22);
    rect(ex-72,bottom-54,144,12,C.paper,14,20);
  }
  return { parts, lamps, panels, variant };
}
