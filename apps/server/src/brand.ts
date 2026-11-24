/**
 * The Moonshine of the Seas logo, served from apps/server/assets/brand:
 *   /brand/logo.webp, /brand/logo.png   the full logo (emblem + name), navy on white: for light backgrounds
 *   /brand/emblem.png                   the moon, palm and ship alone, transparent: on a white badge in navy bars
 *   /brand/favicon.png, /favicon.ico, /brand/apple-touch-icon.png, /brand/icon-512.png   browser and home-screen icons
 */
import { readFileSync, readdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../assets/brand/", import.meta.url));
const TYPES: Record<string, string> = { png: "image/png", webp: "image/webp" };
const FILES = new Map(readdirSync(DIR).filter((f) => TYPES[f.split(".").pop()!]).map((f) => [f, readFileSync(`${DIR}${f}`)]));

/** Icons and the share image for every page's <head>. */
export const BRAND_HEAD =
  '<link rel="icon" type="image/png" href="/brand/favicon.png"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">';

/** The emblem on a round white badge, for the navy header bars (`size` in px). */
export const emblemBadge = (size = 34) =>
  `<span class="emblem" style="width:${size}px;height:${size}px"><img src="/brand/emblem.png" alt="" width="${size - 6}" height="${size - 6}"></span>`;

export const EMBLEM_CSS =
  ".emblem{display:inline-grid;place-items:center;flex:none;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(242,182,50,.55)}.emblem img{object-fit:contain}";

/** Serves /brand/<file> and /favicon.ico; returns false for anything else. */
export function serveBrand(res: ServerResponse, pathname: string): boolean {
  const name = pathname === "/favicon.ico" ? "favicon.png" : pathname.startsWith("/brand/") ? pathname.slice(7) : undefined;
  const body = name ? FILES.get(name) : undefined;
  if (!name || !body) return false;
  res.writeHead(200, { "Content-Type": TYPES[name.split(".").pop()!], "Content-Length": body.length, "Cache-Control": "public, max-age=86400" });
  res.end(body);
  return true;
}
