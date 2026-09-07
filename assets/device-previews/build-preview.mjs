// SPDX-License-Identifier: GPL-3.0-only
// Generates only files beside this script. No dependencies, network or app changes.
import {readFile, writeFile} from "node:fs/promises";
import {deviceSVG} from "./device-wireframes.mjs";
const path = name => new URL(name, import.meta.url);
const [module,template] = await Promise.all([readFile(path("device-wireframes.mjs"),"utf8"),readFile(path("preview.template.html"),"utf8")]);
await writeFile(path("preview.html"),template.replace("/* DEVICE_MODULE */",()=>module.replace(/^export /gm,"")));
for(const device of ["handy2","sr6"])await writeFile(path(`${device}.svg`),deviceSVG(device));
const frame={L0:60,L1:57,L2:42,R0:67,R1:57,R2:44};
const inner = device => deviceSVG(device,frame,{width:450,height:345}).replace(/^<svg[^>]*>/,"").replace(/<\/svg>$/,"");
const comparison=`<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="538" viewBox="0 0 1040 538">
<rect width="1040" height="538" rx="14" fill="#14202a"/>
<g font-family="sans-serif"><text x="30" y="34" fill="#75e2ba" font-size="11" letter-spacing="1.6">SAM3D · MOTION STUDIO</text><text x="30" y="65" fill="#dbe5ed" font-size="24">Device wireframes</text>
${["handy2","sr6"].map((device,i)=>`<g transform="translate(${30+i*500} 87)"><rect width="480" height="404" rx="10" fill="#1d2b36" stroke="#304455"/><text x="20" y="30" fill="#dbe5ed" font-size="16">${i?"SR6":"Handy 2"}</text><text x="20" y="51" fill="#94aabc" font-size="11">${i?"Six arm linkages + twist receiver":"Sliding carriage · stroke only"}</text><g transform="translate(15 49)">${inner(device)}</g><text x="20" y="383" fill="#75e2ba" font-size="11">${i?"L0 60 · L1 57 · L2 42 · R0 67 · R1 57 · R2 44":"L0 60 · 125 mm full carriage travel"}</text></g>`).join("")}
<text x="30" y="520" fill="#94aabc" font-size="11">Schematic geometry · open preview.html for animation, orbit controls and SVG export</text></g></svg>`;
await writeFile(path("preview.svg"),comparison);
console.log("Built preview.html, handy2.svg, sr6.svg and preview.svg");
