import { createHmac, timingSafeEqual } from "node:crypto";
import type { Person } from "@crucero/db";
import type { InboundMessage, TemplateKind, TemplateOutbox } from "@crucero/agent";

export interface TwilioConfig {
  accountSid: string;
  /** API key SID + secret for REST calls (Basic auth). */
  apiKeySid: string;
  apiKeySecret: string;
  /** Account auth token; only needed to validate webhook signatures. */
  authToken?: string;
  /** e.g. "whatsapp:+14155238886" */
  from: string;
  /** Content SIDs (HX…) of approved WhatsApp templates, by kind. Missing = fall back to plain text. */
  templates?: Partial<Record<TemplateKind, string>>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Twilio's request signature: HMAC-SHA1 over the full URL + sorted POST params, base64. */
export function validateTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Map a Twilio WhatsApp webhook body to our channel-neutral inbound message. */
export function parseTwilioInbound(params: Record<string, string>): InboundMessage | undefined {
  const from = params.From ?? "";
  if (!from.startsWith("whatsapp:")) return undefined;
  const numMedia = Number(params.NumMedia ?? "0");
  return {
    phoneE164: from.replace(/^whatsapp:/, ""),
    text: (params.Body ?? "").trim(),
    profileName: params.ProfileName,
    buttonPayload: params.ButtonPayload || undefined,
    mediaUrl: numMedia > 0 ? params.MediaUrl0 : undefined,
    channel: "whatsapp",
  };
}

/** Plain-text fallback bodies for templates, used when no Content SID is configured (sandbox). */
export function templateFallbackText(kind: TemplateKind, v: Record<string, string>): string {
  switch (kind) {
    case "morning_knock":
      return `🚢 ¡Buenos días, ${v["1"]}! Hoy en el Crucero Luna: ${v["2"]}.\nTienes ${v["3"]} actividad(es) en tu agenda. ¿Vemos el programa?\n\nResponde: VER MI DÍA · SORPRÉNDEME · HOY NO`;
    case "activity_reminder":
      return `⏰ En ${v["1"]} min: ${v["2"]} · ${v["3"]} · ${v["4"]}.`;
    case "new_activity":
      return `📣 Nueva actividad: ${v["1"]} con ${v["2"]} · ${v["3"]} · ${v["4"]}. Responde SÍ para apuntarte.`;
  }
}

export class TwilioWhatsAppOutbox implements TemplateOutbox {
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;
  readonly sentLog: { to: string; body: Record<string, string> }[] = [];

  constructor(
    private readonly cfg: TwilioConfig,
    private readonly listPeople: () => Promise<Person[]>,
  ) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.endpoint = `${cfg.baseUrl ?? "https://api.twilio.com"}/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  }

  private async post(body: Record<string, string>): Promise<void> {
    const auth = Buffer.from(`${this.cfg.apiKeySid}:${this.cfg.apiKeySecret}`).toString("base64");
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Twilio ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  async send(to: Person | "everyone", text: string, opts?: { mediaUrl?: string }): Promise<void> {
    const targets = to === "everyone" ? (await this.listPeople()).filter((p) => p.phoneE164 && !p.muted) : [to];
    for (const p of targets) {
      if (!p.phoneE164) continue;
      const body: Record<string, string> = { From: this.cfg.from, To: `whatsapp:${p.phoneE164}`, Body: text };
      if (opts?.mediaUrl) body.MediaUrl = opts.mediaUrl;
      this.sentLog.push({ to: p.phoneE164, body });
      await this.post(body);
    }
  }

  async sendTemplate(to: Person, kind: TemplateKind, variables: Record<string, string>): Promise<void> {
    if (!to.phoneE164) return;
    const sid = this.cfg.templates?.[kind];
    const body: Record<string, string> = sid
      ? { From: this.cfg.from, To: `whatsapp:${to.phoneE164}`, ContentSid: sid, ContentVariables: JSON.stringify(variables) }
      : { From: this.cfg.from, To: `whatsapp:${to.phoneE164}`, Body: templateFallbackText(kind, variables) };
    this.sentLog.push({ to: to.phoneE164, body });
    await this.post(body);
  }
}
