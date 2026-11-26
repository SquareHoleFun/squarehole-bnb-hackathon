import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deal } from './deal.mjs';
import { sampleIds, sha256 } from './check.mjs';
import { canvas, blit, label, decodePng, encodePng, renderGlb } from '../../rent-free/models/lib/raster.mjs';

export function shrink(source, factor) {
  const out=canvas(source.width/factor,source.height/factor);
  for(let y=0;y<out.height;y++) for(let x=0;x<out.width;x++) for(let c=0;c<3;c++) {
    let sum=0;
    for(let dy=0;dy<factor;dy++) for(let dx=0;dx<factor;dx++) sum+=source.rgb[((y*factor+dy)*source.width+x*factor+dx)*3+c];
    out.rgb[(y*out.width+x)*3+c]=Math.round(sum/(factor*factor));
  }
  return out;
}
function caption(sheet,row,x,y) {
  const t=row.traits;
  for(const [i,text] of [
    `ID ${row.id} - ${t.Rank} - SQUAD ${t.Squad}`,
    `FACE ${t.Face} - EYES ${t.Eyes}`,
    `GROOMING ${t.Grooming}`,
    `COLLAR ${t.Collar} - MOUTH ${t.Mouth}`,
    `PROP ${t.Prop} - WALL ${t.Wall}`,
  ].entries()) label(sheet,text,x,y+i*13,1);
}
export function sampleArtifacts(read) {
  const rows=deal(),pictures=sampleIds(rows,48),models=sampleIds(rows,24,pictures),files=new Map();
  const contact=canvas(6*288,8*352),sheet=canvas(3*800,8*352);
  const thumbnails=new Map();
  for(const [i,id] of pictures.entries()) {
    const bytes=read(`picture-${id}.png`); files.set(`samples/picture-${id}.png`,bytes);
    const thumb=shrink(decodePng(bytes),4); thumbnails.set(id,thumb);
    const x=(i%6)*288+16,y=Math.floor(i/6)*352;
    blit(contact,thumb,x,y); caption(contact,rows.find(r=>r.id===id),x,y+268);
  }
  for(const [i,id] of models.entries()) {
    const bytes=read(`model-${id}.glb`); files.set(`samples/model-${id}.glb`,bytes);
    const x=(i%3)*800+16,y=Math.floor(i/3)*352;
    blit(sheet,thumbnails.get(id),x,y);
    for(const [j,camera] of ['front','three-quarter'].entries()) {
      const rendered=renderGlb(bytes,camera);
      files.set(`samples/render-${id}-${camera}.png`,encodePng(rendered));
      blit(sheet,shrink(rendered,2),x+(j+1)*256,y);
    }
    caption(sheet,rows.find(r=>r.id===id),x,y+268);
    label(sheet,'PICTURE - FRONT - THREE-QUARTER',x+360,y+268,1);
  }
  files.set('contact-sheet.png',encodePng(contact)); files.set('models-sheet.png',encodePng(sheet));
  const record={pictures,models,files:[...files].map(([file,bytes])=>({file,bytes:bytes.length,sha256:sha256(bytes)}))};
  files.set('samples.json',Buffer.from(`${JSON.stringify(record,null,2)}\n`));
  return files;
}
export function writeSamples(from,out=fileURLToPath(new URL('./',import.meta.url))) {
  mkdirSync(join(out,'samples'),{recursive:true});
  for(const [name,bytes] of sampleArtifacts(name=>readFileSync(join(from,name)))) writeFileSync(join(out,name),bytes);
  writeFileSync(join(out,'manifest.json'),readFileSync(join(from,'manifest.json')));
}
if(import.meta.main) {
  if(process.argv.length!==4||process.argv[2]!=='--from') throw new Error('Usage: samples.mjs --from <full-build>');
  writeSamples(process.argv[3]);
  process.stdout.write('Wrote 48 pictures, 24 models, 48 model renders, two sheets and manifest\n');
}
