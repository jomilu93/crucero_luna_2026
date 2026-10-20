import type { IncomingMessage, ServerResponse } from "node:http";
import { buildPersonalCalendar, type ChatService } from "@crucero/agent";
import type { Store } from "@crucero/db";
import { type DiskMediaStore, mediaContentType } from "./media.js";
import { parseMetaWebhook, validateMetaSignature } from "./meta.js";
import { privacyPolicyHtml } from "./privacy.js";
import { parseTelegramUpdate } from "./telegram.js";
import { type TvDeps, serveTv } from "./tv.js";
import { parseTwilioInbound, validateTwilioSignature } from "./twilio.js";
import type { VoiceService } from "./voice.js";
import { type WebDeps, handleWeb } from "./web.js";

export interface RouterDeps {
  store: Store;
  chat: ChatService;
  /** Public base URL Twilio calls (needed for signature validation), e.g. https://crucero.fly.dev */
  publicUrl: string;
  twilioAuthToken?: string;
  /** Meta webhook: the verify token you typed in the app dashboard, and the app secret for signatures. */
  metaVerifyToken?: string;
  metaAppSecret?: string;
  /** The ship's number. Webhooks cover every number in the WABA; messages to the others are ignored. */
  metaPhoneNumberId?: string;
  /** Who guests contact about their data, shown on /privacy. */
  privacyContact?: string;
  /** Telegram: the secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token, and the button-tap acknowledger. */
  telegramSecret?: string;
  answerTelegramCallback?: (callbackQueryId: string) => Promise<void>;
  /** Which webhook routes are live; the others answer 404. Default: all. */
  webhooks?: ("meta" | "twilio" | "telegram")[];
  /** Web app (/c/…), TV mode (/tv/<key>), and locally stored media (/media/…), when configured. */
  web?: WebDeps;
  tv?: TvDeps;
  diskMedia?: DiskMediaStore;
  /** "Call the Bridge": the custom LLM endpoint ElevenLabs calls (/v1/chat/completions). */
  voice?: VoiceService;
  /** For the landing page's "talk to the Capitán" link. */
  botUsername?: () => string | undefined;
  log?: (line: string) => void;
}

/** Meta retries webhooks; remember recent message ids so a retry never produces a second reply. */
class RecentIds {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = 5000) {}
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.max) this.ids.delete(this.order.shift()!);
    return false;
  }
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const send = (res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

/**
 * Routes:
 *   GET  /health                 → ok
 *   GET  /privacy                → the public privacy policy
 *   GET  /c/<cabin token>/…      → the passenger's web app (web.ts); POST for its forms
 *   GET  /tv/<key>               → TV mode (tv.ts); /tv/<key>/data.json for its polling
 *   GET  /tv/<key>/call.json     → a phone's "talk on the TV" call waiting for the TV; POST /tv/<key>/call → TV mic call
 *   POST /v1/chat/completions    → the Capitán as ElevenLabs' custom LLM (voice.ts; Bearer secret, SSE)
 *   GET  /media/<key>            → flyers stored on the local volume (before Supabase Storage)
 *   POST /webhooks/telegram      → Telegram bot updates (secret-token header, acks fast, answers asynchronously)
 *   POST /webhooks/twilio        → WhatsApp inbound via Twilio (acks fast, answers asynchronously)
 *   GET  /webhooks/meta          → Meta webhook verification handshake
 *   POST /webhooks/meta          → WhatsApp inbound via Meta Cloud API (acks fast, answers asynchronously)
 *   GET  /cal/<ics_token>.ics    → a passenger's personal calendar feed
 */
export function createRouter(deps: RouterDeps) {
  const log = deps.log ?? (() => {});
  const recent = new RecentIds();
  const live = (hook: "meta" | "twilio" | "telegram") => !deps.webhooks || deps.webhooks.includes(hook);
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", deps.publicUrl);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok");
      if (url.pathname.startsWith("/c/") && deps.web && (await handleWeb(deps.web, req, res, url))) return;
      const tv = url.pathname.match(/^\/tv\/([A-Za-z0-9_-]+)(\/data\.json|\/call\.json|\/call)?$/);
      if ((req.method === "GET" || (req.method === "POST" && tv?.[2] === "/call")) && tv && deps.tv) {
        if (tv[1] !== deps.tv.key) return send(res, 404, "not found");
        return serveTv(deps.tv, res, tv[2] ?? "", req.method);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions" && deps.voice) {
        return deps.voice.completions(req, res, await readBody(req, 2 * 1024 * 1024));
      }
      if (req.method === "GET" && url.pathname.startsWith("/media/") && deps.diskMedia) {
        const key = decodeURIComponent(url.pathname.slice("/media/".length));
        const bytes = await deps.diskMedia.read(key);
        if (!bytes) return send(res, 404, "not found");
        res.writeHead(200, { "Content-Type": mediaContentType(key), "Content-Length": bytes.length, "Cache-Control": "public, max-age=31536000, immutable" });
        res.end(bytes);
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        const bot = deps.botUsername?.();
        return send(
          res,
          200,
          `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crucero Luna 2026</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f4c81;color:#fff;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:16px}a{color:#ffd166}</style></head>
<body><div><div style="font-size:64px">🌙🛳️</div><h1>Crucero Luna 2026</h1><p>Acapulco · 26 dic 2026 – 2 ene 2027</p>
${bot ? `<p><a href="https://t.me/${bot}">Habla con el Capitán Lunático en Telegram · @${bot}</a></p>` : ""}<p style="font-size:14px"><a href="/privacy">Aviso de privacidad · Privacy</a></p></div></body></html>`,
          "text/html; charset=utf-8",
        );
      }
      if (req.method === "GET" && url.pathname === "/privacy") return send(res, 200, privacyPolicyHtml(deps.privacyContact), "text/html; charset=utf-8");

      if (req.method === "POST" && url.pathname === "/webhooks/telegram" && live("telegram")) {
        const token = req.headers["x-telegram-bot-api-secret-token"];
        if (!deps.telegramSecret || token !== deps.telegramSecret) {
          log("telegram webhook rejected: bad or missing secret token");
          return send(res, 403, "bad secret");
        }
        let update;
        try {
          update = parseTelegramUpdate(JSON.parse(await readBody(req, 1024 * 1024)));
        } catch {
          return send(res, 400, "bad json");
        }
        send(res, 200, "ok"); // Telegram retries until it gets a 200; everything else happens after.
        if (!update || recent.seen(`tg:${update.updateId}`)) return;
        if (update.callbackQueryId) deps.answerTelegramCallback?.(update.callbackQueryId).catch((err) => log(`telegram answerCallbackQuery ERROR ${err instanceof Error ? err.message : err}`));
        const m = update.message;
        if (!m) return;
        log(`telegram ${m.phoneE164}: ${m.buttonPayload ? `[button:${m.buttonPayload}]` : m.text.slice(0, 60)}`);
        deps.chat
          .handle(m)
          .then((r) => log(`telegram ${m.phoneE164} → ${r.person.name}: ${r.reply ? r.reply.slice(0, 80) : r.releasedMorning ? "[morning released]" : "[no reply]"}`))
          .catch((err) => log(`telegram ${m.phoneE164} ERROR ${err instanceof Error ? err.message : err}`));
        return;
      }

      if (req.method === "POST" && url.pathname === "/webhooks/twilio" && live("twilio")) {
        const raw = await readBody(req);
        const params = Object.fromEntries(new URLSearchParams(raw));
        if (deps.twilioAuthToken) {
          const sig = req.headers["x-twilio-signature"];
          const ok = validateTwilioSignature(deps.twilioAuthToken, `${deps.publicUrl}${url.pathname}`, params, Array.isArray(sig) ? sig[0] : sig);
          if (!ok) return send(res, 403, "bad signature");
        }
        const inbound = parseTwilioInbound(params);
        if (!inbound) return send(res, 400, "not a whatsapp message");
        // Ack immediately with empty TwiML; the Capitán replies through the REST API when ready.
        send(res, 200, "<Response/>", "text/xml");
        deps.chat
          .handle(inbound)
          .then((r) => log(`whatsapp ${inbound.phoneE164} → ${r.person.name}: ${r.reply ? r.reply.slice(0, 80) : r.releasedMorning ? "[morning released]" : "[no reply]"}`))
          .catch((err) => log(`whatsapp ${inbound.phoneE164} ERROR ${err instanceof Error ? err.message : err}`));
        return;
      }

      if (url.pathname === "/webhooks/meta" && live("meta")) {
        if (req.method === "GET") {
          const mode = url.searchParams.get("hub.mode");
          const token = url.searchParams.get("hub.verify_token");
          const challenge = url.searchParams.get("hub.challenge") ?? "";
          if (mode === "subscribe" && deps.metaVerifyToken && token === deps.metaVerifyToken) return send(res, 200, challenge);
          return send(res, 403, "verification failed");
        }
        if (req.method === "POST") {
          const raw = await readBody(req, 1024 * 1024);
          if (deps.metaAppSecret) {
            const sig = req.headers["x-hub-signature-256"];
            if (!validateMetaSignature(deps.metaAppSecret, raw, Array.isArray(sig) ? sig[0] : sig)) {
              log(`meta webhook rejected: bad signature (${sig ? "check META_APP_SECRET" : "no X-Hub-Signature-256 header"})`);
              return send(res, 403, "bad signature");
            }
          }
          let parsed;
          try {
            parsed = parseMetaWebhook(JSON.parse(raw));
          } catch {
            log("meta webhook rejected: body is not JSON");
            return send(res, 400, "bad json");
          }
          send(res, 200, "ok"); // Meta wants a fast 200; everything else happens after.
          log(`meta webhook: ${parsed.messages.length} message(s), ${parsed.statuses.length} status(es)`);
          const ours = (pnid?: string) => !deps.metaPhoneNumberId || !pnid || pnid === deps.metaPhoneNumberId;
          // Outbound failures only surface here (e.g. 131047 outside the 24h window, 131030 recipient not allowed on a test number).
          for (const s of parsed.statuses) if (s.status === "failed" && ours(s.fromPhoneNumberId)) log(`meta delivery FAILED to ${s.recipient}: ${s.error ?? "no detail"}`);
          for (const m of parsed.messages) {
            if (!ours(m.toPhoneNumberId)) {
              log(`meta webhook: ignored a message to another number in the WABA (phone number id ${m.toPhoneNumberId})`);
              continue;
            }
            if (recent.seen(m.messageId)) continue;
            deps.chat
              .handle(m)
              .then((r) => log(`meta ${m.phoneE164} → ${r.person.name}: ${r.reply ? r.reply.slice(0, 80) : r.releasedMorning ? "[morning released]" : "[no reply]"}`))
              .catch((err) => log(`meta ${m.phoneE164} ERROR ${err instanceof Error ? err.message : err}`));
          }
          return;
        }
      }

      const cal = url.pathname.match(/^\/cal\/([A-Za-z0-9_-]+)\.ics$/);
      if (req.method === "GET" && cal) {
        const person = (await deps.store.listPeople()).find((p) => p.icsToken === cal[1]);
        if (!person) return send(res, 404, "no such calendar");
        const ics = await buildPersonalCalendar(deps.store, person);
        return send(res, 200, ics, "text/calendar; charset=utf-8");
      }

      send(res, 404, "not found");
    } catch (err) {
      log(`http ${req.method} ${url.pathname} ERROR ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) send(res, 500, "error");
    }
  };
}
