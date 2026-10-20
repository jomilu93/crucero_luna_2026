/**
 * The web side of the ship, served by the same process as the chat webhook:
 *
 *   /c/<cabin token>                 → "Mi crucero": countdown/day hero, next up, my plan, discover, settings
 *   /c/<cabin token>/program?date=   → the program for a day (Dec 26 – Jan 2 chips), as a timeline
 *   /c/<cabin token>/a/<id>          → one activity: hero, who's going, sign-up bar, flyer, host actions
 *   /c/<cabin token>/new             → sponsor form
 *   /c/<cabin token>/admin           → admin panel (admins only): pause switch, manifest, kids, removals, TV link
 *   /tv/<tv key>  (+ /data.json)     → TV mode for the apartment screen (tv.ts)
 *
 * Every write goes through the Capitán's own tools (buildTools), so permissions, capacity,
 * waitlists and quiet hours are identical on the web and in the chat. A cabin token is
 * "<person id>.<hmac(person id + ics token)>": unguessable, and revoked by rotating the ICS token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type FlyerMaker, type Outbox, buildTools, headlineFor } from "@crucero/agent";
import {
  type Activity,
  type Person,
  type Store,
  CRUISE_END,
  CRUISE_START,
  SHIP_TZ,
  addDays,
  dayBounds,
  isPaused,
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
    create: "Publicar actividad", flyerToo: "Hacer flyer con estilo", noFlyer: "Sin flyer por ahora", openChat: "Hablar con el Capitán", back: "Volver",
    humorFull: "Completo", humorLight: "Ligero", humorOff: "Sin chistes", saved: "Listo.", working: "El Capitán está en la imprenta…",
    hello: "¡Hola", daysToSail: "días para zarpar", dayToSail: "día para zarpar", dayOf: "Día", of: "de", thanks: "¡Gracias por navegar con nosotros!",
    nextUp: "Lo siguiente para ti", discover: "Descubre a bordo", seeAll: "Ver todo", chat: "Capitán", noneDay: "Nada en el programa este día todavía. ¿Organizas algo?",
    spots: "lugares", spotsLeft: "quedan", youreIn: "Vas", youMaybe: "Tal vez vas", whoGoing: "Quién va", details: "Detalles", hostTools: "Herramientas del anfitrión",
    newSub: "Publica tu actividad y el Capitán la anuncia a bordo.", when: "Cuándo", extra: "Extras", sail: "Acapulco · 26 dic – 2 ene",
    admin: "Admin", adminTitle: "Puente de mando", running: "El barco navega", paused: "Barco en pausa",
    runningSub: "Mensajes de la mañana, recordatorios y respuestas activos.", pausedSub: "No sale nada proactivo y los pasajeros reciben un aviso de fuera de servicio.",
    pause: "Pausar el barco", resume: "Reanudar", passengers: "Pasajeros", activities: "Actividades", signups: "Inscripciones", tv: "Modo TV",
    tvSub: "Ábrelo en la tele del depa: ahora, sigue y flyers.", role: "Rol", adult: "Adulto", kid: "Niño", guardian: "Tutor", saveRole: "Guardar rol",
    makeAdmin: "Hacer admin", removeAdmin: "Quitar admin", remove: "Quitar del barco", confirmRemove: "¿Quitar a esta persona del barco? No se puede deshacer.",
    joined: "Abordó", muted: "Silenciado", noChat: "sin chat", hostsN: "organiza",
  },
  en: {
    myCruise: "My cruise", program: "Program", sponsor: "Host", today: "Today", hosting: "You host", mine: "Your plan",
    empty: "Your deck chair looks lonely. Pick something from the program or host one yourself.", going: "Going", maybe: "Maybe", nobody: "nobody yet",
    imIn: "I'm in!", maybeBtn: "Maybe", out: "Not going", cancelled: "CANCELLED", full: "FULL", host: "Host", bring: "Bring",
    capacity: "Capacity", flyer: "Flyer", makeFlyer: "Make a flyer", cancel: "Cancel activity", reason: "Reason", calendar: "Add to my calendar",
    settings: "Settings", language: "Language", humor: "Humor", quiet: "Quiet hours", wake: "Morning program at", mute: "Don't message me (I only reply when you write)",
    save: "Save", title: "What are you hosting?", emoji: "Emoji", date: "Day", start: "Starts", end: "Ends", place: "Where", description: "Description",
    create: "Publish activity", flyerToo: "Make a flyer in style", noFlyer: "No flyer for now", openChat: "Chat with the Capitán", back: "Back",
    humorFull: "Full", humorLight: "Light", humorOff: "No jokes", saved: "Done.", working: "The Capitán is at the print shop…",
    hello: "Hi", daysToSail: "days to sail", dayToSail: "day to sail", dayOf: "Day", of: "of", thanks: "Thanks for sailing with us!",
    nextUp: "Next up for you", discover: "Discover on board", seeAll: "See all", chat: "Capitán", noneDay: "Nothing on the program this day yet. Host something?",
    spots: "spots", spotsLeft: "left", youreIn: "You're in", youMaybe: "Maybe", whoGoing: "Who's going", details: "Details", hostTools: "Host tools",
    newSub: "Publish your activity and the Capitán announces it on board.", when: "When", extra: "Extras", sail: "Acapulco · Dec 26 – Jan 2",
    admin: "Admin", adminTitle: "The Bridge", running: "The ship is sailing", paused: "Ship paused",
    runningSub: "Morning programs, reminders and replies are on.", pausedSub: "Nothing proactive goes out and passengers get an off-duty notice.",
    pause: "Pause the ship", resume: "Resume", passengers: "Passengers", activities: "Activities", signups: "Sign-ups", tv: "TV mode",
    tvSub: "Open it on the apartment TV: now, next and flyers.", role: "Role", adult: "Adult", kid: "Kid", guardian: "Guardian", saveRole: "Save role",
    makeAdmin: "Make admin", removeAdmin: "Remove admin", remove: "Remove from the ship", confirmRemove: "Remove this person from the ship? This cannot be undone.",
    joined: "Boarded", muted: "Muted", noChat: "no chat", hostsN: "hosts",
  },
} as const satisfies Record<"es" | "en", Record<string, string>>;
type Strings = Record<keyof (typeof T)["es"], string>;

// ---------- html ----------

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ICON: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  bag: '<path d="M5 8h14l-1 13H6z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const icon = (name: string, size = 20, cls = "ic") =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/** Placeholder art for activities without a flyer: an ocean gradient picked from the id. */
const ART = [
  "linear-gradient(135deg,#0b3d91,#1aa0c8)",
  "linear-gradient(135deg,#ff7e5f,#feb47b)",
  "linear-gradient(135deg,#134e5e,#71b280)",
  "linear-gradient(135deg,#41295a,#2f0743)",
  "linear-gradient(135deg,#f7971e,#ffd200)",
  "linear-gradient(135deg,#00b4db,#0083b0)",
];
const artFor = (id: string) => ART[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % ART.length];
const hasFlyer = (a: Activity) => !!a.flyerUrl?.startsWith("http");
const cover = (a: Activity, cls = "cover", height?: number) => {
  const h = height ? `height:${height}px;` : "";
  return hasFlyer(a)
    ? `<div class="${cls} fly" style="${h}"><i style="background-image:url('${esc(a.flyerUrl)}')"></i><img src="${esc(a.flyerUrl)}" alt="" loading="lazy"></div>`
    : `<div class="${cls} art" style="${h}background:${artFor(a.id)}"><span>${esc(a.emoji)}</span></div>`;
};

const AVATAR = ["#1565d8", "#0e9f6e", "#d97706", "#c026d3", "#dc2626", "#0891b2", "#4f46e5"];
const avatar = (p: Pick<Person, "id" | "name">, size = 36) => {
  const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const bg = AVATAR[[...p.id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR.length];
  return `<span class="av" style="width:${size}px;height:${size}px;background:${bg};font-size:${Math.round(size * 0.38)}px">${esc(initials)}</span>`;
};

const shortDay = (date: string, lang: "es" | "en") => {
  const d = new Date(`${date}T12:00:00-06:00`);
  const loc = lang === "es" ? "es-MX" : "en-US";
  const wd = new Intl.DateTimeFormat(loc, { timeZone: SHIP_TZ, weekday: "short" }).format(d).replace(".", "");
  const day = new Intl.DateTimeFormat(loc, { timeZone: SHIP_TZ, day: "numeric" }).format(d);
  const mon = new Intl.DateTimeFormat(loc, { timeZone: SHIP_TZ, month: "short" }).format(d).replace(".", "");
  return { wd, day, mon };
};

const CSS = `
:root{--navy:#0b1f3f;--blue:#1565d8;--blue2:#0d4fb0;--sky:#e8f1fd;--gold:#f2b632;--bg:#f2f5f9;--card:#fff;--ink:#0b1f3f;--muted:#5b6b82;--line:#e3e9f1;--ok:#0e8a5f;--warn:#c2410c;--danger:#c62828;--shadow:0 6px 20px rgba(11,31,63,.08)}
@media (prefers-color-scheme:dark){:root{--bg:#06101e;--card:#0f1d33;--ink:#eaf1fb;--muted:#9db0c8;--line:#1d2f4b;--sky:#13284a;--blue:#4c94ff;--blue2:#3a7ee6;--shadow:0 6px 20px rgba(0,0,0,.35)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 "Plus Jakarta Sans",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding-bottom:calc(84px + env(safe-area-inset-bottom))}
a{color:var(--blue)}.ic{flex:none;vertical-align:-4px}
.app{max-width:560px;margin:0 auto}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:rgba(11,31,63,.96);backdrop-filter:blur(10px);color:#fff}
.top a{color:#fff;text-decoration:none}.logo{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.06em;font-size:15px}
.logo .moon{width:30px;height:30px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff6d5,#f2b632 70%);box-shadow:0 0 14px rgba(242,182,50,.6)}
.logo small{display:block;white-space:nowrap;font-weight:500;letter-spacing:0;opacity:.7;font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:7px 12px;background:rgba(255,255,255,.14);font-size:13px;font-weight:600}
main{padding:16px}
.hero{position:relative;overflow:hidden;border-radius:24px;padding:22px 20px 26px;color:#fff;background:linear-gradient(160deg,#0b2a5b 0%,#0a4d8c 55%,#16a3c9 100%);box-shadow:var(--shadow)}
.hero:after{content:"";position:absolute;left:0;right:0;bottom:0;height:46px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 46' preserveAspectRatio='none'%3E%3Cpath d='M0 22c50-18 100-18 150 0s100 18 150 0 70-14 100-6v30H0z' fill='%23ffffff' fill-opacity='.14'/%3E%3Cpath d='M0 32c60-14 110-12 170 2s120 12 170-2 45-8 60-4v18H0z' fill='%23ffffff' fill-opacity='.18'/%3E%3C/svg%3E") center/100% 100% no-repeat}
.hero .moon{position:absolute;right:22px;top:20px;width:58px;height:58px;border-radius:50%;background:radial-gradient(circle at 38% 38%,#fffaf0,#ffe7a3 55%,#f2b632);box-shadow:0 0 0 10px rgba(255,231,163,.10),0 0 0 22px rgba(255,231,163,.06),0 0 40px rgba(242,182,50,.55)}
.hero .eyebrow{font-size:13px;letter-spacing:.14em;text-transform:uppercase;opacity:.8;font-weight:700}
.hero h1{margin:6px 0 4px;font-size:28px;line-height:1.15}.hero .big{font-size:44px;font-weight:800;line-height:1;margin-top:14px}
.hero .sub{opacity:.85;font-size:15px}.cap{display:inline-block}.cap::first-letter{text-transform:uppercase}.hero .headline{margin-top:10px;display:inline-block;background:rgba(255,255,255,.16);border-radius:12px;padding:6px 10px;font-size:13px;font-weight:600}
.quick{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0 4px}
.quick a{display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;color:var(--ink);font-size:12px;font-weight:600;text-align:center}
.quick span.q{width:54px;height:54px;border-radius:18px;display:grid;place-items:center;background:var(--card);color:var(--blue);box-shadow:var(--shadow)}
h2.sec{display:flex;justify-content:space-between;align-items:baseline;font-size:19px;margin:24px 2px 10px}h2.sec a{font-size:14px;font-weight:600;text-decoration:none}
.card{background:var(--card);border-radius:20px;box-shadow:var(--shadow);margin:12px 0;overflow:hidden}
.pad{padding:16px}.m{color:var(--muted);font-size:14px}
.feature{display:block;text-decoration:none;color:inherit}.feature .cover{height:190px}
.cover{background-size:cover;background-position:center 20%;background-color:var(--sky)}
.fly{position:relative;overflow:hidden;background:#0b1f3f}.fly i{position:absolute;inset:-20px;background-size:cover;background-position:center;filter:blur(18px) brightness(.8)}
.fly img{position:relative;display:block;height:100%;width:100%;object-fit:contain}.thumb.fly img{object-fit:cover;object-position:center 30%}
.art{display:grid;place-items:center}.art span{font-size:56px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.25))}
.feature .body{padding:14px 16px 16px}.t{font-weight:800;font-size:18px;line-height:1.25}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--muted);font-size:14px;margin-top:6px}.meta span{display:inline-flex;gap:5px;align-items:center}
.badge{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.04em;padding:4px 9px;border-radius:999px;background:var(--sky);color:var(--blue);vertical-align:2px}
.badge.ok{background:#e3f6ee;color:var(--ok)}.badge.warn{background:#fdecdf;color:var(--warn)}.badge.gold{background:#fdf3d9;color:#8a5a00}
@media (prefers-color-scheme:dark){.badge.ok{background:#0f3328}.badge.warn{background:#3a1d0e}.badge.gold{background:#3a2c0a;color:#f2c75c}}
.list{display:flex;flex-direction:column}.item{display:flex;gap:12px;align-items:center;padding:12px 14px;text-decoration:none;color:inherit;border-top:1px solid var(--line)}
.item:first-child{border-top:0}.item .thumb{width:64px;height:64px;border-radius:14px;flex:none}.item .thumb.art span{font-size:28px}.item .grow{flex:1;min-width:0}
.item .tt{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.item .ic.go{color:var(--muted)}
.carousel{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding:0 16px;margin:0 -16px;padding:2px 16px 8px;scrollbar-width:none}.carousel::-webkit-scrollbar{display:none}
.tile{flex:0 0 72%;max-width:300px;scroll-snap-align:start;background:var(--card);border-radius:20px;overflow:hidden;box-shadow:var(--shadow);text-decoration:none;color:inherit}
.tile .cover{height:150px}.tile .body{padding:12px 14px 14px}.tile .t{font-size:16px}
.days{position:sticky;top:58px;z-index:4;display:flex;gap:8px;overflow-x:auto;margin:-16px -16px 8px;padding:12px 16px;background:var(--bg);scrollbar-width:none}.days::-webkit-scrollbar{display:none}
.days a{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;min-width:56px;padding:8px 6px;border-radius:16px;background:var(--card);box-shadow:var(--shadow);text-decoration:none;color:var(--ink)}
.days a small{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.days a b{font-size:20px;line-height:1.2}
.days a.on{background:var(--blue);color:#fff}.days a.on small{color:rgba(255,255,255,.8)}
.dayhead{margin:6px 2px 4px}.dayhead h1{font-size:22px;margin:0}.dayhead h1::first-letter{text-transform:uppercase}
.tl{position:relative;margin-left:4px}.tl .row{display:flex;gap:12px}.tl .time{width:62px;flex:none;text-align:right;padding-top:16px;font-weight:700;font-size:14px}
.tl .time small{display:block;color:var(--muted);font-weight:500}.tl .card{flex:1;margin:8px 0}
.ahero{position:relative;margin:-16px -16px 0;height:340px;color:#fff}.ahero .cover{position:absolute;inset:0}
.ahero:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.3) 0%,rgba(0,0,0,0) 25%);pointer-events:none}
.atitle{position:relative;z-index:2;margin:12px 0 0;padding:18px 18px 16px;border-radius:22px;background:var(--card);box-shadow:var(--shadow)}.atitle h1{margin:6px 0 0;font-size:25px;line-height:1.2}
.ahero .backbtn{position:absolute;z-index:1;top:14px;left:14px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:rgba(11,31,63,.55);color:#fff;backdrop-filter:blur(6px)}
.info{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.info>div{background:var(--card);border-radius:16px;padding:12px;box-shadow:var(--shadow);font-size:14px}.info>div b{display:block;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.info .ic{color:var(--blue);margin-right:4px}
.bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),#16a3c9);border-radius:99px}
.faces{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.face{display:flex;align-items:center;gap:8px;background:var(--bg);border-radius:999px;padding:4px 12px 4px 4px;font-size:14px}
.av{display:inline-grid;place-items:center;border-radius:50%;color:#fff;font-weight:800;flex:none}
.cta{position:fixed;left:0;right:0;bottom:calc(68px + env(safe-area-inset-bottom));z-index:6;padding:10px 16px;background:linear-gradient(180deg,transparent,var(--bg) 30%)}
.cta .in{max-width:528px;margin:0 auto;display:flex;gap:8px}.cta form{flex:1;display:flex}.cta button{flex:1}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:14px;padding:13px 16px;background:var(--blue);color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}
button:active{transform:scale(.98)}button.alt,.btn.alt{background:var(--sky);color:var(--blue)}button.ghost{background:var(--card);color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}
button.danger{background:var(--danger)}button.small{padding:9px 12px;font-size:14px;border-radius:12px}form.inline{display:inline}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
label{display:block;font-size:13px;font-weight:700;color:var(--muted);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.05em}
input,select,textarea{font:inherit;width:100%;padding:12px 13px;border-radius:14px;border:1.5px solid var(--line);background:var(--bg);color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--blue)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid2 label{margin-top:14px}
.check{display:flex;gap:10px;align-items:center;text-transform:none;letter-spacing:0;font-size:15px;color:var(--ink);font-weight:500}.check input{width:22px;height:22px}
.flash{position:fixed;left:16px;right:16px;top:70px;z-index:9;max-width:528px;margin:0 auto;background:var(--navy);color:#fff;padding:12px 16px;border-radius:14px;box-shadow:var(--shadow);font-weight:600;animation:fade 4s forwards}
@keyframes fade{0%,80%{opacity:1}100%{opacity:0;visibility:hidden}}
.flyerimg{width:100%;display:block}
details.card summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:16px;font-weight:700}details.card summary::-webkit-details-marker{display:none}
details.card summary .ic.go{margin-left:auto;transition:transform .2s}details[open].card summary .ic.go{transform:rotate(90deg)}details.card .pad{padding-top:0}
.tabs{position:fixed;left:0;right:0;bottom:0;z-index:7;background:var(--card);box-shadow:0 -4px 20px rgba(11,31,63,.08);padding-bottom:env(safe-area-inset-bottom)}
.tabs .in{max-width:560px;margin:0 auto;display:flex}.tabs a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 0 10px;font-size:11px;font-weight:700;color:var(--muted);text-decoration:none}
.tabs a.on{color:var(--blue)}.tabs a.mid span.q{width:46px;height:46px;margin-top:-20px;border-radius:50%;display:grid;place-items:center;background:var(--blue);color:#fff;box-shadow:0 6px 16px rgba(21,101,216,.4)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stats div{background:var(--card);border-radius:16px;padding:12px;text-align:center;box-shadow:var(--shadow)}.stats b{display:block;font-size:24px}
.status{display:flex;gap:14px;align-items:center}.dot{width:14px;height:14px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 6px rgba(14,138,95,.15);flex:none}.dot.off{background:var(--warn);box-shadow:0 0 0 6px rgba(194,65,12,.15)}
.empty{text-align:center;padding:28px 18px;color:var(--muted)}.empty .e{font-size:40px}
`;

type Tab = "" | "/program" | "/new" | "/admin" | undefined;

function page(
  title: string,
  body: string,
  opts: { lang: "es" | "en"; token?: string; on?: Tab; flash?: string; bot?: string; admin?: boolean; bare?: boolean; cta?: string } = { lang: "es" },
): string {
  const s = T[opts.lang];
  const base = opts.token ? `/c/${esc(opts.token)}` : "";
  const tab = (p: Tab, label: string, ic: string, mid = false) =>
    `<a class="${opts.on === p ? "on" : ""}${mid ? " mid" : ""}" href="${base}${p}">${mid ? `<span class="q">${icon(ic, 24)}</span>` : icon(ic, 24)}${esc(label)}</a>`;
  const tabs = opts.token
    ? `<nav class="tabs"><div class="in">${tab("", s.myCruise, "home")}${tab("/program", s.program, "calendar")}${tab("/new", s.sponsor, "plus", true)}${
        opts.bot ? `<a href="https://t.me/${esc(opts.bot)}">${icon("chat", 24)}${esc(s.chat)}</a>` : ""
      }${opts.admin ? tab("/admin", s.admin, "shield") : ""}</div></nav>`
    : "";
  const top = opts.bare
    ? ""
    : `<header class="top"><a class="logo" href="${base || "#"}"><span class="moon"></span><span>CRUCERO LUNA<small>${esc(s.sail)}</small></span></a>${
        opts.bot ? `<a class="pill" href="https://t.me/${esc(opts.bot)}" aria-label="${esc(s.openChat)}">${icon("chat", 16)} ${esc(s.chat)}</a>` : ""
      }</header>`;
  return `<!doctype html><html lang="${opts.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1f3f"><title>${esc(title)} · Crucero Luna 2026</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="app">${top}
<main>${opts.flash ? `<div class="flash" role="status">${esc(opts.flash)}</div>` : ""}${body}</main></div>${opts.cta ?? ""}${tabs}</body></html>`;
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

async function badgesFor(deps: WebDeps, a: Activity, viewer: Person, s: Strings): Promise<string> {
  const { going, maybe } = await counts(deps.store, a);
  const mine = [...going, ...maybe].find((x) => x.personId === viewer.id);
  const full = a.capacity !== undefined && going.length >= a.capacity;
  return [
    a.status === "cancelled" ? `<span class="badge warn">${s.cancelled}</span>` : "",
    a.sponsorId === viewer.id ? `<span class="badge gold">${s.hosting}</span>` : mine ? `<span class="badge ok">${mine.status === "going" ? s.youreIn : s.youMaybe}</span>` : "",
    full && a.status !== "cancelled" ? `<span class="badge warn">${s.full}</span>` : "",
  ].join(" ");
}

/** Compact list row: thumbnail, title, time · place, badges. */
async function activityRow(deps: WebDeps, a: Activity, viewer: Person, token: string, s: Strings, showDate = false): Promise<string> {
  const lang = viewer.language;
  const host = await deps.store.getPerson(a.sponsorId);
  const { going } = await counts(deps.store, a);
  const when = `${showDate ? `${esc(shortDay(shipDate(a.startsAt), lang).wd)} ${esc(shortDay(shipDate(a.startsAt), lang).day)} · ` : ""}${esc(prettyTime(a.startsAt, lang))}`;
  return `<a class="item" href="/c/${esc(token)}/a/${esc(a.id)}">${cover(a, "thumb cover")}<div class="grow">
<div class="tt">${esc(a.title)}</div><div class="m">${when} · ${esc(a.location)}</div>
<div class="m">${s.host}: ${esc(host?.name ?? a.sponsorId)} · ${going.length}${a.capacity ? `/${a.capacity}` : ""} ${s.going.toLowerCase()} ${await badgesFor(deps, a, viewer, s)}</div></div>${icon("chevron", 18, "ic go")}</a>`;
}

/** Big card with cover art, for "next up" and the day timeline. */
async function activityFeature(deps: WebDeps, a: Activity, viewer: Person, token: string, s: Strings, opts: { showDate?: boolean; coverHeight?: number } = {}): Promise<string> {
  const lang = viewer.language;
  const host = await deps.store.getPerson(a.sponsorId);
  const { going } = await counts(deps.store, a);
  const date = shipDate(a.startsAt);
  return `<a class="card feature" href="/c/${esc(token)}/a/${esc(a.id)}">${cover(a, "cover", opts.coverHeight)}<div class="body">
<div class="t">${esc(a.title)} ${await badgesFor(deps, a, viewer, s)}</div>
<div class="meta"><span>${icon("clock", 16)}${opts.showDate ? `${esc(prettyDate(date, lang))} · ` : ""}${esc(prettyTime(a.startsAt, lang))}–${esc(prettyTime(a.endsAt, lang))}</span>
<span>${icon("pin", 16)}${esc(a.location)}</span><span>${icon("star", 16)}${esc(host?.name ?? a.sponsorId)}</span><span>${icon("users", 16)}${going.length}${a.capacity ? `/${a.capacity}` : ""}</span></div></div></a>`;
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
    html(res, 404, page("—", `<div class="card pad">Enlace no válido. Pídele al Capitán tu enlace: escribe <b>mi enlace</b>.<br><span class="m">Invalid link. Ask the Capitán for yours: write <b>my link</b>.</span></div>`));
    return true;
  }
  const lang = viewer.language;
  const s = T[lang];
  const now = deps.now?.() ?? new Date();
  const bot = deps.botUsername?.();
  const flash = url.searchParams.get("ok") ?? undefined;
  const admin = viewer.admin === true;
  const opts = (on: Tab, extra: { cta?: string } = {}) => ({ lang, token, on, flash, bot, admin, ...extra });
  const tools = Object.fromEntries(
    buildTools({ store: deps.store, passenger: viewer, now, outbox: deps.outbox, channel: "web", flyers: deps.flyers }).map((t) => [t.name, t]),
  ) as Record<string, { run: (input: any) => Promise<string> }>;
  const back = (path: string, out: string) => redirect(res, `/c/${token}${path}?ok=${encodeURIComponent(notice(out, s))}`);
  const notFound = () => html(res, 404, page("—", `<div class="card pad">—</div>`, opts(undefined)));

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
        html(res, 400, page(s.sponsor, `<div class="card pad">${esc(out)}</div><a class="btn alt" href="/c/${esc(token)}/new">${s.back}</a>`, opts("/new")));
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
    const adm = sub.match(/^\/admin\/(pause|role|admin|remove)$/);
    if (adm && admin) {
      const person = f.get("person") ?? "";
      const out =
        adm[1] === "pause"
          ? await tools.admin_pause.run({ paused: f.get("paused") === "on" })
          : adm[1] === "role"
            ? await tools.admin_set_role.run({ person, role: f.get("role") === "kid" ? "kid" : "adult", guardian: f.get("guardian") || undefined })
            : adm[1] === "admin"
              ? await tools.admin_set_admin.run({ person, admin: f.get("admin") === "on" })
              : await tools.admin_remove_passenger.run({ person });
      back("/admin", out);
      return true;
    }
    notFound();
    return true;
  }

  // ----- pages -----
  if (sub === "" || sub === "/") {
    const days = cruiseDays();
    const today = shipDate(now);
    const first = viewer.nickname ?? viewer.name.split(" ")[0];
    const sailMs = Date.parse(`${CRUISE_START}T00:00:00-06:00`) - now.getTime();
    const dayIdx = days.indexOf(today);
    const headline = headlineFor(today);
    const hero =
      sailMs > 0
        ? (() => {
            const n = Math.ceil(sailMs / 86_400_000);
            return `<div class="eyebrow">${esc(s.sail)}</div><h1>${s.hello}, ${esc(first)}! 🌙</h1><div class="big">${n}</div><div class="sub">${n === 1 ? s.dayToSail : s.daysToSail}</div>`;
          })()
        : dayIdx >= 0
          ? `<div class="eyebrow">${s.dayOf} ${dayIdx + 1} ${s.of} ${days.length}</div><h1>${s.hello}, ${esc(first)}! 🌙</h1><div class="sub cap">${esc(prettyDate(today, lang))}</div>${headline ? `<div class="headline">${esc(headline)}</div>` : ""}`
          : `<div class="eyebrow">Crucero Luna 2026</div><h1>${s.hello}, ${esc(first)}! 🌙</h1><div class="sub">${s.thanks}</div>`;

    const signups = (await deps.store.listSignupsForPerson(viewer.id)).filter((x) => x.status !== "out");
    const ids = new Set(signups.map((x) => x.activityId));
    const fromToday = await deps.store.listActivities({ from: dayBounds(today).from });
    const nowIso = now.toISOString();
    const upcoming = fromToday.filter((a) => (ids.has(a.id) || a.sponsorId === viewer.id) && a.endsAt > nowIso).slice(0, 30);
    const next = upcoming[0];
    const discover = fromToday.filter((a) => !ids.has(a.id) && a.sponsorId !== viewer.id && a.startsAt > nowIso).slice(0, 8);

    const quick = `<div class="quick">
<a href="/c/${esc(token)}/program"><span class="q">${icon("calendar", 24)}</span>${s.program}</a>
<a href="/c/${esc(token)}/new"><span class="q">${icon("plus", 24)}</span>${s.sponsor}</a>
<a href="${esc(deps.publicUrl)}/cal/${esc(viewer.icsToken)}.ics"><span class="q">${icon("clock", 24)}</span>${lang === "es" ? "Calendario" : "Calendar"}</a>
${bot ? `<a href="https://t.me/${esc(bot)}"><span class="q">${icon("chat", 24)}</span>${s.chat}</a>` : `<a href="#settings"><span class="q">${icon("gear", 24)}</span>${s.settings}</a>`}</div>`;

    const nextBlock = next ? `<h2 class="sec">${s.nextUp}</h2>${await activityFeature(deps, next, viewer, token, s, { showDate: true })}` : "";
    const rest = upcoming.slice(next ? 1 : 0);
    const plan = upcoming.length
      ? rest.length
        ? `<h2 class="sec">${s.mine}<a href="/c/${esc(token)}/program">${s.seeAll}</a></h2><div class="card list">${(await Promise.all(rest.map((a) => activityRow(deps, a, viewer, token, s, true)))).join("")}</div>`
        : ""
      : `<h2 class="sec">${s.mine}</h2><div class="card empty"><div class="e">🏖️</div>${s.empty}<div class="actions" style="justify-content:center"><a class="btn" href="/c/${esc(token)}/program">${s.program}</a><a class="btn alt" href="/c/${esc(token)}/new">${s.sponsor}</a></div></div>`;
    const tiles = discover.length
      ? `<h2 class="sec">${s.discover}<a href="/c/${esc(token)}/program">${s.seeAll}</a></h2><div class="carousel">${(
          await Promise.all(
            discover.map(async (a) => {
              const { going } = await counts(deps.store, a);
              return `<a class="tile" href="/c/${esc(token)}/a/${esc(a.id)}">${cover(a)}<div class="body"><div class="t">${esc(a.title)}</div><div class="m">${esc(shortDay(shipDate(a.startsAt), lang).wd)} ${esc(shortDay(shipDate(a.startsAt), lang).day)} · ${esc(prettyTime(a.startsAt, lang))} · ${going.length}${a.capacity ? `/${a.capacity}` : ""} ${s.going.toLowerCase()}</div></div></a>`;
            }),
          )
        ).join("")}</div>`
      : "";

    const q = viewer.quietHours;
    const settings = `<details class="card" id="settings"><summary>${icon("gear")} ${s.settings}${icon("chevron", 18, "ic go")}</summary><div class="pad">
<form method="post" action="/c/${esc(token)}/settings">
<div class="grid2"><div><label>${s.language}</label><select name="language"><option value="es"${lang === "es" ? " selected" : ""}>Español</option><option value="en"${lang === "en" ? " selected" : ""}>English</option></select></div>
<div><label>${s.humor}</label><select name="humor">${(["full", "light", "off"] as const).map((h) => `<option value="${h}"${viewer.humor === h ? " selected" : ""}>${{ full: s.humorFull, light: s.humorLight, off: s.humorOff }[h]}</option>`).join("")}</select></div></div>
<label>${s.wake}</label><input type="time" name="wake" value="${esc(viewer.wakeTime)}">
<label>${s.quiet}</label><div class="grid2"><input type="time" name="quiet_start" value="${esc(q?.start ?? "")}"><input type="time" name="quiet_end" value="${esc(q?.end ?? "")}"></div>
<label class="check"><input type="checkbox" name="muted"${viewer.muted ? " checked" : ""}> ${s.mute}</label>
<div class="actions"><button>${s.save}</button></div></form></div></details>
<div class="card list"><a class="item" href="${esc(deps.publicUrl)}/cal/${esc(viewer.icsToken)}.ics">${icon("calendar")}<div class="grow"><div class="tt">${s.calendar}</div><div class="m">.ics · iPhone / Google</div></div>${icon("chevron", 18, "ic go")}</a></div>`;

    html(res, 200, page(s.myCruise, `<section class="hero"><div class="moon"></div>${hero}</section>${quick}${nextBlock}${plan}${tiles}<div style="height:12px"></div>${settings}`, opts("")));
    return true;
  }

  if (sub === "/program") {
    const days = cruiseDays();
    const today = shipDate(now);
    const date = url.searchParams.get("date") ?? (days.includes(today) ? today : days[0]);
    const { from, to } = dayBounds(date);
    const acts = await deps.store.listActivities({ from, to });
    const chips = `<div class="days">${days
      .map((d) => {
        const sd = shortDay(d, lang);
        return `<a class="${d === date ? "on" : ""}" href="/c/${esc(token)}/program?date=${d}"><small>${esc(sd.wd)}</small><b>${esc(sd.day)}</b><small>${esc(sd.mon)}</small></a>`;
      })
      .join("")}</div>`;
    const headline = headlineFor(date);
    const head = `<div class="dayhead"><h1>${esc(prettyDate(date, lang))}</h1>${headline ? `<div class="m">✨ ${esc(headline)}</div>` : ""}</div>`;
    const timeline = acts.length
      ? `<div class="tl">${(
          await Promise.all(
            acts.map(async (a) => {
              const [t, ampm] = prettyTime(a.startsAt, lang).split(" ");
              return `<div class="row"><div class="time">${esc(t)}<small>${esc(ampm ?? "")}</small></div>${await activityFeature(deps, a, viewer, token, s, { coverHeight: 140 })}</div>`;
            }),
          )
        ).join("")}</div>`
      : `<div class="card empty"><div class="e">🛟</div>${s.noneDay}<div class="actions" style="justify-content:center"><a class="btn" href="/c/${esc(token)}/new">${s.sponsor}</a></div></div>`;
    html(res, 200, page(s.program, `${chips}${head}${timeline}`, opts("/program")));
    return true;
  }

  const one = sub.match(/^\/a\/([A-Za-z0-9-]+)$/);
  if (one) {
    const a = await deps.store.getActivity(one[1]);
    if (!a) {
      notFound();
      return true;
    }
    const host = await deps.store.getPerson(a.sponsorId);
    const { going, maybe } = await counts(deps.store, a);
    const people = async (list: { personId: string }[]) =>
      (await Promise.all(list.map(async (x) => (await deps.store.getPerson(x.personId)) ?? { id: x.personId, name: x.personId })));
    const faces = async (list: { personId: string }[]) => {
      const ps = await people(list);
      return ps.length ? `<div class="faces">${ps.map((p) => `<span class="face">${avatar(p, 28)}${esc(p.name)}</span>`).join("")}</div>` : `<div class="m">${s.nobody}</div>`;
    };
    const mine = [...going, ...maybe].find((x) => x.personId === viewer.id)?.status;
    const canManage = a.sponsorId === viewer.id || (!!host?.guardianId && host.guardianId === viewer.id);
    const live = a.status !== "cancelled";
    const btn = (status: string, label: string, cls: string) =>
      `<form method="post" action="/c/${esc(token)}/a/${esc(a.id)}/signup"><input type="hidden" name="status" value="${status}"><button class="${cls}">${label}</button></form>`;
    const vibes = ["fiesta", "zen", "retro-cruise", "kids", "gala"];
    const date = shipDate(a.startsAt);
    const pct = a.capacity ? Math.min(100, Math.round((going.length / a.capacity) * 100)) : 0;
    const body = `<section class="ahero">${cover(a)}<a class="backbtn" href="/c/${esc(token)}/program?date=${date}" aria-label="${s.back}">${icon("back", 22)}</a>
</section>
<div class="atitle">${await badgesFor(deps, a, viewer, s)}<h1>${esc(a.emoji)} ${esc(a.title)}</h1></div>
<div class="info">
<div><b>${icon("clock", 14)} ${s.when}</b><span class="cap">${esc(prettyDate(date, lang))}</span><br>${esc(prettyTime(a.startsAt, lang))}–${esc(prettyTime(a.endsAt, lang))}</div>
<div><b>${icon("pin", 14)} ${s.place}</b>${esc(a.location)}</div>
<div><b>${icon("star", 14)} ${s.host}</b>${esc(host?.name ?? a.sponsorId)}</div>
<div><b>${icon("users", 14)} ${s.capacity}</b>${going.length}${a.capacity ? ` / ${a.capacity} ${s.spots}` : ` ${s.going.toLowerCase()}`}${a.capacity ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}</div>
</div>
${a.description || a.bring || a.cancelledReason ? `<div class="card pad"><div class="t" style="font-size:16px">${s.details}</div>${a.description ? `<p style="margin:8px 0 0">${esc(a.description)}</p>` : ""}${a.bring ? `<p class="m" style="margin:8px 0 0">${icon("bag", 16)} ${s.bring}: ${esc(a.bring)}</p>` : ""}${a.cancelledReason ? `<p class="m">${esc(a.cancelledReason)}</p>` : ""}</div>` : ""}
<div class="card pad"><div class="t" style="font-size:16px">${s.whoGoing} · ${going.length}</div>${await faces(going)}${maybe.length ? `<div class="m" style="margin-top:12px">${s.maybe}</div>${await faces(maybe)}` : ""}</div>
${hasFlyer(a) ? `<div class="card"><img class="flyerimg" src="${esc(a.flyerUrl)}" alt="${s.flyer}"></div>` : ""}
${live ? `<form class="card pad" method="post" action="/c/${esc(token)}/a/${esc(a.id)}/flyer" onsubmit="this.querySelector('button').textContent='${s.working}'"><div class="t" style="font-size:16px">${s.flyer}</div>
<div class="actions"><select name="vibe" style="flex:1">${vibes.map((v) => `<option>${v}</option>`).join("")}</select><button class="alt">${s.makeFlyer}</button></div></form>` : ""}
${canManage && live ? `<form class="card pad" method="post" action="/c/${esc(token)}/a/${esc(a.id)}/cancel"><div class="t" style="font-size:16px">${s.hostTools}</div><label>${s.reason}</label><input name="reason" required maxlength="200"><div class="actions"><button class="danger">${s.cancel}</button></div></form>` : ""}
<div style="height:72px"></div>`;
    const cta = live
      ? `<div class="cta"><div class="in">${btn("going", mine === "going" ? `✓ ${s.youreIn}` : s.imIn, mine === "going" ? "alt" : "")}${btn("maybe", s.maybeBtn, mine === "maybe" ? "" : "ghost")}${mine ? btn("out", s.out, "ghost") : ""}</div></div>`
      : "";
    html(res, 200, page(a.title, body, { ...opts(undefined), bare: true, cta }));
    return true;
  }

  if (sub === "/new") {
    const days = cruiseDays();
    const today = shipDate(now);
    const vibes = ["fiesta", "zen", "retro-cruise", "kids", "gala"];
    const body = `<section class="hero" style="padding-bottom:30px"><div class="moon"></div><div class="eyebrow">${s.sponsor}</div><h1>${s.title}</h1><div class="sub">${s.newSub}</div></section>
<form method="post" action="/c/${esc(token)}/new" onsubmit="this.querySelector('button').textContent='${s.working}'">
<div class="card pad"><div class="grid2" style="grid-template-columns:3fr 1fr"><div><label>${s.title}</label><input name="title" required minlength="3" maxlength="80" placeholder="Torneo de dominó"></div><div><label>${s.emoji}</label><input name="emoji" value="🎉" maxlength="4"></div></div>
<label>${s.place}</label><input name="location" required maxlength="80" placeholder="Lido Deck (balcón)">
<label>${s.description}</label><textarea name="description" maxlength="400" rows="3"></textarea></div>
<div class="card pad"><div class="t" style="font-size:16px">${s.when}</div>
<label>${s.date}</label><select name="date">${days.map((d) => `<option value="${d}"${d === today ? " selected" : ""}>${esc(prettyDate(d, lang))}</option>`).join("")}</select>
<div class="grid2"><div><label>${s.start}</label><input type="time" name="start" required></div><div><label>${s.end}</label><input type="time" name="end" required></div></div></div>
<div class="card pad"><div class="t" style="font-size:16px">${s.extra}</div>
<div class="grid2"><div><label>${s.capacity}</label><input type="number" name="capacity" min="1" placeholder="∞"></div><div><label>${s.bring}</label><input name="bring" maxlength="120"></div></div>
<label>${s.flyer}</label><select name="vibe"><option value="none">${s.noFlyer}</option>${vibes.map((v) => `<option value="${v}">${s.flyerToo}: ${v}</option>`).join("")}</select></div>
<button style="width:100%;margin-top:4px">${s.create}</button></form>`;
    html(res, 200, page(s.sponsor, body, opts("/new")));
    return true;
  }

  if (sub === "/admin" && admin) {
    const paused = await isPaused(deps.store);
    const everyone = await deps.store.listPeople();
    const acts = await deps.store.listActivities();
    const signupCount = (await Promise.all(acts.map((a) => deps.store.listSignups(a.id)))).flat().filter((x) => x.status !== "out").length;
    const adults = everyone.filter((p) => p.role === "adult");
    const names = new Map(everyone.map((p) => [p.id, p.name]));
    const status = `<div class="card pad"><div class="status"><span class="dot${paused ? " off" : ""}"></span><div style="flex:1"><div class="t">${paused ? s.paused : s.running}</div><div class="m">${paused ? s.pausedSub : s.runningSub}</div></div></div>
<form method="post" action="/c/${esc(token)}/admin/pause" class="actions"><input type="hidden" name="paused" value="${paused ? "off" : "on"}"><button class="${paused ? "" : "danger"}" style="flex:1">${paused ? s.resume : s.pause}</button></form></div>`;
    const stats = `<div class="stats"><div><b>${everyone.length}</b><span class="m">${s.passengers}</span></div><div><b>${acts.length}</b><span class="m">${s.activities}</span></div><div><b>${signupCount}</b><span class="m">${s.signups}</span></div></div>`;
    const tv = `<div class="card list"><a class="item" href="/tv/${esc(tvKey(deps.secret))}" target="_blank" rel="noopener">${icon("tv")}<div class="grow"><div class="tt">${s.tv}</div><div class="m">${s.tvSub}</div></div>${icon("chevron", 18, "ic go")}</a></div>`;
    const rows = everyone
      .map((p) => {
        const channel = p.phoneE164?.startsWith("tg:") ? "Telegram" : p.phoneE164 ? `WhatsApp ${p.phoneE164}` : s.noChat;
        const hosts = acts.filter((a) => a.sponsorId === p.id).length;
        const badges = [
          p.admin ? `<span class="badge gold">ADMIN</span>` : "",
          p.role === "kid" ? `<span class="badge">${s.kid}${p.guardianId ? ` · ${esc(names.get(p.guardianId) ?? "")}` : ""}</span>` : "",
          p.muted ? `<span class="badge warn">${s.muted}</span>` : "",
        ].join(" ");
        const pid = esc(p.id);
        return `<details class="card"><summary>${avatar(p, 40)}<div style="flex:1;min-width:0"><div>${esc(p.name)} ${badges}</div><div class="m" style="font-weight:500">${esc(channel)} · ${s.joined} ${esc(p.joinedAt.slice(0, 10))}${hosts ? ` · ${s.hostsN} ${hosts}` : ""}</div></div>${icon("chevron", 18, "ic go")}</summary><div class="pad">
<form method="post" action="/c/${esc(token)}/admin/role"><input type="hidden" name="person" value="${pid}">
<div class="grid2"><div><label>${s.role}</label><select name="role"><option value="adult"${p.role === "adult" ? " selected" : ""}>${s.adult}</option><option value="kid"${p.role === "kid" ? " selected" : ""}>${s.kid}</option></select></div>
<div><label>${s.guardian}</label><select name="guardian"><option value="">—</option>${adults.filter((g) => g.id !== p.id).map((g) => `<option value="${esc(g.id)}"${p.guardianId === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></div></div>
<div class="actions"><button class="small alt">${s.saveRole}</button></div></form>
<div class="actions">${p.id === viewer.id ? "" : `<form method="post" action="/c/${esc(token)}/admin/admin"><input type="hidden" name="person" value="${pid}"><input type="hidden" name="admin" value="${p.admin ? "off" : "on"}"><button class="small ghost">${p.admin ? s.removeAdmin : s.makeAdmin}</button></form>
<form method="post" action="/c/${esc(token)}/admin/remove" onsubmit="return confirm('${esc(s.confirmRemove)}')"><input type="hidden" name="person" value="${pid}"><button class="small danger">${s.remove}</button></form>`}</div></div></details>`;
      })
      .join("");
    const body = `<section class="hero"><div class="moon"></div><div class="eyebrow">${s.admin}</div><h1>${s.adminTitle}</h1><div class="sub">${esc(viewer.name)}</div></section>
${status}${stats}${tv}<h2 class="sec">${s.passengers}</h2>${rows}`;
    html(res, 200, page(s.admin, body, opts("/admin")));
    return true;
  }

  notFound();
  return true;
}
