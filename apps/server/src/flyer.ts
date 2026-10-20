/**
 * Flyers: Claude writes the concept and copy, an image model (Flux via fal.ai) paints the art,
 * and we overlay every word ourselves (image models still garble text), so the title, time,
 * place and host are always readable. Output: a 1080×1350 PNG in the media store.
 *
 * Without FAL_KEY (or when the image call fails) the flyer uses a designed gradient for the vibe,
 * so a flyer always ships.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Resvg } from "@resvg/resvg-js";
import { SHIP_NAME } from "@crucero/agent";
import { type Activity, type Person, type Store, prettyDate, prettyTime, shipDate } from "@crucero/db";
import QRCode from "qrcode";
import satori from "satori";
import { z } from "zod";
import { manpatyDataUrl } from "./manpaty.js";
import type { MediaStore } from "./media.js";

export const FLYER_VIBES = ["fiesta", "zen", "retro-cruise", "kids", "gala"] as const;
export type FlyerVibe = (typeof FLYER_VIBES)[number];

const W = 1080;
const H = 1350;

/** Designed fallbacks and accent colors per vibe. */
const VIBE_STYLE: Record<FlyerVibe, { gradient: string; accent: string; art: string }> = {
  fiesta: { gradient: "linear-gradient(160deg, #ff4e50 0%, #f9d423 100%)", accent: "#ffe66d", art: "vibrant papel picado, confetti, Mexican fiesta colors, festive beach-party energy" },
  zen: { gradient: "linear-gradient(160deg, #a8edea 0%, #3a7bd5 100%)", accent: "#e0fbfc", art: "calm sunrise over the Pacific ocean, soft pastel sky, serene minimal composition" },
  "retro-cruise": { gradient: "linear-gradient(160deg, #0f4c81 0%, #f76b1c 100%)", accent: "#ffd166", art: "1950s retro cruise ship travel poster, art deco, bold flat colors, Acapulco bay" },
  kids: { gradient: "linear-gradient(160deg, #43e97b 0%, #38f9d7 50%, #fa709a 100%)", accent: "#fff3b0", art: "playful cartoon beach adventure, bright primary colors, friendly sea creatures" },
  gala: { gradient: "linear-gradient(160deg, #0f0c29 0%, #302b63 50%, #b8860b 100%)", accent: "#f5d06f", art: "elegant black and gold New Year's Eve gala, glittering lights, champagne bokeh" },
};

export const FlyerBrief = z.object({
  headline: z.string().describe("The activity's name as it should appear on the flyer, <= 38 characters, no emoji"),
  tagline: z.string().describe("One short funny line in the passenger's language, <= 70 characters"),
  art_prompt: z.string().describe("English prompt for the background illustration: scene, style, colors, mood. No people's faces, NO text, letters or signs in the image. Leave the lower third calm for overlaid text."),
});
export type FlyerBrief = z.infer<typeof FlyerBrief>;

export interface ImageGenerator {
  /** Returns image bytes (PNG/JPEG); a portrait flyer background unless a size is given. */
  generate(prompt: string, size?: { width: number; height: number }): Promise<Uint8Array>;
}

/** fal.ai Flux (synchronous endpoint). FAL_MODEL defaults to fal-ai/flux/dev. */
export class FalImageGenerator implements ImageGenerator {
  private readonly fetchFn: typeof fetch;
  constructor(
    private readonly key: string,
    private readonly model = "fal-ai/flux/dev",
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = fetchFn ?? fetch;
  }

  async generate(prompt: string, size = { width: W, height: H }): Promise<Uint8Array> {
    const res = await this.fetchFn(`https://fal.run/${this.model}`, {
      method: "POST",
      headers: { Authorization: `Key ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image_size: size, num_images: 1, enable_safety_checker: true }),
    });
    if (!res.ok) throw new Error(`fal ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { images?: { url?: string }[] };
    const url = json.images?.[0]?.url;
    if (!url) throw new Error("fal returned no image");
    const img = await this.fetchFn(url);
    if (!img.ok) throw new Error(`fal image download ${img.status}`);
    return new Uint8Array(await img.arrayBuffer());
  }
}

const require = createRequire(import.meta.url);
const font = (spec: string) => readFileSync(require.resolve(spec));
let FONTS: Parameters<typeof satori>[1]["fonts"] | undefined;
function fonts() {
  FONTS ??= [
    { name: "Baloo", data: font("@fontsource/baloo-2/files/baloo-2-latin-800-normal.woff"), weight: 800, style: "normal" },
    { name: "Inter", data: font("@fontsource/inter/files/inter-latin-400-normal.woff"), weight: 400, style: "normal" },
    { name: "Inter", data: font("@fontsource/inter/files/inter-latin-700-normal.woff"), weight: 700, style: "normal" },
  ];
  return FONTS;
}

/** Twemoji SVGs for emoji graphemes (satori has no emoji font). Cached; a blank on failure. */
const emojiCache = new Map<string, string>();
/** Flux returns JPEG; a mislabeled data URL renders as nothing (a grey flyer), so sniff the bytes. */
export function imageType(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "image/png";
}

const BLANK = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString("base64");
async function loadEmoji(segment: string, fetchFn: typeof fetch): Promise<string> {
  const code = [...segment].map((c) => c.codePointAt(0)!.toString(16)).filter((cp) => cp !== "fe0f").join("-");
  const hit = emojiCache.get(code);
  if (hit) return hit;
  try {
    const res = await fetchFn(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${code}.svg`);
    if (!res.ok) return BLANK;
    const uri = "data:image/svg+xml;base64," + Buffer.from(await res.text()).toString("base64");
    emojiCache.set(code, uri);
    return uri;
  } catch {
    return BLANK;
  }
}

export interface FlyerLayout {
  vibe: FlyerVibe;
  emoji: string;
  headline: string;
  tagline: string;
  when: string;
  where: string;
  host: string;
  qrLabel: string;
  qrDataUrl: string;
  background?: Uint8Array;
}

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({ type, props: { style, children, ...extra } });

/** Pure layout → PNG. Deterministic for a given input (used by tests and the TV preview). */
export async function renderFlyerPng(l: FlyerLayout, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const style = VIBE_STYLE[l.vibe];
  const bg = l.background
    ? el("img", { position: "absolute", top: 0, left: 0, width: W, height: H, objectFit: "cover" }, undefined, { src: `data:${imageType(l.background)};base64,${Buffer.from(l.background).toString("base64")}`, width: W, height: H })
    : el("div", { position: "absolute", top: 0, left: 0, width: W, height: H, backgroundImage: style.gradient });
  const shade = el("div", { position: "absolute", top: 0, left: 0, width: W, height: H, backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.78) 100%)" });

  const tree = el(
    "div",
    { width: W, height: H, display: "flex", position: "relative", fontFamily: "Inter", color: "white" },
    [
      bg,
      shade,
      el("div", { position: "absolute", top: 56, left: 64, right: 64, display: "flex", justifyContent: "space-between", alignItems: "center" }, [
        el("div", { display: "flex", alignItems: "center" }, [
          el("img", { width: 84, height: 115, marginRight: 14 }, undefined, { src: manpatyDataUrl({ size: 84, pose: "cheer" }), width: 84, height: 115 }),
          el("div", { fontFamily: "Baloo", fontSize: 34, letterSpacing: 4, padding: "8px 22px", borderRadius: 40, backgroundColor: "rgba(0,0,0,0.45)" }, `🌙 ${SHIP_NAME.toUpperCase()}`),
        ]),
        el("div", { fontSize: 120 }, l.emoji),
      ]),
      el("div", { position: "absolute", left: 64, right: 64, bottom: 60, display: "flex", flexDirection: "column" }, [
        el("div", { fontFamily: "Baloo", fontSize: l.headline.length > 22 ? 96 : 124, lineHeight: 1.0, color: "white", textShadow: "0 4px 18px rgba(0,0,0,0.5)" }, l.headline),
        el("div", { fontSize: 40, marginTop: 18, color: style.accent, fontWeight: 700 }, l.tagline),
        el("div", { display: "flex", marginTop: 36, alignItems: "flex-end", justifyContent: "space-between" }, [
          el("div", { display: "flex", flexDirection: "column", fontSize: 38, lineHeight: 1.45 }, [
            el("div", { fontWeight: 700 }, `🗓  ${l.when}`),
            el("div", {}, `📍  ${l.where}`),
            el("div", {}, `⭐  ${l.host}`),
          ]),
          el("div", { display: "flex", flexDirection: "column", alignItems: "center" }, [
            el("img", { width: 200, height: 200, borderRadius: 16, backgroundColor: "white", padding: 10 }, undefined, { src: l.qrDataUrl, width: 200, height: 200 }),
            el("div", { fontSize: 24, marginTop: 8, fontWeight: 700 }, l.qrLabel),
          ]),
        ]),
      ]),
    ],
  );

  const svg = await satori(tree as never, {
    width: W,
    height: H,
    fonts: fonts(),
    loadAdditionalAsset: async (code, segment) => (code === "emoji" ? loadEmoji(segment, fetchFn) : BLANK),
  });
  return new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng());
}

export interface FlyerServiceDeps {
  store: Store;
  media: MediaStore;
  client: Anthropic;
  images?: ImageGenerator;
  /** Where the QR code points for an activity (bot deep link or web page). */
  signupUrl: (activity: Activity) => string;
  model?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export class FlyerService {
  constructor(private readonly deps: FlyerServiceDeps) {}

  /** Claude's concept + copy for one activity. Falls back to the activity's own words. */
  async brief(a: Activity, host: Person | undefined, vibe: FlyerVibe, lang: "es" | "en", taglineHint?: string): Promise<FlyerBrief> {
    try {
      const res = await this.deps.client.messages.parse({
        model: this.deps.model ?? process.env.DIRECTOR_MODEL ?? "claude-opus-5-5",
        max_tokens: 1024,
        output_config: { effort: "low", format: zodOutputFormat(FlyerBrief) },
        messages: [
          {
            role: "user",
            content: [
              `Write a flyer brief for a family "cruise" activity (an apartment in Acapulco treated as a cruise ship, Dec 26 2026 - Jan 2 2027).`,
              `Activity: ${a.emoji} ${a.title}${a.description ? ` — ${a.description}` : ""}. Place: ${a.location}. Host: ${host?.name ?? "a passenger"}.`,
              `Vibe: ${vibe} (${VIBE_STYLE[vibe].art}). Language for headline and tagline: ${lang === "es" ? "Spanish" : "English"}.`,
              taglineHint ? `The host suggested this tagline; keep its spirit: "${taglineHint}".` : "",
              `Humor: warm and inclusive; never about bodies, age, health, relationships, money or parenting.`,
            ].filter(Boolean).join("\n"),
          },
        ],
      });
      if (res.parsed_output) return res.parsed_output;
    } catch (err) {
      this.deps.log?.(`flyer brief ERROR ${err instanceof Error ? err.message : err}`);
    }
    return { headline: a.title, tagline: taglineHint ?? "", art_prompt: VIBE_STYLE[vibe].art };
  }

  /** Brief → art → overlay → PNG in the media store; sets activity.flyerUrl and returns it. */
  async make(activityId: string, vibe: FlyerVibe, lang: "es" | "en", taglineHint?: string): Promise<{ url: string; usedAiArt: boolean }> {
    const { store, media, images, log } = this.deps;
    const a = await store.getActivity(activityId);
    if (!a) throw new Error(`No activity ${activityId}`);
    const host = await store.getPerson(a.sponsorId);
    const brief = await this.brief(a, host, vibe, lang, taglineHint);

    let background: Uint8Array | undefined;
    if (images) {
      try {
        background = await images.generate(`${brief.art_prompt}. Style: ${VIBE_STYLE[vibe].art}. Portrait poster background, no text, no letters, no words, no logos.`);
      } catch (err) {
        log?.(`flyer art ERROR ${err instanceof Error ? err.message : err} (using the ${vibe} template)`);
      }
    }

    const qrDataUrl = await QRCode.toDataURL(this.deps.signupUrl(a), { margin: 1, width: 400 });
    const png = await renderFlyerPng(
      {
        vibe,
        emoji: a.emoji,
        headline: brief.headline.slice(0, 40),
        tagline: brief.tagline.slice(0, 80),
        when: `${prettyDate(shipDate(a.startsAt), lang)} · ${prettyTime(a.startsAt, lang)}`,
        where: a.location,
        host: `${lang === "es" ? "Organiza" : "Host"}: ${host?.name ?? a.sponsorId}`,
        qrLabel: lang === "es" ? "¡Apúntate!" : "Sign up!",
        qrDataUrl,
        background,
      },
      this.deps.fetch,
    );
    const url = await media.put(`flyers/${a.id}-${Date.now()}.png`, png, "image/png");
    await store.updateActivity(a.id, { flyerUrl: url });
    return { url, usedAiArt: !!background };
  }
}
