/**
 * TV mode: a kiosk page for the apartment TV at /tv/<key>. The page polls /tv/<key>/data.json
 * every 30 s and shows the ship clock, what is on now and next (with a countdown), today's
 * program, rotating flyers, and QR codes that open the Capitán's chat (and sign up for "next").
 */
import type { ServerResponse } from "node:http";
import { SHIP_FORMER_NAME, SHIP_NAME, headlineFor } from "@crucero/agent";
import { type Activity, type Store, CRUISE_START, dayBounds, prettyDate, prettyTime, shipDate } from "@crucero/db";
import QRCode from "qrcode";
import { tvBridge } from "./bridge.js";
import type { VoiceService } from "./voice.js";
import { esc } from "./web.js";

export interface TvDeps {
  store: Store;
  key: string;
  botUsername?: () => string | undefined;
  /** Live Capitán on the TV (voice.ts): a mic button, and calls handed over from phones. */
  voice?: VoiceService;
  now?: () => Date;
}

const qrCache = new Map<string, string>();
async function qr(text: string): Promise<string> {
  let hit = qrCache.get(text);
  if (!hit) {
    hit = await QRCode.toDataURL(text, { margin: 1, width: 360 });
    qrCache.set(text, hit);
  }
  return hit;
}

export async function tvData(deps: TvDeps) {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const realToday = shipDate(now);
  // Before the cruise (or on a quiet day) show the next day that has activities, so the screen is never empty.
  let today = realToday;
  let acts = await deps.store.listActivities(dayBounds(today));
  if (!acts.length) {
    const upcoming = (await deps.store.listActivities({ from: nowIso }))[0];
    if (upcoming) {
      today = shipDate(upcoming.startsAt);
      acts = await deps.store.listActivities(dayBounds(today));
    }
  }
  const daysToSail = Math.ceil((Date.parse(`${CRUISE_START}T00:00:00-06:00`) - now.getTime()) / 86_400_000);
  const current = acts.filter((a) => a.startsAt <= nowIso && a.endsAt > nowIso);
  const next = acts.find((a) => a.startsAt > nowIso);
  const bot = deps.botUsername?.();
  const hosts = new Map((await deps.store.listPeople()).map((p) => [p.id, p.name]));
  const going = async (a: Activity) => (await deps.store.listSignups(a.id)).filter((s) => s.status === "going").length;
  const view = async (a: Activity) => ({
    id: a.id,
    emoji: a.emoji,
    title: a.title,
    time: `${prettyTime(a.startsAt, "es")}–${prettyTime(a.endsAt, "es")}`,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    location: a.location,
    host: hosts.get(a.sponsorId) ?? a.sponsorId,
    going: await going(a),
    capacity: a.capacity ?? null,
    flyerUrl: a.flyerUrl?.startsWith("http") ? a.flyerUrl : null,
  });
  return {
    clock: now.toISOString(),
    date: prettyDate(realToday, "es"),
    /** The day the program list shows: today, or the next day with activities. */
    showing: today === realToday ? null : prettyDate(today, "es"),
    daysToSail: daysToSail > 0 ? daysToSail : null,
    headline: headlineFor(today) ?? null,
    now: await Promise.all(current.map(view)),
    next: next ? { ...(await view(next)), qr: bot ? await qr(`https://t.me/${bot}?start=signup_${next.id}`) : null } : null,
    today: await Promise.all(acts.map(view)),
    // Every upcoming flyer on the cruise, soonest first, so the screen advertises what is coming.
    flyers: (await deps.store.listActivities({ from: dayBounds(realToday).from }))
      .filter((a) => a.flyerUrl?.startsWith("http") && a.endsAt > nowIso)
      .slice(0, 12)
      .map((a) => ({ url: a.flyerUrl!, title: a.title })),
    joinQr: bot ? await qr(`https://t.me/${bot}`) : null,
    bot: bot ?? null,
  };
}

export async function serveTv(deps: TvDeps, res: ServerResponse, sub: string, method = "GET", body = ""): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (sub === "/call.json") {
    const call = deps.voice?.pollTvCall();
    return json(200, { call: call ? { sessionToken: call.sessionToken, name: call.name, relay: `/voice/relay/${call.id}?k=${call.key}` } : null });
  }
  if (sub === "/log" && method === "POST") {
    const f = new URLSearchParams(body);
    deps.voice?.clientEvent("TV", (f.get("event") ?? "").slice(0, 20), (f.get("code") ?? "").slice(0, 80), (f.get("details") ?? "").slice(0, 300));
    return json(200, { ok: true });
  }
  if (sub === "/call" && method === "POST") {
    if (!deps.voice) return json(503, { error: "voice is not configured" });
    try {
      return json(200, await deps.voice.startCall(await deps.voice.tvPassenger(), "tv"));
    } catch (err) {
      return json(503, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (sub === "/data.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(await tvData(deps)));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  const voice = deps.voice ? await deps.voice.status() : undefined;
  const bridge = voice?.ready ? tvBridge({ key: deps.key, portraitUrl: voice.portraitUrl }) : "";
  res.end(TV_HTML.replace("__DATA_URL__", esc(`/tv/${deps.key}/data.json`)).replace("</body></html>", `${bridge}</body></html>`));
}

const TV_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Puente · ${SHIP_NAME}</title>
<style>
:root{--bg:#07131f;--panel:#0f2236;--ink:#f3f6fb;--muted:#9fb3c8;--gold:#ffd166;--accent:#f76b1c}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden}
.wrap{display:grid;grid-template-columns:1.25fr 1fr;grid-template-rows:auto minmax(0,1fr);gap:2vh 2vw;height:100vh;padding:3vh 3vw}
header{grid-column:1/3;display:flex;justify-content:space-between;align-items:baseline}
.brand{font-weight:800;letter-spacing:.12em;font-size:3vh;color:var(--gold)}.clock{font-size:7vh;font-weight:800;font-variant-numeric:tabular-nums}
.date{font-size:2.6vh;color:var(--muted)}.headline{font-size:2.4vh;color:var(--gold)}
.panel{background:var(--panel);border-radius:2vh;padding:2.4vh 2vw;overflow:hidden}
.label{font-size:2vh;letter-spacing:.2em;color:var(--muted);text-transform:uppercase}
.big{font-size:5.4vh;font-weight:800;line-height:1.1;margin:.6vh 0}.meta{font-size:2.6vh;color:var(--muted)}
.count{font-size:4.2vh;font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
.next{display:flex;gap:2vw;align-items:center;margin-top:3vh}.next img{width:18vh;height:18vh;background:#fff;border-radius:1.4vh;padding:.8vh}
ul{list-style:none;margin:1.4vh 0 0;padding:0}li{display:flex;gap:1.2vw;align-items:baseline;font-size:2.7vh;padding:1vh 0;border-bottom:1px solid rgba(255,255,255,.08)}
li .t{font-variant-numeric:tabular-nums;color:var(--muted);min-width:9.5em}li.past{opacity:.45}li.live{color:var(--gold);font-weight:700}
.right{display:grid;grid-template-rows:minmax(0,1fr) auto;gap:2vh;min-height:0}.flyer{display:flex;align-items:center;justify-content:center;min-height:0;padding:2vh}
.flyer img{height:100%;width:auto;max-width:100%;object-fit:contain;border-radius:1.6vh;box-shadow:0 2vh 6vh rgba(0,0,0,.5)}
.join{display:flex;gap:1.5vw;align-items:center;font-size:2.6vh}.join img{width:14vh;height:14vh;background:#fff;border-radius:1.2vh;padding:.6vh}
.empty{font-size:3vh;color:var(--muted)}.empty.mp{display:flex;gap:1.6vw;align-items:center}.empty.mp img{height:12vh}
.formerly{font-size:1.8vh;color:var(--muted);font-style:italic;letter-spacing:.04em}
</style></head><body><div class="wrap">
<header><div><div class="brand">🌙 ${SHIP_NAME.toUpperCase()} · EL PUENTE</div><div class="formerly">anteriormente ${SHIP_FORMER_NAME}</div><div class="date" id="date"></div><div class="headline" id="headline"></div></div><div class="clock" id="clock">--:--</div></header>
<div class="panel"><div id="now"></div><div id="next"></div><div class="label" style="margin-top:3vh" id="todayLabel">Programa de hoy</div><ul id="today"></ul></div>
<div class="right"><div class="panel flyer" id="flyer"><div class="empty">🛳️</div></div><div class="panel join" id="join"></div></div>
</div><script>
const DATA_URL = "__DATA_URL__";
let data = null, flyerIdx = 0;
const fmt = (d) => new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "numeric", minute: "2-digit" }).format(d);
const h = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function countdown(iso) {
  const ms = new Date(iso) - Date.now(); if (ms <= 0) return "¡ya!";
  const m = Math.floor(ms / 60000), hh = Math.floor(m / 60);
  if (hh >= 48) return Math.ceil(ms / 86400000) + " días";
  return hh ? hh + " h " + (m % 60) + " min" : m + " min";
}
function render() {
  if (!data) return;
  document.getElementById("clock").textContent = fmt(new Date());
  document.getElementById("date").textContent = data.date;
  document.getElementById("headline").textContent = data.daysToSail ? "⚓ Faltan " + data.daysToSail + (data.daysToSail === 1 ? " día" : " días") + " para zarpar" : (data.headline || "");
  document.getElementById("todayLabel").textContent = data.showing ? "Próximo programa · " + data.showing : "Programa de hoy";
  document.getElementById("now").innerHTML = data.now.length
    ? data.now.map((a) => '<div class="label">Ahora</div><div class="big">' + h(a.emoji) + " " + h(a.title) + '</div><div class="meta">' + h(a.time) + " · " + h(a.location) + " · " + h(a.host) + "</div>").join("")
    : '<div class="label">Ahora</div><div class="empty mp"><img src="/manpaty.svg" alt="">Cubierta libre: Manpaty espera en la pasarela. ¿Quién organiza algo?</div>';
  const n = data.next;
  document.getElementById("next").innerHTML = n
    ? '<div class="next">' + (n.qr ? '<img src="' + n.qr + '" alt="">' : "") + '<div><div class="label">Sigue · en <span class="count">' + countdown(n.startsAt) + '</span></div><div class="big">' + h(n.emoji) + " " + h(n.title) + '</div><div class="meta">' + h(n.time) + " · " + h(n.location) + " · " + h(n.host) + (n.qr ? " · escanea para apuntarte" : "") + "</div></div></div>"
    : "";
  const nowIso = new Date().toISOString();
  document.getElementById("today").innerHTML = data.today.length
    ? data.today.map((a) => '<li class="' + (a.endsAt <= nowIso ? "past" : a.startsAt <= nowIso ? "live" : "") + '"><span class="t">' + h(a.time) + "</span><span>" + h(a.emoji) + " " + h(a.title) + '</span><span class="meta">' + h(a.location) + (a.capacity ? " · " + a.going + "/" + a.capacity : "") + "</span></li>").join("")
    : '<li class="empty">Hoy no hay actividades todavía.</li>';
  document.getElementById("join").innerHTML = data.joinQr
    ? '<img src="' + data.joinQr + '" alt=""><div><b>Habla con el Capitán</b><br>Escanea con Telegram: @' + h(data.bot) + "</div>"
    : "<div>Habla con el Capitán por chat</div>";
}
function rotateFlyer() {
  const el = document.getElementById("flyer");
  if (!data || !data.flyers.length) { el.innerHTML = '<div class="empty">🛳️ Los flyers aparecen aquí</div>'; return; }
  const f = data.flyers[flyerIdx++ % data.flyers.length];
  el.innerHTML = '<img src="' + h(f.url) + '" alt="' + h(f.title) + '">';
}
async function load() {
  try { data = await (await fetch(DATA_URL, { cache: "no-store" })).json(); render(); } catch (e) { /* keep the last screen */ }
}
load(); setInterval(load, 30000); setInterval(render, 1000); setInterval(rotateFlyer, 12000); setTimeout(rotateFlyer, 1500);
</script></body></html>`;
