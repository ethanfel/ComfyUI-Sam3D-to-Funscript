// SPDX-License-Identifier: GPL-3.0-only
// Original project artwork, using the existing schematic device geometry.
// Writes only banner.svg and social-preview.svg beside this script.
import {writeFile} from 'node:fs/promises';
import {buildDeviceWireframe, projectWireframe} from '../device-previews/device-wireframes.mjs';

const palette={fixed:'#416881',detail:'#335269',linkage:'#9ec4d0',moving:'#76f0c5',marker:'#dfff9c',unreachable:'#ee997d'};
const pose={L0:59,L1:54,L2:45,R0:61,R1:53,R2:46};
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
function text(x,y,s,size=16,fill='#ecf5f7',extra=''){
 return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
}
function device(name,x,y,w,h,zoom=1){
 const frame=buildDeviceWireframe(name,pose,{sleeve:true});
 const lines=projectWireframe(frame,w,h,{yaw:.64,pitch:.26,zoom});
 return `<g transform="translate(${x} ${y})" fill="none" stroke-linecap="round" stroke-linejoin="round">`+lines.map(l=>`<path d="M${l.a[0].toFixed(2)} ${l.a[1].toFixed(2)}L${l.b[0].toFixed(2)} ${l.b[1].toFixed(2)}" stroke="${palette[l.role]}" stroke-width="${(l.width*(l.role==='moving'?1.15:1)).toFixed(2)}"${l.dashed?' stroke-dasharray="4 5"':''}/>`).join('')+'</g>';
}
function curve(x,y,w,h){
 const n=88,pts=Array.from({length:n},(_,i)=>{const t=i/(n-1);return[x+t*w,y-Math.sin(t*Math.PI*8)*h*(.38+.62*Math.sin(t*Math.PI))];});
 const path=pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
 return `<g fill="none"><path d="M${x} ${y}H${x+w}" stroke="#29404b"/><path d="${path}" stroke="#76f0c5" stroke-width="2.8"/>${pts.filter((p,i)=>i%4===0).map(p=>`<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="3" fill="#9af8d6" stroke="none"/>`).join('')}</g>`;
}
function logo(x,y){
 return `<g transform="translate(${x} ${y})" fill="none" stroke="#76f0c5" stroke-width="1.8" stroke-linejoin="round"><path d="M0 7L12 0L24 7V21L12 28L0 21Z M0 7L12 14L24 7 M12 14V28 M0 21L24 7"/><circle cx="12" cy="14" r="2.6" fill="#dfff9c" stroke="none"/></g>`;
}
function make(social){
 const h=social?640:480,top=social?74:48,base=social?209:147,titleSize=social?76:64;
 const line2=base+(social?87:77),tagline=line2+(social?48:42),waveY=social?483:349;
 const deviceY=social?77:42,deviceH=social?452:334,footerY=h-68;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${h}" viewBox="0 0 1280 ${h}" role="img" aria-labelledby="title desc">
<title id="title">SAM3D to Funscript — ComfyUI Motion Studio</title>
<desc id="desc">Mint and blue wireframe Handy 2 and SR6 mechanisms beside an editable motion curve. Turn video into editable motion with 3D pose tracking, multiple tracks and offline export.</desc>
<defs>
 <linearGradient id="bg" x2="1" y2=".65"><stop stop-color="#111d2b"/><stop offset="1" stop-color="#07131c"/></linearGradient>
 <radialGradient id="halo"><stop stop-color="#1d5c62" stop-opacity=".46"/><stop offset="1" stop-color="#0a1721" stop-opacity="0"/></radialGradient>
 <linearGradient id="fade"><stop stop-color="#76f0c5" stop-opacity="0"/><stop offset=".55" stop-color="#76f0c5" stop-opacity=".25"/><stop offset="1" stop-color="#76f0c5" stop-opacity="0"/></linearGradient>
 <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#274754" stroke-width=".65"/></pattern>
 <linearGradient id="gridFade"><stop stop-color="white" stop-opacity="0"/><stop offset=".65" stop-color="white" stop-opacity=".45"/><stop offset="1" stop-color="white" stop-opacity=".8"/></linearGradient>
 <mask id="gridMask"><rect width="1280" height="${h}" fill="url(#gridFade)"/></mask>
</defs>
<rect width="1280" height="${h}" rx="20" fill="url(#bg)"/>
<rect x=".5" y=".5" width="1279" height="${h-1}" rx="19.5" fill="none" stroke="#263d4c"/>
<ellipse cx="1000" cy="${h*.42}" rx="430" ry="${h*.66}" fill="url(#halo)"/>
<rect x="600" y="1" width="659" height="${h-2}" fill="url(#grid)" opacity=".55" mask="url(#gridMask)"/>
<g fill="none" stroke="#315865" opacity=".38"><ellipse cx="989" cy="${deviceY+deviceH*.53}" rx="240" ry="${deviceH*.51}" transform="rotate(-24 989 ${deviceY+deviceH*.53})"/><ellipse cx="989" cy="${deviceY+deviceH*.53}" rx="212" ry="${deviceH*.39}" transform="rotate(-24 989 ${deviceY+deviceH*.53})" stroke-dasharray="3 13"/></g>
<g font-family="Arial, Helvetica, sans-serif">
 ${logo(62,top-22)}
 ${text(102,top-3,'COMFYUI / MOTION STUDIO',13,'#94b4c4','letter-spacing="2.4" font-weight="700"')}
 ${text(62,base,'SAM3D',titleSize,'#f1f7f8','font-weight="700" letter-spacing="-2.7"')}
 ${text(62,line2,'to Funscript',titleSize,'#76f0c5','font-weight="700" letter-spacing="-2.7"')}
 ${text(65,tagline,'Turn video into editable motion.',social?24:21,'#b4c9d2')}
 ${curve(65,waveY,social?510:499,social?35:29)}
 <g fill="none" stroke="#4c897f" stroke-width="1" opacity=".7"><path d="M${social?575:564} ${waveY}H627L659 ${waveY-32}H691" stroke-dasharray="4 5"/><circle cx="691" cy="${waveY-32}" r="4" fill="#142e33" stroke="#76f0c5"/></g>
 ${device('handy2',596,deviceY+24,264,deviceH,1.06)}
 ${device('sr6',773,deviceY-7,464,deviceH,1.12)}
 ${text(655,deviceY+deviceH+8,'HANDY 2',10,'#8eafb8','letter-spacing="1.5"')}
 ${text(1046,deviceY+deviceH+8,'SR6 / SIX AXES',10,'#8eafb8','letter-spacing="1.5"')}
 <path d="M62 ${footerY}H1218" stroke="#294450"/>
 ${[['01','3D POSE',62],['02','MULTIPLE TRACKS',300],['03','DEVICE PREVIEW',627],['04','OFFLINE EXPORT',960]].map(([i,label,x])=>text(x,footerY+37,i,11,'#76f0c5','font-family="monospace"')+text(x+30,footerY+37,label,12,'#a9beca','font-weight="700" letter-spacing="1.4"')).join('')}
</g>
<path d="M1224 30H1247V53 M1247 ${h-53}V${h-30}H1224" stroke="#446475" fill="none" stroke-width="1"/>
</svg>\n`;
}
for(const [name,social] of [['banner',false],['social-preview',true]])await writeFile(new URL(`${name}.svg`,import.meta.url),make(social));
console.log('Built banner.svg (1280×480) and social-preview.svg (1280×640).');
