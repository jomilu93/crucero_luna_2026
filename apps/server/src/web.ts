/**
 * The web side of the ship, served by the same process as the chat webhook:
 *
 *   /c/<cabin token>                 → "Mi crucero": my day, what I host, settings, calendar link
 *   /c/<cabin token>/program?date=   → the program for a day (Dec 26 – Jan 2 tabs)
 *   /c/<cabin token>/a/<id>          → one activity: flyer, who's going, sign-up buttons, host actions
 *   /c/<cabin token>/new             → sponsor form
 *   /tv/<tv key>  (+ /data.json)     → TV mode for the apartment screen (tv.ts)
 *
 * Every write goes through the Capitán's own tools (buildTools), so permissions, capacity,
 * waitlists and quiet hours are identical on the web and in the chat. A cabin token is
 * "<person id>.<hmac(person id + ics token)>": unguessable, and revoked by rotating the ICS token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type FlyerMaker, type Outbox, buildTools } from "@crucero/agent";
import {
  type Activity,
  type Person,
  type Store,
  CRUISE_END,
  CRUISE_START,
  addDays,
  dayBounds,
  prettyDate,
  prettyTime,
  shipDate,
} from "@crucero/db";

export interface WebDeps {
  store: Store;
  outbox: Outbox;
  publicUrl: string;
  secret: string;
  flyers?: FlyerMaker;
  /** The bot's t.me username, for "open the chat" links; undefined on the console channel. */
  botUsername?: () => string | undefined;
  now?: () => Date;
}

// ---------- tokens ----------

const sig = (secret: string, data: string, len = 24) => createHmac("sha256", secret).update(data).digest("base64url").slice(0, len);

export function cabinToken(secret: string, p: Person): string {
  return `${p.id}.${sig(secret, `cabin:${p.id}:${p.icsToken}`)}`;
}

export function cabinUrl(deps: Pick<WebDeps, "publicUrl" | "secret">, p: Person): string {
  return `${deps.publicUrl}/c/${cabinToken(deps.secret, p)}`;
}

export function tvKey(secret: string): string {
  return sig(secret, "tv-mode", 20);
}

async function personFromToken(deps: WebDeps, token: string): Promise<Person | undefined> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return undefined;
  const person = await deps.store.getPerson(token.slice(0, dot));
  if (!person) return undefined;
  const want = Buffer.from(cabinToken(deps.secret, person));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? person : undefined;
}

// ---------- strings ----------

const T = {
  es: {
    myCruise: "Mi crucero", program: "Programa", sponsor: "Organizar", today: "Hoy", hosting: "Organizas", mine: "Tu agenda",
    empty: "Tu camastro se ve solitario. Elige algo del programa o organiza tú.", going: "Van", maybe: "Tal vez", nobody: "nadie todavía",
    imIn: "¡Voy!", maybeBtn: "Tal vez", out: "No voy", cancelled: "CANCELADA", full: "LLENO", host: "Organiza", bring: "Traer",
    capacity: "Cupo", flyer: "Flyer", makeFlyer: "Hacer flyer", cancel: "Cancelar actividad", reason: "Motivo", calendar: "Agregar a mi calendario",
    settings: "Preferencias", language: "Idioma", humor: "Humor", quiet: "Horas de silencio", wake: "Programa de la mañana a las", mute: "No me mandes mensajes (solo respondo si escribes)",
    save: "Guardar", title: "¿Qué organizas?", emoji: "Emoji", date: "Día", start: "Empieza", end: "Termina", place: "Dónde", description: "Descripción",
    create: "Publicar actividad", flyerToo: "Hacer flyer con estilo", noFlyer: "Sin flyer por ahora", openChat: "Hablar con el Capitán", back: "← Volver",
    humorFull: "Completo", humorLight: "Ligero", humorOff: "Sin chistes", saved: "Listo.", working: "El Capitán está en la imprenta…",
  },
  en: {
    myCruise: "My cruise", program: "Program", sponsor: "Host", today: "Today", hosting: "You host", mine: "Your plan",
    empty: "Your deck chair looks lonely. Pick something from the program or host one yourself.", going: "Going", maybe: "Maybe", nobody: "nobody yet",
    imIn: "I'm in!", maybeBtn: "Maybe", out: "Not going", cancelled: "CANCELLED", full: "FULL", host: "Host", bring: "Bring",
    capacity: "Capacity", flyer: "Flyer", makeFlyer: "Make a flyer", cancel: "Cancel activity", reason: "Reason", calendar: "Add to my calendar",
    settings: "Settings", language: "Language", humor: "Humor", quiet: "Quiet hours", wake: "Morning program at", mute: "Don't message me (I only reply when you write)",
    save: "Save", title: "What are you hosting?", emoji: "Emoji", date: "Day", start: "Starts", end: "Ends", place: "Where", description: "Description",
    create: "Publish activity", flyerToo: "Make a flyer in style", noFlyer: "No flyer for now", openChat: "Chat with the Capitán", back: "← Back",
    humorFull: "Full", humorLight: "Light", humorOff: "No jokes", saved: "Done.", working: "The Capitán is at the print shop…",
  },
} as const satisfies Record<"es" | "en", Record<string, string>>;
type Strings = Record<keyof (typeof T)["es"], string>;

// ---------- html ----------

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#f6f3ee;--card:#fff;--ink:#1d2433;--muted:#667085;--line:#e6e1d8;--brand:#0f4c81;--accent:#f76b1c;--ok:#1a7f4b;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#0e1420;--card:#172033;--ink:#eef2f8;--muted:#9aa4b5;--line:#26324a;--brand:#7cb4ff;--accent:#ff9a5a;--ok:#4fd18b;--warn:#ffb15c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--brand)}header{background:var(--brand);color:#fff;padding:14px 16px}header a{color:#fff;text-decoration:none}
.brand{font-weight:800;letter-spacing:.04em}nav{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}nav a{padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.15);font-size:14px}
nav a.on{background:#fff;color:var(--brand)}main{max-width:720px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
.row{display:flex;gap:12px;align-items:flex-start}.row img{width:84px;height:105px;object-fit:cover;border-radius:10px}
.emoji{font-size:30px;line-height:1}.t{font-weight:700;font-size:17px}.m{color:var(--muted);font-size:14px}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--line);margin-left:6px}
.badge.ok{background:var(--ok);color:#fff}.badge.warn{background:var(--warn);color:#fff}
.days{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}.days a{flex:0 0 auto;padding:6px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card);text-decoration:none;color:var(--ink);font-size:14px}
.days a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
button,.btn{font:inherit;border:0;border-radius:10px;padding:10px 14px;background:var(--brand);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.alt{background:var(--line);color:var(--ink)}button.danger{background:#c0392b}form.inline{display:inline}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
label{display:block;font-size:14px;color:var(--muted);margin-top:10px}input,select,textarea{font:inherit;width:100%;padding:9px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.flash{background:var(--ok);color:#fff;padding:10px 14px;border-radius:10px}
.flyer{width:100%;max-width:420px;border-radius:14px;display:block;margin:8px auto}
`;

function page(title: string, body: string, opts: { lang: "es" | "en"; token?: string; on?: string; flash?: string; bot?: string } = { lang: "es" }): string {
  const s = T[opts.lang];
  const nav = opts.token
    ? `<nav>${[
        ["", s.myCruise],
        ["/program", s.program],
        ["/new", s.sponsor],
      ]
        .map(([p, label]) => `<a class="${opts.on === p ? "on" : ""}" href="/c/${esc(opts.token)}${p}">${esc(label)}</a>`)
        .join("")}${opts.bot ? `<a href="https://t.me/${esc(opts.bot)}">💬 ${esc(s.openChat)}</a>` : ""}</nav>`
    : "";
  return `<!doctype html><html lang="${opts.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Crucero Luna 2026</title><style>${CSS}</style></head><body>
<header><a class="brand" href="${opts.token ? `/c/${esc(opts.token)}` : "#"}">🌙 CRUCERO LUNA 2026</a>${nav}</header>
<main>${opts.flash ? `<p class="flash">${esc(opts.flash)}</p>` : ""}${body}</main></body></html>`;
}

const cruiseDays = (): string[] => {
  const out: string[] = [];
  for (let d = CRUISE_START; d <= CRUISE_END; d = addDays(d, 1)) out.push(d);
  return out;
};

// ---------- data helpers ----------

async function counts(store: Store, a: Activity) {
  const s = await store.listSignups(a.id);
  return { going: s.filter((x) => x.status === "going"), maybe: s.filter((x) => x.status === "maybe") };
}

async function activityCard(deps: WebDeps, a: Activity, viewer: Person, token: string, s: Strings, showDate = false): Promise<string> {
  const host = await deps.store.getPerson(a.sponsorId);
  const { going, maybe } = await counts(deps.store, a);
  const mine = [...going, ...maybe].find((x) => x.personId === viewer.id);
  const full = a.capacity !== undefined && going.length >= a.capacity;
  const flyer = a.flyerUrl?.startsWith("http") ? `<img src="${esc(a.flyerUrl)}" alt="">` : `<div class="emoji">${esc(a.emoji)}</div>`;
  const badges = [
    a.status === "cancelled" ? `<span class="badge warn">${s.cancelled}</span>` : "",
    a.sponsorId === viewer.id ? `<span class="badge">${s.hosting}</span>` : mine ? `<span class="badge ok">${mine.status === "going" ? s.going : s.maybe}</span>` : "",
    full && a.status !== "cancelled" ? `<span class="badge warn">${s.full}</span>` : "",
  ].join("");
  return `<a class="card row" style="text-decoration:none;color:inherit" href="/c/${esc(token)}/a/${esc(a.id)}">${flyer}<div>
<div class="t">${esc(a.title)}${badges}</div>
<div class="m">${showDate ? `${esc(prettyDate(shipDate(a.startsAt), viewer.language))} · ` : ""}${esc(prettyTime(a.startsAt, viewer.language))}–${esc(prettyTime(a.endsAt, viewer.language))} · ${esc(a.location)}</div>
<div class="m">${s.host}: ${esc(host?.name ?? a.sponsorId)} · ${s.going}: ${going.length}${a.capacity ? `/${a.capacity}` : ""}</div></div></a>`;
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 32 * 1024) reject(new Error("form too large"));
    });
    req.on("end", () => resolve(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

const html = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  res.end(body);
};
const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(303, { Location: to });
  res.end();
};
/** Tool outputs become one-line notices; NOT ALLOWED / ERROR keep their wording, the rest says "Done". */
const notice = (out: string, s: Strings) => (/^(NOT ALLOWED|NOT SENT|ERROR|FULL)/.test(out) ? out.replace(/ Offer to .*$/, "") : s.saved);

// ---------- handler ----------

/** Returns true when it handled the request. */
export async function handleWeb(deps: WebDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = url.pathname.match(/^\/c\/([A-Za-z0-9_.-]+)(\/.*)?$/);
  if (!m) return false;
  const token = m[1];
  const sub = m[2] ?? "";
  const viewer = await personFromToken(deps, token);
  if (!viewer) {
    html(res, 404, page("—", `<div class="card">Enlace no válido. Pídele al Capitán tu enlace: escribe <b>mi enlace</b>.<br><span class="m">Invalid link. Ask the Capitán for yours: write <b>my link</b>.</span></div>`));
    return true;
  }
  const lang = viewer.language;
  const s = T[lang];
  const now = deps.now?.() ?? new Date();
  const bot = deps.botUsername?.();
  const flash = url.searchParams.get("ok") ?? undefined;
  const tools = Object.fromEntries(
    buildTools({ store: deps.store, passenger: viewer, now, outbox: deps.outbox, channel: "web", flyers: deps.flyers }).map((t) => [t.name, t]),
  ) as Record<string, { run: (input: any) => Promise<string> }>;
  const back = (path: string, out: string) => redirect(res, `/c/${token}${path}?ok=${encodeURIComponent(notice(out, s))}`);

  // ----- writes -----
  if (req.method === "POST") {
    const f = await readForm(req);
    const act = sub.match(/^\/a\/([A-Za-z0-9-]+)\/(signup|cancel|flyer)$/);
    if (act) {
      const [, id, action] = act;
      const out =
        action === "signup"
          ? await tools.signup.run({ activity_id: id, status: f.get("status") as "going" | "maybe" | "out" })
          : action === "cancel"
            ? await tools.cancel_activity.run({ activity_id: id, reason: f.get("reason") || "—" })
            : await tools.generate_flyer.run({ activity_id: id, vibe: (f.get("vibe") ?? "fiesta") as "fiesta" });
      back(`/a/${id}`, out);
      return true;
    }
    if (sub === "/new") {
      const out = await tools.create_activity.run({
        title: f.get("title") ?? "",
        emoji: f.get("emoji") || "🎉",
        date: f.get("date") ?? "",
        start_time: f.get("start") ?? "",
        end_time: f.get("end") ?? "",
        location: f.get("location") ?? "",
        description: f.get("description") || undefined,
        capacity: f.get("capacity") ? Number(f.get("capacity")) : undefined,
        bring: f.get("bring") || undefined,
      });
      const id = out.match(/\[([A-Za-z0-9-]+)\]/)?.[1];
      if (!id) {
        html(res, 400, page(s.sponsor, `<div class="card">${esc(out)}</div><a href="/c/${esc(token)}/new">${s.back}</a>`, { lang, token, on: "/new", bot }));
        return true;
      }
      const vibe = f.get("vibe");
      if (vibe && vibe !== "none") await tools.generate_flyer.run({ activity_id: id, vibe });
      back(`/a/${id}`, out);
      return true;
    }
    if (sub === "/settings") {
      const out = await tools.set_preferences.run({
        language: (f.get("language") as "es" | "en") || undefined,
        humor: (f.get("humor") as "full" | "light" | "off") || undefined,
        wake_time: f.get("wake") || undefined,
        quiet_start: f.get("quiet_start") || undefined,
        quiet_end: f.get("quiet_end") || undefined,
        muted: f.get("muted") === "on",
      });
      back("", out);
      return true;
    }
    html(res, 404, page("—", "Not found", { lang }));
    return true;
  }

  // ----- pages -----
  if (sub === "" || sub === "/") {
    const today = shipDate(now);
    const signups = (await deps.store.listSignupsForPerson(viewer.id)).filter((x) => x.status !== "out");
    const ids = new Set(signups.map((x) => x.activityId));
    const upcoming = (await deps.store.listActivities({ from: dayBounds(today).from }))
      .filter((a) => ids.has(a.id) || a.sponsorId === viewer.id)
      .slice(0, 30);
    const cards = (await Promise.all(upcoming.map((a) => activityCard(deps, a, viewer, token, s, true)))).join("");
    const byDay = upcoming.length ? cards : `<div class="card">${s.empty}</div>`;
    const q = viewer.quietHours;
    const settings = `<details class="card"><summary><b>${s.settings}</b></summary>
<form method="post" action="/c/${esc(token)}/settings">
<div class="grid2"><div><label>${s.language}</label><select name="language"><option value="es"${lang === "es" ? " selected" : ""}>Español</option><option value="en"${lang === "en" ? " selected" : ""}>English</option></select></div>
<div><label>${s.humor}</label><select name="humor">${(["full", "light", "off"] as const).map((h) => `<option value="${h}"${viewer.humor === h ? " selected" : ""}>${{ full: s.humorFull, light: s.humorLight, off: s.humorOff }[h]}</option>`).join("")}</select></div></div>
<label>${s.wake}</label><input type="time" name="wake" value="${esc(viewer.wakeTime)}">
<label>${s.quiet}</label><div class="grid2"><input type="time" name="quiet_start" value="${esc(q?.start ?? "")}"><input type="time" name="quiet_end" value="${esc(q?.end ?? "")}"></div>
<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="muted" style="width:auto"${viewer.muted ? " checked" : ""}> ${s.mute}</label>
<div class="actions"><button>${s.save}</button></div></form></details>`;
    html(
      res,
      200,
      page(
        s.myCruise,
        `<h2>¡Hola, ${esc(viewer.nickname ?? viewer.name.split(" ")[0])}! 🌙</h2>
<h3>${s.mine}</h3>${byDay}
<div class="card">📅 <a href="${esc(deps.publicUrl)}/cal/${esc(viewer.icsToken)}.ics">${s.calendar}</a></div>${settings}`,
        { lang, token, on: "", flash, bot },
      ),
    );
    return true;
  }

  if (sub === "/program") {
    const days = cruiseDays();
    const today = shipDate(now);
    const date = url.searchParams.get("date") ?? (days.includes(today) ? today : days[0]);
    const { from, to } = dayBounds(date);
    const acts = await deps.store.listActivities({ from, to });
    const tabs = `<div class="days">${days.map((d) => `<a class="${d === date ? "on" : ""}" href="/c/${esc(token)}/program?date=${d}">${esc(prettyDate(d, lang))}</a>`).join("")}</div>`;
    const cards = acts.length ? (await Promise.all(acts.map((a) => activityCard(deps, a, viewer, token, s)))).join("") : `<div class="card">${s.empty}</div>`;
    html(res, 200, page(s.program, `${tabs}<h2>${esc(prettyDate(date, lang))}</h2>${cards}`, { lang, token, on: "/program", flash, bot }));
    return true;
  }

  const one = sub.match(/^\/a\/([A-Za-z0-9-]+)$/);
  if (one) {
    const a = await deps.store.getActivity(one[1]);
    if (!a) {
      html(res, 404, page("—", `<div class="card">—</div>`, { lang, token, bot }));
      return true;
    }
    const host = await deps.store.getPerson(a.sponsorId);
    const { going, maybe } = await counts(deps.store, a);
    const names = async (list: { personId: string }[]) =>
      (await Promise.all(list.map(async (x) => (await deps.store.getPerson(x.personId))?.name ?? x.personId))).join(", ") || s.nobody;
    const mine = [...going, ...maybe].find((x) => x.personId === viewer.id)?.status;
    const canManage = a.sponsorId === viewer.id || (!!host?.guardianId && host.guardianId === viewer.id);
    const live = a.status !== "cancelled";
    const btn = (status: string, label: string, alt: boolean) =>
      `<form class="inline" method="post" action="/c/${esc(token)}/a/${esc(a.id)}/signup"><input type="hidden" name="status" value="${status}"><button class="${alt ? "alt" : ""}">${label}</button></form>`;
    const vibes = ["fiesta", "zen", "retro-cruise", "kids", "gala"];
    const body = `<a href="/c/${esc(token)}/program?date=${shipDate(a.startsAt)}">${s.back}</a>
<div class="card"><div class="emoji">${esc(a.emoji)}</div><h2 style="margin:6px 0">${esc(a.title)}${live ? "" : ` <span class="badge warn">${s.cancelled}</span>`}</h2>
<div>🗓 ${esc(prettyDate(shipDate(a.startsAt), lang))} · ${esc(prettyTime(a.startsAt, lang))}–${esc(prettyTime(a.endsAt, lang))}</div>
<div>📍 ${esc(a.location)}</div><div>⭐ ${s.host}: ${esc(host?.name ?? a.sponsorId)}</div>
${a.bring ? `<div>🎒 ${s.bring}: ${esc(a.bring)}</div>` : ""}${a.capacity ? `<div>👥 ${s.capacity}: ${going.length}/${a.capacity}</div>` : ""}
${a.description ? `<p>${esc(a.description)}</p>` : ""}${a.cancelledReason ? `<p class="m">${esc(a.cancelledReason)}</p>` : ""}
${live ? `<div class="actions">${btn("going", s.imIn, mine === "going")}${btn("maybe", s.maybeBtn, mine !== "maybe")}${mine ? btn("out", s.out, true) : ""}</div>` : ""}</div>
<div class="card"><b>${s.going}:</b> ${esc(await names(going))}<br><b>${s.maybe}:</b> ${esc(await names(maybe))}</div>
${a.flyerUrl?.startsWith("http") ? `<img class="flyer" src="${esc(a.flyerUrl)}" alt="${s.flyer}">` : ""}
${live ? `<form class="card" method="post" action="/c/${esc(token)}/a/${esc(a.id)}/flyer" onsubmit="this.querySelector('button').textContent='${s.working}'"><b>${s.flyer}</b>
<div class="actions"><select name="vibe" style="width:auto">${vibes.map((v) => `<option>${v}</option>`).join("")}</select><button>${s.makeFlyer}</button></div></form>` : ""}
${canManage && live ? `<form class="card" method="post" action="/c/${esc(token)}/a/${esc(a.id)}/cancel"><label>${s.reason}</label><input name="reason" required maxlength="200"><div class="actions"><button class="danger">${s.cancel}</button></div></form>` : ""}`;
    html(res, 200, page(a.title, body, { lang, token, flash, bot }));
    return true;
  }

  if (sub === "/new") {
    const days = cruiseDays();
    const today = shipDate(now);
    const vibes = ["fiesta", "zen", "retro-cruise", "kids", "gala"];
    const body = `<form class="card" method="post" action="/c/${esc(token)}/new" onsubmit="this.querySelector('button').textContent='${s.working}'">
<h2 style="margin-top:0">${s.title}</h2>
<div class="grid2"><div><label>${s.title}</label><input name="title" required minlength="3" maxlength="80"></div><div><label>${s.emoji}</label><input name="emoji" value="🎉" maxlength="4"></div></div>
<label>${s.date}</label><select name="date">${days.map((d) => `<option value="${d}"${d === today ? " selected" : ""}>${esc(prettyDate(d, lang))}</option>`).join("")}</select>
<div class="grid2"><div><label>${s.start}</label><input type="time" name="start" required></div><div><label>${s.end}</label><input type="time" name="end" required></div></div>
<label>${s.place}</label><input name="location" required maxlength="80" placeholder="Lido Deck (balcón)">
<div class="grid2"><div><label>${s.capacity}</label><input type="number" name="capacity" min="1"></div><div><label>${s.bring}</label><input name="bring" maxlength="120"></div></div>
<label>${s.description}</label><textarea name="description" maxlength="400" rows="3"></textarea>
<label>${s.flyer}</label><select name="vibe"><option value="none">${s.noFlyer}</option>${vibes.map((v) => `<option value="${v}">${s.flyerToo}: ${v}</option>`).join("")}</select>
<div class="actions"><button>${s.create}</button></div></form>`;
    html(res, 200, page(s.sponsor, body, { lang, token, on: "/new", flash, bot }));
    return true;
  }

  html(res, 404, page("—", `<div class="card">—</div>`, { lang, token, bot }));
  return true;
}
