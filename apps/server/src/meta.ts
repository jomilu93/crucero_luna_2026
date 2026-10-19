import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage, TemplateKind, TemplateOutbox } from "@crucero/agent";
import type { Person } from "@crucero/db";

/**
 * Meta WhatsApp Cloud API adapter (no reseller in between).
 * Docs: developers.facebook.com/docs/whatsapp/cloud-api
 */
export interface MetaConfig {
  /** Permanent System User token (or the 24h test token while developing). */
  accessToken: string;
  /** The sender's Phone Number ID from the WhatsApp > API Setup page (not the phone number itself). */
  phoneNumberId: string;
  /** App secret, used to validate X-Hub-Signature-256 on webhooks. */
  appSecret?: string;
  /** Graph API version. Meta retires versions roughly two years after release. */
  graphVersion?: string;
  /** Approved template names by kind, plus their language code (e.g. es_MX). */
  templates?: Partial<Record<TemplateKind, string>>;
  templateLanguage?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export const DEFAULT_GRAPH_VERSION = "v22.0";

/** `X-Hub-Signature-256: sha256=<hex hmac of the raw body with the app secret>` */
export function validateMetaSignature(appSecret: string, rawBody: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.slice(7), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * WhatsApp ids are digits without "+". Mexico's wa_ids often carry the legacy mobile "1"
 * (521 + 10 digits) and Argentina's a "9" (549 + 10 digits); normalize to dialable E.164.
 */
export function waIdToE164(waId: string): string {
  const d = waId.replace(/\D/g, "");
  if (d.startsWith("521") && d.length === 13) return `+52${d.slice(3)}`;
  if (d.startsWith("549") && d.length === 13) return `+54${d.slice(3)}`;
  return `+${d}`;
}

export function e164ToWaId(phone: string): string {
  return phone.replace(/\D/g, "");
}

export interface ParsedMetaWebhook {
  /** `toPhoneNumberId` is the business number that received it: one WABA can hold several numbers. */
  messages: (InboundMessage & { messageId: string; toPhoneNumberId?: string })[];
  /** Delivery/read receipts, ignored by the Capitán but handy for logs. */
  statuses: { id: string; status: string; recipient: string; error?: string; fromPhoneNumberId?: string }[];
}

type MetaMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  audio?: { id: string };
  video?: { id: string; caption?: string };
  document?: { id: string; caption?: string };
  button?: { payload: string; text: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
};

/** Flatten a Cloud API webhook body into channel-neutral inbound messages. */
export function parseMetaWebhook(body: unknown): ParsedMetaWebhook {
  const out: ParsedMetaWebhook = { messages: [], statuses: [] };
  const b = body as { object?: string; entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
  if (b?.object !== "whatsapp_business_account") return out;
  for (const entry of b.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const v = change.value as {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: MetaMessage[];
        statuses?: { id: string; status: string; recipient_id: string; errors?: { code?: number; title?: string; message?: string }[] }[];
      };
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      const pnid = v.metadata?.phone_number_id;
      for (const s of v.statuses ?? []) {
        const e = s.errors?.[0];
        out.statuses.push({ id: s.id, status: s.status, recipient: s.recipient_id, ...(e ? { error: `${e.code ?? "?"} ${e.title ?? e.message ?? ""}`.trim() } : {}), ...(pnid ? { fromPhoneNumberId: pnid } : {}) });
      }
      for (const m of v.messages ?? []) {
        const base = { phoneE164: waIdToE164(m.from), profileName: names.get(m.from), channel: "whatsapp" as const, messageId: m.id, ...(pnid ? { toPhoneNumberId: pnid } : {}) };
        switch (m.type) {
          case "text":
            out.messages.push({ ...base, text: (m.text?.body ?? "").trim() });
            break;
          case "button": // quick-reply on a template
            out.messages.push({ ...base, text: m.button?.text ?? "", buttonPayload: m.button?.payload });
            break;
          case "interactive": {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            out.messages.push({ ...base, text: r?.title ?? "", buttonPayload: r?.id });
            break;
          }
          case "image":
          case "video":
          case "document": {
            const media = (m.image ?? m.video ?? m.document)!;
            out.messages.push({ ...base, text: (media.caption ?? "").trim(), mediaUrl: `meta-media://${media.id}` });
            break;
          }
          case "audio":
            // Voice notes: transcription is Phase 2. Tell the Capitán it was audio so he can ask for text.
            out.messages.push({ ...base, text: "[El pasajero envió una nota de voz; la transcripción aún no está activa. Pídele que lo escriba.]", mediaUrl: `meta-media://${m.audio?.id}` });
            break;
          default:
            out.messages.push({ ...base, text: `[El pasajero envió un mensaje de tipo ${m.type} que no puedo leer.]` });
        }
      }
    }
  }
  return out;
}

/** Interactive reply buttons: max 3, titles max 20 chars. */
export function buttonTitle(s: string): string {
  const t = s.trim();
  return t.length <= 20 ? t : `${t.slice(0, 19)}…`;
}

export class MetaWhatsAppOutbox implements TemplateOutbox {
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;
  readonly sentLog: { to: string; body: Record<string, unknown> }[] = [];

  constructor(
    private readonly cfg: MetaConfig,
    private readonly listPeople: () => Promise<Person[]>,
  ) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.endpoint = `${cfg.baseUrl ?? "https://graph.facebook.com"}/${cfg.graphVersion ?? DEFAULT_GRAPH_VERSION}/${cfg.phoneNumberId}/messages`;
  }

  private async post(to: string, payload: Record<string, unknown>): Promise<void> {
    const body = { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload };
    this.sentLog.push({ to, body });
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Meta ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  async send(to: Person | "everyone", text: string, opts?: { mediaUrl?: string }): Promise<void> {
    const targets = to === "everyone" ? (await this.listPeople()).filter((p) => p.phoneE164 && !p.muted) : [to];
    for (const p of targets) {
      if (!p.phoneE164) continue;
      const wa = e164ToWaId(p.phoneE164);
      if (opts?.mediaUrl && /^https?:/.test(opts.mediaUrl)) {
        await this.post(wa, { type: "image", image: { link: opts.mediaUrl, caption: text.slice(0, 1024) } });
      } else {
        await this.post(wa, { type: "text", text: { preview_url: false, body: text.slice(0, 4096) } });
      }
    }
  }

  /** Up to 3 quick-reply buttons under a short body (open-window messages only). */
  async sendInteractive(to: Person, body: string, buttons: { id: string; title: string }[]): Promise<void> {
    if (!to.phoneE164) return;
    await this.post(e164ToWaId(to.phoneE164), {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: buttonTitle(b.title) } })) },
      },
    });
  }

  /**
   * Approved template by kind. Body variables are positional ({{1}}, {{2}}, …).
   * The morning knock also carries its three quick-reply payloads (indexes 0-2).
   */
  async sendTemplate(to: Person, kind: TemplateKind, variables: Record<string, string>): Promise<void> {
    if (!to.phoneE164) return;
    const name = this.cfg.templates?.[kind];
    if (!name) {
      // No approved template: fall back to plain text (works inside an open window, e.g. with the test number).
      await this.send(to, templateFallbackText(kind, variables));
      if (kind === "morning_knock") {
        await this.sendInteractive(to, "¿Vemos el programa?", [
          { id: "ver_mi_dia", title: "Ver mi día" },
          { id: "sorprendeme", title: "Sorpréndeme" },
          { id: "hoy_no", title: "Hoy no, Capitán" },
        ]);
      }
      return;
    }
    const keys = Object.keys(variables).sort((a, b) => Number(a) - Number(b));
    const components: Record<string, unknown>[] = [
      { type: "body", parameters: keys.map((k) => ({ type: "text", text: variables[k] })) },
    ];
    if (kind === "morning_knock") {
      ["ver_mi_dia", "sorprendeme", "hoy_no"].forEach((payload, index) =>
        components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] }),
      );
    }
    await this.post(e164ToWaId(to.phoneE164), {
      type: "template",
      template: { name, language: { code: this.cfg.templateLanguage ?? "es_MX" }, components },
    });
  }
}

export function templateFallbackText(kind: TemplateKind, v: Record<string, string>): string {
  switch (kind) {
    case "morning_knock":
      return `🚢 ¡Buenos días, ${v["1"]}! Hoy en el Crucero Luna: ${v["2"]}.\nTienes ${v["3"]} actividad(es) en tu agenda.`;
    case "activity_reminder":
      return `⏰ En ${v["1"]} min: ${v["2"]} · ${v["3"]} · ${v["4"]}.`;
    case "new_activity":
      return `📣 Nueva actividad: ${v["1"]} con ${v["2"]} · ${v["3"]} · ${v["4"]}. Responde SÍ para apuntarte.`;
  }
}
