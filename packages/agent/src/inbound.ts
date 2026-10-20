import { createHash, timingSafeEqual } from "node:crypto";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { type Person, type Store, isPaused, shipDate } from "@crucero/db";
import { SIGNUP_BUTTON_PREFIX, deliverMorningFull, type TemplateOutbox } from "./scheduler.js";

/** What the ChatService needs from the Capitán; `Director` satisfies this. */
export interface Responder {
  respond(
    passenger: Person,
    text: string,
    history: BetaMessageParam[],
    opts?: { channel?: "cli" | "whatsapp" | "telegram" | "web" | "voice" },
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
  /** ADMIN_PASSWORD: a passenger who sends exactly this (or "/admin <password>") becomes an admin. */
  adminPassword?: string;
  now?: () => Date;
}

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

const OFF_DUTY = {
  es: "🌙 El Capitán está fuera de servicio un momento: el barco está en pausa. ¡Vuelvo pronto!",
  en: "🌙 The Capitán is off duty for a moment: the ship is paused. Back soon!",
} as const;

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
    this.now = opts.now ?? (() => new Date());
  }

  async resolvePassenger(msg: InboundMessage): Promise<{ person: Person; isNew: boolean }> {
    const existing = await this.store.findPersonByPhone(msg.phoneE164);
    if (existing) return { person: existing, isNew: false };
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

  /** Handle one inbound message end to end. Returns the text that was sent back (for logs/tests). */
  async handle(msg: InboundMessage): Promise<{ person: Person; reply?: string; releasedMorning: boolean }> {
    const { person } = await this.resolvePassenger(msg);
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
  async converse(person: Person, text: string, channel: "whatsapp" | "telegram" | "web" | "voice"): Promise<string> {
    if (!person.admin && (await isPaused(this.store))) return OFF_DUTY[person.language];
    const saved = await this.store.getConversation(person.id);
    const stale = !saved || this.now().getTime() - new Date(saved.updatedAt).getTime() > this.staleAfterMs;
    const history = stale ? [] : trimHistory(saved!.history as BetaMessageParam[], this.maxHistory);
    const turn = await this.responder.respond(person, text, history, { channel });
    await this.store.saveConversation(person.id, trimHistory(turn.history, this.maxHistory));
    return turn.text;
  }
}
