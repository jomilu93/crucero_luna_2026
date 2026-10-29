/**
 * The public front door of the ship: the website is where every passenger starts.
 *
 *   GET  /            → home page: what the Moonshine of the Seas is, how it works, the crew, "join the cruise".
 *                       A browser that already belongs to a passenger (cabin cookie) goes straight to its cabin.
 *   POST /join        → name + phone + code. The family's BOARDING_CODE boards a passenger; ADMIN_PASSWORD boards an
 *                       admin. A number already on the manifest signs that passenger in again (new phone, same cabin).
 *   GET  /a/<id>      → what flyer and TV QR codes open: the activity in your cabin, or "join" first.
 *   POST /logout      → forget this browser's cabin.
 *
 * From the cabin, passengers do everything on the web, or connect Telegram (WhatsApp later) or call the Bridge.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { CAPTAIN_NAME, MASCOT_NAME, SHIP_FORMER_NAME, SHIP_NAME, VOYAGE_NAME } from "@crucero/agent";
import { type Person, CRUISE_END, CRUISE_START, normalizePhone } from "@crucero/db";
import { CSS, type WebDeps, cabinToken, esc, html, icon, personFromToken, readForm, redirect, sessionCookie, sessionToken } from "./web.js";

type Lang = "es" | "en";

const T = {
  es: {
    title: "Bienvenido a bordo",
    eyebrow: `${VOYAGE_NAME} · Acapulco`,
    formerly: "anteriormente",
    dates: "26 de diciembre de 2026 – 2 de enero de 2027",
    days: "días para zarpar",
    day: "día para zarpar",
    sailing: "¡Estamos navegando!",
    join: "Únete al crucero",
    signIn: "Ya estoy a bordo",
    pitch:
      "Una semana en el depa de Acapulco convertida en crucero. Cada quien organiza actividades, se apunta a las de los demás y el Capitán lleva el programa: tu día cada mañana, recordatorios y flyers.",
    whatTitle: "¿Qué pasa a bordo?",
    what: [
      ["calendar", "El programa", "Día por día, del 26 al 2: qué hay, dónde, quién organiza y cuántos van."],
      ["plus", "Organiza algo", "Torneo de dominó, yoga al amanecer, karaoke… Publícalo y el Capitán lo anuncia."],
      ["users", "Apúntate", "Un toque y vas. El Capitán te recuerda antes de que empiece."],
      ["chat", `El ${CAPTAIN_NAME}`, "Tu director de crucero: pregúntale lo que sea por chat. Hoy en Telegram, pronto en WhatsApp."],
      ["video", "Llama al Puente", "Videollamada en vivo con el Capitán, desde tu teléfono o en la tele del depa."],
      ["tv", "Modo TV", "La tele del depa muestra lo que pasa ahora, lo que sigue y los flyers."],
    ],
    howTitle: "Cómo funciona",
    how: [
      ["Únete", "Tu nombre, tu número y el código del barco que está en el grupo de la familia."],
      ["Arma tu agenda", "Aquí mismo en la web: ve el programa, apúntate y organiza."],
      ["Habla con el Capitán", "Como prefieras: aquí, por chat en Telegram (pronto WhatsApp) o en videollamada."],
    ],
    crewTitle: "La tripulación",
    captain: `${CAPTAIN_NAME}`,
    captainSub: "Capitán griego, director del crucero y contador de anécdotas no del todo verificadas.",
    mascot: `La Primera Oficial ${MASCOT_NAME}`,
    mascotSub: "La celosía amarilla que te recibía en la entrada. Secretaria del Capitán, lleva el manifiesto y no se le escapa nada.",
    aboard: "a bordo",
    activities: "actividades",
    formTitle: "Únete al crucero",
    formSub: "Si ya te uniste, usa el mismo número y entras a tu camarote.",
    name: "Tu nombre",
    namePh: "Como te dice la familia",
    phone: "Tu número",
    phoneHelp: "Para encontrarte y, cuando quieras, mandarte tu programa. No se comparte.",
    code: "Código del barco",
    codeHelp: "Está en el grupo de la familia.",
    board: "Abordar",
    other: "Otro (+…)",
    errName: "Escribe tu nombre.",
    errPhone: "Ese número no parece válido. Incluye la lada, por ejemplo 55 1234 5678.",
    errCode: "Ese código no es. Revisa el grupo de la familia.",
    errSlow: "Demasiados intentos. Espera unos minutos.",
    invited: "Te invitaron a",
    privacy: "Aviso de privacidad",
    langSwitch: "English",
  },
  en: {
    title: "Welcome aboard",
    eyebrow: `${VOYAGE_NAME} · Acapulco`,
    formerly: "formerly",
    dates: "December 26, 2026 – January 2, 2027",
    days: "days to sail",
    day: "day to sail",
    sailing: "We're sailing!",
    join: "Join the cruise",
    signIn: "I'm already aboard",
    pitch:
      "A week at the Acapulco apartment turned into a cruise. Everyone hosts activities, signs up for each other's, and the Capitán runs the program: your day every morning, reminders and flyers.",
    whatTitle: "What happens on board?",
    what: [
      ["calendar", "The program", "Day by day, the 26th to the 2nd: what's on, where, who hosts and how many are going."],
      ["plus", "Host something", "Domino tournament, sunrise yoga, karaoke… Publish it and the Capitán announces it."],
      ["users", "Sign up", "One tap and you're in. The Capitán reminds you before it starts."],
      ["chat", CAPTAIN_NAME, "Your cruise director: ask him anything by chat. Telegram today, WhatsApp soon."],
      ["video", "Call the Bridge", "Live video call with the Capitán, from your phone or on the apartment TV."],
      ["tv", "TV mode", "The apartment TV shows what's on now, what's next and the flyers."],
    ],
    howTitle: "How it works",
    how: [
      ["Join", "Your name, your number and the ship's code from the family group."],
      ["Build your plan", "Right here on the web: see the program, sign up and host."],
      ["Talk to the Capitán", "However you like: here, by chat on Telegram (WhatsApp soon) or on a video call."],
    ],
    crewTitle: "The crew",
    captain: CAPTAIN_NAME,
    captainSub: "Greek captain, cruise director and teller of not entirely verified tales.",
    mascot: `First Officer ${MASCOT_NAME}`,
    mascotSub: "The yellow screen that used to greet you at the door. The Capitán's secretary: she keeps the manifest and misses nothing.",
    aboard: "aboard",
    activities: "activities",
    formTitle: "Join the cruise",
    formSub: "Already joined? Use the same number and you're back in your cabin.",
    name: "Your name",
    namePh: "What the family calls you",
    phone: "Your number",
    phoneHelp: "To find you and, when you want, send you your program. Never shared.",
    code: "Ship's code",
    codeHelp: "It's in the family group.",
    board: "Board",
    other: "Other (+…)",
    errName: "Please write your name.",
    errPhone: "That number doesn't look valid. Include the area code.",
    errCode: "That's not the code. Check the family group.",
    errSlow: "Too many tries. Wait a few minutes.",
    invited: "You're invited to",
    privacy: "Privacy notice",
    langSwitch: "Español",
  },
} as const;

const HOME_CSS = `
body{padding-bottom:0}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
.nav{position:sticky;top:0;z-index:5;background:rgba(11,31,63,.96);backdrop-filter:blur(10px);color:#fff}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;padding-bottom:12px}
.nav a{color:#fff;text-decoration:none}.nav .links{display:flex;gap:8px;align-items:center}
.nav .links .btn{padding:9px 14px;font-size:14px;white-space:nowrap}
@media (max-width:520px){.nav .links .btn{display:none}.nav .logo{font-size:14px}}
.sea{position:relative;overflow:hidden;color:#fff;background:linear-gradient(165deg,#0b2a5b 0%,#0a4d8c 50%,#16a3c9 100%)}
.sea:after{content:"";position:absolute;left:0;right:0;bottom:0;height:70px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 46' preserveAspectRatio='none'%3E%3Cpath d='M0 22c50-18 100-18 150 0s100 18 150 0 70-14 100-6v30H0z' fill='%23ffffff' fill-opacity='.12'/%3E%3Cpath d='M0 32c60-14 110-12 170 2s120 12 170-2 45-8 60-4v18H0z' fill='%23ffffff' fill-opacity='.16'/%3E%3C/svg%3E") center/100% 100% no-repeat}
.sea .wrap{position:relative;z-index:1;display:grid;gap:24px;padding-top:36px;padding-bottom:88px;align-items:center}
.sea .moon{position:absolute;right:8%;top:28px;width:84px;height:84px;border-radius:50%;background:radial-gradient(circle at 38% 38%,#fffaf0,#ffe7a3 55%,#f2b632);box-shadow:0 0 0 14px rgba(255,231,163,.10),0 0 0 30px rgba(255,231,163,.05),0 0 60px rgba(242,182,50,.55)}
.sea .eyebrow{font-size:13px;letter-spacing:.14em;text-transform:uppercase;opacity:.85;font-weight:700}
.sea h1{font-size:clamp(34px,7vw,64px);line-height:1.03;margin:10px 0 6px;letter-spacing:-.01em}
.sea .formerly{font-style:italic;opacity:.75}
.sea .lede{font-size:clamp(16px,2.2vw,19px);opacity:.92;max-width:560px;margin:16px 0 0}
.sea .when{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.sea .when span{background:rgba(255,255,255,.14);border-radius:999px;padding:7px 14px;font-weight:600;font-size:14px}
.sea .ctas{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.sea .ctas .btn{padding:15px 22px;font-size:17px}
.sea .ctas .btn.ghost{background:rgba(255,255,255,.14);color:#fff}
.sea .art{display:flex;justify-content:center;align-items:flex-end;gap:12px}
.sea .art img.mp{width:min(42vw,200px);filter:drop-shadow(0 10px 18px rgba(0,0,0,.35))}
.sea .art img.cap,.sea .art .cap{width:min(34vw,170px);aspect-ratio:1;border-radius:50%;object-fit:cover;border:5px solid var(--gold);box-shadow:0 10px 30px rgba(0,0,0,.35);background:#0f2d5c;display:grid;place-items:center;font-size:72px}
.count{font-size:clamp(40px,8vw,64px);font-weight:800;line-height:1}.count small{display:block;font-size:15px;font-weight:600;opacity:.85}
.stats2{display:flex;gap:22px;margin-top:20px}.stats2 b{font-size:26px;display:block;line-height:1}.stats2 span{font-size:13px;opacity:.85}
section.blk{padding:36px 0 8px}section.blk h2{font-size:clamp(24px,3.6vw,34px);margin:0 0 6px}section.blk .lead{color:var(--muted);margin:0 0 18px;max-width:640px}
.feats{display:grid;gap:12px;grid-template-columns:1fr}
.feat{background:var(--card);border-radius:20px;box-shadow:var(--shadow);padding:18px}.feat .ic{color:var(--blue)}.feat b{display:block;font-size:17px;margin:10px 0 4px}.feat p{margin:0;color:var(--muted);font-size:15px}
.steps{display:grid;gap:12px;grid-template-columns:1fr;counter-reset:s}
.step{position:relative;background:var(--card);border-radius:20px;box-shadow:var(--shadow);padding:18px 18px 18px 66px}
.step:before{counter-increment:s;content:counter(s);position:absolute;left:18px;top:18px;width:34px;height:34px;border-radius:50%;background:var(--blue);color:#fff;font-weight:800;display:grid;place-items:center}
.step b{display:block;font-size:17px}.step p{margin:4px 0 0;color:var(--muted)}
.crew{display:grid;gap:12px;grid-template-columns:1fr}
.mate{display:flex;gap:16px;align-items:center;background:var(--card);border-radius:20px;box-shadow:var(--shadow);padding:16px}
.mate img,.mate .ph{width:84px;height:84px;flex:none;border-radius:50%;object-fit:cover;background:var(--sky);display:grid;place-items:center;font-size:40px}.mate img.mpimg{border-radius:0;object-fit:contain;background:none}
.mate b{display:block;font-size:17px}.mate p{margin:4px 0 0;color:var(--muted);font-size:15px}
.joinbox{background:var(--card);border-radius:24px;box-shadow:var(--shadow);padding:22px;max-width:560px;margin:0 auto}
.joinbox h2{margin:0}.joinbox .m{margin-top:4px}
.phone{display:grid;grid-template-columns:150px 1fr;gap:8px}
.err{background:#fdecdf;color:var(--warn);border-radius:12px;padding:10px 12px;font-weight:600;margin-top:12px}
@media (prefers-color-scheme:dark){.err{background:#3a1d0e}}
.invite{display:flex;gap:12px;align-items:center;background:var(--sky);border-radius:16px;padding:12px;margin-top:14px;font-weight:600}
.foot{text-align:center;color:var(--muted);font-size:14px;padding:30px 16px 40px}
@media (min-width:760px){
  .sea .wrap{grid-template-columns:1.25fr .75fr;padding-top:56px;padding-bottom:110px}
  .feats{grid-template-columns:repeat(3,1fr)}.steps{grid-template-columns:repeat(3,1fr)}.crew{grid-template-columns:1fr 1fr}
  .sea .art{justify-content:flex-end}
}
@media (max-width:520px){.sea .moon{width:44px;height:44px;top:12px;right:14px;box-shadow:0 0 0 8px rgba(255,231,163,.10),0 0 30px rgba(242,182,50,.5)}}
`;

export interface HomeDeps extends WebDeps {
  privacyUrl?: string;
}

const norm = (s: string) =>
  createHash("sha256")
    .update(s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, "").toLowerCase())
    .digest();
/** Codes ignore case, accents and spaces: "luna 2026" is "Luna2026", "capitán" is "Capitan". */
const sameCode = (typed: string, code: string | undefined) => !!code?.trim() && timingSafeEqual(norm(typed), norm(code));

/** Wrong codes per client address, so the boarding code can't be guessed by brute force. */
const tries = new Map<string, { n: number; until: number }>();
const MAX_TRIES = 8;
const clientOf = (req: IncomingMessage) =>
  String(req.headers["fly-client-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();

/**
 * The ship speaks Mexican Spanish: Spanish unless the visitor picked English with the switch (top right), which
 * is remembered in a cookie. The browser's own language is deliberately ignored.
 */
const LANG_COOKIE = "cl_lang";
const langOf = (req: IncomingMessage, url: URL, res: ServerResponse): Lang => {
  const q = url.searchParams.get("lang");
  if (q === "en" || q === "es") {
    res.setHeader("Set-Cookie", `${LANG_COOKIE}=${q}; Path=/; Max-Age=${365 * 86400}; SameSite=Lax`);
    return q;
  }
  return (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=en(?:;|$)`)) ? "en" : "es";
};

const nextOf = (raw: string | null | undefined): string => (raw && /^a\/[A-Za-z0-9-]+$/.test(raw) ? `/${raw}` : "");

interface FormState {
  name?: string;
  phone?: string;
  country?: string;
  error?: string;
  next?: string;
}

/** With WhatsApp on, the page says so instead of "WhatsApp soon". */
const WITH_WHATSAPP: [string, string][] = [
  ["Hoy en Telegram, pronto en WhatsApp.", "Por WhatsApp (o Telegram)."],
  ["por chat en Telegram (pronto WhatsApp)", "por WhatsApp (o Telegram)"],
  ["Telegram today, WhatsApp soon.", "On WhatsApp (or Telegram)."],
  ["by chat on Telegram (WhatsApp soon)", "by chat on WhatsApp (or Telegram)"],
];

async function homePage(deps: HomeDeps, lang: Lang, form: FormState): Promise<string> {
  const fix = (t: string) => (deps.whatsappNumber ? WITH_WHATSAPP.reduce((x, [a, b]) => x.replace(a, b), t) : t);
  const s = { ...T[lang], what: T[lang].what.map(([i, t, d]) => [i, t, fix(d)] as const), how: T[lang].how.map(([t, d]) => [t, fix(d)] as const) };
  const now = deps.now?.() ?? new Date();
  const sailMs = Date.parse(`${CRUISE_START}T00:00:00-06:00`) - now.getTime();
  const days = Math.ceil(sailMs / 86_400_000);
  const ended = now.getTime() > Date.parse(`${CRUISE_END}T23:59:59-06:00`);
  const people = (await deps.store.listPeople()).filter((p) => p.phoneE164 !== "tv:bridge");
  const acts = (await deps.store.listActivities()).filter((a) => a.status !== "cancelled");
  const voice = deps.voice ? await deps.voice.status() : undefined;
  const portrait = voice?.portraitUrl;
  const next = form.next ?? "";
  const invitedTo = next.startsWith("/a/") ? await deps.store.getActivity(next.slice(3)) : undefined;
  const other = lang === "es" ? "en" : "es";

  const count = sailMs > 0 ? `<div class="count">${days}<small>${days === 1 ? s.day : s.days}</small></div>` : ended ? "" : `<div class="count" style="font-size:28px">${s.sailing}</div>`;
  const hero = `<section class="sea"><div class="moon"></div><div class="wrap"><div>
<div class="eyebrow">${esc(s.eyebrow)}</div>
<h1>${esc(SHIP_NAME)}</h1><div class="formerly">${s.formerly} ${esc(SHIP_FORMER_NAME)}</div>
<p class="lede">${esc(s.pitch)}</p>
<div class="when"><span>📅 ${esc(s.dates)}</span><span>📍 Acapulco</span></div>
<div class="ctas"><a class="btn" href="#join">${esc(s.join)} →</a><a class="btn ghost" href="#join">${esc(s.signIn)}</a></div>
<div class="stats2">${count ? `<div>${count}</div>` : ""}<div><b>${people.length}</b><span>${s.aboard}</span></div><div><b>${acts.length}</b><span>${s.activities}</span></div></div>
</div><div class="art">${portrait ? `<img class="cap" src="${esc(portrait)}" alt="${esc(CAPTAIN_NAME)}">` : `<span class="cap">🧑‍✈️</span>`}<img class="mp" src="/manpaty.svg?pose=wave" alt="${esc(MASCOT_NAME)}"></div></div></section>`;

  const feats = `<section class="blk"><div class="wrap"><h2>${s.whatTitle}</h2><div class="feats">${s.what
    .map(([ic, t, d]) => `<div class="feat">${icon(ic, 28)}<b>${esc(t)}</b><p>${esc(d)}</p></div>`)
    .join("")}</div></div></section>`;
  const steps = `<section class="blk"><div class="wrap"><h2>${s.howTitle}</h2><div class="steps">${s.how
    .map(([t, d]) => `<div class="step"><b>${esc(t)}</b><p>${esc(d)}</p></div>`)
    .join("")}</div></div></section>`;
  const crew = `<section class="blk"><div class="wrap"><h2>${s.crewTitle}</h2><div class="crew">
<div class="mate">${portrait ? `<img src="${esc(portrait)}" alt="">` : `<span class="ph">🧑‍✈️</span>`}<div><b>${esc(s.captain)}</b><p>${esc(s.captainSub)}</p></div></div>
<div class="mate"><img class="mpimg" src="/manpaty.svg?pose=cheer" alt=""><div><b>${esc(s.mascot)}</b><p>${esc(s.mascotSub)}</p></div></div></div></div></section>`;

  const country = form.country ?? "52";
  const join = `<section class="blk" id="join"><div class="wrap"><form class="joinbox" method="post" action="/join">
<h2>${s.formTitle}</h2><div class="m">${s.formSub}</div>
${invitedTo ? `<div class="invite"><span style="font-size:28px">${esc(invitedTo.emoji)}</span><span>${s.invited}: ${esc(invitedTo.title)}</span></div>` : ""}
${form.error ? `<div class="err" role="alert">${esc(form.error)}</div>` : ""}
<input type="hidden" name="lang" value="${lang}"><input type="hidden" name="next" value="${esc(next.slice(1))}">
<label for="name">${s.name}</label><input id="name" name="name" required maxlength="60" autocomplete="name" placeholder="${esc(s.namePh)}" value="${esc(form.name ?? "")}">
<label for="phone">${s.phone}</label><div class="phone"><select name="country" aria-label="País"><option value="52"${country === "52" ? " selected" : ""}>🇲🇽 +52</option><option value="1"${country === "1" ? " selected" : ""}>🇺🇸 +1</option><option value="+"${country === "+" ? " selected" : ""}>${s.other}</option></select>
<input id="phone" name="phone" type="tel" required inputmode="tel" autocomplete="tel-national" placeholder="55 1234 5678" value="${esc(form.phone ?? "")}"></div>
<div class="m" style="margin-top:6px">${s.phoneHelp}</div>
<label for="code">${s.code}</label><input id="code" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="••••••">
<div class="m" style="margin-top:6px">${s.codeHelp}</div>
<button style="width:100%;margin-top:18px;padding:15px">${s.board} 🚢</button></form></div></section>`;

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1f3f"><title>${esc(SHIP_NAME)} · ${esc(VOYAGE_NAME)}</title>
<meta name="description" content="${esc(s.pitch)}"><meta property="og:title" content="${esc(SHIP_NAME)} · ${esc(VOYAGE_NAME)}"><meta property="og:description" content="${esc(s.pitch)}"><meta property="og:image" content="${esc(deps.publicUrl)}/manpaty.png?pose=cheer">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}${HOME_CSS}</style></head><body>
<header class="nav"><div class="wrap"><a class="logo" href="/"><span class="moon"></span><span>${esc(SHIP_NAME.toUpperCase())}<small>${esc(VOYAGE_NAME)} · Acapulco</small></span></a>
<div class="links"><a class="pill" href="/?home&lang=${other}${next ? `&next=${esc(next.slice(1))}` : ""}" hreflang="${other}">🌐 ${s.langSwitch}</a><a class="btn" href="#join">${s.join}</a></div></div></header>
${hero}${invitedTo || form.error ? join : ""}${feats}${steps}${crew}${invitedTo || form.error ? "" : join}
<div class="foot">${esc(SHIP_NAME)} · ${esc(VOYAGE_NAME)} · <a href="${esc(deps.privacyUrl ?? "/privacy")}">${s.privacy}</a></div>
${form.error || invitedTo ? `<script>document.getElementById("join").scrollIntoView()</script>` : ""}</body></html>`;
}

/** The passenger this browser already belongs to, if its cabin cookie is still valid. */
async function sessionPerson(deps: HomeDeps, req: IncomingMessage): Promise<{ person: Person; token: string } | undefined> {
  const token = sessionToken(req);
  const person = token ? await personFromToken(deps, token) : undefined;
  return person && token ? { person, token } : undefined;
}

/** Returns true when it handled the request. */
export async function handleHome(deps: HomeDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const lang = langOf(req, url, res);
  if (req.method === "GET" && url.pathname === "/") {
    const me = await sessionPerson(deps, req);
    const next = nextOf(url.searchParams.get("next"));
    if (me && !url.searchParams.has("home")) {
      redirect(res, `/c/${me.token}${next}`);
      return true;
    }
    html(res, 200, await homePage(deps, lang, { next }));
    return true;
  }

  const qr = url.pathname.match(/^\/a\/([A-Za-z0-9-]+)$/);
  if (req.method === "GET" && qr) {
    const me = await sessionPerson(deps, req);
    redirect(res, me ? `/c/${me.token}/a/${qr[1]}` : `/?next=a/${qr[1]}${url.searchParams.get("lang") ? `&lang=${lang}` : ""}`);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/logout") {
    res.setHeader("Set-Cookie", sessionCookie(undefined, deps.publicUrl));
    redirect(res, "/?home");
    return true;
  }

  if (req.method === "POST" && url.pathname === "/join") {
    const f = await readForm(req);
    const formLang: Lang = f.get("lang") === "en" ? "en" : "es";
    const s = T[formLang];
    const form: FormState = {
      name: (f.get("name") ?? "").trim().slice(0, 60),
      phone: (f.get("phone") ?? "").trim().slice(0, 30),
      country: f.get("country") ?? "52",
      next: nextOf(f.get("next")),
    };
    const fail = async (error: string, status = 400) => html(res, status, await homePage(deps, formLang, { ...form, error }));

    const who = clientOf(req);
    const t = tries.get(who);
    if (t && t.n >= MAX_TRIES && Date.now() < t.until) return (await fail(s.errSlow, 429), true);
    if (!form.name) return (await fail(s.errName), true);
    const typed = form.country === "+" || form.phone!.startsWith("+") ? (form.phone!.startsWith("+") ? form.phone! : `+${form.phone}`) : form.phone!;
    const phone = normalizePhone(typed, form.country === "1" ? "1" : "52");
    if (!phone) return (await fail(s.errPhone), true);

    const code = f.get("code") ?? "";
    const asAdmin = sameCode(code, deps.adminPassword);
    const boarding = asAdmin || !deps.boardingCode?.trim() || sameCode(code, deps.boardingCode);
    if (!boarding) {
      tries.set(who, { n: (t && Date.now() < t.until ? t.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      return (await fail(s.errCode, 403), true);
    }

    const everyone = await deps.store.listPeople();
    let person =
      everyone.find((p) => p.contactPhone === phone) ?? everyone.find((p) => p.phoneE164?.startsWith("+") && normalizePhone(p.phoneE164) === phone);
    if (person) {
      if ((asAdmin && !person.admin) || !person.contactPhone) {
        person = await deps.store.updatePerson(person.id, { ...(asAdmin ? { admin: true } : {}), contactPhone: person.contactPhone ?? phone });
      }
    } else {
      person = await deps.store.createPerson({ name: form.name!, contactPhone: phone, language: formLang, role: "adult", ...(asAdmin ? { admin: true } : {}) });
    }
    const token = cabinToken(deps.secret, person);
    res.setHeader("Set-Cookie", sessionCookie(token, deps.publicUrl));
    redirect(res, `/c/${token}${form.next ?? ""}${form.next ? "" : "?welcome=1"}`);
    return true;
  }

  return false;
}
