/**
 * Primera Oficial Manpaty, the ship's mascot: a cartoon of the yellow ceramic-block screen that stood at the
 * apartment's entrance (brass frame, chunky yellow ceramic celosía blocks with sunburst openings) until the remodel,
 * now the ship's cheeky secretary: a wink, red cat-eye glasses, pearls, a pencil tucked behind the frame, the
 * passenger checklist on a clipboard, long red painted nails and red stiletto heels. Pure SVG, so it stays crisp on phones, flyers and the TV.
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
  // Arms: brass rods from the frame's sides ending in hands with long red painted nails.
  const leftArm = cheer ? "M34 132 C20 114 16 92 22 70" : "M34 132 C18 122 12 102 18 82";
  const rightArm = cheer ? "M186 132 C200 114 204 92 198 70" : "M186 140 C196 150 200 162 198 174";
  const leftHand = cheer ? [22, 66] : [18, 78];
  const rightHand = cheer ? [198, 66] : [198, 178];
  const arm = (d: string) =>
    `<path d="${d}" fill="none" stroke="${brassLine}" stroke-width="9" stroke-linecap="round"/><path d="${d}" fill="none" stroke="url(#brassRod)" stroke-width="5.5" stroke-linecap="round"/>`;
  const skin = "#ffe8cc";
  const skinLine = "#d9b48f";
  const nail = "#d50032";
  /**
   * A cartoon hand drawn as one outline (four rounded fingers with little separations, a thumb), fingers toward
   * `deg` (0 = up), with a long glossy almond nail on each fingertip. `thumbSide` puts the thumb right (1) or left (-1).
   */
  const hand = ([x, y]: number[], deg: number, thumbSide: 1 | -1) => {
    const tips: [number, number][] = [
      [-6.25, -12],
      [-1.75, -15],
      [2.75, -15],
      [7.25, -12],
    ];
    const outline =
      "M-8 7 L-8.5 -6 L-8.5 -12 A2.25 2.25 0 0 1 -4 -12 L-4 -7 L-4 -15 A2.25 2.25 0 0 1 0.5 -15 L0.5 -8 " +
      "L0.5 -15 A2.25 2.25 0 0 1 5 -15 L5 -7 L5 -12 A2.25 2.25 0 0 1 9.5 -12 L9.5 -2 L12.2 -5.6 " +
      "A2.2 2.2 0 0 1 15.4 -2.6 L10.6 5 Q8.6 9 2 9 L-4 9 Q-8 9 -8 7 Z";
    const almond = ([cx, ty]: [number, number]) =>
      `<path d="M${cx - 2.1} ${ty + 1.6} C${cx - 2.1} ${ty - 2} ${cx - 1} ${ty - 4} ${cx} ${ty - 4.8} C${cx + 1} ${ty - 4} ${cx + 2.1} ${ty - 2} ${cx + 2.1} ${ty + 1.6} Q${cx} ${ty + .4} ${cx - 2.1} ${ty + 1.6} Z" fill="${nail}" stroke="#9c0026" stroke-width=".7"/>` +
      `<path d="M${cx - .9} ${ty - 1.6} q.4 -1.2 1 -1.6" fill="none" stroke="#ff9ab0" stroke-width=".9" stroke-linecap="round"/>`;
    const thumbNail = `<g transform="translate(13.8 -4.1) rotate(53)">${almond([0, 0])}</g>`;
    return `<g transform="translate(${x} ${y}) rotate(${deg}) scale(${thumbSide * 1.15} 1.15)">
<path d="${outline}" fill="${skin}" stroke="${skinLine}" stroke-width="1.3" stroke-linejoin="round"/>
${tips.map(almond).join("")}${thumbNail}</g>`;
  };
  /** A red stiletto pump in profile, the ankle at (cx, 272); `dir` points the toe left (-1) or right (1). */
  const heel = (cx: number, dir: 1 | -1) =>
    `<g transform="translate(${cx} 271) scale(${dir * 0.82} 0.82)">
<path d="M-7 6 C-8 9.5 -7.4 12.5 -6 15.5 L-5 27 L-2.6 27 L-1.8 17 C2 14.5 8 15.5 12 21.5 C15.5 25.8 23 27 29 26 C30.2 23.6 26.5 19.8 20.5 17.2 C15 14.6 11 11 8 7.5 C3 9.5 -2 9 -7 6 Z" fill="#d50032" stroke="#8e0020" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M12.5 22.2 C16 26 23.5 27.2 29 26.2" fill="none" stroke="#5c0016" stroke-width="1.6" stroke-linecap="round"/>
<path d="M-4.6 9.5 C-4.9 11 -4.6 12.5 -4 14" fill="none" stroke="#ff7c99" stroke-width="1.6" stroke-linecap="round"/>
<path d="M15 18.8 C19 20.4 23 21.6 26 22.6" fill="none" stroke="#ff7c99" stroke-width="1.4" stroke-linecap="round"/>
<path d="M-6 6.6 C-1.5 9 3 9.2 7.2 7.6" fill="none" stroke="#6d0018" stroke-width="1.4" stroke-linecap="round"/></g>`;
  // The office essentials: a clipboard with the passenger checklist (wave pose only).
  const clipboard = cheer
    ? ""
    : `<g transform="translate(${rightHand[0] - 2} ${rightHand[1] + 4}) rotate(10)">
  <rect x="-14" y="-6" width="28" height="36" rx="4" fill="#9c6b3f" stroke="#6d4524" stroke-width="2"/>
  <rect x="-10.5" y="-1" width="21" height="27" rx="2" fill="#fffdf6"/>
  <rect x="-6" y="-9" width="12" height="7" rx="2.5" fill="#c9ced6" stroke="#8a929c" stroke-width="1.5"/>
  <path d="M-7 6 l2.5 2.5 l4 -5 M-7 14 l2.5 2.5 l4 -5" fill="none" stroke="#2e7d32" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M2 6 h6 M2 14 h6 M-7 21 h15" stroke="#9aa3ad" stroke-width="1.6" stroke-linecap="round"/></g>`;
  // Pearls across the frame, between the face plate and the celosía.
  const pearls = Array.from({ length: 17 }, (_, i) => {
    const x = 46 + i * 8;
    const y = 105.5 + Math.sin((i / 16) * Math.PI) * 2.5;
    return `<circle cx="${x}" cy="${y.toFixed(1)}" r="3.2" fill="url(#pearl)" stroke="#d9cfc0" stroke-width=".8"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 300" width="${size}" height="${Math.round((size * 300) / 220)}">
<defs>
  <radialGradient id="glaze" cx=".3" cy=".25" r=".95"><stop offset="0" stop-color="#ffe066"/><stop offset=".6" stop-color="#ffc21a"/><stop offset="1" stop-color="#e09a00"/></radialGradient>
  <linearGradient id="hole" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a3600"/><stop offset="1" stop-color="#8a5a10"/></linearGradient>
  <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7dc9a"/><stop offset=".35" stop-color="#d9a94e"/><stop offset=".7" stop-color="#b3812f"/><stop offset="1" stop-color="#e2b866"/></linearGradient>
  <linearGradient id="brassRod" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e9c47a"/><stop offset="1" stop-color="#b8873a"/></linearGradient>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6d6"/><stop offset="1" stop-color="#ffe49a"/></linearGradient>
  <radialGradient id="pearl" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e8e0d4"/></radialGradient>
</defs>
<ellipse cx="110" cy="294" rx="58" ry="5.5" fill="#000" fill-opacity=".16"/>
<rect x="79" y="248" width="10" height="30" rx="5" fill="url(#brassRod)" stroke="${brassLine}" stroke-width="2"/>
<rect x="131" y="248" width="10" height="30" rx="5" fill="url(#brassRod)" stroke="${brassLine}" stroke-width="2"/>
${heel(84, -1)}${heel(136, 1)}
${arm(leftArm)}${arm(rightArm)}
<g transform="translate(170 54) rotate(-34)">
  <rect x="-4.5" y="-44" width="9" height="48" fill="#ffcc33" stroke="#b8860b" stroke-width="1.6"/>
  <path d="M-1.5 -44 v48" stroke="#ffe48a" stroke-width="2"/>
  <rect x="-4.5" y="-50" width="9" height="6" fill="#c0c5cc" stroke="#8a929c" stroke-width="1.2"/>
  <rect x="-4.5" y="-57" width="9" height="7" rx="3" fill="#f48fb1" stroke="#c2185b" stroke-width="1.2"/>
</g>
<rect x="30" y="34" width="160" height="218" rx="24" fill="url(#brass)" stroke="${brassLine}" stroke-width="2.5"/>
<rect x="34.5" y="38.5" width="151" height="209" rx="20" fill="none" stroke="#fff3cf" stroke-opacity=".55" stroke-width="2"/>
<rect x="40" y="44" width="140" height="202" rx="16" fill="#8a5a10" fill-opacity=".35"/>
<rect x="43" y="48" width="134" height="54" rx="14" fill="url(#plate)" stroke="#c98a00" stroke-width="1.6"/>
<path d="M50 56 Q60 51 74 51" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="74" cy="88" rx="7.5" ry="4.2" fill="#ff8f8f" fill-opacity=".55"/><ellipse cx="146" cy="88" rx="7.5" ry="4.2" fill="#ff8f8f" fill-opacity=".55"/>
<path d="M85 75 Q91 69.5 97 75" fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round"/>
<path d="M84.5 75 l-3 1.6 M86.5 72.6 l-2.6 -1.8" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>
<ellipse cx="129" cy="74" rx="4.6" ry="6" fill="${ink}"/><circle cx="130.6" cy="71.6" r="1.7" fill="#fff"/>
<path d="M133 69 l3.4 -2.4" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>
<path d="M121 59.5 Q129 54.5 138 58.5" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>
<path d="M84 61.5 Q91 60 98 61.8" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>
<g fill="#fff" fill-opacity=".22" stroke="#c62828" stroke-width="3" stroke-linejoin="round">
  <path d="M77 67 Q76 63 81 63.5 L100 65 Q104.5 65.5 103.5 70.5 Q102 81 91.5 81 Q81 81 79.5 74 Q78.5 70 73 64.5 Z"/>
  <path d="M143 67 Q144 63 139 63.5 L120 65 Q115.5 65.5 116.5 70.5 Q118 81 128.5 81 Q139 81 140.5 74 Q141.5 70 147 64.5 Z"/>
</g>
<path d="M103.5 69.5 Q110 66.5 116.5 69.5" fill="none" stroke="#c62828" stroke-width="2.6" stroke-linecap="round"/>
<path d="M102.5 89 Q110.5 93.5 118.5 86.5" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>
<path d="M118.2 86.6 q2.2 -.4 2.6 1.6" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>
<circle cx="139" cy="94" r="1.4" fill="${ink}"/>
${blocks()}
${pearls}
${clipboard}
${hand(leftHand, cheer ? -12 : -18, 1)}${hand(rightHand, cheer ? 12 : 150, -1)}
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
