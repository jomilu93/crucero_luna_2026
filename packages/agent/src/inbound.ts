import { createHash, timingSafeEqual } from "node:crypto";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { type Person, type Store, isPaused, normalizePhone, shipDate } from "@crucero/db";
import { MASCOT_NAME, SHIP_NAME } from "./brand.js";
import { SIGNUP_BUTTON_PREFIX, deliverMorningFull, type TemplateOutbox } from "./scheduler.js";

/** What the ChatService needs from the Capitán; `Director` satisfies this. */
export interface Responder {
  respond(
    passenger: Person,
    text: string,
    history: BetaMessageParam[],
    opts?: { channel?: "cli" | "whatsapp" | "telegram" | "web" | "voice"; onToolStart?: (name: string) => void },
  ): Promise<{ text: string; history: BetaMessageParam[] }>;
}

export interface InboundMessage {
  /** Channel address: E.164 phone for WhatsApp (e.g. +15551234567), `tg:<chat id>` for Telegram. */
  phoneE164: string;
  text: string;
  /** WhatsApp profile name, used only to seed a new passenger's name. */
  profileName?: string;
  /** Quick-reply button payload, when the message is a tap rather than typed text. */
  buttonPayload?: string;
  mediaUrl?: string;
  channel?: "whatsapp" | "telegram" | "web" | "voice";
}

export interface ChatServiceOptions {
  /** Conversations older than this restart fresh. Default 12 hours. */
  staleAfterMs?: number;
  /** Keep at most this many messages of history. Default 30. */
  maxHistory?: number;
  /** Sent to every new passenger before the Capitán's first reply: Manpaty greeting them at the gangway. */
  welcomePhotoUrl?: string;
  /** ADMIN_PASSWORD: a passenger who sends exactly this (or "/admin <password>") becomes an admin. */
  adminPassword?: string;
  /**
   * Checks a "connect your chat" code from the website (a `link:<code>` payload, e.g. Telegram's /start link_…) and
   * returns the passenger it belongs to. The chat is then attached to that passenger.
   */
  verifyChatLink?: (code: string) => string | undefined;
  now?: () => Date;
}

/** Tools that change the ship or reach people; read-only ones (program, who's going, weather…) are not listed. */
const ACTION_TOOLS = new Set([
  "create_activity",
  "update_activity",
  "cancel_activity",
  "signup",
  "generate_flyer",
  "send_message",
  "remember",
  "set_preferences",
  "mark_attendance",
  "confirm_event",
  "admin_remove_passenger",
  "admin_set_role",
  "admin_set_admin",
  "admin_pause",
]);

const didSomething = (turn: BetaMessageParam[]) =>
  turn.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && ACTION_TOOLS.has(b.name)));

const digest = (s: string) => createHash("sha256").update(s.trim().toLowerCase()).digest();

/** Case-insensitive, constant-time; "/admin <password>" works too. */
export function isAdminPassword(text: string, password: string | undefined): boolean {
  if (!password?.trim()) return false;
  const said = text.trim().replace(/^\/admin(@\w+)?\s+/i, "");
  return timingSafeEqual(digest(said), digest(password));
}

const ADMIN_WELCOME = {
  es: "🔑 Acceso de administrador concedido. Puedes pedirme: el manifiesto completo, quitar a un pasajero, marcar niños y sus tutores, o pausar el barco. Tu página (escribe *mi enlace*) ahora tiene el panel de administración. Por seguridad, borra el mensaje con la contraseña.",
  en: "🔑 Admin access granted. Ask me for: the full manifest, removing a passenger, marking kids and their guardians, or pausing the ship. Your page (write *my link*) now has the admin panel. For safety, delete the message with the password.",
} as const;

const WELCOME_PHOTO_CAPTION = `🟨 ${MASCOT_NAME}, Primera Oficial del ${SHIP_NAME}, te da la bienvenida a bordo. *clink clink*`;

const OFF_DUTY = {
  es: "🌙 El Capitán está fuera de servicio un momento: el barco está en pausa. ¡Vuelvo pronto!",
  en: "🌙 The Capitán is off duty for a moment: the ship is paused. Back soon!",
} as const;

/** A "connect this chat" payload from the website's deep link: `link:<code>`. */
export const CHAT_LINK_PREFIX = "link:";

/** Morning template buttons. The payloads are what Twilio/Meta send back when tapped. */
export const MORNING_BUTTONS = {
  show: "ver_mi_dia",
  surprise: "sorprendeme",
  skip: "hoy_no",
} as const;

export type { MorningPayloadData as MorningPayload } from "./scheduler.js";

/**
 * Trim history from the front without orphaning tool results: the first message must be a
 * plain user turn (string content, or blocks with no tool_result).
 */
export function trimHistory(history: BetaMessageParam[], max: number): BetaMessageParam[] {
  let h = history.length > max ? history.slice(history.length - max) : [...history];
  const startsClean = (m: BetaMessageParam | undefined) =>
    !!m && m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));
  while (h.length && !startsClean(h[0])) h = h.slice(1);
  return h;
}

/**
 * Glue between a channel (WhatsApp, web) and the Capitán: resolves or boards the passenger,
 * keeps per-passenger conversation history, handles template button taps, and sends the reply.
 */
export class ChatService {
  private readonly staleAfterMs: number;
  private readonly maxHistory: number;
  private readonly adminPassword?: string;
  private readonly verifyChatLink?: (code: string) => string | undefined;
  private readonly welcomePhotoUrl?: string;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly responder: Responder,
    private readonly outbox: TemplateOutbox,
    opts: ChatServiceOptions = {},
  ) {
    this.staleAfterMs = opts.staleAfterMs ?? 12 * 3600 * 1000;
    this.maxHistory = opts.maxHistory ?? 30;
    this.adminPassword = opts.adminPassword;
    this.verifyChatLink = opts.verifyChatLink;
    this.welcomePhotoUrl = opts.welcomePhotoUrl;
    this.now = opts.now ?? (() => new Date());
  }

  async resolvePassenger(msg: InboundMessage): Promise<{ person: Person; isNew: boolean }> {
    const existing = await this.store.findPersonByPhone(msg.phoneE164);
    if (existing) return { person: existing, isNew: false };
    // Joined on the website with this number and now writes on WhatsApp: the same passenger, now with a chat.
    // WhatsApp writes Mexican mobiles as +52 1 55…, the website as +52 55…: compare them normalized.
    const number = msg.phoneE164.startsWith("+") ? normalizePhone(msg.phoneE164) : undefined;
    const byNumber = number ? (await this.store.listPeople()).find((p) => p.contactPhone === number && !p.phoneE164) : undefined;
    if (byNumber) return { person: await this.store.updatePerson(byNumber.id, { phoneE164: msg.phoneE164 }), isNew: false };
    const person = await this.store.createPerson({
      name: msg.profileName?.trim() || "Pasajero sin nombre",
      phoneE164: msg.phoneE164,
      language: "es",
      role: "adult",
    });
    return { person, isNew: true };
  }

  /** If this passenger's morning knock went out today and the full show has not, send it. */
  async releasePendingMorning(person: Person): Promise<boolean> {
    const today = shipDate(this.now());
    const key = `${person.id}:${today}`;
    const knock = await this.store.getDelivery("morning", key);
    if (!knock?.payload || (await this.store.wasDelivered("morning_full", key))) return false;
    await deliverMorningFull(this.store, this.outbox, person, knock.payload as { full_message: string; offered_activity_ids: string[] });
    await this.store.markDelivered("morning_full", key);
    return true;
  }

  /**
   * Attaches this chat to the passenger who joined on the website and tapped "connect Telegram". If the chat already
   * belongs to another passenger (they wrote to the bot first), the two become one: whichever has nothing on the
   * manifest yet (no sign-ups, nothing hosted, nothing remembered) gives way, keeping its phone and admin flag.
   */
  async linkChat(address: string, personId: string): Promise<{ person: Person; linked: boolean }> {
    const target = await this.store.getPerson(personId);
    const current = await this.store.findPersonByPhone(address);
    if (!target) return { person: current ?? (await this.resolvePassenger({ phoneE164: address, text: "" })).person, linked: false };
    if (current?.id === target.id) return { person: target, linked: true };
    const fresh = async (p: Person) =>
      (await this.store.listSignupsForPerson(p.id)).every((s) => s.status === "out") &&
      !(await this.store.listActivities({ sponsorId: p.id })).length &&
      !(await this.store.getMemory(p.id)).length;
    if (!current) return { person: await this.store.updatePerson(target.id, { phoneE164: address }), linked: true };
    if (await fresh(current)) {
      await this.store.removePerson(current.id);
      return { person: await this.store.updatePerson(target.id, { phoneE164: address, admin: target.admin || current.admin || undefined }), linked: true };
    }
    if (await fresh(target)) {
      await this.store.removePerson(target.id);
      const keep = await this.store.updatePerson(current.id, {
        contactPhone: current.contactPhone ?? target.contactPhone,
        admin: current.admin || target.admin || undefined,
      });
      return { person: keep, linked: true };
    }
    return { person: current, linked: false };
  }

  /** Handle one inbound message end to end. Returns the text that was sent back (for logs/tests). */
  async handle(msg: InboundMessage): Promise<{ person: Person; reply?: string; releasedMorning: boolean }> {
    // A connect code arrives as a payload (Telegram's /start link_…) or inside the text the website prefilled for
    // WhatsApp ("Hola Capitán 👋 (código link_…)").
    const linkCode = msg.buttonPayload?.startsWith(CHAT_LINK_PREFIX)
      ? msg.buttonPayload.slice(CHAT_LINK_PREFIX.length)
      : msg.text.match(/\blink_([A-Za-z0-9_-]{20,})/)?.[1];
    const linkTo = linkCode ? this.verifyChatLink?.(linkCode) : undefined;
    if (linkTo) {
      const { person, linked } = await this.linkChat(msg.phoneE164, linkTo);
      // The Capitán says hello on the new channel himself, knowing they came from the website.
      const text = linked
        ? person.language === "en"
          ? "[The passenger just connected this chat from the website; welcome them to chatting here.] Hi Capitán"
          : "[El pasajero acaba de conectar este chat desde la página web; dale la bienvenida a platicar por aquí.] Hola Capitán"
        : person.language === "en"
          ? "[The passenger tried to connect this chat from the website, but it already belongs to a passenger with their own plans; tell them an admin can sort it out.] Hi Capitán"
          : "[El pasajero intentó conectar este chat desde la web, pero ya pertenece a un pasajero con planes propios; dile que un admin lo puede arreglar.] Hola Capitán";
      const reply = await this.converse(person, text, msg.channel === "telegram" ? "telegram" : "whatsapp");
      if (reply) await this.outbox.send(person, reply, { from: person });
      return { person, reply, releasedMorning: false };
    }
    const { person, isNew } = await this.resolvePassenger(msg);
    if (isNew && this.welcomePhotoUrl && !(await isPaused(this.store))) {
      // Like the real screen at the apartment's door, Manpaty is the first thing a new passenger sees.
      await this.outbox.send(person, WELCOME_PHOTO_CAPTION, { mediaUrl: this.welcomePhotoUrl, from: person }).catch(() => {});
    }
    const channel = msg.channel ?? "whatsapp";

    // The admin password never reaches the model or the chat history.
    if (isAdminPassword(msg.text, this.adminPassword)) {
      await this.store.logMessage({ personId: person.id, channel, direction: "in", body: "[admin password]" });
      const admin = person.admin ? person : await this.store.updatePerson(person.id, { admin: true });
      const reply = ADMIN_WELCOME[admin.language];
      await this.outbox.send(admin, reply, { from: admin });
      return { person: admin, reply, releasedMorning: false };
    }

    // Pause switch: only admins get the real Capitán.
    if (!person.admin && (await isPaused(this.store))) {
      await this.store.logMessage({ personId: person.id, channel, direction: "in", body: msg.text || `[button:${msg.buttonPayload ?? ""}]` });
      const reply = OFF_DUTY[person.language];
      await this.outbox.send(person, reply, { from: person });
      return { person, reply, releasedMorning: false };
    }

    // Template button taps are handled without the model.
    const payload = msg.buttonPayload?.toLowerCase();
    if (payload === MORNING_BUTTONS.show || payload === MORNING_BUTTONS.surprise) {
      const released = await this.releasePendingMorning(person);
      if (released) {
        await this.store.logMessage({ personId: person.id, channel, direction: "in", body: `[button:${payload}]` });
        return { person, releasedMorning: true };
      }
    }
    if (payload === MORNING_BUTTONS.skip) {
      await this.store.logMessage({ personId: person.id, channel, direction: "in", body: `[button:${payload}]` });
      const today = shipDate(this.now());
      await this.store.markDelivered("morning_full", `${person.id}:${today}`);
      return { person, releasedMorning: false };
    }

    // One-tap sign-up buttons go through the Capitán so the reply keeps his voice.
    let text = msg.text;
    if (payload?.startsWith(SIGNUP_BUTTON_PREFIX)) {
      const id = payload.slice(SIGNUP_BUTTON_PREFIX.length);
      text = person.language === "es" ? `[Botón] Apúntame a la actividad ${id}.` : `[Button] Sign me up for activity ${id}.`;
    }

    // Any real message also opens the window: release the morning show first if it is waiting.
    const releasedMorning = await this.releasePendingMorning(person);

    if (msg.mediaUrl && !text) text = "[El pasajero envió una imagen sin texto]";
    const reply = await this.converse(person, text, channel);
    if (reply) await this.outbox.send(person, reply, { from: person });
    return { person, reply, releasedMorning };
  }

  /**
   * One Capitán turn on the passenger's shared conversation, without sending anything: the chat
   * sends the reply itself, the voice call speaks it. Chat and voice share one history.
   */
  async converse(
    person: Person,
    text: string,
    channel: "whatsapp" | "telegram" | "web" | "voice",
    opts: { keep?: () => boolean; onToolStart?: (name: string) => void } = {},
  ): Promise<string> {
    if (!person.admin && (await isPaused(this.store))) return OFF_DUTY[person.language];
    const saved = await this.store.getConversation(person.id);
    const stale = !saved || this.now().getTime() - new Date(saved.updatedAt).getTime() > this.staleAfterMs;
    const history = stale ? [] : trimHistory(saved!.history as BetaMessageParam[], this.maxHistory);
    const turn = await this.responder.respond(person, text, history, { channel, onToolStart: opts.onToolStart });
    // A voice turn the caller talked over was never heard: keep it out of the shared history, unless it already
    // did something (signed someone up, sent a message…), which the Capitán must remember.
    if (opts.keep && !opts.keep() && !didSomething(turn.history.slice(history.length))) return turn.text;
    await this.store.saveConversation(person.id, trimHistory(turn.history, this.maxHistory));
    return turn.text;
  }
}
