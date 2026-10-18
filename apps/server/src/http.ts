import type { IncomingMessage, ServerResponse } from "node:http";
import { buildPersonalCalendar, type ChatService } from "@crucero/agent";
import type { Store } from "@crucero/db";
import { parseTwilioInbound, validateTwilioSignature } from "./twilio.js";

export interface RouterDeps {
  store: Store;
  chat: ChatService;
  /** Public base URL Twilio calls (needed for signature validation), e.g. https://crucero.fly.dev */
  publicUrl: string;
  twilioAuthToken?: string;
  log?: (line: string) => void;
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
 *   POST /webhooks/twilio        → WhatsApp inbound (acks fast, answers asynchronously)
 *   GET  /cal/<ics_token>.ics    → a passenger's personal calendar feed
 */
export function createRouter(deps: RouterDeps) {
  const log = deps.log ?? (() => {});
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", deps.publicUrl);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok");

      if (req.method === "POST" && url.pathname === "/webhooks/twilio") {
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
