/**
 * Primer Oficial Manpaty, the ship's mascot: a cartoon of the yellow ceramic-block screen that stood at the
 * apartment's entrance (brass frame, chunky yellow ceramic celosía blocks with sunburst openings) until the remodel, now in a sailor cap, waving,
 * with the Christmas wreath it used to wear. Pure SVG, so it stays crisp on phones, flyers and the TV.
 */
import { Resvg } from "@resvg/resvg-js";

export type ManpatyPose = "wave" | "cheer";

const pt = (cx: number, cy: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
};

/**
 * One chunky celosía block like the real screen: glazed yellow ceramic with a puffy rim, a centre hole and
 * sunburst openings between fat, rounded spokes. Openings read as deep shadow (you see through the screen).
 */
function celosia(x: number, y: number, w: number, h: number, id: number): string {
  const [cx, cy] = [x + w / 2, y + h / 2];
  const rim = 5.5;
  const n = 8;
  const open = 360 / n - 19; // degrees of each opening; the rest is a fat spoke
  const wedges = Array.from({ length: n }, (_, i) => {
    const a = i * (360 / n) - 90 + 22.5;
    const [a0, a1] = [a - open / 2, a + open / 2];
    return `M${pt(cx, cy, 10, a0)} L${pt(cx, cy, 34, a0)} A34 34 0 0 1 ${pt(cx, cy, 34, a1)} L${pt(cx, cy, 10, a1)} A10 10 0 0 0 ${pt(cx, cy, 10, a0)} Z`;
  }).join(" ");
  return `<clipPath id="c${id}"><rect x="${x + rim}" y="${y + rim}" width="${w - 2 * rim}" height="${h - 2 * rim}" rx="7"/></clipPath>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" fill="url(#glaze)" stroke="#c98a00" stroke-width="1.8"/>
<g clip-path="url(#c${id})"><path d="${wedges}" fill="url(#hole)" stroke="url(#hole)" stroke-width="2.5" stroke-linejoin="round"/></g>
<circle cx="${cx}" cy="${cy}" r="5" fill="url(#hole)"/>
<path d="M${x + 5} ${y + 7} Q${x + 6} ${y + 4} ${x + 12} ${y + 3.6}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.4" stroke-linecap="round"/>`;
}

function blocks(): string {
  const out: string[] = [];
  const [x0, y0, w, h, gap] = [43, 110, 42, 40, 5];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(celosia(x0 + c * (w + gap), y0 + r * (h + gap), w, h, r * 3 + c));
  return out.join("");
}

/** The SVG markup; `size` is the rendered width (height follows the 220×300 drawing). */
export function manpatySvg(opts: { size?: number; pose?: ManpatyPose } = {}): string {
  const size = opts.size ?? 220;
  const cheer = opts.pose === "cheer";
  const ink = "#2b2118";
  const brassLine = "#7a5520";
  // Arms: brass rods from the frame's sides ending in cartoon gloves.
  const leftArm = cheer ? "M34 132 C20 114 16 92 22 70" : "M34 132 C18 122 12 102 18 82";
  const rightArm = cheer ? "M186 132 C200 114 204 92 198 70" : "M186 140 C196 150 200 162 198 174";
  const leftHand = cheer ? [22, 66] : [18, 78];
  const rightHand = cheer ? [198, 66] : [198, 178];
  const arm = (d: string) =>
    `<path d="${d}" fill="none" stroke="${brassLine}" stroke-width="9" stroke-linecap="round"/><path d="${d}" fill="none" stroke="url(#brassRod)" stroke-width="5.5" stroke-linecap="round"/>`;
  const glove = ([x, y]: number[]) =>
    `<circle cx="${x}" cy="${y}" r="9.5" fill="#fff" stroke="#c9c2b6" stroke-width="2"/><path d="M${x - 4} ${y - 5} q4 -3 8 0" fill="none" stroke="#d8d2c6" stroke-width="1.6" stroke-linecap="round"/>`;
  const wreath = cheer
    ? ""
    : `<g transform="translate(${rightHand[0] - 4} ${rightHand[1] + 16})">
  <circle r="17" fill="none" stroke="#2e7d32" stroke-width="9"/><circle r="17" fill="none" stroke="#4caf50" stroke-width="3.5" stroke-dasharray="2.5 5"/>
  <circle cx="-8" cy="-12" r="2.4" fill="#e53935"/><circle cx="11" cy="-8" r="2.4" fill="#e53935"/><circle cx="-13" cy="7" r="2.4" fill="#e53935"/>
  <path d="M-6 13 L0 18 L6 13 L3.5 25 L0 21 L-3.5 25 Z" fill="#d32f2f"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 300" width="${size}" height="${Math.round((size * 300) / 220)}">
<defs>
  <radialGradient id="glaze" cx=".3" cy=".25" r=".95"><stop offset="0" stop-color="#ffe066"/><stop offset=".6" stop-color="#ffc21a"/><stop offset="1" stop-color="#e09a00"/></radialGradient>
  <linearGradient id="hole" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a3600"/><stop offset="1" stop-color="#8a5a10"/></linearGradient>
  <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7dc9a"/><stop offset=".35" stop-color="#d9a94e"/><stop offset=".7" stop-color="#b3812f"/><stop offset="1" stop-color="#e2b866"/></linearGradient>
  <linearGradient id="brassRod" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e9c47a"/><stop offset="1" stop-color="#b8873a"/></linearGradient>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6d6"/><stop offset="1" stop-color="#ffe49a"/></linearGradient>
</defs>
<ellipse cx="110" cy="290" rx="64" ry="8" fill="#000" fill-opacity=".16"/>
<rect x="76" y="248" width="16" height="32" rx="7" fill="url(#brassRod)" stroke="${brassLine}" stroke-width="2"/>
<rect x="128" y="248" width="16" height="32" rx="7" fill="url(#brassRod)" stroke="${brassLine}" stroke-width="2"/>
<ellipse cx="83" cy="283" rx="15" ry="7.5" fill="#1b2a4a"/><ellipse cx="137" cy="283" rx="15" ry="7.5" fill="#1b2a4a"/>
${arm(leftArm)}${arm(rightArm)}
<rect x="30" y="34" width="160" height="218" rx="24" fill="url(#brass)" stroke="${brassLine}" stroke-width="2.5"/>
<rect x="34.5" y="38.5" width="151" height="209" rx="20" fill="none" stroke="#fff3cf" stroke-opacity=".55" stroke-width="2"/>
<rect x="40" y="44" width="140" height="202" rx="16" fill="#8a5a10" fill-opacity=".35"/>
<rect x="43" y="48" width="134" height="54" rx="14" fill="url(#plate)" stroke="#c98a00" stroke-width="1.6"/>
<path d="M50 56 Q60 51 74 51" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="91" cy="73" rx="5" ry="6.6" fill="${ink}"/><ellipse cx="129" cy="73" rx="5" ry="6.6" fill="${ink}"/>
<circle cx="92.8" cy="70.4" r="1.9" fill="#fff"/><circle cx="130.8" cy="70.4" r="1.9" fill="#fff"/>
<ellipse cx="77" cy="85" rx="7.5" ry="4.2" fill="#ff8f8f" fill-opacity=".55"/><ellipse cx="143" cy="85" rx="7.5" ry="4.2" fill="#ff8f8f" fill-opacity=".55"/>
<path d="M103.5 83 Q110 89.5 116.5 83" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>
${blocks()}
<g transform="rotate(-7 110 34)">
  <path d="M78 38 Q110 2 142 38 Z" fill="#fff" stroke="#c9c2b6" stroke-width="2.2"/>
  <rect x="76" y="32" width="68" height="9" rx="4.5" fill="#1b2a4a"/>
  <path d="M72 41 Q110 52 148 41 L146.5 45 Q110 57 73.5 45 Z" fill="#fff" stroke="#c9c2b6" stroke-width="2"/>
  <circle cx="110" cy="22" r="3.6" fill="#f2b632"/>
</g>
${wreath}
${glove(leftHand)}${glove(rightHand)}
</svg>`;
}

export const manpatyDataUrl = (opts: { size?: number; pose?: ManpatyPose } = {}) =>
  `data:image/svg+xml;base64,${Buffer.from(manpatySvg(opts)).toString("base64")}`;

const pngCache = new Map<string, Buffer>();
/** PNG for places that need a bitmap (Telegram photos). */
export function manpatyPng(opts: { size?: number; pose?: ManpatyPose; background?: string } = {}): Buffer {
  const key = JSON.stringify(opts);
  let png = pngCache.get(key);
  if (!png) {
    const svg = manpatySvg({ size: opts.size ?? 660, pose: opts.pose });
    png = new Resvg(svg, { background: opts.background, fitTo: { mode: "width", value: opts.size ?? 660 } }).render().asPng();
    pngCache.set(key, png);
  }
  return png;
}
