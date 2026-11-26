import { C, MIX } from '../src/palette.mjs';
import { geometry, headPath } from '../src/face.mjs';
import { specFor } from './lib/spec.mjs';
import { Mesh, marineGlb } from './lib/mesh.mjs';
import { rankPlate } from './lib/rank-plate.mjs';

// Shared authoring scale for every marine. No per-id noise, hidden distinguishing marks or individual fitting.
const X = x => (x-500)*0.0008;
const Y = y => 1.07-y*0.0007;
function headPolygon(g) {
  const values = headPath(g).match(/-?\d+(?:\.\d+)?/g).map(Number);
  let start=values.slice(0,2); const out=[start];
  for(let i=2;i<values.length;i+=6) {
    const a=values.slice(i,i+2),b=values.slice(i+2,i+4),end=values.slice(i+4,i+6);
    for(let j=1;j<=3;j++) { const t=j/3,u=1-t; out.push([0,1].map(k=>u**3*start[k]+3*u*u*t*a[k]+3*u*t*t*b[k]+t**3*end[k])); }
    start=end;
  }
  out.pop(); // closing point is the initial point
  return out.map(([x,y])=>[X(x),Y(y)]);
}
function eyes(m,g,kind) {
  const y=Y(g.ey), xs=[X(500-g.w*.2),X(500+g.w*.2)];
  xs.forEach((x,i)=>{
    if(kind==='Dots'||(kind==='Wink'&&i===0)) {
      m.oval(x,y,.143,.012,.017,.012,C.ink,0,10);
      m.oval(x-.003,y+.006,.152,.0035,.004,.004,C.white,0,8);
    } else if(kind==='Wide') {
      m.oval(x,y,.144,.024,.026,.012,C.white,.004,12);
      m.oval(x+.003,y-.002,.154,.010,.013,.005,C.ink,0,10);
    } else {
      const bend=kind==='Sleepy'?-.009:kind==='Squint'?0:.012;
      m.line([[x-.02,y,.146],[x,y+bend,.146],[x+.02,y,.146]],.008,C.ink);
    }
  });
}
function mouth(m,g,kind) {
  const y=Y(g.my),z=.148;
  if(kind==='Smile') m.line([[-.064,y,z],[-.032,y-.018,z],[0,y-.022,z],[.032,y-.018,z],[.064,y,z]],.008,C.ink);
  if(kind==='Surprise') m.oval(0,y-.01,z,.022,.027,.009,MIX.mouth,.005);
  if(kind==='Grin'||kind==='Cheer') {
    const h=kind==='Grin'?.043:.061;
    m.prism([[-.078,y+.008],[.078,y+.008],[.055,y-h*.6],[.025,y-h],[0,y-h-.005],[-.025,y-h],[-.055,y-h*.6]],z-.004,z+.004,MIX.mouth,.005);
    m.prism([[-.063,y+.004],[.063,y+.004],[.054,y-.012],[-.054,y-.012]],z+.005,z+.009,C.white,0);
    if(kind==='Cheer') m.oval(0,y-h+.009,z+.012,.026,.012,.004,MIX.tongue,0,10);
  }
}
function grooming(m,g,t,spec) {
  if(t.Grooming==='Freckles') for(const side of [-1,1]) for(const [dx,dy] of [[0,0],[.014,.01],[-.012,.012]])
    m.oval(side*g.w*.00025+dx,Y(g.ny)-.025+dy,.145,.005,.005,.004,MIX.tongue,0,8);
  if(t.Grooming==='Sideburns') for(const s of [-1,1]) m.prism([[s*g.w*.0004,Y(g.by)-.005],[s*(g.w*.0004-.035),Y(g.by)-.005],[s*(g.w*.0004-.032),Y(g.ny)-.025],[s*g.w*.0004,Y(g.ny)-.035]],.12,.146,MIX.hair,.003);
  if(t.Grooming.endsWith('moustache')) for(const s of [-1,1]) {
    const y=Y(g.ny)-.029;
    m.prism([[0,y+.01],[s*.036,y+.02],[s*.078,y+.01],[s*.106,y-.022],[s*.062,y-.012],[s*.032,y-.02],[0,y-.003]],.152,.168,spec.mustacheColor,.004);
  }
  for(const s of spec.braids) {
    const x=s*(g.w*.0004+.012),top=Y(g.by)-.035,bottom=.47;
    m.prism([[x-.023,bottom],[x+.023,bottom],[x+.032,top],[x-.032,top]],-.035,.025,MIX.hair,.005);
    for(let j=0;j<5;j++) {
      const y=bottom+.035+j*(top-bottom-.05)/5;
      m.line([[x-.019,y+.009,.027],[x,y-.005,.027],[x+.019,y+.009,.027]],.006,C.ink);
    }
    m.box(x,bottom+.016,.029,.048,.018,.008,C.orange,.002);
  }
}
function prop(m,name) {
  const x=.285,z=.13;
  if(name==='Spoon'||name==='Fork') {
    m.box(x,.615,z,.018,.24,.018,C.steel,.004);
    if(name==='Spoon') m.ball([x,.755,z],[.036,.05,.015],C.steel,.005,10,4);
    else {
      m.box(x,.719,z,.059,.027,.019,C.steel,.004);
      for(const dx of [-.025,-.008,.008,.025]) m.box(x+dx,.758,z,.009,.065,.015,C.steel,.003);
    }
  } else if(name==='Teacup') {
    m.ball([x,.575,z],[.076,.009,.048],C.white,.004,12,4);
    m.prism([[x-.05,.582],[x+.05,.582],[x+.063,.675],[x-.063,.675]],z-.035,z+.035,C.white,.005);
    m.box(x,.678,z,.12,.009,.076,C.ink,0);
    m.line([[x+.06,.66,z],[x+.096,.65,z],[x+.096,.616,z],[x+.058,.611,z]],.015,C.ink,.018);
    // Short steam strokes use geometry, as do all other marks.
    for(const dx of [-.02,.02]) m.line([[x+dx,.70,z],[x+dx-.009,.72,z],[x+dx,.74,z]],.007,C.white);
  } else if(name==='Bell') {
    m.box(x,.59,z,.024,.16,.025,C.crate,.004);
    m.ball([x,.69,z],[.023,.017,.021],C.crate,.004,8,4);
    m.prism([[x-.073,.47],[x+.073,.47],[x+.032,.52],[x+.02,.565],[x-.02,.565],[x-.032,.52]],z-.04,z+.04,C.steel,.005);
    m.ball([x,.455,z],[.014,.014,.014],C.steel,.003,8,4);
  } else if(name==='Salt') {
    m.box(x,.616,z,.067,.15,.06,C.white,.006);
    m.ball([x,.70,z],[.037,.03,.033],C.steel,.004,10,4);
    for(const dx of [-.014,0,.014]) m.oval(x+dx,.705,z+.031,.003,.003,.004,C.ink,0,8);
  } else if(name==='Menu') {
    m.box(x,.65,z,.16,.22,.015,C.paper,.005);
    for(let i=0;i<4;i++) m.box(x,.70-i*.029,z+.011,.11-(i%2)*.02,.006,.004,MIX.paperDot,0);
    m.oval(x,.738,z+.013,.006,.006,.004,C.gold,0,8);
  }
  m.ball([x,.525,z+.035],[.048,.04,.042],C.paper,.005,10,4);
  for(const dy of [-.015,0,.015]) m.line([[x-.035,.525+dy,z+.077],[x+.005,.52+dy,z+.077]],.0035,MIX.paperDot);
}
export function model(row) {
  const t=row.traits,s=specFor(row),g=geometry(s.face),m=new Mesh();
  // Boots and trousers, with the same ground plane and body size for every rank.
  for(const x of [-.085,.085]) {
    m.box(x,.045,.015,.115,.08,.205,C.ink,.004);
    m.box(x,.19,-.025,.105,.23,.12,C.navy,.006);
  }
  m.prism([[-.16,.29],[.16,.29],[.19,.48],[.125,.55],[-.125,.55],[-.19,.48]],-.105,.10,C.navy,.007);
  m.box(0,.567,-.005,.10,.10,.12,C.paper,.005);
  m.prism([[-.072,.54],[.072,.54],[.045,.32],[-.045,.32]],.101,.115,C.white,.004);
  for(const side of [-1,1]) {
    m.prism([[side*.13,.54],[side*.07,.55],[side*.025,.36],[side*.12,.45],[side*.095,.47]],.116,.125,C.navy,.004);
    m.box(side*.167,.423,-.005,.08,.22,.12,C.navy,.006);
  }
  m.line([[-.17,.46,.04],[-.22,.36,.10]],.07,C.navy,.065);
  m.line([[.17,.43,.025],[.285,.49,.11]],.08,C.navy,.065);
  m.box(.285,.49,.142,.085,.03,.07,C.white,.004);
  if(t.Collar==='Napkin') m.prism([[-.095,.535],[.095,.535],[.047,.355],[-.047,.355]],.13,.145,C.white,.005);
  else {
    for(const side of [-1,1]) m.prism([[0,.517],[side*.055,.537],[side*.055,.497]],.13,.15,C.ink,0);
    for(const y of [.46,.411]) m.oval(0,y,.129,.006,.006,.006,C.ink,0,8);
  }
  // Hair behind ears and head; facial features sit on the forward (+z) plane.
  grooming(m,g,{...t,Grooming:t.Grooming.includes('braid')?t.Grooming:'Clean'},s);
  for(const side of [-1,1]) m.oval(side*g.w*.0004,Y(g.top+g.h*.5),.025,.035,.044,.12,C.paper,.006);
  m.prism(headPolygon(g),-.12,.13,C.paper,.007);
  // These details must follow the head to keep all meshes visible in conventional viewers too.
  grooming(m,g,{...t,Grooming:t.Grooming.includes('braid')||t.Grooming==='Freckles'?'Clean':t.Grooming},{...s,braids:[]});
  for(const side of [-1,1]) m.oval(side*g.w*.00025,Y(g.ny)-.026,.137,.028,.026,.005,MIX.blush,0,10);
  // Freckles are in front of the cheek colour.
  if(t.Grooming==='Freckles') grooming(m,g,t,{...s,braids:[]});
  eyes(m,g,t.Eyes); mouth(m,g,t.Mouth);
  m.ball([.003,Y(g.ny),.166],[.039,.032,.047],C.paper,.005,10,4);
  const spread={enlisted:92,officer:128,general:150}[s.hatOpts.grade],by=g.by+(s.hatOpts.low??0);
  m.oval(0,Y(by-154),-.012,(g.w/2+spread)*.0008,.078,.285,C.white,.007,16);
  m.box(0,Y(by-72),.02,(g.w+28)*.0008,.043,.27,C.navy,.005);
  m.ball([0,Y(by-29),.071],[(g.w/2+16)*.0008,.018,.16],C.ink,.003,12,4);
  if(s.hatOpts.grade!=='enlisted') m.box(0,Y(by-57),.161,(g.w-10)*.0008,.008,.008,C.khaki,.002);
  m.oval(0,Y(by-151),.14,.024,.024,.013,C.gold,.005,12);
  prop(m,t.Prop);
  // Equal ration carried in the free hand. Same dimensions and one coin for everyone.
  m.ball([-.21,.35,.17],[.04,.03,.042],C.paper,.004,8,4);
  m.ball([-.20,.386,.19],[.114,.009,.078],C.white,.005,12,4);
  m.oval(-.20,.431,.21,.036,.036,.014,C.gold,.005,16);
  rankPlate(m, t.Rank);
  return marineGlb(m.finish());
}
