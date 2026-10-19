/**
 * Telegram Bot API channel: the ship's plan B while WhatsApp is parked.
 *
 * Passengers are addressed as `tg:<chat id>` in `Person.phoneE164` (the channel address column),
 * so the store, scheduler and guardian routing work unchanged. Only private chats are handled:
 * the bot ignores groups, so the family group stays human-only.
 *
 * Inbound arrives at POST /webhooks/telegram with the X-Telegram-Bot-Api-Secret-Token header,
 * whose value is derived from the bot token (no extra secret to manage).
 */
import { createHash } from "node:crypto";
import type { InboundMessage, TemplateKind, TemplateOutbox } from "@crucero/agent";
import type { Person } from "@crucero/db";
import { templateFallbackText } from "./meta.js";

export const TG_PREFIX = "tg:";
export const tgAddress = (chatId: number | string) => `${TG_PREFIX}${chatId}`;
export const tgChatId = (address?: string) => (address?.startsWith(TG_PREFIX) ? address.slice(TG_PREFIX.length) : undefined);

/** The webhook secret Telegram echoes back on every update: stable per bot token, [A-Za-z0-9] only. */
export function telegramWebhookSecret(botToken: string): string {
  return createHash("sha256").update(`crucero-luna:${botToken}`).digest("hex").slice(0, 48);
}

export interface TelegramConfig {
  botToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** The Capitán writes WhatsApp-style markdown; Telegram gets the same emphasis as HTML. */
export function toTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?=[^\w*]|$)/gm, "$1<b>$2</b>")
    .replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?=[^\w]|$)/gm, "$1<i>$2</i>");
}

export class TelegramOutbox implements TemplateOutbox {
  private readonly fetchFn: typeof fetch;
  readonly sentLog: { method: string; body: Record<string, unknown> }[] = [];

  constructor(
    private readonly cfg: TelegramConfig,
    private readonly listPeople: () => Promise<Person[]>,
  ) {
    this.fetchFn = cfg.fetch ?? fetch;
  }

  async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    this.sentLog.push({ method, body });
    const res = await this.fetchFn(`${this.cfg.baseUrl ?? "https://api.telegram.org"}/bot${this.cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    if (!res.ok || !json.ok) throw new Error(`Telegram ${method} ${res.status}: ${json.description ?? "unknown error"}`);
    return json.result;
  }

  /** sendMessage with HTML emphasis; if Telegram rejects the markup, resend as plain text. */
  private async message(chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const body = { chat_id: chatId, link_preview_options: { is_disabled: true }, ...extra };
    try {
      await this.call("sendMessage", { ...body, text: toTelegramHtml(text).slice(0, 4096), parse_mode: "HTML" });
    } catch (err) {
      if (!(err instanceof Error) || !/can't parse entities/i.test(err.message)) throw err;
      await this.call("sendMessage", { ...body, text: text.slice(0, 4096) });
    }
  }

  canReach(to: Person): boolean {
    return !!tgChatId(to.phoneE164);
  }

  async send(to: Person | "everyone", text: string, opts?: { mediaUrl?: string }): Promise<void> {
    const targets = to === "everyone" ? (await this.listPeople()).filter((p) => tgChatId(p.phoneE164) && !p.muted) : [to];
    for (const p of targets) {
      const chatId = tgChatId(p.phoneE164);
      if (!chatId) continue; // a passenger who boarded through another channel
      if (opts?.mediaUrl && /^https?:/.test(opts.mediaUrl)) {
        await this.call("sendPhoto", { chat_id: chatId, photo: opts.mediaUrl, caption: toTelegramHtml(text).slice(0, 1024), parse_mode: "HTML" });
      } else {
        await this.message(chatId, text);
      }
    }
  }

  /** Inline buttons under a short message; a tap comes back as a callback_query with the id. */
  async sendInteractive(to: Person, body: string, buttons: { id: string; title: string }[]): Promise<void> {
    const chatId = tgChatId(to.phoneE164);
    if (!chatId) return;
    await this.message(chatId, body, {
      reply_markup: { inline_keyboard: buttons.slice(0, 3).map((b) => [{ text: b.title.slice(0, 64), callback_data: b.id.slice(0, 64) }]) },
    });
  }

  /** Telegram has no templates or 24-hour window: send the fallback text (+ the morning buttons). */
  async sendTemplate(to: Person, kind: TemplateKind, variables: Record<string, string>): Promise<void> {
    await this.send(to, templateFallbackText(kind, variables));
    if (kind === "morning_knock") {
      await this.sendInteractive(to, "¿Vemos el programa?", [
        { id: "ver_mi_dia", title: "Ver mi día" },
        { id: "sorprendeme", title: "Sorpréndeme" },
        { id: "hoy_no", title: "Hoy no, Capitán" },
      ]);
    }
  }

  async answerCallback(callbackQueryId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  }
}

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  document?: unknown;
  sticker?: { emoji?: string };
};
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
};

export interface ParsedTelegramUpdate {
  updateId: number;
  message?: InboundMessage;
  /** Present for button taps, which must be acknowledged so the client stops spinning. */
  callbackQueryId?: string;
}

const nameOf = (u?: TgUser) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username;

/** One update → one inbound message, or nothing (groups, edits, service messages). */
export function parseTelegramUpdate(body: unknown): ParsedTelegramUpdate | undefined {
  const u = body as TgUpdate;
  if (typeof u?.update_id !== "number") return undefined;
  if (u.callback_query) {
    const q = u.callback_query;
    const chat = q.message?.chat;
    if (!chat || chat.type !== "private") return { updateId: u.update_id, callbackQueryId: q.id };
    return {
      updateId: u.update_id,
      callbackQueryId: q.id,
      message: { phoneE164: tgAddress(chat.id), profileName: nameOf(q.from), text: q.data ?? "", buttonPayload: q.data, channel: "telegram" },
    };
  }
  const m = u.message;
  if (!m || m.chat.type !== "private") return { updateId: u.update_id };
  const base = { phoneE164: tgAddress(m.chat.id), profileName: nameOf(m.from), channel: "telegram" as const };
  let text: string;
  if (m.text !== undefined) {
    // /start (with or without a deep-link payload) is how every Telegram chat begins.
    text = /^\/start\b/.test(m.text) ? "Hola Capitán" : m.text.trim();
  } else if (m.voice || m.audio) {
    text = "[El pasajero envió una nota de voz; la transcripción aún no está activa. Pídele que lo escriba.]";
  } else if (m.sticker) {
    text = m.sticker.emoji ?? "[sticker]";
  } else if (m.photo || m.video || m.document) {
    return { updateId: u.update_id, message: { ...base, text: (m.caption ?? "").trim(), mediaUrl: `telegram-media://${m.message_id}` } };
  } else {
    return { updateId: u.update_id };
  }
  return { updateId: u.update_id, message: { ...base, text } };
}
