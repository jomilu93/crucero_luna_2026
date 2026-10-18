import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { type Person, type Store, shipDate } from "@crucero/db";
import type { Outbox } from "./tools.js";

/** What the ChatService needs from the Capitán; `Director` satisfies this. */
export interface Responder {
  respond(
    passenger: Person,
    text: string,
    history: BetaMessageParam[],
    opts?: { channel?: "cli" | "whatsapp" | "web" | "voice" },
  ): Promise<{ text: string; history: BetaMessageParam[] }>;
}

export interface InboundMessage {
  /** E.164 phone, e.g. +15551234567 (the "whatsapp:" prefix stripped). */
  phoneE164: string;
  text: string;
  /** WhatsApp profile name, used only to seed a new passenger's name. */
  profileName?: string;
  /** Quick-reply button payload, when the message is a tap rather than typed text. */
  buttonPayload?: string;
  mediaUrl?: string;
  channel?: "whatsapp" | "web" | "voice";
}

export interface ChatServiceOptions {
  /** Conversations older than this restart fresh. Default 12 hours. */
  staleAfterMs?: number;
  /** Keep at most this many messages of history. Default 30. */
  maxHistory?: number;
  now?: () => Date;
}

/** Morning template buttons. The payloads are what Twilio/Meta send back when tapped. */
export const MORNING_BUTTONS = {
  show: "ver_mi_dia",
  surprise: "sorprendeme",
  skip: "hoy_no",
} as const;

export interface MorningPayload {
  full_message: string;
  offered_activity_ids: string[];
}

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
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly responder: Responder,
    private readonly outbox: Outbox,
    opts: ChatServiceOptions = {},
  ) {
    this.staleAfterMs = opts.staleAfterMs ?? 12 * 3600 * 1000;
    this.maxHistory = opts.maxHistory ?? 30;
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
    const payload = knock.payload as MorningPayload;
    await this.outbox.send(person, payload.full_message, { from: person });
    await this.store.markDelivered("morning_full", key);
    return true;
  }

  /** Handle one inbound message end to end. Returns the text that was sent back (for logs/tests). */
  async handle(msg: InboundMessage): Promise<{ person: Person; reply?: string; releasedMorning: boolean }> {
    const { person } = await this.resolvePassenger(msg);
    const channel = msg.channel ?? "whatsapp";

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

    // Any real message also opens the window: release the morning show first if it is waiting.
    const releasedMorning = await this.releasePendingMorning(person);

    const saved = await this.store.getConversation(person.id);
    const stale = !saved || this.now().getTime() - new Date(saved.updatedAt).getTime() > this.staleAfterMs;
    const history = stale ? [] : trimHistory(saved!.history as BetaMessageParam[], this.maxHistory);

    const text = msg.mediaUrl && !msg.text ? "[El pasajero envió una imagen sin texto]" : msg.text;
    const turn = await this.responder.respond(person, text, history, { channel });
    await this.store.saveConversation(person.id, trimHistory(turn.history, this.maxHistory));
    if (turn.text) await this.outbox.send(person, turn.text, { from: person });
    return { person, reply: turn.text, releasedMorning };
  }
}
